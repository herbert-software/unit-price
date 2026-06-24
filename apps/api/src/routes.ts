// Hono app + POST /parse route. Request/response bodies are Zod-validated.
// HTTP status semantics (parse-api spec):
//  - 4xx: invalid request body (missing/empty title, missing/non-numeric price)
//  - 5xx info-insufficient: tier2 transport failed AND tier1 had no shape at all
//  - 5xx config-error: runtime config error (distinguishable error code)
//  - 200: everything else, including determined-uncomputable (per100ml=null),
//         contracted-form, and low-confidence results.
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  ParsedSpecSchema,
  UnitPriceSchema,
  WarningsSchema,
  calculate,
  meetsComputeRequiredSet,
  type ComparableUnit,
  type ParsedSpec,
  type RawProduct,
} from '@unit-price/core';
import {
  RankingsResponseSchema,
  CategoryTreeResponseSchema,
  ComputeRequestSchema,
  ComputeResultSchema,
  type ComputeRequest,
  type RankingsItem,
} from '@unit-price/api-client';
import { CATEGORY_NODES, type Db, type RankingRow, type Repository } from '@unit-price/db';
import { orchestrate } from './orchestrate.js';
import type { SpecParserLLM } from './llm.js';
import type { AppEnv, Bindings } from './bindings.js';
import {
  authOnlyMiddleware,
  createRealGovernance,
  governanceMiddleware,
  type Governance,
} from './governance.js';
import { runBackfill, ADMIN_BACKFILL_DEFAULT_LIMIT, ADMIN_BACKFILL_MAX_LIMIT } from './tagging.js';

/** Request schema: title non-empty string, price a finite number, optional hint. */
export const ParseRequestSchema = z.object({
  title: z.string().min(1, 'title must be a non-empty string'),
  price: z.number({ error: 'price must be a number' }).finite('price must be a finite number'),
  categoryHint: z.string().optional(),
});

/** Response schema (validated before send to keep the contract honest). */
export const ParseResponseSchema = z.object({
  spec: ParsedSpecSchema,
  unitPrice: UnitPriceSchema,
  confidence: z.number().min(0).max(1),
  warnings: WarningsSchema,
});

/**
 * Contribute request schema: RawProduct domain fields + provenance fields.
 *
 * `price` uses `.finite()` ONLY (rejects NaN/±Inf) — negative/zero prices are
 * LEGAL reports: product_raw faithfully stores the raw observation (including
 * anomalous prices), and core routes price<=0 to per100ml=null (a 200 with a
 * warning), per parse-api. DO NOT add `.positive()`/`.min(0)` here. `400` is
 * reserved for empty `title`, non-finite `price`, or empty dedupe keys.
 *
 * `store`/`storeSku` are the source of the `(store, store_sku)` dedupe key and
 * MUST be non-empty at the request layer (empty → 400 invalid-request) so an
 * empty key never reaches the repository. `capturedAt` is epoch ms (int only;
 * ISO strings are rejected). Provenance fields (store/storeSku/source/sourceUrl/
 * capturedAt/nativeCategoryId) are NOT part of RawProductSchema — only
 * `categoryHint` rides in the domain `raw` object.
 *
 * `nativeCategoryId` is a DEDICATED store-provenance field (the store's native
 * categoryIdList leaf id, e.g. Sam's "10012164"). It is NOT reused from
 * `categoryHint` (which is the passthrough source of product.category) and is
 * NOT part of the core domain schema — it lands on product_raw.native_category_id
 * to feed the store-map tagging lookup. Unlike the dedupe keys, an empty /
 * whitespace-only / explicit-null value is NOT a 400: it is treated as OMITTED
 * (→ null + success), so a generative client that serializes the absent field as
 * `null`/`""` still succeeds and the row simply falls back to tier1. The
 * preprocess collapses null/empty/whitespace to undefined BEFORE min(1) (a bare
 * `z.string().trim().min(1).optional()` would 400 on "" / null); a non-string
 * (e.g. a number) still fails validation → 400.
 */
export const ContributeRequestSchema = z.object({
  // Domain fields (aligned with RawProductSchema).
  title: z.string().min(1, 'title must be a non-empty string'),
  price: z.number({ error: 'price must be a number' }).finite('price must be a finite number'),
  categoryHint: z.string().optional(),
  // Provenance fields (dedupe / source-of-record). Trim BEFORE min(1) so a
  // whitespace-only dedupe key is rejected at the request layer (400) rather
  // than slipping past min(1) and tripping the repository's DedupeKeyGate
  // (which trims) into a generic 500 persistence-error. Mirrors DedupeKeyGate.
  store: z.string().trim().min(1, 'store must be a non-empty string'),
  storeSku: z.string().trim().min(1, 'storeSku must be a non-empty string'),
  source: z.string().optional(),
  sourceUrl: z.string().optional(),
  capturedAt: z.number().int('capturedAt must be an integer epoch-ms timestamp').optional(),
  // Store-provenance native category id (feeds store-map). null/empty/whitespace
  // → omitted (null + success), not 400; a non-string → 400. See docstring.
  nativeCategoryId: z.preprocess(
    (v) =>
      v == null || (typeof v === 'string' && v.trim() === '') ? undefined : v,
    z.string().trim().min(1).optional(),
  ),
});

export type ContributeRequest = z.infer<typeof ContributeRequestSchema>;

/**
 * Contribute response = the /parse response contract plus the three persisted
 * app-generated TEXT ids. Validated before send (contract enforcement).
 */
export const ContributeResponseSchema = ParseResponseSchema.extend({
  rawId: z.string().min(1),
  productId: z.string().min(1),
  unitPriceId: z.string().min(1),
});

export type ContributeResponse = z.infer<typeof ContributeResponseSchema>;

/**
 * Minimal /ingest 202 body: just the landed app-generated TEXT rawId. Parsing
 * runs in the background after the response is sent, so the synchronous response
 * carries no spec/unitPrice/confidence/warnings — only proof the raw landed.
 * Validated before send (rawId from upsertRaw is always non-empty, so the guard
 * is defensive; a failure maps to 500 internal, mirroring /contribute).
 */
export const IngestResponseSchema = z.object({ rawId: z.string().min(1) });

export type IngestResponse = z.infer<typeof IngestResponseSchema>;

/**
 * Max items per batch ingest request. Pinned at 40 to keep one invocation's
 * background tier2 LLM fetches within the free-plan Worker subrequest ceiling
 * (50) with headroom for non-LLM fetches. Raising this to 100+ REQUIRES first
 * confirming the production Worker is on a PAID plan (1000 subrequests) — an
 * explicit deploy prerequisite, not a runtime "find out later".
 */
export const MAX_BATCH = 40;

/** Bounded concurrency pool size for background per-item parsing of a batch. */
export const BG_POOL = 5;

/**
 * Cache-Control for the public read-only GET endpoints (/rankings, /categories).
 * Set ONLY on the 200 success path so the edge layers already in front of the
 * worker — Aliyun CDN's China POP (the front of the slow cross-border hop) and
 * Cloudflare — cache the JSON and most reads never reach the worker/D1. The data
 * is near-static: catalog prices hold for months, only the occasional temp promo
 * moves, and both arrive via infrequent manual /ingest batches — so a long TTL is
 * what maximizes the China-POP hit rate (the whole point: dodge the cross-border
 * hop). 1 day caps staleness if a purge is ever missed (self-heals next day); to
 * push a promo out sooner, purge the CDN after the ingest/backfill that added it
 * (see docs/backfill-runbook.md). Errors (400/500) carry no header → never cached.
 * Tune the TTL here. (Aliyun CDN keeps the query string in its cache key by
 * default, so /rankings?category=… variants cache separately.)
 */
