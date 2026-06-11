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

  // §含量描述符 token 不计入「数字数量信号」(酒精度/百分比含量不抑制单件推断)

  it('infers quantity=1 for a 度 single bottle, computing per100ml (汾酒 53度 500mL)', () => {
    // `53度` 是酒精度、唯一游离数字;剥离后无数量信号 -> 单件推断。
    const { spec, warnings } = parseTier1(raw('汾酒沪上青花 清香型白酒 53度 500mL', 30));
    expect(spec.unitSize).toEqual({ value: 500, unit: 'ml' });
    expect(spec.quantity).toBe(1);
    expect(spec.totalAmount).toEqual({ value: 500, unit: 'ml' });
    expect(warnings).toContain('数量按单件推断为 1');
    // calculator: 30 / 500 * 100 = 6
    const { unitPrice } = calculate(spec, 30);
    expect(unitPrice.per100ml).toBe(6);
  });

  it('infers quantity=1 for a %vol single bottle, never null (汾酒 55%vol 950ml)', () => {
    const { spec } = parseTier1(raw('汾酒 55%vol清香型白酒 950ml', 95));
    expect(spec.unitSize).toEqual({ value: 950, unit: 'ml' });
    expect(spec.quantity).toBe(1);
    expect(spec.totalAmount).toEqual({ value: 950, unit: 'ml' });
    // calculator: 95 / 950 * 100 = 10 (MUST NOT be null)
    const { unitPrice } = calculate(spec, 95);
    expect(unitPrice.per100ml).toBe(10);
  });

  it('infers quantity=1 for a percentage-content single bottle (NFC 100%果汁 300ml)', () => {
    const { spec } = parseTier1(raw('NFC 100%果汁 300ml', 9));
    expect(spec.unitSize).toEqual({ value: 300, unit: 'ml' });
    expect(spec.quantity).toBe(1);
    expect(spec.totalAmount).toEqual({ value: 300, unit: 'ml' });
    const { unitPrice } = calculate(spec, 9);
    expect(unitPrice.per100ml).not.toBeNull();
  });

  it('infers quantity=1 for the ° alcohol-degree notation (白酒 52° 500ml)', () => {
    const { spec, warnings } = parseTier1(raw('白酒 52° 500ml', 40));
    expect(spec.unitSize).toEqual({ value: 500, unit: 'ml' });
    expect(spec.quantity).toBe(1);
    expect(spec.totalAmount).toEqual({ value: 500, unit: 'ml' });
    expect(warnings).toContain('数量按单件推断为 1');
  });

  it('content digits do not interfere with a real trailing count (白酒 53度 500ml*6瓶)', () => {
    // `*6` 经 QTY_RE 抽取 -> quantity≠null -> 根本不进单件推断;`53度` 不干扰。
    const { spec, warnings } = parseTier1(raw('白酒 53度 500ml*6瓶', 180));
    expect(spec.unitSize).toEqual({ value: 500, unit: 'ml' });
    expect(spec.quantity).toBe(6);
    expect(spec.totalAmount).toEqual({ value: 3000, unit: 'ml' });
    expect(warnings).not.toContain('数量按单件推断为 1');
  });

  it('does not infer single unit when a leading package count precedes the size (白酒 53度 6瓶 500ml)', () => {
    // 前置 `6瓶` 不被 PKG_COUNT_RE(只扫 size 之后)抽取;进单件推断时剥度数后
    // `6瓶` 仍命中信号 -> 不推单件,quantity 保持 null(既有前置限制,本变更不修)。
    const { spec, warnings } = parseTier1(raw('白酒 53度 6瓶 500ml', 180));
    expect(spec.unitSize).toEqual({ value: 500, unit: 'ml' });
    expect(spec.quantity).toBeNull();
    expect(warnings).not.toContain('数量按单件推断为 1');
    const { unitPrice } = calculate(spec, 180);
    expect(unitPrice.per100ml).toBeNull();
  });

  it('keeps a bare product-name number conservative -> null (埃德华兹900 750mL)', () => {
    // `900` 无含量后缀、不被剥 -> 仍作游离数字信号 -> 不推单件、留 null(已知残留)。
    const { spec, warnings } = parseTier1(
      raw('LFE 进口埃德华兹900单一葡萄园干红葡萄酒 750mL', 200),
    );
    expect(spec.unitSize).toEqual({ value: 750, unit: 'ml' });
    expect(spec.quantity).toBeNull();
    expect(warnings).not.toContain('数量按单件推断为 1');
    const { unitPrice } = calculate(spec, 200);
    expect(unitPrice.per100ml).toBeNull();
  });

  it('regression: existing single-unit / count paths unchanged after content-token strip', () => {
    // 单件大规格(无数字)
    expect(parseTier1(raw('MM 弱碱性饮用水 4L', 9.9)).spec.quantity).toBe(1);
    // 乘号
    expect(parseTier1(raw('可乐 330ml*24听', 40)).spec.quantity).toBe(24);
    // 前置乘号
    expect(parseTier1(raw('24x500mL', 42.8)).spec.quantity).toBe(24);
    // 游离 `24听` 未紧贴 size -> 不推单件
    expect(parseTier1(raw('整箱24听 可乐 330ml')).spec.quantity).toBeNull();
    // 品名噪声 X20 + 后置 *6
    expect(parseTier1(raw('可口可乐X20 330ml*6听', 40)).spec.quantity).toBe(6);
    // 乘号在场但数量 0 -> 不推单件
    const zero = parseTier1(raw('农夫山泉 330ml*0'));
    expect(zero.spec.quantity).toBe(0);
    expect(zero.warnings).not.toContain('数量按单件推断为 1');
    // 总量复述
    expect(parseTier1(raw('多维刺梨柠檬饮 2.1L(100mL×21)', 69.9)).spec.quantity).toBe(21);
  });
});

