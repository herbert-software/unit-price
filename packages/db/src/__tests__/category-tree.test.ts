// listCategoryTree: read-only category is-a tree + per-node rankableCount.
// Pure SQLite/in-memory with the canonical taxonomy seeded. Covers: all
// kind=category nodes returned (no attribute/brand/product_line axes), in-memory
// inheritance resolution of comparableUnit (soft-drink/dairy line + 酒种 leaves
// per_100ml, root/酒类 parent null), node `rankable` = comparableUnit !== null,
// rankableCount being closure-descendant rankable members (orthogonal to the
// node's own rankable — P3.5: root>0 AND 酒类 parent>0), per can-point-in node
// rankableCount == its cohort board cardinality (root/酒类 parent are
// informational, no board), a no-rankable-member node count=0, and the
// un-seeded empty tree.
import Database from 'better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.js';
import { createRepository, type Repository } from '../repository.js';
import { seedTaxonomy } from '../seed.js';

const migrationsFolder = fileURLToPath(
  new URL('../../drizzle', import.meta.url),
);

interface TreeTestDb {
  handle: Database.Database;
  db: Db;
  repo: Repository;
}

function openMigratedDb(): TreeTestDb {
  const handle = new Database(':memory:');
  handle.pragma('foreign_keys = ON');
  const db = createDb(handle);
  if (db.kind !== 'sqlite') throw new Error('expected sqlite');
  migrate(db.orm, { migrationsFolder });
  return { handle, db, repo: createRepository(db) };
}

async function openSeededDb(): Promise<TreeTestDb> {
  const t = openMigratedDb();
  await seedTaxonomy(t.db);
  return t;
}

function tagId(handle: Database.Database, slug: string): string {
  return (
    handle.prepare('SELECT id FROM tag WHERE slug = ?').get(slug) as {
      id: string;
    }
  ).id;
}

/** Seed a rankable (or not) product with one category leaf membership. */
function seedMember(
  handle: Database.Database,
  opts: {
    suffix: string;
    leaf: string | null;
    per100ml: number | null;
    rankable: boolean;
  },
): void {
  const { suffix, leaf, per100ml, rankable } = opts;
  handle
    .prepare(
      `INSERT INTO product_raw (id, store, store_sku, title, price, captured_at) VALUES (?,?,?,?,?,?)`,
    )
    .run(`raw-${suffix}`, 'sam', `sku-${suffix}`, `t-${suffix}`, 100, 1000);
  handle
    .prepare(
      `INSERT INTO product (id, raw_id, multipliers, category, confidence, dedupe_key, rankable) VALUES (?,?,?,?,?,?,?)`,
    )
    .run(`prod-${suffix}`, `raw-${suffix}`, '[1]', 'beverage', 0.5, `dk-${suffix}`, rankable ? 1 : 0);
  handle
    .prepare(
      `INSERT INTO unit_price (id, product_id, per100ml, per100g, formula, confidence, warnings) VALUES (?,?,?,?,?,?,?)`,
    )
    .run(`up-${suffix}`, `prod-${suffix}`, per100ml, null, per100ml == null ? null : 'f', 0.95, '[]');
  if (leaf != null) {
    handle
      .prepare(
        `INSERT INTO product_tag (id, product_id, tag_id, source, confidence) VALUES (?,?,?,'rule',1)`,
      )
      .run(`pt-${suffix}`, `prod-${suffix}`, tagId(handle, leaf));
  }
}

