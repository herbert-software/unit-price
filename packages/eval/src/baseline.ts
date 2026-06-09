// Regression baseline — save a metrics snapshot and compare a fresh run against
// it (see spec "回归基线对比").
//
// Direction-aware regression (metrics have a polarity):
//  - "higher is better" (recall / computability / quantity accuracy): regress
//    when current < baseline - threshold.
//  - "lower is better" (per-unit error): regress when current > baseline +
//    threshold.
// `n/a` metrics (empty denominator) are excluded from the comparison. First run
// (no baseline) is NOT a regression: report it and exit 0.

import type { LaneMetrics, MetricValue, Metrics } from './score.js';
import { isNumericMetric } from './score.js';

/** A baseline file is just a saved metrics snapshot. */
export type Baseline = Metrics;

/** Conservative default regression threshold (absolute, on the [0,1] scale). */
export const DEFAULT_THRESHOLD = 0.05;

/** One detected regression. */
export interface Regression {
  /** Dotted metric path, e.g. `tier1.recall.quantity`. */
  metric: string;
  baseline: number;
  current: number;
  /** Threshold applied. */
  threshold: number;
  /** Polarity of the metric. */
  direction: 'higher-better' | 'lower-better';
}

/** Result of a baseline comparison. */
export interface ComparisonResult {
  /** True when no baseline was supplied (first run) — never a regression. */
  noBaseline: boolean;
  /** Detected regressions (empty when none / no baseline). */
  regressions: Regression[];
  /**
   * Newly-failing samples in the tier1 lane: failures present in the current
   * run that were not in the baseline (keyed by index+reason).
   */
  newFailures: { index: number; title: string; reason: string }[];
}

/** A single comparable metric extracted from a lane, with its polarity. */
interface MetricRef {
  path: string;
  value: MetricValue;
  direction: 'higher-better' | 'lower-better';
}

/** Enumerate every comparable metric in a lane with its dotted path + polarity. */
function laneMetricRefs(prefix: string, lane: LaneMetrics): MetricRef[] {
  return [
    { path: `${prefix}.recall.unitSize`, value: lane.recall.unitSize, direction: 'higher-better' },
    { path: `${prefix}.recall.quantity`, value: lane.recall.quantity, direction: 'higher-better' },
    { path: `${prefix}.recall.totalAmount`, value: lane.recall.totalAmount, direction: 'higher-better' },
    { path: `${prefix}.computability`, value: lane.computability, direction: 'higher-better' },
    { path: `${prefix}.quantityAccuracy`, value: lane.quantityAccuracy, direction: 'higher-better' },
    { path: `${prefix}.perUnitError`, value: lane.perUnitError, direction: 'lower-better' },
  ];
}

/** Collect all comparable metric refs across present lanes. */
function metricRefs(m: Metrics): MetricRef[] {
  const refs = laneMetricRefs('tier1', m.tier1);
  if (m.tier1Tier2) refs.push(...laneMetricRefs('tier1+tier2', m.tier1Tier2));
  return refs;
}

/**
 * Compare current metrics against a baseline. When `baseline` is null/undefined
 * this is a first run (no regression). Metrics that are `n/a` in either snapshot
 * are skipped (excluded from the comparison per spec).
 */
export function compareToBaseline(
  current: Metrics,
  baseline: Baseline | null | undefined,
  threshold: number = DEFAULT_THRESHOLD,
): ComparisonResult {
  if (!baseline) {
    return { noBaseline: true, regressions: [], newFailures: [] };
  }

  const baseByPath = new Map<string, MetricRef>();
  for (const ref of metricRefs(baseline)) baseByPath.set(ref.path, ref);

  const regressions: Regression[] = [];
  for (const cur of metricRefs(current)) {
    const base = baseByPath.get(cur.path);
    if (!base) continue;
    // n/a on either side → excluded from comparison.
    if (!isNumericMetric(cur.value) || !isNumericMetric(base.value)) continue;

    const c = cur.value;
    const b = base.value;
    const regressed =
      cur.direction === 'higher-better' ? c < b - threshold : c > b + threshold;
    if (regressed) {
      regressions.push({
        metric: cur.path,
        baseline: b,
        current: c,
        threshold,
        direction: cur.direction,
      });
    }
  }

  // Newly-failing tier1 samples (present now, absent in baseline).
  const baseFailKeys = new Set(
    baseline.tier1.failures.map((f) => `${f.index}::${f.reason}`),
  );
  const newFailures = current.tier1.failures.filter(
    (f) => !baseFailKeys.has(`${f.index}::${f.reason}`),
  );

  return { noBaseline: false, regressions, newFailures };
}

/** Render a comparison result as human-readable lines. */
export function renderComparison(result: ComparisonResult): string {
  if (result.noBaseline) {
    return '回归对比: 无基线,未做回归对比(首跑)';
  }
  if (result.regressions.length === 0) {
    return '回归对比: 通过(无指标回退)';
  }
  const lines = ['回归对比: 检测到回退'];
  for (const r of result.regressions) {
    const dir = r.direction === 'higher-better' ? '↓ 低于' : '↑ 高于';
    lines.push(
      `  ${r.metric}: 基线 ${r.baseline.toFixed(4)} → 当前 ${r.current.toFixed(4)} ` +
        `(${dir}阈值 ${r.threshold})`,
    );
  }
  if (result.newFailures.length > 0) {
    lines.push(`  新增失败样本 (${result.newFailures.length}):`);
    for (const f of result.newFailures) {
      lines.push(`    #${f.index} ${f.title} — ${f.reason}`);
    }
  }
  return lines.join('\n');
}