// 重量轴:tier1 解析 -> tier3 计算端到端 (per100g, per100ml=null)
describe('weight axis — parse + compute', () => {
  // 4.1 单件重量品(kg 单件、无数量信号 -> 单件推断 quantity=1)
  it('infers a single 2kg unit and computes per100g=2.25 (水蜜黄桃2kg)', () => {
    const { spec, warnings } = parseTier1(raw('水蜜黄桃2kg', 45));
    expect(spec.unitSize).toEqual({ value: 2, unit: 'kg' });
    expect(spec.quantity).toBe(1);
    expect(spec.totalAmount).toEqual({ value: 2, unit: 'kg' });
    expect(warnings).toContain('数量按单件推断为 1');
    const { unitPrice } = calculate(spec, 45);
    // 45 / 2000g * 100 = 2.25
    expect(unitPrice.per100g).toBeCloseTo(2.25, 6);
    expect(unitPrice.per100ml).toBeNull();
  });

  // 4.2 多包装重量品(乘号抽取 -> quantity=24,不进单件推断)
  it('extracts 300g*24 -> quantity=24, total 7200g, per100g≈0.833 (MM 有机玉米汁)', () => {
    const { spec, warnings } = parseTier1(raw('MM 有机玉米汁 300g*24', 60));
    expect(spec.unitSize).toEqual({ value: 300, unit: 'g' });
    expect(spec.quantity).toBe(24);
    expect(spec.totalAmount).toEqual({ value: 7200, unit: 'g' });
    // 乘号是数量信号 -> 不触发单件推断
    expect(warnings).not.toContain('数量按单件推断为 1');
    const { unitPrice } = calculate(spec, 60);
    // 60 / 7200g * 100 ≈ 0.8333
    expect(unitPrice.per100g).toBeCloseTo(0.8333, 4);
    expect(unitPrice.per100ml).toBeNull();
  });

  // 4.3 `g×N` 写法 (`x` 形式的乘号)
  it('extracts the gxN multiplier (270gx15 -> quantity=15, total 4050g)', () => {
    const { spec } = parseTier1(raw('樱桃番茄NFC复合果蔬汁 270gx15', 81));
    expect(spec.unitSize).toEqual({ value: 270, unit: 'g' });
    expect(spec.quantity).toBe(15);
    expect(spec.totalAmount).toEqual({ value: 4050, unit: 'g' });
    const { unitPrice } = calculate(spec, 81);
    // 81 / 4050g * 100 = 2 (非 null)
    expect(unitPrice.per100g).not.toBeNull();
    expect(unitPrice.per100g).toBeCloseTo(2, 6);
    expect(unitPrice.per100ml).toBeNull();
  });

  // 4.4 干净 kg 单件、无游离件数 -> 单件推断
  it('infers a single 2.5kg unit and computes per100g=2 (妃子笑荔枝 2.5kg)', () => {
    const { spec, warnings } = parseTier1(raw('妃子笑荔枝 2.5kg', 50));
    expect(spec.unitSize).toEqual({ value: 2.5, unit: 'kg' });
    expect(spec.quantity).toBe(1);
    expect(spec.totalAmount).toEqual({ value: 2.5, unit: 'kg' });
    expect(warnings).toContain('数量按单件推断为 1');
    const { unitPrice } = calculate(spec, 50);
    // 50 / 2500g * 100 = 2
    expect(unitPrice.per100g).toBeCloseTo(2, 6);
    expect(unitPrice.per100ml).toBeNull();
  });

  // 4.5 formula 留痕:g 基准,展开式 + kg->g 换算后的数值(禁止用未换算字面 2/2.5)
  it('renders weight formulas in g base (expanded 7200g, kg converted to g)', () => {
    // 多包装展开式:60 / (300 * 24 * 1) * 100
    const multi = parseTier1(raw('MM 有机玉米汁 300g*24', 60)).spec;
    expect(calculate(multi, 60).unitPrice.formula).toBe('60 / (300 * 24 * 1) * 100');

    // 单件 kg 收缩展开:2kg -> 2000g,禁止出现未换算的字面 2(否则 (2 * ...))
    const single = parseTier1(raw('水蜜黄桃2kg', 45)).spec;
    const f = calculate(single, 45).unitPrice.formula;
    expect(f).toBe('45 / (2000 * 1 * 1) * 100');
    expect(f).not.toContain('(2 *');
  });

  // 4.6 轴互斥不变量:重量品 per100ml===null、容量品 per100g===null,恰一非空
  it('keeps the per100ml/per100g axes mutually exclusive (exactly one non-null)', () => {
    const weight = calculate(parseTier1(raw('水蜜黄桃2kg', 45)).spec, 45).unitPrice;
    expect(weight.per100ml).toBeNull();
    expect(weight.per100g).not.toBeNull();

    const volume = calculate(parseTier1(raw('可口可乐 330ml*24听', 40)).spec, 40).unitPrice;
    expect(volume.per100g).toBeNull();
    expect(volume.per100ml).not.toBeNull();

    // 恰一非空:对两类商品分别断言互斥
    for (const up of [weight, volume]) {
      expect((up.per100ml === null) !== (up.per100g === null)).toBe(true);
    }
  });

  // 4.8 不可算残留:无 size / 裸编号 / 游离件数(枚) -> 两轴 null;价≤0 走终态
  it('leaves uncomputable weight/volume titles at the both-null terminal state', () => {
    // 无 size(只有包装件数,无单位规格)
    const noSize = parseTier1(raw('MM 现泡铂金黑咖啡 15瓶'));
    const noSizeUp = calculate(noSize.spec, 1).unitPrice;
    expect(noSizeUp.per100ml).toBeNull();
    expect(noSizeUp.per100g).toBeNull();

    // 裸编号(品名数字 900 是游离数字 -> 抑制单件推断 -> 残留 null)
    const bareNum = parseTier1(raw('LFE 进口埃德华兹900单一葡萄园干红葡萄酒 750mL', 200));
    expect(bareNum.spec.quantity).toBeNull();
    const bareUp = calculate(bareNum.spec, 200).unitPrice;
    expect(bareUp.per100ml).toBeNull();
    expect(bareUp.per100g).toBeNull();

    // 件数游离数字:`枚` 不在包装单位集,`30` 作游离数字抑制单件推断 -> 两轴 null
    const egg = parseTier1(raw('MM 精选鲜鸡蛋 1.59kg(30枚)', 30));
    expect(egg.spec.unitSize).toEqual({ value: 1.59, unit: 'kg' });
    expect(egg.spec.quantity).toBeNull();
    expect(egg.warnings).not.toContain('数量按单件推断为 1');
    const eggUp = calculate(egg.spec, 30).unitPrice;
    expect(eggUp.per100ml).toBeNull();
    expect(eggUp.per100g).toBeNull();

    // 价≤0 走终态(对可算重量品也一样)
    const badPrice = calculate(parseTier1(raw('水蜜黄桃2kg')).spec, 0);
    expect(badPrice.unitPrice.per100g).toBeNull();
    expect(badPrice.unitPrice.per100ml).toBeNull();
    expect(badPrice.confidence).toBeLessThanOrEqual(0.5);
  });
});

