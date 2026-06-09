// Single definition of the field tiers, referenced by tier3 computability,
// confidence banding, and (downstream) API HTTP status. Pure, no IO.
//
// - Compute-required set (presence only, NO consistency): a `totalAmount`
//   with volume unit and value > 0, OR `unitSize` + `quantity` (from which a
//   totalAmount can be derived); plus `price > 0`.
// - Full-spec set (presence only): `unitSize` + `quantity` + `totalAmount`
//   all present.
// - Consistency gate is independent (see consistency.ts).
import type { ParsedSpec } from './types.js';
import { isVolumeUnit } from './units.js';

function hasMeasurement(m: ParsedSpec['unitSize']): boolean {
  return m !== null && m !== undefined;
}

function hasQuantity(q: ParsedSpec['quantity']): boolean {
  return q !== null && q !== undefined;
}

/** True if a volume totalAmount with value > 0 is present. */
export function hasUsableTotalAmount(spec: ParsedSpec): boolean {
  const t = spec.totalAmount;
  return t !== null && t !== undefined && isVolumeUnit(t.unit) && t.value > 0;
}

/** True if both unitSize and quantity are present (totalAmount derivable). */
export function hasUnitSizeAndQuantity(spec: ParsedSpec): boolean {
  return hasMeasurement(spec.unitSize) && hasQuantity(spec.quantity);
}

/**
 * Compute-required set: presence-only check (no consistency) plus price > 0.
 * Note: when only unitSize+quantity are present, the unitSize must be a volume
 * unit for a per100ml to be derivable.
 */
export function meetsComputeRequiredSet(spec: ParsedSpec, price: number): boolean {
  if (price <= 0) return false;
  if (hasUsableTotalAmount(spec)) return true;
  if (hasUnitSizeAndQuantity(spec)) {
    const u = spec.unitSize;
    const q = spec.quantity;
    if (u && q !== null && q !== undefined && isVolumeUnit(u.unit) && u.value > 0 && q > 0) {
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
