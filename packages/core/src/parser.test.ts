import { describe, expect, it } from 'vitest';
import { calculate } from './calculator.js';
import { parseTier1 } from './parser.js';
import type { RawProduct } from './types.js';
import { ParsedSpecSchema } from './types.js';

function raw(title: string, price = 1, categoryHint?: string): RawProduct {
  return { title, price, ...(categoryHint ? { categoryHint } : {}) };
}

describe('tier1 parser', () => {
  it('parses a clean title (330ml*24听) without needing the LLM', () => {
    const { spec, clean } = parseTier1(raw('可口可乐 330ml*24听', 40));
    expect(spec.unitSize).toEqual({ value: 330, unit: 'ml' });
    expect(spec.quantity).toBe(24);
    expect(spec.packageUnit).toBe('can');
    expect(spec.totalAmount).toEqual({ value: 7920, unit: 'ml' });
    expect(clean).toBe(true);
    // clean full-spec hit gets a high intermediate confidence.
    expect(spec.confidence).toBeGreaterThanOrEqual(0.9);
    // output validates against the schema.
    expect(() => ParsedSpecSchema.parse(spec)).not.toThrow();
  });

  it('normalizes unit aliases (毫升/mL/升/L) and package aliases (罐)', () => {
    expect(parseTier1(raw('雪碧 500毫升*12')).spec.unitSize).toEqual({
      value: 500,
      unit: 'ml',
    });
    expect(parseTier1(raw('果汁 250mL*6')).spec.unitSize).toEqual({
      value: 250,
      unit: 'ml',
    });
    expect(parseTier1(raw('矿泉水 1升')).spec.unitSize).toEqual({ value: 1, unit: 'L' });
    expect(parseTier1(raw('橙汁 1.5L*6')).spec.unitSize).toEqual({ value: 1.5, unit: 'L' });
    expect(parseTier1(raw('啤酒 330ml*6罐')).spec.packageUnit).toBe('can');
  });

  it('does not cross ml<->L at parse time (L stays L, total keeps L)', () => {
    const { spec } = parseTier1(raw('可乐 1L*6', 48));
    expect(spec.unitSize).toEqual({ value: 1, unit: 'L' });
    // derived total keeps the unitSize unit; the ml<->L conversion happens in calc.
    expect(spec.totalAmount).toEqual({ value: 6, unit: 'L' });
  });

  it('passes categoryHint through, defaults to beverage, never from LLM', () => {
    expect(parseTier1(raw('某饮料 330ml')).spec.category).toBe('beverage');
    expect(parseTier1(raw('某饮料 330ml', 1, 'snack')).spec.category).toBe('snack');
  });

  it('recognizes weight aliases (斤=>g, 公斤/千克=>kg) with correct ordering', () => {
    expect(parseTier1(raw('某物 2斤')).spec.unitSize).toEqual({ value: 1000, unit: 'g' });
    expect(parseTier1(raw('大米 5公斤')).spec.unitSize).toEqual({ value: 5, unit: 'kg' });
    expect(parseTier1(raw('大米 5千克')).spec.unitSize).toEqual({ value: 5, unit: 'kg' });
  });

  it('ignores a Latin x glued to the product name before the size (X20)', () => {
    const { spec } = parseTier1(raw('可口可乐X20 330ml*6听', 40));
    expect(spec.quantity).toBe(6);
    expect(spec.unitSize).toEqual({ value: 330, unit: 'ml' });
    expect(spec.totalAmount).toEqual({ value: 1980, unit: 'ml' });
  });

  it('still parses the trailing multiplier when no leading x interferes', () => {
    const { spec } = parseTier1(raw('可口可乐 330ml*24听', 40));
    expect(spec.quantity).toBe(24);
  });

  it('infers quantity=1 when only a volume size is present (single-unit inference)', () => {
    // No quantity signal at all -> treated as a single unit (§2), with an
    // informational provenance warning. This is the post-change behavior; the
    // old "leave quantity null" path only survives when a quantity signal is
    // present but unparsed.
    const { spec, clean, warnings } = parseTier1(raw('单瓶可乐 330ml'));
    expect(spec.unitSize).toEqual({ value: 330, unit: 'ml' });
    expect(spec.quantity).toBe(1);
    expect(spec.totalAmount).toEqual({ value: 330, unit: 'ml' });
    expect(warnings).toContain('数量按单件推断为 1');
    expect(clean).toBe(true);
  });

  it('does not misread a <number><package-word> in the product name as quantity (PKG_COUNT_RE fallback is size-anchored)', () => {
    // No `*`/`×`/`x` multiplier -> goes through the PKG_COUNT_RE fallback.
    // "500瓶" precedes the size span, so it must not be picked up.
    const { spec } = parseTier1(raw('500瓶装礼盒 330ml', 40));
    expect(spec.quantity).not.toBe(500);
    expect(spec.unitSize).toEqual({ value: 330, unit: 'ml' });
  });

  it('still parses a standalone package count when no size is present (fallback searches whole title)', () => {
    const { spec } = parseTier1(raw('可乐 24听', 40));
    expect(spec.quantity).toBe(24);
    expect(spec.packageUnit).toBe('can');
  });

  it('defaults to beverage when categoryHint is an empty string', () => {
    const { spec } = parseTier1({ title: '某饮料 330ml', price: 1, categoryHint: '' });
    expect(spec.category).toBe('beverage');
  });

  // §2 单件推断 (single-unit inference)

  it('infers quantity=1 for an isolated large volume (4L), keeping the L unit', () => {
    const { spec, clean, warnings } = parseTier1(raw('MM 弱碱性饮用水 4L', 9.9));
    expect(spec.unitSize).toEqual({ value: 4, unit: 'L' });
    expect(spec.quantity).toBe(1);
    // totalAmount keeps the unitSize unit (no L->ml at parse time).
    expect(spec.totalAmount).toEqual({ value: 4, unit: 'L' });
    expect(warnings).toContain('数量按单件推断为 1');
    // full-spec set (size+qty+total) -> clean / high intermediate confidence.
    expect(clean).toBe(true);
    expect(spec.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('infers quantity=1 for a fractional 升 size (4.104升)', () => {
    const { spec, warnings } = parseTier1(raw('星巴克能量饮料 4.104升'));
    expect(spec.unitSize).toEqual({ value: 4.104, unit: 'L' });
    expect(spec.quantity).toBe(1);
    expect(spec.totalAmount).toEqual({ value: 4.104, unit: 'L' });
    expect(warnings).toContain('数量按单件推断为 1');
  });

  it('does not override an explicit quantity with the single-unit inference (330ml*24听)', () => {
    const { spec, warnings } = parseTier1(raw('可口可乐 330ml*24听', 40));
    expect(spec.quantity).toBe(24);
    expect(spec.totalAmount).toEqual({ value: 7920, unit: 'ml' });
    expect(warnings).not.toContain('数量按单件推断为 1');
  });

  it('does not infer quantity=1 when only a package count and no size are present (15瓶)', () => {
    const { spec, warnings } = parseTier1(raw('MM 现泡铂金黑咖啡 15瓶'));
    expect(spec.unitSize).toBeNull();
    // package count without a size still resolves as a count, but is never
    // coerced to 1 by the single-unit inference.
    expect(spec.quantity).toBe(15);
    expect(warnings).not.toContain('数量按单件推断为 1');
  });

  it('does not infer single unit when a free digit count precedes the size (整箱24听 可乐 330ml)', () => {
    const { spec, clean, warnings } = parseTier1(raw('整箱24听 可乐 330ml'));
    expect(spec.unitSize).toEqual({ value: 330, unit: 'ml' });
    // `24听` is a quantity signal but not glued to the size -> not parsed,
    // and NOT coerced to 1. Falls through as a partial hit (tier2's job).
    expect(spec.quantity).toBeNull();
    expect(clean).toBe(false);
    expect(warnings).not.toContain('数量按单件推断为 1');
  });

  it('does not infer single unit when a multiplier yields quantity<=0 (330ml*0)', () => {
    const { spec, warnings } = parseTier1(raw('农夫山泉 330ml*0'));
    expect(spec.unitSize).toEqual({ value: 330, unit: 'ml' });
    // the `*` multiplier is itself a signal; quantity stays 0 (downstream
    // zero-total terminal -> per100ml=null), never inferred to 1.
    expect(spec.quantity).toBe(0);
    expect(warnings).not.toContain('数量按单件推断为 1');
  });

  // §3 count-before-size

  it('extracts a count glued before the size (24x500mL)', () => {
    const { spec } = parseTier1(raw('阿尔卑斯山气泡水 FONTE LINDA 24x500mL', 42.8));
    expect(spec.unitSize).toEqual({ value: 500, unit: 'ml' });
    expect(spec.quantity).toBe(24);
    expect(spec.totalAmount).toEqual({ value: 12000, unit: 'ml' });
  });

  it('extracts a count glued before the size with the × symbol (24×500mL)', () => {
    const { spec } = parseTier1(raw('阿尔卑斯山气泡水 24×500mL', 42.8));
    expect(spec.unitSize).toEqual({ value: 500, unit: 'ml' });
    expect(spec.quantity).toBe(24);
    expect(spec.totalAmount).toEqual({ value: 12000, unit: 'ml' });
  });

  it('still ignores a product-name X20 and takes the trailing *6 (可口可乐X20 330ml*6听)', () => {
    const { spec } = parseTier1(raw('可口可乐X20 330ml*6听', 40));
    expect(spec.quantity).toBe(6);
    expect(spec.unitSize).toEqual({ value: 330, unit: 'ml' });
  });

  it('does not regress trailing-multiplier extraction (330ml*24听)', () => {
    const { spec } = parseTier1(raw('可口可乐 330ml*24听', 40));
    expect(spec.quantity).toBe(24);
  });

  it('prefers the trailing multiplier when both sides have one (24x500mL*6)', () => {
    const { spec } = parseTier1(raw('24x500mL*6', 30));
    expect(spec.unitSize).toEqual({ value: 500, unit: 'ml' });
    // trailing *6 wins; the leading 24 is not multiplied/stacked (NOT 144).
    expect(spec.quantity).toBe(6);
    expect(spec.totalAmount).toEqual({ value: 3000, unit: 'ml' });
  });

  // §total-restatement rebind (前导总量 + 单件×数量, self-consistency gate)

  it('rebinds a self-consistent restated total to the per-unit size (多维刺梨柠檬饮 2.1L(100mL×21))', () => {
    // 100mL×21=2100ml ≈ leading 2.1L=2100ml (0% error) -> rebind to 100ml/21.
    // MUST NOT keep 2.1L as unitSize and multiply by 21 (=44.1L -> per100ml≈0.159).
    const { spec } = parseTier1(raw('多维刺梨柠檬饮 2.1L(100mL×21)', 69.9));
    expect(spec.unitSize).toEqual({ value: 100, unit: 'ml' });
    expect(spec.quantity).toBe(21);
    expect(spec.totalAmount).toEqual({ value: 2100, unit: 'ml' });
    // calculator round-trip: 69.9 / 2100 * 100 ≈ 3.33 (NOT 0.159).
    const { unitPrice } = calculate(spec, 69.9);
    expect(unitPrice.per100ml).toBeCloseTo(3.33, 2);
  });

  it('rebinds when the rounding label is within tolerance (2L装可乐 330ml*6)', () => {
    // leading 2L=2000ml vs 330ml×6=1980ml -> 1% error ≤ 10% -> rebind.
    // The 2L装 product-name token is NOT taken as unitSize (would be 12L).
    const { spec } = parseTier1(raw('2L装可乐 330ml*6', 12));
    expect(spec.unitSize).toEqual({ value: 330, unit: 'ml' });
    expect(spec.quantity).toBe(6);
    expect(spec.totalAmount).toEqual({ value: 1980, unit: 'ml' });
  });

  it('does NOT rebind an inconsistent product-name size token (550mL便携装 1.5L*6)', () => {
    // leading 550ml vs 1.5L×6=9000ml -> severe mismatch -> keep existing binding.
    // 550mL is the real unit; 1.5L is marketing noise and must NOT become unitSize.
    const { spec } = parseTier1(raw('550mL便携装 1.5L*6', 30));
    expect(spec.unitSize).toEqual({ value: 550, unit: 'ml' });
    expect(spec.quantity).toBe(6);
  });

  it('does NOT rebind a non-volume (weight) restatement (某蛋白粉 2kg(100g×20))', () => {
    // toMl returns null for weight -> gate (a) fails -> no rebind; per100ml=null.
    const { spec } = parseTier1(raw('某蛋白粉 2kg(100g×20)', 199));
    expect(spec.unitSize).toEqual({ value: 2, unit: 'kg' });
    const { unitPrice } = calculate(spec, 199);
    expect(unitPrice.per100ml).toBeNull();
  });

  it('does NOT rebind when the leading size is weight even if the unit is volume (2kg礼盒 330ml*6)', () => {
    // leading 2kg is non-volume -> gate (a) fails -> keep unitSize=2kg/quantity=6.
    // Conservative: terminal per100ml=null (known non-goal, weight uncomputable).
    const { spec } = parseTier1(raw('2kg礼盒 330ml*6', 88));
    expect(spec.unitSize).toEqual({ value: 2, unit: 'kg' });
    expect(spec.quantity).toBe(6);
    const { unitPrice } = calculate(spec, 88);
    expect(unitPrice.per100ml).toBeNull();
  });

  it('does NOT rebind and emits no NaN/Infinity when the leading total is zero (0L(100mL×21))', () => {
    // This black-box test verifies the GATE DECISION (no rebind on a zero
    // leading total) + output finiteness, NOT guard (b) in isolation: removing
    // `leadingMl > 0` would yield `Infinity <= 0.1 === false`, i.e. the gate
    // still fails and the assertions below are identical. "No transient
    // division" is a short-circuit-ORDER property (guard (b) precedes the
    // ratio), guaranteed by code review — not distinguishable here.
    // Gate fails -> NO rebind: unitSize stays the first size (0L), quantity the
    // QTY_RE value (21) — NOT rebound to 100ml/21.
    const { spec } = parseTier1(raw('0L(100mL×21)', 10));
    expect(spec.unitSize).toEqual({ value: 0, unit: 'L' });
    expect(spec.quantity).toBe(21);
    // per100ml must be null or finite — never NaN/Infinity.
    const { unitPrice } = calculate(spec, 10);
    if (unitPrice.per100ml !== null) {
      expect(Number.isFinite(unitPrice.per100ml)).toBe(true);
    }
  });

  it('ignores a middle size in a 3-size window, binding the rightmost (2.1L 礼盒1L 100mL×21)', () => {
    // leading=first 2.1L, per-unit=rightmost 100mL, middle 1L ignored.
    // 100×21=2100 ≈ 2100 -> self-consistent -> rebind.
    const { spec } = parseTier1(raw('2.1L 礼盒1L 100mL×21', 69.9));
    expect(spec.unitSize).toEqual({ value: 100, unit: 'ml' });
    expect(spec.quantity).toBe(21);
    expect(spec.totalAmount).toEqual({ value: 2100, unit: 'ml' });
  });

  it('does not enter the rebind for a single size multiplier (可口可乐 300mL*24)', () => {
    const { spec } = parseTier1(raw('可口可乐 300mL*24', 50));
    expect(spec.unitSize).toEqual({ value: 300, unit: 'ml' });
    expect(spec.quantity).toBe(24);
    expect(spec.totalAmount).toEqual({ value: 7200, unit: 'ml' });
  });
});
