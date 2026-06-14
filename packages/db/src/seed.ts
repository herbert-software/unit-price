// Reproducible, idempotent seed for the canonical taxonomy: the category is-a
// tree (with single-point `comparable_unit` binding), controlled attributes,
// the Sam `store_category_map`, and the materialized `category_closure`.
//
// This is seed DATA + a deterministic writer — no IO beyond the injected Db,
// no domain computation. The category tree is store-agnostic (derived from
// Sam's 酒水饮料 navigation tree but named in our own canonical slugs); Sam's
// native `categoryIdList` leaf ids are mapped INTO it via `store_category_map`.
//
// Idempotency: every row keys on a natural unique index (`tag.slug`,
// `(product_id, tag_id)` n/a here, `(store, native_category_id)`,
// `(tag_id, ancestor_tag_id)`), and the writer uses onConflictDoNothing on
// those — re-running the seed against an already-seeded DB is a no-op.
//
// Scope (v1): `comparable_unit` is bound only on `软饮` (per_100ml). Leaves
// inherit via `resolveComparableUnit`, NOT a per-leaf duplicate. The v2
// placeholder units `per_100g` / `per_100sheet` are deliberately NOT seeded.
import {
  CategoryLeafSlugSchema,
  type AttributeSlug,
  type CategoryLeafSlug,
  type ComparableUnit,
  type TagKind,
} from '@unit-price/core';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { Db } from './db.js';
import { categoryClosure, storeCategoryMap, tag } from './schema.js';

/**
 * A category-tree node, store-agnostic. `parentSlug=null` marks the root.
 * `comparableUnit` is the single-point binding (only `软饮` carries it this
 * period); a node whose own value is undefined inherits the nearest non-null
 * ancestor at resolve time (see `resolveComparableUnit`).
 */
export interface CategoryNodeSeed {
  slug: string;
  name: string;
  parentSlug: string | null;
  comparableUnit?: ComparableUnit | null;
}

/**
 * Canonical category is-a tree (our naming; derived from Sam's 酒水饮料 tree,
 * marketing/brand nodes stripped). `comparable_unit` is bound ONLY on `软饮`
 * (per_100ml); soft-drink leaves inherit it. `酒类` and its leaves are null →
 * `rankable=false` this period. Order matters only loosely (parents are
 * resolved by slug at write time), but is kept root→leaf for readability.
 */
export const CATEGORY_NODES: readonly CategoryNodeSeed[] = [
  // root
  { slug: 'beverage', name: '饮料', parentSlug: null, comparableUnit: null },
  // 软饮 — single-point comparable_unit binding; children inherit.
  {
    slug: 'soft-drink',
    name: '软饮',
    parentSlug: 'beverage',
    comparableUnit: 'per_100ml',
  },
  // soft-drink leaves (the four tier1 leaves; comparable_unit inherited).
  { slug: 'carbonated', name: '碳酸饮料', parentSlug: 'soft-drink' },
  { slug: 'juice-plant', name: '果汁·植物饮', parentSlug: 'soft-drink' },
  { slug: 'coffee-tea', name: '咖啡·茶饮', parentSlug: 'soft-drink' },
  { slug: 'drinking-water', name: '饮用水', parentSlug: 'soft-drink' },
  // 酒类 subtree — comparable_unit null (rankable=false this period).
  { slug: 'alcohol', name: '酒类', parentSlug: 'beverage', comparableUnit: null },
  { slug: 'baijiu', name: '白酒', parentSlug: 'alcohol' },
  { slug: 'wine', name: '葡萄酒', parentSlug: 'alcohol' },
  { slug: 'spirits', name: '洋酒', parentSlug: 'alcohol' },
  { slug: 'whisky', name: '威士忌', parentSlug: 'alcohol' },
  { slug: 'beer', name: '啤酒', parentSlug: 'alcohol' },
  { slug: 'sake-fruit-wine', name: '清酒果酒', parentSlug: 'alcohol' },
];

/**
 * Compile-time guard: every tier1 `CategoryLeafSlug` must exist as a seeded
 * category node (so arbitration leaf verdicts always resolve to a real tag).
 * If a leaf slug is added in core without seeding it here, this throws at
 * module load in tests.
 */
const SEEDED_SLUGS = new Set(CATEGORY_NODES.map((n) => n.slug));
for (const leaf of CategoryLeafSlugSchema.options as readonly CategoryLeafSlug[]) {
  if (!SEEDED_SLUGS.has(leaf)) {
    throw new Error(
      `seed taxonomy: tier1 leaf "${leaf}" has no seeded category node`,
    );
  }
}

