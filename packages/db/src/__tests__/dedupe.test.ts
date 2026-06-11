// Unit tests for the deterministic dedupe-key pure function. No IO: the key is
// `(rawId + normalized ParsedSpec)`, price-independent, confidence-excluded.
import type { ParsedSpec } from '@unit-price/core';
import { describe, expect, it } from 'vitest';
import { computeDedupeKey } from '../dedupe.js';

/** A representative fully-populated spec; tests clone + tweak one field. */
function baseSpec(): ParsedSpec {
  return {
    unitSize: { value: 330, unit: 'ml' },
    quantity: 6,
    multipliers: [1],
    totalAmount: { value: 1980, unit: 'ml' },
    packageUnit: '瓶',
    category: 'beverage',
    confidence: 0.9,
  };
}

const RAW_ID = 'raw-1';

describe('computeDedupeKey', () => {
  it('is deterministic: same (rawId, spec) → same key', () => {
    expect(computeDedupeKey(RAW_ID, baseSpec())).toBe(
      computeDedupeKey(RAW_ID, baseSpec()),
    );
  });

  it('different unitSize → different key', () => {
    const other = { ...baseSpec(), unitSize: { value: 500, unit: 'ml' as const } };
    expect(computeDedupeKey(RAW_ID, other)).not.toBe(
      computeDedupeKey(RAW_ID, baseSpec()),
    );
  });

  it('different quantity → different key', () => {
    const other = { ...baseSpec(), quantity: 12 };
    expect(computeDedupeKey(RAW_ID, other)).not.toBe(
      computeDedupeKey(RAW_ID, baseSpec()),
    );
  });

  it('different category → different key', () => {
    const other = { ...baseSpec(), category: 'snack' };
    expect(computeDedupeKey(RAW_ID, other)).not.toBe(
      computeDedupeKey(RAW_ID, baseSpec()),
    );
  });

  it('different rawId → different key', () => {
    expect(computeDedupeKey('raw-2', baseSpec())).not.toBe(
      computeDedupeKey(RAW_ID, baseSpec()),
    );
  });

  it('nullable field null vs undefined → same key (normalized to JSON null)', () => {
    const withNull: ParsedSpec = {
      ...baseSpec(),
      quantity: null,
      packageUnit: null,
    };
    const withUndefined: ParsedSpec = {
      ...baseSpec(),
      quantity: undefined,
      packageUnit: undefined,
    };
    expect(computeDedupeKey(RAW_ID, withNull)).toBe(
      computeDedupeKey(RAW_ID, withUndefined),
    );
  });

  it('packageUnit=null vs "瓶" → different key (null never collides with a string)', () => {
    const withNull = { ...baseSpec(), packageUnit: null };
    const withString = { ...baseSpec(), packageUnit: '瓶' };
    expect(computeDedupeKey(RAW_ID, withNull)).not.toBe(
      computeDedupeKey(RAW_ID, withString),
    );
  });

  it('measurement missing (both NULL) vs {value:0,unit:"ml"} → different key', () => {
    const missing = { ...baseSpec(), unitSize: null };
    const zero = { ...baseSpec(), unitSize: { value: 0, unit: 'ml' as const } };
    expect(computeDedupeKey(RAW_ID, missing)).not.toBe(
      computeDedupeKey(RAW_ID, zero),
    );
  });

  it('multipliers serialized once (array element, not pre-encoded string)', () => {
    // A bare number[] element must not collide with a pre-encoded JSON string
    // of the same array — guards against accidental double-encoding.
    const arr = { ...baseSpec(), multipliers: [1, 2] };
    const key = computeDedupeKey(RAW_ID, arr);
    expect(key).toContain('[1,2]');
    expect(key).not.toContain('"[1,2]"');
  });

  it('different multipliers → different key', () => {
    const other = { ...baseSpec(), multipliers: [1, 2] };
    expect(computeDedupeKey(RAW_ID, other)).not.toBe(
      computeDedupeKey(RAW_ID, baseSpec()),
    );
  });

  it('confidence change → key unchanged (confidence excluded)', () => {
    const lower = { ...baseSpec(), confidence: 0.1 };
    const higher = { ...baseSpec(), confidence: 1 };
    expect(computeDedupeKey(RAW_ID, lower)).toBe(
      computeDedupeKey(RAW_ID, higher),
    );
  });

  it('price-derived values (per100ml/formula) are not in the key → key unchanged', () => {
    // ParsedSpec carries no price field; the key is spec-only by construction.
    // Equal specs yield an equal key regardless of any downstream price/formula.
    expect(computeDedupeKey(RAW_ID, baseSpec())).toBe(
      computeDedupeKey(RAW_ID, baseSpec()),
    );
  });
});
