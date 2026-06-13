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
  ParsedSpecSchema,
  RawProductSchema,
  UnitPriceSchema,
  WarningsSchema,
  type CalcResult,
  type ParsedSpec,
  type RawProduct,
} from '@unit-price/core';
import { asc, eq, isNotNull, sql } from 'drizzle-orm';
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
import { corrections, product, productRaw, unitPrice } from './schema.js';

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
   * v2-reserved category filter. In v1 this is NOT pushed down to SQL (it is a
   * no-op since product.category is always "beverage", and pushing it down
   * makes the planner abandon unit_price_per100ml_idx). API-layer validation
   * enforces category=beverage; the query ignores this value in v1.
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
   * Read-only ranking query: per100ml-non-null rows joined across
   * unit_price ⋈ product ⋈ product_raw, ascending by per100ml then unit_price.id,
   * sliced by limit/offset. v1 does NOT filter by category (the input is a
   * v2-reserved no-op; see ListRankingsInput.category). Pure read — no writes,
   * no parse/calc, no recompute. Stored per100ml/formula/confidence are returned
   * verbatim; warnings are decoded to string[].
   */
  listRankings(input: ListRankingsInput): Promise<RankingRow[]>;
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
 * Single source for the v1 ranking query (shared by listRankings and the
 * EXPLAIN query-plan test). The test obtains its SQL via `.toSQL()` on this same
 * builder so the plan assertion runs against the production query — never a
 * hand-rebuilt copy that could silently drift from the JOIN/WHERE/ORDER here.
 * See listRankings for the WHERE/ORDER/category-no-op rationale.
 */
export function buildRankingsQuery(
  orm: BetterSQLite3Database<Record<string, never>>,
  input: ListRankingsInput,
) {
  return orm
    .select({
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
    })
    .from(unitPrice)
    // product join is the unit_price → product_raw bridge (no columns
    // taken from it); kept so the projection can reach product_raw.
    .innerJoin(product, eq(product.id, unitPrice.productId))
    .innerJoin(productRaw, eq(productRaw.id, product.rawId))
    // v1 does NOT push down `category`: product.category is always
    // "beverage", so the equality predicate is a no-op AND it makes the
    // SQLite planner drive from `product` (full SCAN + TEMP B-TREE) and
    // abandon unit_price_per100ml_idx. The API layer already validates
    // category=beverage; v2 (real categories) pushes the predicate down
    // and pairs it with a composite (category, per100ml, id) index.
    .where(isNotNull(unitPrice.per100ml))
    .orderBy(asc(unitPrice.per100ml), asc(unitPrice.id))
    .limit(input.limit)
    .offset(input.offset);
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
      // Read-only projection. confidence is taken explicitly from unit_price
      // (the authoritative band) — product also has a `confidence` column
      // (parse-time intermediate) and must NOT be selected here. per100ml/
      // formula/confidence are stored values, never recomputed from the cents
      // price. The WHERE keeps only per100ml-non-null rows (volume axis);
      // ORDER BY per100ml ASC walks unit_price_per100ml_idx, and the same-table
      // unit_price.id tiebreak makes same-value pages stable. Slicing is in SQL
      // (LIMIT/OFFSET) — rows are never pulled into app memory to sort. The
      // query is built by the shared buildRankingsQuery so the EXPLAIN test runs
      // against this exact SQL (no drift).
      const rows = await buildRankingsQuery(orm, input);

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
  };
}
