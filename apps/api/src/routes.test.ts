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
    // P3.5: default category is `soft-drink` (the 软饮 cohort), not root `beverage`.
    expect(seen!.category).toBe('soft-drink');
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

  // P3.5 cohort guard: a node that statically resolves a non-null comparable_unit
  // (soft-drink / its leaves / dairy / dairy leaves / each 酒种 leaf) is admitted.
  it.each([
    ['soft-drink parent', 'soft-drink'],
    ['carbonated leaf', 'carbonated'],
    ['coffee-tea leaf', 'coffee-tea'],
    ['drinking-water leaf', 'drinking-water'],
    ['dairy parent', 'dairy'],
    ['milk leaf', 'milk'],
    ['yogurt leaf', 'yogurt'],
    ['lactic-drink leaf', 'lactic-drink'],
    ['beer leaf', 'beer'],
    ['wine leaf', 'wine'],
    ['spirits leaf', 'spirits'],
    ['whisky leaf', 'whisky'],
    ['baijiu leaf', 'baijiu'],
    ['sake-fruit-wine leaf', 'sake-fruit-wine'],
  ])('?category=%s (cohort node, comparable_unit non-null) is admitted -> 200', async (_name, slug) => {
    let seen: ListRankingsInput | null = null;
    const { app } = rankingsApp(SNAPSHOT, { onCall: (i) => (seen = i) });
    const { res } = await getRankings(app, `?category=${slug}`);
    expect(res.status).toBe(200);
    // The validated slug is forwarded to listRankings verbatim.
    expect(seen!.category).toBe(slug);
  });

  // P3.5 cohort guard: a cross-cohort node (root `beverage`, `alcohol` parent)
  // statically resolves null → 400 (it spans multiple per100ml cohorts; the
  // board would mix 矿泉水+葡萄酒 / 啤酒+威士忌). Replaces the P3 `→ 200` rows.
  // The guard fires BEFORE the repo is queried.
  it.each([
    ['root', 'beverage'],
    ['alcohol parent', 'alcohol'],
  ])('?category=%s (cross-cohort node, comparable_unit null) -> 400 invalid-request', async (_name, slug) => {
    const { app, listRankings } = rankingsApp(SNAPSHOT);
    const { res, json } = await getRankings(app, `?category=${slug}`);
    expect(res.status).toBe(400);
    expect(json.error).toBe('invalid-request');
    expect(listRankings).not.toHaveBeenCalled();
  });
});

