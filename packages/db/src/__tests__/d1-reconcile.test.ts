// D1-branch dispatch verification for reconcileCategory. The repository's D1
// branch assembles the whole three-state write (delete-leaf → insert-leaf →
// insert-attrs → update) into ONE batch() (D1's only atomic-write API) — never
// an explicit transaction (D1 rejects BEGIN). This pins the dispatch contract:
// how many batches, the statement order inside the batch, and which statements
// are present/absent for each verdict shape.
//
// Like d1-dedupe.test.ts, the fake binding is backed by a real better-sqlite3
// handle (so the pre-flight reads — product existence, tag lookups, leaf set —
// see seeded rows) and its batch() runs the group in one sqlite transaction
// (atomic, like real D1, pinned against workerd in d1-workerd.test.ts). On top
// of that it records the SQL of each batched statement for the dispatch asserts.
import {
  calculate,
  ParsedSpecSchema,
  type CalcResult,
  type ParsedSpec,
} from '@unit-price/core';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, type D1BindingLike } from '../db.js';
import { createRepository, type Repository } from '../repository.js';
import { seedTaxonomy } from '../seed.js';
import { migrationsFolder } from './harness.js';

const spec: ParsedSpec = ParsedSpecSchema.parse({
  unitSize: { value: 330, unit: 'ml' },
  quantity: 24,
  multipliers: [1],
  totalAmount: { value: 7920, unit: 'ml' },
  packageUnit: '瓶',
  category: 'beverage',
  confidence: 0.9,
});
const calc: CalcResult = calculate(spec, 39.9);

/**
 * Stateful D1-shaped binding over a real better-sqlite3 handle. Implements the
 * binding contract drizzle's D1 driver invokes (prepare → bind → run/all/raw/
 * first; atomic batch) and records the SQL of each batched statement group so
 * the dispatch order/content can be asserted.
 */
function createSqliteBackedD1(handle: Database.Database): {
  binding: D1BindingLike;
  batches: string[][];
} {
  const batches: string[][] = [];

  function makeStatement(sql: string) {
    let params: unknown[] = [];
    const stmt = {
      bind(...p: unknown[]) {
        params = p;
        return stmt;
      },
      async run() {
        const info = handle.prepare(sql).run(...params);
        return { success: true, results: [], meta: { changes: info.changes } };
      },
      async all() {
        return { success: true, results: handle.prepare(sql).all(...params), meta: {} };
      },
      async raw() {
        return handle.prepare(sql).raw().all(...params);
      },
      async first() {
        return handle.prepare(sql).get(...params) ?? null;
      },
      get _sql() {
        return sql;
      },
      get _params() {
        return params;
      },
    };
    return stmt;
  }

  const binding: D1BindingLike = {
    prepare(query: string) {
      return makeStatement(query);
    },
    async batch(statements: unknown[]) {
      const stmts = statements as Array<{ _sql: string; _params: unknown[] }>;
      batches.push(stmts.map((s) => s._sql));
      const run = handle.transaction(() => {
        const results: unknown[] = [];
        for (const s of stmts) {
          handle.prepare(s._sql).run(...s._params);
          results.push({ success: true, results: [], meta: {} });
        }
        return results;
      });
      return run();
    },
  };
  return { binding, batches };
}

interface Fixture {
  handle: Database.Database;
  repo: Repository;
  batches: string[][];
  productId: string;
}

/** Seed taxonomy + one product on a D1-backed handle. */
async function openFixture(): Promise<Fixture> {
  const handle = new Database(':memory:');
  handle.pragma('foreign_keys = ON');
  migrate(drizzle(handle), { migrationsFolder });
  const { binding, batches } = createSqliteBackedD1(handle);
  const db = createDb(binding);
  if (db.kind !== 'd1') {
    throw new Error('expected the fake binding to be tagged as kind "d1"');
  }
  await seedTaxonomy(db);
  const repo = createRepository(db);
  const rawId = await repo.upsertRaw({
    store: 'sam',
    storeSku: 'sku-1',
    raw: { title: '可口可乐 无糖 330ml*24', price: 39.9 },
    capturedAt: 1_700_000_000_000,
  });
  const { productId } = await repo.saveParsed({ rawId, spec, calc });
  return { handle, repo, batches, productId };
}

