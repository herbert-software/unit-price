// Typed data-access layer with bidirectional Zod validation against the core
// schema SOT. Writes validate domain inputs before touching the database
// (validation failure throws a ZodError carrying field paths and writes
// nothing); reads rebuild typed domain objects and re-validate them — callers
// never see bare rows.
//
// No domain computation happens here: per100ml/per100g/formula are stored
// verbatim from core's CalcResult (never recomputed from the integer-cents
// price), and the only transformations are storage codecs (see codec.ts).
import {
  ComparableUnitSchema,
  ParsedSpecSchema,
  RawProductSchema,
  TagSourceSchema,
  UnitPriceSchema,
  WarningsSchema,
  type CalcResult,
  type ComparableUnit,
  type ParsedSpec,
  type RawProduct,
  type TagSource,
} from '@unit-price/core';
import { and, asc, countDistinct, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { z } from 'zod';
import {
  decodeJson,
  decodeMeasurement,
  encodeJson,
  encodeMeasurement,
  newId,
  toEpochMillis,
  yuanToCents,
} from './codec.js';
import type { Db } from './db.js';
import { computeDedupeKey } from './dedupe.js';
import {
  categoryClosure,
  corrections,
  product,
  productRaw,
  productTag,
  storeCategoryMap,
  tag,
  unitPrice,
} from './schema.js';

/**
 * Dedupe-key columns are provenance extras, not part of RawProductSchema —
 * they get their own gate: empty/whitespace store/store_sku would collapse
 * unrelated reports into one row, so both are trimmed and rejected when blank
 * before any write; the trimmed values are what get stored.
 */
const DedupeKeyGate = z.object({
  store: z.string().trim().min(1),
  storeSku: z.string().trim().min(1),
});

const FiniteNumber = z.number().finite();

/**
 * Storage gate: core schemas admit ±Infinity (z.number() only rejects NaN),
 * but non-finite values corrupt JSON-text/REAL columns (JSON.stringify turns
 * Infinity into null) — reject before any write. Validation only; the
 * ParsedSpecSchema-parsed object is what gets stored.
 */
const FiniteSpecGate = z.object({
  unitSize: z.object({ value: FiniteNumber }).nullish(),
  totalAmount: z.object({ value: FiniteNumber }).nullish(),
  quantity: FiniteNumber.nullish(),
  multipliers: z.array(FiniteNumber),
});

/** Storage gate for RawProduct.price — same non-finite rejection as above. */
const FiniteRawPriceGate = z.object({ price: FiniteNumber });

/**
 * Core exports no CalcResultSchema (CalcResult is interface-only), so the
 * gate is composed from the exported pieces: UnitPriceSchema for the nested
 * unit price, WarningsSchema for warnings, and bounded confidence. On top of
 * UnitPriceSchema it enforces the axis storage invariants:
 *  - per100ml/per100g must each be finite when present;
 *  - a product sits on at most one axis — per100ml and per100g are never both
 *    non-null;
 *  - formula is non-null IFF one of per100ml/per100g is non-null (computable →
 *    that axis price + formula set, the other axis NULL; uncomputable →
 *    per100ml/per100g/formula all NULL).
 */
const CalcResultGate = z.object({
  unitPrice: UnitPriceSchema.superRefine((up, ctx) => {
    if (up.per100ml !== null && !Number.isFinite(up.per100ml)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['per100ml'],
        message: 'per100ml must be finite or null',
      });
    }
    if (up.per100g !== null && !Number.isFinite(up.per100g)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['per100g'],
        message: 'per100g must be finite or null',
      });
    }
    if (up.per100ml !== null && up.per100g !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['per100g'],
        message:
          'per100ml and per100g must not both be set (a product is on at most one axis)',
      });
    }
    const hasAxis = up.per100ml !== null || up.per100g !== null;
    if (hasAxis === (up.formula === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['formula'],
        message:
          'formula must be non-null IFF one of per100ml/per100g is non-null',
      });
    }
  }),
  confidence: z.number().min(0).max(1),
  warnings: WarningsSchema,
});

const IdGate = z.string().min(1);

export interface UpsertRawInput {
  store: string;
  storeSku: string;
  /** Domain part — validated with RawProductSchema; price in yuan. */
  raw: RawProduct;
  source?: string | null;
  sourceUrl?: string | null;
  /** Observation time (epoch ms or Date); defaults to now. */
  capturedAt?: number | Date;
}

export interface SaveParsedInput {
  rawId: string;
  spec: ParsedSpec;
  calc: CalcResult;
  /** Optional app-generated ids (UUID/ULID); default random UUIDs. */
  productId?: string;
  unitPriceId?: string;
}

export interface SaveParsedResult {
  productId: string;
  unitPriceId: string;
}

export interface SaveCorrectionInput {
  productId: string;
  rawId: string;
  /** Corrected spec — validated with ParsedSpecSchema before writing. */
  correctedSpec: ParsedSpec;
  /** Correction time (epoch ms or Date); defaults to now. */
  createdAt?: number | Date;
}

export interface ProductRecord {
  productId: string;
  rawId: string;
  spec: ParsedSpec;
  /** CalcResult shape: { unitPrice: { per100ml, per100g, formula }, confidence, warnings }. */
  calc: CalcResult;
}

export interface ListRankingsInput {
  /** Page size (caller is responsible for clamping; passed straight to LIMIT). */
  limit: number;
  /** Row offset (passed straight to OFFSET). */
  offset: number;
  /**
   * Taxonomy category-node slug that scopes the board (the root node slug is
   * `beverage`, the default). It is resolved to a `tag` row and pushed down as
   * a closure filter (`category_closure.ancestor_tag_id = <that node>`), paired
   * with the `product.rankable = 1` gate and `per100ml IS NOT NULL` — see
   * `buildRankingsQuery`. A slug with NO `tag` row yields an empty result (NOT
   * an error); slug LEGALITY (a 400 on an unknown/non-category slug) is the
   * API layer's job, not this query's. NOT keyed off `product.category` (always
   * "beverage", no discriminating power).
   */
  category: string;
}

/**
 * Denormalized read-only ranking projection (`unit_price ⋈ product ⋈
 * product_raw`). NOT a domain object (ParsedSpec/CalcResult): the per100ml/
 * formula/confidence/warnings columns are taken verbatim from `unit_price`
 * (never recomputed from the stored cents), and the row carries display columns
 * from `product_raw`. `confidence` is `unit_price.confidence` (the authoritative
 * band) — never `product.confidence` (the parse-time intermediate). `warnings`
 * is decoded from JSON-text and re-validated to `string[]` before it leaves the
 * repo (the raw JSON string is never exposed). The API-layer contract schema
 * (RankingsResponseSchema) validates this projection, not a core Zod schema.
 */
