// Real-workerd verification of the D1 platform semantics the repository relies
// on: batch() is atomic (a failing statement rolls back the whole group),
// explicit BEGIN is rejected (so drizzle's transaction() path is unusable and
// batch() is the correct choice), and foreign keys are enforced.
//
// All D1 operations run inside the Worker script, where the binding is native
// to workerd. The test side only calls dispatchFetch() and reads JSON —
// miniflare's magic-proxy APIs (getD1Database/getBindings) hang the Node event
// loop in this environment and must not be used.
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

interface WorkerResult {
  batchThrew: boolean;
  parentCount: number;
  uniqueIdxBatchThrew: boolean;
  uniqueRowCount: number;
  okBatchSuccess: boolean;
  parentAfterOk: number;
  childAfterOk: number;
  beginThrew: boolean;
  fkThrew: boolean;
}

const script = `
export default {
  async fetch(request, env) {
    const out = {};
    await env.DB.prepare('CREATE TABLE parent (id TEXT PRIMARY KEY)').run();
    await env.DB.prepare('CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id))').run();
    // 1) batch atomicity: second statement violates child PK, first must roll back
    await env.DB.prepare("INSERT INTO parent (id) VALUES ('p1')").run();
    await env.DB.prepare("INSERT INTO child (id, parent_id) VALUES ('c1','p1')").run();
    try {
      await env.DB.batch([
        env.DB.prepare("INSERT INTO parent (id) VALUES ('p2')"),
        env.DB.prepare("INSERT INTO child (id, parent_id) VALUES ('c1','p2')"), // PK conflict
      ]);
      out.batchThrew = false;
    } catch (e) { out.batchThrew = true; }
    out.parentCount = (await env.DB.prepare('SELECT count(*) AS c FROM parent').first()).c;
    // 1b) batch atomicity via a SECONDARY UNIQUE INDEX conflict (the exact
    // mechanism the dedupe D1 path relies on: a bare insert hitting
    // product_dedupe_key_unique inside batch() must throw + roll the group back)
    await env.DB.prepare('CREATE TABLE u (id TEXT PRIMARY KEY, k TEXT NOT NULL)').run();
    await env.DB.prepare('CREATE UNIQUE INDEX u_k_unique ON u (k)').run();
    await env.DB.prepare("INSERT INTO u (id, k) VALUES ('u1','dup')").run();
    try {
      await env.DB.batch([
        env.DB.prepare("INSERT INTO u (id, k) VALUES ('u2','fresh')"),
        env.DB.prepare("INSERT INTO u (id, k) VALUES ('u3','dup')"), // secondary UNIQUE INDEX conflict
      ]);
      out.uniqueIdxBatchThrew = false;
    } catch (e) { out.uniqueIdxBatchThrew = true; }
    out.uniqueRowCount = (await env.DB.prepare('SELECT count(*) AS c FROM u').first()).c;
    // 2) successful batch: two bind-parameterized INSERTs (same shape drizzle
    // dispatches), the whole group commits
    const okBatch = await env.DB.batch([
      env.DB.prepare('INSERT INTO parent (id) VALUES (?)').bind('p-ok'),
      env.DB.prepare('INSERT INTO child (id, parent_id) VALUES (?, ?)').bind('c-ok', 'p-ok'),
    ]);
    out.okBatchSuccess = okBatch.every((r) => r.success === true);
    out.parentAfterOk = (await env.DB.prepare('SELECT count(*) AS c FROM parent').first()).c;
    out.childAfterOk = (await env.DB.prepare('SELECT count(*) AS c FROM child').first()).c;
    // 3) explicit BEGIN is rejected
    try { await env.DB.prepare('BEGIN').run(); out.beginThrew = false; }
    catch (e) { out.beginThrew = true; }
    // 4) foreign keys are enforced
    try {
      await env.DB.prepare("INSERT INTO child (id, parent_id) VALUES ('c9','no-such')").run();
      out.fkThrew = false;
    } catch (e) { out.fkThrew = true; }
    return Response.json(out);
  }
}
`;

describe('D1 platform semantics (real workerd)', () => {
  let mf: Miniflare;
  let out: WorkerResult;

  beforeAll(async () => {
    mf = new Miniflare({ modules: true, script, d1Databases: { DB: 'test-db' } });
    const res = await mf.dispatchFetch('http://localhost/');
    out = (await res.json()) as WorkerResult;
  }, 30_000);

  afterAll(async () => {
    await mf?.dispose();
  }, 30_000);

  it('batch() throws when one statement fails', () => {
    expect(out.batchThrew).toBe(true);
  });

  it('the failed batch rolled back its earlier statement (only p1 remains)', () => {
    expect(out.parentCount).toBe(1);
  });

  it('the failed batch (secondary unique-index conflict) rolled back the whole group', () => {
    expect(out.uniqueIdxBatchThrew).toBe(true);
    expect(out.uniqueRowCount).toBe(1); // only u1; u2 rolled back with u3
  });

  it('a successful batch of bind-parameterized statements commits as a group', () => {
    expect(out.okBatchSuccess).toBe(true);
    expect(out.parentAfterOk).toBe(2); // p1 + p-ok
    expect(out.childAfterOk).toBe(2); // c1 + c-ok
  });

  it('explicit BEGIN is rejected', () => {
    expect(out.beginThrew).toBe(true);
  });

  it('foreign keys are enforced', () => {
    expect(out.fkThrew).toBe(true);
  });
});
