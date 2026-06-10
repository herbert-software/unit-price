// Typed data-access layer with bidirectional Zod validation against the core
// schema SOT. Writes validate domain inputs before touching the database
// (validation failure throws a ZodError carrying field paths and writes
// nothing); reads rebuild typed domain objects and re-validate them — callers
// never see bare rows.
//
// No domain computation happens here: per100ml/formula are stored verbatim
// from core's CalcResult (never recomputed from the integer-cents price), and
// the only transformations are storage codecs (see codec.ts).
import {
  ParsedSpecSchema,
  RawProductSchema,
  UnitPriceSchema,
  WarningsSchema,
  type CalcResult,
  type ParsedSpec,
  type RawProduct,
} from '@unit-price/core';
import { eq, sql } from 'drizzle-orm';
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
 * UnitPriceSchema it enforces two storage invariants: per100ml must be finite
 * when present, and per100ml/formula are NULL together or set together
 * (uncomputable → both NULL; computable → both non-null).
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
    if ((up.per100ml === null) !== (up.formula === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['per100ml'],
        message: 'per100ml and formula must be both NULL or both set',
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
  /** CalcResult shape: { unitPrice: { per100ml, formula }, confidence, warnings }. */
  calc: CalcResult;
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
      };
      const unitPriceRow = {
        id: unitPriceId,
        productId,
        per100ml: calc.unitPrice.per100ml,
        formula: calc.unitPrice.formula,
        confidence: calc.confidence,
        warnings: encodeJson(calc.warnings),
      };

      if (db.kind === 'sqlite') {
        // better-sqlite3 transactions are native and synchronous: the
        // callback must not await, or statements escape the tx boundary.
        db.orm.transaction((tx) => {
          tx.insert(product).values(productRow).run();
          tx.insert(unitPrice).values(unitPriceRow).run();
        });
      } else {
        // D1 rejects explicit BEGIN/COMMIT; batch() is its atomic-write API
        // (the whole group commits or rolls back together).
        await db.orm.batch([
          db.orm.insert(product).values(productRow),
          db.orm.insert(unitPrice).values(unitPriceRow),
        ]);
      }
      return { productId, unitPriceId };
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
        unitPrice: { per100ml: up.per100ml, formula: up.formula },
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
  };
}
