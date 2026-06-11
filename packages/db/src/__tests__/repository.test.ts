import {
  calculate,
  ParsedSpecSchema,
  type CalcResult,
  type ParsedSpec,
} from '@unit-price/core';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { centsToYuan, yuanToCents } from '../codec.js';
import { createDb, type DbConnection } from '../db.js';
import { createRepository } from '../repository.js';
import { countRows, openTestDb, type TestDb } from './harness.js';

/** Full consistent spec: 1L × 6 bottles, explicit 6L total. */
const fullSpec: ParsedSpec = ParsedSpecSchema.parse({
  unitSize: { value: 1, unit: 'L' },
  quantity: 6,
  multipliers: [1],
  totalAmount: { value: 6, unit: 'L' },
  packageUnit: '瓶',
  category: 'beverage',
  confidence: 0.9,
});

/** Real core output for the full spec at ¥39.9 (per100ml = 0.665). */
const fullCalc: CalcResult = calculate(fullSpec, 39.9);

function rawInput(overrides: Record<string, unknown> = {}) {
  return {
    store: 'sam',
    storeSku: 'sku-1',
    raw: { title: '100%椰子水 1L*6瓶', price: 39.9 },
    source: 'surge',
    capturedAt: 1_700_000_000_000,
    ...overrides,
  };
}

