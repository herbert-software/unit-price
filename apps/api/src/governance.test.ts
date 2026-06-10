import { describe, expect, it, vi } from 'vitest';
import type { KVNamespace } from '@cloudflare/workers-types';
import { createApp } from './routes.js';
import {
  createRealGovernance,
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_SECONDS,
} from './governance.js';
import type { Bindings } from './bindings.js';
import type { ParseResult, SpecParserLLM } from './llm.js';

// A clean-title port that must never be reached for the governance assertions
// (governance short-circuits or the title is tier1-sufficient).
const cleanPort: SpecParserLLM = {
  async parse(): Promise<ParseResult> {
    throw new Error('LLM must not be called for tier1-sufficient inputs');
  },
};

/**
 * Map-backed fake KVNamespace. Implements get/put/delete with TTL semantics
 * (entries past `expiresAt` are treated as absent). We do NOT use miniflare's
 * magic-proxy KV — it hangs the Node event loop in this environment.
 */
interface FakeKVOptions {
  /** Force get/put to throw (simulates a KV outage). */
  failGet?: boolean;
  failPut?: boolean;
  /** Override the clock (seconds since epoch) for window-expiry tests. */
  now?: () => number;
}

function makeFakeKV(opts: FakeKVOptions = {}) {
  const store = new Map<string, { value: string; expiresAt: number | null }>();
  const nowMs = () => (opts.now ? opts.now() * 1000 : Date.now());

  const put = vi.fn(
    async (key: string, value: string, options?: { expirationTtl?: number }) => {
      if (opts.failPut) throw new Error('KV put failure (simulated)');
      const expiresAt =
        options?.expirationTtl !== undefined ? nowMs() + options.expirationTtl * 1000 : null;
      store.set(key, { value, expiresAt });
    },
  );

  const get = vi.fn(async (key: string) => {
    if (opts.failGet) throw new Error('KV get failure (simulated)');
    const entry = store.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt !== null && nowMs() >= entry.expiresAt) {
      store.delete(key);
      return null;
    }
    return entry.value;
  });

  const del = vi.fn(async (key: string) => {
    store.delete(key);
  });

  // Only get/put/delete are exercised; cast to the full KV type for the env.
  const kv = { get, put, delete: del } as unknown as KVNamespace;
  return { kv, get, put, del, store };
}

/** Build an app with real governance and a clean (never-called) LLM port. */
function appWith(env: Bindings) {
  const app = createApp({ makeLlm: () => cleanPort, governance: createRealGovernance() });
  const request = (path: string, init: RequestInit) => app.request(path, init, env);
  return { app, request };
}

const VALID_KEY = 'key-alpha';
const cleanBody = JSON.stringify({ title: '可口可乐 330ml*24听', price: 40 });

function bearer(key: string): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: cleanBody,
  };
}

describe('governance — authentication', () => {
  it('missing key -> 401 auth-missing, business never reached', async () => {
    const { kv } = makeFakeKV();
    const { request } = appWith({ API_KEYS: VALID_KEY, GOVERNANCE_KV: kv });
    const res = await request('/parse', { method: 'POST', headers: { 'content-type': 'application/json' }, body: cleanBody });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('auth-missing');
  });

  it('malformed key (empty Bearer) -> 401 auth-malformed', async () => {
    const { kv } = makeFakeKV();
    const { request } = appWith({ API_KEYS: VALID_KEY, GOVERNANCE_KV: kv });
    const res = await request('/parse', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' },
      body: cleanBody,
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('auth-malformed');
  });

  it('non-Bearer Authorization (Basic …) -> 401 auth-malformed (no fallback to X-API-Key)', async () => {
    const { kv } = makeFakeKV();
    const { request } = appWith({ API_KEYS: VALID_KEY, GOVERNANCE_KV: kv });
    const res = await request('/parse', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Basic dXNlcjpwYXNz',
        'x-api-key': VALID_KEY, // present but must be IGNORED (strict precedence)
      },
      body: cleanBody,
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('auth-malformed');
  });

  it('empty X-API-Key -> 401 auth-malformed', async () => {
    const { kv } = makeFakeKV();
    const { request } = appWith({ API_KEYS: VALID_KEY, GOVERNANCE_KV: kv });
    const res = await request('/parse', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': '' },
      body: cleanBody,
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('auth-malformed');
  });

  it('unregistered key -> 403 auth-forbidden', async () => {
    const { kv } = makeFakeKV();
    const { request } = appWith({ API_KEYS: VALID_KEY, GOVERNANCE_KV: kv });
    const res = await request('/parse', bearer('key-not-registered'));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('auth-forbidden');
  });

  it('valid key -> admitted, /parse responds with its normal contract (200)', async () => {
    const { kv } = makeFakeKV();
    const { request } = appWith({ API_KEYS: VALID_KEY, GOVERNANCE_KV: kv });
    const res = await request('/parse', bearer(VALID_KEY));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.unitPrice.per100ml).toBeCloseTo(0.505, 3);
  });

  it('X-API-Key carries a valid key when no Authorization header -> admitted', async () => {
    const { kv } = makeFakeKV();
    const { request } = appWith({ API_KEYS: VALID_KEY, GOVERNANCE_KV: kv });
    const res = await request('/parse', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': VALID_KEY },
      body: cleanBody,
    });
    expect(res.status).toBe(200);
  });
});

