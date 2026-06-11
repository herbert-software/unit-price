// Scoring harness — run the corpus through @unit-price/core tier1 + tier3 (and
// optionally tier1+tier2 when OPENROUTER_API_KEY is set), then compute the
// calibration metrics defined in spec "打分跑批器".
//
// Hard invariants (see spec):
//  - NEVER produce NaN / Infinity / divide-by-zero. Per-sample, per-unit error
//    is only counted when `quantity > 0` AND `samUnitPrice` (and priceCents)
//    present. Per-metric, an empty denominator is recorded as `n/a` (the literal
//    string "n/a"), never 0 / NaN, and an `n/a` metric is excluded from
//    regression comparison.
//  - per100ml has NO external truth → it is NOT subject to an accuracy assertion;
//    "computability rate" (tier3 producing a non-null per100ml or per100g) is the
//    metric we consume from tier3.
//  - No key → tier1-only is evaluated; the report flags "tier2 未评(无 key)" and
//    the harness must not error out. tier2 is reached via a dynamic import of
//    `@unit-price/api` so apps/api is never a resident dependency; if it cannot
//    be loaded the tier2 lane is honestly skipped (recorded in issues).

import { calculate, parseTier1, type RawProduct } from '@unit-price/core';
import type { CorpusSample } from './corpus.js';

/** A metric value: either a finite number or the literal `'n/a'` placeholder. */
export type MetricValue = number | 'n/a';

/** True when a metric carries a real (comparable) numeric value. */
export function isNumericMetric(v: MetricValue): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Safely divide numerator by denominator, returning `'n/a'` when the
 * denominator is 0 (empty / zero-eligible sample set) — the global no-NaN /
 * no-divide-by-zero guard at the metric layer.
 */
function ratio(numerator: number, denominator: number): MetricValue {
  if (denominator <= 0) return 'n/a';
  const v = numerator / denominator;
  return Number.isFinite(v) ? v : 'n/a';
}

/** A sample flagged for the human-readable failure list. */
export interface FailureSample {
  /** 1-based index into the corpus (order of appearance). */
  index: number;
  title: string;
  /** Why this sample is a failure for the named metric. */
  reason: string;
}

/** Metrics for a single evaluation lane (tier1-only or tier1+tier2). */
export interface LaneMetrics {
  /** Lane label. */
  lane: 'tier1' | 'tier1+tier2';
  /** Number of samples evaluated in this lane. */
  total: number;
  /** Recall: fraction of samples for which tier1 populated the field. */
  recall: {
    unitSize: MetricValue;
    quantity: MetricValue;
    totalAmount: MetricValue;
  };
  /**
   * Computability rate: fraction of samples (with a usable price) for which
   * tier3 produced a non-null per100ml or per100g. Consumes the tier3 conclusion.
   */
  computability: MetricValue;
  /**
   * Quantity accuracy vs `samPkgNum`: fraction of samples-with-samPkgNum whose
   * parsed quantity equals samPkgNum. A wrong value / 0 / null all count wrong.
   */
  quantityAccuracy: MetricValue;
  /**
   * Per-unit price error: mean relative error of `evalPerUnit =
   * (priceCents/100)/quantity` vs `samUnitPrice`, over samples with
   * `quantity > 0` AND `samUnitPrice` AND `priceCents`. (`quantity <= 0` / null
   * excluded → no divide-by-zero.)
   */
  perUnitError: MetricValue;
  /** Failure samples for human triage. */
  failures: FailureSample[];
}

/** The full machine-readable metrics snapshot. */
export interface Metrics {
  /** Number of corpus samples. */
  corpusSize: number;
  /** tier1-only lane (always present). */
  tier1: LaneMetrics;
  /** tier1+tier2 lane, present only when the LLM lane actually ran. */
  tier1Tier2?: LaneMetrics;
  /** Whether the tier2 lane was evaluated (key present AND port loaded). */
  tier2Evaluated: boolean;
  /** Honest note when tier2 was not evaluated (no key / port unavailable). */
  tier2Note?: string;
  /** Non-fatal issues encountered (e.g. tier2 port could not be imported). */
  issues: string[];
}