describe('GET /rankings — node scope: default = soft-drink cohort (P3.5)', () => {
  it('no params ≡ ?category=soft-drink: same forwarded ListRankingsInput', async () => {
    let noParam: ListRankingsInput | null = null;
    const a = rankingsApp(SNAPSHOT, { onCall: (i) => (noParam = i) });
    await getRankings(a.app);
    let explicit: ListRankingsInput | null = null;
    const b = rankingsApp(SNAPSHOT, { onCall: (i) => (explicit = i) });
    await getRankings(b.app, '?category=soft-drink');
    expect(noParam!).toEqual(explicit!);
    expect(noParam!.category).toBe('soft-drink');
  });

  it('explicit ?category=beverage (root, cross-cohort) -> 400 (guard fires before repo)', async () => {
    const { app, listRankings } = rankingsApp(SNAPSHOT);
    const { res, json } = await getRankings(app, '?category=beverage');
    expect(res.status).toBe(400);
    expect(json.error).toBe('invalid-request');
    expect(listRankings).not.toHaveBeenCalled();
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
  // A small dirty-ish snapshot keyed by node. The soft-drink snapshot is the union
  // of its two leaves (carbonated + drinking-water) — i.e. the parent closure
  // includes the child leaves. Each 酒种 leaf is its own cohort (beer here has its
  // own members); the `alcohol` parent is cohort-guarded out (400), so the route
  // never even queries the repo for it (no byNode entry needed).
  const carbonated = [
    row({ id: 'c-1', per100ml: 0.5, storeSku: 'sku-carb-1' }),
    row({ id: 'c-2', per100ml: 3.2, storeSku: 'sku-carb-2' }),
  ];
  const water = [row({ id: 'w-1', per100ml: 1.1, storeSku: 'sku-water-1' })];
  const beerRows = [
    row({ id: 'b-1', per100ml: 1.8, storeSku: 'sku-beer-1' }),
    row({ id: 'b-2', per100ml: 4.5, storeSku: 'sku-beer-2' }),
  ];
  // soft-drink parent closure = both leaves, merged ascending by per100ml.
  const softDrink = [carbonated[0]!, water[0]!, carbonated[1]!];
  const byNode: Record<string, RankingRow[]> = {
    'soft-drink': softDrink,
    carbonated,
    'drinking-water': water,
    beer: beerRows,
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

  it('default (no params) = soft-drink cohort (not the cross-cohort root)', async () => {
    const { app } = nodeRankingsApp(byNode);
    const { res, json } = await getRankings(app);
    expect(res.status).toBe(200);
    expect(json.map((r: any) => r.storeSku)).toEqual([
      'sku-carb-1',
      'sku-water-1',
      'sku-carb-2',
    ]);
  });

  it('?category=beer returns only the beer cohort; other 酒种/软饮 never mix', async () => {
    const { app } = nodeRankingsApp(byNode);
    const { res, json } = await getRankings(app, '?category=beer');
    expect(res.status).toBe(200);
    expect(json.map((r: any) => r.storeSku)).toEqual(['sku-beer-1', 'sku-beer-2']);
    // No soft-drink member leaks into the beer cohort board.
    expect(json.find((r: any) => r.storeSku === 'sku-carb-1')).toBeUndefined();
  });

  it('alcohol parent (cross-cohort) -> 400, repo never queried (cohort guard)', async () => {
    const { app, listRankings } = nodeRankingsApp(byNode);
    const { res, json } = await getRankings(app, '?category=alcohol');
    expect(res.status).toBe(400);
    expect(json.error).toBe('invalid-request');
    expect(listRankings).not.toHaveBeenCalled();
  });

  it('legal-but-unseeded slug (no tag row) -> 200 + [] (not 400)', async () => {
    // `juice-plant` is a seed slug (static unit per_100ml) but absent from byNode
    // → repo returns [] (the migrate-before-seed window), mirroring a real repo.
    const { app, listRankings } = nodeRankingsApp(byNode);
    const { res, json } = await getRankings(app, '?category=juice-plant');
    expect(res.status).toBe(200);
    expect(json).toEqual([]);
    // It cleared the slug enum AND the static cohort guard (a legal cohort slug)
    // and reached the repo — NOT a typo 400, NOT a cohort 400.
    expect(listRankings).toHaveBeenCalled();
    expect(listRankings.mock.calls[0]![0].category).toBe('juice-plant');
  });
});

// ── GET /rankings — cohort guard runs on the STATIC tree, not DB seed state ──
// The decisive P3.5 contract: a legal cohort leaf (`beer`) that statically
// resolves `per_100ml` clears the guard even when the DB has NO tag rows seeded
// (the migrate-before-seed window → repo returns []), so it is 200 [], never 400.
// A cross-cohort parent (`alcohol`) statically resolves null → 400 regardless of
// seed state. This proves the guard uses the compile-time `CATEGORY_NODES`, not a
// runtime `tag`-table round-trip (which would wrongly 400 the unseeded `beer`).
describe('GET /rankings — cohort guard is static (unseeded-window)', () => {
  it('?category=beer on an UNSEEDED (empty tag) DB -> 200 + [] (static guard passes)', async () => {
    // The repo returns [] for every slug (no tag rows seeded yet).
    const { app, listRankings } = nodeRankingsApp({});
    const { res, json } = await getRankings(app, '?category=beer');
    expect(res.status).toBe(200);
    expect(json).toEqual([]);
    // The guard did NOT consult the DB to decide — it cleared `beer` statically
    // (per_100ml) and let the request reach the repo, which returned [].
    expect(listRankings).toHaveBeenCalled();
    expect(listRankings.mock.calls[0]![0].category).toBe('beer');
  });

  it('?category=alcohol on an UNSEEDED DB -> 400 (static null, repo never queried)', async () => {
    const { app, listRankings } = nodeRankingsApp({});
    const { res, json } = await getRankings(app, '?category=alcohol');
    expect(res.status).toBe(400);
    expect(json.error).toBe('invalid-request');
    expect(listRankings).not.toHaveBeenCalled();
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

// ── GET /rankings — q (title substring search) validation + cache (rankings-api)
// The route validates `q` via the RankingsQuerySchema pipeline (trim → ''→undefined
// → refine ≥2 codepoints → truncate ≤64 codepoints → optional) and forwards the
// validated value to listRankings. The db layer owns the actual LIKE/ESCAPE
// filtering (covered in @unit-price/db); here we assert what the ROUTE forwards and
// how it sets Cache-Control. ALL length math is by CODEPOINT (`[...s]`), never `.length`.
describe('GET /rankings — q search: validation, forwarding, codepoint length', () => {
  it('?q=可乐 forwards the trimmed/truncated q to listRankings (200)', async () => {
    let seen: ListRankingsInput | null = null;
    const { app } = rankingsApp(SNAPSHOT, { onCall: (i) => (seen = i) });
    const { res } = await getRankings(app, `?q=${encodeURIComponent('可乐')}`);
    expect(res.status).toBe(200);
    expect(seen!.q).toBe('可乐');
  });

  it('?q=水 (single codepoint) -> 400 invalid-request, repo never queried', async () => {
    const { app, listRankings } = rankingsApp(SNAPSHOT);
    const { res, json } = await getRankings(app, `?q=${encodeURIComponent('水')}`);
    expect(res.status).toBe(400);
    expect(json.error).toBe('invalid-request');
    expect(listRankings).not.toHaveBeenCalled();
  });

  it('duplicate ?q=可乐&q=雪碧 forwards the FIRST value 可乐 (Hono c.req.query semantics)', async () => {
    let seen: ListRankingsInput | null = null;
    const { app } = rankingsApp(SNAPSHOT, { onCall: (i) => (seen = i) });
    const { res } = await getRankings(
      app,
      `?q=${encodeURIComponent('可乐')}&q=${encodeURIComponent('雪碧')}`,
    );
    expect(res.status).toBe(200);
    // c.req.query() takes the first value; the second (雪碧) is ignored.
    expect(seen!.q).toBe('可乐');
  });

  it('duplicate ?q=水&q=可乐 runs the length gate on the FIRST value 水 -> 400, repo never queried', async () => {
    const { app, listRankings } = rankingsApp(SNAPSHOT);
    const { res, json } = await getRankings(
      app,
      `?q=${encodeURIComponent('水')}&q=${encodeURIComponent('可乐')}`,
    );
    // First value 水 is 1 codepoint → fails the ≥2 gate, even though a valid
    // second value 可乐 follows (which c.req.query ignores).
    expect(res.status).toBe(400);
    expect(json.error).toBe('invalid-request');
    expect(listRankings).not.toHaveBeenCalled();
  });

  it.each([
    ['empty q', '?q='],
    ['half-width whitespace q', `?q=${encodeURIComponent('  ')}`],
    ['full-width whitespace q', `?q=${encodeURIComponent('　')}`],
  ])('%s -> not filtered (q === undefined forwarded), 200', async (_name, query) => {
    let seen: ListRankingsInput | null = null;
    const { app } = rankingsApp(SNAPSHOT, { onCall: (i) => (seen = i) });
    const { res } = await getRankings(app, query);
    expect(res.status).toBe(200);
    // trim → '' → undefined BEFORE the refine, so empty/whitespace never 400s and
    // never filters (the request is the plain cohort board).
    expect(seen!.q).toBeUndefined();
  });

  it('?q=<70 codepoints> truncates to 64 codepoints', async () => {
    let seen: ListRankingsInput | null = null;
    const { app } = rankingsApp(SNAPSHOT, { onCall: (i) => (seen = i) });
    const long = 'a'.repeat(70);
    const { res } = await getRankings(app, `?q=${encodeURIComponent(long)}`);
    expect(res.status).toBe(200);
    expect([...seen!.q!]).toHaveLength(64);
    expect(seen!.q).toBe('a'.repeat(64));
  });

  it('surrogate-pair q (emoji / 𠮷) is measured by codepoint, never split at the 64 boundary', async () => {
    let seen: ListRankingsInput | null = null;
    const { app } = rankingsApp(SNAPSHOT, { onCall: (i) => (seen = i) });
    // 𠮷 is one codepoint but two UTF-16 units; 70 of them = 70 codepoints (140
    // UTF-16 units). By codepoint we truncate to 64 whole chars — never a lone
    // surrogate. (UTF-16 `.length` would wrongly see 140 and slice at unit 64,
    // splitting a pair.)
    const surrogate = '𠮷'.repeat(70);
    const { res } = await getRankings(app, `?q=${encodeURIComponent(surrogate)}`);
    expect(res.status).toBe(200);
    expect([...seen!.q!]).toHaveLength(64); // 64 codepoints, not 64 UTF-16 units
    expect(seen!.q).toBe('𠮷'.repeat(64));
    // No lone surrogate (split pair) survived: every codepoint is the full 𠮷.
    expect([...seen!.q!].every((ch) => ch === '𠮷')).toBe(true);
  });

  it('a 2-codepoint emoji q passes the ≥2 lower bound (not under-counted as 1)', async () => {
    let seen: ListRankingsInput | null = null;
    const { app } = rankingsApp(SNAPSHOT, { onCall: (i) => (seen = i) });
    // Two emoji = 2 codepoints (4 UTF-16 units). Codepoint length 2 ≥ 2 → admitted.
    const twoEmoji = '😀😀';
    const { res } = await getRankings(app, `?q=${encodeURIComponent(twoEmoji)}`);
    expect(res.status).toBe(200);
    expect(seen!.q).toBe(twoEmoji);
  });

  it.each([
    ['literal percent', '100%水'],
    ['literal underscore', 'a_b'],
    ['literal escape char', 'a!b'],
    ['literal plus (encodeURIComponent → %2B → +)', '100+200'],
  ])(
    '%s is forwarded VERBATIM (route does not escape; db ESCAPE owns LIKE literalization)',
    async (_name, q) => {
      let seen: ListRankingsInput | null = null;
      const { app } = rankingsApp(SNAPSHOT, { onCall: (i) => (seen = i) });
      const { res } = await getRankings(app, `?q=${encodeURIComponent(q)}`);
      expect(res.status).toBe(200);
      // The route forwards the literal user text; LIKE special chars (%, _, the !
      // escape char) are escaped in the db layer's `ESCAPE '!'` pattern, and `+`
      // survives as a literal because encode/decodeURIComponent map + ↔ %2B (NOT
      // form `+`→space). So `100+200` reaches the repo as `100+200`.
      expect(seen!.q).toBe(q);
    },
  );

  it('?q=可乐&category=alcohol -> 400 (cohort guard fires BEFORE the q filter)', async () => {
    const { app, listRankings } = rankingsApp(SNAPSHOT);
    const { res, json } = await getRankings(
      app,
      `?q=${encodeURIComponent('可乐')}&category=alcohol`,
    );
    expect(res.status).toBe(400);
    expect(json.error).toBe('invalid-request');
    // The cross-cohort guard rejects before the repo is ever queried, regardless
    // of a present q.
    expect(listRankings).not.toHaveBeenCalled();
  });
});

describe('GET /rankings — q search: cache verdict keys off the POST-PARSE q', () => {
  it('?q=可乐 (real filter) -> Cache-Control: no-store (not just omitting public)', async () => {
    const { app } = rankingsApp(SNAPSHOT);
    const { res } = await getRankings(app, `?q=${encodeURIComponent('可乐')}`);
    expect(res.status).toBe(200);
    const cc = res.headers.get('cache-control') ?? '';
    expect(cc).toBe('no-store');
    expect(cc).not.toMatch(/public/);
  });

  it.each([
    ['?q=%20%20 (whitespace → undefined)', `?q=${encodeURIComponent('  ')}`],
    ['no q at all', ''],
  ])('%s -> public edge cache (same as no-q board)', async (_name, query) => {
    const { app } = rankingsApp(SNAPSHOT);
    const { res } = await getRankings(app, query);
    expect(res.status).toBe(200);
    const cc = res.headers.get('cache-control') ?? '';
    // q parsed to undefined → body equals the cohort board → rides the public
    // edge cache. The verdict keys off the POST-PARSE q (undefined), NOT the raw
    // URL having a `q` key.
    expect(cc).toMatch(/public/);
    expect(cc).toMatch(/max-age=\d+/);
    expect(cc).not.toBe('no-store');
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
    // Use a legal cohort slug (soft-drink) so the request clears the cohort guard
    // and actually reaches the throwing repo. A cross-cohort `beverage` would 400
    // at the guard BEFORE the repo throws — the wrong code path for this test.
    const { app } = rankingsApp(SNAPSHOT, { throws: true });
    const { res, json } = await getRankings(app, '?category=soft-drink');
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
 * A tree fixture mirroring the P3.5 seed: root `beverage` (rankable=false,
 * comparableUnit=null — NOT the default board, which is now `soft-drink`), the
 * `soft-drink` parent + leaves (all per_100ml / rankable=true), the `dairy` parent
 * + leaves (per_100ml / rankable=true), and the alcohol subtree — where the
 * `alcohol` PARENT is comparableUnit=null / rankable=false (cross-cohort,
 * cohort-guarded out of /rankings) but its rankableCount > 0 (its 酒种 leaf
 * descendants ARE rankable), and each 酒种 LEAF is per_100ml / rankable=true (its
 * own cohort). Counts: each parent equals the union of its rankable descendants.
 */
const TREE: CategoryTreeNode[] = [
  node({ slug: 'beverage', name: '饮料', parentSlug: null, comparableUnit: null, rankable: false, rankableCount: 13 }),
  node({ slug: 'soft-drink', name: '软饮', parentSlug: 'beverage', comparableUnit: 'per_100ml', rankable: true, rankableCount: 7 }),
  node({ slug: 'carbonated', name: '碳酸饮料', parentSlug: 'soft-drink', comparableUnit: 'per_100ml', rankable: true, rankableCount: 4 }),
  node({ slug: 'drinking-water', name: '饮用水', parentSlug: 'soft-drink', comparableUnit: 'per_100ml', rankable: true, rankableCount: 3 }),
  node({ slug: 'juice-plant', name: '果汁·植物饮', parentSlug: 'soft-drink', comparableUnit: 'per_100ml', rankable: true, rankableCount: 0 }),
  node({ slug: 'dairy', name: '乳品', parentSlug: 'beverage', comparableUnit: 'per_100ml', rankable: true, rankableCount: 2 }),
  node({ slug: 'milk', name: '牛奶', parentSlug: 'dairy', comparableUnit: 'per_100ml', rankable: true, rankableCount: 2 }),
  node({ slug: 'yogurt', name: '酸奶', parentSlug: 'dairy', comparableUnit: 'per_100ml', rankable: true, rankableCount: 0 }),
  node({ slug: 'lactic-drink', name: '乳酸菌饮料', parentSlug: 'dairy', comparableUnit: 'per_100ml', rankable: true, rankableCount: 0 }),
  node({ slug: 'alcohol', name: '酒类', parentSlug: 'beverage', comparableUnit: null, rankable: false, rankableCount: 4 }),
  node({ slug: 'wine', name: '葡萄酒', parentSlug: 'alcohol', comparableUnit: 'per_100ml', rankable: true, rankableCount: 3 }),
  node({ slug: 'baijiu', name: '白酒', parentSlug: 'alcohol', comparableUnit: 'per_100ml', rankable: true, rankableCount: 1 }),
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

describe('public GET endpoints are edge-cacheable on 200, never on errors', () => {
  it('/rankings 200 → public, max-age Cache-Control (edge cache enabled)', async () => {
    const { app } = rankingsApp(SNAPSHOT);
    const { res } = await getRankings(app);
    expect(res.status).toBe(200);
    const cc = res.headers.get('cache-control') ?? '';
    expect(cc).toMatch(/public/);
    expect(cc).toMatch(/max-age=\d+/);
  });

  it('/categories 200 → public, max-age Cache-Control', async () => {
    const { app } = categoriesApp(TREE);
    const { res } = await getCategories(app);
    expect(res.status).toBe(200);
    const cc = res.headers.get('cache-control') ?? '';
    expect(cc).toMatch(/public/);
    expect(cc).toMatch(/max-age=\d+/);
  });

  it('/rankings 400 (invalid) carries NO Cache-Control — a cached error must never be served', async () => {
    const { app } = rankingsApp(SNAPSHOT);
    const { res } = await getRankings(app, '?limit=0');
    expect(res.status).toBe(400);
    expect(res.headers.get('cache-control')).toBeNull();
  });
});

describe('GET /categories — comparableUnit / rankable per node (P3.5 收敛)', () => {
  it('soft-drink/dairy/酒种叶: per_100ml + rankable=true; alcohol parent+root: null + rankable=false', async () => {
    const { app } = categoriesApp(TREE);
    const { json } = await getCategories(app);
    const bySlug: Record<string, any> = Object.fromEntries(json.nodes.map((n: any) => [n.slug, n]));
    // Soft-drink line, dairy line, and each 酒种 leaf are all single rankable
    // cohorts (per_100ml / rankable=true → 可点进).
    for (const slug of [
      'soft-drink', 'carbonated', 'drinking-water', 'juice-plant',
      'dairy', 'milk', 'yogurt', 'lactic-drink',
      'wine', 'baijiu',
    ]) {
      expect(bySlug[slug].comparableUnit).toBe('per_100ml');
      expect(bySlug[slug].rankable).toBe(true);
    }
    // ONLY the cross-cohort ancestors (alcohol parent, root) are null / rankable
    // false (不可点进, /rankings cohort-guards them to 400).
    for (const slug of ['alcohol', 'beverage']) {
      expect(bySlug[slug].comparableUnit).toBeNull();
      expect(bySlug[slug].rankable).toBe(false);
    }
  });
});

describe('GET /categories — rankableCount orthogonal to rankable (P3.5)', () => {
  it('root + alcohol parent: rankable=false yet rankableCount>0 (informational branch count)', async () => {
    const { app } = categoriesApp(TREE);
    const { json } = await getCategories(app);
    const bySlug: Record<string, any> = Object.fromEntries(json.nodes.map((n: any) => [n.slug, n]));
    // Root is rankable=false (not 可点进) yet its closure has rankable members →
    // count > 0 (a branch信息 count, NOT a clickable board — /rankings 400s it).
    expect(bySlug.beverage.rankable).toBe(false);
    expect(bySlug.beverage.rankableCount).toBeGreaterThan(0);
    // P3.5 KEY FLIP: the alcohol PARENT is rankable=false but rankableCount>0 (its
    // 酒种 leaf descendants are rankable). A client must NOT read this as 可点进.
    expect(bySlug.alcohol.rankable).toBe(false);
    expect(bySlug.alcohol.rankableCount).toBeGreaterThan(0);
    // soft-drink parent count = union of its leaves (4 + 3 + 0).
    expect(bySlug['soft-drink'].rankableCount).toBe(7);
    // 酒种 leaves ARE rankable cohorts with their own counts (no longer 0).
    expect(bySlug.wine.rankable).toBe(true);
    expect(bySlug.wine.rankableCount).toBe(3);
    expect(bySlug.baijiu.rankableCount).toBe(1);
  });

  it('an empty rankable leaf (juice-plant / yogurt) stays in the tree with rankableCount=0', async () => {
    const { app } = categoriesApp(TREE);
    const { json } = await getCategories(app);
    const bySlug: Record<string, any> = Object.fromEntries(json.nodes.map((n: any) => [n.slug, n]));
    // 可点进 but empty cohort: rankable=true ∧ rankableCount=0 (空 cohort, 仍列出).
    for (const slug of ['juice-plant', 'yogurt']) {
      expect(bySlug[slug]).toBeDefined();
      expect(bySlug[slug].rankable).toBe(true);
      expect(bySlug[slug].rankableCount).toBe(0);
    }
  });

  // P3.5 consumption contract: 可点进 is decided by node.rankable, NOT by
  // rankableCount>0. The alcohol parent is the canonical counter-example.
  it('consumption contract: alcohol parent rankableCount>0 but rankable=false → NOT 可点进', async () => {
    const { app } = categoriesApp(TREE);
    const { json } = await getCategories(app);
    const alcohol = json.nodes.find((n: any) => n.slug === 'alcohol');
    // A client keying off rankableCount>0 would wrongly treat it as clickable;
    // the contract says key off rankable (=false → 不可点进, matches /rankings 400).
    expect(alcohol.rankableCount).toBeGreaterThan(0);
    expect(alcohol.rankable).toBe(false);
  });
});

describe('GET /categories — rankableCount matches the cohort board basis (P3.5)', () => {
  it('soft-drink (可点进) rankableCount equals the default /rankings (no params) basis', async () => {
    // One repo serves BOTH surfaces off a shared snapshot keyed by node. The
    // default /rankings (no params) is the `soft-drink` cohort (P3.5), so the
    // soft-drink board basis must equal the tree's soft-drink rankableCount (7).
    const softBoard: RankingRow[] = Array.from({ length: 7 }, (_, i) =>
      row({ id: `s-${i}`, per100ml: i + 1, storeSku: `sku-s-${i}` }),
    );
    const byNode: Record<string, RankingRow[]> = { 'soft-drink': softBoard };
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
    const softCount = cats.json.nodes.find((n: any) => n.slug === 'soft-drink').rankableCount;
    expect(softCount).toBe(7);
    // Default board (no params) ≡ soft-drink cohort → same basis N.
    const board = await getRankings(app, '?limit=200');
    expect(board.json).toHaveLength(softCount);
  });

  it('a 可点进 酒种 leaf (wine) rankableCount equals its cohort board basis', async () => {
    // For a rankable=true cohort node, rankableCount MUST equal its
    // /rankings?category=<node> basis. wine: tree count 3, board 3 rows.
    const wineBoard: RankingRow[] = Array.from({ length: 3 }, (_, i) =>
      row({ id: `wine-${i}`, per100ml: 10 + i, storeSku: `sku-wine-${i}` }),
    );
    const byNode: Record<string, RankingRow[]> = { wine: wineBoard };
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
    const wineCount = cats.json.nodes.find((n: any) => n.slug === 'wine').rankableCount;
    expect(wineCount).toBe(3);
    // wine is a rankable cohort: the guard passes and the board basis matches.
    const wineBoardRes = await getRankings(app, '?category=wine');
    expect(wineBoardRes.json).toHaveLength(wineCount);
  });

  it('alcohol parent: rankableCount>0 (not 可点进) but its /rankings board is 400 (cohort guard)', async () => {
    // P3.5: the alcohol PARENT has rankable descendants (rankableCount>0) but is
    // NOT a single cohort → /rankings?category=alcohol is 400 (no board), so the
    // "count == board basis" consistency does NOT apply (it only binds rankable
    // nodes). This asserts the divergence: count>0 on the tree, 400 on /rankings.
    const listRankings = vi.fn(async (input: ListRankingsInput): Promise<RankingRow[]> => {
      // Defensive: the route must NOT reach here for alcohol (guard fires first).
      void input;
      return [];
    });
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
    expect(alcoholCount).toBeGreaterThan(0);
    const board = await getRankings(app, '?category=alcohol');
    expect(board.res.status).toBe(400);
    expect(board.json.error).toBe('invalid-request');
    // The cohort guard fired before the repo board query.
    expect(listRankings).not.toHaveBeenCalled();
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

// ─────────────────────────────────────────────────────────────────────────────
// POST /compute — stateless on-demand 比价 (tier3 deterministic, no AI, no write)
//
// The route maps a STRUCTURED ComputeRequest onto core's ParsedSpec, runs core
// `calculate` (the same per100ml/formula the board stores — byte-for-byte), then
// positions the user's value in the SAME cohort/rankable/per100ml population the
// /rankings query serves. These tests inject a FAKE Repository whose ALL write
// methods THROW (persistence regression guard: a 200 compute must never touch a
// write path) and whose `listRankings` serves a fixed ascending cohort board.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build an app for POST /compute. `cohort` is the fixed ascending-by-per100ml
 * board `listRankings` returns for any category (the route reads the whole
 * cohort to position). EVERY write method throws — a 200 compute that触发了 any
 * write fails loudly. `listRankings` is a spy so a test can assert it was (not)
 * called and with what input.
 */
function computeApp(cohort: RankingRow[]) {
  const listRankings = vi.fn(async (input: ListRankingsInput): Promise<RankingRow[]> => {
    return cohort.slice(input.offset, input.offset + input.limit);
  });
  const upsertRaw = vi.fn(async () => {
    throw new Error('compute is stateless: upsertRaw must not be called');
  });
  const saveParsed = vi.fn(async () => {
    throw new Error('compute is stateless: saveParsed must not be called');
  });
  const saveCorrection = vi.fn(async () => {
    throw new Error('compute is stateless: saveCorrection must not be called');
  });
  const reconcileCategory = vi.fn(async () => {
    throw new Error('compute is stateless: reconcileCategory must not be called');
  });
  const setRankable = vi.fn(async () => {
    throw new Error('compute is stateless: setRankable must not be called');
  });
  const repo = {
    upsertRaw,
    saveParsed,
    saveCorrection,
    reconcileCategory,
    setRankable,
    async getProduct() {
      return null;
    },
    listRankings,
  } as unknown as Repository;
  const app = createApp({
    makeLlm: () => throwingPort,
    governance: createNoopGovernance(),
    makeRepo: () => repo,
  });
  return { app, listRankings, upsertRaw, saveParsed, saveCorrection, reconcileCategory, setRankable };
}

/** POST /compute on an app, returning {res, json}. */
async function postCompute(app: ReturnType<typeof createApp>, body: unknown) {
  const res = await app.request('/compute', {
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

// A small soft-drink cohort (per_100ml axis), ascending by per100ml — mirrors
// what listRankings returns (closure + rankable=1 + per100ml NOT NULL).
const COHORT: RankingRow[] = [
  row({ id: 'p-1', per100ml: 0.4, storeSku: 'sku-1' }),
  row({ id: 'p-2', per100ml: 0.6, storeSku: 'sku-2' }),
  row({ id: 'p-3', per100ml: 1.0, storeSku: 'sku-3' }),
  row({ id: 'p-4', per100ml: 2.0, storeSku: 'sku-4' }),
  row({ id: 'p-5', per100ml: 5.0, storeSku: 'sku-5' }),
];

describe('POST /compute — sufficient input -> 200 + price + positioning', () => {
  it('totalAmount path: 200 with byte-exact per100ml/formula + rank/percentile/neighbors', async () => {
    const { app, saveParsed, upsertRaw } = computeApp(COHORT);
    // 1500ml @ 9 元 → per100ml = 0.6 (= cohort p-2). Cheaper rows: only p-1 (0.4).
    const { res, json } = await postCompute(app, {
      totalPrice: 9,
      totalAmount: { value: 1500, unit: 'ml' },
      category: 'soft-drink',
    });
    expect(res.status).toBe(200);
    // Byte-exact core output (same calculate the board stores).
    expect(json.per100ml).toBe(0.6);
    expect(json.per100g).toBeNull();
    expect(json.formula).toBe('9 / 1500 * 100');
    expect(json.axis).toBe('per_100ml');
    // rank = (# strictly cheaper) + 1 = 1 (only 0.4) + 1 = 2.
    expect(json.rank).toBe(2);
    expect(json.total).toBe(5);
    // percentile = strictly-pricier (1.0,2.0,5.0 → 3) / 5 * 100 = 60.
    expect(json.percentile).toBeCloseTo(60);
    // neighbors: up to 3 cheaper (just p-1) + up to 3 pricier-or-equal at/above
    // the slot (p-2 @0.6 [tie], p-3, p-4). Each is a board projection with rank.
    expect(json.neighbors.map((n: any) => n.storeSku)).toEqual([
      'sku-1',
      'sku-2',
      'sku-3',
      'sku-4',
    ]);
    expect(json.neighbors[0].rank).toBe(1);
    expect(json.neighbors[0]).not.toHaveProperty('id');
    // No write path was ever entered (stateless guard).
    expect(saveParsed).not.toHaveBeenCalled();
    expect(upsertRaw).not.toHaveBeenCalled();
  });

  it('unitSize+quantity path: 200 with the expanded formula verbatim from core', async () => {
    const { app } = computeApp(COHORT);
    // 330ml × 24 @ 40 → per100ml = 0.5050505... (cheaper than p-2 @0.6, pricier than p-1 @0.4).
    const { res, json } = await postCompute(app, {
      totalPrice: 40,
      unitSize: { value: 330, unit: 'ml' },
      quantity: 24,
      category: 'soft-drink',
    });
    expect(res.status).toBe(200);
    expect(json.per100ml).toBe(0.5050505050505051);
    expect(json.formula).toBe('40 / (330 * 24 * 1) * 100');
    expect(json.axis).toBe('per_100ml');
    // rank: strictly cheaper = p-1 (0.4) only → rank 2.
    expect(json.rank).toBe(2);
  });

  it('sets Cache-Control: no-store on the 200', async () => {
    const { app } = computeApp(COHORT);
    const { res } = await postCompute(app, {
      totalPrice: 9,
      totalAmount: { value: 1500, unit: 'ml' },
      category: 'soft-drink',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('reads positioning via listRankings with the validated category + offset 0', async () => {
    const { app, listRankings } = computeApp(COHORT);
    await postCompute(app, {
      totalPrice: 9,
      totalAmount: { value: 1500, unit: 'ml' },
      category: 'carbonated',
    });
    expect(listRankings).toHaveBeenCalled();
    const input = listRankings.mock.calls[0]![0];
    expect(input.category).toBe('carbonated');
    expect(input.offset).toBe(0);
    // q is NOT used for positioning (whole cohort).
    expect(input.q).toBeUndefined();
  });
});

describe('POST /compute — insufficient input -> 400 naming the missing class', () => {
  it('only totalPrice + category (no totalAmount, no unitSize+quantity) -> 400, repo not read', async () => {
    const { app, listRankings } = computeApp(COHORT);
    const { res, json } = await postCompute(app, { totalPrice: 9, category: 'soft-drink' });
    expect(res.status).toBe(400);
    expect(json.error).toBe('invalid-request');
    // Message names BOTH acceptable ways to complete the input set.
    expect(json.message).toContain('总量');
    expect(json.message).toContain('数量');
    // No silent per100ml=null 200, and positioning never ran.
    expect(json).not.toHaveProperty('per100ml');
    expect(listRankings).not.toHaveBeenCalled();
  });

  it('unitSize WITHOUT quantity -> 400 (incomplete unitSize path)', async () => {
    const { app } = computeApp(COHORT);
    const { res, json } = await postCompute(app, {
      totalPrice: 9,
      unitSize: { value: 330, unit: 'ml' },
      category: 'soft-drink',
    });
    expect(res.status).toBe(400);
    expect(json.error).toBe('invalid-request');
  });
});

describe('POST /compute — uncomputable (price 非正/无轴) -> 400 + core warning (never silent 200)', () => {
  it('totalPrice <= 0 -> 400 carrying core 价格无效 warning', async () => {
    const { app } = computeApp(COHORT);
    // The api-client schema rejects totalPrice<=0 at the boundary (positive()),
    // so this is a 400 invalid-request — never a silent 200 with nulls.
    const { res, json } = await postCompute(app, {
      totalPrice: 0,
      totalAmount: { value: 1500, unit: 'ml' },
      category: 'soft-drink',
    });
    expect(res.status).toBe(400);
    expect(json.error).toBe('invalid-request');
    expect(json).not.toHaveProperty('per100ml');
  });
});

describe('POST /compute — cross-axis / cross-cohort -> 400 不可比 (positioning forbidden)', () => {
  it('g input into a per_100ml cohort -> 400 naming the cohort 比价 axis, repo not read', async () => {
    const { app, listRankings } = computeApp(COHORT);
    // 500g @ 25 → core lands per100g; soft-drink cohort is per_100ml → mismatch.
    const { res, json } = await postCompute(app, {
      totalPrice: 25,
      totalAmount: { value: 500, unit: 'g' },
      category: 'soft-drink',
    });
    expect(res.status).toBe(400);
    expect(json.error).toBe('invalid-request');
    // Message points at the cohort's axis (per 100ml).
    expect(json.message).toContain('100ml');
    expect(listRankings).not.toHaveBeenCalled();
  });

  it('cross-cohort node (beverage root) -> 400, positioning never happens', async () => {
    const { app, listRankings } = computeApp(COHORT);
    const { res, json } = await postCompute(app, {
      totalPrice: 9,
      totalAmount: { value: 1500, unit: 'ml' },
      category: 'beverage',
    });
    expect(res.status).toBe(400);
    expect(json.error).toBe('invalid-request');
    expect(listRankings).not.toHaveBeenCalled();
  });

  it('cross-cohort node (alcohol parent) -> 400', async () => {
    const { app, listRankings } = computeApp(COHORT);
    const { res, json } = await postCompute(app, {
      totalPrice: 9,
      totalAmount: { value: 1500, unit: 'ml' },
      category: 'alcohol',
    });
    expect(res.status).toBe(400);
    expect(json.error).toBe('invalid-request');
    expect(listRankings).not.toHaveBeenCalled();
  });

  it('unknown/typo category (non-empty, not in CATEGORY_SLUGS) -> 400 未知品类 (distinct from cross-cohort), repo not read', async () => {
    const { app, listRankings } = computeApp(COHORT);
    const { res, json } = await postCompute(app, {
      totalPrice: 9,
      totalAmount: { value: 1500, unit: 'ml' },
      category: 'nonexistent',
    });
    expect(res.status).toBe(400);
    expect(json.error).toBe('invalid-request');
    // The distinct 未知品类 message (NOT the cross-cohort "跨多个比价口径") — this is
    // the guard F8 added; without it an unknown slug would resolve null and be
    // misdiagnosed as cross-cohort. Removing the gate must fail THIS test.
    expect(json.message).toBe('未知品类');
    expect(listRankings).not.toHaveBeenCalled();
  });
});

describe('POST /compute — empty cohort -> 200 + empty neighbors (never 404)', () => {
  it('no rankable rows -> 200, total=0, rank=1, percentile=0, neighbors=[]', async () => {
    const { app } = computeApp([]);
    const { res, json } = await postCompute(app, {
      totalPrice: 9,
      totalAmount: { value: 1500, unit: 'ml' },
      category: 'soft-drink',
    });
    expect(res.status).toBe(200);
    expect(json.total).toBe(0);
    expect(json.rank).toBe(1);
    expect(json.percentile).toBe(0);
    expect(json.neighbors).toEqual([]);
    // Still a valid computed price (positioning empty ≠ uncomputable).
    expect(json.per100ml).toBe(0.6);
    expect(json.formula).toBe('9 / 1500 * 100');
  });

  it('user value below the whole cohort -> rank 1, one-sided (only pricier) neighbors', async () => {
    const { app } = computeApp(COHORT);
    // 5000ml @ 9 → per100ml = 0.18, cheaper than every cohort row (min 0.4).
    const { res, json } = await postCompute(app, {
      totalPrice: 9,
      totalAmount: { value: 5000, unit: 'ml' },
      category: 'soft-drink',
    });
    expect(res.status).toBe(200);
    expect(json.rank).toBe(1);
    expect(json.total).toBe(5);
    expect(json.percentile).toBeCloseTo(100); // cheaper than all 5.
    // Only the pricier side (the 3 cheapest cohort rows) — no cheaper neighbors.
    expect(json.neighbors.map((n: any) => n.storeSku)).toEqual(['sku-1', 'sku-2', 'sku-3']);
  });
});

describe('POST /compute — invalid request body -> 400 invalid-request', () => {
  it.each([
    ['non-JSON body', '{not json'],
    ['missing category', { totalPrice: 9, totalAmount: { value: 1500, unit: 'ml' } }],
    ['empty category', { totalPrice: 9, totalAmount: { value: 1500, unit: 'ml' }, category: '' }],
    ['negative measurement', { totalPrice: 9, totalAmount: { value: -1, unit: 'ml' }, category: 'soft-drink' }],
    ['bad unit', { totalPrice: 9, totalAmount: { value: 1500, unit: 'oz' }, category: 'soft-drink' }],
    ['non-integer quantity', { totalPrice: 9, unitSize: { value: 330, unit: 'ml' }, quantity: 1.5, category: 'soft-drink' }],
  ])('%s -> 400, repo never read, no write', async (_name, body) => {
    const { app, listRankings, saveParsed } = computeApp(COHORT);
    const { res, json } = await postCompute(app, body);
    expect(res.status).toBe(400);
    expect(json.error).toBe('invalid-request');
    expect(listRankings).not.toHaveBeenCalled();
    expect(saveParsed).not.toHaveBeenCalled();
  });
});
