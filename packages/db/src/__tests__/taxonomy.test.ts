// Persistence-layer tests for the taxonomy/tagging data model (2.5):
// closure full-ancestor membership, single-attribution convergence,
// comparable_unit is-a inheritance, product_tag idempotency, store_category_map
// (no coarse-native → leaf下放), dedupe_key unchanged by the two new columns,
// non-empty-table `rankable` migration (DEFAULT 0), and migration replay.
//
// These exercise the repository PRIMITIVES (attachTag / removeCategoryLeafTags /
// setPendingCategory / setRankable / resolveComparableUnit /
// listProductIdsInCategoryNode / lookupStoreCategory / getProductAttribution)
// and the seed; the three-state reconcile ORCHESTRATION is apps/api's job.
import {
  calculate,
  ParsedSpecSchema,
  type CalcResult,
  type ParsedSpec,
} from '@unit-price/core';
import Database from 'better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { readFileSync as fsReadFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { computeDedupeKey } from '../dedupe.js';
import { createDb } from '../db.js';
import { type Repository } from '../repository.js';
import {
  CATEGORY_NODES,
  SAM_CATEGORY_MAP,
  SAM_STORE,
  computeClosurePairs,
  seedTaxonomy,
} from '../seed.js';
import {
  countRows,
  migrationsFolder,
  openSeededTestDb,
  openTestDb,
  type TestDb,
} from './harness.js';

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

let seq = 0;

/** Insert a product (raw + product + unit_price) and return its product id. */
async function insertProduct(
  repo: Repository,
  title = '可口可乐 无糖 330ml*24',
): Promise<string> {
  seq += 1;
  const rawId = await repo.upsertRaw({
    store: 'sam',
    storeSku: `sku-${seq}`,
    raw: { title, price: 39.9 },
    capturedAt: 1_700_000_000_000,
  });
  const { productId } = await repo.saveParsed({ rawId, spec, calc });
  return productId;
}

describe('seed: canonical category tree', () => {
  it('resolves per_100ml on soft-drink/dairy/酒种 leaves; null on beverage/alcohol parents (P3.5)', async () => {
    const t = await openSeededTestDb();
    // 软饮 leaves inherit per_100ml (bound once on 软饮, not per-leaf).
    for (const leaf of ['carbonated', 'juice-plant', 'coffee-tea', 'drinking-water']) {
      expect(await t.repo.resolveComparableUnit(leaf)).toBe('per_100ml');
    }
    expect(await t.repo.resolveComparableUnit('soft-drink')).toBe('per_100ml');
    // 乳品 subtree: 乳品 binds per_100ml, leaves inherit.
    expect(await t.repo.resolveComparableUnit('dairy')).toBe('per_100ml');
    for (const leaf of ['milk', 'yogurt', 'lactic-drink']) {
      expect(await t.repo.resolveComparableUnit(leaf)).toBe('per_100ml');
    }
    // Each 酒种 leaf binds per_100ml on the leaf itself (its own cohort).
    for (const leaf of ['baijiu', 'wine', 'spirits', 'whisky', 'beer', 'sake-fruit-wine']) {
      expect(await t.repo.resolveComparableUnit(leaf)).toBe('per_100ml');
    }
    // Only the cross-cohort parents resolve null: root 饮料 and 酒类 parent.
    expect(await t.repo.resolveComparableUnit('beverage')).toBeNull();
    expect(await t.repo.resolveComparableUnit('alcohol')).toBeNull();
  });

  it('self-binds comparable_unit on exactly the 8 P3.5 nodes (软饮 + 乳品 + 6 酒种叶)', async () => {
    const t = await openSeededTestDb();
    // Self-binding = the `tag.comparable_unit` COLUMN is non-null (NOT
    // inheritance-resolved non-null). Soft-drink/dairy leaves carry NULL in the
    // row and inherit, so they are NOT among these 8.
    const rows = t.handle
      .prepare(
        'SELECT slug FROM tag WHERE comparable_unit IS NOT NULL ORDER BY slug',
      )
      .all() as Array<{ slug: string }>;
    expect(rows.map((r) => r.slug)).toEqual([
      'baijiu',
      'beer',
      'dairy',
      'sake-fruit-wine',
      'soft-drink',
      'spirits',
      'whisky',
      'wine',
    ]);
  });

  it('seed is idempotent — re-running produces no duplicate rows', async () => {
    const t = await openSeededTestDb();
    const before = {
      tag: countRows(t.handle, 'tag'),
      closure: countRows(t.handle, 'category_closure'),
      map: countRows(t.handle, 'store_category_map'),
    };
    await seedTaxonomy(t.db);
    await seedTaxonomy(t.db);
    expect(countRows(t.handle, 'tag')).toBe(before.tag);
    expect(countRows(t.handle, 'category_closure')).toBe(before.closure);
    expect(countRows(t.handle, 'store_category_map')).toBe(before.map);
  });
});