/** A resolved spec for one sample in one lane — what we score against. */
interface ScoredSample {
  hitUnitSize: boolean;
  hitQuantity: boolean;
  hitTotalAmount: boolean;
  /** parsed quantity (may be null / any number). */
  quantity: number | null;
  /** tier3 per100ml (null when uncomputable). */
  per100ml: number | null;
  /** tier3 per100g (null when uncomputable / not weight axis). */
  per100g: number | null;
  /** whether the sample carried a usable (>0) price at all. */
  hasUsablePrice: boolean;
}

/** Build the RawProduct fed to the core engine. price is yuan (priceCents/100). */
function toRawProduct(sample: CorpusSample): RawProduct {
  // Missing price → 0, which the calculator treats as uncomputable (no throw).
  const price = sample.priceCents != null ? sample.priceCents / 100 : 0;
  return { title: sample.title, price };
}

/**
 * Compute lane metrics from a parallel array of scored samples. The metric
 * layer guards every denominator → `n/a` instead of NaN/0 on an empty set.
 */
function computeLaneMetrics(
  lane: LaneMetrics['lane'],
  samples: CorpusSample[],
  scored: ScoredSample[],
): LaneMetrics {
  const total = samples.length;
  const failures: FailureSample[] = [];

  let unitSizeHits = 0;
  let quantityHits = 0;
  let totalAmountHits = 0;

  // computability: denominator = samples with a usable price.
  let priceEligible = 0;
  let computable = 0;

  // quantity accuracy: denominator = samples with samPkgNum.
  let qtyTruthCount = 0;
  let qtyCorrect = 0;

  // per-unit error: denominator = samples with quantity>0 AND samUnitPrice AND price.
  let perUnitCount = 0;
  let perUnitErrorSum = 0;

  for (let i = 0; i < total; i++) {
    const sample = samples[i]!;
    const s = scored[i]!;
    const index = i + 1;

    if (s.hitUnitSize) unitSizeHits++;
    if (s.hitQuantity) quantityHits++;
    if (s.hitTotalAmount) totalAmountHits++;

    if (s.hasUsablePrice) {
      priceEligible++;
      if (s.per100ml !== null || s.per100g !== null) {
        computable++;
      } else {
        failures.push({ index, title: sample.title, reason: 'uncomputable (no per100ml/per100g)' });
      }
    }

    // Quantity accuracy vs samPkgNum (0 / wrong value / null all count wrong).
    if (sample.samPkgNum != null) {
      qtyTruthCount++;
      if (s.quantity !== null && s.quantity === sample.samPkgNum) {
        qtyCorrect++;
      } else {
        failures.push({
          index,
          title: sample.title,
          reason: `quantity ${s.quantity === null ? 'null' : s.quantity} != samPkgNum ${sample.samPkgNum}`,
        });
      }
    }

    // Per-unit error — strictly guarded against divide-by-zero, and against
    // negative/zero prices (aligned with hasUsablePrice's `price > 0`) so a
    // negative priceCents cannot pollute perUnitError with a spurious error.
    const hasPrice = sample.priceCents != null && sample.priceCents > 0;
    const qty = s.quantity;
    if (
      hasPrice &&
      sample.samUnitPrice != null &&
      sample.samUnitPrice > 0 &&
      qty !== null &&
      qty > 0
    ) {
      const evalPerUnit = sample.priceCents! / 100 / qty;
      const relErr = Math.abs(evalPerUnit - sample.samUnitPrice) / sample.samUnitPrice;
      if (Number.isFinite(relErr)) {
        perUnitCount++;
        perUnitErrorSum += relErr;
      }
    }
  }

  return {
    lane,
    total,
    recall: {
      unitSize: ratio(unitSizeHits, total),
      quantity: ratio(quantityHits, total),
      totalAmount: ratio(totalAmountHits, total),
    },
    computability: ratio(computable, priceEligible),
    quantityAccuracy: ratio(qtyCorrect, qtyTruthCount),
    perUnitError: ratio(perUnitErrorSum, perUnitCount),
    failures,
  };
}

