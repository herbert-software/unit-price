// listRankings: read-only NODE-SCOPED ranking projection over
// unit_price ⋈ product ⋈ product_raw ⋈ product_tag ⋈ category_closure. Pure
// SQLite/in-memory with the canonical taxonomy seeded. Covers ascending order,
// per100ml-NULL exclusion, the rankable=1 gate (rankable=false/待人工 excluded;
// P3.5: 酒种/乳品 叶 members ARE rankable + cohort-scoped, cross-cohort 酒类/root
// rejection is the API cohort guard, not the repo),
// closure scoping (carbonated leaf vs soft-drink parent vs alcohol vs root),
// double-leaf DISTINCT dedupe, same-value stability by unit_price.id,
// limit/offset slicing, an empty db, a legal-but-unseeded slug → [], verbatim
// stored values, the confidence-column provenance (unit_price.confidence, never
// product.confidence), and a node-path query-plan assertion (the EXPLAIN
// guardrail: category_closure + unit_price both SEARCH ... USING INDEX).
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.js';
import {
  buildRankableCountQuery,
  buildRankingsQuery,
  createRepository,
  escapeLikePattern,
  type Repository,
} from '../repository.js';
import { seedTaxonomy } from '../seed.js';

const migrationsFolder = fileURLToPath(
  new URL('../../drizzle', import.meta.url),
);

interface RankingsTestDb {
  handle: Database.Database;
  db: Db;
  repo: Repository;
}

async function openDb(): Promise<RankingsTestDb> {
  const handle = new Database(':memory:');
  handle.pragma('foreign_keys = ON');
  const db = createDb(handle);
  if (db.kind !== 'sqlite') {
    throw new Error('test harness expected a better-sqlite3-backed Db');
  }
  migrate(db.orm, { migrationsFolder });
  await seedTaxonomy(db);
  return { handle, db, repo: createRepository(db) };
}

/** Resolve a seeded tag's id by slug (for direct closure-edge inserts). */
function tagId(handle: Database.Database, slug: string): string {
  return (
    handle.prepare('SELECT id FROM tag WHERE slug = ?').get(slug) as {
      id: string;
    }
  ).id;
}