describe('category_closure: full ancestor membership', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await openSeededTestDb();
  });

  it('a carbonated leaf is a member of 软饮 AND 饮料 root (full ancestors)', async () => {
    const pid = await insertProduct(t.repo);
    await t.repo.attachTag({
      productId: pid,
      tagSlug: 'carbonated',
      source: 'rule',
      confidence: 0.9,
    });
    // Member of its own leaf, of 软饮, and of the root 饮料.
    expect(await t.repo.listProductIdsInCategoryNode('carbonated')).toEqual([
      pid,
    ]);
    expect(await t.repo.listProductIdsInCategoryNode('soft-drink')).toEqual([
      pid,
    ]);
    expect(await t.repo.listProductIdsInCategoryNode('beverage')).toEqual([
      pid,
    ]);
  });

  it('membership does not leak across sibling subtrees', async () => {
    const pid = await insertProduct(t.repo);
    await t.repo.attachTag({
      productId: pid,
      tagSlug: 'carbonated',
      source: 'rule',
      confidence: 0.9,
    });
    // A carbonated product is NOT a member of juice-plant nor of alcohol.
    expect(await t.repo.listProductIdsInCategoryNode('juice-plant')).toEqual([]);
    expect(await t.repo.listProductIdsInCategoryNode('alcohol')).toEqual([]);
  });

  it('attribute tags carry no closure rows → never match a category node', async () => {
    const pid = await insertProduct(t.repo);
    // Attribute only, no leaf category.
    await t.repo.attachTag({
      productId: pid,
      tagSlug: 'sparkling',
      source: 'rule',
      confidence: 0.9,
    });
    expect(await t.repo.listProductIdsInCategoryNode('beverage')).toEqual([]);
    expect(await t.repo.listProductIdsInCategoryNode('drinking-water')).toEqual(
      [],
    );
  });

  it('closure pairs computed from the tree include the self row + chain to root', () => {
    const pairs = computeClosurePairs();
    const carb = pairs
      .filter((p) => p.tagSlug === 'carbonated')
      .map((p) => p.ancestorSlug)
      .sort();
    expect(carb).toEqual(['beverage', 'carbonated', 'soft-drink']);
  });

  it('closure includes 乳品/酒种 leaves chained to their own ancestors (P3.5)', () => {
    const pairs = computeClosurePairs();
    const ancestorsOf = (slug: string) =>
      pairs
        .filter((p) => p.tagSlug === slug)
        .map((p) => p.ancestorSlug)
        .sort();
    // milk → milk, dairy, beverage.
    expect(ancestorsOf('milk')).toEqual(['beverage', 'dairy', 'milk']);
    // baijiu → baijiu, alcohol, beverage.
    expect(ancestorsOf('baijiu')).toEqual(['alcohol', 'baijiu', 'beverage']);
  });

  it('乳品/酒种 leaves are members of their own node AND their ancestors (closure)', async () => {
    const milkPid = await insertProduct(t.repo, 'MM 纯牛奶 1L');
    await t.repo.attachTag({
      productId: milkPid,
      tagSlug: 'milk',
      source: 'rule',
      confidence: 0.9,
    });
    expect(await t.repo.listProductIdsInCategoryNode('milk')).toEqual([milkPid]);
    expect(await t.repo.listProductIdsInCategoryNode('dairy')).toEqual([milkPid]);
    expect(await t.repo.listProductIdsInCategoryNode('beverage')).toEqual([milkPid]);

    const beerPid = await insertProduct(t.repo, '青岛啤酒 500ml');
    await t.repo.attachTag({
      productId: beerPid,
      tagSlug: 'beer',
      source: 'rule',
      confidence: 0.9,
    });
    expect(await t.repo.listProductIdsInCategoryNode('beer')).toEqual([beerPid]);
    expect(await t.repo.listProductIdsInCategoryNode('alcohol')).toEqual([beerPid]);
    // beer is NOT a member of a sibling 酒种 node.
    expect(await t.repo.listProductIdsInCategoryNode('wine')).toEqual([]);
  });
});

describe('single-attribution convergence (removeCategoryLeafTags before re-attach)', () => {
  it('rule re-judgement A→B leaves only the new leaf', async () => {
    const t = await openSeededTestDb();
    const pid = await insertProduct(t.repo);
    // First verdict: carbonated.
    await t.repo.removeCategoryLeafTags(pid);
    await t.repo.attachTag({
      productId: pid,
      tagSlug: 'carbonated',
      source: 'rule',
      confidence: 0.9,
    });
    let attr = await t.repo.getProductAttribution(pid);
    expect(attr?.categoryLeafSlug).toBe('carbonated');

    // Re-judged to juice-plant: drop the old leaf, attach the new one.
    const removed = await t.repo.removeCategoryLeafTags(pid);
    expect(removed).toBe(1);
    await t.repo.attachTag({
      productId: pid,
      tagSlug: 'juice-plant',
      source: 'rule',
      confidence: 0.9,
    });
    attr = await t.repo.getProductAttribution(pid);
    expect(attr?.categoryLeafSlug).toBe('juice-plant');
    // No residual carbonated membership.
    expect(await t.repo.listProductIdsInCategoryNode('carbonated')).toEqual([]);
    expect(await t.repo.listProductIdsInCategoryNode('juice-plant')).toEqual([
      pid,
    ]);
  });

  it('removeCategoryLeafTags never touches attribute/brand edges', async () => {
    const t = await openSeededTestDb();
    const pid = await insertProduct(t.repo);
    await t.repo.attachTag({
      productId: pid,
      tagSlug: 'carbonated',
      source: 'rule',
      confidence: 0.9,
    });
    await t.repo.attachTag({
      productId: pid,
      tagSlug: 'sugar-free',
      source: 'rule',
      confidence: 0.9,
    });
    await t.repo.removeCategoryLeafTags(pid);
    const attr = await t.repo.getProductAttribution(pid);
    // The category leaf is gone; the orthogonal attribute survives.
    expect(attr?.categoryLeafSlug).toBeNull();
    expect(attr?.tags.map((x) => x.slug)).toContain('sugar-free');
  });
});

describe('product_tag idempotency', () => {
  it('re-attaching the same (product, tag) is a no-op (no duplicate row)', async () => {
    const t = await openSeededTestDb();
    const pid = await insertProduct(t.repo);
    await t.repo.attachTag({
      productId: pid,
      tagSlug: 'carbonated',
      source: 'rule',
      confidence: 0.9,
    });
    await t.repo.attachTag({
      productId: pid,
      tagSlug: 'carbonated',
      source: 'rule',
      confidence: 0.5,
    });
    expect(countRows(t.handle, 'product_tag')).toBe(1);
  });
});