export interface RankingRow {
  /** unit_price.id (the stable secondary sort key). */
  id: string;
  /** unit_price.per100ml (REAL; non-null by the WHERE filter). */
  per100ml: number;
  /** unit_price.formula (stored replay string). */
  formula: string;
  /** unit_price.confidence (authoritative band) — NOT product.confidence. */
  confidence: number;
  /** unit_price.warnings decoded from JSON-text to string[]. */
  warnings: string[];
  /** product_raw.title. */
  title: string;
  /** product_raw.price as integer cents (latest observed price). */
  priceCents: number;
  /** product_raw.store. */
  store: string;
  /** product_raw.store_sku. */
  storeSku: string;
  /** product_raw.source_url (nullable). */
  sourceUrl: string | null;
}

/**
 * One read-only category-tree node (kind=category) for the browse view. NOT a
 * domain object: `comparableUnit` is the inheritance-resolved effective unit
 * (node's own value, else nearest non-null ancestor, else null), `rankable` is
 * the node's own axis flag (`comparableUnit !== null`), and `rankableCount` is
 * the closure-descendant rankable-member count (orthogonal to `rankable`). The
 * API-layer contract schema (CategoryTreeResponseSchema) validates this shape.
 */
export interface CategoryTreeNode {
  /** tag.slug (stable ASCII identifier). */
  slug: string;
  /** tag.name (display name). */
  name: string;
  /** Parent node slug; null at the root. */
  parentSlug: string | null;
  /** Inheritance-resolved comparable unit, or null (root/alcohol). */
  comparableUnit: ComparableUnit | null;
  /** Node's own axis flag: comparableUnit !== null. */
  rankable: boolean;
  /** Closure-descendant rankable members (COUNT(DISTINCT product.id)). */
  rankableCount: number;
}

/** Input to attach (idempotently) one product↔tag edge by tag slug. */
export interface AttachTagInput {
  productId: string;
  /** Stable tag slug (resolved to tag.id internally). */
  tagSlug: string;
  source: TagSource;
  /** Rule/mapping confidence in [0,1]. */
  confidence: number;
}

/** Atomic three-state category reconcile (one tx/batch). */
export interface ReconcileCategoryInput {
  productId: string;
  /** Decided leaf slug to attach (must be a kind=category LEAF), or null. */
  leafSlug: string | null;
  /** product_tag.source for the leaf attach (ignored when leafSlug is null). */
  leafSource: TagSource;
  /** Coarse non-leaf category node for 待细化 (kind=category NON-leaf), or null. */
  pendingNodeSlug: string | null;
  /** Orthogonal attribute slugs to attach idempotently (kind != category). */
  attributeSlugs: string[];
  /** Derived rankable flag. */
  rankable: boolean;
}

/** One tag attached to a product (debug/read projection). */
export interface ProductTagRow {
  tagId: string;
  slug: string;
  name: string;
  kind: string;
  source: string;
  confidence: number;
}

/**
 * Field-discriminable category-attribution view of a product (debug/verify).
 * The three states are derived here, not stored: `已分类叶` = has a kind=category
 * leaf tag ∧ pendingCategoryTagId null; `待细化` = no leaf ∧ pending non-null;
 * `待人工` = no leaf ∧ pending null.
 */
export interface ProductAttribution {
  productId: string;
  /** All attached tags (every kind). */
  tags: ProductTagRow[];
  /** The single kind=category leaf slug, or null if none attached. */
  categoryLeafSlug: string | null;
  /** product.pending_category_tag_id resolved to a slug, or null. */
  pendingCategorySlug: string | null;
  /** Derived three-state, mechanically from leaf + pending. */
  state: 'classified-leaf' | 'pending' | 'manual';
  /** product.rankable (stored derived flag). */
  rankable: boolean;
}

export interface Repository {
  /** Upsert a raw report by `(store, store_sku)`; returns the raw row id. */
  upsertRaw(input: UpsertRawInput): Promise<string>;
  /** Atomically persist product + unit_price for a raw row (single tx). */
  saveParsed(input: SaveParsedInput): Promise<SaveParsedResult>;
  /** Typed read: ParsedSpec + CalcResult-shaped unit price + raw_id. */
  getProduct(productId: string): Promise<ProductRecord | null>;
  /** Append a correction row; never mutates product_raw/product. */
  saveCorrection(input: SaveCorrectionInput): Promise<string>;
  /**
   * Read-only node-scoped ranking query: rows joined across
   * `unit_price ⋈ product ⋈ product_raw ⋈ product_tag ⋈ category_closure`, kept
   * when they are a closure member of the `category` node (`ancestor_tag_id` =
   * that node's tag) ∧ `product.rankable = 1` ∧ `per100ml IS NOT NULL`,
   * `SELECT DISTINCT` on `unit_price.id` (double-leaf dedupe backstop, mirrors
   * `listProductIdsInCategoryNode`), ascending by per100ml then unit_price.id,
   * sliced by limit/offset. `category` is the node slug (default root
   * `beverage`); a slug with no `tag` row yields []. Pure read — no writes, no
   * parse/calc, no recompute. Stored per100ml/formula/confidence are returned
   * verbatim; warnings are decoded to string[].
   */
  listRankings(input: ListRankingsInput): Promise<RankingRow[]>;

  /**
   * Read-only category is-a tree (kind=category nodes only) + each node's
   * `rankableCount` (closure-descendant rankable members). Loads all category
   * nodes in ONE query and resolves `comparableUnit` inheritance in memory
   * (never the per-node `resolveComparableUnit` round-trip). `rankable` =
   * `comparableUnit !== null` (the node's own axis flag). `rankableCount` is
   * `COUNT(DISTINCT product.id)` over the SAME filter fragment as the node board
   * (closure member ∧ rankable=1 ∧ per100ml NOT NULL) — orthogonal to the
   * node's own `rankable` (root `beverage` is rankable=false yet count>0). No
   * category rows → empty (not an error). Pure read.
   */
  listCategoryTree(): Promise<CategoryTreeNode[]>;

  // --- category-tagging primitives (atomic writes / closure & inheritance
  // queries). The three-state reconcile ORCHESTRATION lives in apps/api; these
  // are the callable atoms it composes. None touches `product.category` (kept
  // verbatim, always "beverage").

  /**
   * Attach one product↔tag edge, idempotently. `(product_id, tag_id)` is
   * unique, so re-attaching the same edge is a no-op (onConflictDoNothing) —
   * never duplicates, never throws on a repeat. Resolves `tagSlug` → tag.id;
   * an unknown slug throws (the caller seeded the tree). Does NOT reconcile
   * the three-state or recompute rankable — that is the caller's job.
   */
  attachTag(input: AttachTagInput): Promise<void>;

