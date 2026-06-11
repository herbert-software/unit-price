// Single definition of the field tiers, referenced by tier3 computability,
// confidence banding, and (downstream) API HTTP status. Pure, no IO.
//
// - Compute-required set (presence only, NO consistency): a `totalAmount` whose
//   unit falls on some axis (volume {ml,L} OR weight {g,kg}) with value > 0, OR
//   `unitSize` + `quantity` (from which a same-axis totalAmount can be derived);
//   plus `price > 0`.
// - Full-spec set (presence only): `unitSize` + `quantity` + `totalAmount`
//   all present.
// - Consistency gate is independent (see consistency.ts).
import type { ParsedSpec, Unit } from './types.js';
import { isVolumeUnit, isWeightUnit } from './units.js';

/** True if `unit` falls on a computable axis (volume {ml,L} or weight {g,kg}). */
function isAxisUnit(unit: Unit): boolean {
  return isVolumeUnit(unit) || isWeightUnit(unit);
}

function hasMeasurement(m: ParsedSpec['unitSize']): boolean {
  return m !== null && m !== undefined;
}

function hasQuantity(q: ParsedSpec['quantity']): boolean {
  return q !== null && q !== undefined;
}

/** True if a totalAmount on some axis (volume or weight) with value > 0 is present. */
export function hasUsableTotalAmount(spec: ParsedSpec): boolean {
  const t = spec.totalAmount;
  return t !== null && t !== undefined && isAxisUnit(t.unit) && t.value > 0;
}

/** True if both unitSize and quantity are present (totalAmount derivable). */
export function hasUnitSizeAndQuantity(spec: ParsedSpec): boolean {
  return hasMeasurement(spec.unitSize) && hasQuantity(spec.quantity);
}

/**
 * Compute-required set: presence-only check (no consistency) plus price > 0.
 * Note: when only unitSize+quantity are present, the unitSize must fall on an
 * axis (volume or weight) for a per100ml/per100g to be derivable.
 */
export function meetsComputeRequiredSet(spec: ParsedSpec, price: number): boolean {
  if (price <= 0) return false;
  if (hasUsableTotalAmount(spec)) return true;
  if (hasUnitSizeAndQuantity(spec)) {
    const u = spec.unitSize;
    const q = spec.quantity;
    if (u && q !== null && q !== undefined && isAxisUnit(u.unit) && u.value > 0 && q > 0) {
      return true;
    }
  }
  return false;
}

/** Full-spec set: unitSize + quantity + totalAmount all present. */
export function meetsFullSpecSet(spec: ParsedSpec): boolean {
  return (
    hasMeasurement(spec.unitSize) &&
    hasQuantity(spec.quantity) &&
    spec.totalAmount !== null &&
    spec.totalAmount !== undefined
  );
}