describe('three-state field-discriminability + rankable', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await openSeededTestDb();
  });

  it('classified leaf (per_100ml) → rankable true, pending null', async () => {
    const pid = await insertProduct(t.repo);
    await t.repo.attachTag({
      productId: pid,
      tagSlug: 'carbonated',
      source: 'rule',
      confidence: 0.9,
    });
    await t.repo.setPendingCategory(pid, null);
    const unit = await t.repo.resolveComparableUnit('carbonated');
    await t.repo.setRankable(pid, unit != null);
    const attr = await t.repo.getProductAttribution(pid);
    expect(attr?.state).toBe('classified-leaf');
    expect(attr?.pendingCategorySlug).toBeNull();
    expect(attr?.rankable).toBe(true);
  });

  it('pending (coarse non-leaf) → no leaf, pending non-null, rankable false', async () => {
    const pid = await insertProduct(t.repo);
    await t.repo.removeCategoryLeafTags(pid);
    await t.repo.setPendingCategory(pid, 'soft-drink');
    await t.repo.setRankable(pid, false);
    const attr = await t.repo.getProductAttribution(pid);
    expect(attr?.state).toBe('pending');
    expect(attr?.categoryLeafSlug).toBeNull();
    expect(attr?.pendingCategorySlug).toBe('soft-drink');
    expect(attr?.rankable).toBe(false);
    // 待细化 must not appear as a member of its own pending node's ranking.
    expect(await t.repo.listProductIdsInCategoryNode('soft-drink')).toEqual([]);
  });

  it('manual (no leaf, pending null) is distinct from pending', async () => {
    const pid = await insertProduct(t.repo);
    const attr = await t.repo.getProductAttribution(pid);
    expect(attr?.state).toBe('manual');
    expect(attr?.categoryLeafSlug).toBeNull();
    expect(attr?.pendingCategorySlug).toBeNull();
    expect(attr?.rankable).toBe(false);
  });

  it('酒种 leaf (per_100ml) classified → rankable true (P3.5)', async () => {
    // P3.5: each 酒种 leaf binds per_100ml, so a product classified to it is
    // rankable (the cross-cohort guard lives in the API, not in rankable).
    const pid = await insertProduct(t.repo, '茅台 飞天 500ml');
    await t.repo.attachTag({
      productId: pid,
      tagSlug: 'baijiu',
      source: 'store-map',
      confidence: 0.9,
    });
    const unit = await t.repo.resolveComparableUnit('baijiu');
    expect(unit).toBe('per_100ml');
    await t.repo.setRankable(pid, unit != null);
    const attr = await t.repo.getProductAttribution(pid);
    expect(attr?.state).toBe('classified-leaf');
    expect(attr?.rankable).toBe(true);
  });

  it('乳品 leaf (per_100ml inherited) classified → rankable true (P3.5)', async () => {
    const pid = await insertProduct(t.repo, 'MM 全脂纯牛奶 1L');
    await t.repo.attachTag({
      productId: pid,
      tagSlug: 'milk',
      source: 'rule',
      confidence: 0.9,
    });
    const unit = await t.repo.resolveComparableUnit('milk');
    expect(unit).toBe('per_100ml');
    await t.repo.setRankable(pid, unit != null);
    const attr = await t.repo.getProductAttribution(pid);
    expect(attr?.state).toBe('classified-leaf');
    expect(attr?.rankable).toBe(true);
  });

  it('pending → classified leaf transition clears pending (no越界态)', async () => {
    const pid = await insertProduct(t.repo);
    // Start 待细化.
    await t.repo.setPendingCategory(pid, 'soft-drink');
    expect((await t.repo.getProductAttribution(pid))?.state).toBe('pending');
    // Now a leaf is hit. Through primitives the越界态 (有叶∧pending) is forbidden,
    // so the only safe ordering is clear-pending-first, then drop-any-leaf and
    // attach the new leaf. (The atomic single-call path is reconcileCategory.)
    await t.repo.setPendingCategory(pid, null);
    await t.repo.removeCategoryLeafTags(pid);
    await t.repo.attachTag({
      productId: pid,
      tagSlug: 'carbonated',
      source: 'rule',
      confidence: 0.9,
    });
    const attr = await t.repo.getProductAttribution(pid);
    expect(attr?.state).toBe('classified-leaf');
    expect(attr?.pendingCategorySlug).toBeNull();
    expect(attr?.categoryLeafSlug).toBe('carbonated');
  });
});