/**
 * Seed one full chain (product_raw → product → unit_price) directly via SQL so
 * each ranking row's columns are pinned independently — including the two
 * same-named `confidence` columns (product.confidence vs unit_price.confidence)
 * set to DIFFERENT values to prove the projection reads the authoritative one.
 * `leaf` attaches one category LEAF edge (the membership path); `rankable`
 * writes product.rankable. With no `leaf`, the product is 待人工 (no closure
 * membership) — it never appears in any node board.
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
    leaf?: string | null; // category leaf slug to attach (membership)
    rankable?: boolean;
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
    leaf = 'carbonated',
    rankable = true,
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
      `INSERT INTO product (id, raw_id, multipliers, category, confidence, dedupe_key, rankable)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `prod-${suffix}`,
      `raw-${suffix}`,
      '[1]',
      category,
      productConfidence,
      `dk-${suffix}`,
      rankable ? 1 : 0,
    );
  handle
    .prepare(
      `INSERT INTO unit_price (id, product_id, per100ml, per100g, formula, confidence, warnings)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(`up-${suffix}`, `prod-${suffix}`, per100ml, per100g, formula, upConfidence, warnings);
  if (leaf != null) {
    handle
      .prepare(
        `INSERT INTO product_tag (id, product_id, tag_id, source, confidence)
         VALUES (?, ?, ?, 'rule', 1)`,
      )
      .run(`pt-${suffix}`, `prod-${suffix}`, tagId(handle, leaf));
  }
}

describe('listRankings (node-scoped)', () => {
  let t: RankingsTestDb;
  beforeEach(async () => {
    t = await openDb();
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
    // per100ml NULL (weight-axis per100g-only / definitely uncomputable) — excluded
    // by the data gate even though it is rankable + a member.
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

  it('excludes rankable=false rows (the rankable gate, not a special-cased leaf)', async () => {
    // A rankable soft-drink and a rankable=false carbonated row that still has a
    // non-null per100ml (e.g. 待细化/manual-corrected to unrankable). The rankable
    // gate keeps only the rankable one — purely the product.rankable column, no
    // leaf-specific special case. (P3.5: 酒种 leaves are themselves rankable; the
    // cross-cohort exclusion of 酒类/root moves to the API cohort guard, not here.)
    seedRow(t.handle, {
      suffix: 'soda',
      per100ml: 0.3,
      formula: 'f',
      upConfidence: 0.95,
      productConfidence: 0.5,
      warnings: '[]',
      leaf: 'carbonated',
      rankable: true,
    });
    seedRow(t.handle, {
      suffix: 'ungated',
      per100ml: 0.2, // cheaper, yet excluded — product.rankable = 0
      formula: 'f',
      upConfidence: 0.95,
      productConfidence: 0.5,
      warnings: '[]',
      leaf: 'carbonated',
      rankable: false,
    });
    const board = await t.repo.listRankings({
      limit: 50,
      offset: 0,
      category: 'carbonated',
    });
    expect(board.map((r) => r.id)).toEqual(['up-soda']);
  });

  it('酒种 leaf members are rankable and cohort-scoped (P3.5: beer board only beer)', async () => {
    // P3.5: 酒种 leaves bind per_100ml → their members ARE rankable and appear in
    // their own cohort board. A beer and a wine: the beer board carries only the
    // beer (cohort scoping), and listRankings('alcohol') returns its closure +
    // rankable members (no longer empty — the cross-cohort REJECTION is the API's
    // cohort guard returning 400, not the repository returning []).
    seedRow(t.handle, {
      suffix: 'beer',
      per100ml: 0.5,
      formula: 'f',
      upConfidence: 0.95,
      productConfidence: 0.5,
      warnings: '[]',
      leaf: 'beer',
      rankable: true,
    });
    seedRow(t.handle, {
      suffix: 'wine',
      per100ml: 0.3,
      formula: 'f',
      upConfidence: 0.95,
      productConfidence: 0.5,
      warnings: '[]',
      leaf: 'wine',
      rankable: true,
    });
    // beer cohort board: only the beer (wine excluded — different 酒种 cohort).
    const beerBoard = await t.repo.listRankings({
      limit: 50,
      offset: 0,
      category: 'beer',
    });
    expect(beerBoard.map((r) => r.id)).toEqual(['up-beer']);
    // wine cohort board: only the wine.
    const wineBoard = await t.repo.listRankings({
      limit: 50,
      offset: 0,
      category: 'wine',
    });
    expect(wineBoard.map((r) => r.id)).toEqual(['up-wine']);
    // alcohol parent: closure + rankable returns BOTH (no longer empty). The API
    // cohort guard (not the repo) rejects this cross-cohort node with 400.
    const alcoholBoard = await t.repo.listRankings({
      limit: 50,
      offset: 0,
      category: 'alcohol',
    });
    expect(alcoholBoard.map((r) => r.id).sort()).toEqual(['up-beer', 'up-wine']);
  });

  it('乳品 leaf members are rankable and cohort-scoped (P3.5: milk board only milk)', async () => {
    seedRow(t.handle, {
      suffix: 'milk',
      per100ml: 1.2,
      formula: 'f',
      upConfidence: 0.95,
      productConfidence: 0.5,
      warnings: '[]',
      leaf: 'milk',
      rankable: true,
    });
    seedRow(t.handle, {
      suffix: 'soda',
      per100ml: 0.3,
      formula: 'f',
      upConfidence: 0.95,
      productConfidence: 0.5,
      warnings: '[]',
      leaf: 'carbonated',
      rankable: true,
    });
    // 乳品 board carries only the milk; the soft-drink is a different cohort.
    const dairyBoard = await t.repo.listRankings({
      limit: 50,
      offset: 0,
      category: 'dairy',
    });
    expect(dairyBoard.map((r) => r.id)).toEqual(['up-milk']);
    // milk leaf board: also just the milk.
    const milkBoard = await t.repo.listRankings({
      limit: 50,
      offset: 0,
      category: 'milk',
    });
    expect(milkBoard.map((r) => r.id)).toEqual(['up-milk']);
  });

  it('excludes 待人工 rows (no category leaf → not a member of any node)', async () => {
    // A rankable=true soft-drink with per100ml but NO category leaf is not a
    // member of any node (not even root) — the "无叶 → 非成员" mechanism.
    seedRow(t.handle, {
      suffix: 'member',
      per100ml: 0.4,
      formula: 'f',
      upConfidence: 0.95,
      productConfidence: 0.5,
      warnings: '[]',
      leaf: 'carbonated',
      rankable: true,
    });
    seedRow(t.handle, {
      suffix: 'manual',
      per100ml: 0.1, // cheaper, yet excluded — no leaf
      formula: 'f',
      upConfidence: 0.95,
      productConfidence: 0.5,
      warnings: '[]',
      leaf: null,
      rankable: true,
    });
    const root = await t.repo.listRankings({
      limit: 50,
      offset: 0,
      category: 'beverage',
    });
    expect(root.map((r) => r.id)).toEqual(['up-member']);
  });

  it('scopes a leaf node to only its own members', async () => {
    seedRow(t.handle, {
      suffix: 'carb',
      per100ml: 0.3,
      formula: 'f',
      upConfidence: 0.95,
      productConfidence: 0.5,
      warnings: '[]',
      leaf: 'carbonated',
    });
    seedRow(t.handle, {
      suffix: 'water',
      per100ml: 0.1,
      formula: 'f',
      upConfidence: 0.95,
      productConfidence: 0.5,
      warnings: '[]',
      leaf: 'drinking-water',
    });
    const carbonated = await t.repo.listRankings({
      limit: 50,
      offset: 0,
      category: 'carbonated',
    });
    // Only the carbonated member; the drinking-water member is excluded.
    expect(carbonated.map((r) => r.id)).toEqual(['up-carb']);
  });

  it('a parent node includes its sub-leaf members via the closure', async () => {
    seedRow(t.handle, {
      suffix: 'carb',
      per100ml: 0.3,
      formula: 'f',
      upConfidence: 0.95,
      productConfidence: 0.5,
      warnings: '[]',
      leaf: 'carbonated',
    });
    seedRow(t.handle, {
      suffix: 'water',
      per100ml: 0.1,
      formula: 'f',
      upConfidence: 0.95,
      productConfidence: 0.5,
      warnings: '[]',
      leaf: 'drinking-water',
    });
    seedRow(t.handle, {
      suffix: 'juice',
      per100ml: 0.2,
      formula: 'f',
      upConfidence: 0.95,
      productConfidence: 0.5,
      warnings: '[]',
      leaf: 'juice-plant',
    });
    // soft-drink parent: closure pulls all three sub-leaf members, mixed ASC.
    const softDrink = await t.repo.listRankings({
      limit: 50,
      offset: 0,
      category: 'soft-drink',
    });
    expect(softDrink.map((r) => r.id)).toEqual(['up-water', 'up-juice', 'up-carb']);
  });

  it('a violated single-attribution (one product, two leaves under the node) lists it at most once', async () => {
    // Defensive DISTINCT backstop: the invariant is app-layer, not a DB
    // constraint, so inject a second category leaf directly. Both leaves are
    // under soft-drink/root → the closure JOIN would otherwise emit the row
    // twice. SELECT DISTINCT unit_price.id must collapse it to one.
    seedRow(t.handle, {
      suffix: 'dup',
      per100ml: 0.3,
      formula: 'f',
      upConfidence: 0.95,
      productConfidence: 0.5,
      warnings: '[]',
      leaf: 'carbonated',
    });
    t.handle
      .prepare(
        `INSERT INTO product_tag (id, product_id, tag_id, source, confidence)
         VALUES ('pt-dup2', 'prod-dup', ?, 'rule', 1)`,
      )
      .run(tagId(t.handle, 'juice-plant'));
    for (const slug of ['beverage', 'soft-drink']) {
      const rows = await t.repo.listRankings({
        limit: 50,
        offset: 0,
        category: slug,
      });
      expect(rows.filter((r) => r.id === 'up-dup')).toHaveLength(1);
    }
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

  it('returns [] for a legal slug with no tag row (not an error)', async () => {
    // Drop the carbonated tag's closure rows AND the tag row to simulate the
    // migrate-before-seed window for one node. A query for it must return [] —
    // never throw. (Slug legality / 400 is the API layer's job.)
    seedRow(t.handle, {
      suffix: 'x',
      per100ml: 0.5,
      formula: 'f',
      upConfidence: 0.95,
      productConfidence: 0.5,
      warnings: '[]',
      leaf: 'carbonated',
    });
    // A slug that simply does not exist as a tag row → [].
    await expect(
      t.repo.listRankings({ limit: 50, offset: 0, category: 'no-such-node' }),
    ).resolves.toEqual([]);
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

  // --- q (title substring) push-down ------------------------------------

  it('q non-empty returns only title-substring matches, still per100ml ASC', async () => {
    // Three carbonated rows; only two carry the 「可乐」 substring. The matched
    // pair must come back per100ml ASC (the filter is orthogonal to ordering).
    seedRow(t.handle, {
      suffix: 'cola-cheap',
      per100ml: 0.2,
      formula: 'f',
      upConfidence: 0.95,
      productConfidence: 0.5,
      warnings: '[]',
      title: '可口可乐 330ml*24',
    });
    seedRow(t.handle, {
      suffix: 'sprite',
      per100ml: 0.1, // cheaper, but no 可乐 substring → excluded
      formula: 'f',
      upConfidence: 0.95,
      productConfidence: 0.5,
      warnings: '[]',
      title: '雪碧 330ml*24',
    });
    seedRow(t.handle, {
      suffix: 'cola-pricey',
      per100ml: 0.5,
      formula: 'f',
      upConfidence: 0.95,
      productConfidence: 0.5,
      warnings: '[]',
      title: '百事可乐 500ml*12',
    });
    const rows = await t.repo.listRankings({
      limit: 50,
      offset: 0,
      category: 'beverage',
      q: '可乐',
    });
    // Only the two 可乐 rows, ascending per100ml (cheap before pricey); 雪碧 gone.
    expect(rows.map((r) => r.id)).toEqual(['up-cola-cheap', 'up-cola-pricey']);
    expect(rows.map((r) => r.per100ml)).toEqual([0.2, 0.5]);
  });

  it('q paginates correctly across pages (hits split by limit/offset, no overlap)', async () => {
    // Four 可乐 matches at distinct per100ml + one non-match. Page the matches.
    seedRow(t.handle, {
      suffix: 'q1',
      per100ml: 0.1,
      formula: 'f',
      upConfidence: 0.95,
      productConfidence: 0.5,
      warnings: '[]',
      title: '可乐 A',
    });
    seedRow(t.handle, {
      suffix: 'q2',
      per100ml: 0.2,
      formula: 'f',
      upConfidence: 0.95,
      productConfidence: 0.5,
      warnings: '[]',
      title: '可乐 B',
    });
    seedRow(t.handle, {
      suffix: 'q3',
      per100ml: 0.3,
      formula: 'f',
      upConfidence: 0.95,
      productConfidence: 0.5,
      warnings: '[]',
      title: '可乐 C',
    });
    seedRow(t.handle, {
      suffix: 'q4',
      per100ml: 0.4,
      formula: 'f',
      upConfidence: 0.95,
      productConfidence: 0.5,
      warnings: '[]',
      title: '可乐 D',
    });
    seedRow(t.handle, {
      suffix: 'nomatch',
      per100ml: 0.05, // cheapest of all, yet excluded — no 可乐 substring
      formula: 'f',
      upConfidence: 0.95,
      productConfidence: 0.5,
      warnings: '[]',
      title: '矿泉水 550ml',
    });
    const page1 = await t.repo.listRankings({
      limit: 2,
      offset: 0,
      category: 'beverage',
      q: '可乐',
    });
    const page2 = await t.repo.listRankings({
      limit: 2,
      offset: 2,
      category: 'beverage',
      q: '可乐',
    });
    expect(page1.map((r) => r.id)).toEqual(['up-q1', 'up-q2']);
    expect(page2.map((r) => r.id)).toEqual(['up-q3', 'up-q4']);
    // Union covers all four matches exactly once; the non-match never appears.
    const all = [...page1, ...page2].map((r) => r.id);
    expect(new Set(all).size).toBe(4);
    expect(all).not.toContain('up-nomatch');
  });

  it('q keeps the cohort guard — does not leak cross-cohort title matches', async () => {
    // A beer and a soft-drink, both titled 「可乐」. A 可乐 search scoped to the
    // soft-drink cohort must NOT pull the (cross-cohort) beer in via the title
    // filter — the closure/cohort guard is ANDed, never replaced.
    seedRow(t.handle, {
      suffix: 'softcola',
      per100ml: 0.3,
      formula: 'f',
      upConfidence: 0.95,
      productConfidence: 0.5,
      warnings: '[]',
      leaf: 'carbonated',
      title: '可乐味汽水 330ml',
    });
    seedRow(t.handle, {
      suffix: 'beercola',
      per100ml: 0.2, // cheaper, but a different cohort
      formula: 'f',
      upConfidence: 0.95,
      productConfidence: 0.5,
      warnings: '[]',
      leaf: 'beer',
      title: '可乐味啤酒 500ml',
    });
    const softDrink = await t.repo.listRankings({
      limit: 50,
      offset: 0,
      category: 'soft-drink',
      q: '可乐',
    });
    // Only the soft-drink 可乐 — the beer 可乐 is out of cohort.
    expect(softDrink.map((r) => r.id)).toEqual(['up-softcola']);
  });

  it('q keeps the rankable + per100ml guards (no q-bypass of either gate)', async () => {
    // Two 可乐 rows: one rankable with per100ml, one rankable=false (cheaper),
    // one rankable with NULL per100ml. The title filter must NOT resurrect the
    // gated-out rows.
    seedRow(t.handle, {
      suffix: 'ok',
      per100ml: 0.5,
      formula: 'f',
      upConfidence: 0.95,
      productConfidence: 0.5,
      warnings: '[]',
      title: '可乐 OK',
      rankable: true,
    });
    seedRow(t.handle, {
      suffix: 'notrankable',
      per100ml: 0.1, // cheaper, but rankable=0 → excluded
      formula: 'f',
      upConfidence: 0.95,
      productConfidence: 0.5,
      warnings: '[]',
      title: '可乐 不可排',
      rankable: false,
    });
    seedRow(t.handle, {
      suffix: 'nullml',
      per100ml: null, // per100ml NULL → excluded
      per100g: 1.0,
      formula: 'f-weight',
      upConfidence: 0.95,
      productConfidence: 0.5,
      warnings: '[]',
      title: '可乐 无单价',
      rankable: true,
    });
    const rows = await t.repo.listRankings({
      limit: 50,
      offset: 0,
      category: 'beverage',
      q: '可乐',
    });
    expect(rows.map((r) => r.id)).toEqual(['up-ok']);
  });

  it('q LIKE specials match literally (% / _ / escape char), not as wildcards', async () => {
    // Literal 「100%」 must match only the row containing the literal percent,
    // never every row (which a raw % wildcard would). Same shape proves _ and
    // the escape char are literal too.
    seedRow(t.handle, {
      suffix: 'pct',
      per100ml: 0.3,
      formula: 'f',
      upConfidence: 0.95,
      productConfidence: 0.5,
      warnings: '[]',
      title: '100%纯果汁 1L',
    });
    seedRow(t.handle, {
      suffix: 'other',
      per100ml: 0.1,
      formula: 'f',
      upConfidence: 0.95,
      productConfidence: 0.5,
      warnings: '[]',
      title: '某饮料 500ml',
    });
    const pct = await t.repo.listRankings({
      limit: 50,
      offset: 0,
      category: 'beverage',
      q: '100%',
    });
    // Literal %: only the 100% row, NOT the other row.
    expect(pct.map((r) => r.id)).toEqual(['up-pct']);

    // Underscore literal: a query 「0_纯」 must NOT match 「0X纯」-style single-char.
    seedRow(t.handle, {
      suffix: 'underscore',
      per100ml: 0.4,
      formula: 'f',
      upConfidence: 0.95,
      productConfidence: 0.5,
      warnings: '[]',
      title: 'a_b 饮料',
    });
    seedRow(t.handle, {
      suffix: 'underscore-decoy',
      per100ml: 0.05,
      formula: 'f',
      upConfidence: 0.95,
      productConfidence: 0.5,
      warnings: '[]',
      title: 'aXb 饮料', // would match if _ were a wildcard
    });
    const us = await t.repo.listRankings({
      limit: 50,
      offset: 0,
      category: 'beverage',
      q: 'a_b',
    });
    expect(us.map((r) => r.id)).toEqual(['up-underscore']);
  });

  it('q with a literal ! matches only the literal-! title (! self-escaped, NOT the ESCAPE char)', async () => {
    // End-to-end SQLite proof of the escape-char self-escaping (escapeLikePattern
    // !→!!): a q containing the literal escape char `!` must match the `!`
    // LITERALLY under `LIKE ? ESCAPE '!'`. The target carries a real `!`; the
    // decoys make a WRONG impl (one that left `!` un-self-escaped) fail:
    //   q='酒!特' correct → pattern '%酒!!特%' matches the literal `酒!特` substring.
    //   q='酒!特' WRONG   → pattern '%酒!特%' where the lone `!` escapes the next
    //                       char `特` → collapses to the literal `酒特`, so it would
    //                       MISS the target AND wrongly match the no-`!` decoy below.
    seedRow(t.handle, {
      suffix: 'bang',
      per100ml: 0.3,
      formula: 'f',
      upConfidence: 0.95,
      productConfidence: 0.5,
      warnings: '[]',
      title: '啤酒!特价 330ml', // the literal `!` — the only intended match
    });
    seedRow(t.handle, {
      suffix: 'bang-nobang',
      per100ml: 0.1, // cheaper, yet excluded: no literal `!`
      formula: 'f',
      upConfidence: 0.95,
      productConfidence: 0.5,
      warnings: '[]',
      title: '啤酒特价 330ml', // a WRONG (un-self-escaped) impl WOULD match this
    });
    seedRow(t.handle, {
      suffix: 'bang-neighbour',
      per100ml: 0.2, // cheaper, yet excluded: `X` is not the literal `!`
      formula: 'f',
      upConfidence: 0.95,
      productConfidence: 0.5,
      warnings: '[]',
      title: '啤酒X特价 330ml', // neighbour char in place of `!`
    });
    const rows = await t.repo.listRankings({
      limit: 50,
      offset: 0,
      category: 'beverage',
      q: '酒!特',
    });
    // ONLY the literal-`!` row. (Fails if `!` were treated as the ESCAPE char:
    // a wrong impl would return up-bang-nobang and drop up-bang.)
    expect(rows.map((r) => r.id)).toEqual(['up-bang']);
  });

  it('q zero-hit returns [] (not an error)', async () => {
    seedRow(t.handle, {
      suffix: 'only',
      per100ml: 0.3,
      formula: 'f',
      upConfidence: 0.95,
      productConfidence: 0.5,
      warnings: '[]',
      title: '雪碧 330ml',
    });
    await expect(
      t.repo.listRankings({
        limit: 50,
        offset: 0,
        category: 'beverage',
        q: '不存在的词',
      }),
    ).resolves.toEqual([]);
  });
});

/**
 * Query-plan assertion for the node-scoped path. The EXPLAIN guardrail (see
 * `rankings-api`「节点路径的查询计划口径」) is: with stats (先 `ANALYZE`, pinned to
 * match既有 P2 测试), the two BE-PROBED tables `category_closure` and
 * `unit_price` must each be `SEARCH ... USING INDEX` (their respective unique
 * indexes) — they must NOT degrade to a full SCAN. The driving table is a full
 * SCAN (`product` with stats, or `product_tag` without) and is deliberately
 * accepted (small tables); a `USE TEMP B-TREE` for ORDER BY / DISTINCT is also
 * allowed. We assert by per-table substring match only — NOT a whole-plan
 * equality / row-count assertion (post-`ANALYZE` plans add `BLOOM FILTER` /
 * covering-index probes that drift). We deliberately do NOT assert "driven from
 * closure/product_tag" (flips between `SCAN p` ↔ `SCAN pt` with ANALYZE) nor
 * "no SCAN unit_price" (structurally near-tautological in this join shape).
 * The SQL is the EXACT production query via the shared `buildRankingsQuery` +
 * `.toSQL()` — it can never drift from a hand-built copy.
 */