export const PUBLIC_CACHE_CONTROL = 'public, max-age=86400';

/**
 * Neighbors returned each side of the user's value by POST /compute (up to N
 * cheaper + up to N pricier). Pure display parameter (decision D6) — tune here;
 * not part of the response contract's核心.
 */
export const COMPUTE_NEIGHBORS_N = 3;

/**
 * Upper bound on cohort rankable rows POST /compute pulls to position the user.
 * Positioning needs the FULL ascending cohort board (count rows below the user
 * value + pick the boundary neighbors), so the端点 reads the whole cohort via the
 * SAME `repo.listRankings` cohort/rankable/per100ml query as /rankings (decision
 * D6 — "定位" and "榜单" share one population), capped to keep one bounded read
 * (v1 cohorts are ~hundreds). The slice is in SQL; rows past this cap (a far
 * larger cohort than any v1 leaf) would silently under-count — raise this if a
 * cohort ever approaches it.
 */
export const COMPUTE_COHORT_FETCH_MAX = 5000;

/**
 * Batch ingest request: an envelope of 1..MAX_BATCH single-item contributions.
 * Reuses ContributeRequestSchema for each item (single-item fields are NOT
 * redefined — schema SOT). Strict: any item failing ContributeRequestSchema, an
 * empty array, or an over-limit array rejects the whole batch with 400.
 */
export const BatchIngestRequestSchema = z.object({
  items: z.array(ContributeRequestSchema).min(1).max(MAX_BATCH),
});

export type BatchIngestRequest = z.infer<typeof BatchIngestRequestSchema>;

/**
 * Batch ingest response: how many items landed as raw + which ones failed.
 * `accepted` = items whose upsertRaw succeeded and were queued for background
 * parsing. `failed` reports each failed item by its ORIGINAL index in the
 * request `items` array (for precise client-side dequeue/retry), plus its
 * store/storeSku for logging. Invariant: accepted + failed.length === items.length.
 */
export const BatchIngestResponseSchema = z.object({
  accepted: z.number().int().nonnegative(),
  failed: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      store: z.string(),
      storeSku: z.string(),
    }),
  ),
});

export type BatchIngestResponse = z.infer<typeof BatchIngestResponseSchema>;

/**
 * GET /rankings response contract (`RankingsResponseSchema`) + its `RankingsItem`
 * shape now live in `@unit-price/api-client` — the transport-agnostic single
 * source of truth shared by apps/api and every client. This handler imports it
 * (see top-of-file import); it is NOT redefined here. `RankingsQuerySchema`
 * below stays in apps/api: it is the server-side 400 query gate, not part of the
 * shared response contract.
 */

/**
 * Accepted `category` slugs — the seed kind=category slug set, derived at COMPILE
 * TIME from `packages/db`'s `CATEGORY_NODES` (the seed truth source). This is the
 * ONLY slug list in apps/api: hand-writing a second one would let the API drift
 * from the seed. Used to build `RankingsQuerySchema.category`'s `z.enum`. The
 * `as [string, ...string[]]` assertion satisfies `z.enum`'s non-empty-tuple type
 * (CATEGORY_NODES always seeds `beverage` and more).
 */
export const CATEGORY_SLUGS = CATEGORY_NODES.map((n) => n.slug) as [string, ...string[]];

/**
 * Static slug→node map over the COMPILE-TIME seed truth (`CATEGORY_NODES`), built
 * once at module load. Same single-source paradigm as `CATEGORY_SLUGS` — apps/api
 * never hand-writes a second tree and never round-trips the `tag` table.
 */
const CATEGORY_NODE_BY_SLUG = new Map(CATEGORY_NODES.map((n) => [n.slug, n]));

/**
 * Resolve a category slug's effective `comparable_unit` by is-a inheritance over
 * the STATIC `CATEGORY_NODES` constant — the node's own value, else walk
 * `parentSlug` up to the nearest non-null ancestor; null all the way to root → null.
 * Pure synchronous, NO DB round-trip (mirrors `resolveComparableUnitInMemory`, but
 * over the compile-time seed, not the `tag` table).
 *
 * This is the cohort guard's resolver: it MUST NOT use the repository's runtime
 * `repo.resolveComparableUnit` (which reads the `tag` table). A legal-but-unseeded
 * cohort slug (e.g. `beer` in the migrate-before-seed window) has no `tag` row, so
 * a runtime resolve returns null → the guard would wrongly 400 it, breaking the
 * "legal-but-unseeded slug → 200 []" contract. The static resolve is invariant to
 * DB seed state: `beer` is ALWAYS `per_100ml` (its own binding), `alcohol`/`beverage`
 * are ALWAYS null (cross-cohort ancestors), so the guard and the unseeded-window
 * contract hold simultaneously. An unknown slug (already rejected by the
 * `CATEGORY_SLUGS` enum gate before this is called) also resolves null.
 */
export function resolveComparableUnitStatic(slug: string): ComparableUnit | null {
  let cursor = CATEGORY_NODE_BY_SLUG.get(slug);
  let guard = 0;
  while (cursor != null && guard < 64) {
    if (cursor.comparableUnit != null) return cursor.comparableUnit;
    if (cursor.parentSlug == null) return null;
    cursor = CATEGORY_NODE_BY_SLUG.get(cursor.parentSlug);
    guard += 1;
  }
  return null;
}

/**
 * GET /rankings query parameters. Query values arrive as strings. `limit` and
 * `offset` accept ONLY a decimal non-negative integer string (STRICT, symmetric):
 * a present value is gated by `^\d+$` BEFORE numeric conversion, so loose coercion
 * (`Number("")=0`, `Number("0x10")=16`, `Number(" 5 ")=5`) can never sneak a
 * non-canonical input past validation. Only a MISSING key falls through to the
 * default. A parse failure maps to `400 invalid-request` at the route.
 *
 * `limit`: default 50 (key missing). Present: `^\d+$` → int → `positive` (rejects
 * `0`); the clamp to 200 comes AFTER the positive check (a present `>200` clamps,
 * never rejects). Empty string / hex / whitespace / decimal / negative / `abc` /
 * `Infinity` all fail the regex or the int/positive pipe → 400.
 *
 * `offset`: default 0 (key missing). Present: `^\d+$` → int → `nonnegative`
 * (allows `0`) — SAME strictness as `limit` (symmetry: empty `offset` is rejected
 * just like empty `limit`, not silently treated as 0). A valid in-range-but-past-
 * the-end offset is a route-level concern (→ 200 + []), not a parse failure.
 *
 * `category` (CASE-SENSITIVE), default `soft-drink` (the 软饮 cohort node — P3.5
 * replaces the P3 root `beverage` default so the no-param board is the soft-drink
 * cohort, not a cross-cohort root). Present: MUST exactly match one seed
 * kind=category node slug. The accepted set is `CATEGORY_SLUGS`, derived AT COMPILE
 * TIME from `packages/db`'s `CATEGORY_NODES` (the seed truth) — apps/api does NOT
 * hand-write a second slug list (would drift from seed). Validation is a pure
 * synchronous parse (NO runtime `tag`-table lookup: that cannot tell a legal-but-
 * unseeded slug apart from a typo). An unknown / non-category / wrong-case / empty
 * `?category=` slug → 400 invalid-request. A slug that IS in the set but whose `tag`
 * row is not seeded yet (migrate-before-seed window) is NOT a parse failure here: it
 * passes the gate, clears the cohort guard via the STATIC resolver (see the route
 * handler), and the repository returns [] (→ 200), so a typo and an unseeded-but-
 * legal slug stay distinguishable. The validated slug drives the closure filter
 * (`category_closure.ancestor_tag_id = <that node>` + `product.rankable=1` +
 * `per100ml IS NOT NULL`) inside listRankings.
 */