describe('store_category_map: coarse native never maps to a leaf下放', () => {
  it('every seeded Sam map row targets a real category tag; soft-drink ids hit leaves', async () => {
    const t = await openSeededTestDb();
    // Carbonated native id resolves to the carbonated LEAF (leaf→leaf is OK).
    const carb = await t.repo.lookupStoreCategory(SAM_STORE, '10003380');
    expect(carb).toEqual({ slug: 'carbonated', kind: 'category', isLeaf: true });
    const juice = await t.repo.lookupStoreCategory(SAM_STORE, '10012082');
    expect(juice).toEqual({ slug: 'juice-plant', kind: 'category', isLeaf: true });
  });

  it('lookupStoreCategory reports isLeaf: soft-drink leaf true, alcohol leaf true, coarse node false', async () => {
    const t = await openSeededTestDb();
    // Soft-drink leaf (carbonated) → isLeaf true.
    expect((await t.repo.lookupStoreCategory(SAM_STORE, '10003380'))?.isLeaf).toBe(true);
    // Alcohol leaf (baijiu, native 10012164) → isLeaf true.
    expect((await t.repo.lookupStoreCategory(SAM_STORE, '10012164'))?.isLeaf).toBe(true);
    // Map a native id at a coarse (non-leaf) node directly → isLeaf false.
    const softDrinkTagId = (
      t.handle.prepare("SELECT id FROM tag WHERE slug = 'soft-drink'").get() as {
        id: string;
      }
    ).id;
    t.handle
      .prepare(
        "INSERT INTO store_category_map (id, store, native_category_id, tag_id) VALUES ('m-coarse', ?, 'coarse-native', ?)",
      )
      .run(SAM_STORE, softDrinkTagId);
    const coarse = await t.repo.lookupStoreCategory(SAM_STORE, 'coarse-native');
    expect(coarse).toEqual({ slug: 'soft-drink', kind: 'category', isLeaf: false });
  });

  it('NO seeded map row points a coarse (non-leaf) native id at a leaf tag', async () => {
    // The forbidden shape is "coarse native → leaf". Our seed maps native LEAF
    // ids to leaf tags (allowed). Assert structurally: every map target tag is
    // a real seeded category node, and there is no row whose target is a leaf
    // while declared as a coarse mapping. Since the seed has no coarse rows at
    // all, the dangerous下放 simply cannot exist.
    const slugs = new Set(CATEGORY_NODES.map((n) => n.slug));
    for (const m of SAM_CATEGORY_MAP) {
      expect(slugs.has(m.tagSlug)).toBe(true);
    }
    // A coarse node (e.g. soft-drink, alcohol, beverage) is NOT a map target.
    const targets = new Set(SAM_CATEGORY_MAP.map((m) => m.tagSlug));
    for (const coarse of ['beverage', 'soft-drink', 'alcohol']) {
      expect(targets.has(coarse)).toBe(false);
    }
  });

  it('an unmapped native id resolves to null (→ 待人工)', async () => {
    const t = await openSeededTestDb();
    expect(await t.repo.lookupStoreCategory(SAM_STORE, 'no-such-id')).toBeNull();
  });
});

describe('dedupe_key unchanged by the two new product columns', () => {
  it('dedupe_key is spec-only — adding pending/rankable does not affect it', () => {
    // The key derives from (rawId + ParsedSpec); the two new columns are not
    // inputs. Equal spec → equal key regardless of pending/rankable.
    expect(computeDedupeKey('raw-x', spec)).toBe(computeDedupeKey('raw-x', spec));
  });

  it('re-saving an equivalent product still converges (first-write-wins)', async () => {
    const t = await openSeededTestDb();
    const rawId = await t.repo.upsertRaw({
      store: 'sam',
      storeSku: 'dedupe-sku',
      raw: { title: '可乐 330ml*24', price: 39.9 },
      capturedAt: 1_700_000_000_000,
    });
    const first = await t.repo.saveParsed({ rawId, spec, calc });
    // Tag + flag the first product (the new columns now carry values).
    await t.repo.attachTag({
      productId: first.productId,
      tagSlug: 'carbonated',
      source: 'rule',
      confidence: 0.9,
    });
    await t.repo.setRankable(first.productId, true);
    // An equivalent re-save converges onto the same (oldest) row.
    const second = await t.repo.saveParsed({ rawId, spec, calc });
    expect(second.productId).toBe(first.productId);
    expect(countRows(t.handle, 'product')).toBe(1);
  });
});

describe('migration: non-empty product table + replay', () => {
  it('adds rankable (DEFAULT 0) onto a non-empty product table', async () => {
    // Apply migrations up to 0002 only, insert a product, then apply 0003 — the
    // ALTER that adds `rankable NOT NULL DEFAULT 0` must succeed on a non-empty
    // table and backfill existing rows to 0 (待 recompute).
    const handle = new Database(':memory:');
    handle.pragma('foreign_keys = ON');

    const upTo0002 = [
      '0000_deep_enchantress.sql',
      '0001_fast_mephisto.sql',
      '0002_natural_jubilee.sql',
    ];
    const fs = await import('node:fs');
    const path = await import('node:path');
    for (const file of upTo0002) {
      const sql = fs.readFileSync(path.join(migrationsFolder, file), 'utf8');
      for (const stmt of sql.split('--> statement-breakpoint')) {
        if (stmt.trim()) handle.exec(stmt);
      }
    }
    // Seed a row into the (pre-0003) product table.
    handle
      .prepare(
        "INSERT INTO product_raw (id, store, store_sku, title, price, captured_at) VALUES ('r1','sam','s1','t',100,1)",
      )
      .run();
    handle
      .prepare(
        "INSERT INTO product (id, raw_id, multipliers, category, confidence, dedupe_key) VALUES ('p1','r1','[1]','beverage',0.9,'k1')",
      )
      .run();
    expect(
      (handle.prepare('SELECT count(*) c FROM product').get() as { c: number })
        .c,
    ).toBe(1);

    // Apply 0003 — must not throw on the non-empty table.
    const sql0003 = fs.readFileSync(
      path.join(migrationsFolder, '0003_daffy_lilandra.sql'),
      'utf8',
    );
    expect(() => {
      for (const stmt of sql0003.split('--> statement-breakpoint')) {
        if (stmt.trim()) handle.exec(stmt);
      }
    }).not.toThrow();

    const row = handle
      .prepare('SELECT rankable, pending_category_tag_id AS p FROM product WHERE id = ?')
      .get('p1') as { rankable: number; p: string | null };
    expect(row.rankable).toBe(0);
    expect(row.p).toBeNull();
    handle.close();
  });

  it('drizzle migrate replay is idempotent', async () => {
    const handle = new Database(':memory:');
    handle.pragma('foreign_keys = ON');
    const db = createDb(handle);
    if (db.kind !== 'sqlite') throw new Error('expected sqlite');
    migrate(db.orm, { migrationsFolder });
    const before = countRows(handle, '__drizzle_migrations');
    expect(() => migrate(db.orm, { migrationsFolder })).not.toThrow();
    expect(countRows(handle, '__drizzle_migrations')).toBe(before);
    handle.close();
  });
});

