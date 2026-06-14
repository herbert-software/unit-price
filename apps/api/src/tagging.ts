// Deterministic category/attribute tagging pipeline orchestration + existing-
// stock backfill. This is the IO/编排 layer (apps/api): it composes core's pure
// rules (tagTier1Leaf / tagTier1Attributes / arbitrate) with the repository's
// atomic write/read primitives. NO LLM is involved this period — the category /
// comparability decision is made entirely by the deterministic tier1 rules +
// store_category_map + arbiter (red line: the LLM never decides a category).
//
// Write-path three-state reconcile (D5): every category-attribution write
// converges the three discriminable state fields (kind=category leaf
// product_tag + product.pending_category_tag_id) to the current verdict, so a
// product is always in exactly one of {已分类叶, 待细化, 待人工} and the
// "有叶 ∧ pending 非空" 越界态 never occurs. Only the kind=category axis is
// touched — orthogonal attribute/brand/product_line edges are never removed.
// `rankable` is recomputed on every write (never read stale).
//
// Closure: category_closure is materialized on the TAG axis at seed time (leaf →
// all ancestors); attaching the leaf product_tag is all it takes for the product
// to JOIN into every ancestor node (no per-product closure rows — see D2). So
// "补 category_closure 命中" is satisfied by the leaf attach itself.
import {
  arbitrate,
  tagTier1Attributes,
  tagTier1Leaf,
  type ArbitrationVerdict,
  type StoreMapResult,
} from '@unit-price/core';
import { product, productRaw, type Db, type Repository } from '@unit-price/db';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

/** One product's tagging input (raw title + store-native category for lookup). */
export interface TagProductInput {
  productId: string;
  /** product_raw.title — drives the tier1 keyword rules. */
  title: string;
  /** product_raw.store (e.g. "sam"); null when unknown → no store-map lookup. */
  store: string | null;
  /**
   * The store's NATIVE category id (e.g. Sam's numeric categoryIdList leaf) used
   * to hit store_category_map. A DIRECT `tagProduct` call (e.g. a unit test, or a
   * future manual entry) may pass it to exercise the store-map arbitration. The
   * production backfill passes null this period — no ingest field carries a store
   * native category id yet (do NOT reuse product_raw.category_hint: it is the
   * passthrough source of product.category, "beverage" for all Sam stock — not a
   * native id). null → no store-map lookup.
   */
  nativeCategoryId: string | null;
}

/** Outcome of tagging one product (for backfill summary / debug). */
export interface TagProductResult {
  productId: string;
  verdict: ArbitrationVerdict;
  /** Leaf slug attached when verdict=leaf (else null). */
  leafSlug: string | null;
  /** Attribute slugs attached (always tier1, orthogonal to the verdict). */
  attributeSlugs: string[];
  /** Recomputed derived rankable. */
  rankable: boolean;
}

/**
 * Resolve the repository's `lookupStoreCategory` result into the core arbiter's
 * `StoreMapResult`. A store-map hit on a LEAF (any category leaf — soft-drink
 * OR alcohol) is a `leaf` verdict; the leaf's comparability/rankability is
 * decided downstream by the DB tree (an alcohol leaf resolves comparable_unit
 * null → rankable=false, but is still 已分类叶, not 待细化). A hit on a coarse
 * (non-leaf) node → `coarse` → 待细化 (pending must point at a non-leaf). A
 * non-category tag or an unmapped native id → `none`.
 *
 * Determinism: classification is purely by the tag kind + the DB-supplied leaf
 * flag — same lookup, same StoreMapResult.
 */
function toStoreMapResult(
  lookup: { slug: string; kind: string; isLeaf: boolean } | null,
): StoreMapResult {
  if (lookup == null || lookup.kind !== 'category') return { kind: 'none' };
  if (lookup.isLeaf) {
    return { kind: 'leaf', leafSlug: lookup.slug };
  }
  // A coarse (non-leaf) category node → pending (待细化 points at a non-leaf).
  return { kind: 'coarse', coarseNodeSlug: lookup.slug };
}

/** Map an arbiter `decidedBy` to the product_tag source for a leaf attach. */
function leafSource(decidedBy: 'tier1' | 'store-map'): 'rule' | 'store-map' {
  return decidedBy === 'tier1' ? 'rule' : 'store-map';
}

/**
 * Tag one product deterministically and reconcile its three-state category
 * attribution + rankable. Pure orchestration over repo atoms — does NOT read the
 * DB itself (the caller supplies title/store/native). Idempotent: re-running on
 * the same snapshot converges to the same state — the verdict's leaf/pending +
 * attributes + rankable are收敛 via reconcileCategory in一个单事务/批 (原子三态
 * 收敛 + 属性 + rankable;幂等). Never touches product.category (kept verbatim,
 * always "beverage").
 */