describe('listRankings query plan (node path)', () => {
  it('probes category_closure + unit_price via their unique indexes (category_closure not SCANned; unit_price guarded by its positive USING INDEX assertion)', async () => {
    const t = await openDb();
    const carbonatedId = tagId(t.handle, 'carbonated');
    const insRaw = t.handle.prepare(
      `INSERT INTO product_raw (id, store, store_sku, title, price, captured_at) VALUES (?,?,?,?,?,?)`,
    );
    const insProd = t.handle.prepare(
      `INSERT INTO product (id, raw_id, multipliers, category, confidence, dedupe_key, rankable) VALUES (?,?,?,?,?,?,?)`,
    );
    const insUp = t.handle.prepare(
      `INSERT INTO unit_price (id, product_id, per100ml, per100g, formula, confidence, warnings) VALUES (?,?,?,?,?,?,?)`,
    );
    const insPt = t.handle.prepare(
      `INSERT INTO product_tag (id, product_id, tag_id, source, confidence) VALUES (?,?,?,'rule',1)`,
    );
    const tx = t.handle.transaction(() => {
      for (let i = 0; i < 300; i++) {
        insRaw.run(`r${i}`, 'sam', `sku${i}`, `t${i}`, 100 + i, 1000);
        insProd.run(`p${i}`, `r${i}`, '[1]', 'beverage', 0.5, `dk${i}`, 1);
        insUp.run(
          `u${i}`,
          `p${i}`,
          i % 7 === 0 ? null : i * 0.01,
          null,
          'f',
          0.95,
          '[]',
        );
        insPt.run(`pt${i}`, `p${i}`, carbonatedId);
      }
    });
    tx();
    // ANALYZE so the planner's cost model has table stats (pinned, like P2).
    t.handle.exec('ANALYZE');

    // The EXACT node-scoped SQL the repository emits — from the SAME shared
    // builder listRankings uses (`buildRankingsQuery` + `.toSQL()`), so the
    // EXPLAIN runs on the production query and can never drift.
    const orm = drizzle(t.handle);
    const { sql: prodSql, params } = buildRankingsQuery(orm, carbonatedId, {
      limit: 50,
      offset: 0,
    }).toSQL();

    const plan = t.handle
      .prepare('EXPLAIN QUERY PLAN ' + prodSql)
      .all(...params) as Array<{ detail: string }>;
    const details = plan.map((p) => p.detail);

    // Guardrail: category_closure is SEARCHed via its unique index (not SCANned).
    expect(
      details.some((d) =>
        /SEARCH\b.*\bcategory_closure\b.*USING INDEX category_closure_tag_id_ancestor_tag_id_unique/.test(
          d,
        ),
      ),
    ).toBe(true);
    // Guardrail: unit_price is SEARCHed via unit_price_product_id_unique.
    expect(
      details.some((d) =>
        /SEARCH\b.*\bunit_price\b.*USING INDEX unit_price_product_id_unique/.test(
          d,
        ),
      ),
    ).toBe(true);
    // category_closure is asserted NOT degraded to a full SCAN. unit_price needs
    // no separate `!SCAN unit_price` — the positive `SEARCH unit_price USING INDEX
    // unit_price_product_id_unique` assertion above already protects it (a row
    // cannot be both SEARCHed-by-index and SCANned), and a standalone `!SCAN
    // unit_price` is near-tautological in this join shape (per the spec).
    expect(details.some((d) => /\bSCAN\b\s+category_closure\b/.test(d))).toBe(
      false,
    );
    // (A SCAN of the driving table product/product_tag and a TEMP B-TREE for
    // ORDER BY / DISTINCT are permitted and intentionally not asserted against.)

    t.handle.close();
  });

  it('q-absent SQL is byte-identical to the no-q board (no LIKE, plan unchanged)', async () => {
    // Structural guarantee: an absent `q` constructs NO title LIKE clause, so
    // the production SQL — and thus its EXPLAIN — is byte-for-byte the same as
    // before `q` existed. `and()` drops the undefined predicate.
    const t = await openDb();
    const carbonatedId = tagId(t.handle, 'carbonated');
    const orm = drizzle(t.handle);
    const { sql } = buildRankingsQuery(orm, carbonatedId, {
      limit: 50,
      offset: 0,
    }).toSQL();
    expect(sql).not.toMatch(/LIKE/i);
    // Passing q: undefined / '' must be identical to omitting it entirely.
    const omitted = buildRankingsQuery(orm, carbonatedId, {
      limit: 50,
      offset: 0,
    }).toSQL().sql;
    const undef = buildRankingsQuery(orm, carbonatedId, {
      limit: 50,
      offset: 0,
      q: undefined,
    }).toSQL().sql;
    const empty = buildRankingsQuery(orm, carbonatedId, {
      limit: 50,
      offset: 0,
      q: '',
    }).toSQL().sql;
    expect(undef).toBe(omitted);
    expect(empty).toBe(omitted);
    t.handle.close();
  });

  it('q-present plan: closure + unit_price still SEARCH USING INDEX; title LIKE is a residual filter', async () => {
    // With `q` the only change is a residual `product_raw.title LIKE ?` on the
    // already-PK-reached product_raw row — the index-probe shape on
    // category_closure + unit_price is unchanged. We assert the two probes still
    // use their unique indexes and the LIKE rides on product_raw; we deliberately
    // do NOT assert "must SCAN product_raw" (brittle — product_raw is already
    // reached by PK join, the LIKE is just a residual on that row).
    const t = await openDb();
    const carbonatedId = tagId(t.handle, 'carbonated');
    const insRaw = t.handle.prepare(
      `INSERT INTO product_raw (id, store, store_sku, title, price, captured_at) VALUES (?,?,?,?,?,?)`,
    );
    const insProd = t.handle.prepare(
      `INSERT INTO product (id, raw_id, multipliers, category, confidence, dedupe_key, rankable) VALUES (?,?,?,?,?,?,?)`,
    );
    const insUp = t.handle.prepare(
      `INSERT INTO unit_price (id, product_id, per100ml, per100g, formula, confidence, warnings) VALUES (?,?,?,?,?,?,?)`,
    );
    const insPt = t.handle.prepare(
      `INSERT INTO product_tag (id, product_id, tag_id, source, confidence) VALUES (?,?,?,'rule',1)`,
    );
    const tx = t.handle.transaction(() => {
      for (let i = 0; i < 300; i++) {
        insRaw.run(`r${i}`, 'sam', `sku${i}`, `可乐${i}`, 100 + i, 1000);
        insProd.run(`p${i}`, `r${i}`, '[1]', 'beverage', 0.5, `dk${i}`, 1);
        insUp.run(
          `u${i}`,
          `p${i}`,
          i % 7 === 0 ? null : i * 0.01,
          null,
          'f',
          0.95,
          '[]',
        );
        insPt.run(`pt${i}`, `p${i}`, carbonatedId);
      }
    });
    tx();
    t.handle.exec('ANALYZE');

    const orm = drizzle(t.handle);
    const { sql: prodSql, params } = buildRankingsQuery(orm, carbonatedId, {
      limit: 50,
      offset: 0,
      q: '可乐',
    }).toSQL();
    // The SQL carries the residual LIKE on product_raw.title with ESCAPE '!'.
    expect(prodSql).toMatch(
      /"product_raw"\."title" LIKE \? ESCAPE '!'/,
    );

    const plan = t.handle
      .prepare('EXPLAIN QUERY PLAN ' + prodSql)
      .all(...params) as Array<{ detail: string }>;
    const details = plan.map((p) => p.detail);

    // The index probes are unchanged by the residual title filter.
    expect(
      details.some((d) =>
        /SEARCH\b.*\bcategory_closure\b.*USING INDEX category_closure_tag_id_ancestor_tag_id_unique/.test(
          d,
        ),
      ),
    ).toBe(true);
    expect(
      details.some((d) =>
        /SEARCH\b.*\bunit_price\b.*USING INDEX unit_price_product_id_unique/.test(
          d,
        ),
      ),
    ).toBe(true);
    // category_closure still must not degrade to a SCAN.
    expect(details.some((d) => /\bSCAN\b\s+category_closure\b/.test(d))).toBe(
      false,
    );

    t.handle.close();
  });
});