async function expectZodReject(
  promise: Promise<unknown>,
  pathPart: string,
): Promise<void> {
  const err = await promise.then(
    () => {
      throw new Error('expected promise to reject with a ZodError');
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ZodError);
  const paths = (err as ZodError).issues.map((issue) => issue.path.join('.'));
  expect(
    paths.some((p) => p.includes(pathPart)),
    `expected a Zod issue path containing "${pathPart}", got: ${paths.join(', ')}`,
  ).toBe(true);
}

describe('connection injection', () => {
  it('createDb throws a clear error when the connection is missing', () => {
    expect(() => createDb(undefined)).toThrow(/connection missing/i);
    expect(() => createDb(null)).toThrow(/connection missing/i);
  });

  it('createDb throws when the sqlite handle is not open', () => {
    const handle = new Database(':memory:');
    handle.close();
    expect(() => createDb(handle)).toThrow(/not open/i);
  });

  it('createDb throws on an unrecognized connection shape', () => {
    expect(() => createDb({} as unknown as DbConnection)).toThrow(
      /unrecognized/i,
    );
  });

  it('createRepository throws without an initialized Db', () => {
    expect(() =>
      createRepository(undefined as unknown as Parameters<typeof createRepository>[0]),
    ).toThrow(/missing or invalid/i);
  });
});

describe('upsertRaw', () => {
  let t: TestDb;
  beforeEach(() => {
    t = openTestDb();
  });

  it('keeps a single row per (store, store_sku) and updates price/captured_at', async () => {
    const id1 = await t.repo.upsertRaw(
      rawInput({ raw: { title: '椰子水', price: 39.9 }, capturedAt: 1_000 }),
    );
    const id2 = await t.repo.upsertRaw(
      rawInput({ raw: { title: '椰子水(新价)', price: 35.5 }, capturedAt: 2_000 }),
    );
    expect(id2).toBe(id1);
    expect(countRows(t.handle, 'product_raw')).toBe(1);
    const row = t.handle
      .prepare('SELECT title, price, captured_at FROM product_raw WHERE id = ?')
      .get(id1) as { title: string; price: number; captured_at: number };
    expect(row.title).toBe('椰子水(新价)');
    expect(row.price).toBe(3550);
    expect(row.captured_at).toBe(2_000);
  });

  it('rejects empty store / store_sku before writing anything', async () => {
    await expectZodReject(t.repo.upsertRaw(rawInput({ store: '' })), 'store');
    await expectZodReject(
      t.repo.upsertRaw(rawInput({ storeSku: '' })),
      'storeSku',
    );
    await expectZodReject(
      t.repo.upsertRaw(rawInput({ storeSku: undefined })),
      'storeSku',
    );
    expect(countRows(t.handle, 'product_raw')).toBe(0);
  });

  it('rejects whitespace-only store and trims the dedupe key before storing', async () => {
    await expectZodReject(t.repo.upsertRaw(rawInput({ store: ' ' })), 'store');
    expect(countRows(t.handle, 'product_raw')).toBe(0);

    const id1 = await t.repo.upsertRaw(rawInput({ storeSku: 'sku-1' }));
    const id2 = await t.repo.upsertRaw(rawInput({ storeSku: 'sku-1 ' }));
    expect(id2).toBe(id1);
    expect(countRows(t.handle, 'product_raw')).toBe(1);
  });

  it('rejects a non-finite price without writing anything', async () => {
    await expectZodReject(
      t.repo.upsertRaw(rawInput({ raw: { title: '椰子水', price: Infinity } })),
      'price',
    );
    expect(countRows(t.handle, 'product_raw')).toBe(0);
  });

  it('rejects a finite price whose cents overflow the safe-integer range', async () => {
    await expect(
      t.repo.upsertRaw(rawInput({ raw: { title: '测试', price: 1e307 } })),
    ).rejects.toThrow(/price out of exact integer-cents range/i);
    expect(countRows(t.handle, 'product_raw')).toBe(0);
  });

  it('stores a negative price faithfully (product_raw never enforces positivity)', async () => {
    const id = await t.repo.upsertRaw(
      rawInput({ raw: { title: '测试', price: -39.9 } }),
    );
    const row = t.handle
      .prepare('SELECT price FROM product_raw WHERE id = ?')
      .get(id) as { price: number };
    expect(row.price).toBe(-3990);
  });

  it('rejects a finite price whose cents are finite but beyond safe-integer range', async () => {
    await expect(
      t.repo.upsertRaw(rawInput({ raw: { title: '测试', price: 1e15 } })),
    ).rejects.toThrow(/price out of exact integer-cents range/i);
    expect(countRows(t.handle, 'product_raw')).toBe(0);
  });

  it('rejects a capturedAt that is an integer but not a safe integer', async () => {
    expect(Number.isInteger(1e300)).toBe(true);
    await expect(
      t.repo.upsertRaw(rawInput({ capturedAt: 1e300 })),
    ).rejects.toThrow(/safe-integer epoch milliseconds/i);
    expect(countRows(t.handle, 'product_raw')).toBe(0);
  });

  it('rejects an invalid capturedAt Date with a timestamp error, not a NOT NULL error', async () => {
    await expect(
      t.repo.upsertRaw(rawInput({ capturedAt: new Date('garbage') })),
    ).rejects.toThrow(/invalid timestamp/i);
    expect(countRows(t.handle, 'product_raw')).toBe(0);
  });

  it('rejects a RawProduct that fails RawProductSchema (empty title)', async () => {
    await expectZodReject(
      t.repo.upsertRaw(rawInput({ raw: { title: '', price: 1 } })),
      'title',
    );
    expect(countRows(t.handle, 'product_raw')).toBe(0);
  });

  it('stores money as integer cents via Math.round (never truncation)', async () => {
    // Pin the float trap that mandates round: 0.29*100 truncates to 28.
    expect(Math.trunc(0.29 * 100)).toBe(28);
    expect(yuanToCents(0.29)).toBe(29);

    const cases: Array<[number, number]> = [
      [0.29, 29],
      [0.57, 57],
      [39.9, 3990],
    ];
    for (const [yuan, cents] of cases) {
      const id = await t.repo.upsertRaw(
        rawInput({
          storeSku: `sku-${cents}`,
          raw: { title: '测试', price: yuan },
        }),
      );
      const row = t.handle
        .prepare('SELECT price FROM product_raw WHERE id = ?')
        .get(id) as { price: number };
      expect(Number.isInteger(row.price)).toBe(true);
      expect(row.price).toBe(cents);
      expect(centsToYuan(row.price)).toBe(yuan);
    }
  });

  it('keeps prior provenance when a price-only resubmit omits optional fields', async () => {
    const id1 = await t.repo.upsertRaw({
      store: 'sam',
      storeSku: 'sku-1',
      raw: { title: '椰子水', price: 39.9, categoryHint: '饮料' },
      source: 'surge',
      sourceUrl: 'https://x/1',
      capturedAt: 1_000,
    });
    // Resubmit updates title/price/captured_at but omits source/sourceUrl/categoryHint.
    const id2 = await t.repo.upsertRaw({
      store: 'sam',
      storeSku: 'sku-1',
      raw: { title: '椰子水(新价)', price: 35.5 },
      capturedAt: 2_000,
    });
    expect(id2).toBe(id1);
    const row = t.handle
      .prepare(
        'SELECT title, price, source, source_url, category_hint, captured_at FROM product_raw WHERE id = ?',
      )
      .get(id1) as Record<string, unknown>;
    expect(row.title).toBe('椰子水(新价)'); // latest observation
    expect(row.price).toBe(3550); // latest observation
    expect(row.captured_at).toBe(2_000); // latest observation
    expect(row.source).toBe('surge'); // preserved, not nulled
    expect(row.source_url).toBe('https://x/1'); // preserved
    expect(row.category_hint).toBe('饮料'); // preserved
  });

  it('overwrites provenance when a resubmit supplies new non-null values', async () => {
    const id1 = await t.repo.upsertRaw({
      store: 'sam',
      storeSku: 'sku-1',
      raw: { title: 'a', price: 10, categoryHint: '饮料' },
      source: 'surge',
      sourceUrl: 'https://x/1',
      capturedAt: 1_000,
    });
    await t.repo.upsertRaw({
      store: 'sam',
      storeSku: 'sku-1',
      raw: { title: 'a', price: 10, categoryHint: '乳品' },
      source: 'plugin',
      sourceUrl: 'https://x/2',
      capturedAt: 2_000,
    });
    const row = t.handle
      .prepare(
        'SELECT source, source_url, category_hint FROM product_raw WHERE id = ?',
      )
      .get(id1) as Record<string, unknown>;
    expect(row.source).toBe('plugin');
    expect(row.source_url).toBe('https://x/2');
    expect(row.category_hint).toBe('乳品');
  });
});

describe('saveParsed + getProduct', () => {
  let t: TestDb;
  let rawId: string;
  beforeEach(async () => {
    t = openTestDb();
    rawId = await t.repo.upsertRaw(rawInput());
  });

  it('round-trips a full spec + CalcResult as typed domain objects', async () => {
    const { productId } = await t.repo.saveParsed({
      rawId,
      spec: fullSpec,
      calc: fullCalc,
    });
    const record = await t.repo.getProduct(productId);
    expect(record).not.toBeNull();
    expect(record!.rawId).toBe(rawId);
    expect(record!.spec).toEqual(fullSpec);
    expect(record!.calc).toEqual(fullCalc);
  });

  it('stores per100ml verbatim from core, not recomputed from stored cents', async () => {
    const { productId } = await t.repo.saveParsed({
      rawId,
      spec: fullSpec,
      calc: fullCalc,
    });
    const row = t.handle
      .prepare('SELECT per100ml FROM unit_price WHERE product_id = ?')
      .get(productId) as { per100ml: number };
    // Exactly the core float (¥39.9 / 6000ml × 100).
    expect(row.per100ml).toBe(fullCalc.unitPrice.per100ml);
    expect(row.per100ml).toBe((39.9 / 6000) * 100);
    // The stored integer-cents price (3990) would give 66.5 if someone
    // recomputed in-repo with the wrong scale — must not happen.
    const cents = (
      t.handle
        .prepare('SELECT price FROM product_raw WHERE id = ?')
        .get(rawId) as { price: number }
    ).price;
    expect(row.per100ml).not.toBe((cents / 6000) * 100);
  });

  it('round-trips a partial spec; undefined and null both normalize to NULL', async () => {
    const omitted = ParsedSpecSchema.parse({
      unitSize: { value: 330, unit: 'ml' },
      category: 'beverage',
      confidence: 0.5,
    });
    const explicitNull = ParsedSpecSchema.parse({
      unitSize: { value: 330, unit: 'ml' },
      quantity: null,
      totalAmount: null,
      packageUnit: null,
      category: 'beverage',
      confidence: 0.5,
    });
    const calc = calculate(omitted, 4.5); // uncomputable: no usable total

    for (const spec of [omitted, explicitNull]) {
      const { productId } = await t.repo.saveParsed({ rawId, spec, calc });
      const cols = t.handle
        .prepare(
          'SELECT quantity, total_amount_value, total_amount_unit, package_unit FROM product WHERE id = ?',
        )
        .get(productId) as Record<string, unknown>;
      expect(cols.quantity).toBeNull();
      expect(cols.total_amount_value).toBeNull();
      expect(cols.total_amount_unit).toBeNull();
      expect(cols.package_unit).toBeNull();

      const record = await t.repo.getProduct(productId);
      expect(record!.spec).toEqual({
        unitSize: { value: 330, unit: 'ml' },
        quantity: null,
        multipliers: [1],
        totalAmount: null,
        packageUnit: null,
        category: 'beverage',
        confidence: 0.5,
      });
    }
  });

  it('round-trips JSON-text columns: multipliers=[1,2], warnings=[] (NOT NULL, "[]")', async () => {
    const spec = ParsedSpecSchema.parse({ ...fullSpec, multipliers: [1, 2] });
    expect(fullCalc.warnings).toEqual([]);
    const { productId } = await t.repo.saveParsed({
      rawId,
      spec,
      calc: fullCalc,
    });
    const stored = t.handle
      .prepare(
        'SELECT p.multipliers AS m, u.warnings AS w FROM product p JOIN unit_price u ON u.product_id = p.id WHERE p.id = ?',
      )
      .get(productId) as { m: string; w: string };
    expect(stored.m).toBe('[1,2]');
    expect(stored.w).toBe('[]');

    const record = await t.repo.getProduct(productId);
    expect(record!.spec.multipliers).toEqual([1, 2]);
    expect(record!.calc.warnings).toEqual([]);
  });

  it('stores "definitely uncomputable" as per100ml NULL, never 0', async () => {
    const uncomputable = calculate(fullSpec, -1);
    expect(uncomputable.unitPrice.per100ml).toBeNull();
    const { productId } = await t.repo.saveParsed({
      rawId,
      spec: fullSpec,
      calc: uncomputable,
    });
    const row = t.handle
      .prepare('SELECT per100ml, formula FROM unit_price WHERE product_id = ?')
      .get(productId) as { per100ml: unknown; formula: unknown };
    expect(row.per100ml).toBeNull();
    expect(row.per100ml).not.toBe(0);
    expect(row.formula).toBeNull();

    const record = await t.repo.getProduct(productId);
    expect(record!.calc.unitPrice.per100ml).toBeNull();
  });

  it('keeps parse confidence and authoritative band in their own columns', async () => {
    const spec = ParsedSpecSchema.parse({ ...fullSpec, confidence: 0.6 });
    expect(fullCalc.confidence).toBe(0.95);
    const { productId } = await t.repo.saveParsed({
      rawId,
      spec,
      calc: fullCalc,
    });
    const cols = t.handle
      .prepare(
        'SELECT p.confidence AS parse_conf, u.confidence AS band FROM product p JOIN unit_price u ON u.product_id = p.id WHERE p.id = ?',
      )
      .get(productId) as { parse_conf: number; band: number };
    expect(cols.parse_conf).toBe(0.6);
    expect(cols.band).toBe(0.95);

    const record = await t.repo.getProduct(productId);
    expect(record!.spec.confidence).toBe(0.6);
    expect(record!.calc.confidence).toBe(0.95);
  });

  it('rejects an invalid ParsedSpec (confidence=1.2) without writing rows', async () => {
    const bad = { ...fullSpec, confidence: 1.2 } as ParsedSpec;
    await expectZodReject(
      t.repo.saveParsed({ rawId, spec: bad, calc: fullCalc }),
      'confidence',
    );
    expect(countRows(t.handle, 'product')).toBe(0);
    expect(countRows(t.handle, 'unit_price')).toBe(0);
  });

  it('rejects an invalid CalcResult (confidence=1.2, non-string warning) without writing rows', async () => {
    const badConfidence = { ...fullCalc, confidence: 1.2 } as CalcResult;
    await expectZodReject(
      t.repo.saveParsed({ rawId, spec: fullSpec, calc: badConfidence }),
      'confidence',
    );
    const badWarnings = {
      ...fullCalc,
      warnings: [42],
    } as unknown as CalcResult;
    await expectZodReject(
      t.repo.saveParsed({ rawId, spec: fullSpec, calc: badWarnings }),
      'warnings',
    );
    expect(countRows(t.handle, 'product')).toBe(0);
    expect(countRows(t.handle, 'unit_price')).toBe(0);
  });

  it('rejects an explicit empty-string productId/unitPriceId without writing rows', async () => {
    await expect(
      t.repo.saveParsed({ rawId, spec: fullSpec, calc: fullCalc, productId: '' }),
    ).rejects.toThrow(ZodError);
    await expect(
      t.repo.saveParsed({
        rawId,
        spec: fullSpec,
        calc: fullCalc,
        unitPriceId: '',
      }),
    ).rejects.toThrow(ZodError);
    expect(countRows(t.handle, 'product')).toBe(0);
    expect(countRows(t.handle, 'unit_price')).toBe(0);
  });

  it('rejects non-finite spec numbers (multipliers=[Infinity]) without writing rows', async () => {
    const bad = { ...fullSpec, multipliers: [Infinity] } as ParsedSpec;
    await expectZodReject(
      t.repo.saveParsed({ rawId, spec: bad, calc: fullCalc }),
      'multipliers',
    );
    expect(countRows(t.handle, 'product')).toBe(0);
    expect(countRows(t.handle, 'unit_price')).toBe(0);
  });

  it('rejects a non-finite per100ml without writing rows', async () => {
    const bad = {
      ...fullCalc,
      unitPrice: { per100ml: Infinity, formula: '39.9/660*100' },
    } as CalcResult;
    await expectZodReject(
      t.repo.saveParsed({ rawId, spec: fullSpec, calc: bad }),
      'per100ml',
    );
    expect(countRows(t.handle, 'unit_price')).toBe(0);
  });

  it('rejects a mixed per100ml/formula NULL state without writing rows', async () => {
    const bad = {
      ...fullCalc,
      unitPrice: { per100ml: null, formula: '39.9/660*100' },
    } as CalcResult;
    await expectZodReject(
      t.repo.saveParsed({ rawId, spec: fullSpec, calc: bad }),
      'per100ml',
    );
    expect(countRows(t.handle, 'unit_price')).toBe(0);
  });

  it('enforces the raw_id foreign key (PRAGMA foreign_keys=ON is effective)', async () => {
    await expect(
      t.repo.saveParsed({
        rawId: 'no-such-raw',
        spec: fullSpec,
        calc: fullCalc,
      }),
    ).rejects.toThrow(/FOREIGN KEY/i);
    expect(countRows(t.handle, 'product')).toBe(0);
    expect(countRows(t.handle, 'unit_price')).toBe(0);
  });

  it('is atomic: a failing unit_price insert rolls the product row back', async () => {
    const first = await t.repo.saveParsed({
      rawId,
      spec: fullSpec,
      calc: fullCalc,
    });
    expect(countRows(t.handle, 'product')).toBe(1);
    expect(countRows(t.handle, 'unit_price')).toBe(1);

    // The second call MUST take the real insert path so the unit_price insert
    // is actually attempted — under dedupe a same-spec resubmit would hit the
    // existing-row branch and never insert unit_price, so the UNIQUE conflict
    // would never fire. Use a DIFFERENT spec (→ different dedupe_key → product
    // insert succeeds), then reuse the first unit_price PK to force the second
    // statement of the transaction to fail. The product insert succeeds inside
    // the tx, then the unit_price PK UNIQUE violation must roll it back.
    const otherSpec = ParsedSpecSchema.parse({ ...fullSpec, quantity: 12 });
    const otherCalc = calculate(otherSpec, 39.9);
    await expect(
      t.repo.saveParsed({
        rawId,
        spec: otherSpec,
        calc: otherCalc,
        unitPriceId: first.unitPriceId,
      }),
    ).rejects.toThrow(/UNIQUE/i);
    // Product rolled back to the pre-call count (no orphan product row, no
    // extra unit_price): still exactly the first pair.
    expect(countRows(t.handle, 'product')).toBe(1);
    expect(countRows(t.handle, 'unit_price')).toBe(1);
  });

  it('getProduct throws on half-NULL measurement columns (corrupt row guard)', async () => {
    const { productId } = await t.repo.saveParsed({
      rawId,
      spec: fullSpec,
      calc: fullCalc,
    });
    t.handle
      .prepare('UPDATE product SET unit_size_unit = NULL WHERE id = ?')
      .run(productId);
    await expect(t.repo.getProduct(productId)).rejects.toThrow(
      /corrupt measurement/i,
    );
  });

  it('getProduct returns null for an unknown id', async () => {
    expect(await t.repo.getProduct('missing-id')).toBeNull();
  });
});

describe('saveParsed dedupe (sqlite path)', () => {
  let t: TestDb;
  let rawId: string;
  beforeEach(async () => {
    t = openTestDb();
    rawId = await t.repo.upsertRaw(rawInput());
  });

  it('same rawId + same spec twice → one product, one unit_price, same id pair', async () => {
    const first = await t.repo.saveParsed({
      rawId,
      spec: fullSpec,
      calc: fullCalc,
    });
    const second = await t.repo.saveParsed({
      rawId,
      spec: fullSpec,
      calc: fullCalc,
    });
    // Idempotent: the second call returns the existing (oldest) pair, inserts
    // nothing — one product, one unit_price (no orphan).
    expect(second).toEqual(first);
    expect(countRows(t.handle, 'product')).toBe(1);
    expect(countRows(t.handle, 'unit_price')).toBe(1);
  });

  it('different specs (same rawId) → two products, not deduped', async () => {
    const specB = ParsedSpecSchema.parse({ ...fullSpec, quantity: 12 });
    const a = await t.repo.saveParsed({ rawId, spec: fullSpec, calc: fullCalc });
    const b = await t.repo.saveParsed({
      rawId,
      spec: specB,
      calc: calculate(specB, 39.9),
    });
    // Distinct dedupe keys → each lands its own product row.
    expect(b.productId).not.toBe(a.productId);
    expect(b.unitPriceId).not.toBe(a.unitPriceId);
    expect(countRows(t.handle, 'product')).toBe(2);
    expect(countRows(t.handle, 'unit_price')).toBe(2);
  });

  it('price/formula change (same spec) → still one product, returns oldest pair', async () => {
    const first = await t.repo.saveParsed({
      rawId,
      spec: fullSpec,
      calc: calculate(fullSpec, 39.9),
    });
    // Same spec, different price → different per100ml/formula, same dedupe key.
    const cheaper = calculate(fullSpec, 19.9);
    expect(cheaper.unitPrice.per100ml).not.toBe(fullCalc.unitPrice.per100ml);
    const second = await t.repo.saveParsed({
      rawId,
      spec: fullSpec,
      calc: cheaper,
    });
    expect(second).toEqual(first);
    expect(countRows(t.handle, 'product')).toBe(1);
    expect(countRows(t.handle, 'unit_price')).toBe(1);
    // The stored unit_price is the FIRST one (oldest wins), not the resubmit.
    const row = t.handle
      .prepare('SELECT per100ml FROM unit_price WHERE product_id = ?')
      .get(first.productId) as { per100ml: number };
    expect(row.per100ml).toBe(fullCalc.unitPrice.per100ml);
  });

  it('confidence change (same spec) → still one product, returns oldest pair', async () => {
    const specLow = ParsedSpecSchema.parse({ ...fullSpec, confidence: 0.3 });
    const specHigh = ParsedSpecSchema.parse({ ...fullSpec, confidence: 0.95 });
    const first = await t.repo.saveParsed({
      rawId,
      spec: specLow,
      calc: calculate(specLow, 39.9),
    });
    const second = await t.repo.saveParsed({
      rawId,
      spec: specHigh,
      calc: calculate(specHigh, 39.9),
    });
    // Parse confidence is excluded from the dedupe key → same product, oldest
    // row kept (its stored confidence is the first one's).
    expect(second).toEqual(first);
    expect(countRows(t.handle, 'product')).toBe(1);
    const row = t.handle
      .prepare('SELECT confidence FROM product WHERE id = ?')
      .get(first.productId) as { confidence: number };
    expect(row.confidence).toBe(0.3);
  });

  it('unique index is the source of truth: a second product with the same dedupe_key is rejected at the DB', () => {
    // Bypass saveParsed and insert two product rows that share a dedupe_key
    // directly — the DB unique index, not the application layer, must reject
    // the second. (Harness sets PRAGMA foreign_keys=ON, matching the
    // atomicity test, so the valid raw_id below satisfies the FK.)
    const insert = t.handle.prepare(
      `INSERT INTO product
         (id, raw_id, unit_size_value, unit_size_unit, quantity, multipliers,
          total_amount_value, total_amount_unit, package_unit, category,
          confidence, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const row = (id: string) =>
      [id, rawId, 1, 'L', 6, '[1]', 6, 'L', '瓶', 'beverage', 0.9, 'dup-key'] as const;
    insert.run(...row('prod-a'));
    expect(() => insert.run(...row('prod-b'))).toThrow(/UNIQUE/i);
    expect(countRows(t.handle, 'product')).toBe(1);
  });
});

describe('saveCorrection', () => {
  let t: TestDb;
  let rawId: string;
  let productId: string;
  beforeEach(async () => {
    t = openTestDb();
    rawId = await t.repo.upsertRaw(rawInput());
    ({ productId } = await t.repo.saveParsed({
      rawId,
      spec: fullSpec,
      calc: fullCalc,
    }));
  });

  it('appends a correction whose corrected_spec round-trips through ParsedSpecSchema', async () => {
    const corrected = ParsedSpecSchema.parse({
      ...fullSpec,
      quantity: 12,
      confidence: 1,
    });
    const id = await t.repo.saveCorrection({
      productId,
      rawId,
      correctedSpec: corrected,
      createdAt: 1_700_000_001_000,
    });
    const row = t.handle
      .prepare(
        'SELECT corrected_spec, parse_source, created_at, product_id, raw_id FROM corrections WHERE id = ?',
      )
      .get(id) as Record<string, unknown>;
    expect(row.parse_source).toBe('manual_corrected');
    expect(row.created_at).toBe(1_700_000_001_000);
    expect(row.product_id).toBe(productId);
    expect(row.raw_id).toBe(rawId);
    const roundTripped = ParsedSpecSchema.parse(
      JSON.parse(row.corrected_spec as string),
    );
    expect(roundTripped).toEqual(corrected);
  });

  it('never mutates the original product_raw/product rows', async () => {
    const rawBefore = t.handle.prepare('SELECT * FROM product_raw').all();
    const productBefore = t.handle.prepare('SELECT * FROM product').all();
    await t.repo.saveCorrection({
      productId,
      rawId,
      correctedSpec: ParsedSpecSchema.parse({ ...fullSpec, quantity: 12 }),
    });
    expect(t.handle.prepare('SELECT * FROM product_raw').all()).toEqual(
      rawBefore,
    );
    expect(t.handle.prepare('SELECT * FROM product').all()).toEqual(
      productBefore,
    );
    expect(countRows(t.handle, 'corrections')).toBe(1);
  });

  it('rejects an inconsistent productId/rawId pair without writing', async () => {
    await expect(
      t.repo.saveCorrection({
        productId: 'no-such-product',
        rawId,
        correctedSpec: fullSpec,
      }),
    ).rejects.toThrow(/does not exist/i);

    const otherRawId = await t.repo.upsertRaw(rawInput({ storeSku: 'sku-2' }));
    await expect(
      t.repo.saveCorrection({
        productId,
        rawId: otherRawId,
        correctedSpec: fullSpec,
      }),
    ).rejects.toThrow(/rawId mismatch/i);
    expect(countRows(t.handle, 'corrections')).toBe(0);
  });

  it('rejects a corrected_spec that fails ParsedSpecSchema without writing', async () => {
    const bad = { ...fullSpec, confidence: 2 } as ParsedSpec;
    await expectZodReject(
      t.repo.saveCorrection({ productId, rawId, correctedSpec: bad }),
      'confidence',
    );
    expect(countRows(t.handle, 'corrections')).toBe(0);
  });
});
