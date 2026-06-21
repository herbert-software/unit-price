import { describe, it, expect } from 'vitest';
import type { CategoryTreeNode, ComputeResult } from '@unit-price/api-client';
import {
  toCohorts,
  unitsForAxis,
  isUnitOnAxis,
  axisCaption,
  buildComputeRequest,
  deriveResultView,
  type Cohort,
  type ComputeFormInput,
} from './form';

// — fixtures —
const cat = (
  slug: string,
  over: Partial<CategoryTreeNode> = {},
): CategoryTreeNode => ({
  slug,
  name: slug,
  parentSlug: 'beverage',
  comparableUnit: 'per_100ml',
  rankable: true,
  rankableCount: 5,
  ...over,
});

const cohort = (over: Partial<Cohort> = {}): Cohort => ({
  slug: 'soft-drink',
  name: '软饮',
  axis: 'per_100ml',
  ...over,
});

const input = (over: Partial<ComputeFormInput> = {}): ComputeFormInput => ({
  totalPrice: '12',
  quantity: '24',
  mode: 'unit',
  amount: '330',
  unit: 'ml',
  cohort: cohort(),
  ...over,
});

describe('toCohorts — derive selectable leaf cohorts from /categories (no hardcode)', () => {
  it('keeps only rankable nodes with rankableCount>0, preserving server order', () => {
    const cs = toCohorts([
      cat('beverage', { rankable: false, comparableUnit: null, rankableCount: 9, parentSlug: null }),
      cat('soft-drink', { name: '软饮' }),
      cat('alcohol', { rankable: false, comparableUnit: null, rankableCount: 3 }), // parent: NOT clickable
      cat('beer', { name: '啤酒', parentSlug: 'alcohol' }),
    ]);
    expect(cs).toEqual([
      { slug: 'soft-drink', name: '软饮', axis: 'per_100ml' },
      { slug: 'beer', name: '啤酒', axis: 'per_100ml' },
    ]);
  });

  it('drops a rankable node with zero rankable members (no board to position into)', () => {
    expect(toCohorts([cat('empty-cohort', { rankableCount: 0 })])).toEqual([]);
  });

  it('skips a per_100g cohort this period (server 400s 重量轴 until backfill; UI must not offer it)', () => {
    const cs = toCohorts([cat('snacks', { name: '零食', comparableUnit: 'per_100g' })]);
    expect(cs).toEqual([]);
  });

  it('skips a rankable node whose resolved unit is null/unsupported (guards, no guess)', () => {
    expect(toCohorts([cat('weird', { comparableUnit: null })])).toEqual([]);
  });

  it('empty input → empty', () => {
    expect(toCohorts([])).toEqual([]);
  });
});

describe('unit ↔ cohort axis constraint (same口径 as the server cross-axis 400 guard)', () => {
  it('per_100ml → ml/L; per_100g → g/kg', () => {
    expect(unitsForAxis('per_100ml')).toEqual(['ml', 'L']);
    expect(unitsForAxis('per_100g')).toEqual(['g', 'kg']);
  });

  it('isUnitOnAxis accepts on-axis, rejects off-axis', () => {
    expect(isUnitOnAxis('ml', 'per_100ml')).toBe(true);
    expect(isUnitOnAxis('L', 'per_100ml')).toBe(true);
    expect(isUnitOnAxis('g', 'per_100ml')).toBe(false);
    expect(isUnitOnAxis('kg', 'per_100ml')).toBe(false);
    expect(isUnitOnAxis('g', 'per_100g')).toBe(true);
    expect(isUnitOnAxis('ml', 'per_100g')).toBe(false);
  });

  it('axisCaption names the比价口径 per axis', () => {
    expect(axisCaption('per_100ml')).toContain('100ml');
    expect(axisCaption('per_100g')).toContain('100g');
  });
});

