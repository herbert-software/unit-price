import { describe, expect, it, vi } from 'vitest';
import type { RawProduct } from '@unit-price/core';
import type { CategoryTreeNode, ListRankingsInput, RankingRow, Repository } from '@unit-price/db';
import { createApp } from './routes.js';
import { buildApp } from './index.js';
import { createNoopGovernance, createRealGovernance } from './governance.js';
import type { Bindings } from './bindings.js';
import type { ParseOptions, ParseResult, SpecParserLLM } from './llm.js';

// A port that must never be called (clean titles must skip tier2). Calling it
// throws so any accidental invocation fails the test loudly.
const throwingPort: SpecParserLLM = {
  async parse(): Promise<ParseResult> {
    throw new Error('LLM must not be called for tier1-sufficient inputs');
  },
};

/** A port that always reports a transport failure. */
const transportFailPort: SpecParserLLM = {
  async parse(): Promise<ParseResult> {
    return { ok: false, kind: 'transport', message: 'simulated timeout' };
  },
};

/** A port that reports a (runtime) config error. */
const configFailPort: SpecParserLLM = {
  async parse(): Promise<ParseResult> {
    return { ok: false, kind: 'config', message: 'missing OPENROUTER_API_KEY' };
  },
};

/** A port that fills a given partial spec (used to test gap-filling). */
function fillingPort(fill: Partial<RawProduct> & Record<string, unknown>): SpecParserLLM {
  return {
    async parse(_input: RawProduct, _opts?: ParseOptions): Promise<ParseResult> {
      return {
        ok: true,
        spec: {
          unitSize: null,
          quantity: null,
          multipliers: [1],
          totalAmount: null,
          packageUnit: null,
          category: 'beverage',
          confidence: 0.7,
          ...(fill as object),
        },
      };
    },
  };
}