/** Controlled attribute values (flat axis; no parent, no comparable_unit). */
export interface AttributeSeed {
  slug: AttributeSlug;
  name: string;
}

export const ATTRIBUTE_NODES: readonly AttributeSeed[] = [
  { slug: 'sugar-free', name: '无糖' },
  { slug: 'sparkling', name: '气泡' },
  { slug: 'imported', name: '进口' },
];

/**
 * Sam `store_category_map` rows: native `categoryIdList` LEAF ids → our tag
 * slug. Hand-curated from the Sam HAR ([[sam-category-taxonomy]]). These native
 * ids are leaf-level (path末端), so they map to our leaf tags — this is a
 * leaf→leaf mapping, NOT a coarse-native→leaf下放 (which is forbidden).
 *
 * Partial by design: only ids with a confident v1-tree node are seeded; a Sam
 * native with no corresponding node is NOT seeded (left to 待人工). The soft-
 * drink ids (carbonated 10003380, juice-plant 10012082) are the v1 穿刺线;
 * alcohol leaf ids are mapped for completeness (alcohol is rankable=false).
 *
 * NOTE: precise per-store native ids for `咖啡·茶饮` and `饮用水` were not
 * isolated in the HAR (the capture was alcohol-heavy); those rows are
 * intentionally omitted until a soft-drink-heavy HAR pins their leaf ids —
 * tier1 keyword rules (core) remain the primary path for them.
 */
export interface StoreCategoryMapSeed {
  store: string;
  nativeCategoryId: string;
  /** Target tag slug; must be a seeded category node. */
  tagSlug: string;
}

export const SAM_STORE = 'sam';

export const SAM_CATEGORY_MAP: readonly StoreCategoryMapSeed[] = [
  // 软饮叶(v1 穿刺线)。
  { store: SAM_STORE, nativeCategoryId: '10003380', tagSlug: 'carbonated' },
  { store: SAM_STORE, nativeCategoryId: '10012082', tagSlug: 'juice-plant' },
  // 酒类叶(rankable=false;leaf→leaf,非下放)。
  { store: SAM_STORE, nativeCategoryId: '10012180', tagSlug: 'wine' },
  { store: SAM_STORE, nativeCategoryId: '10012178', tagSlug: 'wine' },
  { store: SAM_STORE, nativeCategoryId: '10012182', tagSlug: 'wine' },
  { store: SAM_STORE, nativeCategoryId: '10007844', tagSlug: 'wine' },
  { store: SAM_STORE, nativeCategoryId: '10012164', tagSlug: 'baijiu' },
  { store: SAM_STORE, nativeCategoryId: '10012165', tagSlug: 'baijiu' },
  { store: SAM_STORE, nativeCategoryId: '10012166', tagSlug: 'baijiu' },
  { store: SAM_STORE, nativeCategoryId: '10012187', tagSlug: 'whisky' },
  { store: SAM_STORE, nativeCategoryId: '10012188', tagSlug: 'whisky' },
  { store: SAM_STORE, nativeCategoryId: '10012172', tagSlug: 'beer' },
  { store: SAM_STORE, nativeCategoryId: '10012170', tagSlug: 'beer' },
  { store: SAM_STORE, nativeCategoryId: '10012190', tagSlug: 'spirits' },
];

/**
 * Both drivers share the sqlite-core query-builder surface; the seed uses no
 * transactions, so a single typed code path suffices (mirrors repository.ts).
 */
function seedOrm(db: Db): BetterSQLite3Database<Record<string, never>> {
  return db.orm as unknown as BetterSQLite3Database<Record<string, never>>;
}

/**
 * Compute the closure rows for the canonical tree from `CATEGORY_NODES`: for
 * every category node, one `(node, ancestor)` row per ancestor up to root,
 * INCLUDING the self row (`node, node`). Pure (no IO): operates on the seed
 * data only. The self row lets a leaf JOIN itself so it is a member of its own
 * node; the chain-to-root rows make it a member of every ancestor (e.g.
 * `碳酸饮料 → 软饮 → 饮料`).
 */
export function computeClosurePairs(): Array<{
  tagSlug: string;
  ancestorSlug: string;
}> {
  const parentOf = new Map<string, string | null>(
    CATEGORY_NODES.map((n) => [n.slug, n.parentSlug]),
  );
  const pairs: Array<{ tagSlug: string; ancestorSlug: string }> = [];
  for (const node of CATEGORY_NODES) {
    let cursor: string | null = node.slug;
    while (cursor != null) {
      pairs.push({ tagSlug: node.slug, ancestorSlug: cursor });
      cursor = parentOf.get(cursor) ?? null;
    }
  }
  return pairs;
}

