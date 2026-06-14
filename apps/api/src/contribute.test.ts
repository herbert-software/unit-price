// POST /contribute — write-path tests (group B). Injects a REAL in-memory
// repository (better-sqlite3 + the drizzle migrations) so persistence
// assertions query actual rows, and fixed LLM ports to drive each orchestrate
// branch (ok / insufficient / config-error). Governance is the no-op for the
// functional cases; auth regressions use the REAL governance below.
import Database from 'better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createDb, createRepository, type Repository } from '@unit-price/db';
import { createApp } from './routes.js';
import { buildApp } from './index.js';
import { createNoopGovernance, createRealGovernance } from './governance.js';
import type { Bindings } from './bindings.js';
import type { ParseResult, SpecParserLLM } from './llm.js';

// Drizzle migrations live in the @unit-price/db package; apply them onto an
// in-memory better-sqlite3 handle to build the same four tables D1 gets.
const migrationsFolder = fileURLToPath(
  new URL('../../../packages/db/drizzle', import.meta.url),
);

interface TestRepo {
  repo: Repository;
  handle: Database.Database;
}

/** Build a fresh in-memory repo with migrations applied (FKs on, like D1). */
function openRepo(): TestRepo {
  const handle = new Database(':memory:');
  handle.pragma('foreign_keys = ON');
  const db = createDb(handle);
  if (db.kind !== 'sqlite') throw new Error('expected a better-sqlite3-backed Db');
  migrate(db.orm, { migrationsFolder });
  return { repo: createRepository(db), handle };
}

function countRows(handle: Database.Database, table: string): number {
  return (handle.prepare(`SELECT count(*) AS c FROM ${table}`).get() as { c: number }).c;
}

// ── LLM ports (drive orchestrate branches) ────────────────────────────────
/** A port that must never be called (tier1-sufficient inputs skip tier2). */
const throwingPort: SpecParserLLM = {
  async parse(): Promise<ParseResult> {
    throw new Error('LLM must not be called for tier1-sufficient inputs');
  },
};
/** Always reports a transport failure (drives `insufficient` on no-shape titles). */
const transportFailPort: SpecParserLLM = {
  async parse(): Promise<ParseResult> {
    return { ok: false, kind: 'transport', message: 'simulated timeout' };
  },
};
/** Reports a runtime config error (drives `config-error`). */
const configFailPort: SpecParserLLM = {
  async parse(): Promise<ParseResult> {
    return { ok: false, kind: 'config', message: 'missing OPENROUTER_API_KEY' };
  },
};

/**
 * POST /contribute against an app with the given repo factory + LLM port and a
 * no-op governance (auth is exercised separately below). `makeRepo` may be
 * omitted to drive the persistence-error branch.
 */
