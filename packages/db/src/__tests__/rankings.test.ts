// listRankings: read-only ranking projection over unit_price ⋈ product ⋈
// product_raw. Pure SQLite/in-memory. Covers ascending order, per100ml-NULL
// exclusion, same-value stability by unit_price.id, limit/offset slicing, an
// empty db, the v1 category no-op (no SQL push-down), verbatim stored values,
// the confidence-column provenance (unit_price.confidence, never
// product.confidence), and a query-plan assertion that the primary order +
// filter ride unit_price_per100ml_idx with no unit_price full scan.
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.js';
import {
  buildRankingsQuery,
  createRepository,
  type Repository,
} from '../repository.js';

const migrationsFolder = fileURLToPath(
  new URL('../../drizzle', import.meta.url),
);

interface RankingsTestDb {
  handle: Database.Database;
  db: Db;
  repo: Repository;
}

function openDb(): RankingsTestDb {
  const handle = new Database(':memory:');
  handle.pragma('foreign_keys = ON');
  const db = createDb(handle);
  if (db.kind !== 'sqlite') {
    throw new Error('test harness expected a better-sqlite3-backed Db');
  }
  migrate(db.orm, { migrationsFolder });
  return { handle, db, repo: createRepository(db) };
}

/**
 * Seed one full chain (product_raw → product → unit_price) directly via SQL so
 * each ranking row's columns are pinned independently — including the two
 * same-named `confidence` columns (product.confidence vs unit_price.confidence)
 * set to DIFFERENT values to prove the projection reads the authoritative one.
 */