export const RankingsQuerySchema = z.object({
  limit: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.number().int().positive())
    .transform((n) => Math.min(n, 200))
    .optional()
    .transform((n) => n ?? 50),
  offset: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.number().int().nonnegative())
    .optional()
    .transform((n) => n ?? 0),
  category: z.enum(CATEGORY_SLUGS).default('soft-drink'),
  // `q` (title substring search) is a PURE-ADDITIVE concern — the schema is
  // `z.object` (NOT `.strict`), so absent `q` leaves the no-`q` board unchanged.
  // Pipeline ORDER is load-bearing (see design.md D2.1):
  //   1. trim          — ECMAScript trim() strips half- AND full-width (　) space.
  //   2. ''→undefined  — empty / whitespace-only means NO search intent → undefined
  //                      (NOT filtered). This MUST run BEFORE the refine, else the
  //                      refine would 400 on an empty `?q=`.
  //   3. refine ≥ 2    — only the PRESENT branch is length-checked; trim→1 codepoint
  //                      is "searched but too wide" → 400 invalid-request (single CJK
  //                      char like 水/茶/奶 over-matches into near-full-table).
  //   4. truncate ≤ 64 — by CODEPOINT (`[...s]`), never UTF-16 `.length`: surrogate
  //                      pairs (emoji / rare CJK 𠮷) count as 1 and `.slice` never
  //                      splits a pair (no lone surrogate injected into LIKE).
  //   5. optional      — last, so absent stays absent.
  // ALL length math is by codepoint (`[...s]`), never `.length`.
  q: z
    .string()
    .transform((s) => s.trim())
    .transform((s) => (s === '' ? undefined : s))
    .refine((s) => s === undefined || [...s].length >= 2, { message: 'q too short' })
    .transform((s) => (s === undefined ? undefined : [...s].slice(0, 64).join('')))
    .optional(),
});

export type RankingsQuery = z.infer<typeof RankingsQuerySchema>;

export const AdminBackfillQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.number().int().positive())
    .transform((n) => Math.min(n, ADMIN_BACKFILL_MAX_LIMIT))
    .optional()
    .transform((n) => Math.min(n ?? ADMIN_BACKFILL_DEFAULT_LIMIT, ADMIN_BACKFILL_MAX_LIMIT)),
});

export interface AppDeps {
  /**
   * Factory that builds an LLM port from the per-request injected env. Building
   * per request (not a shared singleton) avoids isolate cross-request env
   * bleed: each request resolves config from its OWN `c.env`.
   */
  makeLlm: (env: Bindings) => SpecParserLLM;
  /**
   * Injectable access governance (auth / rate-limit / usage). Production injects
   * the real implementation; dev injects a pass-through no-op. Mounted as a
   * pre-middleware on /parse and /contribute — /health is exempt from the chain.
   */
  governance: Governance;
  /**
   * Optional factory that builds the persistence Repository from the per-request
   * injected env. Built per request (not a shared singleton), mirroring
   * `makeLlm`, so each request resolves its OWN `c.env.DB` — no isolate
   * cross-request env bleed. Production wires the real D1 repo; Node dev omits
   * it, so `/contribute` takes the persistence-error branch. Returns `null` when
   * no DB is bound; the factory itself may THROW on an invalid binding (both the
   * null and the throw map to a 500 persistence-error at the route).
   */
  makeRepo?: (env: Bindings) => Repository | null;
  /** Db 工厂(镜像 makeRepo),供 admin backfill 游标读。null→persistence-error。 */
  makeDb?: (env: Bindings) => Db | null;
  /** admin-tier authenticate-only governance(读 ADMIN_API_KEYS)。省略时默认 createRealGovernance({allowlistVar:'ADMIN_API_KEYS'})。 */
  adminGovernance?: Governance;
  /**
   * Injectable "background execution" port for /ingest's post-response work
   * (orchestrate + saveParsed), same paradigm as makeLlm/makeRepo/governance.
   * Production (`buildApp`) injects `(c, run) => c.executionCtx.waitUntil(run())`
   * so `run()` continues after the 202 is sent within the same invocation, and
   * the port RETURNS VOID so the handler's `await` resolves immediately (202
   * lands fast, never blocked on `run()`). Node dev / default is the synchronous
   * `(_, run) => run()` so local/tests are deterministic (202 after parsing
   * completes). The route MUST NOT touch `c.executionCtx` directly — that getter
   * throws under Node dev; the runtime difference is confined to this port.
   */
  scheduleBackground?: (
    c: Context<AppEnv>,
    run: () => Promise<void>,
  ) => void | Promise<void>;
}

/**
 * Internal helper result: either the parsed/resolved value, or a short-circuit
 * Response (already a 400/500) the caller returns as-is. Shared by /contribute
 * and /ingest so the "validate body → resolve repo → land raw" preamble stays
 * identical (and /contribute's behavior is unchanged) — the two endpoints only
 * diverge afterward on parse timing + response.
 */
type HelperResult<T> = { ok: true; value: T } | { ok: false; response: Response };

/**
 * Validate the request body against ContributeRequestSchema. Non-JSON or schema
 * failure (incl. empty/whitespace dedupe keys, empty title, non-finite price) →
 * 400 invalid-request, no row written.
 */
async function parseContributeBody(
  c: Context<AppEnv>,
): Promise<HelperResult<ContributeRequest>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return {
      ok: false,
      response: c.json({ error: 'invalid-request', message: 'request body must be valid JSON' }, 400),
    };
  }

  const parsedReq = ContributeRequestSchema.safeParse(body);
  if (!parsedReq.success) {
    return {
      ok: false,
      response: c.json(
        {
          error: 'invalid-request',
          message: 'request body failed validation',
          issues: parsedReq.error.issues.map((i) => ({ path: i.path, message: i.message })),
        },
        400,
      ),
    };
  }
  return { ok: true, value: parsedReq.data };
}

/**
 * Resolve the repository from this request's env. The factory's
 * createDb/createRepository THROW on an invalid binding — catch and map to
 * persistence-error. A null repo (no DB bound, e.g. Node dev) is the same
 * persistence-error. Both keep the failure from bubbling as a framework 500.
 */
function resolveRepo(
  c: Context<AppEnv>,
  deps: AppDeps,
): HelperResult<Repository> {
  let repo: Repository | null;
  try {
    repo = deps.makeRepo?.(c.env) ?? null;
  } catch {
    return {
      ok: false,
      response: c.json({ error: 'persistence-error', message: 'persistence layer initialization failed' }, 500),
    };
  }
  if (repo === null) {
    return { ok: false, response: c.json({ error: 'persistence-error', message: 'no database bound' }, 500) };
  }
  return { ok: true, value: repo };
}

/**
 * SHARED landing map (single source of the upsertRaw field mapping). Returns the
 * app-generated rawId on success, or `null` on any throw. Both `landRaw` (single
 * /ingest, /contribute) and the batch handler MUST go through here so the
 * `ContributeRequest → upsertRaw({...})` field mapping lives in EXACTLY ONE place
 * — inlining a second copy in the batch handler would let the single-item and
 * batch landing logic silently drift apart.
 */
async function upsertRawOrNull(
  repo: Repository,
  req: ContributeRequest,
): Promise<string | null> {
  try {
    return await repo.upsertRaw({
      store: req.store,
      storeSku: req.storeSku,
      raw: { title: req.title, price: req.price, categoryHint: req.categoryHint },
      source: req.source,
      sourceUrl: req.sourceUrl,
      capturedAt: req.capturedAt,
      nativeCategoryId: req.nativeCategoryId,
    });
  } catch {
    return null;
  }
}