  /**
   * Delete every kind=category LEAF `product_tag` of a product (a leaf is a
   * category tag that is no other category node's parent). Used by the
   * reconcile to converge single-attribution (drop the old leaf before
   * inserting the new one) and on the leaf→待人工/待细化 transition. Only touches
   * kind=category leaves — never attribute/brand/product_line edges. Returns
   * the count removed. Idempotent (deleting when none present is a no-op).
   */
  removeCategoryLeafTags(productId: string): Promise<number>;

  /**
   * Set `product.pending_category_tag_id` to the tag with `nodeSlug`, or NULL
   * when `nodeSlug` is null. Used by the reconcile: 待细化 sets a coarse
   * (non-leaf) node; 已分类叶 / 待人工 clear it to NULL. An unknown slug throws.
   */
  setPendingCategory(productId: string, nodeSlug: string | null): Promise<void>;

  /** Write the derived `product.rankable` flag (boolean → 0/1). */
  setRankable(productId: string, rankable: boolean): Promise<void>;

  /**
   * Atomically reconcile a product's kind=category three-state + attributes +
   * rankable in ONE transaction (sqlite) / batch (D1): delete existing category
   * leaf edges, attach the decided leaf (if any), attach attributes, set pending,
   * set rankable — the whole group commits or rolls back, so the invariant
   * "never 有叶 ∧ pending 非空" holds even under partial failure. Validates kinds
   * BEFORE any write: leafSlug a category LEAF, pendingNodeSlug a category
   * NON-leaf, attributeSlugs non-category; unknown slug / kind mismatch / both
   * leaf+pending / missing product → throws before mutating. Idempotent on re-run.
   */
  reconcileCategory(input: ReconcileCategoryInput): Promise<void>;

  /**
   * Resolve a category node's effective `comparable_unit` by is-a inheritance:
   * take the node's own value, else walk `parent_id` up to the nearest non-null
   * ancestor; null all the way to root → null (node not rankable). Returns null
   * for a non-category tag or an unknown slug. Pure read.
   */
  resolveComparableUnit(nodeSlug: string): Promise<ComparableUnit | null>;

  /**
   * Product ids that are members of the category node `nodeSlug`, via
   * `product_tag` (kind=category leaf) JOIN `category_closure` (the leaf's
   * ancestor set includes `nodeSlug`). attribute/brand/product_line tags have
   * no closure rows and never match. Closure includes the self row, so querying
   * a leaf returns products tagged with that exact leaf too. Unknown/non-
   * category slug → empty.
   */
  listProductIdsInCategoryNode(nodeSlug: string): Promise<string[]>;

  /**
   * Resolve a store's native category id through `store_category_map` to a tag
   * slug + kind + leaf flag, or null when unmapped (→ 待人工). `isLeaf` is true
   * when no tag names this tag as its `parent_id`. Pure read (the arbiter in
   * apps/api turns this into a `StoreMapResult`: a leaf → leaf verdict, a coarse
   * node → pending).
   */
  lookupStoreCategory(
    store: string,
    nativeCategoryId: string,
  ): Promise<{ slug: string; kind: string; isLeaf: boolean } | null>;

  /**
   * Debug/verify read: a product's tags, derived category three-state, and
   * rankable. Not an external contract — for tests/inspection. Null if the
   * product does not exist.
   */
  getProductAttribution(productId: string): Promise<ProductAttribution | null>;
}

/**
 * Both drivers share the sqlite-core query-builder surface; execution
 * dispatches through the instance's own session at runtime. Non-transactional
 * paths are typed against one driver to keep a single code path — only
 * transactions need the tagged branch (sync vs async semantics).
 */
function queryOrm(db: Db): BetterSQLite3Database<Record<string, never>> {
  return db.orm as unknown as BetterSQLite3Database<Record<string, never>>;
}

/**
 * The single reusable filter fragment for node-scoped rankings: the bridge +
 * display + closure JOINs paired with the two gates `product.rankable = 1` ∧
 * `per100ml IS NOT NULL`, scoped to one node by `category_closure.ancestor_tag_id
 * = nodeTagId`. BOTH the node board (buildRankingsQuery) and `rankableCount`
 * (buildRankableCountQuery) compose this ONE function, so the JOIN graph and the
 * WHERE predicate are written exactly once — the tree's "N members" can never
 * drift from the board's "N rows". Caller has already resolved the slug to
 * `nodeTagId`.
 *
 * `query` is the select builder (full projection for the board, COUNT for the
 * count). It is typed loosely on the way in (the two callers pass structurally
 * different selections) and the chained JOIN/WHERE result is `$dynamic()` so
 * each caller can finish it (ORDER/LIMIT vs nothing); callers re-assert the row
 * type they expect. Closure rows exist only for category is-a edges, so
 * `category_closure.tag_id = product_tag.tag_id` matches only category leaves —
 * attribute/brand/product_line edges in the same `product_tag` table never join
 * through.
 */
function applyNodeRankingFilter(
  // The select builder before `.from()`. Typed loosely (`any` chain) because the
  // board and count callers pass structurally different selections; each
  // re-asserts its own concrete result type at the call site. The JOIN graph and
  // the WHERE predicate live ONLY here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: { from: (table: typeof unitPrice) => any },
  nodeTagId: string,
) {
  return query
    .from(unitPrice)
    // product is the unit_price → product_raw bridge AND carries the rankable
    // gate; product_raw carries display columns.
    .innerJoin(product, eq(product.id, unitPrice.productId))
    .innerJoin(productRaw, eq(productRaw.id, product.rawId))
    // product_tag (category leaf) JOIN category_closure: the product's leaf has
    // `nodeTagId` among its ancestors (incl. self) → the product is a member of
    // the queried node.
    .innerJoin(productTag, eq(productTag.productId, product.id))
    .innerJoin(categoryClosure, eq(categoryClosure.tagId, productTag.tagId))
    .where(
      and(
        eq(categoryClosure.ancestorTagId, nodeTagId),
        eq(product.rankable, 1),
        isNotNull(unitPrice.per100ml),
      ),
    )
    .$dynamic();
}

/** The denormalized columns the board projection selects (pre-decode). */
interface RawRankingRow {
  id: string;
  per100ml: number | null;
  formula: string | null;
  confidence: number;
  warnings: string;
  title: string;
  priceCents: number;
  store: string;
  storeSku: string;
  sourceUrl: string | null;
}