/** Run tier1 + tier3 for one sample, returning its scored shape. */
function scoreTier1(sample: CorpusSample): ScoredSample {
  const input = toRawProduct(sample);
  const t1 = parseTier1(input);
  const calc = calculate(t1.spec, input.price);
  return {
    hitUnitSize: t1.evidence.hits.unitSize,
    hitQuantity: t1.evidence.hits.quantity,
    hitTotalAmount: t1.evidence.hits.totalAmount,
    quantity: t1.spec.quantity ?? null,
    per100ml: calc.unitPrice.per100ml,
    per100g: calc.unitPrice.per100g,
    hasUsablePrice: input.price > 0,
  };
}

/** Options for {@link scoreCorpus}. */
export interface ScoreOptions {
  /** OPENROUTER_API_KEY value (absence → tier1-only). */
  apiKey?: string;
  /**
   * Override the tier2 orchestrator loader (for tests). Returns a function that
   * scores one sample's merged tier1+tier2 spec, or null when unavailable.
   */
  loadTier2?: () => Promise<Tier2Scorer | null>;
}

/** Scores one sample through tier1+tier2 (merged) + tier3. */
export type Tier2Scorer = (sample: CorpusSample) => Promise<ScoredSample>;

/**
 * Default tier2 loader: dynamically import `@unit-price/api` (never a resident
 * dependency) and adapt its orchestration to a {@link Tier2Scorer}. Returns null
 * if the port cannot be imported, so the tier2 lane is honestly skipped.
 */
async function defaultLoadTier2(apiKey: string): Promise<Tier2Scorer | null> {
  try {
    // Dynamic import by package name — only reached when a key is present.
    // `@unit-price/api` is intentionally NOT a resident dependency of this
    // package; the specifier is built as a variable so the compiler does not
    // try to resolve it at build time (it is resolved at runtime only).
    const specifier = ['@unit-price', 'api'].join('/');
    const api = (await import(/* @vite-ignore */ specifier)) as {
      AiSdkSpecParser?: new (config?: unknown) => {
        parse: (input: RawProduct) => Promise<unknown>;
      };
      orchestrate?: (
        input: RawProduct,
        llm: unknown,
      ) => Promise<{
        kind: string;
        response?: {
          spec: { quantity?: number | null };
          unitPrice: { per100ml: number | null; per100g?: number | null };
        };
      }>;
      loadLlmConfig?: () => unknown;
    };
    if (!api.AiSdkSpecParser || !api.orchestrate || !api.loadLlmConfig) {
      return null;
    }
    const llm = new api.AiSdkSpecParser(api.loadLlmConfig());
    const orchestrate = api.orchestrate;
    return async (sample: CorpusSample): Promise<ScoredSample> => {
      const input = toRawProduct(sample);
      // tier1 hits/quantity are needed regardless of the merged outcome.
      const t1 = parseTier1(input);
      const outcome = await orchestrate(input, llm);
      let per100ml: number | null = null;
      let per100g: number | null = null;
      let quantity: number | null = t1.spec.quantity ?? null;
      if (outcome.kind === 'ok' && outcome.response) {
        per100ml = outcome.response.unitPrice.per100ml ?? null;
        per100g = outcome.response.unitPrice.per100g ?? null;
        quantity = outcome.response.spec.quantity ?? quantity;
      }
      return {
        hitUnitSize: t1.evidence.hits.unitSize,
        hitQuantity: t1.evidence.hits.quantity,
        hitTotalAmount: t1.evidence.hits.totalAmount,
        quantity,
        per100ml,
        per100g,
        hasUsablePrice: input.price > 0,
      };
    };
  } catch {
    return null;
  }
}

