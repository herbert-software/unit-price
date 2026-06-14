// Tagging pipeline + backfill tests (3.4). Uses a REAL in-memory better-sqlite3
// repo with the @unit-price/db migrations applied AND the canonical taxonomy
// seeded (tag tree / attributes / closure / Sam store_category_map) — mirroring
// the package's openSeededTestDb harness (openTestDb + seedTaxonomy) without
// depending on its un-exported test file. Asserts leaf attribution + attributes
// + rankable derivation + the 待人工/待细化 branches, re-run idempotency, rule-
// re-decision single-attribution convergence, and that NO LLM is ever called.
import Database from 'better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
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
  type Repository,
} from '@unit-price/db';
import { runBackfill, tagProduct } from './tagging.js';

const migrationsFolder = fileURLToPath(
  new URL('../../../packages/db/drizzle', import.meta.url),
);

interface SeededDb {
  handle: Database.Database;
  repo: Repository;
  db: ReturnType<typeof createDb>;
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

/**
 * Land one product (product_raw + product + unit_price) via the real repo. When
 * `nativeCategoryId` is given it rides on product_raw.category_hint — used by the
 * DIRECT tagProduct store-map tests (which pass nativeCategoryId explicitly). The
 * backfill does NOT consume it this period (it feeds nativeCategoryId=null,
 * store-map lazy — see design D9). Returns the product id.
 */
async function landProduct(
  repo: Repository,
  opts: {
    title: string;
    price: number;
    store: string;
    storeSku: string;
    /** Store-native category id (rides on product_raw.category_hint). */
    nativeCategoryId?: string;
  },
): Promise<string> {
  const rawId = await repo.upsertRaw({
    store: opts.store,
    storeSku: opts.storeSku,
    raw: {
      title: opts.title,
      price: opts.price,
      ...(opts.nativeCategoryId ? { categoryHint: opts.nativeCategoryId } : {}),
    },
  });
  const spec: ParsedSpec = parseTier1({
    title: opts.title,
    price: opts.price,
    ...(opts.nativeCategoryId ? { categoryHint: opts.nativeCategoryId } : {}),
  }).spec;
  const calc: CalcResult = calculate(spec, opts.price);
  const { productId } = await repo.saveParsed({ rawId, spec, calc });
  return productId;
}

describe('tagProduct — leaf attribution + attributes + rankable (3.1/3.4)', () => {
  it('tier1 carbonated leaf → classified-leaf, rankable=true, category column untouched', async () => {
    const { repo, handle } = await openSeeded();
    const id = await landProduct(repo, {
      title: '可口可乐 330ml*24听',
      price: 40,
      store: 'sam',
      storeSku: 'coke-24',
    });
    const result = await tagProduct(repo, {
      productId: id,
      title: '可口可乐 330ml*24听',
      store: 'sam',
      nativeCategoryId: null,
    });
    expect(result.verdict).toEqual({
      verdict: 'leaf',
      leafSlug: 'carbonated',
      decidedBy: 'tier1',
    });
    expect(result.rankable).toBe(true);

    const attr = await repo.getProductAttribution(id);
    expect(attr?.state).toBe('classified-leaf');
    expect(attr?.categoryLeafSlug).toBe('carbonated');
    expect(attr?.pendingCategorySlug).toBeNull();
    expect(attr?.rankable).toBe(true);
    // product.category column is NEVER touched — still "beverage".
    const row = handle
      .prepare('SELECT category FROM product WHERE id = ?')
      .get(id) as { category: string };
    expect(row.category).toBe('beverage');
  });

  it('气泡水 → drinking-water leaf + sparkling attribute (not carbonated)', async () => {
    const { repo } = await openSeeded();
    const title = '屈臣氏苏打水 330ml*24';
    const id = await landProduct(repo, {
      title,
      price: 50,
      store: 'sam',
      storeSku: 'soda-24',
    });
    const result = await tagProduct(repo, {
      productId: id,
      title,
      store: 'sam',
      nativeCategoryId: null,
    });
    expect(result.leafSlug).toBe('drinking-water');
    expect(result.attributeSlugs).toContain('sparkling');
    expect(result.rankable).toBe(true);

    const attr = await repo.getProductAttribution(id);
    expect(attr?.categoryLeafSlug).toBe('drinking-water');
    // sparkling attribute attached (orthogonal axis).
    expect(attr?.tags.some((t) => t.kind === 'attribute' && t.slug === 'sparkling')).toBe(true);
    // NOT a member of carbonated (closure search by category leaf).
    const carbonatedMembers = await repo.listProductIdsInCategoryNode('carbonated');
    expect(carbonatedMembers).not.toContain(id);
  });

  it('sugar-free attribute attaches alongside the carbonated leaf', async () => {
    const { repo } = await openSeeded();
    const title = '可口可乐无糖 330ml*24';
    const id = await landProduct(repo, { title, price: 40, store: 'sam', storeSku: 'coke-zero-24' });
    await tagProduct(repo, { productId: id, title, store: 'sam', nativeCategoryId: null });
    const attr = await repo.getProductAttribution(id);
    expect(attr?.categoryLeafSlug).toBe('carbonated');
    expect(attr?.tags.some((t) => t.kind === 'attribute' && t.slug === 'sugar-free')).toBe(true);
  });
});

describe('tagProduct — store-map branches (3.1)', () => {
  it('store-map soft-drink leaf (tier1 miss) → take store-map leaf', async () => {
    const { repo } = await openSeeded();
    // Title with no tier1 leaf keyword, but Sam native 10003380 → carbonated.
    const title = '神秘饮料 330ml*24';
    const id = await landProduct(repo, {
      title,
      price: 30,
      store: 'sam',
      storeSku: 'mystery-24',
      nativeCategoryId: '10003380',
    });
    const result = await tagProduct(repo, {
      productId: id,
      title,
      store: 'sam',
      nativeCategoryId: '10003380',
    });
    expect(result.verdict).toEqual({
      verdict: 'leaf',
      leafSlug: 'carbonated',
      decidedBy: 'store-map',
    });
    expect(result.rankable).toBe(true);
    const attr = await repo.getProductAttribution(id);
    expect(attr?.categoryLeafSlug).toBe('carbonated');
    // Provenance: the leaf edge is sourced store-map.
    expect(attr?.tags.find((t) => t.slug === 'carbonated')?.source).toBe('store-map');
  });

  it('store-map alcohol leaf → classified-leaf (store-map source), pending NULL, rankable=false', async () => {
    const { repo } = await openSeeded();
    // Sam native 10012172 → beer (an alcohol LEAF, not a v1 soft-drink leaf).
    const title = '某啤酒礼盒';
    const id = await landProduct(repo, {
      title,
      price: 100,
      store: 'sam',
      storeSku: 'beer-box',
      nativeCategoryId: '10012172',
    });
    // Note: title has no soft-drink keyword (`啤酒` is not a tier1 leaf keyword).
    const result = await tagProduct(repo, {
      productId: id,
      title,
      store: 'sam',
      nativeCategoryId: '10012172',
    });
    // An alcohol leaf is a determinate leaf (已分类叶), NOT 待细化 — pending must
    // never point at a leaf. rankable=false only because beer resolves
    // comparable_unit null.
    expect(result.verdict).toEqual({
      verdict: 'leaf',
      leafSlug: 'beer',
      decidedBy: 'store-map',
    });
    expect(result.rankable).toBe(false);
    const attr = await repo.getProductAttribution(id);
    expect(attr?.state).toBe('classified-leaf');
    expect(attr?.categoryLeafSlug).toBe('beer');
    expect(attr?.pendingCategorySlug).toBeNull();
    expect(attr?.rankable).toBe(false);
    // Provenance: the leaf edge is sourced store-map.
    expect(attr?.tags.find((t) => t.slug === 'beer')?.source).toBe('store-map');
  });

  it('store-map coarse (non-leaf) node → 待细化 pending pointing at the non-leaf', async () => {
    const { repo, handle } = await openSeeded();
    // Seed a coarse-node map row directly (the canonical seed maps only leaf
    // natives): native "coarse-native" → soft-drink (a non-leaf coarse node).
    const softDrinkTagId = (
      handle.prepare("SELECT id FROM tag WHERE slug = 'soft-drink'").get() as {
        id: string;
      }
    ).id;
    handle
      .prepare(
        "INSERT INTO store_category_map (id, store, native_category_id, tag_id) VALUES ('m-coarse', 'sam', 'coarse-native', ?)",
      )
      .run(softDrinkTagId);
    // Title has no tier1 keyword → store-map is the only signal; it is coarse.
    const title = '神秘饮品礼盒 1套';
    const id = await landProduct(repo, {
      title,
      price: 30,
      store: 'sam',
      storeSku: 'coarse-box',
      nativeCategoryId: 'coarse-native',
    });
    const result = await tagProduct(repo, {
      productId: id,
      title,
      store: 'sam',
      nativeCategoryId: 'coarse-native',
    });
    expect(result.verdict).toEqual({
      verdict: 'pending',
      pendingNodeSlug: 'soft-drink',
    });
    expect(result.rankable).toBe(false);
    const attr = await repo.getProductAttribution(id);
    expect(attr?.state).toBe('pending');
    expect(attr?.categoryLeafSlug).toBeNull();
    // pending points at the coarse non-leaf node.
    expect(attr?.pendingCategorySlug).toBe('soft-drink');
  });

  it('unmapped native + tier1 miss → 待人工 (no leaf, no pending), not force-assigned', async () => {
    const { repo, handle } = await openSeeded();
    // Use a title with zero tier1 keywords to land 待人工.
    const cleanTitle = '神秘赠品礼盒 1套';
    const id = await landProduct(repo, {
      title: cleanTitle,
      price: 20,
      store: 'sam',
      storeSku: 'gift-set',
      nativeCategoryId: '99999999', // not in store_category_map
    });
    // Capture the category column AS LANDED (before tagging) — the tagging
    // pipeline must never CHANGE it (it does not write product.category at all).
    const before = (
      handle.prepare('SELECT category FROM product WHERE id = ?').get(id) as { category: string }
    ).category;
    const result = await tagProduct(repo, {
      productId: id,
      title: cleanTitle,
      store: 'sam',
      nativeCategoryId: '99999999',
    });
    expect(result.verdict.verdict).toBe('manual');
    expect(result.rankable).toBe(false);
    const attr = await repo.getProductAttribution(id);
    expect(attr?.state).toBe('manual');
    expect(attr?.categoryLeafSlug).toBeNull();
    expect(attr?.pendingCategorySlug).toBeNull();
    // category column untouched by the pipeline (same value as before tagging).
    const after = (
      handle.prepare('SELECT category FROM product WHERE id = ?').get(id) as { category: string }
    ).category;
    expect(after).toBe(before);
  });
});

describe('tagProduct — three-state reconcile / single-attribution convergence (3.1)', () => {
  it('rule re-decision A→B leaves only leaf B (no residual A); rankable recomputed', async () => {
    const { repo } = await openSeeded();
    const idTitle = 'reuse-id';
    const id = await landProduct(repo, {
      title: '可口可乐 330ml*24听',
      price: 40,
      store: 'sam',
      storeSku: idTitle,
    });
    // First pass: title says carbonated.
    await tagProduct(repo, { productId: id, title: '可口可乐 330ml*24听', store: 'sam', nativeCategoryId: null });
    let attr = await repo.getProductAttribution(id);
    expect(attr?.categoryLeafSlug).toBe('carbonated');

    // Second pass with a re-decided title (果汁 → juice-plant).
    await tagProduct(repo, { productId: id, title: '鲜榨果汁 330ml*24', store: 'sam', nativeCategoryId: null });
    attr = await repo.getProductAttribution(id);
    expect(attr?.categoryLeafSlug).toBe('juice-plant');
    // Exactly one kind=category leaf remains.
    const categoryLeaves = attr!.tags.filter((t) => t.kind === 'category');
    expect(categoryLeaves.map((t) => t.slug)).toEqual(['juice-plant']);
    expect(attr?.rankable).toBe(true);
  });

  it('leaf → 待人工 transition removes the old leaf (no residual, no 越界态)', async () => {
    const { repo } = await openSeeded();
    const id = await landProduct(repo, { title: '可口可乐 330ml*24听', price: 40, store: 'sam', storeSku: 'coke-x' });
    await tagProduct(repo, { productId: id, title: '可口可乐 330ml*24听', store: 'sam', nativeCategoryId: null });
    expect((await repo.getProductAttribution(id))?.categoryLeafSlug).toBe('carbonated');
    // Re-tag with a no-keyword title and no native → 待人工: leaf must be removed.
    await tagProduct(repo, { productId: id, title: '神秘赠品 1套', store: 'sam', nativeCategoryId: null });
    const attr = await repo.getProductAttribution(id);
    expect(attr?.state).toBe('manual');
    expect(attr?.categoryLeafSlug).toBeNull();
    expect(attr?.pendingCategorySlug).toBeNull();
    expect(attr?.rankable).toBe(false);
  });

  it('待细化 → 命中叶 clears pending (no "有叶 ∧ pending 非空" 越界态)', async () => {
    const { repo, handle } = await openSeeded();
    // Land pending first via a coarse-node store-map (the canonical seed maps
    // only leaf natives, so seed a coarse row directly): native "coarse-native"
    // → soft-drink (a non-leaf), with no tier1 keyword in the title.
    const softDrinkTagId = (
      handle.prepare("SELECT id FROM tag WHERE slug = 'soft-drink'").get() as {
        id: string;
      }
    ).id;
    handle
      .prepare(
        "INSERT INTO store_category_map (id, store, native_category_id, tag_id) VALUES ('m-coarse-rec', 'sam', 'coarse-native', ?)",
      )
      .run(softDrinkTagId);
    const id = await landProduct(repo, { title: '神秘饮品礼盒', price: 80, store: 'sam', storeSku: 'coarse-rec', nativeCategoryId: 'coarse-native' });
    await tagProduct(repo, { productId: id, title: '神秘饮品礼盒', store: 'sam', nativeCategoryId: 'coarse-native' });
    let attr = await repo.getProductAttribution(id);
    expect(attr?.state).toBe('pending');
    expect(attr?.pendingCategorySlug).toBe('soft-drink');
    // Now re-tag with a carbonated title (tier1 hits a leaf) → leaf + pending cleared.
    await tagProduct(repo, { productId: id, title: '可乐 330ml*24', store: 'sam', nativeCategoryId: 'coarse-native' });
    attr = await repo.getProductAttribution(id);
    expect(attr?.state).toBe('classified-leaf');
    expect(attr?.categoryLeafSlug).toBe('carbonated');
    expect(attr?.pendingCategorySlug).toBeNull(); // 落叶必清 pending
  });

  it('reconcile never removes orthogonal attribute edges', async () => {
    const { repo } = await openSeeded();
    const id = await landProduct(repo, { title: '可口可乐无糖 330ml*24', price: 40, store: 'sam', storeSku: 'coke-zero-y' });
    await tagProduct(repo, { productId: id, title: '可口可乐无糖 330ml*24', store: 'sam', nativeCategoryId: null });
    // Re-tag (re-decision) — sugar-free attribute (if still in title) survives.
    await tagProduct(repo, { productId: id, title: '可口可乐无糖 330ml*24', store: 'sam', nativeCategoryId: null });
    const attr = await repo.getProductAttribution(id);
    expect(attr?.tags.some((t) => t.kind === 'attribute' && t.slug === 'sugar-free')).toBe(true);
    const categoryLeaves = attr!.tags.filter((t) => t.kind === 'category');
    expect(categoryLeaves).toHaveLength(1);
  });
});

describe('runBackfill — full stock, idempotent, no LLM (3.2/3.4)', () => {
  it('backfills every product via tier1 (store-map LAZY), derives state + rankable, re-run idempotent', async () => {
    const { repo, db, handle } = await openSeeded();

    // Seed a coarse-node map row + rely on the canonical leaf-native seeds so the
    // sample WOULD cover store-map branches IF the backfill fed native ids — it
    // does NOT this period (lazy), so these natives are inert in the backfill.
    const softDrinkTagId = (
      handle.prepare("SELECT id FROM tag WHERE slug = 'soft-drink'").get() as {
        id: string;
      }
    ).id;
    handle
      .prepare(
        "INSERT INTO store_category_map (id, store, native_category_id, tag_id) VALUES ('m-coarse-bf', 'sam', 'coarse-native', ?)",
      )
      .run(softDrinkTagId);

    // Land a representative sample. Note the native ids are carried on
    // product_raw.category_hint for landing, but the backfill IGNORES them (it
    // feeds nativeCategoryId=null), so only tier1 keyword titles classify:
    //   可口可乐  → tier1 carbonated (classified, rankable)
    //   神秘饮料  + native 10003380   → store-map carbonated IF fed, but tier1 miss → 待人工
    //   某啤酒礼盒 + native 10012172  → store-map beer IF fed, but tier1 miss → 待人工
    //   神秘饮品盒 + native coarse    → store-map pending IF fed, but tier1 miss → 待人工
    //   神秘赠品  → tier1 miss → 待人工
    await landProduct(repo, { title: '可口可乐 330ml*24听', price: 40, store: 'sam', storeSku: 's-coke' });
    await landProduct(repo, { title: '神秘饮料 330ml*24', price: 30, store: 'sam', storeSku: 's-mystery', nativeCategoryId: '10003380' });
    await landProduct(repo, { title: '某啤酒礼盒', price: 100, store: 'sam', storeSku: 's-beer', nativeCategoryId: '10012172' });
    await landProduct(repo, { title: '神秘饮品盒 1套', price: 25, store: 'sam', storeSku: 's-coarse', nativeCategoryId: 'coarse-native' });
    await landProduct(repo, { title: '神秘赠品 1套', price: 20, store: 'sam', storeSku: 's-gift' });

    const first = await runBackfill(repo, db);
    expect(first.total).toBe(5);
    // store-map LAZY: only the tier1 carbonated title classifies; every native-id
    // -only product lands 待人工 (the seed rows are inert in the backfill).
    expect(first.classified).toBe(1); // carbonated (tier1 only)
    expect(first.pending).toBe(0); // coarse store-map never consulted
    expect(first.manual).toBe(4); // mystery/beer/coarse/gift all tier1-miss
    expect(first.rankable).toBe(1); // the carbonated leaf

    // Snapshot the product_tag rows for idempotency comparison.
    const tagCountBefore = (handle.prepare('SELECT count(*) AS c FROM product_tag').get() as { c: number }).c;

    // Re-run on the same snapshot → identical summary + no duplicate edges.
    const second = await runBackfill(repo, db);
    expect(second.total).toBe(5);
    expect(second.classified).toBe(1);
    expect(second.pending).toBe(0);
    expect(second.manual).toBe(4);
    expect(second.rankable).toBe(1);
    const tagCountAfter = (handle.prepare('SELECT count(*) AS c FROM product_tag').get() as { c: number }).c;
    expect(tagCountAfter).toBe(tagCountBefore);

    // No-LLM red line is structural, not spy-enforced: tagProduct/runBackfill take
    // no LLM port, and tagging.ts imports no LLM/provider module — only core rules,
    // db types/schema, and Drizzle query helpers — so no seam can invoke an LLM.
  });

  it('backfill is store-map LAZY: a product classifiable ONLY by a store native id lands 待人工', async () => {
    // Even though the canonical seed maps Sam native 10003380 → carbonated, the
    // backfill does not feed native ids this period, so a title with no tier1
    // keyword stays 待人工 — proving the backfill's classification is tier1-only.
    const { repo, db } = await openSeeded();
    const id = await landProduct(repo, {
      title: '神秘饮料 330ml*24', // no tier1 leaf keyword
      price: 30,
      store: 'sam',
      storeSku: 's-lazy',
      nativeCategoryId: '10003380', // seeded → carbonated, but inert in backfill
    });
    const result = await runBackfill(repo, db);
    expect(result.classified).toBe(0);
    expect(result.manual).toBe(1);
    const attr = await repo.getProductAttribution(id);
    expect(attr?.state).toBe('manual');
    expect(attr?.categoryLeafSlug).toBeNull();
    expect(attr?.pendingCategorySlug).toBeNull();
    expect(attr?.rankable).toBe(false);
  });

  it('backfill closure membership: a carbonated product is a member of soft-drink AND root', async () => {
    const { repo, db } = await openSeeded();
    const id = await landProduct(repo, { title: '雪碧 330ml*24', price: 36, store: 'sam', storeSku: 'sprite-24' });
    await runBackfill(repo, db);
    expect(await repo.listProductIdsInCategoryNode('carbonated')).toContain(id);
    expect(await repo.listProductIdsInCategoryNode('soft-drink')).toContain(id);
    expect(await repo.listProductIdsInCategoryNode('beverage')).toContain(id);
  });
});
