// Compute contract — transport-agnostic single source of truth for POST /compute
// (on-demand unit-price + in-cohort positioning). Lives here so `apps/api` and
// every client (miniapp, web, plugin) depend on ONE request/response schema.
//
// SELF-CONTAINED by design (decision D3): this module DELIBERATELY does NOT
// import `@unit-price/core`. Its request shape is a slim `{ value, unit }` form
// defined locally — NOT core's `ParsedSpecSchema`/`MeasurementSchema` — because
// `@unit-price/api-client` is bundled into the WeChat mini-program (weapp) and
// dragging core through it would re-trigger the weapp pitfalls core hits
// (modern-syntax transpile breaking Zod classes + JIT `new Function` vs eval
// ban). The server (apps/api, which MAY legally depend on core) maps a
// ComputeRequest onto core's `ParsedSpec` and calls `calculate()`; the slim
// `{ value, unit }` duplication (2 fields) is the accepted cost of keeping core
// OUT of weapp. The response REUSES `RankingsItemSchema` from `./rankings.js`
// (a sibling api-client module) for `neighbors` so a positioned row projects
// identically to a board row — `./rankings.js` is intra-package, NOT a core
// import.
import { z } from 'zod';
import { RankingsItemSchema, type RankingsItem } from './rankings.js';
import { cleanOrigin } from './client.js';

/**
 * The measurement unit set accepted by POST /compute. A slim, self-contained
 * enum (NOT core's `UnitSchema`) — only the four units the structured form
 * offers: volume `ml`/`L`, mass `g`/`kg`. The server maps these onto core's
 * unit handling; keeping the enum local is what keeps core out of weapp (D3).
 */
export const ComputeUnitSchema = z.enum(['ml', 'L', 'g', 'kg']);

export type ComputeUnit = z.infer<typeof ComputeUnitSchema>;

/**
 * A single structured measurement: a strictly-positive magnitude + a unit. The
 * slim local stand-in for core's `MeasurementSchema` (D3). `value` MUST be
 * `> 0` — a zero/negative size is meaningless input the form must not send and
 * the server authoritatively rejects.
 */
export const ComputeMeasurementSchema = z.object({
  value: z.number().positive(),
  unit: ComputeUnitSchema,
});

export type ComputeMeasurement = z.infer<typeof ComputeMeasurementSchema>;

/**
 * POST /compute request body. The user enters CLEAN structured fields (no dirty
 * title to "understand"), so there is no AI step — the server runs core tier3
 * deterministic calculation only (per the compute-api spec / decision D1).
 *
 * Field shapes (Zod is the single source of truth; the server validates the
 * request body with THIS SAME schema — authoritative validation at the trust
 * boundary, decision D7):
 *  - `totalPrice` is the strictly-positive total yuan price the user paid/saw.
 *    `> 0` here is a cheap client-side guard; an `<= 0` value that slips through
 *    drives core into its uncomputable terminal state, which the server maps to
 *    a `400` (NOT a silent `200`, decision D5).
 *  - `quantity` is an OPTIONAL positive integer (pack count). Required ONLY in
 *    the `unitSize`+`quantity` input path; the server's `meetsComputeRequiredSet`
 *    check (not this schema) enforces the per-path required set.
 *  - `unitSize` / `totalAmount` are the two mutually-exclusive ways to express
 *    the comparable amount: per-unit size × quantity, OR a single total amount.
 *    Both OPTIONAL at the schema level; the server enforces "have `totalAmount`
 *    OR have `unitSize`+`quantity`" via `meetsComputeRequiredSet` and `400`s an
 *    insufficient set (spec scenario "输入集不足返回 400").
 *  - `category` is a non-empty cohort slug (the leaf cohort the user is pricing
 *    into). Non-empty here; cohort legality (cross-cohort node / axis mismatch)
 *    is the server's `resolveComparableUnitStatic` `400` concern, NOT this
 *    schema's.
 */
export const ComputeRequestSchema = z
  .object({
    totalPrice: z.number().positive(),
    quantity: z.number().int().positive().optional(),
    unitSize: ComputeMeasurementSchema.optional(),
    totalAmount: ComputeMeasurementSchema.optional(),
    category: z.string().min(1),
  })
  // `unitSize` and `totalAmount` are the two MUTUALLY-EXCLUSIVE ways to express
  // the comparable amount — the client sends one or the other, never both
  // (二选一互斥). Both present is ambiguous input the server rejects at the trust
  // boundary (→ 400). The `meetsComputeRequiredSet` check still enforces that AT
  // LEAST one path is complete; this refine forbids supplying both at once.
  .refine((req) => !(req.unitSize != null && req.totalAmount != null), {
    message: 'unitSize 与 totalAmount 二选一，不能同时提供',
  });

