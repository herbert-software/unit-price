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
// Scope: `comparable_unit=per_100ml` is bound on `软饮` and `乳品` (their leaves
// inherit via `resolveComparableUnit`, NOT a per-leaf duplicate) and on EACH
// 酒种 leaf directly (each leaf is its own cohort). The `酒类` parent and root
// stay null. The v2 placeholder units `per_100g` / `per_100sheet` are
// deliberately NOT seeded.
import {
  CategoryLeafSlugSchema,
  type AttributeSlug,
  type CategoryLeafSlug,
  type ComparableUnit,
  type TagKind,
} from '@unit-price/core';
import { eq, inArray } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { Db } from './db.js';
import { categoryClosure, storeCategoryMap, tag } from './schema.js';

/**
 * A category-tree node, store-agnostic. `parentSlug=null` marks the root.
 * `comparableUnit` is the cohort binding point (`软饮`/`乳品` bind it on the
 * parent, each 酒种 leaf binds it on the leaf); a node whose own value is
 * undefined inherits the nearest non-null ancestor at resolve time (see
 * `resolveComparableUnit`).
 */
export interface CategoryNodeSeed {
  slug: string;
  name: string;
  parentSlug: string | null;
  comparableUnit?: ComparableUnit | null;
}

/**
 * Canonical category is-a tree (our naming; derived from Sam's 酒水饮料 tree,
 * marketing/brand nodes stripped). `comparable_unit` is bound at the cohort's
 * binding point: `软饮` (per_100ml) and `乳品` (per_100ml) bind it on the
 * parent (their leaves inherit), whereas each 酒种 leaf binds it on the leaf
 * itself (the leaf IS its own cohort — no deeper descendants). The `酒类` parent
 * stays null (it spans multiple per100ml cohorts → not a single rankable cohort;
 * rankings-api's cohort guard rejects it). root `饮料` is null. Order matters
 * only loosely (parents are resolved by slug at write time), kept root→leaf.
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
  // 乳品 — single-point comparable_unit binding (per_100ml); leaves inherit
  // (their own comparableUnit is left undefined, resolved up to 乳品), same
  // pattern as 软饮. Plant-based "milks" (椰奶/燕麦奶/豆浆) are NOT here — they
  // are soft-drink juice-plant (a different cohort).
  {
    slug: 'dairy',
    name: '乳品',
    parentSlug: 'beverage',
    comparableUnit: 'per_100ml',
  },
  { slug: 'milk', name: '牛奶', parentSlug: 'dairy' },
  { slug: 'yogurt', name: '酸奶', parentSlug: 'dairy' },
  { slug: 'lactic-drink', name: '乳酸菌饮料', parentSlug: 'dairy' },
  // 酒类 subtree — the 酒类 parent is null (spans multiple per100ml cohorts;
  // cohort-guarded out of rankings), but EACH 酒种 leaf binds per_100ml on the
  // leaf itself (each leaf is its own rankable cohort, no deeper descendants).
  { slug: 'alcohol', name: '酒类', parentSlug: 'beverage', comparableUnit: null },
  { slug: 'baijiu', name: '白酒', parentSlug: 'alcohol', comparableUnit: 'per_100ml' },
  { slug: 'wine', name: '葡萄酒', parentSlug: 'alcohol', comparableUnit: 'per_100ml' },
  { slug: 'spirits', name: '洋酒', parentSlug: 'alcohol', comparableUnit: 'per_100ml' },
  { slug: 'whisky', name: '威士忌', parentSlug: 'alcohol', comparableUnit: 'per_100ml' },
  { slug: 'beer', name: '啤酒', parentSlug: 'alcohol', comparableUnit: 'per_100ml' },
  {
    slug: 'sake-fruit-wine',
    name: '清酒果酒',
    parentSlug: 'alcohol',
    comparableUnit: 'per_100ml',
  },
];

/**
 * The 6 酒种 (alcohol) leaf slugs that bind `comparable_unit=per_100ml` on the
 * leaf itself (each is its own rankable cohort). Single source for the explicit
 * idempotent UPDATE in `seedTaxonomy()` (and mirrored verbatim by the 0005 DML
 * migration), needed because prod already holds these rows (seeded by 0004 with
 * comparable_unit=NULL) and INSERT OR IGNORE / onConflictDoNothing cannot flip
 * an existing row's column.
 */
export const ALCOHOL_LEAF_SLUGS = [
  'baijiu',
  'wine',
  'spirits',
  'whisky',
  'beer',
  'sake-fruit-wine',
] as const;

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
 * alcohol leaf ids are mapped for completeness (each 酒种 leaf binds per_100ml
 * → rankable=true, its own cohort; the `alcohol` parent stays null).
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
  // 酒类叶(各酒种叶绑 per_100ml→rankable=true;leaf→leaf,非下放)。
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

  // 1b. Flip comparable_unit on each 酒种 leaf (P3.5). A DB seeded by the old
  // P3 path already holds these leaf rows with comparable_unit=NULL, and the
  // insert above is onConflictDoNothing — it does NOT update an existing row's
  // column. So a SEPARATE explicit idempotent UPDATE (mirroring the 0005 DML
  // migration's UPDATE) is required to converge old rows to per_100ml; without
  // it, seedTaxonomy() and the migration diverge on an already-seeded DB. Do NOT
  // switch the insert to onConflictDoUpdate — that would also overwrite
  // parentId/name and collide with the two-pass parentId resolution above.
  await orm
    .update(tag)
    .set({ comparableUnit: 'per_100ml' })
    .where(inArray(tag.slug, ALCOHOL_LEAF_SLUGS));

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
