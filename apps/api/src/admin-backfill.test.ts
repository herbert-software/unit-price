// Admin backfill route + cursor-chunking + write-set/projection/audit tests
// (group D, tasks 3.1–3.5). Mirrors two existing harnesses verbatim so the
// behavior under test is the REAL stack, not a mock:
//   - tagging.test.ts: openSeeded() (in-memory better-sqlite3 + migrations +
//     seedTaxonomy) and landProduct() (raw → product → unit_price via the real
//     repo). The DIRECT runBackfill / listProductsForBackfill tests drive these.
//   - governance.test.ts: the `app.request(path, init, env)` env-injection mode
//     and makeFakeKV() (whose `store` Map lets us assert NO public rl:/usage:
//     slot is written by an admin call). cleanPort is copied from there.
//
// The admin app is assembled with the REAL admin governance
// (createRealGovernance({ allowlistVar: 'ADMIN_API_KEYS' })) + a noop PUBLIC
// governance + the seeded repo/db, so admin auth, fail-closed config-error,
// permission separation (public key rejected on admin), limit gating, response
// projection (results[] dropped) and the keyed-hash audit line are all exercised
// end-to-end without touching any implementation file.
import Database from 'better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  calculate,
  parseTier1,
  type CalcResult,
  type ParsedSpec,
} from '@unit-price/core';
import {
  createDb,
  createRepository,
  seedTaxonomy,
  type Db,
  type Repository,
} from '@unit-price/db';
import type { KVNamespace } from '@cloudflare/workers-types';
import { createApp } from './routes.js';
import { createNoopGovernance, createRealGovernance } from './governance.js';
import {
  listProductsForBackfill,
  runBackfill,
  ADMIN_BACKFILL_MAX_LIMIT,
} from './tagging.js';
import type { Bindings } from './bindings.js';
import type { ParseResult, SpecParserLLM } from './llm.js';

const migrationsFolder = fileURLToPath(
  new URL('../../../packages/db/drizzle', import.meta.url),
);

// A clean-title port that must never be reached: the backfill/admin path never
// calls an LLM, and the public /parse cleanBody is tier1-sufficient. Copied from
// governance.test.ts so this file is self-contained.
const cleanPort: SpecParserLLM = {
  async parse(): Promise<ParseResult> {
    throw new Error('LLM must not be called for the admin/backfill path');
  },
};

interface SeededDb {
  handle: Database.Database;
  repo: Repository;
  db: Db;
}

/** Open an in-memory DB with migrations applied + taxonomy seeded. */
async function openSeeded(): Promise<SeededDb> {
  const handle = new Database(':memory:');
  handle.pragma('foreign_keys = ON');
  const db = createDb(handle);
  if (db.kind !== 'sqlite') throw new Error('expected a better-sqlite3 Db');
  migrate(db.orm, { migrationsFolder });
  await seedTaxonomy(db);
  return { handle, repo: createRepository(db), db };
}

/** Land one product (product_raw + product + unit_price) via the real repo. */
async function landProduct(
  repo: Repository,
  opts: { title: string; price: number; store: string; storeSku: string },
): Promise<string> {
  const rawId = await repo.upsertRaw({
    store: opts.store,
    storeSku: opts.storeSku,
    raw: { title: opts.title, price: opts.price },
  });
  const spec: ParsedSpec = parseTier1({ title: opts.title, price: opts.price }).spec;
  const calc: CalcResult = calculate(spec, opts.price);
  const { productId } = await repo.saveParsed({ rawId, spec, calc });
  return productId;
}

/**
 * Map-backed fake KVNamespace (copied from governance.test.ts). `store` is the
 * underlying Map so admin-call tests can assert NO public rl:/usage: slot was
 * written. No TTL/clock machinery is needed here — only get/put are exercised.
 */
