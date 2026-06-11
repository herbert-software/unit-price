// tier3 calculator. Pure, no IO. Computes the per-axis unit price (per100ml for
// the volume axis XOR per100g for the weight axis) + canonical formula, applies
// the unified uncomputable terminal state, the consistency gate, and the single
// authoritative confidence banding.
import { checkConsistency, multiplierOf } from './consistency.js';
import {
  hasUnitSizeAndQuantity,
  hasUsableTotalAmount,
  meetsComputeRequiredSet,
  meetsFullSpecSet,
} from './tiers.js';
import type { Measurement, ParsedSpec, UnitPrice } from './types.js';
import { isVolumeUnit, isWeightUnit, toGrams, toMl } from './units.js';

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

const WARN_NO_AXIS = '无法识别容量或重量单位，无法计算单价';
const WARN_NO_TOTAL = '无法确定总量，无法计算单价';
const WARN_BAD_PRICE = '价格无效（非正或非有限），无法计算单价';
const WARN_INCONSISTENT = '规格不一致，总量不可信，已抑制单价';
const WARN_INCOMPLETE = '规格不完整，未校验自洽性';

/** Axis descriptor: conversion fn + per100 field key. Volume XOR weight. */
type Axis = 'volume' | 'weight';

interface AxisOps {
  /** Convert a same-axis measurement to its base unit, or null off-axis. */
  toBase: (m: Measurement) => number | null;
  /** True if the unit is on this axis. */
  isAxisUnit: (unit: Measurement['unit']) => boolean;
  /** Which UnitPrice field this axis populates. */
  per100Key: 'per100ml' | 'per100g';
}

const AXIS_OPS: Record<Axis, AxisOps> = {
  volume: { toBase: toMl, isAxisUnit: isVolumeUnit, per100Key: 'per100ml' },
  weight: { toBase: toGrams, isAxisUnit: isWeightUnit, per100Key: 'per100g' },
};

/**
 * Resolve the product's axis from a single source: prefer `totalAmount.unit`,
 * else `unitSize.unit`. Returns the axis or null (no size / unknown unit). The
 * single source prevents cross-axis mixing (per100ml/per100g exactly-one
 * invariant downstream).
 */
function axisOf(spec: ParsedSpec): Axis | null {
  const source = spec.totalAmount ?? spec.unitSize;
  if (source === null || source === undefined) return null;
  if (isVolumeUnit(source.unit)) return 'volume';
  if (isWeightUnit(source.unit)) return 'weight';
  return null;
}

/** Uncomputable terminal state: both axes null, no formula, warning, low conf. */
function uncomputable(warning: string): CalcResult {
  return {
    unitPrice: { per100ml: null, per100g: null, formula: null },
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
 * tier3 entry. Computes the per-axis unit price from the final (merged) spec +
 * price, or routes to the unified uncomputable terminal state. Never emits
 * NaN/Infinity.
 */
export function calculate(spec: ParsedSpec, price: number): CalcResult {
  // price guard.
  if (!(price > 0)) {
    return uncomputable(WARN_BAD_PRICE);
  }

  // Axis dispatch from a single source. No axis (no size / unknown unit) ->
  // uncomputable (both axes null).
  const axis = axisOf(spec);
  if (axis === null) {
    return uncomputable(WARN_NO_AXIS);
  }
  const ops = AXIS_OPS[axis];

  // Presence-level computability (compute-required set, no consistency yet).
  if (!meetsComputeRequiredSet(spec, price)) {
    return uncomputable(WARN_NO_TOTAL);
  }

  // Consistency gate (independent of the compute-required set).
  const consistency = checkConsistency(spec);
  if (consistency.kind === 'inconsistent') {
    return uncomputable(WARN_INCONSISTENT);
  }

  // Compute total in axis base. Prefer explicit total; else derive from
  // unitSize*qty*mult.
  const total = spec.totalAmount;
  const explicitTotalUsable = hasUsableTotalAmount(spec);
  const unitSize = spec.unitSize;
  let totalBase: number | null = null;
  if (explicitTotalUsable && total) {
    totalBase = ops.toBase(total);
  } else if (hasUnitSizeAndQuantity(spec) && unitSize && spec.quantity != null) {
    const unitSizeBase = ops.toBase(unitSize);
    if (unitSizeBase !== null) {
      totalBase = unitSizeBase * spec.quantity * multiplierOf(spec);
    }
  }

  // Defensive: no usable, finite, positive total -> uncomputable.
  if (totalBase === null || !Number.isFinite(totalBase) || totalBase <= 0) {
    return uncomputable(WARN_NO_TOTAL);
  }

  const per100 = (price / totalBase) * 100;
  if (!Number.isFinite(per100)) {
    return uncomputable(WARN_NO_TOTAL);
  }

  // Canonical formula: expanded form when unitSize/quantity known, else
  // contracted form. Always uses axis-base-converted values.
  let formula: string;
  const useExpanded =
    hasUnitSizeAndQuantity(spec) && unitSize !== null && unitSize !== undefined;
  if (useExpanded && unitSize) {
    const unitSizeBase = ops.toBase(unitSize);
    if (unitSizeBase !== null && spec.quantity != null) {
      formula = `${fmt(price)} / (${fmt(unitSizeBase)} * ${fmt(spec.quantity)} * ${fmt(
        multiplierOf(spec),
      )}) * 100`;
    } else {
      formula = `${fmt(price)} / ${fmt(totalBase)} * 100`;
    }
  } else {
    formula = `${fmt(price)} / ${fmt(totalBase)} * 100`;
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

  // Exactly one axis field is non-null; the other stays null.
  const unitPrice: UnitPrice = { per100ml: null, per100g: null, formula };
  unitPrice[ops.per100Key] = per100;

  return { unitPrice, confidence, warnings };
}
