// listCategoryTree: read-only category is-a tree + per-node rankableCount.
// Pure SQLite/in-memory with the canonical taxonomy seeded. Covers: all
// kind=category nodes returned (no attribute/brand/product_line axes), in-memory
// inheritance resolution of comparableUnit (soft-drink line per_100ml,
// root/alcohol null), node `rankable` = comparableUnit !== null, rankableCount
// being closure-descendant rankable members (orthogonal to the node's own
// rankable — root>0, alcohol=0), per-node rankableCount == the node board's
// cardinality (含 root / 父 / 叶 / 酒类), a no-rankable-member node count=0, and
// the un-seeded empty tree.
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
    expect(tree.length).toBe(13);
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
    // root + alcohol parent + alcohol leaves resolve null → not rankable.
    for (const slug of ['beverage', 'alcohol', 'baijiu', 'wine', 'beer', 'whisky']) {
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
    // 2 carbonated + 1 drinking-water rankable soft-drinks; 1 wine rankable=false.
    seedMember(t.handle, { suffix: 'c1', leaf: 'carbonated', per100ml: 0.3, rankable: true });
    seedMember(t.handle, { suffix: 'c2', leaf: 'carbonated', per100ml: 0.4, rankable: true });
    seedMember(t.handle, { suffix: 'w1', leaf: 'drinking-water', per100ml: 0.1, rankable: true });
    seedMember(t.handle, { suffix: 'wine', leaf: 'wine', per100ml: 0.2, rankable: false });

    const tree = await t.repo.listCategoryTree();
    const bySlug = new Map(tree.map((n) => [n.slug, n]));

    // root: rankable=false yet count > 0 (= all 3 rankable soft-drinks).
    expect(bySlug.get('beverage')?.rankable).toBe(false);
    expect(bySlug.get('beverage')?.rankableCount).toBe(3);
    // soft-drink parent: union of its leaves' rankable members.
    expect(bySlug.get('soft-drink')?.rankableCount).toBe(3);
    // leaves.
    expect(bySlug.get('carbonated')?.rankableCount).toBe(2);
    expect(bySlug.get('drinking-water')?.rankableCount).toBe(1);
    expect(bySlug.get('juice-plant')?.rankableCount).toBe(0);
    // alcohol subtree: only a rankable=false wine → count 0.
    expect(bySlug.get('alcohol')?.rankableCount).toBe(0);
    expect(bySlug.get('wine')?.rankableCount).toBe(0);
  });

  it('rankableCount per node equals the node board cardinality (root / parent / leaf / alcohol)', async () => {
    seedMember(t.handle, { suffix: 'c1', leaf: 'carbonated', per100ml: 0.3, rankable: true });
    seedMember(t.handle, { suffix: 'c2', leaf: 'carbonated', per100ml: 0.4, rankable: true });
    seedMember(t.handle, { suffix: 'w1', leaf: 'drinking-water', per100ml: 0.1, rankable: true });
    seedMember(t.handle, { suffix: 'j1', leaf: 'juice-plant', per100ml: 0.5, rankable: true });
    // Excluded ones: a rankable soft-drink with NULL per100ml + a rankable=false wine.
    seedMember(t.handle, { suffix: 'cn', leaf: 'carbonated', per100ml: null, rankable: true });
    seedMember(t.handle, { suffix: 'wine', leaf: 'wine', per100ml: 0.2, rankable: false });

    const tree = await t.repo.listCategoryTree();
    const bySlug = new Map(tree.map((n) => [n.slug, n]));
    for (const slug of [
      'beverage',
      'soft-drink',
      'carbonated',
      'drinking-water',
      'juice-plant',
      'coffee-tea',
      'alcohol',
      'wine',
    ]) {
      const board = await t.repo.listRankings({
        limit: 1000,
        offset: 0,
        category: slug,
      });
      expect(bySlug.get(slug)?.rankableCount).toBe(board.length);
    }
    // Sanity anchors.
    expect(bySlug.get('beverage')?.rankableCount).toBe(4); // = default board base
    expect(bySlug.get('beverage')!.rankableCount).toBeGreaterThan(0);
    expect(bySlug.get('alcohol')?.rankableCount).toBe(0);
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