/**
 * Write the canonical taxonomy seed into the database, idempotently. Safe to
 * run repeatedly (e.g. after every migrate): all inserts use
 * onConflictDoNothing on the natural unique index, so a second run is a no-op
 * and never duplicates rows or throws. Resolves slugs → ids in-process; never
 * recomputes ids for existing rows (slug is the stable key).
 *
 * Order: tags first (so FK targets exist), then closure + store_category_map.
 */
export async function seedTaxonomy(db: Db): Promise<void> {
  const orm = seedOrm(db);

  // 1. Tags (category tree + attributes). Insert by slug, skip if present.
  const allTags: Array<{
    slug: string;
    name: string;
    kind: TagKind;
    parentSlug: string | null;
    comparableUnit: ComparableUnit | null;
  }> = [
    ...CATEGORY_NODES.map((n) => ({
      slug: n.slug,
      name: n.name,
      kind: 'category' as TagKind,
      parentSlug: n.parentSlug,
      comparableUnit: n.comparableUnit ?? null,
    })),
    ...ATTRIBUTE_NODES.map((a) => ({
      slug: a.slug,
      name: a.name,
      kind: 'attribute' as TagKind,
      parentSlug: null,
      comparableUnit: null,
    })),
  ];

  // Insert tags without parent first, then resolve parent ids in a second pass
  // — avoids depending on insertion order for self-FK resolution and keeps the
  // writer idempotent (a re-run skips the insert and the update is a no-op).
  // Deterministic ids (tag_<slug>) match the 0004 DML seed byte-for-byte, so a
  // DB seeded by either path carries identical FK targets — closure/map rows
  // written by one path resolve against tags written by the other.
  for (const t of allTags) {
    await orm
      .insert(tag)
      .values({
        id: `tag_${t.slug}`,
        slug: t.slug,
        name: t.name,
        kind: t.kind,
        parentId: null,
        comparableUnit: t.comparableUnit,
      })
      .onConflictDoNothing({ target: tag.slug });
  }

  const slugToId = await loadSlugIndex(orm);

  // Resolve parent ids now that all category nodes exist.
  for (const n of CATEGORY_NODES) {
    if (n.parentSlug == null) continue;
    const childId = slugToId.get(n.slug);
    const parentId = slugToId.get(n.parentSlug);
    if (childId == null || parentId == null) {
      throw new Error(
        `seed taxonomy: cannot resolve parent ${n.parentSlug} of ${n.slug}`,
      );
    }
    await orm.update(tag).set({ parentId }).where(eq(tag.id, childId));
  }

  // 2. category_closure — full ancestor set (incl. self) for every category
  // node. Idempotent on (tag_id, ancestor_tag_id).
  for (const pair of computeClosurePairs()) {
    const tagId = slugToId.get(pair.tagSlug);
    const ancestorId = slugToId.get(pair.ancestorSlug);
    if (tagId == null || ancestorId == null) {
      throw new Error(
        `seed taxonomy: closure references unknown slug ${pair.tagSlug}/${pair.ancestorSlug}`,
      );
    }
    await orm
      .insert(categoryClosure)
      .values({
        id: `clo_${pair.tagSlug}__${pair.ancestorSlug}`,
        tagId,
        ancestorTagId: ancestorId,
      })
      .onConflictDoNothing({
        target: [categoryClosure.tagId, categoryClosure.ancestorTagId],
      });
  }

  // 3. store_category_map — Sam native leaf ids → our tags. Idempotent on
  // (store, native_category_id).
  for (const m of SAM_CATEGORY_MAP) {
    const tagId = slugToId.get(m.tagSlug);
    if (tagId == null) {
      throw new Error(
        `seed taxonomy: store_category_map references unknown tag ${m.tagSlug}`,
      );
    }
    await orm
      .insert(storeCategoryMap)
      .values({
        id: `scm_${m.store}_${m.nativeCategoryId}`,
        store: m.store,
        nativeCategoryId: m.nativeCategoryId,
        tagId,
      })
      .onConflictDoNothing({
        target: [storeCategoryMap.store, storeCategoryMap.nativeCategoryId],
      });
  }
}

/** Load a slug→id map for every tag currently in the table. */
async function loadSlugIndex(
  orm: BetterSQLite3Database<Record<string, never>>,
): Promise<Map<string, string>> {
  const rows = await orm.select({ id: tag.id, slug: tag.slug }).from(tag);
  return new Map(rows.map((r) => [r.slug, r.id]));
}
