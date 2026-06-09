// tier3 calculator. Pure, no IO. Computes per100ml + canonical formula,
// applies the unified uncomputable terminal state, the consistency gate, and
// the single authoritative confidence banding.
import { checkConsistency, multiplierOf } from './consistency.js';
import {
  hasUnitSizeAndQuantity,
  hasUsableTotalAmount,
  meetsComputeRequiredSet,
  meetsFullSpecSet,
} from './tiers.js';
import type { ParsedSpec, UnitPrice } from './types.js';
import { isVolumeUnit, toMl } from './units.js';

export interface CalcResult {
  unitPrice: UnitPrice;
  /** Single authoritative top-level confidence (final-result banding). */
  confidence: number;
  warnings: string[];
}

/** Confidence band representative values; per-band scoring is a later change. */
const BAND_HIGH = 0.95; // >= 0.9
const BAND_MID = 0.7; // (0.5, 0.9)
const BAND_LOW = 0.3; // <= 0.5

const WARN_NON_VOLUME = '本次仅支持容量单位的饮料';
const WARN_NO_TOTAL = '无法确定总容量，无法计算每 100ml 单价';
const WARN_BAD_PRICE = '价格无效（非正或非有限），无法计算每 100ml 单价';
const WARN_INCONSISTENT = '规格不一致，总量不可信，已抑制单价';
const WARN_INCOMPLETE = '规格不完整，未校验自洽性';

/** Uncomputable terminal state: per100ml=null, no formula, warning, low conf. */
function uncomputable(warning: string): CalcResult {
  return {
    unitPrice: { per100ml: null, formula: null },
    confidence: BAND_LOW,
    warnings: [warning],
  };
}

/**
 * Render a number into the canonical formula without scientific notation or
 * trailing-zero noise (e.g. 330, 1.25, 1000).
 */
function fmt(n: number): string {
  return String(n);
}

/**
 * tier3 entry. Computes per100ml from the final (merged) spec + price, or
 * routes to the unified uncomputable terminal state. Never emits NaN/Infinity.
 */
export function calculate(spec: ParsedSpec, price: number): CalcResult {
  // price guard.
  if (!(price > 0)) {
    return uncomputable(WARN_BAD_PRICE);
  }

  // Resolve totalMl: prefer an explicit usable totalAmount; otherwise derive
  // from unitSize + quantity (volume only).
  const total = spec.totalAmount;
  const explicitTotalUsable = hasUsableTotalAmount(spec);

  // Non-volume totalAmount (weight etc.) -> uncomputable.
  if (total !== null && total !== undefined && !isVolumeUnit(total.unit)) {
    return uncomputable(WARN_NON_VOLUME);
  }

  // unitSize present but non-volume (weight) with no usable volume total.
  const unitSize = spec.unitSize;
  if (
    !explicitTotalUsable &&
    unitSize !== null &&
    unitSize !== undefined &&
    !isVolumeUnit(unitSize.unit)
  ) {
    return uncomputable(WARN_NON_VOLUME);
  }

  // Presence-level computability (compute-required set, no consistency yet).
  if (!meetsComputeRequiredSet(spec, price)) {
    return uncomputable(WARN_NO_TOTAL);
  }

  // Consistency gate (independent of the compute-required set).
  const consistency = checkConsistency(spec);
  if (consistency.kind === 'inconsistent') {
    return uncomputable(WARN_INCONSISTENT);
  }

  // Compute totalMl. Prefer explicit total; else derive from unitSize*qty*mult.
  let totalMl: number | null = null;
  if (explicitTotalUsable && total) {
    totalMl = toMl(total);
  } else if (hasUnitSizeAndQuantity(spec) && unitSize && spec.quantity != null) {
    const unitSizeMl = toMl(unitSize);
    if (unitSizeMl !== null) {
      totalMl = unitSizeMl * spec.quantity * multiplierOf(spec);
    }
  }

  // Defensive: no usable, finite, positive totalMl -> uncomputable.
  if (totalMl === null || !Number.isFinite(totalMl) || totalMl <= 0) {
    return uncomputable(WARN_NO_TOTAL);
  }

  const per100ml = (price / totalMl) * 100;
  if (!Number.isFinite(per100ml)) {
    return uncomputable(WARN_NO_TOTAL);
  }

  // Canonical formula: expanded form when unitSize/quantity known, else
  // contracted form. Always uses ml-converted values.
  let formula: string;
  const useExpanded =
    hasUnitSizeAndQuantity(spec) && unitSize !== null && unitSize !== undefined;
  if (useExpanded && unitSize) {
    const unitSizeMl = toMl(unitSize);
    if (unitSizeMl !== null && spec.quantity != null) {
      formula = `${fmt(price)} / (${fmt(unitSizeMl)} * ${fmt(spec.quantity)} * ${fmt(
        multiplierOf(spec),
      )}) * 100`;
    } else {
      formula = `${fmt(price)} / ${fmt(totalMl)} * 100`;
    }
  } else {
    formula = `${fmt(price)} / ${fmt(totalMl)} * 100`;
  }

  // Confidence banding — single authoritative value from final result quality.
  // High: full-spec set AND consistency gate passed.
  // Mid: compute-required but not high (missing-field contracted form).
  const warnings: string[] = [];
  let confidence: number;
  if (meetsFullSpecSet(spec) && consistency.kind === 'consistent') {
    confidence = BAND_HIGH;
  } else {
    confidence = BAND_MID;
    warnings.push(WARN_INCOMPLETE);
  }

  return { unitPrice: { per100ml, formula }, confidence, warnings };
}
