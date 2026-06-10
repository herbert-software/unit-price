// Storage codecs for the repository layer: scale/encode domain values into
// SQLite↔Postgres-portable columns and back.
//
// These are storage-calibration encodings only (cents↔yuan scaling, JSON-text,
// measurement column split, epoch timestamps) — never domain computation.
// Prices, unit conversion and comparability decisions all come from
// @unit-price/core; Zod validation is applied to decoded domain objects,
// never to the encoded JSON strings.
import type { Measurement } from '@unit-price/core';

/** App-generated TEXT primary key (UUID v4) — portable, no central sequence. */
export function newId(): string {
  return crypto.randomUUID();
}

/**
 * Encode a yuan amount as exact integer cents. Always `Math.round` — never
 * trunc/floor: `0.29 * 100 === 28.999…` in float64, truncation would lose a
 * cent (28 instead of 29).
 */
export function yuanToCents(yuan: number): number {
  if (!Number.isFinite(yuan)) {
    throw new Error(`cannot encode non-finite price as cents: ${yuan}`);
  }
  const cents = Math.round(yuan * 100);
  // A finite yuan ×100 can still overflow to Infinity or exceed the safe-integer
  // range; exact integer cents require the rounded result to be a safe integer.
  if (!Number.isSafeInteger(cents)) {
    throw new Error(`price out of exact integer-cents range: ${yuan}`);
  }
  return cents;
}

/** Decode integer cents back to yuan. */
export function centsToYuan(cents: number): number {
  return cents / 100;
}

/** Column pair for a split `Measurement` (`*_value` REAL + `*_unit` TEXT). */
export interface MeasurementColumns {
  value: number | null;
  unit: string | null;
}

/** Split a Measurement into its column pair; missing/null → both NULL. */
export function encodeMeasurement(
  measurement: Measurement | null | undefined,
): MeasurementColumns {
  if (measurement == null) {
    return { value: null, unit: null };
  }
  return { value: measurement.value, unit: measurement.unit };
}

/**
 * Rebuild a measurement-shaped object from its column pair (both NULL → null).
 * Returns a loose shape on purpose: the caller validates the decoded domain
 * object with the core Zod schema (which checks the unit enum).
 */
export function decodeMeasurement(
  value: number | null,
  unit: string | null,
): { value: number; unit: string } | null {
  if (value === null && unit === null) {
    return null;
  }
  if (value === null || unit === null) {
    throw new Error(
      'corrupt measurement columns: value and unit must be both set or both NULL',
    );
  }
  return { value, unit };
}

/**
 * Encode a JSON payload (arrays, corrected_spec) into a JSON-text column.
 * Non-finite numbers throw instead of silently becoming JSON `null` —
 * defense in depth behind the repository's finite-number gates, catching
 * any write path that bypasses them.
 */
export function encodeJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === 'number' && !Number.isFinite(v)) {
      throw new Error(`cannot encode non-finite number as JSON-text: ${v}`);
    }
    return v;
  });
}

/** Decode a JSON-text column back into a value (Zod-validate afterwards). */
export function decodeJson(text: string): unknown {
  return JSON.parse(text);
}

/** Normalize a Date or epoch-milliseconds number to epoch milliseconds. */
export function toEpochMillis(input: number | Date): number {
  const millis = input instanceof Date ? input.getTime() : input;
  if (!Number.isSafeInteger(millis)) {
    throw new Error(
      `invalid timestamp: expected safe-integer epoch milliseconds, got ${millis}`,
    );
  }
  return millis;
}
