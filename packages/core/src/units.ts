// Unit conversion table + alias normalization. Pure, no IO.
//
// Volume aliases normalize to the canonical symbols `ml`/`L` WITHOUT crossing
// the ml<->L boundary at parse time (`升` -> `L`, `毫升`/`mL` -> `ml`). The
// ml<->L conversion only happens here, inside unit-price-calc, via `toMl`.
// Weight aliases normalize to `g`/`kg` (`斤` => 500g) WITHOUT crossing the
// g<->kg boundary at parse time (`千克`/`公斤` -> `kg`, `克` -> `g`). The
// g<->kg conversion only happens here, inside unit-price-calc, via `toGrams`.
// Weight units feed the weight axis (per100g); they never enter per100ml. The
// two axes are independent — no density conversion (g<->ml) is ever performed.
import type { Measurement, Unit } from './types.js';

/** Canonical conversion factors to a base within each dimension. */
const TO_BASE: Record<Unit, number> = {
  ml: 1, // base: ml
  L: 1000, // 1L = 1000ml
  g: 1, // base: g
  kg: 1000, // 1kg = 1000g
};

/** Volume units that can be converted to ml (and thus participate in calc). */
export const VOLUME_UNITS: ReadonlySet<Unit> = new Set<Unit>(['ml', 'L']);

/** Weight units that can be converted to grams (and thus participate in calc). */
export const WEIGHT_UNITS: ReadonlySet<Unit> = new Set<Unit>(['g', 'kg']);

export function isVolumeUnit(unit: Unit): boolean {
  return VOLUME_UNITS.has(unit);
}

export function isWeightUnit(unit: Unit): boolean {
  return WEIGHT_UNITS.has(unit);
}

/**
 * Alias -> canonical unit. `斤` is special (1斤 = 500g) and handled in
 * `normalizeMeasurement`; this map only covers 1:1 symbol normalization.
 */
const UNIT_ALIASES: Record<string, Unit> = {
  ml: 'ml',
  mL: 'ml',
  ML: 'ml',
  毫升: 'ml',
  l: 'L',
  L: 'L',
  升: 'L',
  g: 'g',
  G: 'g',
  克: 'g',
  kg: 'kg',
  KG: 'kg',
  Kg: 'kg',
  公斤: 'kg',
  千克: 'kg',
};

/** Package-unit aliases -> canonical packageUnit enum (e.g. `can`/`bottle`). */
const PACKAGE_UNIT_ALIASES: Record<string, string> = {
  听: 'can',
  罐: 'can',
  瓶: 'bottle',
  盒: 'box',
  袋: 'bag',
};

/** Normalize a raw unit token to a canonical `Unit`, or null if unknown. */
export function normalizeUnitToken(token: string): Unit | null {
  return UNIT_ALIASES[token] ?? null;
}

/** Normalize a raw package token (听/罐/瓶...) to canonical packageUnit. */
export function normalizePackageUnit(token: string): string | null {
  return PACKAGE_UNIT_ALIASES[token] ?? null;
}

/**
 * Build a normalized Measurement from a raw value + raw unit token.
 * `斤` folds to grams (value * 500). Returns null if the unit is unknown.
 */
export function normalizeMeasurement(value: number, unitToken: string): Measurement | null {
  if (unitToken === '斤') {
    return { value: value * 500, unit: 'g' };
  }
  const unit = normalizeUnitToken(unitToken);
  if (unit === null) return null;
  return { value, unit };
}

/**
 * Convert a volume Measurement to ml. Returns null for weight units
 * (per100ml is undefined for weight) — callers treat null as uncomputable.
 */
export function toMl(m: Measurement): number | null {
  if (!isVolumeUnit(m.unit)) return null;
  return m.value * TO_BASE[m.unit];
}

/**
 * Convert a weight Measurement to grams. Returns null for volume units
 * (per100g is undefined for volume) — callers treat null as uncomputable.
 * Mirrors `toMl`; reuses the same `TO_BASE` factors (`g:1`, `kg:1000`).
 */
export function toGrams(m: Measurement): number | null {
  if (!isWeightUnit(m.unit)) return null;
  return m.value * TO_BASE[m.unit];
}