describe('governance — /health exemption', () => {
  it('GET /health -> 200 keyless, governance never engaged (no KV access)', async () => {
    const { kv, get, put } = makeFakeKV();
    const { request } = appWith({ API_KEYS: VALID_KEY, GOVERNANCE_KV: kv });
    const res = await request('/health', { method: 'GET' });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    // No auth, no rate-limit, no usage on /health.
    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });
});

describe('governance — API_KEYS config validation', () => {
  it('missing API_KEYS -> 500 config-error even with a key present (not 403)', async () => {
    const { kv } = makeFakeKV();
    const { request } = appWith({ GOVERNANCE_KV: kv }); // no API_KEYS
    const res = await request('/parse', bearer(VALID_KEY));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('config-error');
  });

  it('empty API_KEYS -> 500 config-error', async () => {
    const { kv } = makeFakeKV();
    const { request } = appWith({ API_KEYS: '   ', GOVERNANCE_KV: kv });
    const res = await request('/parse', bearer(VALID_KEY));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('config-error');
  });
});

describe('governance — rate limiting', () => {
  it('over-limit -> 429 rate-limited + Retry-After, business not reached', async () => {
    const fixedNow = 1_000_000; // seconds; window-aligned arithmetic is exercised below
    const { kv } = makeFakeKV({ now: () => fixedNow });
    // Pre-seed the current window counter at the limit.
    const windowStart = fixedNow - (fixedNow % RATE_LIMIT_WINDOW_SECONDS);
    await kv.put(`rl:${VALID_KEY}:${windowStart}`, String(RATE_LIMIT_MAX), {
      expirationTtl: RATE_LIMIT_WINDOW_SECONDS,
    });

    // Re-point Date.now so the middleware computes the same window.
    const spy = vi.spyOn(Date, 'now').mockReturnValue(fixedNow * 1000);
    try {
      const { request } = appWith({ API_KEYS: VALID_KEY, GOVERNANCE_KV: kv });
      const res = await request('/parse', bearer(VALID_KEY));
      expect(res.status).toBe(429);
      expect((await res.json()).error).toBe('rate-limited');
      const retryAfter = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(RATE_LIMIT_WINDOW_SECONDS);
    } finally {
      spy.mockRestore();
    }
  });

  it('isolates by key: A over-limit, B admitted', async () => {
    const fixedNow = 2_000_000;
    const { kv } = makeFakeKV();
    const windowStart = fixedNow - (fixedNow % RATE_LIMIT_WINDOW_SECONDS);
    const spy = vi.spyOn(Date, 'now').mockReturnValue(fixedNow * 1000);
    try {
      await kv.put(`rl:keyA:${windowStart}`, String(RATE_LIMIT_MAX), {
        expirationTtl: RATE_LIMIT_WINDOW_SECONDS,
      });
      const { request } = appWith({ API_KEYS: 'keyA,keyB', GOVERNANCE_KV: kv });
      const resA = await request('/parse', bearer('keyA'));
      const resB = await request('/parse', bearer('keyB'));
      expect(resA.status).toBe(429);
      expect(resB.status).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });

  it('window expiry: a fresh window admits again', async () => {
    // First window saturated; advancing past the window TTL clears the counter.
    const t0 = 3_000_000;
    let clock = t0;
    const { kv } = makeFakeKV({ now: () => clock });
    const windowStart = t0 - (t0 % RATE_LIMIT_WINDOW_SECONDS);
    await kv.put(`rl:${VALID_KEY}:${windowStart}`, String(RATE_LIMIT_MAX), {
      expirationTtl: RATE_LIMIT_WINDOW_SECONDS,
    });

    const spy = vi.spyOn(Date, 'now').mockImplementation(() => clock * 1000);
    try {
      const { request } = appWith({ API_KEYS: VALID_KEY, GOVERNANCE_KV: kv });
      const over = await request('/parse', bearer(VALID_KEY));
      expect(over.status).toBe(429);

      // Advance into the next window: the old `rl:` key has a different
      // windowStart, so the counter is effectively reset.
      clock = t0 + RATE_LIMIT_WINDOW_SECONDS + 1;
      const recovered = await request('/parse', bearer(VALID_KEY));
      expect(recovered.status).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });

  it('KV failure -> fail-open (admit), never 429/5xx', async () => {
    const { kv } = makeFakeKV({ failGet: true, failPut: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { request } = appWith({ API_KEYS: VALID_KEY, GOVERNANCE_KV: kv });
      const res = await request('/parse', bearer(VALID_KEY));
      expect(res.status).toBe(200); // admitted despite KV outage
    } finally {
      warn.mockRestore();
    }
  });
});

describe('governance — usage counting', () => {
  it('admitting once writes a usage record containing key/count/time, NOT title/price', async () => {
    const { kv, put } = makeFakeKV();
    const { request } = appWith({ API_KEYS: VALID_KEY, GOVERNANCE_KV: kv });
    const res = await request('/parse', bearer(VALID_KEY));
    expect(res.status).toBe(200);

    const usageCalls = put.mock.calls.filter(([k]) => String(k).startsWith('usage:'));
    expect(usageCalls.length).toBeGreaterThanOrEqual(1);
    const [usageKey, usageValue] = usageCalls[0];
    expect(usageKey).toBe(`usage:${VALID_KEY}`);
    const payload = JSON.parse(String(usageValue));
    expect(payload.key).toBe(VALID_KEY);
    expect(typeof payload.count).toBe('number');
    expect(payload.lastSeen).toBeDefined();
    // MUST NOT leak business data into the governance face.
    expect(String(usageValue)).not.toContain('可口可乐');
    expect(String(usageValue)).not.toMatch(/price|"40"|title/i);
  });

  it('usage count is monotonic across admissions (reads prior count from JSON)', async () => {
    // Round-trips the stored JSON payload: a second admission must read the
    // prior count back and write count=2 — guards against parsing the whole
    // JSON string as an int (which yields NaN and pins the counter at 1).
    const { kv, put } = makeFakeKV();
    const { request } = appWith({ API_KEYS: VALID_KEY, GOVERNANCE_KV: kv });
    await request('/parse', bearer(VALID_KEY));
    await request('/parse', bearer(VALID_KEY));
    const usageWrites = put.mock.calls.filter(([k]) => String(k).startsWith('usage:'));
    const counts = usageWrites.map(([, v]) => JSON.parse(String(v)).count);
    expect(counts).toContain(1);
    expect(counts).toContain(2); // would be [1, 1] under the NaN bug
    expect(Math.max(...counts)).toBe(2);
  });

  it('usage write failure does NOT downgrade a 200 response', async () => {
    // Make ONLY the usage write fail: rate-limit get/put succeed, usage put throws.
    // Simplest: fail all puts but the rate-limit path is fail-open, so the
    // request is still admitted; assert the response stays 200.
    const { kv } = makeFakeKV({ failPut: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { request } = appWith({ API_KEYS: VALID_KEY, GOVERNANCE_KV: kv });
      const res = await request('/parse', bearer(VALID_KEY));
      expect(res.status).toBe(200);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('governance — middleware order (auth before rate/usage)', () => {
  it('unauthenticated request writes NO rl: counter', async () => {
    const { kv, get, put } = makeFakeKV();
    const { request } = appWith({ API_KEYS: VALID_KEY, GOVERNANCE_KV: kv });
    const res = await request('/parse', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: cleanBody,
    });
    expect(res.status).toBe(401);
    // Auth short-circuits before rate-limit/usage: no KV access at all.
    expect(get).not.toHaveBeenCalled();
    const rlPuts = put.mock.calls.filter(([k]) => String(k).startsWith('rl:'));
    expect(rlPuts).toHaveLength(0);
  });

  it('auth precedes config-error: missing OPENROUTER_API_KEY + missing client key -> 401 first', async () => {
    // Env has no OPENROUTER_API_KEY (would be a business config-error on a
    // dirty title) AND the client sends no API key. Auth fires first -> 401,
    // the parse-api config-error branch is never evaluated.
    const { kv } = makeFakeKV();
    const dirtyBody = JSON.stringify({ title: '农夫山泉', price: 5 });
    const { request } = appWith({ API_KEYS: VALID_KEY, GOVERNANCE_KV: kv });
    const res = await request('/parse', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: dirtyBody,
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('auth-missing');
  });
});
