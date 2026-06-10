// Entry-level guardrail for the PRODUCTION Workers entry (`worker.ts`).
//
// Why this test exists: a pass-through no-op governance accidentally injected
// into the production entry would make the public API run wide open (no auth /
// no rate-limit), and BOTH /health and keyed/keyless /parse smokes would still
// pass — the regression would be invisible to ordinary smoke checks. So we drive
// the actual production entry (`worker.fetch(request, env, ctx)`) and assert the
// REAL governance is in force: missing key -> 401, allowlisted key -> admitted,
// over-limit -> 429. If someone swaps in the no-op, the 401/429 assertions fail.
//
// We use in-process `worker.fetch(req, env)` with a Map-backed fake KV (not
// miniflare's magic-proxy KV — it hangs the Node event loop here). In-process
// fetch reliably exercises "the worker entry wires real governance", which is
// the exact guardrail target.
import { describe, expect, it, vi } from 'vitest';
import type { KVNamespace } from '@cloudflare/workers-types';
import worker from './worker.js';
import { RATE_LIMIT_MAX } from './governance.js';
import type { Bindings } from './bindings.js';

/** Map-backed fake KVNamespace (get/put with TTL semantics). */
function makeFakeKV() {
  const store = new Map<string, { value: string; expiresAt: number | null }>();
  const put = vi.fn(async (key: string, value: string, options?: { expirationTtl?: number }) => {
    const expiresAt =
      options?.expirationTtl !== undefined ? Date.now() + options.expirationTtl * 1000 : null;
    store.set(key, { value, expiresAt });
  });
  const get = vi.fn(async (key: string) => {
    const entry = store.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt !== null && Date.now() >= entry.expiresAt) {
      store.delete(key);
      return null;
    }
    return entry.value;
  });
  const del = vi.fn(async (key: string) => {
    store.delete(key);
  });
  const kv = { get, put, delete: del } as unknown as KVNamespace;
  return { kv };
}

const VALID_KEY = 'key-alpha';
const cleanBody = JSON.stringify({ title: '可口可乐 330ml*24听', price: 40 });

// Minimal ExecutionContext stub (the entry passes ctx straight to Hono, which
// does not use it on this path).
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

function fetchParse(env: Bindings, init: RequestInit) {
  const req = new Request('http://worker.test/parse', init);
  return worker.fetch(req, env, ctx);
}

const contributeBody = JSON.stringify({
  title: '可口可乐 330ml*24听',
  price: 40,
  store: 'sam',
  storeSku: 'coke-24',
});

function fetchContribute(env: Bindings, init: RequestInit) {
  const req = new Request('http://worker.test/contribute', init);
  return worker.fetch(req, env, ctx);
}

describe('worker.ts production entry — real governance guardrail', () => {
  it('missing key -> 401 (real auth in force, not no-op)', async () => {
    const { kv } = makeFakeKV();
    const res = await fetchParse(
      { API_KEYS: VALID_KEY, GOVERNANCE_KV: kv },
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: cleanBody },
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('auth-missing');
  });

  it('allowlisted key -> admitted (not blocked by 401/429)', async () => {
    const { kv } = makeFakeKV();
    const res = await fetchParse(
      { API_KEYS: VALID_KEY, GOVERNANCE_KV: kv },
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${VALID_KEY}` },
        body: cleanBody,
      },
    );
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(429);
    // Clean title is tier1-sufficient -> 200 with a unit price.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.unitPrice).toBeDefined();
  });

  it('same key over the window limit -> 429 (real rate limiter in force)', async () => {
    const { kv } = makeFakeKV();
    const env: Bindings = { API_KEYS: VALID_KEY, GOVERNANCE_KV: kv };
    const init: RequestInit = {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${VALID_KEY}` },
      body: cleanBody,
    };

    // Exhaust the window: RATE_LIMIT_MAX admitted requests.
    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      const ok = await fetchParse(env, init);
      expect(ok.status).toBe(200);
    }
    // The next one is over the limit.
    const limited = await fetchParse(env, init);
    expect(limited.status).toBe(429);
    expect((await limited.json()).error).toBe('rate-limited');
    expect(limited.headers.get('Retry-After')).not.toBeNull();
  });

  it('/contribute is guarded by real governance: missing key -> 401 (not wide-open)', async () => {
    // The production entry must mount REAL governance on /contribute too. A
    // no-op accidentally injected here would run the write path wide open and a
    // keyless smoke would NOT 401 — this asserts the guardrail holds.
    const { kv } = makeFakeKV();
    const res = await fetchContribute(
      { API_KEYS: VALID_KEY, GOVERNANCE_KV: kv },
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: contributeBody },
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('auth-missing');
  });
});