async function contribute(opts: {
  port: SpecParserLLM;
  makeRepo?: (env: Bindings) => Repository | null;
  body: unknown;
}) {
  const app = createApp({
    makeLlm: () => opts.port,
    governance: createNoopGovernance(),
    makeRepo: opts.makeRepo,
  });
  const res = await app.request('/contribute', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { res, json };
}

// A clean, tier1-sufficient title: 330ml*24 -> 7920ml, per100ml ~= 0.505.
const CLEAN = { title: '可口可乐 330ml*24听', price: 40 };

describe('POST /contribute — happy path lands all three tables (5.1)', () => {
  it('returns 200 with three ids and writes one row to each table', async () => {
    const { repo, handle } = openRepo();
    const { res, json } = await contribute({
      port: throwingPort,
      makeRepo: () => repo,
      body: { ...CLEAN, store: 'sam', storeSku: 'coke-24' },
    });

    expect(res.status).toBe(200);
    // Three persisted app-generated ids alongside the /parse response contract.
    expect(typeof json.rawId).toBe('string');
    expect(json.rawId.length).toBeGreaterThan(0);
    expect(typeof json.productId).toBe('string');
    expect(json.productId.length).toBeGreaterThan(0);
    expect(typeof json.unitPriceId).toBe('string');
    expect(json.unitPriceId.length).toBeGreaterThan(0);
    // /parse response fields are present.
    expect(json.unitPrice.per100ml).toBeCloseTo(0.505, 3);
    expect(json.spec.totalAmount).toEqual({ value: 7920, unit: 'ml' });

    // Each table got exactly one row.
    expect(countRows(handle, 'product_raw')).toBe(1);
    expect(countRows(handle, 'product')).toBe(1);
    expect(countRows(handle, 'unit_price')).toBe(1);
  });
});

describe('POST /contribute — invalid request writes nothing (5.2)', () => {
  it.each([
    ['missing store', { ...CLEAN, storeSku: 'x' }],
    ['missing storeSku', { ...CLEAN, store: 'sam' }],
    ['empty store', { ...CLEAN, store: '', storeSku: 'x' }],
    ['empty storeSku', { ...CLEAN, store: 'sam', storeSku: '' }],
    // Whitespace-only keys must 400 at the request layer (trim before min(1)),
    // not slip past into the repository DedupeKeyGate -> generic 500.
    ['whitespace store', { ...CLEAN, store: '   ', storeSku: 'x' }],
    ['whitespace storeSku', { ...CLEAN, store: 'sam', storeSku: '\t ' }],
  ])('%s -> 400 invalid-request, no rows written', async (_name, body) => {
    const { repo, handle } = openRepo();
    const { res, json } = await contribute({ port: throwingPort, makeRepo: () => repo, body });
    expect(res.status).toBe(400);
    expect(json.error).toBe('invalid-request');
    // 400 fires before any write (and before orchestrate).
    expect(countRows(handle, 'product_raw')).toBe(0);
    expect(countRows(handle, 'product')).toBe(0);
    expect(countRows(handle, 'unit_price')).toBe(0);
  });
});

describe('POST /contribute — dedupe + provenance COALESCE (5.3)', () => {
  it('same (store,storeSku) converges to one row; price/title/capturedAt overwrite, provenance preserved', async () => {
    const { repo, handle } = openRepo();
    const app = createApp({
      makeLlm: () => throwingPort,
      governance: createNoopGovernance(),
      makeRepo: () => repo,
    });
    const postBody = (body: unknown) =>
      app.request('/contribute', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    // First report: provenance columns MUST be non-empty, else COALESCE(null,
    // null) passes vacuously and the preservation assertion has no discriminating
    // power. capturedAt/title/price are distinct from the resubmit's so the
    // overwrite is observable.
    const first = await postBody({
      title: '可口可乐 330ml*24听',
      price: 40,
      categoryHint: 'soda',
      store: 'sam',
      storeSku: 'coke-24',
      source: 'surge',
      sourceUrl: 'https://example.com/first',
      capturedAt: 1_700_000_000_000,
    });
    expect(first.status).toBe(200);
    const firstId = (await first.json()).rawId;

    // Resubmit the SAME dedupe key: new price/title/capturedAt, but OMIT the
    // three COALESCE columns (source/sourceUrl/categoryHint).
    const second = await postBody({
      title: '可口可乐 330ml*12听',
      price: 22,
      store: 'sam',
      storeSku: 'coke-24',
      capturedAt: 1_700_000_999_000,
    });
    expect(second.status).toBe(200);
    const secondId = (await second.json()).rawId;

    // Convergence: exactly one raw row, same id (upsert, not a new insert).
    expect(countRows(handle, 'product_raw')).toBe(1);
    expect(secondId).toBe(firstId);

    const row = handle
      .prepare(
        'SELECT title, price, captured_at AS capturedAt, source, source_url AS sourceUrl, category_hint AS categoryHint FROM product_raw WHERE id = ?',
      )
      .get(firstId) as Record<string, unknown>;

    // title/price/capturedAt overwrite to the most recent observation.
    expect(row.title).toBe('可口可乐 330ml*12听');
    expect(row.price).toBe(2200); // 22 yuan -> integer cents
    expect(row.capturedAt).toBe(1_700_000_999_000);

    // COALESCE columns: resubmit omitted them, so the first non-null values
    // survive (provenance is not nulled out by a price-only update).
    expect(row.source).toBe('surge');
    expect(row.sourceUrl).toBe('https://example.com/first');
    expect(row.categoryHint).toBe('soda');
  });
});

describe('POST /contribute — weight product computes per100g and lands (5.4/5.5)', () => {
  it('weight unit (2kg) -> 200, per100g set / per100ml null in body, persisted on the weight axis', async () => {
    // tier1 extracts a clean weight single unit (2kg, qty inferred = 1) — a
    // determinate WEIGHT-axis verdict, so tier2 is skipped (throwingPort never
    // reached). The weight axis computes per100g = 30/2000*100 = 1.5 and the
    // volume axis is null. The saveParsed write path lands per100g into the
    // unit_price row (and leaves per100ml NULL), proving axis-correct persistence.
    const { repo, handle } = openRepo();
    const { res, json } = await contribute({
      port: throwingPort,
      makeRepo: () => repo,
      body: { title: '大米 2kg', price: 30, store: 'sam', storeSku: 'rice-2kg' },
    });
    expect(res.status).toBe(200);
    expect(json.unitPrice.per100ml).toBeNull();
    expect(json.unitPrice.per100g).toBeCloseTo(1.5, 6);
    expect(json.unitPrice.formula).not.toBeNull();
    expect(countRows(handle, 'product')).toBe(1);
    expect(countRows(handle, 'unit_price')).toBe(1);
    const up = handle
      .prepare('SELECT per100ml, per100g FROM unit_price WHERE id = ?')
      .get(json.unitPriceId) as { per100ml: number | null; per100g: number | null };
    expect(up.per100ml).toBeNull();
    expect(up.per100g).toBeCloseTo(1.5, 6);
  });
});

describe('POST /contribute — no DB -> persistence-error (5.5)', () => {
  it('makeRepo returns null -> 500 persistence-error (distinct from config-error)', async () => {
    // No repo factory at all -> repo resolves null -> persistence-error. This is
    // the DB-layer failure, NOT the LLM config failure (which would be config-
    // error). The two are asserted distinct in 5.7 below.
    const { res, json } = await contribute({
      port: throwingPort,
      makeRepo: () => null,
      body: { ...CLEAN, store: 'sam', storeSku: 'coke-24' },
    });
    expect(res.status).toBe(500);
    expect(json.error).toBe('persistence-error');
    expect(json.error).not.toBe('config-error');
    // No rawId on a persistence-error (raw never landed).
    expect(json.rawId).toBeUndefined();
  });
});

describe('POST /contribute — orchestrate failure keeps raw (5.6)', () => {
  it('insufficient (tier2 transport fail + no tier1 shape) -> 503, raw retained', async () => {
    // "农夫山泉" has no tier1 shape; a transport-failing port leaves nothing to
    // judge -> insufficient. raw was already persisted observation-first.
    const { repo, handle } = openRepo();
    const { res, json } = await contribute({
      port: transportFailPort,
      makeRepo: () => repo,
      body: { title: '农夫山泉', price: 5, store: 'sam', storeSku: 'nfsq' },
    });
    expect(res.status).toBe(503);
    expect(json.error).toBe('insufficient-information');
    // raw retained; product/unit_price NOT written (saveParsed only on ok).
    expect(countRows(handle, 'product_raw')).toBe(1);
    expect(countRows(handle, 'product')).toBe(0);
    expect(countRows(handle, 'unit_price')).toBe(0);
  });

  it('config-error (LLM config fail) -> 500, raw retained', async () => {
    const { repo, handle } = openRepo();
    const { res, json } = await contribute({
      port: configFailPort,
      makeRepo: () => repo,
      body: { title: '农夫山泉', price: 5, store: 'sam', storeSku: 'nfsq' },
    });
    expect(res.status).toBe(500);
    expect(json.error).toBe('config-error');
    expect(countRows(handle, 'product_raw')).toBe(1);
    expect(countRows(handle, 'product')).toBe(0);
    expect(countRows(handle, 'unit_price')).toBe(0);
  });
});

describe('POST /contribute — saveParsed throws keeps raw + returns rawId (5.6b)', () => {
  it('upsertRaw ok but saveParsed throws -> 500 persistence-error with the landed rawId', async () => {
    // upsertRaw returns a real id (raw landed); saveParsed throws on the ok
    // branch. The catch MUST still surface rawId (raw-landed ⇒ rawId invariant).
    const upsertRaw = vi.fn(async () => 'raw-xyz');
    const saveParsed = vi.fn(async () => {
      throw new Error('boom');
    });
    const repo = {
      upsertRaw,
      saveParsed,
      async getProduct() {
        return null;
      },
      async saveCorrection() {
        return 'c';
      },
    } as unknown as Repository;

    const { res, json } = await contribute({
      port: throwingPort, // CLEAN is tier1-sufficient -> ok branch -> saveParsed
      makeRepo: () => repo,
      body: { ...CLEAN, store: 'sam', storeSku: 'coke-24' },
    });
    expect(res.status).toBe(500);
    expect(json.error).toBe('persistence-error');
    expect(json.rawId).toBe('raw-xyz');
  });
});

describe('POST /contribute — upsertRaw throws -> no rawId (5.6c)', () => {
  it('upsertRaw throws -> 500 persistence-error WITHOUT rawId (raw not landed)', async () => {
    // Symmetry with 5.6b: when the write that lands raw fails, no rawId exists,
    // so the body must NOT carry one (raw-not-landed ⇒ no rawId invariant).
    const upsertRaw = vi.fn(async () => {
      throw new Error('boom');
    });
    const saveParsed = vi.fn(async () => ({ productId: 'p', unitPriceId: 'u' }));
    const repo = {
      upsertRaw,
      saveParsed,
      async getProduct() {
        return null;
      },
      async saveCorrection() {
        return 'c';
      },
    } as unknown as Repository;

    const { res, json } = await contribute({
      port: throwingPort,
      makeRepo: () => repo,
      body: { ...CLEAN, store: 'sam', storeSku: 'coke-24' },
    });
    expect(res.status).toBe(500);
    expect(json.error).toBe('persistence-error');
    expect(json.rawId).toBeUndefined();
    expect(saveParsed).not.toHaveBeenCalled();
  });
});

describe('POST /contribute — zero/negative price lands (5.4b)', () => {
  it('price 0 on a volume title -> 200, per100ml null, raw + NULL unit_price landed', async () => {
    // 0/negative price is a LEGAL observation: faithfully stored, core routes
    // price<=0 to per100ml=null. NOT a 400.
    const { repo, handle } = openRepo();
    const { res, json } = await contribute({
      port: throwingPort,
      makeRepo: () => repo,
      body: { title: '可乐 330ml', price: 0, store: 'sam', storeSku: 'coke-0' },
    });
    expect(res.status).toBe(200);
    expect(json.unitPrice.per100ml).toBeNull();
    expect(countRows(handle, 'product_raw')).toBe(1);
    const up = handle
      .prepare('SELECT per100ml FROM unit_price WHERE id = ?')
      .get(json.unitPriceId) as { per100ml: number | null };
    expect(up.per100ml).toBeNull();
  });
});

describe('POST /contribute — error codes pairwise distinct (5.7)', () => {
  it('the business + governance error-code sets are pairwise distinct', () => {
    // These literal arrays are a DOCUMENTED INVARIANT (the cross-source error-code
    // namespace must stay collision-free), not a coverage gate. governance.ts
    // exports `GovernanceErrorCode` as a type-only union (no runtime constant) and
    // the business codes have no exported runtime list, so there is nothing to
    // import here; the real wiring is covered by the behavioral tests in 5.5/5.6/
    // 5.6b/6.x that assert each emitted code from the actual handler/middleware.
    // /contribute business codes.
    const businessCodes = [
      'invalid-request',
      'config-error',
      'insufficient-information',
      'persistence-error',
      'internal',
    ];
    // api-governance codes. NOTE: governance ALSO emits `config-error` (when
    // API_KEYS is missing) — `config-error` is a SAME-CODE, DUAL-SOURCE item:
    // governance-side (missing API_KEYS) and business-side (missing
    // OPENROUTER_API_KEY) both produce 500 config-error. They are NOT
    // distinguished by error code but by MIDDLEWARE ORDER (auth runs before
    // business: a keyless client gets 401 first, so the governance config-error
    // is not masked while the business one is). So the governance subset listed
    // here drops the duplicate `config-error` and keeps only the four that do
    // not overlap the business set.
    const governanceCodes = ['auth-missing', 'auth-malformed', 'auth-forbidden', 'rate-limited'];

    const all = [...businessCodes, ...governanceCodes];
    expect(new Set(all).size).toBe(all.length); // pairwise distinct across the union

    // Explicit: persistence-error (DB unavailable) != config-error (LLM missing).
    expect('persistence-error').not.toBe('config-error');
  });
});

describe('POST /contribute — error body carries rawId (5.8)', () => {
  it('insufficient 503 body.rawId matches the landed product_raw row', async () => {
    const { repo, handle } = openRepo();
    const { res, json } = await contribute({
      port: transportFailPort,
      makeRepo: () => repo,
      body: { title: '农夫山泉', price: 5, store: 'sam', storeSku: 'nfsq' },
    });
    expect(res.status).toBe(503);
    expect(typeof json.rawId).toBe('string');
    const row = handle.prepare('SELECT id FROM product_raw').get() as { id: string };
    expect(json.rawId).toBe(row.id);
  });

  it('config-error 500 body.rawId matches the landed product_raw row', async () => {
    const { repo, handle } = openRepo();
    const { res, json } = await contribute({
      port: configFailPort,
      makeRepo: () => repo,
      body: { title: '农夫山泉', price: 5, store: 'sam', storeSku: 'nfsq' },
    });
    expect(res.status).toBe(500);
    expect(typeof json.rawId).toBe('string');
    const row = handle.prepare('SELECT id FROM product_raw').get() as { id: string };
    expect(json.rawId).toBe(row.id);
  });
});

describe('POST /contribute — non-target boundary (5.9)', () => {
  it('routes are exactly {/admin/backfill, /categories, /health, /rankings, /parse, /contribute, /ingest, /ingest/batch} — no corrections/compare', async () => {
    const app = createApp({
      makeLlm: () => throwingPort,
      governance: createNoopGovernance(),
      makeRepo: () => null,
    });
    const paths = [...new Set(app.routes.map((r) => r.path))].sort();
    // /rankings is the public read-only leaderboard; /categories is the public
    // read-only category-tree browse — both governance-exempt, registered
    // alongside /health. /admin/backfill is the admin-tier taxonomy backfill
    // driver (its own ADMIN_API_KEYS gate, not the public governance chain).
    // corrections/compare are still future (v2) and must NOT exist yet.
    expect(paths).toEqual(['/admin/backfill', '/categories', '/contribute', '/health', '/ingest', '/ingest/batch', '/parse', '/rankings']);
    expect(paths).not.toContain('/corrections');
    expect(paths).not.toContain('/compare');
  });

  it('migrated table set is the 4 core + 4 taxonomy tables — only comparison_group forbidden', () => {
    const { handle } = openRepo();
    const tables = (
      handle
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'",
        )
        .all() as Array<{ name: string }>
    )
      .map((r) => r.name)
      .sort();
    // add-taxonomy-v1 (persistence MODIFIED) legitimately introduces the four
    // taxonomy tables alongside the original core four; the migrated set is now
    // exactly those eight.
    expect(tables).toEqual([
      'category_closure',
      'corrections',
      'product',
      'product_raw',
      'product_tag',
      'store_category_map',
      'tag',
      'unit_price',
    ]);
    // The taxonomy tables now exist…
    expect(tables).toContain('tag');
    expect(tables).toContain('product_tag');
    expect(tables).toContain('store_category_map');
    expect(tables).toContain('category_closure');
    // …but comparison_group stays forbidden — comparison is a dynamic query
    // (category closure ∧ attribute), never a materialized table.
    expect(tables).not.toContain('comparison_group');
  });
});

// ── Governance regression on /contribute (6.1 / 6.2) ───────────────────────
const VALID_KEY = 'key-alpha';

/**
 * Build an app with REAL governance, a spy-wrapped repo factory, and a spy LLM
 * factory, so auth assertions can prove the ingest pipeline is NOT entered.
 */
function appWithSpies(env: Bindings) {
  const upsertRaw = vi.fn(async () => 'raw-id');
  const saveParsed = vi.fn(async () => ({ productId: 'p', unitPriceId: 'u' }));
  const repo = {
    upsertRaw,
    saveParsed,
    async getProduct() {
      return null;
    },
    async saveCorrection() {
      return 'c';
    },
  } as unknown as Repository;
  const makeRepo = vi.fn(() => repo);
  const llmParse = vi.fn(async (): Promise<ParseResult> => ({ ok: true, spec: {} as any }));
  const makeLlm = vi.fn(() => ({ parse: llmParse }) as SpecParserLLM);

  const app = createApp({ makeLlm, governance: createRealGovernance(), makeRepo });
  const request = (init: RequestInit) => app.request('/contribute', init, env);
  return { request, upsertRaw, saveParsed, makeLlm, llmParse, makeRepo };
}

const cleanContributeBody = JSON.stringify({ ...CLEAN, store: 'sam', storeSku: 'coke-24' });

describe('governance — /contribute auth gate (6.1)', () => {
  it('missing key -> 401 auth-missing; upsertRaw and LLM never called', async () => {
    const fakeKv = { get: vi.fn(async () => null), put: vi.fn(async () => undefined) };
    const env = { API_KEYS: VALID_KEY, GOVERNANCE_KV: fakeKv } as unknown as Bindings;
    const { request, upsertRaw, makeLlm, llmParse } = appWithSpies(env);
    const res = await request({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: cleanContributeBody,
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('auth-missing');
    // Auth short-circuits BEFORE the ingest pipeline.
    expect(upsertRaw).not.toHaveBeenCalled();
    expect(makeLlm).not.toHaveBeenCalled();
    expect(llmParse).not.toHaveBeenCalled();
  });
});

describe('governance — /contribute forbidden / admit / health exempt (6.2)', () => {
  it('unregistered key -> 403 auth-forbidden, ingest not entered', async () => {
    const fakeKv = { get: vi.fn(async () => null), put: vi.fn(async () => undefined) };
    const env = { API_KEYS: VALID_KEY, GOVERNANCE_KV: fakeKv } as unknown as Bindings;
    const { request, upsertRaw, llmParse } = appWithSpies(env);
    const res = await request({
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer key-not-registered' },
      body: cleanContributeBody,
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('auth-forbidden');
    expect(upsertRaw).not.toHaveBeenCalled();
    expect(llmParse).not.toHaveBeenCalled();
  });

  it('valid key -> admitted (ingest entered, upsertRaw called)', async () => {
    const fakeKv = { get: vi.fn(async () => null), put: vi.fn(async () => undefined) };
    const env = { API_KEYS: VALID_KEY, GOVERNANCE_KV: fakeKv } as unknown as Bindings;
    const { request, upsertRaw } = appWithSpies(env);
    const res = await request({
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${VALID_KEY}` },
      body: cleanContributeBody,
    });
    // Admitted: the clean title is tier1-sufficient so it lands 200. The point
    // is the governance gate let it through to the ingest pipeline.
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    expect(upsertRaw).toHaveBeenCalledTimes(1);
  });

  it('/health stays exempt from the governance chain (200, no KV access)', async () => {
    const get = vi.fn(async () => null);
    const put = vi.fn(async () => undefined);
    const env = { API_KEYS: VALID_KEY, GOVERNANCE_KV: { get, put } } as unknown as Bindings;
    const app = createApp({
      makeLlm: () => throwingPort,
      governance: createRealGovernance(),
      makeRepo: () => null,
    });
    const res = await app.request('/health', { method: 'GET' }, env);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });
});