describe('buildComputeRequest — light validation + ComputeRequest assembly (no request on ok:false)', () => {
  it('mode unit: assembles unitSize + quantity, omits totalAmount', () => {
    const r = buildComputeRequest(input({ mode: 'unit', quantity: '24', amount: '330', unit: 'ml' }));
    expect(r).toEqual({
      ok: true,
      request: {
        totalPrice: 12,
        category: 'soft-drink',
        quantity: 24,
        unitSize: { value: 330, unit: 'ml' },
      },
    });
  });

  it('mode total: assembles totalAmount, omits quantity + unitSize (two-of-one exclusivity)', () => {
    const r = buildComputeRequest(input({ mode: 'total', amount: '7920', unit: 'ml' }));
    expect(r).toEqual({
      ok: true,
      request: { totalPrice: 12, category: 'soft-drink', totalAmount: { value: 7920, unit: 'ml' } },
    });
    if (r.ok) {
      // exclusivity: the total path NEVER carries the unit-path fields
      expect('quantity' in r.request).toBe(false);
      expect('unitSize' in r.request).toBe(false);
    }
  });

  it('no cohort selected → ok:false (请选择品类), no request', () => {
    expect(buildComputeRequest(input({ cohort: undefined }))).toEqual({ ok: false, hint: '请选择品类' });
  });

  it('off-axis unit for the cohort → ok:false with the axis caption (cross-axis pre-guard)', () => {
    const r = buildComputeRequest(input({ cohort: cohort({ axis: 'per_100ml' }), unit: 'g' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hint).toContain('100ml');
  });

  it('non-positive总价 → ok:false', () => {
    expect(buildComputeRequest(input({ totalPrice: '0' })).ok).toBe(false);
    expect(buildComputeRequest(input({ totalPrice: '-5' })).ok).toBe(false);
    expect(buildComputeRequest(input({ totalPrice: '' })).ok).toBe(false);
    expect(buildComputeRequest(input({ totalPrice: 'abc' })).ok).toBe(false);
  });

  it('non-positive容量 → ok:false, names the right field per mode', () => {
    expect(buildComputeRequest(input({ mode: 'unit', amount: '0' }))).toEqual({ ok: false, hint: '请输入单件容量' });
    expect(buildComputeRequest(input({ mode: 'total', amount: '' }))).toEqual({ ok: false, hint: '请输入总容量' });
  });

  it('mode unit with bad quantity (zero / non-integer / blank) → ok:false', () => {
    expect(buildComputeRequest(input({ mode: 'unit', quantity: '0' })).ok).toBe(false);
    expect(buildComputeRequest(input({ mode: 'unit', quantity: '2.5' })).ok).toBe(false);
    expect(buildComputeRequest(input({ mode: 'unit', quantity: '' })).ok).toBe(false);
  });

  it('mode total ignores a blank quantity (quantity not required on the total path)', () => {
    const r = buildComputeRequest(input({ mode: 'total', quantity: '', amount: '7920' }));
    expect(r.ok).toBe(true);
  });

  it('decimal容量 with L unit assembles as-is (server converts the axis)', () => {
    const r = buildComputeRequest(input({ mode: 'total', amount: '1.25', unit: 'L' }));
    expect(r).toEqual({
      ok: true,
      request: { totalPrice: 12, category: 'soft-drink', totalAmount: { value: 1.25, unit: 'L' } },
    });
  });
});

describe('deriveResultView — result-card presentation (PURE, single source for the card)', () => {
  const res = (over: Partial<ComputeResult> = {}): ComputeResult => ({
    per100ml: 0.5,
    per100g: null,
    formula: '12 / (330 * 24) * 100',
    axis: 'per_100ml',
    rank: 3,
    total: 10,
    percentile: 70,
    neighbors: [],
    ...over,
  });

  it('total===0 → neutral empty (no verdict color, no dot, cheaperPct 0)', () => {
    expect(deriveResultView(res({ total: 0, rank: 1, percentile: 0 }))).toEqual({
      empty: true,
      verdict: 'empty',
      cheaperPct: 0,
      pos: 0,
    });
  });

  it('percentile drives cheaperPct + verdict; ≥66 worth, ≤34 pricey, else mid (inclusive bounds)', () => {
    expect(deriveResultView(res({ percentile: 66 })).verdict).toBe('worth');
    expect(deriveResultView(res({ percentile: 34 })).verdict).toBe('pricey');
    expect(deriveResultView(res({ percentile: 50 })).verdict).toBe('mid');
    expect(deriveResultView(res({ percentile: 70 })).cheaperPct).toBe(70);
  });

  it('pos derives from percentile (same source as verdict, NOT rank): pct100→0 left, pct0→1 right, pct50→0.5', () => {
    expect(deriveResultView(res({ percentile: 100 })).pos).toBe(0); // cheapest → far-left 便宜
    expect(deriveResultView(res({ percentile: 0 })).pos).toBe(1); // priciest → far-right 贵
    expect(deriveResultView(res({ percentile: 50 })).pos).toBe(0.5);
  });

  it('TIE inputs: pos (dot) never contradicts the verdict (the round-3 F-B regression guard)', () => {
    // rows [1,1,1,1] user=1 → server {rank:1,total:4,percentile:0}. The OLD rank-based
    // pos gave 0 (far-left 便宜) while the verdict was pricey — a dot/color contradiction.
    // Now pos derives from percentile, so dot(right) and verdict(pricey) AGREE.
    const tiedAll = deriveResultView(res({ rank: 1, total: 4, percentile: 0 }));
    expect(tiedAll.pos).toBe(1);
    expect(tiedAll.verdict).toBe('pricey');
    // tied-cheapest [0.5,0.5,1,2,5] user=0.5 → {rank:1,total:5,percentile:60}: dot left-of-mid + mid.
    const tiedCheap = deriveResultView(res({ rank: 1, total: 5, percentile: 60 }));
    expect(tiedCheap.pos).toBeCloseTo(0.4);
    expect(tiedCheap.verdict).toBe('mid');
  });

  it('verdict thresholds on the ROUNDED cheaperPct so the number and word never straddle (F-A)', () => {
    const hi = deriveResultView(res({ percentile: 65.6 }));
    expect(hi.cheaperPct).toBe(66);
    expect(hi.verdict).toBe('worth'); // rounded 66 ≥ 66, not 'mid'
    const lo = deriveResultView(res({ percentile: 34.4 }));
    expect(lo.cheaperPct).toBe(34);
    expect(lo.verdict).toBe('pricey'); // rounded 34 ≤ 34
  });
});
