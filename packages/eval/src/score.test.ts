import { describe, expect, it } from 'vitest';
import type { CorpusSample } from './corpus.js';
import { isNumericMetric, renderReport, scoreCorpus } from './score.js';

// A small corpus exercising recall, quantity accuracy, computability, and the
// guarded per-unit error path.
const corpus: CorpusSample[] = [
  // Clean full spec: 330ml*6, ¥109.90 → per-bottle 18.32, samPkgNum 6 correct.
  {
    title: '可口可乐 330ml*6听',
    source: 'manual',
    priceCents: 10990,
    samPkgNum: 6,
    samUnitPrice: 18.32,
  },
  // 550ml*24, ¥35.90, samPkgNum 24, samUnitPrice ~1.4958.
  {
    title: '农夫山泉 550ml*24',
    source: 'manual',
    priceCents: 3590,
    samPkgNum: 24,
    samUnitPrice: 1.4958,
  },
  // No quantity in title → bare '500ml' now inferred as single unit (qty=1);
  // samPkgNum 12 → quantity accuracy wrong. qty=1>0 + samUnitPrice + price →
  // per-unit error now INCLUDED (large error from the inferred single unit).
  {
    title: '矿泉水 500ml',
    source: 'manual',
    priceCents: 1200,
    samPkgNum: 12,
    samUnitPrice: 1.0,
  },
];

describe('scoreCorpus — tier1-only (no key)', () => {
  it('computes recall, quantity accuracy, computability, per-unit error correctly', async () => {
    const m = await scoreCorpus(corpus, { apiKey: undefined });

    expect(m.tier2Evaluated).toBe(false);
    expect(m.tier2Note).toContain('无 key');
    expect(m.corpusSize).toBe(3);

    const t = m.tier1;
    // unitSize hit on all 3 (330ml, 550ml, 500ml).
    expect(t.recall.unitSize).toBe(1);
    // quantity hit on all 3: bare '500ml' now inferred as single unit (qty=1).
    expect(t.recall.quantity).toBe(1);
    // totalAmount derivable on all 3 (every sample now has a quantity).
    expect(t.recall.totalAmount).toBe(1);

    // computability: all 3 have a usable price and a quantity → all 3 compute.
    expect(t.computability).toBe(1);

    // quantity accuracy: 2 correct (6, 24), 1 wrong (inferred 1 vs samPkgNum 12).
    expect(t.quantityAccuracy).toBeCloseTo(2 / 3, 6);

    // per-unit error: all 3 now qualify (every sample has qty>0 + samUnitPrice + price).
    // sample 1: evalPerUnit = 109.90/6 = 18.3166..., rel err vs 18.32 ≈ 0.0182%.
    // sample 2: evalPerUnit = 35.90/24 = 1.49583..., rel err vs 1.4958 ≈ 0.0022%.
    // sample 3: evalPerUnit = 12.00/1 (inferred qty=1) = 12 vs samUnitPrice 1.0 → 1100% err.
    // mean ≈ (0.0182% + 0.0022% + 1100%)/3 ≈ 3.6667.
    expect(isNumericMetric(t.perUnitError)).toBe(true);
    expect(t.perUnitError as number).toBeCloseTo(3.6667, 3);
    expect(t.perUnitError as number).toBeGreaterThanOrEqual(0);
  });

  it('renderReport never emits NaN and flags per100ml has no external truth', async () => {
    const m = await scoreCorpus(corpus, { apiKey: undefined });
    const report = renderReport(m);
    expect(report).not.toMatch(/NaN/);
    expect(report).toContain('per100ml 无外部真值');
    expect(report).toContain('tier2 未评(无 key)');
  });
});

describe('scoreCorpus — per-unit error guards against divide-by-zero', () => {
  it('excludes quantity<=0 samples (no priceCents/0)', async () => {
    // "330ml*0" → tier1 quantity 0 → per-unit error EXCLUDED, qty accuracy wrong.
    const guarded: CorpusSample[] = [
      {
        title: '怪味饮料 330ml*0',
        source: 'manual',
        priceCents: 1000,
        samPkgNum: 6,
        samUnitPrice: 1.67,
      },
    ];
    const m = await scoreCorpus(guarded, { apiKey: undefined });
    // No qualifying per-unit sample → n/a, not NaN.
    expect(m.tier1.perUnitError).toBe('n/a');
    // quantity 0 != samPkgNum 6 → wrong.
    expect(m.tier1.quantityAccuracy).toBe(0);
    expect(renderReport(m)).not.toMatch(/NaN/);
  });
});