describe('listCategoryTree', () => {
  let t: TreeTestDb;
  beforeEach(async () => {
    t = await openSeededDb();
  });

  it('returns every kind=category node and no attribute/brand/product_line axis', async () => {
    const tree = await t.repo.listCategoryTree();
    const slugs = new Set(tree.map((n) => n.slug));
    // All seeded category nodes present.
    for (const slug of [
      'beverage',
      'soft-drink',
      'carbonated',
      'juice-plant',
      'coffee-tea',
      'drinking-water',
      'dairy',
      'milk',
      'yogurt',
      'lactic-drink',
      'alcohol',
      'baijiu',
      'wine',
      'spirits',
      'whisky',
      'beer',
      'sake-fruit-wine',
    ]) {
      expect(slugs.has(slug)).toBe(true);
    }
    // No attribute slugs leak in.
    for (const attr of ['sugar-free', 'sparkling', 'imported']) {
      expect(slugs.has(attr)).toBe(false);
    }
    // 6 soft-drink (软饮 + 4 leaves) + 4 dairy (乳品 + 3 leaves) + 7 alcohol
    // (酒类 + 6 leaves) + root = 17.
    expect(tree.length).toBe(17);
  });

  it('resolves comparableUnit by inheritance and derives rankable = (unit !== null)', async () => {
    const tree = await t.repo.listCategoryTree();
    const bySlug = new Map(tree.map((n) => [n.slug, n]));

    // soft-drink parent directly binds per_100ml → rankable.
    expect(bySlug.get('soft-drink')?.comparableUnit).toBe('per_100ml');
    expect(bySlug.get('soft-drink')?.rankable).toBe(true);
    // Soft-drink leaves inherit per_100ml → rankable.
    for (const leaf of ['carbonated', 'juice-plant', 'coffee-tea', 'drinking-water']) {
      expect(bySlug.get(leaf)?.comparableUnit).toBe('per_100ml');
      expect(bySlug.get(leaf)?.rankable).toBe(true);
    }
    // 乳品 parent binds per_100ml; its leaves inherit → all rankable (P3.5).
    for (const slug of ['dairy', 'milk', 'yogurt', 'lactic-drink']) {
      expect(bySlug.get(slug)?.comparableUnit).toBe('per_100ml');
      expect(bySlug.get(slug)?.rankable).toBe(true);
    }
    // Each 酒种 leaf binds per_100ml on the leaf itself → rankable (P3.5).
    for (const slug of ['baijiu', 'wine', 'spirits', 'whisky', 'beer', 'sake-fruit-wine']) {
      expect(bySlug.get(slug)?.comparableUnit).toBe('per_100ml');
      expect(bySlug.get(slug)?.rankable).toBe(true);
    }
    // Only the cross-cohort parents resolve null → not rankable: root + 酒类.
    for (const slug of ['beverage', 'alcohol']) {
      expect(bySlug.get(slug)?.comparableUnit).toBeNull();
      expect(bySlug.get(slug)?.rankable).toBe(false);
    }
  });

  it('projects parentSlug (null at root)', async () => {
    const tree = await t.repo.listCategoryTree();
    const bySlug = new Map(tree.map((n) => [n.slug, n]));
    expect(bySlug.get('beverage')?.parentSlug).toBeNull();
    expect(bySlug.get('soft-drink')?.parentSlug).toBe('beverage');
    expect(bySlug.get('carbonated')?.parentSlug).toBe('soft-drink');
    expect(bySlug.get('alcohol')?.parentSlug).toBe('beverage');
    expect(bySlug.get('wine')?.parentSlug).toBe('alcohol');
  });

  it('rankableCount counts closure descendants, orthogonal to the node rankable flag', async () => {
    // 2 carbonated + 1 drinking-water rankable soft-drinks; 1 rankable beer
    // (P3.5: 酒种 leaves are rankable) under the 酒类 parent.
    seedMember(t.handle, { suffix: 'c1', leaf: 'carbonated', per100ml: 0.3, rankable: true });
    seedMember(t.handle, { suffix: 'c2', leaf: 'carbonated', per100ml: 0.4, rankable: true });
    seedMember(t.handle, { suffix: 'w1', leaf: 'drinking-water', per100ml: 0.1, rankable: true });
    seedMember(t.handle, { suffix: 'beer', leaf: 'beer', per100ml: 0.2, rankable: true });

    const tree = await t.repo.listCategoryTree();
    const bySlug = new Map(tree.map((n) => [n.slug, n]));

    // root: rankable=false yet count > 0 (= 3 soft-drinks + 1 beer).
    expect(bySlug.get('beverage')?.rankable).toBe(false);
    expect(bySlug.get('beverage')?.rankableCount).toBe(4);
    // soft-drink parent: union of its leaves' rankable members.
    expect(bySlug.get('soft-drink')?.rankableCount).toBe(3);
    // leaves.
    expect(bySlug.get('carbonated')?.rankableCount).toBe(2);
    expect(bySlug.get('drinking-water')?.rankableCount).toBe(1);
    expect(bySlug.get('juice-plant')?.rankableCount).toBe(0);
    // alcohol parent: rankable=false (cross-cohort, cohort-guarded out of any
    // single board) yet rankableCount > 0 — P3.5 its 酒种 leaf descendants ARE
    // rankable (no longer 0). Informational branch count, no corresponding board.
    expect(bySlug.get('alcohol')?.rankable).toBe(false);
    expect(bySlug.get('alcohol')?.rankableCount).toBe(1);
    expect(bySlug.get('beer')?.rankableCount).toBe(1);
    expect(bySlug.get('wine')?.rankableCount).toBe(0);
  });

  it('rankableCount per can-point-in node equals its cohort board cardinality (root/alcohol parent are informational, no board)', async () => {
    seedMember(t.handle, { suffix: 'c1', leaf: 'carbonated', per100ml: 0.3, rankable: true });
    seedMember(t.handle, { suffix: 'c2', leaf: 'carbonated', per100ml: 0.4, rankable: true });
    seedMember(t.handle, { suffix: 'w1', leaf: 'drinking-water', per100ml: 0.1, rankable: true });
    seedMember(t.handle, { suffix: 'j1', leaf: 'juice-plant', per100ml: 0.5, rankable: true });
    seedMember(t.handle, { suffix: 'm1', leaf: 'milk', per100ml: 0.6, rankable: true });
    // P3.5: a rankable beer 酒种 member → 酒类 parent rankableCount > 0.
    seedMember(t.handle, { suffix: 'b1', leaf: 'beer', per100ml: 0.2, rankable: true });
    // Excluded ones: a rankable soft-drink with NULL per100ml + a rankable=false wine.
    seedMember(t.handle, { suffix: 'cn', leaf: 'carbonated', per100ml: null, rankable: true });
    seedMember(t.handle, { suffix: 'wine', leaf: 'wine', per100ml: 0.2, rankable: false });

    const tree = await t.repo.listCategoryTree();
    const bySlug = new Map(tree.map((n) => [n.slug, n]));
    // can-point-in nodes (rankable=true): rankableCount == cohort board length.
    // `wine` has only a rankable=false member → board [] and rankableCount 0.
    for (const slug of [
      'soft-drink',
      'carbonated',
      'drinking-water',
      'juice-plant',
      'coffee-tea',
      'dairy',
      'milk',
      'beer',
      'wine',
    ]) {
      const board = await t.repo.listRankings({
        limit: 1000,
        offset: 0,
        category: slug,
      });
      expect(bySlug.get(slug)?.rankableCount).toBe(board.length);
    }
    // soft-drink board base (carbonated×2 + water×1 + juice×1 = 4 rankable; the
    // NULL-per100ml carbonated `cn` is excluded by the data gate).
    expect(bySlug.get('soft-drink')?.rankableCount).toBe(4);
    expect(bySlug.get('dairy')?.rankableCount).toBe(1);
    expect(bySlug.get('beer')?.rankableCount).toBe(1);
    // root + 酒类 parent: rankable=false → informational branch count (no board,
    // cohort-guarded out at the API). root counts ALL rankable descendants
    // (4 soft-drink + 1 dairy + 1 beer = 6); 酒类 counts its 酒种 descendants
    // (1 beer; the wine is rankable=false → not counted). P3.5: alcohol > 0.
    expect(bySlug.get('beverage')?.rankable).toBe(false);
    expect(bySlug.get('beverage')?.rankableCount).toBe(6);
    expect(bySlug.get('alcohol')?.rankable).toBe(false);
    expect(bySlug.get('alcohol')?.rankableCount).toBe(1);
  });

  it('a violated single-attribution (double leaf) still counts the product once', async () => {
    // Inject a product holding two category leaves both under root → the closure
    // JOIN would double-count without COUNT(DISTINCT product.id).
    seedMember(t.handle, { suffix: 'dup', leaf: 'carbonated', per100ml: 0.3, rankable: true });
    t.handle
      .prepare(
        `INSERT INTO product_tag (id, product_id, tag_id, source, confidence) VALUES ('pt-dup2','prod-dup',?,'rule',1)`,
      )
      .run(tagId(t.handle, 'juice-plant'));

    const tree = await t.repo.listCategoryTree();
    const bySlug = new Map(tree.map((n) => [n.slug, n]));
    expect(bySlug.get('beverage')?.rankableCount).toBe(1);
    expect(bySlug.get('soft-drink')?.rankableCount).toBe(1);
    // It IS a member of both leaves (one each) but the product counts once per node.
    const board = await t.repo.listRankings({ limit: 100, offset: 0, category: 'beverage' });
    expect(board.filter((r) => r.id === 'up-dup')).toHaveLength(1);
  });

  it('a node with no rankable members counts 0 and is still in the tree', async () => {
    const tree = await t.repo.listCategoryTree();
    const bySlug = new Map(tree.map((n) => [n.slug, n]));
    // Empty DB of products → every count 0, but all nodes present.
    expect(bySlug.get('coffee-tea')?.rankableCount).toBe(0);
    expect(bySlug.has('coffee-tea')).toBe(true);
  });

  it('returns an empty tree when no category rows are seeded (not an error)', async () => {
    const t2 = openMigratedDb(); // migrated but NOT seeded
    await expect(t2.repo.listCategoryTree()).resolves.toEqual([]);
    t2.handle.close();
  });
});
