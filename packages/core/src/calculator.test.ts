import { describe, expect, it } from 'vitest';
import { calculate } from './calculator.js';
import type { ParsedSpec } from './types.js';

function spec(partial: Partial<ParsedSpec>): ParsedSpec {
  return {
    unitSize: null,
    quantity: null,
    multipliers: [1],
    totalAmount: null,
    packageUnit: null,
    category: 'beverage',
    confidence: 0.5,
    ...partial,
  };
}

describe('tier3 calculator — ml expanded form', () => {
  it('computes per100ml ~= 0.505 with expanded ml formula', () => {
    const r = calculate(
      spec({
        unitSize: { value: 330, unit: 'ml' },
        quantity: 24,
        totalAmount: { value: 7920, unit: 'ml' },
      }),
      40,
    );
    expect(r.unitPrice.per100ml).toBeCloseTo(0.505, 3);
    expect(r.unitPrice.formula).toBe('40 / (330 * 24 * 1) * 100');
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
    expect(r.warnings).toEqual([]);
  });
});

describe('tier3 calculator — L conversion in formula', () => {
  it('converts 1L to 1000ml before rendering the expanded formula', () => {
    const r = calculate(
      spec({
        unitSize: { value: 1, unit: 'L' },
        quantity: 6,
        totalAmount: { value: 6000, unit: 'ml' },
      }),
      48,
    );
    expect(r.unitPrice.formula).toBe('48 / (1000 * 6 * 1) * 100');
    expect(r.unitPrice.formula).not.toContain('(1 *');
    expect(r.unitPrice.per100ml).toBeCloseTo(0.8, 6);
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
  });
});

describe('tier3 calculator — uncomputable terminal states', () => {
  it('weight unit (kg) computes per100g on the weight axis, per100ml stays null', () => {
    const r = calculate(spec({ totalAmount: { value: 2, unit: 'kg' } }), 10);
    expect(r.unitPrice.per100ml).toBeNull();
    expect(r.unitPrice.per100g).toBeCloseTo(0.5, 6);
    expect(r.unitPrice.formula).toBe('10 / 2000 * 100');
  });

  it('weight unitSize (g) without volume total computes per100g on the weight axis', () => {
    const r = calculate(spec({ unitSize: { value: 500, unit: 'g' }, quantity: 2 }), 10);
    expect(r.unitPrice.per100ml).toBeNull();
    expect(r.unitPrice.per100g).toBeCloseTo(1, 6);
  });

  it('null total is uncomputable, no NaN/Infinity', () => {
    const r = calculate(spec({ totalAmount: null }), 10);
    expect(r.unitPrice.per100ml).toBeNull();
    expect(r.unitPrice.formula).toBeNull();
    expect(r.confidence).toBeLessThanOrEqual(0.5);
  });

  it('zero total is uncomputable, no division by zero', () => {
    const r = calculate(spec({ totalAmount: { value: 0, unit: 'ml' } }), 10);
    expect(r.unitPrice.per100ml).toBeNull();
    expect(Number.isFinite(r.unitPrice.per100ml ?? 0)).toBe(true);
    expect(r.confidence).toBeLessThanOrEqual(0.5);
  });

  it('price <= 0 is uncomputable', () => {
    const zero = calculate(spec({ totalAmount: { value: 6000, unit: 'ml' } }), 0);
    expect(zero.unitPrice.per100ml).toBeNull();
    expect(zero.confidence).toBeLessThanOrEqual(0.5);
    const neg = calculate(spec({ totalAmount: { value: 6000, unit: 'ml' } }), -5);
    expect(neg.unitPrice.per100ml).toBeNull();
    expect(neg.confidence).toBeLessThanOrEqual(0.5);
  });
});

describe('tier3 calculator — consistency gate', () => {
  it('passes within tolerance and produces no warning', () => {
    const r = calculate(
      spec({
        unitSize: { value: 330, unit: 'ml' },
        quantity: 24,
        totalAmount: { value: 7920, unit: 'ml' },
      }),
      40,
    );
    expect(r.warnings).toEqual([]);
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('suppresses unit price when inconsistent (330ml*24 vs 3960ml total)', () => {
    const r = calculate(
      spec({
        unitSize: { value: 330, unit: 'ml' },
        quantity: 24,
        totalAmount: { value: 3960, unit: 'ml' },
      }),
      40,
    );
    expect(r.unitPrice.per100ml).toBeNull();
    expect(r.unitPrice.formula).toBeNull();
    expect(r.confidence).toBeLessThanOrEqual(0.5);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('decimal volume floating-point tolerance (1.25L*6 == 7500ml)', () => {
    const r = calculate(
      spec({
        unitSize: { value: 1.25, unit: 'L' },
        quantity: 6,
        totalAmount: { value: 7500, unit: 'ml' },
      }),
      30,
    );
    expect(r.unitPrice.per100ml).not.toBeNull();
    expect(r.unitPrice.formula).toBe('30 / (1250 * 6 * 1) * 100');
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
    expect(r.warnings).toEqual([]);
  });
});

describe('tier3 calculator — weight axis consistency gate', () => {
  // 4.9 重量满规格自洽品上高档(pin consistency.ts 重量分支):300g*24 == 7200g
  it('rates a self-consistent weight full-spec product high (300g*24 == 7200g)', () => {
    const r = calculate(
      spec({
        unitSize: { value: 300, unit: 'g' },
        quantity: 24,
        totalAmount: { value: 7200, unit: 'g' },
      }),
      60,
    );
    // 与容量满规格同档:consistent + 高置信(防被错降为 skipped/中档)。
    expect(r.unitPrice.per100g).toBeCloseTo(0.8333, 4);
    expect(r.unitPrice.per100ml).toBeNull();
    expect(r.unitPrice.formula).toBe('60 / (300 * 24 * 1) * 100');
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
    expect(r.warnings).toEqual([]);
  });

  // 4.10 重量不一致抑制单价:300g*24 (=7200g) vs 声明 3600g -> 不自洽
  it('suppresses the unit price when the weight spec is inconsistent (300g*24 vs 3600g)', () => {
    const r = calculate(
      spec({
        unitSize: { value: 300, unit: 'g' },
        quantity: 24,
        totalAmount: { value: 3600, unit: 'g' },
      }),
      60,
    );
    expect(r.unitPrice.per100g).toBeNull();
    expect(r.unitPrice.per100ml).toBeNull();
    expect(r.unitPrice.formula).toBeNull();
    expect(r.confidence).toBeLessThanOrEqual(0.5);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});

describe('tier3 calculator — missing-field third state', () => {
  it('uses contracted formula and a non-high (mid) confidence', () => {
    const r = calculate(spec({ totalAmount: { value: 6000, unit: 'ml' } }), 36);
    expect(r.unitPrice.formula).toBe('36 / 6000 * 100');
    expect(r.unitPrice.per100ml).toBeCloseTo(0.6, 6);
    expect(r.confidence).toBeGreaterThan(0.5);
    expect(r.confidence).toBeLessThan(0.9);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});