/**
 * Single source for the node-scoped ranking query (shared by listRankings and
 * the EXPLAIN query-plan test). The test obtains its SQL via `.toSQL()` on this
 * same builder so the plan assertion runs against the production query — never a
 * hand-rebuilt copy that could silently drift from the JOIN/WHERE/ORDER here.
 * `category` (the input slug) is already resolved to `nodeTagId` by the caller.
 *
 * `selectDistinct` dedups on `unit_price.id` (the full projection is
 * functionally determined by it, so SELECT DISTINCT over the projection ≡
 * dedupe on unit_price.id) — a defensive backstop against a future
 * single-attribution violation (a product holding two category leaves both
 * under the node) listing the same product twice. ORDER BY per100ml ASC,
 * unit_price.id ASC (same-table full order → stable pagination). The closure +
 * rankable + per100ml filter comes from `applyNodeRankingFilter` (shared with
 * the count). See `rankings-api`「节点路径的查询计划口径」for the EXPLAIN contract.
 */
export function buildRankingsQuery(
  orm: BetterSQLite3Database<Record<string, never>>,
  nodeTagId: string,
  input: Pick<ListRankingsInput, 'limit' | 'offset'>,
) {
  return applyNodeRankingFilter(
    orm.selectDistinct({
      id: unitPrice.id,
      per100ml: unitPrice.per100ml,
      formula: unitPrice.formula,
      confidence: unitPrice.confidence,
      warnings: unitPrice.warnings,
      title: productRaw.title,
      priceCents: productRaw.price,
      store: productRaw.store,
      storeSku: productRaw.storeSku,
      sourceUrl: productRaw.sourceUrl,
    }),
    nodeTagId,
  )
    .orderBy(asc(unitPrice.per100ml), asc(unitPrice.id))
    .limit(input.limit)
    .offset(input.offset) as unknown as {
    toSQL: () => { sql: string; params: unknown[] };
  } & Promise<RawRankingRow[]>;
}

/**
 * `rankableCount` for one node, built on the SAME `applyNodeRankingFilter`
 * fragment as the board: `COUNT(DISTINCT product.id)`. Equals the (DISTINCT
 * unit_price.id) board cardinality because `unit_price` is 1:1 with `product`
 * (`unit_price_product_id_unique`) — the load-bearing invariant for "tree N ==
 * board N". If that 1:1 ever loosens, both sides must switch to the same
 * COUNT(DISTINCT product.id) keying.
 */
function buildRankableCountQuery(
  orm: BetterSQLite3Database<Record<string, never>>,
  nodeTagId: string,
) {
  return applyNodeRankingFilter(
    orm.select({ count: countDistinct(product.id) }),
    nodeTagId,
  ) as unknown as Promise<Array<{ count: number }>>;
}

/**
 * Load the existing (oldest) product + unit_price pair for a dedupe_key.
 * Returns null when no product matches the key (caller decides whether that is
 * a miss to insert through or a post-conflict invariant violation). A matched
 * product with no unit_price is data corruption (the first write is atomic), so
 * this throws — never returns a pair with a missing unitPriceId.
 */
async function loadExistingPair(
  orm: BetterSQLite3Database<Record<string, never>>,
  dedupeKey: string,
): Promise<SaveParsedResult | null> {
  const productRows = await orm
    .select({ id: product.id })
    .from(product)
    .where(eq(product.dedupeKey, dedupeKey))
    .limit(1);
  const existingProductId = productRows[0]?.id;
  if (existingProductId == null) {
    return null;
  }
  const unitPriceRows = await orm
    .select({ id: unitPrice.id })
    .from(unitPrice)
    .where(eq(unitPrice.productId, existingProductId))
    .limit(1);
  const existingUnitPriceId = unitPriceRows[0]?.id;
  if (existingUnitPriceId == null) {
    throw new Error(
      `unit_price row missing for product ${existingProductId} (saveParsed writes both atomically)`,
    );
  }
  return { productId: existingProductId, unitPriceId: existingUnitPriceId };
}

const CategoryTagSlugGate = z.string().min(1);

