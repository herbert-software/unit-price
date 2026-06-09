// Spec consistency check (tolerance + missing-field third state). Pure, no IO.
import type { ParsedSpec } from './types.js';
import { toMl } from './units.js';

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
 * consistent: abs(totalMl - unitSizeMl*quantity*multiplier)
 *   <= 1e-6 * max(totalMl, unitSizeMl*quantity*multiplier).
 * Missing unitSize/quantity -> 'skipped' (a third state, distinct from
 * 'inconsistent'). If totalAmount is absent, there is nothing to compare
 * against, so it is also 'skipped'.
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

  const unitSizeMl = toMl(unitSize);
  const totalMl = toMl(totalAmount);
  // Non-volume units cannot be compared in ml space; defer to the
  // uncomputable terminal state rather than asserting (in)consistency here.
  if (unitSizeMl === null || totalMl === null) {
    return { kind: 'skipped' };
  }

  const expected = unitSizeMl * quantity * multiplierOf(spec);
  const diff = Math.abs(totalMl - expected);
  const basis = Math.max(totalMl, expected);
  if (diff <= REL_TOL * basis) {
    return { kind: 'consistent' };
  }
  return { kind: 'inconsistent' };
}