export async function tagProduct(
  repo: Repository,
  input: TagProductInput,
): Promise<TagProductResult> {
  // 1. tier1 pure rules (leaf + attributes).
  const tier1 = tagTier1Leaf({ title: input.title });
  const attributes = tagTier1Attributes({ title: input.title });

  // 2. store_category_map lookup → StoreMapResult (IO read, then pure map).
  let storeMap: StoreMapResult = { kind: 'none' };
  if (input.store != null && input.nativeCategoryId != null) {
    const lookup = await repo.lookupStoreCategory(
      input.store,
      input.nativeCategoryId,
    );
    storeMap = toStoreMapResult(lookup);
  }

  // 3. Deterministic arbitration (pure decision; no LLM).
  const verdict = arbitrate(tier1, storeMap);

  // 4. Derive the three-state target + rankable from the verdict. These are
  // reads only — the actual writes happen atomically in step 5. rankable =
  // classified-leaf AND that leaf resolves a non-null comparable_unit (v1 =
  // per_100ml soft drinks); 待细化 / 待人工 / 酒类(null) → false.
  const leafSlug = verdict.verdict === 'leaf' ? verdict.leafSlug : null;
  const pendingNodeSlug =
    verdict.verdict === 'pending' ? verdict.pendingNodeSlug : null;
  let rankable = false;
  if (leafSlug != null) {
    const unit = await repo.resolveComparableUnit(leafSlug);
    rankable = unit != null;
  }

  // 5. Atomic three-state reconcile on the kind=category axis (single tx /
  // batch): drop old leaf, attach the decided leaf (if any) + attributes, set
  // pending + rankable — the whole group commits or rolls back, so we never
  // leave "有叶 ∧ pending 非空" even under a partial-write failure on D1.
  // attribute tags are orthogonal (kind != category), attached regardless of
  // verdict. Never touches product.category (kept verbatim, always "beverage").
  await repo.reconcileCategory({
    productId: input.productId,
    leafSlug,
    leafSource: verdict.verdict === 'leaf' ? leafSource(verdict.decidedBy) : 'rule',
    pendingNodeSlug,
    attributeSlugs: attributes.map((a) => a.slug),
    rankable,
  });

  return {
    productId: input.productId,
    verdict,
    leafSlug,
    attributeSlugs: attributes.map((a) => a.slug),
    rankable,
  };
}

/** Summary of a backfill run. */
export interface BackfillResult {
  /** Total products processed. */
  total: number;
  /** Count that landed 已分类叶 (a leaf attached). */
  classified: number;
  /** Count that landed 待细化 (pending non-null). */
  pending: number;
  /** Count that landed 待人工 (no leaf, no pending). */
  manual: number;
  /** Count with rankable=true after recompute. */
  rankable: number;
  /** Per-product results (in processing order). */
  results: TagProductResult[];
}

/**
 * Read every product joined to its raw row (id + title + store) for the backfill.
 * A pure read — no parse/calc, no writes.
 *
 * store-map is LAZY this period: no ingest field carries a store native category
 * id (product_raw.category_hint is the passthrough source of product.category =
 * "beverage" for all Sam stock, NOT a native id; ingest never collects Sam's
 * numeric categoryIdList). So the backfill does NOT feed the store-map — every
 * input gets `nativeCategoryId: null`, and tier1 keyword rules are this period's
 * ONLY active classification path in production. The store_category_map seed +
 * the arbiter's store-map branch are rails laid for a later phase, covered by
 * unit tests; they get wired into the backfill once ingest adds a DEDICATED
 * store-native-category-id field (must NOT reuse category_hint — that would
 * pollute product.category). Both drivers share the sqlite-core query-builder
 * surface for this non-transactional read (mirrors repository.ts / seed.ts).
 */
export async function listProductsForBackfill(
  db: Db,
): Promise<TagProductInput[]> {
  const orm = db.orm as unknown as BetterSQLite3Database<Record<string, never>>;
  const rows = await orm
    .select({
      productId: product.id,
      title: productRaw.title,
      store: productRaw.store,
    })
    .from(product)
    .innerJoin(productRaw, eq(productRaw.id, product.rawId));
  return rows.map((r) => ({
    productId: r.productId,
    title: r.title,
    store: r.store,
    // No ingest field carries a store native category id this period → store-map
    // stays lazy in the backfill (store kept; tagProduct skips the lookup when
    // nativeCategoryId is null). See the docstring above.
    nativeCategoryId: null,
  }));
}

/**
 * Backfill the existing stock (≈445 products in production): run the tagging
 * pipeline over EVERY landed product. Does NOT replay /ingest (first-write-wins
 * — see [[ingest-write-once-needs-backfill]]); it composes the repo's category-
 * attribution atoms only. store-map is LAZY this period — no ingest field carries
 * a store native category id (see listProductsForBackfill), so tier1 keyword
 * rules are the only active classification path; a product classifiable only by a
 * store native id lands 待人工 in the backfill until that field exists. Idempotent:
 * re-running on the same snapshot yields the same state, and a rule re-decision
 * leaves only the new leaf. Provided as a callable function so it can be driven
 * from a one-off script or an admin entry.
 */
export async function runBackfill(
  repo: Repository,
  db: Db,
): Promise<BackfillResult> {
  const inputs = await listProductsForBackfill(db);
  const results: TagProductResult[] = [];
  let classified = 0;
  let pending = 0;
  let manual = 0;
  let rankableCount = 0;
  for (const input of inputs) {
    const result = await tagProduct(repo, input);
    results.push(result);
    if (result.verdict.verdict === 'leaf') classified += 1;
    else if (result.verdict.verdict === 'pending') pending += 1;
    else manual += 1;
    if (result.rankable) rankableCount += 1;
  }
  return {
    total: inputs.length,
    classified,
    pending,
    manual,
    rankable: rankableCount,
    results,
  };
}