/** Resolve a tag row (id/kind/parent/comparable_unit) by slug, or null. */
async function loadTagBySlug(
  orm: BetterSQLite3Database<Record<string, never>>,
  slug: string,
): Promise<{
  id: string;
  kind: string;
  parentId: string | null;
  comparableUnit: string | null;
} | null> {
  const rows = await orm
    .select({
      id: tag.id,
      kind: tag.kind,
      parentId: tag.parentId,
      comparableUnit: tag.comparableUnit,
    })
    .from(tag)
    .where(eq(tag.slug, slug))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Slugs of category tags that are LEAVES (no other category tag names them as
 * `parent_id`). Used to scope `removeCategoryLeafTags` to leaves only, so a
 * non-leaf pending pointer is never expressed via product_tag and the
 * single-attribution reconcile drops only the leaf edge.
 */
async function loadCategoryLeafTagIds(
  orm: BetterSQLite3Database<Record<string, never>>,
): Promise<Set<string>> {
  const categories = await orm
    .select({ id: tag.id, parentId: tag.parentId })
    .from(tag)
    .where(eq(tag.kind, 'category'));
  const hasChild = new Set<string>();
  for (const c of categories) {
    if (c.parentId != null) hasChild.add(c.parentId);
  }
  const leaves = new Set<string>();
  for (const c of categories) {
    if (!hasChild.has(c.id)) leaves.add(c.id);
  }
  return leaves;
}

/** A loaded kind=category tag row (raw, pre-inheritance). */
interface CategoryTagRow {
  id: string;
  slug: string;
  name: string;
  parentId: string | null;
  comparableUnit: string | null;
}

/**
 * Resolve a category node's effective `comparable_unit` by is-a inheritance,
 * IN MEMORY against a preloaded id→row map: the node's own value, else walk
 * `parent_id` up to the nearest non-null ancestor; null all the way to root →
 * null. A bounded guard defends against a malformed cycle. Pure (no IO) — the
 * batch counterpart to `resolveComparableUnit` (which round-trips per node).
 */
function resolveComparableUnitInMemory(
  start: CategoryTagRow,
  byId: Map<string, CategoryTagRow>,
): ComparableUnit | null {
  let cursor: CategoryTagRow | undefined = start;
  let guard = 0;
  while (cursor != null && guard < 64) {
    if (cursor.comparableUnit != null) {
      return ComparableUnitSchema.parse(cursor.comparableUnit);
    }
    if (cursor.parentId == null) return null;
    cursor = byId.get(cursor.parentId);
    guard += 1;
  }
  return null;
}

/** Create the typed repository over an initialized Db (from createDb). */
export function createRepository(db: Db | null | undefined): Repository {
  if (db == null || (db.kind !== 'sqlite' && db.kind !== 'd1')) {
    throw new Error(
      'Repository requires an initialized Db from createDb(connection); DB connection missing or invalid',
    );
  }

  return {
    async upsertRaw(input) {
      const key = DedupeKeyGate.parse({
        store: input.store,
        storeSku: input.storeSku,
      });
      const raw = RawProductSchema.parse(input.raw);
      FiniteRawPriceGate.parse({ price: raw.price });
      const row = {
        id: newId(),
        store: key.store,
        storeSku: key.storeSku,
        title: raw.title,
        price: yuanToCents(raw.price),
        categoryHint: raw.categoryHint ?? null,
        source: input.source ?? null,
        sourceUrl: input.sourceUrl ?? null,
        capturedAt: toEpochMillis(input.capturedAt ?? Date.now()),
      };
      const rows = await queryOrm(db)
        .insert(productRaw)
        .values(row)
        .onConflictDoUpdate({
          target: [productRaw.store, productRaw.storeSku],
          // title/price/captured_at track the latest observation (always
          // overwrite). Optional provenance is COALESCE'd: a new non-null value
          // wins, but a resubmit that omits it keeps the prior value instead of
          // nulling it — don't destroy provenance on a price-only update.
          set: {
            title: row.title,
            price: row.price,
            categoryHint: sql`coalesce(${row.categoryHint}, ${productRaw.categoryHint})`,
            source: sql`coalesce(${row.source}, ${productRaw.source})`,
            sourceUrl: sql`coalesce(${row.sourceUrl}, ${productRaw.sourceUrl})`,
            capturedAt: row.capturedAt,
          },
        })
        .returning({ id: productRaw.id });
      const first = rows[0];
      if (!first) {
        throw new Error('upsertRaw: upsert returned no row');
      }
      return first.id;
    },

    async saveParsed(input) {
      const rawId = IdGate.parse(input.rawId);
      const spec = ParsedSpecSchema.parse(input.spec);
      FiniteSpecGate.parse(spec);
      const calc = CalcResultGate.parse(input.calc);

      // Optional caller-supplied ids must clear IdGate too (rawId already does);
      // an explicit empty string is rejected rather than used as a primary key.
      const productId =
        input.productId == null ? newId() : IdGate.parse(input.productId);
      const unitPriceId =
        input.unitPriceId == null ? newId() : IdGate.parse(input.unitPriceId);
      const unitSize = encodeMeasurement(spec.unitSize);
      const totalAmount = encodeMeasurement(spec.totalAmount);
      // dedupe_key = (rawId + normalized ParsedSpec), price-independent. The
      // unique index on it makes the first-inserted row win; equivalent
      // resubmits converge onto it instead of stacking duplicate product rows.
      const dedupeKey = computeDedupeKey(rawId, spec);
      const productRow = {
        id: productId,
        rawId,
        unitSizeValue: unitSize.value,
        unitSizeUnit: unitSize.unit,
        quantity: spec.quantity ?? null,
        multipliers: encodeJson(spec.multipliers),
        totalAmountValue: totalAmount.value,
        totalAmountUnit: totalAmount.unit,
        packageUnit: spec.packageUnit ?? null,
        category: spec.category,
        confidence: spec.confidence,
        dedupeKey,
      };
      const unitPriceRow = {
        id: unitPriceId,
        productId,
        per100ml: calc.unitPrice.per100ml,
        per100g: calc.unitPrice.per100g,
        formula: calc.unitPrice.formula,
        confidence: calc.confidence,
        warnings: encodeJson(calc.warnings),
      };

      if (db.kind === 'sqlite') {
        // better-sqlite3 transactions are native and synchronous: the
        // callback must not await, or statements escape the tx boundary.
        // Single connection, no real concurrency — onConflictDoNothing on the
        // dedupe_key + RunResult.changes is a safe hit/insert discriminator.
        return db.orm.transaction((tx) => {
          const inserted = tx
            .insert(product)
            .values(productRow)
            .onConflictDoNothing({ target: product.dedupeKey })
            .run();
          if (inserted.changes === 1) {
            // Real insert: persist unit_price in the same tx (first-write atomic)
            // and return the new pair.
            tx.insert(unitPrice).values(unitPriceRow).run();
            return { productId, unitPriceId };
          }
          // Hit an existing row (changes=0): do NOT insert unit_price (would
          // orphan onto the un-inserted product). Return the existing (oldest)
          // pair; an existing product with no unit_price is data corruption.
          const existingProductRows = tx
            .select({ id: product.id })
            .from(product)
            .where(eq(product.dedupeKey, dedupeKey))
            .limit(1)
            .all();
          const existingProductId = existingProductRows[0]?.id;
          if (existingProductId == null) {
            throw new Error(
              `saveParsed: insert hit dedupe_key conflict but no product found for key (dedupe_key=${dedupeKey})`,
            );
          }
          const existingUnitPriceRows = tx
            .select({ id: unitPrice.id })
            .from(unitPrice)
            .where(eq(unitPrice.productId, existingProductId))
            .limit(1)
            .all();
          const existingUnitPriceId = existingUnitPriceRows[0]?.id;
          if (existingUnitPriceId == null) {
            throw new Error(
              `unit_price row missing for product ${existingProductId} (saveParsed writes both atomically)`,
            );
          }
          return {
            productId: existingProductId,
            unitPriceId: existingUnitPriceId,
          };
        });
      }

      // D1 driver (real concurrency). SELECT-first fast path; the bare insert
      // inside batch() is the concurrency backstop.
      const orm = queryOrm(db);
      const existing = await loadExistingPair(orm, dedupeKey);
      if (existing) {
        return existing;
      }
      try {
        // D1 rejects explicit BEGIN/COMMIT; batch() is its atomic-write API
        // (whole group commits or rolls back together). The product insert is
        // BARE (no onConflictDoNothing): a concurrent racer that already
        // committed makes this insert hit the unique index and THROW, which
        // rolls the whole batch back (no unit_price orphan). onConflictDoNothing
        // would swallow the conflict and leak a unit_price orphan — forbidden.
        await db.orm.batch([
          db.orm.insert(product).values(productRow),
          db.orm.insert(unitPrice).values(unitPriceRow),
        ]);
        return { productId, unitPriceId };
      } catch (err) {
        // Concurrent equivalent submit won the race; our batch rolled back.
        // Fall back to the existing (oldest) pair — the winner has committed.
        const winner = await loadExistingPair(orm, dedupeKey);
        if (!winner) {
          throw new Error(
            `saveParsed: batch insert failed but no existing product found for dedupe_key=${dedupeKey}`,
            { cause: err },
          );
        }
        return winner;
      }
    },

    async getProduct(productId) {
      IdGate.parse(productId);
      const orm = queryOrm(db);
      const productRows = await orm
        .select()
        .from(product)
        .where(eq(product.id, productId))
        .limit(1);
      const p = productRows[0];
      if (!p) {
        return null;
      }
      const unitPriceRows = await orm
        .select()
        .from(unitPrice)
        .where(eq(unitPrice.productId, productId))
        .limit(1);
      const up = unitPriceRows[0];
      if (!up) {
        throw new Error(
          `unit_price row missing for product ${productId} (saveParsed writes both atomically)`,
        );
      }

      const spec = ParsedSpecSchema.parse({
        unitSize: decodeMeasurement(p.unitSizeValue, p.unitSizeUnit),
        quantity: p.quantity,
        multipliers: decodeJson(p.multipliers),
        totalAmount: decodeMeasurement(p.totalAmountValue, p.totalAmountUnit),
        packageUnit: p.packageUnit,
        category: p.category,
        confidence: p.confidence,
      });
      const calc = CalcResultGate.parse({
        unitPrice: {
          per100ml: up.per100ml,
          per100g: up.per100g,
          formula: up.formula,
        },
        confidence: up.confidence,
        warnings: decodeJson(up.warnings),
      });
      return { productId: p.id, rawId: p.rawId, spec, calc };
    },

    async saveCorrection(input) {
      const productId = IdGate.parse(input.productId);
      const rawId = IdGate.parse(input.rawId);
      const spec = ParsedSpecSchema.parse(input.correctedSpec);
      FiniteSpecGate.parse(spec);
      // Consistency check: the correction must target the product's own raw
      // row — attaching product A's correction to raw B would poison the
      // eval ground truth.
      const productRows = await queryOrm(db)
        .select({ rawId: product.rawId })
        .from(product)
        .where(eq(product.id, productId))
        .limit(1);
      const target = productRows[0];
      if (!target) {
        throw new Error(`saveCorrection: product ${productId} does not exist`);
      }
      if (target.rawId !== rawId) {
        throw new Error(
          `saveCorrection: rawId mismatch — product ${productId} belongs to raw ${target.rawId}, not ${rawId}`,
        );
      }
      const id = newId();
      await queryOrm(db)
        .insert(corrections)
        .values({
          id,
          productId,
          rawId,
          correctedSpec: encodeJson(spec),
          parseSource: 'manual_corrected',
          createdAt: toEpochMillis(input.createdAt ?? Date.now()),
        });
      return id;
    },

    async listRankings(input) {
      const orm = queryOrm(db);
      // Resolve the category-node slug → its tag row. A slug with no tag row
      // (legal-but-unseeded window) yields []; a non-category slug also yields
      // [] (closure rows are category-only). Slug LEGALITY (400 on a
      // typo/non-category slug) is the API layer's job — never an error here.
      const node = await loadTagBySlug(orm, CategoryTagSlugGate.parse(input.category));
      if (node == null || node.kind !== 'category') {
        return [];
      }
      // Read-only projection. confidence is taken explicitly from unit_price
      // (the authoritative band) — product also has a `confidence` column
      // (parse-time intermediate) and must NOT be selected here. per100ml/
      // formula/confidence are stored values, never recomputed from the cents
      // price. The closure + rankable=1 + per100ml-non-null filter and the
      // SELECT DISTINCT / ORDER BY / LIMIT come from the shared
      // buildRankingsQuery so the EXPLAIN test runs against this exact SQL (no
      // drift). Slicing is in SQL — rows are never pulled into app memory.
      const rows = await buildRankingsQuery(orm, node.id, input);

      return rows.map((row) => ({
        // per100ml is non-null by the WHERE filter; the column type is
        // `number | null`, so narrow it here without recomputing.
        id: row.id,
        per100ml: row.per100ml as number,
        formula: row.formula as string,
        confidence: row.confidence,
        // warnings is JSON-text: decode (codec, symmetric to encodeJson) then
        // re-validate to string[] — the raw JSON string is never exposed.
        warnings: WarningsSchema.parse(decodeJson(row.warnings)),
        title: row.title,
        priceCents: row.priceCents,
        store: row.store,
        storeSku: row.storeSku,
        sourceUrl: row.sourceUrl,
      }));
    },

    async listCategoryTree() {
      const orm = queryOrm(db);
      // ONE query for every kind=category node — inheritance is resolved in
      // memory below, never per-node round-trips to resolveComparableUnit.
      const nodes: CategoryTagRow[] = await orm
        .select({
          id: tag.id,
          slug: tag.slug,
          name: tag.name,
          parentId: tag.parentId,
          comparableUnit: tag.comparableUnit,
        })
        .from(tag)
        .where(eq(tag.kind, 'category'));
      // No category rows seeded yet (migrate-before-seed window) → empty tree,
      // not an error.
      if (nodes.length === 0) return [];

      const byId = new Map<string, CategoryTagRow>(nodes.map((n) => [n.id, n]));
      const out: CategoryTreeNode[] = [];
      for (const n of nodes) {
        const comparableUnit = resolveComparableUnitInMemory(n, byId);
        // rankableCount uses the SAME filter fragment as the node board
        // (buildRankableCountQuery → applyNodeRankingFilter), so the count can
        // never drift from the board's row count. It is orthogonal to the node's own
        // `rankable`: root `beverage` (rankable=false) still counts its
        // rankable soft-drink descendants (count > 0); only a subtree with no
        // rankable members (alcohol) counts 0.
        const countRows = await buildRankableCountQuery(orm, n.id);
        out.push({
          slug: n.slug,
          name: n.name,
          parentSlug: n.parentId == null ? null : (byId.get(n.parentId)?.slug ?? null),
          comparableUnit,
          rankable: comparableUnit !== null,
          rankableCount: countRows[0]?.count ?? 0,
        });
      }
      return out;
    },

    async attachTag(input) {
      const productId = IdGate.parse(input.productId);
      const slug = CategoryTagSlugGate.parse(input.tagSlug);
      const source = TagSourceSchema.parse(input.source);
      const confidence = z.number().min(0).max(1).parse(input.confidence);
      const orm = queryOrm(db);
      const t = await loadTagBySlug(orm, slug);
      if (t == null) {
        throw new Error(`attachTag: unknown tag slug "${slug}"`);
      }
      if (t.kind === 'category') {
        const leafIds = await loadCategoryLeafTagIds(orm);
        if (!leafIds.has(t.id)) {
          throw new Error(
            `attachTag: category tag "${slug}" must be attached at leaf granularity`,
          );
        }
        // 落叶要求 pending 为空;否则成「有叶∧pending」越界态。三态转换走
        // reconcileCategory(原子),不经此原语。
        const prodRows = await orm
          .select({ pendingCategoryTagId: product.pendingCategoryTagId })
          .from(product)
          .where(eq(product.id, productId))
          .limit(1);
        if (prodRows[0]?.pendingCategoryTagId != null) {
          throw new Error(
            `attachTag: attaching a category leaf while pending is set creates 有叶∧pending; use reconcileCategory`,
          );
        }
        // single-attribution: a product holds at most one category leaf. Refuse a
        // second, DIFFERENT leaf (re-attaching the same leaf stays a no-op below);
        // an A→B re-classification goes through reconcileCategory (drops the old leaf).
        const existingLeaf = await orm
          .select({ tagId: productTag.tagId })
          .from(productTag)
          .where(
            and(
              eq(productTag.productId, productId),
              inArray(productTag.tagId, [...leafIds]),
            ),
          )
          .limit(1);
        if (existingLeaf[0] != null && existingLeaf[0].tagId !== t.id) {
          throw new Error(
            `attachTag: product already has a different category leaf; use reconcileCategory`,
          );
        }
      }
      // (product_id, tag_id) is unique → re-attaching the same edge is a no-op.
      await orm
        .insert(productTag)
        .values({ id: newId(), productId, tagId: t.id, source, confidence })
        .onConflictDoNothing({
          target: [productTag.productId, productTag.tagId],
        });
    },

    async removeCategoryLeafTags(productId) {
      IdGate.parse(productId);
      const orm = queryOrm(db);
      const leafIds = await loadCategoryLeafTagIds(orm);
      if (leafIds.size === 0) return 0;
      // Delete only this product's edges whose tag is a category LEAF — never
      // touches attribute/brand/product_line edges.
      const result = await orm
        .delete(productTag)
        .where(
          and(
            eq(productTag.productId, productId),
            inArray(productTag.tagId, [...leafIds]),
          ),
        )
        .returning({ tagId: productTag.tagId });
      return result.length;
    },

    async setPendingCategory(productId, nodeSlug) {
      IdGate.parse(productId);
      const orm = queryOrm(db);
      const prodRows = await orm
        .select({ id: product.id })
        .from(product)
        .where(eq(product.id, productId))
        .limit(1);
      if (prodRows[0] == null) {
        throw new Error(`setPendingCategory: unknown product "${productId}"`);
      }
      let pendingId: string | null = null;
      if (nodeSlug != null) {
        const slug = CategoryTagSlugGate.parse(nodeSlug);
        const t = await loadTagBySlug(orm, slug);
        if (t == null) {
          throw new Error(`setPendingCategory: unknown tag slug "${slug}"`);
        }
        const leafIds = await loadCategoryLeafTagIds(orm);
        if (t.kind !== 'category' || leafIds.has(t.id)) {
          throw new Error(
            `setPendingCategory: "${slug}" must be a non-leaf category node`,
          );
        }
        // 待细化要求无叶;若已有 category 叶,设 pending 会造「有叶∧pending」
        // 越界态。三态转换必须走 reconcileCategory(原子)。
        const existingLeaf = await orm
          .select({ id: productTag.id })
          .from(productTag)
          .where(
            and(
              eq(productTag.productId, productId),
              inArray(productTag.tagId, [...leafIds]),
            ),
          )
          .limit(1);
        if (existingLeaf[0] != null) {
          throw new Error(
            `setPendingCategory: product has a category leaf — setting pending would create 有叶∧pending; use reconcileCategory`,
          );
        }
        pendingId = t.id;
      }
      await orm
        .update(product)
        .set({ pendingCategoryTagId: pendingId })
        .where(eq(product.id, productId));
    },

    async setRankable(productId, rankable) {
      IdGate.parse(productId);
      const orm = queryOrm(db);
      const rows = await orm
        .select({ id: product.id })
        .from(product)
        .where(eq(product.id, productId))
        .limit(1);
      if (rows[0] == null) {
        throw new Error(`setRankable: unknown product "${productId}"`);
      }
      await orm
        .update(product)
        .set({ rankable: rankable ? 1 : 0 })
        .where(eq(product.id, productId));
    },

    async reconcileCategory(input) {
      const productId = IdGate.parse(input.productId);
      const leafSrc = TagSourceSchema.parse(input.leafSource);
      const orm = queryOrm(db);
      // Product must exist (no silent no-op on a typo'd/missing id).
      const prodRows = await orm
        .select({ id: product.id })
        .from(product)
        .where(eq(product.id, productId))
        .limit(1);
      if (prodRows[0] == null) {
        throw new Error(`reconcileCategory: unknown product "${productId}"`);
      }
      const leafIds = await loadCategoryLeafTagIds(orm);
      let leafTagId: string | null = null;
      if (input.leafSlug != null) {
        const slug = CategoryTagSlugGate.parse(input.leafSlug);
        const t = await loadTagBySlug(orm, slug);
        if (t == null)
          throw new Error(`reconcileCategory: unknown leaf slug "${slug}"`);
        if (t.kind !== 'category' || !leafIds.has(t.id)) {
          throw new Error(
            `reconcileCategory: leaf slug "${slug}" is not a category leaf`,
          );
        }
        leafTagId = t.id;
      }
      let pendingId: string | null = null;
      if (input.pendingNodeSlug != null) {
        const slug = CategoryTagSlugGate.parse(input.pendingNodeSlug);
        const t = await loadTagBySlug(orm, slug);
        if (t == null)
          throw new Error(`reconcileCategory: unknown pending slug "${slug}"`);
        if (t.kind !== 'category' || leafIds.has(t.id)) {
          throw new Error(
            `reconcileCategory: pending slug "${slug}" must be a non-leaf category node`,
          );
        }
        pendingId = t.id;
      }
      if (leafTagId != null && pendingId != null) {
        throw new Error(
          'reconcileCategory: cannot set both a leaf and a pending node',
        );
      }
      const attrTagIds: string[] = [];
      for (const s of input.attributeSlugs) {
        const slug = CategoryTagSlugGate.parse(s);
        const t = await loadTagBySlug(orm, slug);
        if (t == null)
          throw new Error(`reconcileCategory: unknown attribute slug "${slug}"`);
        if (t.kind === 'category') {
          throw new Error(
            `reconcileCategory: attribute slug "${slug}" must not be a category tag`,
          );
        }
        attrTagIds.push(t.id);
      }
      const rankableInt = input.rankable ? 1 : 0;
      const leafIdsArr = [...leafIds];

      if (db.kind === 'sqlite') {
        return db.orm.transaction((tx) => {
          if (leafIdsArr.length > 0) {
            tx.delete(productTag)
              .where(
                and(
                  eq(productTag.productId, productId),
                  inArray(productTag.tagId, leafIdsArr),
                ),
              )
              .run();
          }
          if (leafTagId != null) {
            tx.insert(productTag)
              .values({
                id: newId(),
                productId,
                tagId: leafTagId,
                source: leafSrc,
                confidence: 1,
              })
              .onConflictDoNothing({
                target: [productTag.productId, productTag.tagId],
              })
              .run();
          }
          for (const aid of attrTagIds) {
            tx.insert(productTag)
              .values({
                id: newId(),
                productId,
                tagId: aid,
                source: 'rule',
                confidence: 1,
              })
              .onConflictDoNothing({
                target: [productTag.productId, productTag.tagId],
              })
              .run();
          }
          tx.update(product)
            .set({ pendingCategoryTagId: pendingId, rankable: rankableInt })
            .where(eq(product.id, productId))
            .run();
        });
      }
      // D1: batch() commits/rolls back the whole group atomically.
      const stmts = [];
      if (leafIdsArr.length > 0) {
        stmts.push(
          db.orm.delete(productTag).where(
            and(
              eq(productTag.productId, productId),
              inArray(productTag.tagId, leafIdsArr),
            ),
          ),
        );
      }
      if (leafTagId != null) {
        stmts.push(
          db.orm
            .insert(productTag)
            .values({
              id: newId(),
              productId,
              tagId: leafTagId,
              source: leafSrc,
              confidence: 1,
            })
            .onConflictDoNothing({
              target: [productTag.productId, productTag.tagId],
            }),
        );
      }
      for (const aid of attrTagIds) {
        stmts.push(
          db.orm
            .insert(productTag)
            .values({
              id: newId(),
              productId,
              tagId: aid,
              source: 'rule',
              confidence: 1,
            })
            .onConflictDoNothing({
              target: [productTag.productId, productTag.tagId],
            }),
        );
      }
      stmts.push(
        db.orm
          .update(product)
          .set({ pendingCategoryTagId: pendingId, rankable: rankableInt })
          .where(eq(product.id, productId)),
      );
      await db.orm.batch(
        stmts as unknown as Parameters<typeof db.orm.batch>[0],
      );
    },

    async resolveComparableUnit(nodeSlug) {
      const slug = CategoryTagSlugGate.parse(nodeSlug);
      const orm = queryOrm(db);
      let cursor = await loadTagBySlug(orm, slug);
      if (cursor == null || cursor.kind !== 'category') return null;
      // Walk parent_id up the is-a chain to the nearest non-null comparable_unit.
      // A bounded guard (tree depth is tiny) defends against a malformed cycle.
      let guard = 0;
      while (cursor != null && guard < 64) {
        if (cursor.comparableUnit != null) {
          return ComparableUnitSchema.parse(cursor.comparableUnit);
        }
        if (cursor.parentId == null) return null;
        const parentRows = await orm
          .select({
            id: tag.id,
            kind: tag.kind,
            parentId: tag.parentId,
            comparableUnit: tag.comparableUnit,
          })
          .from(tag)
          .where(eq(tag.id, cursor.parentId))
          .limit(1);
        cursor = parentRows[0] ?? null;
        guard += 1;
      }
      return null;
    },

    async listProductIdsInCategoryNode(nodeSlug) {
      const slug = CategoryTagSlugGate.parse(nodeSlug);
      const orm = queryOrm(db);
      const node = await loadTagBySlug(orm, slug);
      if (node == null || node.kind !== 'category') return [];
      // product_tag (leaf) → category_closure (leaf has node as an ancestor).
      // Closure rows exist only for category edges, so attribute/brand tags
      // never match here even though they live in the same product_tag table.
      const rows = await orm
        .selectDistinct({ productId: productTag.productId })
        .from(productTag)
        .innerJoin(categoryClosure, eq(categoryClosure.tagId, productTag.tagId))
        .where(eq(categoryClosure.ancestorTagId, node.id));
      return rows.map((r) => r.productId);
    },

    async lookupStoreCategory(store, nativeCategoryId) {
      const orm = queryOrm(db);
      const rows = await orm
        .select({ id: tag.id, slug: tag.slug, kind: tag.kind })
        .from(storeCategoryMap)
        .innerJoin(tag, eq(tag.id, storeCategoryMap.tagId))
        .where(
          and(
            eq(storeCategoryMap.store, store),
            eq(storeCategoryMap.nativeCategoryId, nativeCategoryId),
          ),
        )
        .limit(1);
      const hit = rows[0];
      if (hit == null) return null;
      // Leaf = no tag names this tag as its parent_id.
      const children = await orm
        .select({ id: tag.id })
        .from(tag)
        .where(eq(tag.parentId, hit.id))
        .limit(1);
      return { slug: hit.slug, kind: hit.kind, isLeaf: children.length === 0 };
    },

    async getProductAttribution(productId) {
      IdGate.parse(productId);
      const orm = queryOrm(db);
      const productRows = await orm
        .select({
          id: product.id,
          pendingCategoryTagId: product.pendingCategoryTagId,
          rankable: product.rankable,
        })
        .from(product)
        .where(eq(product.id, productId))
        .limit(1);
      const p = productRows[0];
      if (p == null) return null;

      const tagRows = await orm
        .select({
          tagId: tag.id,
          slug: tag.slug,
          name: tag.name,
          kind: tag.kind,
          parentId: tag.parentId,
          source: productTag.source,
          confidence: productTag.confidence,
        })
        .from(productTag)
        .innerJoin(tag, eq(tag.id, productTag.tagId))
        .where(eq(productTag.productId, productId));

      const leafIds = await loadCategoryLeafTagIds(orm);
      let categoryLeafSlug: string | null = null;
      const tags: ProductTagRow[] = tagRows.map((r) => {
        if (r.kind === 'category' && leafIds.has(r.tagId)) {
          categoryLeafSlug = r.slug;
        }
        return {
          tagId: r.tagId,
          slug: r.slug,
          name: r.name,
          kind: r.kind,
          source: r.source,
          confidence: r.confidence,
        };
      });

      let pendingCategorySlug: string | null = null;
      if (p.pendingCategoryTagId != null) {
        const pendingRows = await orm
          .select({ slug: tag.slug })
          .from(tag)
          .where(eq(tag.id, p.pendingCategoryTagId))
          .limit(1);
        pendingCategorySlug = pendingRows[0]?.slug ?? null;
      }

      // Three-state: classified-leaf = has leaf ∧ pending null; pending = no
      // leaf ∧ pending non-null; manual = no leaf ∧ pending null. (Mechanical.)
      const state: ProductAttribution['state'] =
        categoryLeafSlug != null
          ? 'classified-leaf'
          : p.pendingCategoryTagId != null
            ? 'pending'
            : 'manual';

      return {
        productId: p.id,
        tags,
        categoryLeafSlug,
        pendingCategorySlug,
        state,
        rankable: p.rankable === 1,
      };
    },
  };
}