describe('reconcileCategory: atomic three-state + attributes + rankable', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await openSeededTestDb();
  });

  it('verdict=leaf: attaches leaf, clears pending, sets rankable', async () => {
    const pid = await insertProduct(t.repo);
    await t.repo.reconcileCategory({
      productId: pid,
      leafSlug: 'carbonated',
      leafSource: 'rule',
      pendingNodeSlug: null,
      attributeSlugs: ['sugar-free'],
      rankable: true,
    });
    const attr = await t.repo.getProductAttribution(pid);
    expect(attr?.state).toBe('classified-leaf');
    expect(attr?.categoryLeafSlug).toBe('carbonated');
    expect(attr?.pendingCategorySlug).toBeNull();
    expect(attr?.rankable).toBe(true);
    expect(attr?.tags.map((x) => x.slug)).toContain('sugar-free');
  });

  it('A→B re-judgement leaves only the new leaf', async () => {
    const pid = await insertProduct(t.repo);
    await t.repo.reconcileCategory({
      productId: pid,
      leafSlug: 'carbonated',
      leafSource: 'rule',
      pendingNodeSlug: null,
      attributeSlugs: [],
      rankable: true,
    });
    await t.repo.reconcileCategory({
      productId: pid,
      leafSlug: 'juice-plant',
      leafSource: 'rule',
      pendingNodeSlug: null,
      attributeSlugs: [],
      rankable: true,
    });
    const attr = await t.repo.getProductAttribution(pid);
    expect(attr?.categoryLeafSlug).toBe('juice-plant');
    expect(await t.repo.listProductIdsInCategoryNode('carbonated')).toEqual([]);
    expect(await t.repo.listProductIdsInCategoryNode('juice-plant')).toEqual([
      pid,
    ]);
  });

  it('待细化→叶 transition leaves pending NULL (no越界态)', async () => {
    const pid = await insertProduct(t.repo);
    await t.repo.reconcileCategory({
      productId: pid,
      leafSlug: null,
      leafSource: 'rule',
      pendingNodeSlug: 'soft-drink',
      attributeSlugs: [],
      rankable: false,
    });
    expect((await t.repo.getProductAttribution(pid))?.state).toBe('pending');
    await t.repo.reconcileCategory({
      productId: pid,
      leafSlug: 'carbonated',
      leafSource: 'rule',
      pendingNodeSlug: null,
      attributeSlugs: [],
      rankable: true,
    });
    const attr = await t.repo.getProductAttribution(pid);
    expect(attr?.state).toBe('classified-leaf');
    expect(attr?.categoryLeafSlug).toBe('carbonated');
    expect(attr?.pendingCategorySlug).toBeNull();
  });

  it('verdict=待细化: no leaf, pending=non-leaf node, rankable false', async () => {
    const pid = await insertProduct(t.repo);
    await t.repo.reconcileCategory({
      productId: pid,
      leafSlug: null,
      leafSource: 'rule',
      pendingNodeSlug: 'soft-drink',
      attributeSlugs: [],
      rankable: false,
    });
    const attr = await t.repo.getProductAttribution(pid);
    expect(attr?.state).toBe('pending');
    expect(attr?.categoryLeafSlug).toBeNull();
    expect(attr?.pendingCategorySlug).toBe('soft-drink');
    expect(attr?.rankable).toBe(false);
  });

  it('verdict=待人工: no leaf, pending NULL', async () => {
    const pid = await insertProduct(t.repo);
    // Pre-seed a leaf to prove reconcile clears it on the manual verdict.
    await t.repo.reconcileCategory({
      productId: pid,
      leafSlug: 'carbonated',
      leafSource: 'rule',
      pendingNodeSlug: null,
      attributeSlugs: [],
      rankable: true,
    });
    await t.repo.reconcileCategory({
      productId: pid,
      leafSlug: null,
      leafSource: 'rule',
      pendingNodeSlug: null,
      attributeSlugs: [],
      rankable: false,
    });
    const attr = await t.repo.getProductAttribution(pid);
    expect(attr?.state).toBe('manual');
    expect(attr?.categoryLeafSlug).toBeNull();
    expect(attr?.pendingCategorySlug).toBeNull();
    expect(attr?.rankable).toBe(false);
  });

  it('idempotent: same input re-run does not duplicate product_tag', async () => {
    const pid = await insertProduct(t.repo);
    const args = {
      productId: pid,
      leafSlug: 'carbonated' as const,
      leafSource: 'rule' as const,
      pendingNodeSlug: null,
      attributeSlugs: ['sugar-free'],
      rankable: true,
    };
    await t.repo.reconcileCategory(args);
    await t.repo.reconcileCategory(args);
    // 1 leaf + 1 attribute = 2 edges, no duplicates.
    expect(countRows(t.handle, 'product_tag')).toBe(2);
  });

  it('rejects a non-leaf leafSlug', async () => {
    const pid = await insertProduct(t.repo);
    await expect(
      t.repo.reconcileCategory({
        productId: pid,
        leafSlug: 'soft-drink',
        leafSource: 'rule',
        pendingNodeSlug: null,
        attributeSlugs: [],
        rankable: false,
      }),
    ).rejects.toThrow(/not a category leaf/);
  });

  it('rejects a non-category leafSlug', async () => {
    const pid = await insertProduct(t.repo);
    await expect(
      t.repo.reconcileCategory({
        productId: pid,
        leafSlug: 'sugar-free',
        leafSource: 'rule',
        pendingNodeSlug: null,
        attributeSlugs: [],
        rankable: false,
      }),
    ).rejects.toThrow(/not a category leaf/);
  });

  it('rejects a leaf pendingNodeSlug', async () => {
    const pid = await insertProduct(t.repo);
    await expect(
      t.repo.reconcileCategory({
        productId: pid,
        leafSlug: null,
        leafSource: 'rule',
        pendingNodeSlug: 'carbonated',
        attributeSlugs: [],
        rankable: false,
      }),
    ).rejects.toThrow(/non-leaf category node/);
  });

  it('rejects a non-category pendingNodeSlug', async () => {
    const pid = await insertProduct(t.repo);
    await expect(
      t.repo.reconcileCategory({
        productId: pid,
        leafSlug: null,
        leafSource: 'rule',
        pendingNodeSlug: 'sugar-free',
        attributeSlugs: [],
        rankable: false,
      }),
    ).rejects.toThrow(/non-leaf category node/);
  });

  it('rejects a category attributeSlug', async () => {
    const pid = await insertProduct(t.repo);
    await expect(
      t.repo.reconcileCategory({
        productId: pid,
        leafSlug: null,
        leafSource: 'rule',
        pendingNodeSlug: null,
        attributeSlugs: ['carbonated'],
        rankable: false,
      }),
    ).rejects.toThrow(/must not be a category tag/);
  });

  it('rejects both leaf and pending set together', async () => {
    const pid = await insertProduct(t.repo);
    await expect(
      t.repo.reconcileCategory({
        productId: pid,
        leafSlug: 'carbonated',
        leafSource: 'rule',
        pendingNodeSlug: 'soft-drink',
        attributeSlugs: [],
        rankable: false,
      }),
    ).rejects.toThrow(/cannot set both a leaf and a pending node/);
  });

  it('rejects an unknown product', async () => {
    await expect(
      t.repo.reconcileCategory({
        productId: 'no-such-product',
        leafSlug: 'carbonated',
        leafSource: 'rule',
        pendingNodeSlug: null,
        attributeSlugs: [],
        rankable: true,
      }),
    ).rejects.toThrow(/unknown product/);
  });
});

