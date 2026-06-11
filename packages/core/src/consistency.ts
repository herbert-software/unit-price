// Spec consistency check (tolerance + missing-field third state). Pure, no IO.
import type { Measurement, ParsedSpec } from './types.js';
import { isVolumeUnit, isWeightUnit, toGrams, toMl } from './units.js';

/**
 * Convert a measurement to its axis base unit (volume -> ml, weight -> g), or
 * null if the unit is on neither axis. Used so consistency compares both sides
 * within the same axis.
 */
function toAxisBase(m: Measurement): number | null {
  if (isVolumeUnit(m.unit)) return toMl(m);
  if (isWeightUnit(m.unit)) return toGrams(m);
  return null;
}

export type ConsistencyResult =
  | { kind: 'consistent' } // unitSize & quantity present, equation holds
  | { kind: 'inconsistent' } // unitSize & quantity present, equation fails
  | { kind: 'skipped' }; // unitSize or quantity missing — no equation to check

/** Relative tolerance, with the larger side as the basis to avoid masking. */
const REL_TOL = 1e-6;

/** product(multipliers); this change is always [1]. */
export function multiplierOf(spec: ParsedSpec): number {
  return spec.multipliers.reduce((acc, m) => acc * m, 1);
}

/**
 * When both unitSize and quantity are present, verify the total is self-
 * consistent within the product's axis: abs(totalBase - unitSizeBase*quantity*
 * multiplier) <= 1e-6 * max(...), where base is ml (volume axis) or g (weight
 * axis). This is axis-agnostic — a weight full-spec self-consistent product is
 * judged 'consistent' just like a volume one. Missing unitSize/quantity ->
 * 'skipped' (a third state, distinct from 'inconsistent'). If totalAmount is
 * absent, or unitSize/totalAmount are cross-axis, it is also 'skipped'.
 */
export function checkConsistency(spec: ParsedSpec): ConsistencyResult {
  const { unitSize, quantity, totalAmount } = spec;
  if (
    unitSize === null ||
    unitSize === undefined ||
    quantity === null ||
    quantity === undefined
  ) {
    return { kind: 'skipped' };
  }
  if (totalAmount === null || totalAmount === undefined) {
    // No equation to check against; treat as skipped (relies on derived total).
    return { kind: 'skipped' };
  }

  // Convert both sides to their axis base (volume -> ml, weight -> g). Units on
  // neither axis, or a cross-axis pairing (unitSize volume vs totalAmount
  // weight, or vice versa), cannot form a same-axis equation; defer to the
  // 'skipped' third state rather than asserting (in)consistency here.
  const sameAxis =
    (isVolumeUnit(unitSize.unit) && isVolumeUnit(totalAmount.unit)) ||
    (isWeightUnit(unitSize.unit) && isWeightUnit(totalAmount.unit));
  if (!sameAxis) {
    return { kind: 'skipped' };
  }
  const unitSizeBase = toAxisBase(unitSize);
  const totalBase = toAxisBase(totalAmount);
  if (unitSizeBase === null || totalBase === null) {
    return { kind: 'skipped' };
  }

  const expected = unitSizeBase * quantity * multiplierOf(spec);
  const diff = Math.abs(totalBase - expected);
  const basis = Math.max(totalBase, expected);
  if (diff <= REL_TOL * basis) {
    return { kind: 'consistent' };
  }
  return { kind: 'inconsistent' };
}