function makeFakeKV() {
  const store = new Map<string, { value: string; expiresAt: number | null }>();
  const put = vi.fn(
    async (key: string, value: string, options?: { expirationTtl?: number }) => {
      const expiresAt =
        options?.expirationTtl !== undefined
          ? Date.now() + options.expirationTtl * 1000
          : null;
      store.set(key, { value, expiresAt });
    },
  );
  const get = vi.fn(async (key: string) => {
    const entry = store.get(key);
    return entry === undefined ? null : entry.value;
  });
  const del = vi.fn(async (key: string) => {
    store.delete(key);
  });
  const kv = { get, put, delete: del } as unknown as KVNamespace;
  return { kv, get, put, store };
}

/**
 * Build an admin-capable app over a seeded repo/db. Public governance is noop
 * (the public path is irrelevant to admin assertions); admin governance is the
 * REAL one reading ADMIN_API_KEYS. Returns the app + a request helper bound to
 * the given env.
 */
function adminAppOver(seeded: SeededDb) {
  const app = createApp({
    makeLlm: () => cleanPort,
    governance: createNoopGovernance(),
    makeRepo: () => seeded.repo,
    makeDb: () => seeded.db,
    adminGovernance: createRealGovernance({ allowlistVar: 'ADMIN_API_KEYS' }),
  });
  const request = (path: string, init: RequestInit, env: Bindings) =>
    app.request(path, init, env);
  return { app, request };
}

/** Standard admin env (admin key registered, distinct public key, audit salt). */
function adminEnv(over: Partial<Bindings> = {}): Bindings {
  return {
    ADMIN_API_KEYS: 'admin-key',
    API_KEYS: 'pub-key',
    AUDIT_LOG_HMAC_SECRET: 'salt',
    ...over,
  };
}

const POST: RequestInit = { method: 'POST' };
function bearerPost(key: string): RequestInit {
  return { method: 'POST', headers: { authorization: `Bearer ${key}` } };
}