describe('scoreCorpus — negative priceCents is excluded symmetrically', () => {
  it('does not pollute perUnitError with a negative price (computability n/a too)', async () => {
    // priceCents -6000 → hasUsablePrice false (price>0). Per-unit error must NOT
    // count this sample (would otherwise be a spurious ~154% error).
    const negative: CorpusSample[] = [
      {
        title: 'X 330ml*6',
        source: 'manual',
        priceCents: -6000,
        samPkgNum: 6,
        samUnitPrice: 18.32,
      },
    ];
    const m = await scoreCorpus(negative, { apiKey: undefined });
    // Only sample has a negative price → no usable price → computability n/a.
    expect(m.tier1.computability).toBe('n/a');
    // Per-unit error excludes the negative-price sample → n/a, never ~1.54.
    expect(m.tier1.perUnitError).toBe('n/a');
    expect(renderReport(m)).not.toMatch(/NaN/);
  });
});

describe('scoreCorpus — empty / zero-eligible corpus → n/a not divide-by-zero', () => {
  it('empty corpus yields n/a for every metric', async () => {
    const m = await scoreCorpus([], { apiKey: undefined });
    expect(m.corpusSize).toBe(0);
    expect(m.tier1.recall.unitSize).toBe('n/a');
    expect(m.tier1.recall.quantity).toBe('n/a');
    expect(m.tier1.recall.totalAmount).toBe('n/a');
    expect(m.tier1.computability).toBe('n/a');
    expect(m.tier1.quantityAccuracy).toBe('n/a');
    expect(m.tier1.perUnitError).toBe('n/a');
    expect(renderReport(m)).not.toMatch(/NaN/);
  });

  it('corpus with no truth fields → truth-requiring metrics are n/a, recall still computed', async () => {
    const noTruth: CorpusSample[] = [
      { title: '可乐 330ml*6', source: 'manual' }, // no price, no sam*
    ];
    const m = await scoreCorpus(noTruth, { apiKey: undefined });
    // recall still measurable.
    expect(m.tier1.recall.unitSize).toBe(1);
    // no usable price → computability n/a (denominator 0).
    expect(m.tier1.computability).toBe('n/a');
    // no samPkgNum → quantity accuracy n/a.
    expect(m.tier1.quantityAccuracy).toBe('n/a');
    // no samUnitPrice/price → per-unit error n/a.
    expect(m.tier1.perUnitError).toBe('n/a');
  });
});

describe('scoreCorpus — tier2 lane', () => {
  it('honestly skips tier2 when the port cannot be loaded (key present)', async () => {
    const m = await scoreCorpus(corpus, {
      apiKey: 'fake-key',
      loadTier2: async () => null,
    });
    expect(m.tier2Evaluated).toBe(false);
    expect(m.tier1Tier2).toBeUndefined();
    expect(m.tier2Note).toContain('端口不可用');
    expect(m.issues.length).toBeGreaterThan(0);
    // tier1-only must still be fully computed.
    expect(m.tier1.recall.unitSize).toBe(1);
  });

  it('produces a tier1+tier2 lane when a scorer is provided', async () => {
    const m = await scoreCorpus(corpus, {
      apiKey: 'fake-key',
      // Stub: pretend tier2 resolved quantity for every sample to its samPkgNum.
      loadTier2: async () => async (sample: CorpusSample) => ({
        hitUnitSize: true,
        hitQuantity: true,
        hitTotalAmount: true,
        quantity: sample.samPkgNum ?? null,
        per100ml: 1,
        per100g: null,
        hasUsablePrice: sample.priceCents != null && sample.priceCents > 0,
      }),
    });
    expect(m.tier2Evaluated).toBe(true);
    expect(m.tier1Tier2).toBeDefined();
    // With tier2 filling quantity to samPkgNum, accuracy is perfect.
    expect(m.tier1Tier2!.quantityAccuracy).toBe(1);
  });
});
