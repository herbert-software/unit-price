// Drizzle schema (sqlite dialect) for the product persistence layer.
//
// Portability invariant: only SQLite↔Postgres-equivalent column types are
// used — app-generated TEXT primary keys (UUID), JSON payloads as TEXT
// ("JSON-text"), money as INTEGER cents, timestamps as INTEGER epoch,
// ratios/confidence as REAL. No native arrays, jsonb, serial/auto-increment
// PKs, or numeric.
//
// Domain fields mirror @unit-price/core types (RawProduct / ParsedSpec /
// CalcResult); provenance/FK/timestamp columns (store, store_sku, source,
// source_url, captured_at, raw_id, …) are storage extras, not domain fields.
import {
  type AnySQLiteColumn,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/**
 * Raw reported products, one row per `(store, store_sku)` dedupe key.
 * Stores the original observation only — no parse/calc derived columns.
 * Domain part aligns with `RawProductSchema` (title, price, categoryHint);
 * `price` is stored as exact integer cents (`Math.round(yuan * 100)`).
 */
export const productRaw = sqliteTable(
  'product_raw',
  {
    /** App-generated TEXT id (UUID/ULID) — never auto-increment. */
    id: text('id').primaryKey(),
    store: text('store').notNull(),
    storeSku: text('store_sku').notNull(),
    /** RawProduct.title — z.string().min(1). */
    title: text('title').notNull(),
    /** RawProduct.price as integer cents (exact, no float money). */
    price: integer('price').notNull(),
    /** RawProduct.categoryHint (optional → nullable column). */
    categoryHint: text('category_hint'),
    source: text('source'),
    sourceUrl: text('source_url'),
    /** Epoch (ms) of the most recent observation; set at ingest time. */
    capturedAt: integer('captured_at').notNull(),
  },
  (t) => [
    // Dedupe key: deterministic, price-independent — a price change is an
    // update of the same row, not a new row.
    uniqueIndex('product_raw_store_store_sku_unique').on(t.store, t.storeSku),
  ],
);

/**
 * Normalized product derived from a `ParsedSpec`, linked to its source raw
 * row. Measurement fields are split into queryable `*_value` REAL +
 * `*_unit` TEXT columns; optional ParsedSpec fields are nullable columns
 * (undefined/null both normalize to NULL). `confidence` here is
 * `ParsedSpec.confidence` (parse-time confidence), distinct from
 * `unit_price.confidence`.
 */
export const product = sqliteTable(
  'product',
  {
    id: text('id').primaryKey(),
    rawId: text('raw_id')
      .notNull()
      .references(() => productRaw.id),
    unitSizeValue: real('unit_size_value'),
    unitSizeUnit: text('unit_size_unit'),
    quantity: real('quantity'),
    /** JSON-text array (e.g. "[1]"); NOT NULL — core defaults to [1]. */
    multipliers: text('multipliers').notNull(),
    totalAmountValue: real('total_amount_value'),
    totalAmountUnit: text('total_amount_unit'),
    packageUnit: text('package_unit'),
    /** Free-form category string (currently always "beverage"). */
    category: text('category').notNull(),
    /** ParsedSpec.confidence — parse confidence (intermediate value). */
    confidence: real('confidence').notNull(),
    /**
     * Provenance/convergence extra (like `raw_id`), NOT a domain field and
     * not part of ParsedSpec: a deterministic key over `(raw_id + normalized
     * ParsedSpec)`, price-independent. The unique index makes the first
     * inserted equivalent row win ("keep the oldest"). Portable TEXT type.
     */
    dedupeKey: text('dedupe_key').notNull(),
    /**
     * Category-attribution extra (NOT a domain field, NOT in `dedupe_key`):
     * the "粗分类/待细化" non-leaf terminal pointer. Non-null IFF the product is
     * in the 待细化 (pending) state — a coarse `tag` (non-leaf category node) is
     * mapped but no leaf `product_tag` is attached yet. The three category-
     * attribution states are field-discriminable: 已分类叶 = has a kind=category
     * leaf product_tag ∧ pending NULL; 待细化 = no leaf ∧ pending non-null;
     * 待人工 = no leaf ∧ pending NULL. Nullable; references `tag`.
     */
    pendingCategoryTagId: text('pending_category_tag_id').references(
      () => tag.id,
    ),
    /**
     * Derived (NOT a domain field, NOT in `dedupe_key`): true IFF the product is
     * 已分类叶 AND that leaf resolves a non-null `comparable_unit` (per_100ml on
     * the soft-drink line / dairy line / each 酒种 leaf). 待细化 / 待人工 (no leaf)
     * are false; the `酒类` parent resolves null but is never a product's leaf.
     * Recomputed by every category-attribution write path; never read stale.
     *
     * Migration safety (B1/D8): added as `INTEGER NOT NULL DEFAULT 0` — the
     * production `product` table is non-empty and push-to-main auto-migrates;
     * SQLite refuses a `NOT NULL` column with no DEFAULT on a non-empty table.
     * Existing rows initialize to 0, then category-tagging backfill recomputes.
     */
    rankable: integer('rankable').notNull().default(0),
  },
  (t) => [
    // Dedupe convergence: one product row per `(raw_id + normalized spec)`.
    // First successful insert wins; later equivalent rows are rejected/no-op.
    uniqueIndex('product_dedupe_key_unique').on(t.dedupeKey),
  ],
);

/**
 * Calculator output (`CalcResult`, not just `UnitPrice`) for a product.
 * `per100ml`/`per100g`/`formula` come straight from core (never recomputed
 * from the stored integer-cents price); `formula` embeds yuan amounts and is
 * self-contained for replay. A product falls on exactly one axis: `per100ml`
 * (volume) XOR `per100g` (weight) — at most one is non-null. "Definitely not
 * computable" is expressed as `per100ml = per100g = NULL` (never 0 or a
 * missing row).
 */
export const unitPrice = sqliteTable(
  'unit_price',
  {
    id: text('id').primaryKey(),
    productId: text('product_id')
      .notNull()
      .references(() => product.id),
    per100ml: real('per100ml'),
    per100g: real('per100g'),
    formula: text('formula'),
    /** CalcResult.confidence — the single authoritative confidence band. */
    confidence: real('confidence').notNull(),
    /** JSON-text array validated by WarningsSchema; empty array is "[]". */
    warnings: text('warnings').notNull(),
  },
  (t) => [
    // Numeric (REAL) ordering index for future per-100ml rankings.
    index('unit_price_per100ml_idx').on(t.per100ml),
    // Symmetric numeric (REAL) ordering index for per-100g rankings.
    index('unit_price_per100g_idx').on(t.per100g),
    // One unit_price row per product (saveParsed writes them 1:1).
    uniqueIndex('unit_price_product_id_unique').on(t.productId),
  ],
);

/**
 * Tag dictionary (store-agnostic). `kind` partitions the axes:
 * - `category`: an is-a tree (single-attribution). `parent_id` builds the tree
 *   (NULL at root); `comparable_unit` is single-point-bound on a node and
 *   inherited downward (see `resolveComparableUnit`) — NOT repeated per leaf.
 *   Only `category` participates in `category_closure`.
 * - `attribute` / `brand` / `product_line`: flat axes; `parent_id` /
 *   `comparable_unit` stay NULL and they never appear in the closure.
 *
 * `comparable_unit` is a nullable TEXT (`per_100ml` is the only value seeded
 * this period; `per_100g` / `per_100sheet` are v2 placeholders — NOT seeded).
 * `slug` is unique so seeds are idempotent and lookups are stable.
 */
export const tag = sqliteTable(
  'tag',
  {
    id: text('id').primaryKey(),
    /** Stable store-agnostic identifier (e.g. "carbonated"); unique. */
    slug: text('slug').notNull(),
    /** Human-readable display name (e.g. "碳酸饮料"). */
    name: text('name').notNull(),
    /** TagKind: category / attribute / brand / product_line. */
    kind: text('kind').notNull(),
    /**
     * is-a parent (category kind only; NULL at root and on flat axes). Drizzle
     * self-reference uses an inline FK callback (AnySQLiteColumn return type).
     */
    parentId: text('parent_id').references((): AnySQLiteColumn => tag.id),
    /**
     * Single-point-bound comparable unit (category kind only). Nullable:
     * resolution inherits the nearest non-null ancestor up the is-a chain; a
     * node whose chain to root is all-NULL is not rankable.
     */
    comparableUnit: text('comparable_unit'),
  },
  (t) => [uniqueIndex('tag_slug_unique').on(t.slug)],
);

/**
 * Product↔tag edges. Stores ONLY atomic/leaf tags (kind=category leaves +
 * attribute/brand/product_line). A non-leaf "待细化" attribution is NOT written
 * here — it lives in `product.pending_category_tag_id`. `(product_id, tag_id)`
 * is unique, which makes re-attaching the same edge a no-op (idempotent).
 */
export const productTag = sqliteTable(
  'product_tag',
  {
    id: text('id').primaryKey(),
    productId: text('product_id')
      .notNull()
      .references(() => product.id),
    tagId: text('tag_id')
      .notNull()
      .references(() => tag.id),
    /** TagSource: rule / store-map / manual (no `llm` this period). */
    source: text('source').notNull(),
    /** Rule/mapping confidence (REAL). */
    confidence: real('confidence').notNull(),
  },
  (t) => [
    uniqueIndex('product_tag_product_id_tag_id_unique').on(
      t.productId,
      t.tagId,
    ),
  ],
);

/**
 * Per-store native category → our canonical tag, N:1. A coarse native category
 * may only map to a coarse (non-leaf) node — never down to a leaf; a native
 * with no v1-tree match is simply not seeded (left to 待人工). `(store,
 * native_category_id)` is unique. `native_category_id` is stored as portable
 * TEXT (the store's id, e.g. Sam's `categoryIdList` leaf id as a string).
 */
export const storeCategoryMap = sqliteTable(
  'store_category_map',
  {
    id: text('id').primaryKey(),
    store: text('store').notNull(),
    nativeCategoryId: text('native_category_id').notNull(),
    tagId: text('tag_id')
      .notNull()
      .references(() => tag.id),
  },
  (t) => [
    uniqueIndex('store_category_map_store_native_category_id_unique').on(
      t.store,
      t.nativeCategoryId,
    ),
  ],
);

/**
 * Category is-a closure, materialized on the tag axis (NOT product×ancestor —
 * that would grow with the catalog). One row per `(tag_id, ancestor_tag_id)`
 * where `ancestor_tag_id` is a category ancestor of `tag_id` up to (and
 * including) the root. Holds ONLY `category` is-a edges; attribute/brand axes
 * have no closure rows. A product is a member of a node by `product_tag`
 * (kind=category leaf) JOIN this table. Includes the self row (tag = ancestor)
 * so a leaf joins itself. `(tag_id, ancestor_tag_id)` is unique.
 */
export const categoryClosure = sqliteTable(
  'category_closure',
  {
    id: text('id').primaryKey(),
    tagId: text('tag_id')
      .notNull()
      .references(() => tag.id),
    ancestorTagId: text('ancestor_tag_id')
      .notNull()
      .references(() => tag.id),
  },
  (t) => [
    uniqueIndex('category_closure_tag_id_ancestor_tag_id_unique').on(
      t.tagId,
      t.ancestorTagId,
    ),
  ],
);

/**
 * Manual corrections, kept as independent rows — the original
 * `product_raw`/`product` rows are never mutated in place.
 */
export const corrections = sqliteTable('corrections', {
  id: text('id').primaryKey(),
  productId: text('product_id')
    .notNull()
    .references(() => product.id),
  rawId: text('raw_id')
    .notNull()
    .references(() => productRaw.id),
  /** JSON-text holding a ParsedSpec-shaped object (ParsedSpecSchema-valid). */
  correctedSpec: text('corrected_spec').notNull(),
  parseSource: text('parse_source').notNull().default('manual_corrected'),
  /** Epoch (ms). */
  createdAt: integer('created_at').notNull(),
});
