import { describe, expect, it } from 'vitest';
import type { RawProduct } from '@unit-price/core';
import { createApp } from './routes.js';
import { buildApp } from './index.js';
import { createNoopGovernance } from './governance.js';
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

  it('weight unitSize (2kg) with price>0 is determinate null and skips tier2', async () => {
    // tier1 extracts a non-volume unit (2kg). The LLM cannot make a weight a
    // volume, so this is a CERTAIN null -> 200; tier2 (a failing port) must not
    // be reached, and no "未经 LLM 复核" warning is attached.
    const { res, json } = await post(transportFailPort, { title: '鸡胸肉 2kg', price: 40 });
    expect(res.status).toBe(200);
    expect(json.unitPrice.per100ml).toBeNull();
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

  it('weight unitSize (2kg) is determined-uncomputable -> 200 + null, not 5xx', async () => {
    const { res, json } = await post(transportFailPort, { title: '大米 2kg', price: 30 });
    expect(res.status).toBe(200);
    expect(json.unitPrice.per100ml).toBeNull();
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