function seedRow(
  handle: Database.Database,
  opts: {
    suffix: string;
    per100ml: number | null;
    formula: string | null;
    upConfidence: number;
    productConfidence: number;
    warnings: string; // JSON-text
    title?: string;
    priceCents?: number;
    store?: string;
    storeSku?: string;
    sourceUrl?: string | null;
    category?: string;
    per100g?: number | null;
  },
): void {
  const {
    suffix,
    per100ml,
    formula,
    upConfidence,
    productConfidence,
    warnings,
    title = `title-${suffix}`,
    priceCents = 3990,
    store = 'sam',
    storeSku = `sku-${suffix}`,
    sourceUrl = `https://x/${suffix}`,
    category = 'beverage',
    per100g = null,
  } = opts;
  handle
    .prepare(
      `INSERT INTO product_raw (id, store, store_sku, title, price, source_url, captured_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(`raw-${suffix}`, store, storeSku, title, priceCents, sourceUrl, 1000);
  handle
    .prepare(
      `INSERT INTO product (id, raw_id, multipliers, category, confidence, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(`prod-${suffix}`, `raw-${suffix}`, '[1]', category, productConfidence, `dk-${suffix}`);
  handle
    .prepare(
      `INSERT INTO unit_price (id, product_id, per100ml, per100g, formula, confidence, warnings)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(`up-${suffix}`, `prod-${suffix}`, per100ml, per100g, formula, upConfidence, warnings);
}

describe('listRankings', () => {
  let t: RankingsTestDb;
  beforeEach(() => {
    t = openDb();
  });

  it('returns rows ascending by per100ml and excludes per100ml = NULL', async () => {
    seedRow(t.handle, {
      suffix: 'mid',
      per100ml: 0.5,
      formula: 'f-mid',
      upConfidence: 0.95,
      productConfidence: 0.5,
      warnings: '[]',
    });
    seedRow(t.handle, {
      suffix: 'low',
      per100ml: 0.1,
      formula: 'f-low',
      upConfidence: 0.95,
      productConfidence: 0.5,
      warnings: '[]',
    });
    seedRow(t.handle, {
      suffix: 'high',
      per100ml: 0.9,
      formula: 'f-high',
      upConfidence: 0.95,
      productConfidence: 0.5,
      warnings: '[]',
    });
    // per100ml NULL (weight-axis per100g-only / definitely uncomputable) — excluded.
    seedRow(t.handle, {
      suffix: 'nullml',
      per100ml: null,
      per100g: 2.25,
      formula: 'f-weight',
      upConfidence: 0.95,
      productConfidence: 0.5,
      warnings: '[]',
    });

    const rows = await t.repo.listRankings({
      limit: 50,
      offset: 0,
      category: 'beverage',
    });
    expect(rows.map((r) => r.id)).toEqual(['up-low', 'up-mid', 'up-high']);
    expect(rows.map((r) => r.per100ml)).toEqual([0.1, 0.5, 0.9]);
    // The NULL-per100ml row never appears.
    expect(rows.some((r) => r.id === 'up-nullml')).toBe(false);
  });

  it('is stable by unit_price.id when per100ml ties', async () => {
    // Insert in id-descending order to prove the ORDER BY (not insertion order)
    // drives the tiebreak.
    for (const suffix of ['c', 'a', 'b', 'e', 'd']) {
      seedRow(t.handle, {
        suffix,
        per100ml: 0.4, // all tied
        formula: `f-${suffix}`,
        upConfidence: 0.95,
        productConfidence: 0.5,
        warnings: '[]',
      });
    }
    const rows = await t.repo.listRankings({
      limit: 50,
      offset: 0,
      category: 'beverage',
    });
    expect(rows.map((r) => r.id)).toEqual([
      'up-a',
      'up-b',
      'up-c',
      'up-d',
      'up-e',
    ]);
  });

  it('paginates same-value rows without overlap or gaps (stable across pages)', async () => {
    for (const suffix of ['a', 'b', 'c', 'd', 'e', 'f']) {
      seedRow(t.handle, {
        suffix,
        per100ml: 0.4, // all tied → tiebreak is the only ordering
        formula: `f-${suffix}`,
        upConfidence: 0.95,
        productConfidence: 0.5,
        warnings: '[]',
      });
    }
    const page1 = await t.repo.listRankings({
      limit: 3,
      offset: 0,
      category: 'beverage',
    });
    const page2 = await t.repo.listRankings({
      limit: 3,
      offset: 3,
      category: 'beverage',
    });
    expect(page1.map((r) => r.id)).toEqual(['up-a', 'up-b', 'up-c']);
    expect(page2.map((r) => r.id)).toEqual(['up-d', 'up-e', 'up-f']);
    // Union covers all six exactly once (no overlap, no gap).
    const all = [...page1, ...page2].map((r) => r.id);
    expect(new Set(all).size).toBe(6);
  });

  it('honors limit/offset slicing on the ascending order', async () => {
    for (let i = 0; i < 5; i++) {
      seedRow(t.handle, {
        suffix: `s${i}`,
        per100ml: i * 0.1, // 0, 0.1, 0.2, 0.3, 0.4
        formula: `f${i}`,
        upConfidence: 0.95,
        productConfidence: 0.5,
        warnings: '[]',
      });
    }
    const slice = await t.repo.listRankings({
      limit: 2,
      offset: 1,
      category: 'beverage',
    });
    expect(slice.map((r) => r.per100ml)).toEqual([0.1, 0.2]);
    expect(slice.map((r) => r.id)).toEqual(['up-s1', 'up-s2']);
  });

  it('returns an empty array on an empty database', async () => {
    expect(
      await t.repo.listRankings({ limit: 50, offset: 0, category: 'beverage' }),
    ).toEqual([]);
  });

  it('returns an empty array when offset is past the end', async () => {
    seedRow(t.handle, {
      suffix: 'only',
      per100ml: 0.5,
      formula: 'f',
      upConfidence: 0.95,
      productConfidence: 0.5,
      warnings: '[]',
    });
    expect(
      await t.repo.listRankings({ limit: 50, offset: 10, category: 'beverage' }),
    ).toEqual([]);
  });

  it('does not push down category in v1 (passing category is a no-op)', async () => {
    // v1 intentionally ignores the `category` input (it is a v2-reserved
    // no-op): the WHERE filter is per100ml IS NOT NULL only, with no
    // product.category predicate. Seed two different categories and prove BOTH
    // rows come back regardless of the category passed — the result equals what
    // a category-less query returns.
    seedRow(t.handle, {
      suffix: 'bev',
      per100ml: 0.5,
      formula: 'f',
      upConfidence: 0.95,
      productConfidence: 0.5,
      warnings: '[]',
      category: 'beverage',
    });
    seedRow(t.handle, {
      suffix: 'food',
      per100ml: 0.3,
      formula: 'f',
      upConfidence: 0.95,
      productConfidence: 0.5,
      warnings: '[]',
      category: 'food',
    });
    // Passing category='beverage' must NOT exclude the 'food' row — v1 returns
    // every per100ml-non-null row in ascending order.
    const withCategory = await t.repo.listRankings({
      limit: 50,
      offset: 0,
      category: 'beverage',
    });
    expect(withCategory.map((r) => r.id)).toEqual(['up-food', 'up-bev']);
    // A different category value yields the identical result set (no-op).
    const otherCategory = await t.repo.listRankings({
      limit: 50,
      offset: 0,
      category: 'food',
    });
    expect(otherCategory.map((r) => r.id)).toEqual(
      withCategory.map((r) => r.id),
    );
  });

  it('returns per100ml/formula/warnings as stored values (no recompute)', async () => {
    seedRow(t.handle, {
      suffix: 'x',
      per100ml: 0.505,
      formula: '40 / (330 * 24 * 1) * 100',
      upConfidence: 0.95,
      productConfidence: 0.5,
      warnings: JSON.stringify(['single-unit-inferred']),
      priceCents: 4000,
    });
    const [row] = await t.repo.listRankings({
      limit: 50,
      offset: 0,
      category: 'beverage',
    });
    expect(row.per100ml).toBe(0.505);
    expect(row.formula).toBe('40 / (330 * 24 * 1) * 100');
    expect(row.warnings).toEqual(['single-unit-inferred']);
    // Stored verbatim — NOT recomputed from the integer-cents price.
    expect(row.priceCents).toBe(4000);
  });

  it('decodes warnings JSON-text to string[] (never the raw JSON string)', async () => {
    seedRow(t.handle, {
      suffix: 'w',
      per100ml: 0.5,
      formula: 'f',
      upConfidence: 0.95,
      productConfidence: 0.5,
      warnings: JSON.stringify(['a', 'b']),
    });
    const [row] = await t.repo.listRankings({
      limit: 50,
      offset: 0,
      category: 'beverage',
    });
    expect(Array.isArray(row.warnings)).toBe(true);
    expect(row.warnings).toEqual(['a', 'b']);
    expect(typeof row.warnings).not.toBe('string');
  });

  it('fail-closed on a corrupt warnings column (rejects, no partial result)', async () => {
    // A corrupt `unit_price.warnings` value is UNREACHABLE through the app write
    // path (encodeJson + the persistence CalcResultGate validate warnings as a
    // string[] before storing). This seeds the corruption DIRECTLY via the
    // low-level db handle (bypassing repository validation) to lock the
    // persistence-delta fail-closed contract: decodeJson/WarningsSchema must
    // throw so listRankings rejects — never emit the raw JSON string, never
    // silently drop the row and return a partial result.
    seedRow(t.handle, {
      suffix: 'corrupt',
      per100ml: 0.5, // non-null → would otherwise be in the board
      formula: 'f',
      upConfidence: 0.95,
      productConfidence: 0.5,
      warnings: '[1,2,3]', // valid JSON, but NOT string[] → WarningsSchema rejects
    });
    await expect(
      t.repo.listRankings({ limit: 50, offset: 0, category: 'beverage' }),
    ).rejects.toThrow();
  });

  it('reads confidence from unit_price.confidence, NOT product.confidence', async () => {
    // The two columns are deliberately different: authoritative band 0.95 on
    // unit_price, parse-time intermediate 0.5 on product.
    seedRow(t.handle, {
      suffix: 'conf',
      per100ml: 0.5,
      formula: 'f',
      upConfidence: 0.95,
      productConfidence: 0.5,
      warnings: '[]',
    });
    const [row] = await t.repo.listRankings({
      limit: 50,
      offset: 0,
      category: 'beverage',
    });
    expect(row.confidence).toBe(0.95); // unit_price.confidence
    expect(row.confidence).not.toBe(0.5); // never product.confidence
  });

  it('projects the denormalized product_raw display columns', async () => {
    seedRow(t.handle, {
      suffix: 'proj',
      per100ml: 0.5,
      formula: 'f',
      upConfidence: 0.95,
      productConfidence: 0.5,
      warnings: '[]',
      title: '椰子水 1L*6瓶',
      priceCents: 3990,
      store: 'sam',
      storeSku: 'sku-proj',
      sourceUrl: 'https://x/proj',
    });
    const [row] = await t.repo.listRankings({
      limit: 50,
      offset: 0,
      category: 'beverage',
    });
    expect(row).toMatchObject({
      id: 'up-proj',
      title: '椰子水 1L*6瓶',
      priceCents: 3990,
      store: 'sam',
      storeSku: 'sku-proj',
      sourceUrl: 'https://x/proj',
    });
  });

  it('projects a NULL source_url faithfully', async () => {
    seedRow(t.handle, {
      suffix: 'nullurl',
      per100ml: 0.5,
      formula: 'f',
      upConfidence: 0.95,
      productConfidence: 0.5,
      warnings: '[]',
      sourceUrl: null,
    });
    const [row] = await t.repo.listRankings({
      limit: 50,
      offset: 0,
      category: 'beverage',
    });
    expect(row.sourceUrl).toBeNull();
  });
});

/**
 * Query-plan assertion. v1 drops the `product.category` predicate (it is a
 * no-op since every row is "beverage", and including it makes the planner drive
 * from `product` with a full SCAN + TEMP B-TREE and abandon the per100ml
 * index). Without it, the planner drives from `unit_price` via
 * `unit_price_per100ml_idx`, which satisfies both the per100ml IS NOT NULL
 * filter and the primary ASC order. We assert exactly that on the SQL the
 * repository actually emits (obtained via drizzle `.toSQL()` — same shape as
 * production, no `INDEXED BY` hint). A populated table + ANALYZE is required so
 * the planner's cost model prefers the index over a small-table scan.
 *
 * The secondary key `unit_price.id` is not covered by the single-column index,
 * so a "USE TEMP B-TREE FOR LAST TERM OF ORDER BY" may appear — that is
 * accepted (design D2) and deliberately NOT asserted against. What we forbid is
 * a full SCAN of `unit_price`.
 */
describe('listRankings query plan', () => {
  it('drives from unit_price_per100ml_idx with no unit_price full scan', () => {
    const t = openDb();
    const insRaw = t.handle.prepare(
      `INSERT INTO product_raw (id, store, store_sku, title, price, captured_at) VALUES (?,?,?,?,?,?)`,
    );
    const insProd = t.handle.prepare(
      `INSERT INTO product (id, raw_id, multipliers, category, confidence, dedupe_key) VALUES (?,?,?,?,?,?)`,
    );
    const insUp = t.handle.prepare(
      `INSERT INTO unit_price (id, product_id, per100ml, per100g, formula, confidence, warnings) VALUES (?,?,?,?,?,?,?)`,
    );
    const tx = t.handle.transaction(() => {
      for (let i = 0; i < 300; i++) {
        insRaw.run(`r${i}`, 'sam', `sku${i}`, `t${i}`, 100 + i, 1000);
        insProd.run(`p${i}`, `r${i}`, '[1]', 'beverage', 0.5, `dk${i}`);
        insUp.run(
          `u${i}`,
          `p${i}`,
          i % 7 === 0 ? null : i * 0.01,
          null,
          'f',
          0.95,
          '[]',
        );
      }
    });
    tx();
    // ANALYZE so the planner's cost model has table stats and prefers the index.
    t.handle.exec('ANALYZE');

    // The EXACT v1 SQL the repository emits — obtained from the SAME shared
    // builder listRankings uses (`buildRankingsQuery` + `.toSQL()`), so the
    // EXPLAIN runs on the production query and can never drift from a hand-built
    // copy when listRankings' JOIN/WHERE/ORDER changes.
    const orm = drizzle(t.handle);
    const { sql: prodSql, params } = buildRankingsQuery(orm, {
      limit: 50,
      offset: 0,
      category: 'beverage',
    }).toSQL();

    const plan = t.handle
      .prepare('EXPLAIN QUERY PLAN ' + prodSql)
      .all(...params) as Array<{ detail: string }>;
    const details = plan.map((p) => p.detail);

    // Primary order + per100ml-non-null filter ride the per100ml index.
    expect(
      details.some((d) =>
        /SEARCH\b.*\bunit_price\b.*USING INDEX unit_price_per100ml_idx/.test(d),
      ),
    ).toBe(true);
    // No full table SCAN of unit_price (a SCAN would mean the index was
    // abandoned and rows would be sorted in a temp B-tree wholesale).
    expect(details.some((d) => /\bSCAN\b\s+unit_price\b/.test(d))).toBe(false);
    // Note: a TEMP B-TREE for the secondary key (up.id) is permitted (design
    // D2) and intentionally not asserted against here.
  });
});