async function post(port: SpecParserLLM, body: unknown) {
  // makeLlm ignores env here: each test injects a fixed port. Env-keyed
  // construction is covered by the dedicated "env injection" suite below.
  const app = createApp({ makeLlm: () => port, governance: createNoopGovernance() });
  const res = await app.request('/parse', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { res, json };
}

describe('POST /parse — clean title (tier1, no LLM)', () => {
  it('returns 200, per100ml ~= 0.505, expanded formula, confidence >= 0.9', async () => {
    const { res, json } = await post(throwingPort, { title: '可口可乐 330ml*24听', price: 40 });
    expect(res.status).toBe(200);
    expect(json.unitPrice.per100ml).toBeCloseTo(0.505, 3);
    expect(json.unitPrice.formula).toBe('40 / (330 * 24 * 1) * 100');
    expect(json.confidence).toBeGreaterThanOrEqual(0.9);
    expect(json.spec.totalAmount).toEqual({ value: 7920, unit: 'ml' });
    expect(json.spec.category).toBe('beverage');
  });

  it('does not fail without a key because the LLM is never called', async () => {
    // throwingPort stands in for an unavailable LLM; a 200 proves tier2 was skipped.
    const { res } = await post(throwingPort, { title: '可口可乐 330ml*24听', price: 40 });
    expect(res.status).toBe(200);
  });
});

describe('POST /parse — orphan single-unit volume (tier1 infers qty=1)', () => {
  it('4L single bottle: 200, per100ml ~= 0.2475, confidence >= 0.9, surfaces inference warning', async () => {
    // "4L" is a bare volume with no quantity signal. tier1 infers quantity=1
    // and emits an informational warning; the case is clean/determinate so
    // tier2 (throwingPort) is never reached (no OPENROUTER_API_KEY needed).
    const { res, json } = await post(throwingPort, { title: 'MM 弱碱性饮用水 4L', price: 9.9 });
    expect(res.status).toBe(200);
    expect(json.unitPrice.per100ml).not.toBeNull();
    expect(json.unitPrice.per100ml).toBeCloseTo(0.2475, 4);
    expect(json.confidence).toBeGreaterThanOrEqual(0.9);
    // tier1's single-unit inference warning must reach the API response.
    expect(json.warnings).toContain('数量按单件推断为 1');
  });
});

describe('POST /parse — invalid request -> 4xx', () => {
  it('missing price -> 400', async () => {
    const { res, json } = await post(throwingPort, { title: '可口可乐 330ml*24听' });
    expect(res.status).toBe(400);
    expect(json.error).toBe('invalid-request');
  });

  it('non-numeric price -> 400', async () => {
    const { res } = await post(throwingPort, { title: '可口可乐 330ml*24听', price: 'abc' });
    expect(res.status).toBe(400);
  });

  it('empty title -> 400', async () => {
    const { res } = await post(throwingPort, { title: '', price: 40 });
    expect(res.status).toBe(400);
  });

  it('missing title -> 400', async () => {
    const { res } = await post(throwingPort, { price: 40 });
    expect(res.status).toBe(400);
  });

  it('non-JSON body -> 400', async () => {
    const { res } = await post(throwingPort, 'not json');
    expect(res.status).toBe(400);
  });

  it('Infinity price -> 400 (non-finite rejected like NaN)', async () => {
    // JSON literal 1e999 parses to Infinity; a non-finite price is an invalid
    // request, not a 200+null result.
    const { res, json } = await post(throwingPort, '{"title":"可口可乐 330ml*24听","price":1e999}');
    expect(res.status).toBe(400);
    expect(json.error).toBe('invalid-request');
  });
});

describe('POST /parse — price <= 0 -> 200 + null + warning', () => {
  it('price 0 on a clean title returns 200, per100ml null, warning', async () => {
    const { res, json } = await post(throwingPort, { title: '可口可乐 330ml*24听', price: 0 });
    expect(res.status).toBe(200);
    expect(json.unitPrice.per100ml).toBeNull();
    expect(json.unitPrice.formula).toBeNull();
    expect(json.warnings.length).toBeGreaterThan(0);
    expect(json.confidence).toBeLessThanOrEqual(0.5);
  });

  it('price 0 with a fully-extracted tier1 spec skips tier2 even without a key', async () => {
    // tier1 extracts a full spec (330ml*24 -> 7920ml) but price<=0 is a CERTAIN
    // null the LLM cannot change. A config/transport-failing port must NOT be
    // reached: HTTP 200, per100ml null, the price warning present, and NO
    // "未经 LLM 复核" warning (tier2 was never called).
    const { res, json } = await post(configFailPort, { title: '可口可乐 330ml*24听', price: 0 });
    expect(res.status).toBe(200);
    expect(json.unitPrice.per100ml).toBeNull();
    expect(json.spec.totalAmount).toEqual({ value: 7920, unit: 'ml' });
    expect(json.warnings.length).toBeGreaterThan(0);
    expect(json.warnings.some((w: string) => /价格/.test(w))).toBe(true);
    expect(json.warnings).not.toContain('未经 LLM 复核');
  });

  it('quantity 0 (derived totalMl<=0) is determinate null and skips tier2', async () => {
    // Title "可乐 330ml*0" -> tier1 unitSize 330ml + quantity 0 -> derived
    // totalMl = 0 (<=0). The LLM cannot change tier1's extracted quantity, so
    // this is a CERTAIN null -> 200; a transport-failing port must NOT be
    // reached (no "未经 LLM 复核" warning).
    const { res, json } = await post(transportFailPort, { title: '可乐 330ml*0', price: 40 });
    expect(res.status).toBe(200);
    expect(json.unitPrice.per100ml).toBeNull();
    expect(json.warnings).not.toContain('未经 LLM 复核');
  });

  it('weight unitSize (2kg) computes per100g on the weight axis and skips tier2', async () => {
    // tier1 extracts a clean weight single unit (2kg, qty inferred = 1). This is
    // a DETERMINATE weight-axis verdict — per100g = 40/2000*100 = 2.0, per100ml
    // null — so tier2 (a failing port) must not be reached, and no "未经 LLM 复核"
    // warning is attached. The single-unit inference warning is surfaced.
    const { res, json } = await post(transportFailPort, { title: '鸡胸肉 2kg', price: 40 });
    expect(res.status).toBe(200);
    expect(json.unitPrice.per100ml).toBeNull();
    expect(json.unitPrice.per100g).toBeCloseTo(2.0, 6);
    expect(json.unitPrice.formula).not.toBeNull();
    expect(json.warnings.length).toBeGreaterThan(0);
    expect(json.warnings).not.toContain('未经 LLM 复核');
  });
});

describe('POST /parse — tier2 transport failure', () => {
  it('no spec shape at all -> 5xx insufficient (price>0)', async () => {
    const { res, json } = await post(transportFailPort, { title: '农夫山泉', price: 5 });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(json.error).toBe('insufficient-information');
    expect(json.confidence).toBeUndefined();
  });

  it('bare single-unit volume (6000ml, no qty) -> qty=1 inferred, determinate, skips tier2', async () => {
    // tier1 puts "6000ml" into unitSize with NO quantity signal, so the
    // single-unit inference sets quantity=1 -> compute-required set met ->
    // a determinate (computable) verdict, hence 200. tier2 is skipped (a
    // transport-failing port must NOT be reached -> no "未经 LLM 复核"
    // warning), and the inference warning is surfaced. per100ml = 36/6000*100.
    const { res, json } = await post(transportFailPort, { title: '某饮料 6000ml', price: 36 });
    expect(res.status).toBe(200);
    expect(json.unitPrice.per100ml).toBeCloseTo(0.6, 3);
    expect(json.spec.quantity).toBe(1);
    expect(json.warnings).toContain('数量按单件推断为 1');
    expect(json.warnings).not.toContain('未经 LLM 复核');
  });

  it('weight unitSize (2kg) is a determinate weight-axis verdict -> 200 + per100g, not 5xx', async () => {
    // tier1 has a weight shape, so even with tier2 transport-failing the verdict
    // is determinate (per100g = 30/2000*100 = 1.5) -> 200, never 5xx.
    const { res, json } = await post(transportFailPort, { title: '大米 2kg', price: 30 });
    expect(res.status).toBe(200);
    expect(json.unitPrice.per100ml).toBeNull();
    expect(json.unitPrice.per100g).toBeCloseTo(1.5, 6);
  });

  it('weight unitSize (2kg, price 45) -> 200, per100g = 2.25, per100ml null (spec scenario)', async () => {
    // parse-api spec scenario: tier1 extracts unitSize=2kg (single unit, qty=1,
    // totalAmount=2kg). Weight axis computes per100g = 45/2000*100 = 2.25; the
    // volume axis is null. Determinate at tier1 -> tier2 skipped.
    const { res, json } = await post(transportFailPort, { title: '水蜜黄桃 2kg', price: 45 });
    expect(res.status).toBe(200);
    expect(json.unitPrice.per100g).toBeCloseTo(2.25, 6);
    expect(json.unitPrice.per100ml).toBeNull();
    expect(json.unitPrice.formula).not.toBeNull();
    expect(json.warnings).not.toContain('未经 LLM 复核');
  });

  it('egg 1.59kg(30枚): free piece-count suppresses inference -> 200, both axes null, not 5xx', async () => {
    // parse-api spec scenario: tier1 extracts unitSize=1.59kg but the free piece
    // count "30" (枚 ∉ package-unit set) suppresses the single-unit inference, so
    // quantity stays null and no total is derivable -> a CERTAIN null on BOTH
    // axes. tier1 has a weight shape -> determinate -> 200 (not 5xx), even with
    // tier2 transport-failing.
    const { res, json } = await post(transportFailPort, {
      title: 'MM 精选鲜鸡蛋 1.59kg(30枚)',
      price: 30,
    });
    expect(res.status).toBe(200);
    expect(json.unitPrice.per100ml).toBeNull();
    expect(json.unitPrice.per100g).toBeNull();
    expect(json.unitPrice.formula).toBeNull();
    expect(json.warnings.length).toBeGreaterThan(0);
  });
});

describe('POST /parse — runtime config error -> distinguishable 5xx', () => {
  it('returns 500 with config-error code (distinct from insufficient)', async () => {
    const { res, json } = await post(configFailPort, { title: '农夫山泉', price: 5 });
    expect(res.status).toBe(500);
    expect(json.error).toBe('config-error');
  });
});

describe('POST /parse — tier2 gap fill + merge semantics', () => {
  it('tier1 has unitSize, LLM fills quantity; merged -> full-spec high band', async () => {
    // Title "可乐2代 330ml" -> tier1 extracts unitSize 330ml; the stray digit
    // "2" suppresses the single-unit inference (a quantity signal is present),
    // so quantity stays null and tier2 is invoked. LLM supplies quantity=24.
    // tier1 unitSize is authoritative; LLM's unitSize is ignored.
    const port = fillingPort({
      unitSize: { value: 999, unit: 'ml' }, // must be IGNORED (tier1 authoritative)
      quantity: 24,
    });
    const { res, json } = await post(port, { title: '可乐2代 330ml', price: 40 });
    expect(res.status).toBe(200);
    // tier1 unitSize 330 wins over LLM's 999 -> per100ml uses 330*24.
    expect(json.spec.unitSize).toEqual({ value: 330, unit: 'ml' });
    expect(json.spec.quantity).toBe(24);
    expect(json.unitPrice.per100ml).toBeCloseTo(0.505, 3);
    expect(json.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('tier2 success but fields still empty -> 200 (determined uncomputable)', async () => {
    const port = fillingPort({}); // all-empty valid spec
    const { res, json } = await post(port, { title: '农夫山泉', price: 5 });
    expect(res.status).toBe(200);
    expect(json.unitPrice.per100ml).toBeNull();
  });
});

describe('POST /parse — env injected per request (no isolate cross-request bleed)', () => {
  // buildApp injects REAL governance, so these env-injection cases (which probe
  // the parse-api tier behavior, not governance) must clear the auth gate: a
  // valid API_KEYS allowlist + matching Bearer key admits the request, leaving
  // OPENROUTER_API_KEY absent so the tier1/tier2 assertions stand unchanged.
  const ADMIT_KEY = 'env-suite-key';

  /** POST a body to an app, injecting `env` as the request-scoped Bindings. */
  async function postEnv(app: ReturnType<typeof buildApp>, env: Bindings, body: unknown) {
    const res = await app.request(
      '/parse',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIT_KEY}` },
        body: JSON.stringify(body),
      },
      { API_KEYS: ADMIT_KEY, ...env },
    );
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { res, json };
  }

  it('missing key + clean title -> 200 (tier1 only, tier2 never reached)', async () => {
    // buildApp resolves LLM config from the INJECTED env; with no key a clean
    // title must still parse via tier1 (tier2 skipped) -> 200.
    const app = buildApp();
    const { res, json } = await postEnv(app, {}, { title: '可口可乐 330ml*24听', price: 40 });
    expect(res.status).toBe(200);
    expect(json.unitPrice.per100ml).toBeCloseTo(0.505, 3);
  });

  it('missing key + dirty title needing tier2 -> 500 config-error (not 503)', async () => {
    // A bare brand name has tier1 shape but needs tier2 to fill the spec. With
    // no OPENROUTER_API_KEY injected, resolving config throws ConfigError ->
    // orchestrate returns config-error -> HTTP 500 (distinct from 503).
    const app = buildApp();
    const { res, json } = await postEnv(app, {}, { title: '农夫山泉', price: 5 });
    expect(res.status).toBe(500);
    expect(json.error).toBe('config-error');
  });

  it('two requests with different env use their own env (no first-env固化)', async () => {
    // Record the env each makeLlm call receives. The first request injects a
    // key, the second injects none; if env were固化 from the first request the
    // second would wrongly see the first key. We assert each saw its own env.
    const seen: Array<Bindings> = [];
    const app = createApp({
      makeLlm: (env) => {
        seen.push(env);
        return {
          async parse(): Promise<ParseResult> {
            return { ok: false, kind: 'transport', message: 'noop' };
          },
        };
      },
      governance: createNoopGovernance(),
    });

    const dirty = { title: '农夫山泉', price: 5 };
    await app.request(
      '/parse',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(dirty) },
      { OPENROUTER_API_KEY: 'key-A' },
    );
    await app.request(
      '/parse',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(dirty) },
      {},
    );

    expect(seen).toHaveLength(2);
    expect(seen[0].OPENROUTER_API_KEY).toBe('key-A');
    expect(seen[1].OPENROUTER_API_KEY).toBeUndefined();
  });
});

describe('POST /parse — categoryHint passthrough', () => {
  it('passes categoryHint through to spec.category (never from LLM)', async () => {
    const { res, json } = await post(throwingPort, {
      title: '可口可乐 330ml*24听',
      price: 40,
      categoryHint: 'soda',
    });
    expect(res.status).toBe(200);
    expect(json.spec.category).toBe('soda');
  });
});

// ── GET /rankings — read-only leaderboard (rankings-api spec) ───────────────
//
// The route is read-only: it validates the query, calls repo.listRankings, and
// projects rows (DROP `id`, ADD `rank = offset + 1-based index`). These tests
// inject a FAKE Repository whose listRankings serves a fixed, already-sorted
// snapshot (the repo owns the WHERE per100ml IS NOT NULL filter + ORDER BY
// per100ml,id slicing — covered in @unit-price/db's own tests). Here we assert
// the HTTP contract: status codes, query validation, the rank projection, and
// verbatim passthrough of stored per100ml/formula/confidence/warnings.

/** A RankingRow fixture (only per100ml-non-null rows ever reach the route). */
function row(over: Partial<RankingRow> & Pick<RankingRow, 'id' | 'per100ml'>): RankingRow {
  return {
    formula: `cents / (${over.per100ml} * 100) * 100`,
    confidence: 0.95,
    warnings: [],
    title: `item-${over.id}`,
    priceCents: 1000,
    store: 'sam',
    storeSku: `sku-${over.id}`,
    sourceUrl: null,
    ...over,
  };
}

/**
 * A fixed, ascending-by-(per100ml, id) snapshot. listRankings slices it by
 * limit/offset EXACTLY as the SQL LIMIT/OFFSET would, so route-level pagination
 * (rank continuity, no overlap/gap across pages) is exercised against a stable
 * dataset. The two id='ml-2a'/'ml-2b' rows share per100ml=2.0 to exercise the
 * same-value tiebreak ordering (already applied by the snapshot order here).
 */
const SNAPSHOT: RankingRow[] = [
  row({ id: 'ml-1', per100ml: 0.505, formula: '40 / (330 * 24 * 1) * 100', warnings: [] }),
  row({ id: 'ml-2a', per100ml: 2.0 }),
  row({ id: 'ml-2b', per100ml: 2.0 }),
  row({ id: 'ml-3', per100ml: 5.5, warnings: ['数量按单件推断为 1'], priceCents: 990 }),
  row({ id: 'ml-4', per100ml: 889.9, warnings: ['数量按单件推断为 1'] }),
];

/**
 * Build an app whose Repository serves `data` from listRankings, slicing by the
 * passed limit/offset (mirroring SQL). `onCall` captures each ListRankingsInput
 * so tests can assert the route forwarded clamped limit / parsed offset/category.
 */
function rankingsApp(
  data: RankingRow[],
  opts: { onCall?: (input: ListRankingsInput) => void; throws?: boolean } = {},
) {
  const listRankings = vi.fn(async (input: ListRankingsInput): Promise<RankingRow[]> => {
    opts.onCall?.(input);
    if (opts.throws) throw new Error('simulated read failure');
    return data.slice(input.offset, input.offset + input.limit);
  });
  const repo = {
    async upsertRaw() {
      throw new Error('rankings is read-only: upsertRaw must not be called');
    },
    async saveParsed() {
      throw new Error('rankings is read-only: saveParsed must not be called');
    },
    async getProduct() {
      return null;
    },
    async saveCorrection() {
      throw new Error('rankings is read-only: saveCorrection must not be called');
    },
    listRankings,
  } as unknown as Repository;

  const app = createApp({
    makeLlm: () => throwingPort,
    governance: createNoopGovernance(),
    makeRepo: () => repo,
  });
  return { app, listRankings };
}

/** GET /rankings on an app, returning {res, json}. */
async function getRankings(app: ReturnType<typeof createApp>, query = '') {
  const res = await app.request(`/rankings${query}`, { method: 'GET' });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { res, json };
}

describe('GET /rankings — ascending leaderboard, verbatim stored values', () => {
  it('returns 200, ascending per100ml, rank from 1, fields verbatim (no recompute)', async () => {
    const { app } = rankingsApp(SNAPSHOT);
    const { res, json } = await getRankings(app);
    expect(res.status).toBe(200);
    expect(Array.isArray(json)).toBe(true);
    expect(json).toHaveLength(SNAPSHOT.length);
    // rank is 1-based and contiguous; per100ml is non-decreasing.
    expect(json.map((r: any) => r.rank)).toEqual([1, 2, 3, 4, 5]);
    for (let i = 1; i < json.length; i++) {
      expect(json[i].per100ml).toBeGreaterThanOrEqual(json[i - 1].per100ml);
    }
    // First item = lowest per100ml, with stored formula/per100ml verbatim.
    expect(json[0].rank).toBe(1);
    expect(json[0].per100ml).toBe(0.505);
    expect(json[0].formula).toBe('40 / (330 * 24 * 1) * 100');
    // Item shape: contract fields present, `id` NOT exposed.
    expect(json[0]).toHaveProperty('title');
    expect(json[0]).toHaveProperty('priceCents');
    expect(json[0]).toHaveProperty('confidence');
    expect(json[0]).toHaveProperty('store');
    expect(json[0]).toHaveProperty('storeSku');
    expect(json[0]).toHaveProperty('sourceUrl');
    expect(json[0]).not.toHaveProperty('id');
    // confidence is the stored unit_price band, passed through verbatim.
    expect(json[0].confidence).toBe(0.95);
  });

  it('per100ml=null rows never appear (repo returns only non-null; response mirrors them)', async () => {
    // The route never sees null rows (the repo's WHERE filters them); the
    // response must contain only finite per100ml values, never null.
    const { app } = rankingsApp(SNAPSHOT);
    const { json } = await getRankings(app);
    for (const item of json) {
      expect(item.per100ml).not.toBeNull();
      expect(typeof item.per100ml).toBe('number');
    }
  });
});

describe('GET /rankings — single-unit-inference warning is carried, not dropped', () => {
  it('a row with 数量按单件推断为 1 stays in the board with its warning verbatim', async () => {
    const { app } = rankingsApp(SNAPSHOT);
    const { json } = await getRankings(app);
    const inferred = json.find((r: any) => r.storeSku === 'sku-ml-3');
    expect(inferred).toBeDefined();
    expect(inferred.warnings).toContain('数量按单件推断为 1');
    // The high-per100ml single-unit-inference row (889.9) is also present, not
    // silently filtered for being a suspicious high price.
    const high = json.find((r: any) => r.storeSku === 'sku-ml-4');
    expect(high).toBeDefined();
    expect(high.warnings).toContain('数量按单件推断为 1');
  });
});

describe('GET /rankings — formula/per100ml taken from storage', () => {
  it('per100ml=0.505 and formula equal the stored values exactly', async () => {
    const stored = row({
      id: 'only',
      per100ml: 0.505,
      formula: '40 / (330 * 24 * 1) * 100',
    });
    const { app } = rankingsApp([stored]);
    const { res, json } = await getRankings(app);
    expect(res.status).toBe(200);
    expect(json).toHaveLength(1);
    expect(json[0].per100ml).toBe(0.505);
    expect(json[0].formula).toBe('40 / (330 * 24 * 1) * 100');
  });
});

describe('GET /rankings — limit clamp', () => {
  it('?limit=1000 clamps the forwarded LIMIT to 200 (200, never more than 200)', async () => {
    let seen: ListRankingsInput | null = null;
    const { app } = rankingsApp(SNAPSHOT, { onCall: (i) => (seen = i) });
    const { res } = await getRankings(app, '?limit=1000');
    expect(res.status).toBe(200);
    expect(seen!.limit).toBe(200); // clamped, not 1000
  });

  it('default limit is 50 when omitted', async () => {
    let seen: ListRankingsInput | null = null;
    const { app } = rankingsApp(SNAPSHOT, { onCall: (i) => (seen = i) });
    await getRankings(app);
    expect(seen!.limit).toBe(50);
    expect(seen!.offset).toBe(0);
    expect(seen!.category).toBe('beverage');
  });
});

describe('GET /rankings — invalid limit/offset -> 400 invalid-request', () => {
  it.each([
    ['negative limit', '?limit=-5'],
    ['zero limit', '?limit=0'],
    ['non-integer limit', '?limit=1.5'],
    ['non-numeric limit', '?limit=abc'],
    ['Infinity limit', '?limit=Infinity'],
    ['empty limit', '?limit='],
    ['hex limit', '?limit=0x10'],
    ['whitespace limit', '?limit=%20%205'],
    ['negative offset', '?offset=-1'],
    ['non-numeric offset', '?offset=abc'],
    ['non-integer offset', '?offset=2.5'],
    ['decimal offset', '?offset=1.5'],
    ['empty offset', '?offset='],
  ])('%s -> 400 invalid-request (never 200, never silent default)', async (_name, query) => {
    const { app, listRankings } = rankingsApp(SNAPSHOT);
    const { res, json } = await getRankings(app, query);
    expect(res.status).toBe(400);
    expect(json.error).toBe('invalid-request');
    // 400 fires before the repo is queried.
    expect(listRankings).not.toHaveBeenCalled();
  });
});

describe('GET /rankings — out-of-range offset -> 200 + []', () => {
  it('?offset=0 (boundary) returns 200 (offset 0 is valid, not rejected)', async () => {
    const { app } = rankingsApp(SNAPSHOT);
    const { res } = await getRankings(app, '?offset=0');
    expect(res.status).toBe(200);
  });

  it('?offset=100000 returns 200 and an empty array (not 404)', async () => {
    const { app } = rankingsApp(SNAPSHOT);
    const { res, json } = await getRankings(app, '?offset=100000');
    expect(res.status).toBe(200);
    expect(json).toEqual([]);
  });
});

describe('GET /rankings — unknown/non-category/wrong-case/empty category -> 400', () => {
  it.each([
    ['unknown slug', '?category=nope'],
    ['attribute (non-category) slug', '?category=sugar-free'],
    ['wrong case', '?category=Beverage'],
    ['empty string', '?category='],
  ])('%s -> 400 invalid-request (only an exact seed kind=category slug admitted)', async (_name, query) => {
    const { app, listRankings } = rankingsApp(SNAPSHOT);
    const { res, json } = await getRankings(app, query);
    expect(res.status).toBe(400);
    expect(json.error).toBe('invalid-request');
    // 400 fires before the repo is queried.
    expect(listRankings).not.toHaveBeenCalled();
  });

  it.each([
    ['root', 'beverage'],
    ['soft-drink parent', 'soft-drink'],
    ['carbonated leaf', 'carbonated'],
    ['alcohol (legal but rankable=false subtree)', 'alcohol'],
  ])('?category=%s (exact seed slug) is admitted -> 200', async (_name, slug) => {
    let seen: ListRankingsInput | null = null;
    const { app } = rankingsApp(SNAPSHOT, { onCall: (i) => (seen = i) });
    const { res } = await getRankings(app, `?category=${slug}`);
    expect(res.status).toBe(200);
    // The validated slug is forwarded to listRankings verbatim.
    expect(seen!.category).toBe(slug);
  });
});

describe('GET /rankings — node scope: default = beverage = root closure', () => {
  it('no params ≡ ?category=beverage: same forwarded ListRankingsInput', async () => {
    let noParam: ListRankingsInput | null = null;
    const a = rankingsApp(SNAPSHOT, { onCall: (i) => (noParam = i) });
    await getRankings(a.app);
    let explicit: ListRankingsInput | null = null;
    const b = rankingsApp(SNAPSHOT, { onCall: (i) => (explicit = i) });
    await getRankings(b.app, '?category=beverage');
    expect(noParam!).toEqual(explicit!);
    expect(noParam!.category).toBe('beverage');
  });
});

// The repo owns the closure + rankable=1 + per100ml gate (covered in @unit-price/
// db's own tests). Here we assert the ROUTE forwards the validated node slug and
// faithfully projects whatever the repo returns. A "node-aware" fake keys its
// snapshot by slug so we can exercise route-level closure semantics: a leaf
// returns only its members, a parent returns the union of its leaves, an
// alcohol/empty node returns []. rankable=false rows simply never appear in any
// snapshot (the repo's gate excludes them before the route ever sees a row).
function nodeRankingsApp(byNode: Record<string, RankingRow[]>) {
  const listRankings = vi.fn(async (input: ListRankingsInput): Promise<RankingRow[]> => {
    const data = byNode[input.category] ?? [];
    return data.slice(input.offset, input.offset + input.limit);
  });
  const repo = {
    async upsertRaw() {
      throw new Error('rankings is read-only: upsertRaw must not be called');
    },
    async saveParsed() {
      throw new Error('rankings is read-only: saveParsed must not be called');
    },
    async getProduct() {
      return null;
    },
    async saveCorrection() {
      throw new Error('rankings is read-only: saveCorrection must not be called');
    },
    listRankings,
  } as unknown as Repository;
  const app = createApp({
    makeLlm: () => throwingPort,
    governance: createNoopGovernance(),
    makeRepo: () => repo,
  });
  return { app, listRankings };
}

describe('GET /rankings — closure node scoping (route forwards slug, projects rows)', () => {
  // A small dirty-ish snapshot keyed by node. The root snapshot is the union of
  // the two soft-drink leaves (carbonated + drinking-water) — i.e. the parent
  // closure includes the child leaves. alcohol returns [] (rankable=false subtree).
  const carbonated = [
    row({ id: 'c-1', per100ml: 0.5, storeSku: 'sku-carb-1' }),
    row({ id: 'c-2', per100ml: 3.2, storeSku: 'sku-carb-2' }),
  ];
  const water = [row({ id: 'w-1', per100ml: 1.1, storeSku: 'sku-water-1' })];
  // soft-drink parent / root closure = both leaves, merged ascending by per100ml.
  const softDrink = [carbonated[0]!, water[0]!, carbonated[1]!];
  const byNode: Record<string, RankingRow[]> = {
    beverage: softDrink,
    'soft-drink': softDrink,
    carbonated,
    'drinking-water': water,
    alcohol: [],
  };

  it('leaf ?category=carbonated returns only the carbonated members', async () => {
    const { app } = nodeRankingsApp(byNode);
    const { res, json } = await getRankings(app, '?category=carbonated');
    expect(res.status).toBe(200);
    expect(json.map((r: any) => r.storeSku)).toEqual(['sku-carb-1', 'sku-carb-2']);
    // A sibling leaf's member (drinking-water) does NOT appear.
    expect(json.find((r: any) => r.storeSku === 'sku-water-1')).toBeUndefined();
  });

  it('parent ?category=soft-drink includes the child-leaf members (closure)', async () => {
    const { app } = nodeRankingsApp(byNode);
    const { res, json } = await getRankings(app, '?category=soft-drink');
    expect(res.status).toBe(200);
    // Union of carbonated + drinking-water leaves, ascending, ranks contiguous.
    expect(json.map((r: any) => r.storeSku)).toEqual([
      'sku-carb-1',
      'sku-water-1',
      'sku-carb-2',
    ]);
    expect(json.map((r: any) => r.rank)).toEqual([1, 2, 3]);
  });

  it('default (no params) = root beverage closure = soft-drink union', async () => {
    const { app } = nodeRankingsApp(byNode);
    const { res, json } = await getRankings(app);
    expect(res.status).toBe(200);
    expect(json.map((r: any) => r.storeSku)).toEqual([
      'sku-carb-1',
      'sku-water-1',
      'sku-carb-2',
    ]);
  });

  it('alcohol node (rankable=false subtree) -> 200 + [] (not 400/404)', async () => {
    const { app } = nodeRankingsApp(byNode);
    const { res, json } = await getRankings(app, '?category=alcohol');
    expect(res.status).toBe(200);
    expect(json).toEqual([]);
  });

  it('legal-but-unseeded slug (no tag row) -> 200 + [] (not 400)', async () => {
    // `juice-plant` is a seed slug but absent from byNode → repo returns []
    // (the migrate-before-seed window), mirroring a real repo's behavior.
    const { app, listRankings } = nodeRankingsApp(byNode);
    const { res, json } = await getRankings(app, '?category=juice-plant');
    expect(res.status).toBe(200);
    expect(json).toEqual([]);
    // It passed the 400 gate (a legal slug) and reached the repo — NOT a typo 400.
    expect(listRankings).toHaveBeenCalled();
    expect(listRankings.mock.calls[0]![0].category).toBe('juice-plant');
  });
});

describe('GET /rankings — empty library -> 200 + []', () => {
  it('no per100ml-non-null rows returns 200 and [] (not an error)', async () => {
    const { app } = rankingsApp([]);
    const { res, json } = await getRankings(app);
    expect(res.status).toBe(200);
    expect(json).toEqual([]);
  });
});

describe('GET /rankings — same per100ml stable pagination (one snapshot)', () => {
  it('two pages (offset 0 / offset N) cover the same-value rows without overlap or gaps', async () => {
    // limit=2 splits the 5-row snapshot into [0,2) / [2,4) / [4,5). The two
    // per100ml=2.0 rows (ml-2a, ml-2b) straddle pages 1 and 2; stable ordering
    // means page1 ends with ml-2a and page2 begins with ml-2b — no repeat, no
    // skip. Ranks must be globally contiguous across the page boundary.
    const { app } = rankingsApp(SNAPSHOT);
    const page1 = (await getRankings(app, '?limit=2&offset=0')).json;
    const page2 = (await getRankings(app, '?limit=2&offset=2')).json;
    const page3 = (await getRankings(app, '?limit=2&offset=4')).json;

    expect(page1.map((r: any) => r.rank)).toEqual([1, 2]);
    expect(page2.map((r: any) => r.rank)).toEqual([3, 4]);
    expect(page3.map((r: any) => r.rank)).toEqual([5]);

    // Reassembled storeSku order is the full snapshot, each row exactly once.
    const reassembled = [...page1, ...page2, ...page3].map((r: any) => r.storeSku);
    expect(reassembled).toEqual(SNAPSHOT.map((r) => `sku-${r.id}`));
    // No id collides across pages (no overlap), and the count matches (no gaps).
    expect(new Set(reassembled).size).toBe(SNAPSHOT.length);
  });
});

describe('GET /rankings — read failure -> 500 persistence-error', () => {
  it('listRankings throwing maps to 500 persistence-error (no recompute, no retry)', async () => {
    const { app } = rankingsApp(SNAPSHOT, { throws: true });
    const { res, json } = await getRankings(app, '?category=beverage');
    expect(res.status).toBe(500);
    expect(json.error).toBe('persistence-error');
  });
});

// ── GET /rankings — governance exemption (api-governance delta) ─────────────
describe('GET /rankings — governance-exempt public endpoint (4.2)', () => {
  /** A KV that records every get/put so we can prove rankings never touches it. */
  function spyKv() {
    const get = vi.fn(async () => null);
    const put = vi.fn(async () => undefined);
    return { get, put, kv: { get, put } as unknown as Bindings['GOVERNANCE_KV'] };
  }

  /** App with REAL governance + a fake read-only repo, env injected per request. */
  function govApp(env: Bindings) {
    const listRankings = vi.fn(async (input: ListRankingsInput) =>
      SNAPSHOT.slice(input.offset, input.offset + input.limit),
    );
    const repo = {
      async upsertRaw() {
        throw new Error('read-only');
      },
      async saveParsed() {
        throw new Error('read-only');
      },
      async getProduct() {
        return null;
      },
      async saveCorrection() {
        throw new Error('read-only');
      },
      listRankings,
    } as unknown as Repository;
    const app = createApp({
      makeLlm: () => throwingPort,
      governance: createRealGovernance(),
      makeRepo: () => repo,
    });
    return (path: string) => app.request(path, { method: 'GET' }, env);
  }

  it('GET /rankings without a key -> 200, and NO rate-limit/usage write to GOVERNANCE_KV', async () => {
    const { get, put, kv } = spyKv();
    // API_KEYS present (real governance configured) — yet /rankings must NOT
    // engage auth/rate/usage at all (governance-exempt, like /health).
    const request = govApp({ API_KEYS: 'key-alpha', GOVERNANCE_KV: kv });
    const res = await request('/rankings');
    expect(res.status).toBe(200);
    // No auth challenge, and zero KV access (no rl:/usage: counters written).
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it('exemption does not leak: a protected endpoint (/parse) still 401 auth-missing', async () => {
    const { kv } = spyKv();
    const request = govApp({ API_KEYS: 'key-alpha', GOVERNANCE_KV: kv });
    const res = await request('/parse'); // GET (no key) — auth fires first
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('auth-missing');
  });
});

// ── GET /categories — read-only category-tree browse (category-tree-api spec) ──
//
// The route is a thin read-only pass-through: it calls repo.listCategoryTree,
// wraps the nodes in `{ nodes }`, validates CategoryTreeResponseSchema, and
// returns. The inheritance resolution, the `rankable` axis flag, the closure
// `rankableCount`, and the "only kind=category" filter are repo-owned (covered in
// @unit-price/db's own tests). Here we assert the HTTP contract against a fixture
// that MIRRORS the seed tree so the route-level shape/value passthrough and the
// `rankableCount`↔node-board consistency are exercised end to end.

/** A CategoryTreeNode fixture. */
function node(over: Partial<CategoryTreeNode> & Pick<CategoryTreeNode, 'slug' | 'name'>): CategoryTreeNode {
  return {
    parentSlug: null,
    comparableUnit: null,
    rankable: false,
    rankableCount: 0,
    ...over,
  };
}

/**
 * A tree fixture mirroring the seed: root `beverage` (rankable=false but
 * rankableCount>0 = default board basis), the `soft-drink` parent and its leaves
 * (all per_100ml / rankable=true), and the alcohol subtree (comparableUnit=null /
 * rankable=false / rankableCount=0). Counts are chosen so the parent equals the
 * union of its leaves and root equals the soft-drink total.
 */
const TREE: CategoryTreeNode[] = [
  node({ slug: 'beverage', name: '饮料', parentSlug: null, comparableUnit: null, rankable: false, rankableCount: 7 }),
  node({ slug: 'soft-drink', name: '软饮', parentSlug: 'beverage', comparableUnit: 'per_100ml', rankable: true, rankableCount: 7 }),
  node({ slug: 'carbonated', name: '碳酸饮料', parentSlug: 'soft-drink', comparableUnit: 'per_100ml', rankable: true, rankableCount: 4 }),
  node({ slug: 'drinking-water', name: '饮用水', parentSlug: 'soft-drink', comparableUnit: 'per_100ml', rankable: true, rankableCount: 3 }),
  node({ slug: 'juice-plant', name: '果汁·植物饮', parentSlug: 'soft-drink', comparableUnit: 'per_100ml', rankable: true, rankableCount: 0 }),
  node({ slug: 'alcohol', name: '酒类', parentSlug: 'beverage', comparableUnit: null, rankable: false, rankableCount: 0 }),
  node({ slug: 'wine', name: '葡萄酒', parentSlug: 'alcohol', comparableUnit: null, rankable: false, rankableCount: 0 }),
  node({ slug: 'baijiu', name: '白酒', parentSlug: 'alcohol', comparableUnit: null, rankable: false, rankableCount: 0 }),
];

/** App whose Repository serves `tree` from listCategoryTree (read-only). */
function categoriesApp(tree: CategoryTreeNode[], opts: { throws?: boolean } = {}) {
  const listCategoryTree = vi.fn(async (): Promise<CategoryTreeNode[]> => {
    if (opts.throws) throw new Error('simulated read failure');
    return tree;
  });
  const repo = {
    async upsertRaw() {
      throw new Error('categories is read-only: upsertRaw must not be called');
    },
    async saveParsed() {
      throw new Error('categories is read-only: saveParsed must not be called');
    },
    async getProduct() {
      return null;
    },
    async saveCorrection() {
      throw new Error('categories is read-only: saveCorrection must not be called');
    },
    listCategoryTree,
  } as unknown as Repository;
  const app = createApp({
    makeLlm: () => throwingPort,
    governance: createNoopGovernance(),
    makeRepo: () => repo,
  });
  return { app, listCategoryTree };
}

/** GET /categories on an app, returning {res, json}. */
async function getCategories(app: ReturnType<typeof createApp>) {
  const res = await app.request('/categories', { method: 'GET' });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { res, json };
}

describe('GET /categories — full category is-a tree, only the category axis', () => {
  it('returns 200 { nodes } with every category node, no attribute/brand/product_line axis', async () => {
    const { app } = categoriesApp(TREE);
    const { res, json } = await getCategories(app);
    expect(res.status).toBe(200);
    expect(Array.isArray(json.nodes)).toBe(true);
    const slugs = json.nodes.map((n: any) => n.slug);
    // Every category node is present.
    expect(slugs).toEqual(TREE.map((n) => n.slug));
    // No attribute axis slug (e.g. sugar-free) leaks in — the repo only emits
    // kind=category nodes, so the response carries none.
    expect(slugs).not.toContain('sugar-free');
    expect(slugs).not.toContain('sparkling');
    // Each node carries exactly the contract fields.
    for (const n of json.nodes) {
      expect(n).toHaveProperty('slug');
      expect(n).toHaveProperty('name');
      expect(n).toHaveProperty('parentSlug');
      expect(n).toHaveProperty('comparableUnit');
      expect(n).toHaveProperty('rankable');
      expect(n).toHaveProperty('rankableCount');
    }
  });
});

describe('GET /categories — comparableUnit / rankable per node', () => {
  it('soft-drink parent + leaves: per_100ml + rankable=true; alcohol+root: null + rankable=false', async () => {
    const { app } = categoriesApp(TREE);
    const { json } = await getCategories(app);
    const bySlug: Record<string, any> = Object.fromEntries(json.nodes.map((n: any) => [n.slug, n]));
    // soft-drink parent (directly bound) and soft-drink leaves (inherited).
    for (const slug of ['soft-drink', 'carbonated', 'drinking-water', 'juice-plant']) {
      expect(bySlug[slug].comparableUnit).toBe('per_100ml');
      expect(bySlug[slug].rankable).toBe(true);
    }
    // alcohol parent + alcohol leaves + root: comparableUnit null, rankable false.
    for (const slug of ['alcohol', 'wine', 'baijiu', 'beverage']) {
      expect(bySlug[slug].comparableUnit).toBeNull();
      expect(bySlug[slug].rankable).toBe(false);
    }
  });
});

describe('GET /categories — rankableCount orthogonal to rankable', () => {
  it('root beverage rankableCount > 0 and equals default /rankings basis; alcohol = 0', async () => {
    const { app } = categoriesApp(TREE);
    const { json } = await getCategories(app);
    const bySlug: Record<string, any> = Object.fromEntries(json.nodes.map((n: any) => [n.slug, n]));
    // Root is rankable=false yet its closure has rankable members → count > 0.
    expect(bySlug.beverage.rankable).toBe(false);
    expect(bySlug.beverage.rankableCount).toBeGreaterThan(0);
    // soft-drink parent count = union of its leaves (4 + 3 + 0).
    expect(bySlug['soft-drink'].rankableCount).toBe(7);
    // alcohol subtree has no rankable members → count 0 (despite being a node).
    expect(bySlug.alcohol.rankableCount).toBe(0);
    expect(bySlug.wine.rankableCount).toBe(0);
  });

  it('an empty leaf (juice-plant) stays in the tree with rankableCount=0', async () => {
    const { app } = categoriesApp(TREE);
    const { json } = await getCategories(app);
    const jp = json.nodes.find((n: any) => n.slug === 'juice-plant');
    expect(jp).toBeDefined();
    expect(jp.rankableCount).toBe(0);
  });
});

describe('GET /categories — rankableCount matches the node board basis', () => {
  it('root rankableCount equals the default /rankings (no params) basis (same snapshot)', async () => {
    // One repo serves BOTH endpoints off a shared snapshot: a 7-row root board
    // and a tree whose root rankableCount=7. The route must report the same N on
    // both surfaces.
    const rootBoard: RankingRow[] = Array.from({ length: 7 }, (_, i) =>
      row({ id: `r-${i}`, per100ml: i + 1, storeSku: `sku-r-${i}` }),
    );
    const listRankings = vi.fn(async (input: ListRankingsInput) =>
      rootBoard.slice(input.offset, input.offset + input.limit),
    );
    const listCategoryTree = vi.fn(async () => TREE);
    const repo = {
      async upsertRaw() {
        throw new Error('read-only');
      },
      async saveParsed() {
        throw new Error('read-only');
      },
      async getProduct() {
        return null;
      },
      async saveCorrection() {
        throw new Error('read-only');
      },
      listRankings,
      listCategoryTree,
    } as unknown as Repository;
    const app = createApp({
      makeLlm: () => throwingPort,
      governance: createNoopGovernance(),
      makeRepo: () => repo,
    });

    const cats = await getCategories(app);
    const rootCount = cats.json.nodes.find((n: any) => n.slug === 'beverage').rankableCount;
    const board = await getRankings(app, '?limit=200');
    expect(board.json).toHaveLength(rootCount);
  });

  it('alcohol rankableCount=0 and its node board is empty (same data)', async () => {
    const byNode: Record<string, RankingRow[]> = { alcohol: [] };
    const listRankings = vi.fn(async (input: ListRankingsInput) =>
      (byNode[input.category] ?? []).slice(input.offset, input.offset + input.limit),
    );
    const listCategoryTree = vi.fn(async () => TREE);
    const repo = {
      async upsertRaw() {
        throw new Error('read-only');
      },
      async saveParsed() {
        throw new Error('read-only');
      },
      async getProduct() {
        return null;
      },
      async saveCorrection() {
        throw new Error('read-only');
      },
      listRankings,
      listCategoryTree,
    } as unknown as Repository;
    const app = createApp({
      makeLlm: () => throwingPort,
      governance: createNoopGovernance(),
      makeRepo: () => repo,
    });
    const cats = await getCategories(app);
    const alcoholCount = cats.json.nodes.find((n: any) => n.slug === 'alcohol').rankableCount;
    expect(alcoholCount).toBe(0);
    const board = await getRankings(app, '?category=alcohol');
    expect(board.json).toEqual([]);
  });
});

describe('GET /categories — unseeded taxonomy -> 200 { nodes: [] }', () => {
  it('no kind=category rows returns 200 and an empty tree (not an error)', async () => {
    const { app } = categoriesApp([]);
    const { res, json } = await getCategories(app);
    expect(res.status).toBe(200);
    expect(json).toEqual({ nodes: [] });
  });
});

describe('GET /categories — read failure -> 500 persistence-error', () => {
  it('listCategoryTree throwing maps to 500 persistence-error', async () => {
    const { app } = categoriesApp(TREE, { throws: true });
    const { res, json } = await getCategories(app);
    expect(res.status).toBe(500);
    expect(json.error).toBe('persistence-error');
  });
});

describe('GET /categories — response validation failure -> 500 internal', () => {
  it('a node violating CategoryTreeResponseSchema (rankableCount<0) maps to 500 internal', async () => {
    const { app } = categoriesApp([node({ slug: 'beverage', name: '饮料', rankableCount: -1 })]);
    const { res, json } = await getCategories(app);
    expect(res.status).toBe(500);
    expect(json.error).toBe('internal');
  });
});

describe('GET /categories — governance-exempt public endpoint', () => {
  it('GET /categories without a key -> 200, and NO rate-limit/usage write to GOVERNANCE_KV', async () => {
    const get = vi.fn(async () => null);
    const put = vi.fn(async () => undefined);
    const kv = { get, put } as unknown as Bindings['GOVERNANCE_KV'];
    const listCategoryTree = vi.fn(async () => TREE);
    const repo = {
      async upsertRaw() {
        throw new Error('read-only');
      },
      async saveParsed() {
        throw new Error('read-only');
      },
      async getProduct() {
        return null;
      },
      async saveCorrection() {
        throw new Error('read-only');
      },
      listCategoryTree,
    } as unknown as Repository;
    // REAL governance configured (API_KEYS present) — yet /categories must NOT
    // engage auth/rate/usage at all (governance-exempt, like /rankings).
    const app = createApp({
      makeLlm: () => throwingPort,
      governance: createRealGovernance(),
      makeRepo: () => repo,
    });
    const res = await app.request('/categories', { method: 'GET' }, { API_KEYS: 'key-alpha', GOVERNANCE_KV: kv });
    expect(res.status).toBe(200);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });
});