describe('independent primitive guards (kind + existence)', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await openSeededTestDb();
  });

  it('attachTag rejects a non-leaf category tag', async () => {
    const pid = await insertProduct(t.repo);
    await expect(
      t.repo.attachTag({
        productId: pid,
        tagSlug: 'soft-drink',
        source: 'rule',
        confidence: 0.9,
      }),
    ).rejects.toThrow(/must be attached at leaf granularity/);
  });

  it('setPendingCategory rejects a leaf node', async () => {
    const pid = await insertProduct(t.repo);
    await expect(
      t.repo.setPendingCategory(pid, 'carbonated'),
    ).rejects.toThrow(/must be a non-leaf category node/);
  });

  it('setRankable rejects an unknown product', async () => {
    await expect(t.repo.setRankable('no-such-product', true)).rejects.toThrow(
      /unknown product/,
    );
  });

  it('setPendingCategory rejects an unknown product', async () => {
    await expect(
      t.repo.setPendingCategory('no-such-product', 'soft-drink'),
    ).rejects.toThrow(/unknown product/);
  });

  it('setPendingCategory refuses to create 有叶∧pending (product already has a leaf)', async () => {
    const pid = await insertProduct(t.repo);
    await t.repo.attachTag({
      productId: pid,
      tagSlug: 'carbonated',
      source: 'rule',
      confidence: 0.9,
    });
    // Setting a pending node now would leave the product with both a leaf and a
    // pending node — the越界态. The primitive must refuse.
    await expect(
      t.repo.setPendingCategory(pid, 'soft-drink'),
    ).rejects.toThrow(/有叶∧pending/);
    // Clearing pending (nodeSlug=null) is always allowed, even with a leaf.
    await expect(t.repo.setPendingCategory(pid, null)).resolves.not.toThrow();
  });

  it('attachTag refuses to attach a category leaf while pending is set (有叶∧pending)', async () => {
    const pid = await insertProduct(t.repo);
    await t.repo.setPendingCategory(pid, 'soft-drink');
    // Attaching a leaf now would create both a leaf and a pending node.
    await expect(
      t.repo.attachTag({
        productId: pid,
        tagSlug: 'carbonated',
        source: 'rule',
        confidence: 0.9,
      }),
    ).rejects.toThrow(/有叶∧pending/);
    // An ORTHOGONAL attribute attach is unaffected by a set pending node.
    await expect(
      t.repo.attachTag({
        productId: pid,
        tagSlug: 'sugar-free',
        source: 'rule',
        confidence: 0.9,
      }),
    ).resolves.not.toThrow();
  });

  it('attachTag refuses a second, different category leaf (single-attribution)', async () => {
    const pid = await insertProduct(t.repo);
    await t.repo.attachTag({
      productId: pid,
      tagSlug: 'carbonated',
      source: 'rule',
      confidence: 1,
    });
    // A DIFFERENT leaf must be refused — would create dual category leaves.
    await expect(
      t.repo.attachTag({
        productId: pid,
        tagSlug: 'juice-plant',
        source: 'rule',
        confidence: 1,
      }),
    ).rejects.toThrow(/already has a different category leaf/);
    // Re-attaching the SAME leaf stays an idempotent no-op (not a throw).
    await expect(
      t.repo.attachTag({
        productId: pid,
        tagSlug: 'carbonated',
        source: 'rule',
        confidence: 1,
      }),
    ).resolves.not.toThrow();
    // Exactly one category leaf remains.
    const attr = await t.repo.getProductAttribution(pid);
    expect(attr?.categoryLeafSlug).toBe('carbonated');
  });
});