/**
 * Score a corpus, producing the full metrics snapshot. Always evaluates the
 * tier1-only lane. Evaluates the tier1+tier2 lane only when a key is present
 * AND the tier2 port could be loaded; otherwise records an honest note + issue.
 */
export async function scoreCorpus(
  samples: CorpusSample[],
  options: ScoreOptions = {},
): Promise<Metrics> {
  const apiKey = options.apiKey;
  const issues: string[] = [];

  // tier1-only lane — always runs, never depends on a key.
  const tier1Scored = samples.map(scoreTier1);
  const tier1 = computeLaneMetrics('tier1', samples, tier1Scored);

  const metrics: Metrics = {
    corpusSize: samples.length,
    tier1,
    tier2Evaluated: false,
    issues,
  };

  if (!apiKey) {
    metrics.tier2Note = 'tier2 未评(无 key)';
    return metrics;
  }

  // Key present → attempt the tier2 lane via dynamic import.
  const loader = options.loadTier2 ?? (() => defaultLoadTier2(apiKey));
  let scorer: Tier2Scorer | null = null;
  try {
    scorer = await loader();
  } catch (err) {
    scorer = null;
    issues.push(`tier2 loader threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!scorer) {
    metrics.tier2Note = 'tier2 未评(端口不可用)';
    issues.push('tier2 port (@unit-price/api) could not be loaded; tier2 lane skipped');
    return metrics;
  }

  const tier2Scored: ScoredSample[] = [];
  for (const sample of samples) {
    tier2Scored.push(await scorer(sample));
  }
  metrics.tier1Tier2 = computeLaneMetrics('tier1+tier2', samples, tier2Scored);
  metrics.tier2Evaluated = true;
  return metrics;
}

/** Format a metric value for human display. */
function fmtMetric(v: MetricValue, kind: 'pct' | 'err'): string {
  if (!isNumericMetric(v)) return 'n/a (样本不足)';
  if (kind === 'pct') return `${(v * 100).toFixed(1)}%`;
  return `${(v * 100).toFixed(2)}%`;
}

/** Render one lane's metrics as human-readable lines. */
function renderLane(m: LaneMetrics): string[] {
  const lines = [
    `[${m.lane}] samples=${m.total}`,
    `  recall.unitSize     ${fmtMetric(m.recall.unitSize, 'pct')}`,
    `  recall.quantity     ${fmtMetric(m.recall.quantity, 'pct')}`,
    `  recall.totalAmount  ${fmtMetric(m.recall.totalAmount, 'pct')}`,
    `  computability       ${fmtMetric(m.computability, 'pct')}`,
    `  quantityAccuracy    ${fmtMetric(m.quantityAccuracy, 'pct')}`,
    `  perUnitError        ${fmtMetric(m.perUnitError, 'err')}`,
  ];
  if (m.failures.length > 0) {
    lines.push(`  failures (${m.failures.length}):`);
    for (const f of m.failures) {
      lines.push(`    #${f.index} ${f.title} — ${f.reason}`);
    }
  }
  return lines;
}

/** Render the full metrics snapshot as a human-readable report (no NaN). */
export function renderReport(metrics: Metrics): string {
  const lines: string[] = [];
  lines.push(`corpus size: ${metrics.corpusSize}`);
  lines.push('note: per100ml 无外部真值,不做精度断言(仅由 quantity + 容量解析间接佐证)');
  lines.push(...renderLane(metrics.tier1));
  if (metrics.tier1Tier2) {
    lines.push(...renderLane(metrics.tier1Tier2));
  }
  if (!metrics.tier2Evaluated && metrics.tier2Note) {
    lines.push(`tier2: ${metrics.tier2Note}`);
  }
  if (metrics.issues.length > 0) {
    lines.push('issues:');
    for (const issue of metrics.issues) lines.push(`  - ${issue}`);
  }
  return lines.join('\n');
}
