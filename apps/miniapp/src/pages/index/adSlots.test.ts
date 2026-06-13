// Pure unit test for the deterministic ad-slot INSERTION rule. This covers the
// sharpened spec assertion ①: the first-10-rows segment has NO insertion point,
// and from row 10 onward a slot sits after render rank 10/22/34/…
//
// (Assertion ② — the mounted slot's height===0 — is a VISUAL check that needs a
// real layout source; it is NOT done here. jsdom's getBoundingClientRect always
// returns 0 and would false-green it, so height===0 is deferred to the WeChat
// devtools manual verification step (5.2), measured via Taro.createSelectorQuery
// boundingClientRect. See the returned report for the rationale.)
import { describe, it, expect } from 'vitest';
import { isAdSlotAfterRank, adSlotRanks } from './adSlots';

describe('isAdSlotAfterRank', () => {
  it('no insertion point within the first 10 rows (ranks 1..10 except 10)', () => {
    for (let rank = 1; rank <= 9; rank++) {
      expect(isAdSlotAfterRank(rank)).toBe(false);
    }
  });

  it('first insertion point is AFTER render rank 10', () => {
    expect(isAdSlotAfterRank(10)).toBe(true);
  });

  it('then one insertion point every 12 rows: 10, 22, 34, 46, …', () => {
    expect(isAdSlotAfterRank(22)).toBe(true);
    expect(isAdSlotAfterRank(34)).toBe(true);
    expect(isAdSlotAfterRank(46)).toBe(true);
  });

  it('rows between insertion points carry no slot', () => {
    for (const rank of [11, 12, 15, 21, 23, 33, 35]) {
      expect(isAdSlotAfterRank(rank)).toBe(false);
    }
  });

  it('rejects non-positive / non-integer ranks', () => {
    expect(isAdSlotAfterRank(0)).toBe(false);
    expect(isAdSlotAfterRank(-12)).toBe(false);
    expect(isAdSlotAfterRank(10.5)).toBe(false);
  });
});

describe('adSlotRanks', () => {
  it('is empty for fewer than 10 rows (first-10 segment has zero ad DOM)', () => {
    expect(adSlotRanks(0)).toEqual([]);
    expect(adSlotRanks(9)).toEqual([]);
  });

  it('includes rank 10 once the 10th row is rendered', () => {
    expect(adSlotRanks(10)).toEqual([10]);
    expect(adSlotRanks(11)).toEqual([10]);
    expect(adSlotRanks(21)).toEqual([10]);
  });

  it('adds the next insertion point at rank 22, then 34, …', () => {
    expect(adSlotRanks(22)).toEqual([10, 22]);
    expect(adSlotRanks(34)).toEqual([10, 22, 34]);
    expect(adSlotRanks(50)).toEqual([10, 22, 34, 46]);
  });
});
