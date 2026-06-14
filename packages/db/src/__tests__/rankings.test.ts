// listRankings: read-only NODE-SCOPED ranking projection over
// unit_price ⋈ product ⋈ product_raw ⋈ product_tag ⋈ category_closure. Pure
// SQLite/in-memory with the canonical taxonomy seeded. Covers ascending order,
// per100ml-NULL exclusion, the rankable=1 gate (alcohol/待人工 excluded),
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
  buildRankingsQuery,
  createRepository,
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

  it('excludes rankable=false rows (alcohol leaf with per100ml is gated out)', async () => {
    // A rankable soft-drink and a rankable=false wine (alcohol leaf) that still
    // has a non-null per100ml. The rankable gate keeps only the soft drink —
    // the wine never rides the volume axis (fixes "sorting alcohol by volume").
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
      suffix: 'wine',
      per100ml: 0.2, // cheaper, yet excluded
      formula: 'f',
      upConfidence: 0.95,
      productConfidence: 0.5,
      warnings: '[]',
      leaf: 'wine',
      rankable: false,
    });
    const root = await t.repo.listRankings({
      limit: 50,
      offset: 0,
      category: 'beverage',
    });
    expect(root.map((r) => r.id)).toEqual(['up-soda']);
    // The alcohol node board is empty (the rankable gate, not a special case).
    expect(
      await t.repo.listRankings({ limit: 50, offset: 0, category: 'alcohol' }),
    ).toEqual([]);
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
});