/**
 * upsertRaw FIRST (observation-first): the raw report is the most valuable
 * crowd-sourced asset, persisted even if parsing later fails. A throw maps to
 * persistence-error (raw not landed → no rawId). Thin wrapper over the shared
 * `upsertRawOrNull` map: a null (throw) becomes the 500 short-circuit response;
 * /ingest and /contribute behavior is unchanged.
 */
async function landRaw(
  c: Context<AppEnv>,
  repo: Repository,
  req: ContributeRequest,
): Promise<HelperResult<string>> {
  const rawId = await upsertRawOrNull(repo, req);
  if (rawId === null) {
    return {
      ok: false,
      response: c.json({ error: 'persistence-error', message: 'failed to persist raw report' }, 500),
    };
  }
  return { ok: true, value: rawId };
}

/** admin key 的审计标识:HMAC-SHA256(key, secret) hex 截断。绝不落原文 key。 */
async function hmacKeyId(key: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const ck = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', ck, enc.encode(key));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

/**
 * Map the cohort's static comparable-unit (`per_100ml`/`per_100g`/`per_100sheet`)
 * to the core `UnitPrice` axis field its `calculate` populates. `per_100ml` ↔
 * `per100ml`, `per_100g` ↔ `per100g`. `per_100sheet` (a v2 placeholder, not a
 * calculable volume/weight axis) and any unmapped value return null → the cohort
 * is not compute-positionable on either axis, so the route 400s as incomparable.
 */
function cohortAxisField(unit: ComparableUnit): 'per100ml' | 'per100g' | null {
  if (unit === 'per_100ml') return 'per100ml';
  if (unit === 'per_100g') return 'per100g';
  return null;
}

/** The response `axis` literal for the cohort's per100 field. */
function axisLabel(field: 'per100ml' | 'per100g'): 'per_100ml' | 'per_100g' {
  return field === 'per100ml' ? 'per_100ml' : 'per_100g';
}

/**
 * Project a stored RankingRow → the shared `RankingsItem` shape (DROP `id`, ADD
 * the row's board `rank`). Identical projection to /rankings so a positioned
 * neighbor row renders exactly like a board row (decision D6). `rank` is the
 * row's 1-based position in the ascending cohort board (its array index + 1).
 */
function projectNeighbor(row: RankingRow, boardRank: number): RankingsItem {
  return {
    rank: boardRank,
    title: row.title,
    priceCents: row.priceCents,
    per100ml: row.per100ml,
    formula: row.formula,
    confidence: row.confidence,
    warnings: row.warnings,
    store: row.store,
    storeSku: row.storeSku,
    sourceUrl: row.sourceUrl,
  };
}

/**
 * Deterministic in-cohort positioning of `userValue` against the FULL ascending
 * cohort board `rows` (already sorted by per100ml ASC — the /rankings order).
 * Pure (no IO):
 *  - `rank` = (# rows strictly cheaper than the user) + 1 (1-based; the user
 *    slots AFTER every strictly-cheaper row, ties counted as not-cheaper).
 *  - `total` = the cohort's rankable row count (`rows.length`).
 *  - `percentile` = the share of the cohort the user is strictly cheaper than,
 *    `(# rows pricier) / total * 100`; `total = 0 → 0` (no cohort to beat — the
 *    deterministic empty-cohort convention, never NaN).
 *  - `neighbors` = up to N rows each side of the user's slot (the N cheapest-but-
 *    still-pricier-than below it are the closest cheaper ones; the N just-pricier
 *    above), board-projected with their board ranks. MAY be empty / one-sided at
 *    a boundary (a valid 200, never a 404).
 */
function positionInCohort(
  rows: RankingRow[],
  userValue: number,
): { rank: number; total: number; percentile: number; neighbors: RankingsItem[] } {
  const total = rows.length;
  // Rows are ASC by per100ml. cheaperCount = strictly-cheaper rows; the user's
  // insertion slot is right after them (ties are NOT cheaper, so the user ranks
  // after equal-priced rows too — stable with the board's tiebreak intent).
  let cheaperCount = 0;
  while (cheaperCount < total && rows[cheaperCount]!.per100ml < userValue) {
    cheaperCount += 1;
  }
  const rank = cheaperCount + 1;
  // percentile = "你比多少同类便宜" = share of cohort rows STRICTLY pricier than
  // the user (the rows the user genuinely beats). `total = 0 → 0` (no cohort to
  // beat — deterministic empty-cohort convention, never NaN).
  let strictlyPricier = 0;
  for (let i = cheaperCount; i < total; i++) {
    if (rows[i]!.per100ml > userValue) strictlyPricier += 1;
  }
  const percentile = total === 0 ? 0 : (strictlyPricier / total) * 100;
  // Neighbors: the N closest cheaper rows (just below the slot) and the N closest
  // pricier-or-equal rows (at/above the slot), each board-projected with rank =
  // array index + 1.
  const below = rows
    .slice(Math.max(0, cheaperCount - COMPUTE_NEIGHBORS_N), cheaperCount)
    .map((r, i) => projectNeighbor(r, Math.max(0, cheaperCount - COMPUTE_NEIGHBORS_N) + i + 1));
  const above = rows
    .slice(cheaperCount, cheaperCount + COMPUTE_NEIGHBORS_N)
    .map((r, i) => projectNeighbor(r, cheaperCount + i + 1));
  return { rank, total, percentile, neighbors: [...below, ...above] };
}

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // /health is exempt from the entire governance chain (auth + rate + usage),
  // so liveness probes can hit it keyless and high-frequency.
  app.get('/health', (c) => c.json({ ok: true }));

  // GET /rankings — public read-only leaderboard. Like /health, it is EXEMPT
  // from the governance chain: NO `app.use('/rankings', …)` is mounted, so it
  // takes no API key, consumes no rate-limit slot, and records no usage (the
  // protected set is exactly {/parse, /contribute, /ingest, /ingest/batch}).
  // Hono matches `app.use(...)` by exact path, so the protected endpoints'
  // middleware never wraps this route. The handler is strictly READ-ONLY:
  // it validates the query, calls repo.listRankings, projects rows (assigning
  // `rank = offset + 1-based index`), and returns — no write, no LLM, no
  // background task.
  app.get('/rankings', async (c) => {
    // ── Validate query params. Values arrive as strings; RankingsQuerySchema
    //    coerces/clamps limit, validates offset, and enforces category ∈ the seed
    //    kind=category slug set (case-sensitive, default `soft-drink`). Any
    //    failure → 400 invalid-request, same shape/code as the other endpoints.
    //    An out-of-range (but valid) offset is NOT a parse failure — it falls
    //    through to listRankings, which returns [] (→ 200). A legal-but-unseeded
    //    slug also passes the gate and returns [] (→ 200), never a 400.
    const parsedQuery = RankingsQuerySchema.safeParse(c.req.query());
    if (!parsedQuery.success) {
      return c.json(
        {
          error: 'invalid-request',
          message: 'request query failed validation',
          issues: parsedQuery.error.issues.map((i) => ({ path: i.path, message: i.message })),
        },
        400,
      );
    }
    const { limit, offset, category, q } = parsedQuery.data;

    // ── Cohort guard (P3.5): the board is open ONLY for a node that resolves a
    //    non-null comparable_unit (a single rankable cohort — soft-drink / its
    //    leaves / dairy / dairy leaves / each 酒种 leaf). A cross-cohort node
    //    (root `beverage`, the `alcohol` parent) resolves null → reject with
    //    400 invalid-request so per100ml-incomparable boards (矿泉水+葡萄酒,
    //    啤酒+威士忌) never form. The resolve is the STATIC `CATEGORY_NODES`
    //    resolver — NOT the runtime `repo.resolveComparableUnit` — so a legal-
    //    but-unseeded cohort slug (e.g. `beer` before its `tag` row is seeded)
    //    clears the guard (its static unit is `per_100ml`) and falls through to
    //    listRankings → [] (200), while `alcohol`/`beverage` are 400 regardless
    //    of seed state. The guard runs BEFORE the repo, so it adds no D1 round-
    //    trip and reuses the existing invalid-request shape/code (no new code).
    if (resolveComparableUnitStatic(category) === null) {
      return c.json(
        {
          error: 'invalid-request',
          message:
            'this node spans multiple comparable cohorts and cannot be ranked directly; choose a sub-category',
        },
        400,
      );
    }

    // ── Resolve the repository (shared helper; null/throw → 500 persistence-
    //    error). Read-only — no write path is reachable from here.
    const resolved = resolveRepo(c, deps);
    if (!resolved.ok) return resolved.response;
    const repo = resolved.value;

    // ── Read the ascending per100ml slice for the resolved category NODE: the
    //    repository resolves the slug → its tag row and pushes down the closure
    //    filter (`category_closure.ancestor_tag_id = <node>` + `product.rankable=1`
    //    + `per100ml IS NOT NULL`). A legal-but-unseeded/non-category slug yields
    //    [] (not an error). A throw → 500 persistence-error (no recompute, no
    //    retry); per100ml/formula/confidence/warnings are stored values.
    let rows: Awaited<ReturnType<Repository['listRankings']>>;
    try {
      rows = await repo.listRankings({ limit, offset, category, q });
    } catch {
      return c.json({ error: 'persistence-error', message: 'failed to read rankings' }, 500);
    }

    // ── Project RankingRow[] → RankingsItem[]: DROP `id` (the same-table
    //    tiebreak key, not part of the contract) and ADD `rank = offset + 1-based
    //    index`. per100ml/formula/confidence/warnings are taken verbatim from the
    //    stored row (never recomputed). An out-of-range offset yields [] → 200.
    const items = rows.map((row, i) => ({
      rank: offset + i + 1,
      title: row.title,
      priceCents: row.priceCents,
      per100ml: row.per100ml,
      formula: row.formula,
      confidence: row.confidence,
      warnings: row.warnings,
      store: row.store,
      storeSku: row.storeSku,
      sourceUrl: row.sourceUrl,
    }));

    // ── Validate the response shape before returning (contract enforcement,
    //    mirrors /parse + /contribute). Failure → 500 internal.
    const validated = RankingsResponseSchema.safeParse(items);
    if (!validated.success) {
      return c.json({ error: 'internal', message: 'response failed validation' }, 500);
    }
    // ── Cache verdict keys off the POST-PARSE `q`, NOT raw URL key presence:
    //    a real search (`q` resolved to a string, codepoint ≥ 2) gets an EXPLICIT
    //    `no-store` — search is long-tail, each `q` is its own near-never-reused
    //    CDN key, and the CDN partitions on the RAW un-truncated URL (out of sync
    //    with the server's 64-codepoint truncation), so caching it just fills the
    //    CDN with cold misses. Merely OMITTING `public` is NOT enough — Aliyun CDN
    //    self-caches at a default TTL, so we must actively `no-store`. When `q`
    //    parsed to `undefined` (absent / `?q=` / `?q=%20%20`, i.e. no filter) the
    //    body equals the no-`q` cohort board, so it still rides the public edge
    //    cache. (The 400/500 paths above carry no Cache-Control and are never
    //    cached.)
    c.header('Cache-Control', q !== undefined ? 'no-store' : PUBLIC_CACHE_CONTROL);
    return c.json(validated.data, 200);
  });

  // GET /categories — public read-only category-tree browse (the store-agnostic
  // category is-a tree the miniapp's "分类树" Tab renders). Like /rankings and
  // /health it is EXEMPT from the governance chain: NO `app.use('/categories', …)`
  // is mounted, so it takes no API key, consumes no rate-limit slot, and records
  // no usage. Strictly READ-ONLY: it calls repo.listCategoryTree, wraps the nodes
  // in `{ nodes }`, validates the contract, and returns — no write, no LLM, no
  // background task, no outbound fetch. An unseeded taxonomy (DB connected, no
  // kind=category rows) → 200 { nodes: [] }, never an error.
  app.get('/categories', async (c) => {
    // ── Resolve the repository (shared helper; null/throw → 500 persistence-
    //    error, mirroring /rankings). Read-only — no write path is reachable.
    const resolved = resolveRepo(c, deps);
    if (!resolved.ok) return resolved.response;
    const repo = resolved.value;

    // ── Read the full kind=category tree (each node carries the inheritance-
    //    resolved comparableUnit, its own `rankable` axis flag, and the closure-
    //    descendant `rankableCount`). A throw → 500 persistence-error. An
    //    unseeded taxonomy returns [] → 200 { nodes: [] }.
    let nodes: Awaited<ReturnType<Repository['listCategoryTree']>>;
    try {
      nodes = await repo.listCategoryTree();
    } catch {
      return c.json({ error: 'persistence-error', message: 'failed to read categories' }, 500);
    }

    // ── Validate the response shape before returning (contract enforcement,
    //    mirrors /rankings). Failure → 500 internal.
    const validated = CategoryTreeResponseSchema.safeParse({ nodes });
    if (!validated.success) {
      return c.json({ error: 'internal', message: 'response failed validation' }, 500);
    }
    // Edge-cacheable like /rankings; the category tree changes even less often.
    c.header('Cache-Control', PUBLIC_CACHE_CONTROL);
    return c.json(validated.data, 200);
  });

  // POST /compute — stateless on-demand 比价: deterministic per-unit price for a
  // STRUCTURED input (no dirty title → NO AI; this is tier3 only) + in-cohort
  // positioning. Like /rankings and /categories it is EXEMPT from the governance
  // chain (no `app.use('/compute', …)`): it takes no API key and records no
  // usage. STRICTLY no persistence — it reuses core's `calculate` (zero new
  // calculation) and the SAME `repo.listRankings` cohort/rankable/per100ml query
  // for "定位" as /rankings uses for "榜单" (one population, decision D6), and
  // NEVER calls a write method. Error codes mirror the other endpoints
  // (invalid-request 400, persistence-error 500, internal 500). Every response
  // carries `Cache-Control: no-store` (each input is unique — caching is pure
  // CDN-pollution, decision D6).
  app.post('/compute', async (c) => {
    // ── Validate body with the SHARED api-client schema (the trust-boundary
    //    authoritative validation, decision D7): non-JSON / schema fail (incl.
    //    totalPrice ≤ 0, a zero/negative measurement, empty category) → 400.
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid-request', message: 'request body must be valid JSON' }, 400);
    }
    const parsedReq = ComputeRequestSchema.safeParse(body);
    if (!parsedReq.success) {
      return c.json(
        {
          error: 'invalid-request',
          message: 'request body failed validation',
          issues: parsedReq.error.issues.map((i) => ({ path: i.path, message: i.message })),
        },
        400,
      );
    }
    const req: ComputeRequest = parsedReq.data;

    // ── Map ComputeRequest → core ParsedSpec. The slim `{value,unit}` form maps
    //    1:1 onto core's Measurement (`ml|L|g|kg` are identical to core's Unit);
    //    `multipliers:[1]` (no extra-layer packs in the structured form),
    //    `confidence:1` (structured input has NO parse uncertainty). `category`
    //    rides through verbatim (its cohort legality is the guard's concern below).
    const spec: ParsedSpec = {
      unitSize: req.unitSize ?? null,
      quantity: req.quantity ?? null,
      multipliers: [1],
      totalAmount: req.totalAmount ?? null,
      category: req.category,
      confidence: 1,
    };

    // ── Input-set sufficiency FIRST (compute-required set): have `totalAmount`
    //    OR `unitSize`+`quantity`, plus price > 0. Insufficient → 400 naming the
    //    missing class (NOT a silent per100ml=null 200, decision D5).
    if (!meetsComputeRequiredSet(spec, req.totalPrice)) {
      return c.json(
        {
          error: 'invalid-request',
          message:
            '输入集不足：请补充「总量」或「单件容量 + 数量」之一（再加总价）才能计算单价',
        },
        400,
      );
    }

    // ── tier3 deterministic calculation (core, ZERO new calc logic). An
    //    uncomputable terminal state (price 非正 / 无可识别单位轴 / 规格不自洽 →
    //    both axes null + warning) is NEVER a silent 200: map it to 400 carrying
    //    core's warning (decision D5). A successful CalcResult has exactly ONE
    //    per100 axis non-null.
    const calc = calculate(spec, req.totalPrice);
    if (calc.unitPrice.formula === null) {
      return c.json(
        {
          error: 'invalid-request',
          message: calc.warnings[0] ?? '无法计算单价',
        },
        400,
      );
    }
    const inputAxisField: 'per100ml' | 'per100g' =
      calc.unitPrice.per100ml !== null ? 'per100ml' : 'per100g';
    const userValue = calc.unitPrice[inputAxisField] as number;

    // ── Known-slug gate (BEFORE the cohort resolver): `category` MUST be a member
    //    of the SAME compile-time seed slug set `/rankings` validates against
    //    (`CATEGORY_SLUGS`). A non-member (typo / unknown) → 400 未知品类 — a
    //    DISTINCT message from the cross-cohort one below, so a typo is not
    //    misdiagnosed as 「跨多个比价口径」. (`/rankings` gets this gate for free via
    //    its `z.enum(CATEGORY_SLUGS)` query schema; /compute's category arrives in
    //    the body as a plain `z.string().min(1)`, so the gate is explicit here.)
    if (!CATEGORY_SLUGS.includes(req.category)) {
      return c.json({ error: 'invalid-request', message: '未知品类' }, 400);
    }

    // ── Cohort comparability guard (decision D4), reusing the SAME static
    //    resolver as /rankings. null (a cross-cohort node: `beverage`/`alcohol`)
    //    → 400 (cannot 比价 directly). Non-null but NOT mapping to the input axis
    //    (input g into a per_100ml cohort) → 400 不可比, naming the cohort's 比价
    //    axis. The guard runs BEFORE any repo read.
    const cohortUnit = resolveComparableUnitStatic(req.category);
    if (cohortUnit === null) {
      return c.json(
        {
          error: 'invalid-request',
          message:
            '该品类跨多个比价口径，无法直接比价；请选择具体子品类',
        },
        400,
      );
    }
    const cohortAxis = cohortAxisField(cohortUnit);
    // per_100g cohorts are unservable this period: the positioning read reuses the
    // per100ml-only /rankings query, so a per_100g cohort would mis-position a
    // g-value against an ml board (a confident garbage rank). Reject explicitly
    // until the 重量轴 backfill extends listRankings/RankingsItem to a per100g board.
    if (cohortAxis === 'per100g') {
      return c.json(
        { error: 'invalid-request', message: '本期暂不支持按重量（每100g）比价' },
        400,
      );
    }
    // The only servable axis now is per_100ml. Reject a cross-axis input (g into
    // the ml cohort) or an unservable non-volume cohort (e.g. per_100sheet → null).
    // No raw comparable-unit slug ever reaches the user message.
    if (cohortAxis === null || cohortAxis !== inputAxisField) {
      return c.json(
        {
          error: 'invalid-request',
          message:
            cohortAxis === null
              ? '该品类暂不支持比价'
              : '输入单位与该品类的比价口径不一致：该品类按每 100ml 比价，请使用 ml/L',
        },
        400,
      );
    }

    // ── Resolve the repository for the in-cohort positioning read (shared
    //    helper; null/throw → 500 persistence-error). Read-only — no write path
    //    is reachable from here.
    const resolved = resolveRepo(c, deps);
    if (!resolved.ok) return resolved.response;
    const repo = resolved.value;

    // ── Read the FULL ascending cohort board via the SAME cohort/rankable/
    //    per100ml query /rankings uses (one population, decision D6). A throw →
    //    500 persistence-error. An empty / unseeded cohort returns [] → a valid
    //    200 with empty neighbors (never a 404).
    let rows: RankingRow[];
    try {
      rows = await repo.listRankings({
        limit: COMPUTE_COHORT_FETCH_MAX,
        offset: 0,
        category: req.category,
      });
    } catch {
      return c.json({ error: 'persistence-error', message: 'failed to read cohort for positioning' }, 500);
    }

    // ── Deterministic positioning (pure): rank / total / percentile + boundary
    //    neighbors. `rows` is already ASC by per100ml (the /rankings order).
    const { rank, total, percentile, neighbors } = positionInCohort(rows, userValue);

    // ── Assemble + validate the response (contract enforcement, mirrors the
    //    other endpoints). EXACTLY one per100 axis is non-null (the computed one).
    const validated = ComputeResultSchema.safeParse({
      per100ml: calc.unitPrice.per100ml,
      per100g: calc.unitPrice.per100g,
      formula: calc.unitPrice.formula,
      axis: axisLabel(inputAxisField),
      rank,
      total,
      percentile,
      neighbors,
    });
    if (!validated.success) {
      return c.json({ error: 'internal', message: 'response failed validation' }, 500);
    }
    // Each input is unique → never edge-cache (decision D6). The 400/500 paths
    // above carry NO Cache-Control (never cached).
    c.header('Cache-Control', 'no-store');
    return c.json(validated.data, 200);
  });

  // Governance runs only on /parse, before the business handler. Order inside
  // the middleware: auth → rate-limit → usage → next().
  app.use('/parse', governanceMiddleware(deps.governance));

  app.post('/parse', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid-request', message: 'request body must be valid JSON' }, 400);
    }

    const parsedReq = ParseRequestSchema.safeParse(body);
    if (!parsedReq.success) {
      return c.json(
        {
          error: 'invalid-request',
          message: 'request body failed validation',
          issues: parsedReq.error.issues.map((i) => ({ path: i.path, message: i.message })),
        },
        400,
      );
    }

    const input: RawProduct = parsedReq.data;
    // Build the LLM port from THIS request's injected env (no cross-request
    // bleed). The factory's lazy parser only resolves config if tier2 is reached.
    const llm = deps.makeLlm(c.env);
    const outcome = await orchestrate(input, llm);

    if (outcome.kind === 'config-error') {
      // Distinguishable 5xx: runtime configuration error (no confidence body).
      return c.json({ error: 'config-error', message: outcome.message }, 500);
    }
    if (outcome.kind === 'insufficient') {
      // Distinguishable 5xx: information insufficient — can't even judge
      // computability (tier2 transport failed + tier1 had no shape).
      return c.json({ error: 'insufficient-information', message: outcome.message }, 503);
    }

    // Validate the response shape before returning (contract enforcement).
    const validated = ParseResponseSchema.safeParse(outcome.response);
    if (!validated.success) {
      return c.json({ error: 'internal', message: 'response failed validation' }, 500);
    }
    return c.json(validated.data, 200);
  });

  // Governance runs on /contribute too, mounted BEFORE the handler so Hono
  // (which matches by registration order) wraps the route. Mounting the
  // middleware after the handler would leave /contribute unauthenticated.
  app.use('/contribute', governanceMiddleware(deps.governance));

  app.post('/contribute', async (c) => {
    // ── Validate request body (4.2): non-JSON / schema fail / empty dedupe
    //    keys → 400 invalid-request. No row written, orchestrate not entered.
    const parsed = await parseContributeBody(c);
    if (!parsed.ok) return parsed.response;
    const req = parsed.value;

    // ── Resolve the repository (4.3). null/throw → 500 persistence-error.
    const resolved = resolveRepo(c, deps);
    if (!resolved.ok) return resolved.response;
    const repo = resolved.value;

    // ── upsertRaw FIRST (4.4) — observation-first: the raw report is the most
    //    valuable crowd-sourced asset, persisted even if parsing later fails.
    const landed = await landRaw(c, repo, req);
    if (!landed.ok) return landed.response;
    const rawId = landed.value;

    // ── orchestrate (4.5). raw is already persisted and is NOT rolled back on
    //    failure; config-error/insufficient responses carry the landed rawId so
    //    the client knows the observation is saved and a retry only re-parses
    //    (which re-triggers tier2 LLM — abuse cost is bounded by api-governance
    //    rate limiting).
    const input: RawProduct = { title: req.title, price: req.price, categoryHint: req.categoryHint };
    const outcome = await orchestrate(input, deps.makeLlm(c.env));

    if (outcome.kind === 'config-error') {
      return c.json({ error: 'config-error', message: outcome.message, rawId }, 500);
    }
    if (outcome.kind === 'insufficient') {
      return c.json({ error: 'insufficient-information', message: outcome.message, rawId }, 503);
    }

    // ── saveParsed on ok (4.6). calc is assembled directly from orchestrate's
    //    response (no recompute); uncomputable results (per100ml/formula=null)
    //    are persisted normally.
    const res = outcome.response;
    let saved: { productId: string; unitPriceId: string };
    try {
      saved = await repo.saveParsed({
        rawId,
        spec: res.spec,
        calc: { unitPrice: res.unitPrice, confidence: res.confidence, warnings: res.warnings },
      });
    } catch {
      return c.json({ error: 'persistence-error', message: 'failed to persist parsed result', rawId }, 500);
    }

    // ── Assemble + validate the response (4.7). Validation failure → internal.
    const validated = ContributeResponseSchema.safeParse({
      spec: res.spec,
      unitPrice: res.unitPrice,
      confidence: res.confidence,
      warnings: res.warnings,
      rawId,
      productId: saved.productId,
      unitPriceId: saved.unitPriceId,
    });
    if (!validated.success) {
      return c.json({ error: 'internal', message: 'response failed validation' }, 500);
    }
    return c.json(validated.data, 200);
  });

  // Governance runs on /ingest too, mounted BEFORE the handler (same order as
  // /parse and /contribute) so Hono — which matches by registration order —
  // wraps the route; mounting it after would leave /ingest unauthenticated.
  app.use('/ingest', governanceMiddleware(deps.governance));

  // POST /ingest — async crowd-sourced capture: land raw synchronously, return
  // 202 immediately, run orchestrate + saveParsed in the BACKGROUND. Shares the
  // "validate body → resolve repo → land raw" preamble with /contribute; the two
  // diverge only on parse timing (background) + response (202 {rawId}). The
  // request-path error code set is {invalid-request(400), persistence-error(500),
  // internal(500), accepted(202)} plus governance codes — NO insufficient-
  // information / config-error, because upsertRaw success is already a 202 and
  // any orchestrate/saveParsed failure happens in the background (logged only).
  app.post('/ingest', async (c) => {
    // ── Same preamble as /contribute (helpers keep the behavior identical).
    const parsed = await parseContributeBody(c);
    if (!parsed.ok) return parsed.response; // 400 invalid-request
    const req = parsed.value;

    const resolved = resolveRepo(c, deps);
    if (!resolved.ok) return resolved.response; // 500 persistence-error
    const repo = resolved.value;

    const landed = await landRaw(c, repo, req);
    if (!landed.ok) return landed.response; // 500 persistence-error
    const rawId = landed.value;

    // ── Background work unit: orchestrate (tier1+tier2+tier3) then saveParsed on
    //    `ok`. It is `async` and SELF-WRAPS try/catch so both synchronous and
    //    asynchronous failures stay confined to the background (a rejected
    //    promise handed to waitUntil) and NEVER propagate back to the already-
    //    decided 202 path. Three-state failure disposition: log only — no retry,
    //    no LLM re-burn (event-driven, each report parsed exactly once).
    const env = c.env;
    const input: RawProduct = { title: req.title, price: req.price, categoryHint: req.categoryHint };
    const run = async (): Promise<void> => {
      try {
        const outcome = await orchestrate(input, deps.makeLlm(env));
        if (outcome.kind === 'insufficient') {
          // tier2 transport failed + tier1 had no shape (e.g. a spec-less title):
          // log structured (rawId/store/sku) and stop — leaves the intentionally
          // accepted "raw, no product" intermediate state.
          console.warn('[ingest] background parse insufficient', {
            rawId,
            store: req.store,
            storeSku: req.storeSku,
          });
          return;
        }
        if (outcome.kind === 'config-error') {
          console.error('[ingest] background parse config-error', {
            rawId,
            store: req.store,
            storeSku: req.storeSku,
            message: outcome.message,
          });
          return;
        }
        // ok → saveParsed. calc is assembled directly from orchestrate's response
        // (no recompute); uncomputable (per100ml=null) is persisted normally.
        const res = outcome.response;
        await repo.saveParsed({
          rawId,
          spec: res.spec,
          calc: { unitPrice: res.unitPrice, confidence: res.confidence, warnings: res.warnings },
        });
      } catch (err) {
        // saveParsed throw (or any other background failure): log only, no
        // retry, no LLM re-burn. Keeps the "raw, no product" intermediate state.
        console.error('[ingest] background work failed', {
          rawId,
          store: req.store,
          storeSku: req.storeSku,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    };

    // ── Schedule the background work via the injected port (NEVER bare
    //    c.executionCtx). Production's waitUntil version returns void so this
    //    `await` resolves immediately (202 lands fast); the default/dev sync
    //    version awaits `run()` to completion (deterministic for tests).
    await (deps.scheduleBackground ?? ((_c, r) => r()))(c, run);

    // ── Validate the 202 body (rawId from upsertRaw is always non-empty, so this
    //    is a defensive guard); failure → 500 internal (mirrors /contribute).
    const validated = IngestResponseSchema.safeParse({ rawId });
    if (!validated.success) {
      return c.json({ error: 'internal', message: 'response failed validation' }, 500);
    }
    return c.json(validated.data, 202);
  });

  // Governance runs on /ingest/batch too, mounted BEFORE the handler. Hono
  // matches `app.use('/ingest', …)` by EXACT path, so the /ingest middleware
  // does NOT wrap /ingest/batch — the batch endpoint MUST mount its own
  // governance. Registered right after /ingest for locality.
  app.use('/ingest/batch', governanceMiddleware(deps.governance));

  // POST /ingest/batch — batch async crowd-sourced capture: land each item's raw
  // SYNCHRONOUSLY (shared upsertRawOrNull map), then schedule a SINGLE bounded-
  // concurrency background unit (BG_POOL) draining all landed items, and return
  // 202 immediately. Request-path error codes mirror /ingest:
  // {invalid-request(400), persistence-error(500), internal(500), accepted(202)}
  // plus governance codes. accepted=0 (every upsertRaw failed) → 500 (NO 2xx
  // masking a whole-batch write failure as accepted).
  app.post('/ingest/batch', async (c) => {
    // ── Envelope validation. Non-JSON → 400 invalid-request.
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid-request', message: 'request body must be valid JSON' }, 400);
    }

    // Strict: empty array / over MAX_BATCH / any item failing
    // ContributeRequestSchema → 400, whole batch rejected, no row written.
    const parsedReq = BatchIngestRequestSchema.safeParse(body);
    if (!parsedReq.success) {
      return c.json(
        {
          error: 'invalid-request',
          message: 'request body failed validation',
          issues: parsedReq.error.issues.map((i) => ({ path: i.path, message: i.message })),
        },
        400,
      );
    }
    const items = parsedReq.data.items;

    // ── Resolve the repository (reused). null/throw → 500 persistence-error
    //    (whole batch, no raw landed).
    const resolved = resolveRepo(c, deps);
    if (!resolved.ok) return resolved.response;
    const repo = resolved.value;

    // ── Synchronous per-item landing via the SHARED map. Each item lands
    //    independently; a throw (null) does not stop the rest. Invariant:
    //    accepted + failed.length === items.length.
    const landed: Array<{ rawId: string; req: ContributeRequest }> = [];
    const failed: Array<{ index: number; store: string; storeSku: string }> = [];
    for (let index = 0; index < items.length; index++) {
      const item = items[index]!;
      const rawId = await upsertRawOrNull(repo, item);
      if (rawId === null) {
        failed.push({ index, store: item.store, storeSku: item.storeSku });
      } else {
        landed.push({ rawId, req: item });
      }
    }
    const accepted = landed.length;

    // ── SINGLE bounded-concurrency background unit (NOT one waitUntil per item —
    //    that would fan out MAX_BATCH unbounded concurrent units). drainBackground
    //    consumes `landed` through a fixed pool of BG_POOL workers; each item runs
    //    the SAME logic as /ingest's background `run` (orchestrate → ok ?
    //    saveParsed : log), self-wrapping try/catch so one item never trips the
    //    others. BG_POOL bounds CONCURRENCY; MAX_BATCH bounds TOTAL subrequests.
    const env = c.env;
    const drainBackground = async (
      units: Array<{ rawId: string; req: ContributeRequest }>,
      pool: number,
    ): Promise<void> => {
      let cursor = 0;
      const runOne = async (unit: { rawId: string; req: ContributeRequest }): Promise<void> => {
        const { rawId, req } = unit;
        try {
          const input: RawProduct = { title: req.title, price: req.price, categoryHint: req.categoryHint };
          const outcome = await orchestrate(input, deps.makeLlm(env));
          if (outcome.kind === 'insufficient') {
            console.warn('[ingest/batch] background parse insufficient', {
              rawId,
              store: req.store,
              storeSku: req.storeSku,
            });
            return;
          }
          if (outcome.kind === 'config-error') {
            console.error('[ingest/batch] background parse config-error', {
              rawId,
              store: req.store,
              storeSku: req.storeSku,
              message: outcome.message,
            });
            return;
          }
          // ok → saveParsed. calc assembled directly from orchestrate's response
          // (no recompute); uncomputable (per100ml=null) persisted normally.
          const res = outcome.response;
          await repo.saveParsed({
            rawId,
            spec: res.spec,
            calc: { unitPrice: res.unitPrice, confidence: res.confidence, warnings: res.warnings },
          });
        } catch (err) {
          console.error('[ingest/batch] background work failed', {
            rawId,
            store: req.store,
            storeSku: req.storeSku,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      };
      const worker = async (): Promise<void> => {
        while (cursor < units.length) {
          const unit = units[cursor++]!;
          await runOne(unit);
        }
      };
      const workers: Array<Promise<void>> = [];
      const width = Math.min(pool, units.length);
      for (let i = 0; i < width; i++) workers.push(worker());
      await Promise.all(workers);
    };

    if (accepted >= 1) {
      // Schedule the background unit ONCE (single waitUntil) — the pool limits
      // concurrency internally. Production's waitUntil returns void so this
      // `await` resolves immediately; the dev/default sync version awaits the
      // whole drain (deterministic for tests).
      await (deps.scheduleBackground ?? ((_c, r) => r()))(c, () => drainBackground(landed, BG_POOL));
    }

    // ── Usage stacking: admission already counted 1 (governance middleware).
    //    Total usage for the request should equal `accepted`, so add (accepted-1)
    //    when accepted>1. Guard >1 so we never pass amount ≤ 0 (would corrupt the
    //    KV count). Stacking failure does not throw / does not change the response.
    const key = c.get('govKey');
    if (accepted > 1) await deps.governance.recordUsage(c.env, key, accepted - 1);

    // ── Status code. accepted=0 (every upsertRaw failed) → 500 persistence-error,
    //    NO result body (mirrors single /ingest upsertRaw failure → 500; never a
    //    2xx masking a whole-batch write failure as accepted).
    if (accepted === 0) {
      return c.json({ error: 'persistence-error', message: 'failed to persist any raw report' }, 500);
    }

    // accepted ≥ 1 → assemble + validate the 202 body. Validation failure → 500
    // internal (defensive guard, effectively unreachable).
    const validated = BatchIngestResponseSchema.safeParse({ accepted, failed });
    if (!validated.success) {
      return c.json({ error: 'internal', message: 'response failed validation' }, 500);
    }
    return c.json(validated.data, 202);
  });

  // POST /admin/backfill — admin-tier taxonomy backfill 驱动。挂专用 authenticate-
  // only admin gate(独立 ADMIN_API_KEYS;**非**公共 governanceMiddleware → 不跑
  // rate/usage)。Hono 精确路径:每个 /admin/* 各自挂 gate(无前缀 catch-all)。
  const adminGov = deps.adminGovernance ?? createRealGovernance({ allowlistVar: 'ADMIN_API_KEYS' });
  app.use('/admin/backfill', authOnlyMiddleware(adminGov));
  app.post('/admin/backfill', async (c) => {
    const parsed = AdminBackfillQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: 'invalid-request', message: 'invalid cursor/limit', issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) }, 400);
    }
    const { cursor, limit } = parsed.data;

    const resolved = resolveRepo(c, deps);
    if (!resolved.ok) return resolved.response;
    const repo = resolved.value;

    let db: Db | null;
    try { db = deps.makeDb?.(c.env) ?? null; } catch { db = null; }
    if (db === null) return c.json({ error: 'persistence-error', message: 'no database bound' }, 500);

    // 审计:keyed-哈希 admin key(原文绝不落日志);adminKey 由 authenticate-only gate 放行时设。
    // secret 缺失则 fail-close — 审计 keying 是必需项,绝不降级到源码常量 salt。
    const auditSecret = c.env.AUDIT_LOG_HMAC_SECRET;
    if (!auditSecret) {
      console.warn('[admin/backfill] AUDIT_LOG_HMAC_SECRET unconfigured — refusing (audit keying required)');
      return c.json({ error: 'config-error', message: 'service configuration error' }, 500);
    }
    const adminKey = c.get('adminKey') ?? '';
    const keyHash = await hmacKeyId(adminKey, auditSecret);

    let result;
    try {
      result = await runBackfill(repo, db, { cursor, limit });
    } catch {
      console.warn('[admin/backfill] failed', { keyHash, cursor: cursor ?? null, limit });
      return c.json({ error: 'persistence-error', message: 'backfill failed' }, 500);
    }

    console.warn('[admin/backfill]', {
      keyHash, cursor: cursor ?? null, limit,
      total: result.total, classified: result.classified, pending: result.pending,
      manual: result.manual, rankable: result.rankable,
      storeMapDecisions: result.storeMapDecisions, nextCursor: result.nextCursor,
      at: new Date().toISOString(),
    });

    // 响应:只回计数 + nextCursor(投影掉 results[])。storeMapDecisions = 本块内
    // store-map 定叶(异叶)的决定数;backfill 分块续跑时门值须跨所有块累加。
    return c.json({
      total: result.total, classified: result.classified, pending: result.pending,
      manual: result.manual, rankable: result.rankable,
      storeMapDecisions: result.storeMapDecisions, nextCursor: result.nextCursor,
    });
  });

  return app;
}