// ── 3.1 admin authentication (admin app + env injection) ────────────────────
describe('admin/backfill — authentication tier (3.1)', () => {
  it('missing auth header → 401 auth-missing, repo not driven (landed product stays 待人工)', async () => {
    const seeded = await openSeeded();
    const id = await landProduct(seeded.repo, {
      title: '可口可乐无糖 330ml*24',
      price: 40,
      store: 'sam',
      storeSku: 'noauth',
    });
    const { request } = adminAppOver(seeded);
    const res = await request('/admin/backfill', POST, adminEnv());
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('auth-missing');
    // The gate short-circuits before runBackfill: the product is untagged.
    const attr = await seeded.repo.getProductAttribution(id);
    expect(attr?.state).toBe('manual');
    expect(attr?.categoryLeafSlug).toBeNull();
    expect(attr?.tags).toHaveLength(0);
  });

  it('malformed Authorization ("Bearer ") → 401 auth-malformed', async () => {
    const seeded = await openSeeded();
    const { request } = adminAppOver(seeded);
    const res = await request(
      '/admin/backfill',
      { method: 'POST', headers: { authorization: 'Bearer ' } },
      adminEnv(),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('auth-malformed');
  });

  it('valid-format key registered ONLY in public API_KEYS → 403 auth-forbidden (permission separation)', async () => {
    const seeded = await openSeeded();
    const { request } = adminAppOver(seeded);
    // pub-key is a real public key but is NOT in ADMIN_API_KEYS.
    const res = await request('/admin/backfill', bearerPost('pub-key'), adminEnv());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('auth-forbidden');
  });

  it('valid admin key → 200', async () => {
    const seeded = await openSeeded();
    const { request } = adminAppOver(seeded);
    const res = await request('/admin/backfill', bearerPost('admin-key'), adminEnv());
    expect(res.status).toBe(200);
  });

  it('ADMIN_API_KEYS unconfigured (only API_KEYS present) → 500 config-error, message hides secret names (fail-closed)', async () => {
    const seeded = await openSeeded();
    const { request } = adminAppOver(seeded);
    // env omits ADMIN_API_KEYS entirely; API_KEYS is present (must NOT leak in).
    const res = await request(
      '/admin/backfill',
      bearerPost('admin-key'),
      { API_KEYS: 'pub-key', AUDIT_LOG_HMAC_SECRET: 'salt' },
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('config-error');
    expect(body.message).not.toContain('API_KEYS');
    expect(body.message).not.toContain('ADMIN_API_KEYS');
  });

  it('ADMIN_API_KEYS empty string while API_KEYS non-empty → still 500 config-error (judged by admin source)', async () => {
    const seeded = await openSeeded();
    const { request } = adminAppOver(seeded);
    const res = await request('/admin/backfill', bearerPost('admin-key'), adminEnv({ ADMIN_API_KEYS: '' }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('config-error');
  });

  it('malformed header + unconfigured ADMIN_API_KEYS → 500 config-error (config-error precedes auth三态, not 401)', async () => {
    const seeded = await openSeeded();
    const { request } = adminAppOver(seeded);
    const res = await request(
      '/admin/backfill',
      { method: 'POST', headers: { authorization: 'Bearer ' } },
      { API_KEYS: 'pub-key', AUDIT_LOG_HMAC_SECRET: 'salt' }, // no ADMIN_API_KEYS
    );
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('config-error');
  });

  it('malformed Authorization + valid X-API-Key admin key → 401 (Authorization is authoritative, no fallback)', async () => {
    const seeded = await openSeeded();
    const { request } = adminAppOver(seeded);
    const res = await request(
      '/admin/backfill',
      { method: 'POST', headers: { authorization: 'Bearer ', 'x-api-key': 'admin-key' } },
      adminEnv(),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('auth-malformed');
  });
});

// ── 3.2 public regression + generalized config-error + admin writes no public KV
describe('admin/backfill — public isolation + generalized config-error (3.2)', () => {
  it('public /parse with empty API_KEYS → 500 config-error, body message does NOT name the secret (net-new generalization assertion)', async () => {
    const { kv } = makeFakeKV();
    // Real PUBLIC governance, empty API_KEYS → config-error on the public tier.
    const app = createApp({
      makeLlm: () => cleanPort,
      governance: createRealGovernance(), // defaults to API_KEYS source
    });
    const res = await app.request(
      '/parse',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer whatever' },
        body: JSON.stringify({ title: '可口可乐 330ml*24听', price: 40 }),
      },
      { API_KEYS: '', GOVERNANCE_KV: kv },
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('config-error');
    expect(body.message).not.toContain('API_KEYS');
  });

  it('one admitted admin call writes NO public rl:/usage: KV slot (admin tier never engages public limiter/usage)', async () => {
    const seeded = await openSeeded();
    await landProduct(seeded.repo, { title: '可口可乐 330ml*24听', price: 40, store: 'sam', storeSku: 'kv-x' });
    const { kv, store } = makeFakeKV();
    const { request } = adminAppOver(seeded);
    const res = await request('/admin/backfill', bearerPost('admin-key'), adminEnv({ GOVERNANCE_KV: kv }));
    expect(res.status).toBe(200);
    const keys = [...store.keys()];
    expect(keys.some((k) => k.startsWith('rl:'))).toBe(false);
    expect(keys.some((k) => k.startsWith('usage:'))).toBe(false);
  });
});

// ── 3.3 deterministic cursor chunking (direct runBackfill / listProductsForBackfill)
describe('runBackfill — deterministic cursor chunking (3.3)', () => {
  it('5 products, limit=2: chunks cover every id exactly once; nextCursor strictly increases', async () => {
    const { repo, db } = await openSeeded();
    const all = new Set<string>();
    for (let i = 0; i < 5; i++) {
      all.add(
        await landProduct(repo, {
          title: '可口可乐 330ml*24听',
          price: 40,
          store: 'sam',
          storeSku: `chunk-${i}`,
        }),
      );
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    let prevCursor: string | null = null;
    let guard = 0;
    for (;;) {
      if (guard++ > 20) throw new Error('cursor loop did not terminate');
      // Parallel read of the SAME chunk's ids (runBackfill processes exactly this
      // keyset slice; BackfillResult only gives counts + nextCursor).
      const chunkIds = (await listProductsForBackfill(db, { cursor, limit: 2 })).map(
        (p) => p.productId,
      );
      const res = await runBackfill(repo, db, { cursor, limit: 2 });
      for (const pid of chunkIds) seen.push(pid);
      if (res.nextCursor !== null) {
        if (prevCursor !== null) expect(res.nextCursor > prevCursor).toBe(true);
        prevCursor = res.nextCursor;
        cursor = res.nextCursor;
      } else break;
    }

    // No miss, no duplicate: the union of all chunk ids equals the full id set,
    // each appearing exactly once.
    expect(seen).toHaveLength(5);
    expect(new Set(seen)).toEqual(all);
  });

  it('4 products (integer multiple of limit=2): drives to null with a trailing empty (total=0) read', async () => {
    const { repo, db } = await openSeeded();
    for (let i = 0; i < 4; i++) {
      await landProduct(repo, {
        title: '可口可乐 330ml*24听',
        price: 40,
        store: 'sam',
        storeSku: `mult-${i}`,
      });
    }
    const totals: number[] = [];
    let cursor: string | undefined;
    let last = await runBackfill(repo, db, { cursor, limit: 2 });
    totals.push(last.total);
    let guard = 0;
    while (last.nextCursor !== null) {
      if (guard++ > 20) throw new Error('cursor loop did not terminate');
      cursor = last.nextCursor;
      last = await runBackfill(repo, db, { cursor, limit: 2 });
      totals.push(last.total);
    }
    // The final read is the empty one: total=0 AND nextCursor=null.
    expect(last.total).toBe(0);
    expect(last.nextCursor).toBeNull();
    expect(totals[totals.length - 1]).toBe(0);
  });

  it('concurrent insert bisection: a row inserted mid-sweep is included iff its id > current cursor (text order)', async () => {
    const { repo, db } = await openSeeded();
    for (let i = 0; i < 4; i++) {
      await landProduct(repo, {
        title: '可口可乐 330ml*24听',
        price: 40,
        store: 'sam',
        storeSku: `bisect-${i}`,
      });
    }
    // Drive one chunk to obtain a non-null cursor X.
    const first = await runBackfill(repo, db, { cursor: undefined, limit: 2 });
    const X = first.nextCursor;
    expect(X).not.toBeNull();
    // Insert a NEW product after the cursor was taken; its UUID Y may sort either
    // side of X — the deterministic keyset rule holds regardless of which side.
    const Y = await landProduct(repo, {
      title: '可口可乐 330ml*24听',
      price: 40,
      store: 'sam',
      storeSku: 'bisect-new',
    });
    const rest = (await listProductsForBackfill(db, { cursor: X!, limit: 100 })).map(
      (p) => p.productId,
    );
    expect(rest.includes(Y)).toBe(Y > X!);
  });

  it('no-arg runBackfill (library/full-scan contract) → nextCursor null, total == full stock', async () => {
    const { repo, db } = await openSeeded();
    for (let i = 0; i < 7; i++) {
      await landProduct(repo, {
        title: '可口可乐 330ml*24听',
        price: 40,
        store: 'sam',
        storeSku: `full-${i}`,
      });
    }
    const res = await runBackfill(repo, db);
    expect(res.nextCursor).toBeNull();
    expect(res.total).toBe(7);
  });
});

// ── 3.4 limit boundary (HTTP) ───────────────────────────────────────────────
describe('admin/backfill — limit boundary (3.4)', () => {
  it('limit=0 → 400, limit=-1 → 400, limit=1.5 → 400', async () => {
    const seeded = await openSeeded();
    const { request } = adminAppOver(seeded);
    for (const bad of ['0', '-1', '1.5']) {
      const res = await request(`/admin/backfill?limit=${bad}`, bearerPost('admin-key'), adminEnv());
      expect(res.status).toBe(400);
    }
  });

  it('limit=9999 (oversize) → 200 and is clamped to ADMIN_BACKFILL_MAX_LIMIT (one call processes ≤ MAX)', async () => {
    const seeded = await openSeeded();
    for (let i = 0; i < ADMIN_BACKFILL_MAX_LIMIT + 3; i++) {
      await landProduct(seeded.repo, {
        title: '可口可乐 330ml*24听',
        price: 40,
        store: 'sam',
        storeSku: `clamp-${i}`,
      });
    }
    const { request } = adminAppOver(seeded);
    const res = await request('/admin/backfill?limit=9999', bearerPost('admin-key'), adminEnv());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBeLessThanOrEqual(ADMIN_BACKFILL_MAX_LIMIT);
  });

  it('default limit (no query) → 200 and chunked (total ≤ MAX, not the full stock)', async () => {
    const seeded = await openSeeded();
    const n = ADMIN_BACKFILL_MAX_LIMIT + 3;
    for (let i = 0; i < n; i++) {
      await landProduct(seeded.repo, {
        title: '可口可乐 330ml*24听',
        price: 40,
        store: 'sam',
        storeSku: `default-${i}`,
      });
    }
    const { request } = adminAppOver(seeded);
    const res = await request('/admin/backfill', bearerPost('admin-key'), adminEnv());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBeLessThanOrEqual(ADMIN_BACKFILL_MAX_LIMIT);
    expect(body.total).toBeLessThan(n); // chunked, not a full single scan
  });

  it('single-chunk re-run is idempotent: same cursor/limit twice → identical counts, no duplicate tags', async () => {
    const seeded = await openSeeded();
    for (let i = 0; i < 2; i++) {
      await landProduct(seeded.repo, {
        title: '可口可乐 330ml*24听',
        price: 40,
        store: 'sam',
        storeSku: `idem-${i}`,
      });
    }
    const tagCount = () =>
      (seeded.handle.prepare('SELECT count(*) AS c FROM product_tag').get() as { c: number }).c;
    const { request } = adminAppOver(seeded);

    const r1 = await request('/admin/backfill?limit=5', bearerPost('admin-key'), adminEnv());
    const b1 = await r1.json();
    const afterFirst = tagCount();
    const r2 = await request('/admin/backfill?limit=5', bearerPost('admin-key'), adminEnv());
    const b2 = await r2.json();
    const afterSecond = tagCount();

    expect(b2.total).toBe(b1.total);
    expect(b2.classified).toBe(b1.classified);
    expect(b2.manual).toBe(b1.manual);
    expect(b2.rankable).toBe(b1.rankable);
    expect(afterSecond).toBe(afterFirst); // no duplicate edges
  });
});

// ── 3.5 write-set + response projection + audit ─────────────────────────────
describe('admin/backfill — write-set, response projection, audit (3.5)', () => {
  it('write-set keeps the attribute edge: backfill writes the carbonated leaf AND the sugar-free attribute', async () => {
    const { repo, db } = await openSeeded();
    const id = await landProduct(repo, {
      title: '可口可乐无糖 330ml*24',
      price: 40,
      store: 'sam',
      storeSku: 'ws-zero',
    });
    await runBackfill(repo, db);
    const attr = await repo.getProductAttribution(id);
    expect(attr?.categoryLeafSlug).toBe('carbonated');
    // The write-set is NOT narrowed to only the category leaf: the orthogonal
    // attribute edge is written too.
    expect(
      attr?.tags.some((t) => t.kind === 'attribute' && t.slug === 'sugar-free'),
    ).toBe(true);
  });

  it('response projection: body has counts + nextCursor but NOT results', async () => {
    const seeded = await openSeeded();
    await landProduct(seeded.repo, { title: '可口可乐 330ml*24听', price: 40, store: 'sam', storeSku: 'proj' });
    const { request } = adminAppOver(seeded);
    const res = await request('/admin/backfill?limit=5', bearerPost('admin-key'), adminEnv());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('total');
    expect(body).toHaveProperty('classified');
    expect(body).toHaveProperty('pending');
    expect(body).toHaveProperty('manual');
    expect(body).toHaveProperty('rankable');
    expect(body).toHaveProperty('nextCursor');
    expect(body).not.toHaveProperty('results');
  });

  it('audit: an admitted call logs "[admin/backfill]" with a hex keyHash that is NOT the cleartext key', async () => {
    const seeded = await openSeeded();
    await landProduct(seeded.repo, { title: '可口可乐 330ml*24听', price: 40, store: 'sam', storeSku: 'audit' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { request } = adminAppOver(seeded);
      const res = await request('/admin/backfill?limit=5', bearerPost('admin-key'), adminEnv());
      expect(res.status).toBe(200);
      const adminCalls = warn.mock.calls.filter(([tag]) => tag === '[admin/backfill]');
      expect(adminCalls.length).toBeGreaterThanOrEqual(1);
      const payload = adminCalls[0][1] as { keyHash: string };
      expect(payload.keyHash).toMatch(/^[0-9a-f]+$/);
      expect(payload.keyHash).not.toBe('admin-key');
    } finally {
      warn.mockRestore();
    }
  });

  it('audit fail-close: valid admin key but AUDIT_LOG_HMAC_SECRET unconfigured → 500 config-error, backfill not driven', async () => {
    const seeded = await openSeeded();
    const id = await landProduct(seeded.repo, {
      title: '可口可乐无糖 330ml*24',
      price: 40,
      store: 'sam',
      storeSku: 'audit-failclose',
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { request } = adminAppOver(seeded);
      // env omits AUDIT_LOG_HMAC_SECRET entirely; audit keying is required.
      const res = await request('/admin/backfill', bearerPost('admin-key'), {
        ADMIN_API_KEYS: 'admin-key',
      });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe('config-error');
      // The body must not leak the secret name.
      expect(body.message).not.toContain('AUDIT_LOG_HMAC_SECRET');
      expect(
        warn.mock.calls.some(
          ([msg]) =>
            typeof msg === 'string' &&
            msg.startsWith('[admin/backfill] AUDIT_LOG_HMAC_SECRET unconfigured'),
        ),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
    // Fail-close precedes runBackfill: the landed product stays untagged.
    const attr = await seeded.repo.getProductAttribution(id);
    expect(attr?.categoryLeafSlug).toBeNull();
    expect(attr?.tags).toHaveLength(0);
  });

  it('runBackfill throws (db.orm.select boom) → 500 persistence-error, diagnostic line logged', async () => {
    const seeded = await openSeeded();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const app = createApp({
        makeLlm: () => cleanPort,
        governance: createNoopGovernance(),
        makeRepo: () => seeded.repo,
        // db.orm.select throws → listProductsForBackfill inside runBackfill rejects.
        makeDb: () => ({ orm: { select: () => { throw new Error('boom'); } } } as unknown as Db),
        adminGovernance: createRealGovernance({ allowlistVar: 'ADMIN_API_KEYS' }),
      });
      const res = await app.request('/admin/backfill', bearerPost('admin-key'), adminEnv());
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe('persistence-error');
      expect(body.message).toBe('backfill failed');
      const failCalls = warn.mock.calls.filter(([tag]) => tag === '[admin/backfill] failed');
      expect(failCalls.length).toBeGreaterThanOrEqual(1);
      expect(failCalls[0][1]).toHaveProperty('keyHash');
    } finally {
      warn.mockRestore();
    }
  });
});