export type ComputeRequest = z.infer<typeof ComputeRequestSchema>;

/**
 * POST /compute response body: the user's deterministic unit price + replayable
 * `formula` + position within the selected cohort.
 *
 * Field shapes:
 *  - `per100ml` / `per100g` are nullable; EXACTLY ONE is non-null — the axis the
 *    cohort compares on. The non-null one matches `axis`. (The schema admits
 *    both-null structurally, but the server NEVER returns both-null: an
 *    uncomputable result is a `400`, not a `200` with two nulls — decision D5.)
 *  - `formula` is the non-empty replayable calculation string straight from
 *    core's `calculate` (computation留痕). A successful `200` always carries one.
 *  - `axis` is the cohort's comparable unit axis (`per_100ml` | `per_100g`),
 *    resolved by the server's `resolveComparableUnitStatic` guard and matched
 *    against the input axis (mismatch → `400`, decision D4).
 *  - `rank` is 1-based: count of rankable cohort rows whose axis unit price is
 *    `<` the user's value, plus 1. `>= 1` always (an empty cohort gives
 *    `total=0`, `rank=1` per the spec's deterministic convention).
 *  - `total` is the cohort's rankable row count (`>= 0`; the "定位" total is the
 *    same population as the "榜单", decision D6).
 *  - `percentile` is derived from `rank`/`total` (a `0..100` number; the schema
 *    keeps it an unconstrained number — the deterministic value for `total=0` is
 *    the server's convention, not a schema concern).
 *  - `neighbors` REUSES `RankingsItemSchema` so each is a board-identical
 *    projection (up to N each side of the user's value; MAY be empty or
 *    one-sided at a boundary — empty is a valid `200`, never a `404`).
 */
export const ComputeResultSchema = z
  .object({
    per100ml: z.number().nullable(),
    per100g: z.number().nullable(),
    formula: z.string().min(1),
    axis: z.enum(['per_100ml', 'per_100g']),
    rank: z.number().int().min(1),
    total: z.number().int().min(0),
    percentile: z.number(),
    neighbors: z.array(RankingsItemSchema),
  })
  // EXACTLY ONE per100 axis is non-null, and it MUST match `axis`:
  // `axis==='per_100ml'` ⟺ per100ml non-null & per100g null; `axis==='per_100g'`
  // ⟺ per100g non-null & per100ml null. A both-null (uncomputable — that is a
  // 400, never a 200), both-non-null, or axis-mismatched result is structurally
  // invalid and fails the parse (fail-closed).
  .refine(
    (res) =>
      res.axis === 'per_100ml'
        ? res.per100ml !== null && res.per100g === null
        : res.per100g !== null && res.per100ml === null,
    { message: 'exactly one per100 axis must be non-null and match `axis`' },
  );

export type ComputeResult = z.infer<typeof ComputeResultSchema>;

// Re-export the reused neighbor row type so a compute consumer can name it
// without reaching into ./rankings.js directly.
export type { RankingsItem };

/**
 * Serialize the POST /compute target URL from a clean API origin. PURE: does not
 * send a request and takes NO query params — the request body carries the
 * `ComputeRequest`, so the URL is always `<origin>/compute`.
 *
 * `base` MUST be a clean `http(s)` origin (`https://host[:port]`) with NO path
 * segment, query, or fragment; it is validated by the SAME `cleanOrigin` helper
 * as `buildRankingsUrl`/`buildCategoriesUrl` (one fail-fast contract, no
 * divergent copy). Anything else throws (fail-fast) — never a silently-malformed
 * URL.
 */
export function buildComputeUrl(base: string): string {
  const origin = cleanOrigin(base, 'buildComputeUrl');
  return `${origin}/compute`;
}

/**
 * Validate an untrusted POST /compute response body against the contract.
 * Signature mirrors `parseRankingsResponse(json)` EXACTLY: a single `json`
 * param, `{ jitless: true }` hardcoded internally (NEVER exposed as a caller
 * option). Uses `ComputeResultSchema.parse` (fail-CLOSED): on a schema mismatch
 * the raised `ZodError` bubbles up UNWRAPPED — callers catch any throw and enter
 * their error state. NEVER returns unvalidated or partial data.
 *
 * `jitless: true` forces Zod's interpreted parser instead of its `new Function`
 * JIT fast-path, keeping this validator runnable in eval-restricted runtimes:
 * the WeChat mini-program forbids `new Function` — and its non-throwing stub
 * defeats Zod's eval probe, so the JIT path fails deep in `_zod.parse`. Same
 * runtime constraint and known pitfall as `parseRankingsResponse`.
 */
export function parseComputeResponse(json: unknown): ComputeResult {
  return ComputeResultSchema.parse(json, { jitless: true });
}