describe('reconcileCategory D1 dispatch (sqlite-backed fake binding)', () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await openFixture();
    // saveParsed already used batch() once; isolate reconcile's batch.
    f.batches.length = 0;
  });

  it('verdict=leaf with attributes: one batch, order delete→insert-leaf→insert-attr→update', async () => {
    await f.repo.reconcileCategory({
      productId: f.productId,
      leafSlug: 'carbonated',
      leafSource: 'rule',
      pendingNodeSlug: null,
      attributeSlugs: ['sugar-free'],
      rankable: true,
    });
    expect(f.batches).toHaveLength(1);
    const stmts = f.batches[0]!;
    // delete-leaf (leaf set non-empty) → insert-leaf → insert-attr → update.
    expect(stmts).toHaveLength(4);
    expect(stmts[0]).toMatch(/^delete from "product_tag"/i);
    expect(stmts[1]).toMatch(/^insert into "product_tag"/i);
    expect(stmts[2]).toMatch(/^insert into "product_tag"/i);
    expect(stmts[3]).toMatch(/^update "product"/i);
    // No explicit transaction control was prepared.
    expect(stmts.some((s) => /^begin/i.test(s))).toBe(false);
  });

  it('leafSlug=null (待人工, no attrs): batch has delete + update only, no insert-leaf', async () => {
    await f.repo.reconcileCategory({
      productId: f.productId,
      leafSlug: null,
      leafSource: 'rule',
      pendingNodeSlug: null,
      attributeSlugs: [],
      rankable: false,
    });
    expect(f.batches).toHaveLength(1);
    const stmts = f.batches[0]!;
    // leaf set is non-empty (seed has leaves) → delete is present; but with no
    // leafSlug there is NO insert-leaf, and no attrs → only delete + update.
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toMatch(/^delete from "product_tag"/i);
    expect(stmts[1]).toMatch(/^update "product"/i);
    expect(stmts.some((s) => /^insert into "product_tag"/i.test(s))).toBe(false);
  });

  it('待细化 (pending, no leaf, no attrs): delete + update only', async () => {
    await f.repo.reconcileCategory({
      productId: f.productId,
      leafSlug: null,
      leafSource: 'rule',
      pendingNodeSlug: 'soft-drink',
      attributeSlugs: [],
      rankable: false,
    });
    expect(f.batches).toHaveLength(1);
    const stmts = f.batches[0]!;
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toMatch(/^delete from "product_tag"/i);
    expect(stmts[1]).toMatch(/^update "product"/i);
  });

  it('empty leaf set → no delete statement in the batch', async () => {
    // Make loadCategoryLeafTagIds() return ∅ by removing ALL category tags
    // (every tree has leaves, so the only empty-leaf state is "no categories").
    // Clear FK-referencing rows first (closure, store_category_map), then the
    // category tags. The product carries no category leaf, so no product_tag FK
    // is broken. With an empty leaf set the delete-leaf statement is omitted.
    f.handle.prepare('DELETE FROM category_closure').run();
    f.handle.prepare('DELETE FROM store_category_map').run();
    f.handle.prepare("DELETE FROM tag WHERE kind = 'category'").run();
    await f.repo.reconcileCategory({
      productId: f.productId,
      leafSlug: null,
      leafSource: 'rule',
      pendingNodeSlug: null,
      attributeSlugs: [],
      rankable: false,
    });
    expect(f.batches).toHaveLength(1);
    const stmts = f.batches[0]!;
    expect(stmts.some((s) => /^delete from "product_tag"/i.test(s))).toBe(false);
    // Only the final update remains (clears pending + writes rankable).
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toMatch(/^update "product"/i);
  });
});