/**
 * `escapeLikePattern` unit tests: the LIKE specials (`%`, `_`, the escape char
 * `!`) must each be prefixed with `!` so they match LITERALLY under
 * `... LIKE ? ESCAPE '!'`. The escape char escapes itself; no over/under
 * escaping; the surrounding `%…%` wildcards are NOT this function's job (the
 * caller adds them and they stay wildcards).
 */
describe('escapeLikePattern', () => {
  it('escapes % so it matches literally (not as a wildcard)', () => {
    expect(escapeLikePattern('100%')).toBe('100!%');
  });

  it('escapes _ so it matches a literal underscore (not any single char)', () => {
    expect(escapeLikePattern('a_b')).toBe('a!_b');
  });

  it('escapes the escape char ! by doubling it (escapes itself)', () => {
    expect(escapeLikePattern('a!b')).toBe('a!!b');
  });

  it('escapes a mix of all three specials in one pass, no double-processing', () => {
    // !→!!, %→!%, _→!_, each exactly once; the inserted ! is never re-escaped.
    expect(escapeLikePattern('!%_')).toBe('!!!%!_');
    expect(escapeLikePattern('100%_a!b')).toBe('100!%!_a!!b');
  });

  it('leaves non-special chars (incl. CJK) untouched — no over-escaping', () => {
    expect(escapeLikePattern('可乐')).toBe('可乐');
    expect(escapeLikePattern('100+200')).toBe('100+200'); // + is not a LIKE special
    expect(escapeLikePattern('')).toBe('');
  });

  it('the wrapping %…% wildcards are NOT passed through escapeLikePattern (only the inner word is escaped; outer % stays a wildcard)', () => {
    // buildRankingsQuery wraps as '%' + escapeLikePattern(q) + '%'. The outer %
    // are appended OUTSIDE the escape — so they remain wildcards. If the outer %
    // were escaped, the pattern would be a literal `%...%` and match nothing.
    const inner = escapeLikePattern('可乐');
    const pattern = '%' + inner + '%';
    expect(pattern).toBe('%可乐%'); // leading/trailing % are bare wildcards
    expect(pattern.startsWith('%')).toBe(true);
    expect(pattern.startsWith('!%')).toBe(false);
    expect(pattern.endsWith('%')).toBe(true);
    expect(pattern.endsWith('!%')).toBe(false);
  });
});