// 4.7 容量回归(零误伤):重量轴改动不波及既有 ml 路径
describe('volume axis — no regression from the weight axis', () => {
  it('矿泉水 4L -> per100ml unchanged, per100g null', () => {
    const up = calculate(parseTier1(raw('矿泉水 4L', 8)).spec, 8).unitPrice;
    // 8 / 4000ml * 100 = 0.2
    expect(up.per100ml).toBeCloseTo(0.2, 6);
    expect(up.per100g).toBeNull();
    expect(up.formula).toBe('8 / (4000 * 1 * 1) * 100');
  });

  it('啤酒 500ml*12 -> per100ml unchanged, per100g null', () => {
    const up = calculate(parseTier1(raw('啤酒 500ml*12', 36)).spec, 36).unitPrice;
    // 36 / 6000ml * 100 = 0.6
    expect(up.per100ml).toBeCloseTo(0.6, 6);
    expect(up.per100g).toBeNull();
    expect(up.formula).toBe('36 / (500 * 12 * 1) * 100');
  });

  it('葡萄酒 750mL single bottle -> per100ml unchanged, per100g null', () => {
    const up = calculate(parseTier1(raw('葡萄酒 750mL', 75)).spec, 75).unitPrice;
    // 单件推断 -> 75 / 750ml * 100 = 10
    expect(up.per100ml).toBeCloseTo(10, 6);
    expect(up.per100g).toBeNull();
  });

  it('330ml*24听 -> per100ml unchanged, per100g null, ml formula unchanged', () => {
    const up = calculate(parseTier1(raw('可口可乐 330ml*24听', 40)).spec, 40).unitPrice;
    expect(up.per100ml).toBeCloseTo(0.505, 3);
    expect(up.per100g).toBeNull();
    expect(up.formula).toBe('40 / (330 * 24 * 1) * 100');
  });
});
