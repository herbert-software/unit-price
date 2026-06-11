// Convergence/dedupe-key construction for `product` rows.
//
// `dedupe_key` is a provenance/convergence column (like `raw_id`), not a domain
// field — it never enters `ParsedSpec`. The key is `(rawId + normalized
// ParsedSpec)` and is deliberately price-independent: it derives only from the
// parse-result structure, never from `per100ml`/`formula` or any `unit_price`
// column. `ParsedSpec.confidence` is also excluded — it is an intermediate
// parse confidence, not part of the result structure, so the same rawId+spec
// with a different confidence is the same product (keep oldest), not a new row.
//
// To avoid drift between the key and the stored column values, measurement and
// JSON serialization MUST reuse the storage codecs directly rather than
// re-implementing equivalent serialization.
import type { ParsedSpec } from '@unit-price/core';
import { encodeJson, encodeMeasurement } from './codec.js';

/**
 * Deterministic, pure (no IO) dedupe-key for a `product` row.
 *
 * The key is the whole-array `encodeJson` of a fixed-order tuple. Measurement
 * fields go through `encodeMeasurement` (same split as the stored columns);
 * `multipliers` (a `number[]`) is placed directly into the outer array so the
 * outer `encodeJson` serializes it once (no pre-encoding / double-encoding).
 * Nullable bare fields pass their raw value or `null` — `null`/`undefined` are
 * normalized to JSON `null`. No string sentinels: JSON distinguishes
 * `null`/number/string, so a structural `null` never collides with a real
 * string (e.g. `packageUnit=null` vs `"瓶"`) or number.
 */
export function computeDedupeKey(rawId: string, spec: ParsedSpec): string {
  return encodeJson([
    rawId,
    encodeMeasurement(spec.unitSize),
    spec.quantity ?? null,
    encodeMeasurement(spec.totalAmount),
    spec.category,
    spec.multipliers,
    spec.packageUnit ?? null,
  ]);
}