/**
 * Regression guard: `buildRankableCountQuery` must stay q-pure (it ALWAYS passes
 * `undefined` for the extra predicate) so the tree's rankableCount can never
 * drift from the no-q board's row count. The baseline string below was captured
 * from the builder BEFORE the `extra?` parameter was added; after the change the
 * `.toSQL().sql` must be byte-for-byte identical (no LIKE, no q leakage).
 */
describe('buildRankableCountQuery (q-pure regression)', () => {
  // Honest baseline: captured from the pre-`extra?` builder via .toSQL().sql.
  const BASELINE_COUNT_SQL =
    'select count(distinct "product"."id") from "unit_price" inner join "product" on "product"."id" = "unit_price"."product_id" inner join "product_raw" on "product_raw"."id" = "product"."raw_id" inner join "product_tag" on "product_tag"."product_id" = "product"."id" inner join "category_closure" on "category_closure"."tag_id" = "product_tag"."tag_id" where ("category_closure"."ancestor_tag_id" = ? and "product"."rankable" = ? and "unit_price"."per100ml" is not null)';

  it('emits byte-identical SQL to the pre-q baseline (no LIKE, count unaffected by q)', async () => {
    const t = await openDb();
    const carbonatedId = tagId(t.handle, 'carbonated');
    const orm = drizzle(t.handle);
    const { sql } = (
      buildRankableCountQuery(orm, carbonatedId) as unknown as {
        toSQL: () => { sql: string; params: unknown[] };
      }
    ).toSQL();
    expect(sql).toBe(BASELINE_COUNT_SQL);
    expect(sql).not.toMatch(/LIKE/i);
    t.handle.close();
  });
});
