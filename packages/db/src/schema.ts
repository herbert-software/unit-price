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
export const product = sqliteTable('product', {
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
});

/**
 * Calculator output (`CalcResult`, not just `UnitPrice`) for a product.
 * `per100ml`/`formula` come straight from core (never recomputed from the
 * stored integer-cents price); `formula` embeds yuan amounts and is
 * self-contained for replay. "Definitely not computable" is expressed as
 * `per100ml = NULL` (never 0 or a missing row).
 */
export const unitPrice = sqliteTable(
  'unit_price',
  {
    id: text('id').primaryKey(),
    productId: text('product_id')
      .notNull()
      .references(() => product.id),
    per100ml: real('per100ml'),
    formula: text('formula'),
    /** CalcResult.confidence — the single authoritative confidence band. */
    confidence: real('confidence').notNull(),
    /** JSON-text array validated by WarningsSchema; empty array is "[]". */
    warnings: text('warnings').notNull(),
  },
  (t) => [
    // Numeric (REAL) ordering index for future per-100ml rankings.
    index('unit_price_per100ml_idx').on(t.per100ml),
    // One unit_price row per product (saveParsed writes them 1:1).
    uniqueIndex('unit_price_product_id_unique').on(t.productId),
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