describe('seed parity: 0004 DML migration ≡ seedTaxonomy()', () => {
  /** Apply a hand-written DML seed migration SQL onto an already-migrated handle. */
  function applySeedMigration(handle: Database.Database, file: string): void {
    const sqlPath = fileURLToPath(
      new URL(`../../drizzle/${file}`, import.meta.url),
    );
    const sql = fsReadFileSync(sqlPath, 'utf8');
    for (const stmt of sql.split('--> statement-breakpoint')) {
      if (stmt.trim()) handle.exec(stmt);
    }
  }

  /** Apply the full DML seed (0004 base tree + 0005 dairy/alcohol P3.5 delta),
   *  the order wrangler's directory scan applies them in. */
  function apply0004(handle: Database.Database): void {
    applySeedMigration(handle, '0004_seed_taxonomy.sql');
    applySeedMigration(handle, '0005_seed_dairy_alcohol_units.sql');
  }

  function readTags(handle: Database.Database) {
    return (
      handle
        .prepare(
          `SELECT c.slug AS slug, c.name AS name, c.kind AS kind,
                  p.slug AS parentSlug, c.comparable_unit AS comparableUnit
           FROM tag c LEFT JOIN tag p ON p.id = c.parent_id`,
        )
        .all() as Array<{
        slug: string;
        name: string;
        kind: string;
        parentSlug: string | null;
        comparableUnit: string | null;
      }>
    )
      .map((r) => ({
        slug: r.slug,
        name: r.name,
        kind: r.kind,
        parentSlug: r.parentSlug ?? null,
        comparableUnit: r.comparableUnit ?? null,
      }))
      .sort((a, b) => a.slug.localeCompare(b.slug));
  }

  function readClosure(handle: Database.Database) {
    return (
      handle
        .prepare(
          `SELECT t.slug AS tagSlug, a.slug AS ancestorSlug
           FROM category_closure c
           JOIN tag t ON t.id = c.tag_id
           JOIN tag a ON a.id = c.ancestor_tag_id`,
        )
        .all() as Array<{ tagSlug: string; ancestorSlug: string }>
    ).sort(
      (a, b) =>
        a.tagSlug.localeCompare(b.tagSlug) ||
        a.ancestorSlug.localeCompare(b.ancestorSlug),
    );
  }

  function readMap(handle: Database.Database) {
    return (
      handle
        .prepare(
          `SELECT m.store AS store, m.native_category_id AS nativeCategoryId,
                  t.slug AS tagSlug
           FROM store_category_map m JOIN tag t ON t.id = m.tag_id`,
        )
        .all() as Array<{
        store: string;
        nativeCategoryId: string;
        tagSlug: string;
      }>
    ).sort(
      (a, b) =>
        a.store.localeCompare(b.store) ||
        a.nativeCategoryId.localeCompare(b.nativeCategoryId),
    );
  }

  /** Raw `SELECT *` (every column, incl. id) ordered by id — for exact-row
   *  equality now that both paths write byte-identical deterministic ids. */
  function rawTags(handle: Database.Database) {
    return handle.prepare('SELECT * FROM tag ORDER BY id').all();
  }
  function rawClosure(handle: Database.Database) {
    return handle.prepare('SELECT * FROM category_closure ORDER BY id').all();
  }
  function rawMap(handle: Database.Database) {
    return handle.prepare('SELECT * FROM store_category_map ORDER BY id').all();
  }

  it('produces structurally equivalent rows (id-agnostic)', async () => {
    const a = openTestDb();
    await seedTaxonomy(a.db);

    const b = openTestDb();
    apply0004(b.handle);

    expect(readTags(b.handle)).toEqual(readTags(a.handle));
    expect(readClosure(b.handle)).toEqual(readClosure(a.handle));
    expect(readMap(b.handle)).toEqual(readMap(a.handle));

    a.handle.close();
    b.handle.close();
  });

  it('produces byte-identical rows incl. id (seedTaxonomy ≡ 0004 exactly)', async () => {
    // Deterministic ids on both paths → exact row equality, not just structural.
    // This is what makes the two writers interchangeable (the mixed-order applies
    // below are pure no-ops): closure/map rows written by one path point at the
    // same tag ids the other path writes.
    const a = openTestDb();
    await seedTaxonomy(a.db);

    const b = openTestDb();
    apply0004(b.handle);

    expect(rawTags(a.handle)).toEqual(rawTags(b.handle));
    expect(rawClosure(a.handle)).toEqual(rawClosure(b.handle));
    expect(rawMap(a.handle)).toEqual(rawMap(b.handle));

    a.handle.close();
    b.handle.close();
  });

  it('mixed order: seedTaxonomy() then apply 0004 — pure no-op, no dangling FK', async () => {
    // seedTaxonomy() and 0004 write byte-identical rows (proven by the test
    // above), so applying both to one DB is a pure no-op: every row of the second
    // writer hits an existing PK / unique index and is skipped by INSERT OR
    // IGNORE / onConflictDoNothing — no throw, no row inflation. The
    // byte-identical test is the anchor for interchangeability; this test confirms
    // the two compose without error and that no foreign key is left dangling.
    const t = openTestDb();
    await seedTaxonomy(t.db);
    const before = {
      tag: countRows(t.handle, 'tag'),
      closure: countRows(t.handle, 'category_closure'),
      map: countRows(t.handle, 'store_category_map'),
    };
    expect(() => apply0004(t.handle)).not.toThrow();
    expect(countRows(t.handle, 'tag')).toBe(before.tag);
    expect(countRows(t.handle, 'category_closure')).toBe(before.closure);
    expect(countRows(t.handle, 'store_category_map')).toBe(before.map);
    // Real integrity check: every closure/map/parent FK resolves to a tag row.
    expect(t.handle.pragma('foreign_key_check')).toEqual([]);
    t.handle.close();
  });

  it('reverse mixed order: apply 0004 then seedTaxonomy() — pure no-op, no dangling FK', async () => {
    const t = openTestDb();
    apply0004(t.handle);
    const before = {
      tag: countRows(t.handle, 'tag'),
      closure: countRows(t.handle, 'category_closure'),
      map: countRows(t.handle, 'store_category_map'),
    };
    await expect(seedTaxonomy(t.db)).resolves.not.toThrow();
    expect(countRows(t.handle, 'tag')).toBe(before.tag);
    expect(countRows(t.handle, 'category_closure')).toBe(before.closure);
    expect(countRows(t.handle, 'store_category_map')).toBe(before.map);
    expect(t.handle.pragma('foreign_key_check')).toEqual([]);
    t.handle.close();
  });

  it('0004 is idempotent — re-applying changes no row counts', async () => {
    const b = openTestDb();
    apply0004(b.handle);
    const before = {
      tag: countRows(b.handle, 'tag'),
      closure: countRows(b.handle, 'category_closure'),
      map: countRows(b.handle, 'store_category_map'),
    };
    apply0004(b.handle);
    expect(countRows(b.handle, 'tag')).toBe(before.tag);
    expect(countRows(b.handle, 'category_closure')).toBe(before.closure);
    expect(countRows(b.handle, 'store_category_map')).toBe(before.map);
    b.handle.close();
  });

  // P3.5 drift guard. The "double-fresh equivalence" tests above are BLIND to
  // the existing-row flip: on a fresh DB both writers create the 酒种 leaf rows
  // with per_100ml from the start. The real prod hazard is a DB already carrying
  // the OLD P3 tree (酒种 leaves at comparable_unit=NULL, no dairy). Here we
  // preset exactly that, then drive each path and assert BOTH converge the 酒种
  // leaves NULL→per_100ml (INSERT OR IGNORE / onConflictDoNothing alone would
  // not — the explicit UPDATE must).
  function presetOldP3Tree(handle: Database.Database): void {
    applySeedMigration(handle, '0004_seed_taxonomy.sql');
    // Sanity: the preset really has the old state (NULL on 酒种 leaves, no dairy).
    const before = handle
      .prepare(
        "SELECT comparable_unit AS u FROM tag WHERE slug = 'baijiu'",
      )
      .get() as { u: string | null };
    expect(before.u).toBeNull();
    expect(
      handle.prepare("SELECT id FROM tag WHERE slug = 'dairy'").get(),
    ).toBeUndefined();
  }

  function alcoholLeafUnits(handle: Database.Database): Array<string | null> {
    return (
      handle
        .prepare(
          "SELECT comparable_unit AS u FROM tag WHERE slug IN ('baijiu','wine','spirits','whisky','beer','sake-fruit-wine') ORDER BY slug",
        )
        .all() as Array<{ u: string | null }>
    ).map((r) => r.u);
  }

  it('preset old P3 tree → 0005 migration flips 酒种 leaves NULL→per_100ml + adds dairy', async () => {
    const t = openTestDb();
    presetOldP3Tree(t.handle);
    applySeedMigration(t.handle, '0005_seed_dairy_alcohol_units.sql');
    // All 6 酒种 leaves converged to per_100ml.
    expect(alcoholLeafUnits(t.handle)).toEqual(Array(6).fill('per_100ml'));
    // Dairy subtree present; 乳品 binds per_100ml, leaves inherit (column NULL).
    const dairy = t.handle
      .prepare("SELECT comparable_unit AS u FROM tag WHERE slug = 'dairy'")
      .get() as { u: string | null };
    expect(dairy.u).toBe('per_100ml');
    for (const leaf of ['milk', 'yogurt', 'lactic-drink']) {
      const row = t.handle
        .prepare('SELECT comparable_unit AS u FROM tag WHERE slug = ?')
        .get(leaf) as { u: string | null };
      expect(row.u).toBeNull();
    }
    expect(t.handle.pragma('foreign_key_check')).toEqual([]);
    t.handle.close();
  });

  it('preset old P3 tree → seedTaxonomy() flips 酒种 leaves NULL→per_100ml + adds dairy', async () => {
    const t = openTestDb();
    presetOldP3Tree(t.handle);
    await seedTaxonomy(t.db);
    expect(alcoholLeafUnits(t.handle)).toEqual(Array(6).fill('per_100ml'));
    const dairy = t.handle
      .prepare("SELECT comparable_unit AS u FROM tag WHERE slug = 'dairy'")
      .get() as { u: string | null };
    expect(dairy.u).toBe('per_100ml');
    // seedTaxonomy's two-pass insert must NOT have clobbered an existing row's
    // parent/name (the explicit UPDATE only touches comparable_unit).
    const wine = t.handle
      .prepare(
        `SELECT c.name AS name, p.slug AS parentSlug
         FROM tag c LEFT JOIN tag p ON p.id = c.parent_id WHERE c.slug = 'wine'`,
      )
      .get() as { name: string; parentSlug: string | null };
    expect(wine).toEqual({ name: '葡萄酒', parentSlug: 'alcohol' });
    expect(t.handle.pragma('foreign_key_check')).toEqual([]);
    t.handle.close();
  });

  it('preset old P3 tree → both paths converge to the SAME tree (migration ≡ seedTaxonomy on existing rows)', async () => {
    const a = openTestDb();
    presetOldP3Tree(a.handle);
    applySeedMigration(a.handle, '0005_seed_dairy_alcohol_units.sql');

    const b = openTestDb();
    presetOldP3Tree(b.handle);
    await seedTaxonomy(b.db);

    expect(readTags(a.handle)).toEqual(readTags(b.handle));
    expect(readClosure(a.handle)).toEqual(readClosure(b.handle));
    a.handle.close();
    b.handle.close();
  });
});
