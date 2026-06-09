import { describe, expect, it } from 'vitest';
import { compareToBaseline, renderComparison } from './baseline.js';
import type { LaneMetrics, Metrics } from './score.js';

function lane(overrides: Partial<LaneMetrics> = {}): LaneMetrics {
  return {
    lane: 'tier1',
    total: 100,
    recall: { unitSize: 0.98, quantity: 0.21, totalAmount: 0.21 },
    computability: 0.21,
    quantityAccuracy: 0.95,
    perUnitError: 0.02,
    failures: [],
    ...overrides,
  };
}

function metrics(t1: LaneMetrics): Metrics {
  return {
    corpusSize: t1.total,
    tier1: t1,
    tier2Evaluated: false,
    tier2Note: 'tier2 未评(无 key)',
    issues: [],
  };
}

describe('compareToBaseline', () => {
  it('no baseline → first run, not a regression', () => {
    const result = compareToBaseline(metrics(lane()), null);
    expect(result.noBaseline).toBe(true);
    expect(result.regressions).toHaveLength(0);
    expect(renderComparison(result)).toContain('无基线');
  });

  it('metrics at or above baseline → passes (no regression)', () => {
    const base = metrics(lane({ quantityAccuracy: 0.95 }));
    const cur = metrics(lane({ quantityAccuracy: 0.96 }));
    const result = compareToBaseline(cur, base, 0.05);
    expect(result.regressions).toHaveLength(0);
  });

  it('positive metric (quantity accuracy) falling below baseline-threshold → regression', () => {
    // baseline 95% → current 80% (drop 15% > threshold 5%).
    const base = metrics(lane({ quantityAccuracy: 0.95 }));
    const cur = metrics(lane({ quantityAccuracy: 0.8 }));
    const result = compareToBaseline(cur, base, 0.05);
    expect(result.regressions.length).toBeGreaterThan(0);
    const r = result.regressions.find((x) => x.metric === 'tier1.quantityAccuracy');
    expect(r).toBeDefined();
    expect(r!.direction).toBe('higher-better');
  });

  it('inverse metric (per-unit error) rising above baseline+threshold → regression', () => {
    // baseline 2% → current 8% (rise 6% > threshold 5%).
    const base = metrics(lane({ perUnitError: 0.02 }));
    const cur = metrics(lane({ perUnitError: 0.08 }));
    const result = compareToBaseline(cur, base, 0.05);
    const r = result.regressions.find((x) => x.metric === 'tier1.perUnitError');
    expect(r).toBeDefined();
    expect(r!.direction).toBe('lower-better');
  });

  it('n/a metrics are excluded from comparison', () => {
    const base = metrics(lane({ quantityAccuracy: 0.95 }));
    const cur = metrics(lane({ quantityAccuracy: 'n/a' }));
    const result = compareToBaseline(cur, base, 0.05);
    expect(result.regressions.find((x) => x.metric === 'tier1.quantityAccuracy')).toBeUndefined();
  });

  it('lists newly-failing samples not present in the baseline', () => {
    const base = metrics(
      lane({ failures: [{ index: 1, title: 'a', reason: 'x' }] }),
    );
    const cur = metrics(
      lane({
        failures: [
          { index: 1, title: 'a', reason: 'x' },
          { index: 2, title: 'b', reason: 'y' },
        ],
      }),
    );
    const result = compareToBaseline(cur, base, 0.05);
    expect(result.newFailures).toHaveLength(1);
    expect(result.newFailures[0]!.index).toBe(2);
  });

  it('threshold is configurable: a small drop within a larger threshold passes', () => {
    const base = metrics(lane({ quantityAccuracy: 0.95 }));
    const cur = metrics(lane({ quantityAccuracy: 0.85 }));
    // drop 10% but threshold 15% → no regression.
    const result = compareToBaseline(cur, base, 0.15);
    expect(result.regressions.find((x) => x.metric === 'tier1.quantityAccuracy')).toBeUndefined();
  });
});
