// Deterministic in-list ad-slot insertion rule (pure — no DOM, no Taro).
// Kept separate from the page component so the placement logic can be unit
// tested without a renderer (the `height===0` visual collapse is a SEPARATE
// concern, verified against a real layout source — see AdSlot.tsx).
//
// Rule (per the miniapp spec "前 10 条无广告、之后每 12 条一个插入点"):
//   - The first 10 rendered rows (render rank ≤ 10) carry NO ad slot between
//     them — that whole segment has zero ad-slot DOM.
//   - From the 10th row onward an insertion point sits AFTER every 12th row:
//     after render rank 10, 22, 34, … (i.e. ranks ≡ 10 (mod 12) and ≥ 10).
//
// `rank` here is the 1-based RENDER position of a row in the flattened list
// (matches RankingsItem.rank, which the server assigns as offset + index). The
// rule is expressed on render position so it is stable across pages.

const FIRST_AD_AFTER_RANK = 10; // no slot within ranks 1..10
const AD_EVERY = 12; // then one slot after every 12th row

/**
 * Does an ad-slot insertion point belong immediately AFTER the row at the given
 * 1-based render `rank`? True for rank 10, 22, 34, … only.
 */
export function isAdSlotAfterRank(rank: number): boolean {
  if (!Number.isInteger(rank) || rank < FIRST_AD_AFTER_RANK) return false;
  return (rank - FIRST_AD_AFTER_RANK) % AD_EVERY === 0;
}

/**
 * Given a count of rendered rows, return the render ranks AFTER which an ad slot
 * is inserted (10, 22, 34, … up to `rowCount`). Empty for rowCount < 10. Pure
 * helper used by tests and (optionally) the renderer to reason about placement.
 */
export function adSlotRanks(rowCount: number): number[] {
  const ranks: number[] = [];
  for (let r = FIRST_AD_AFTER_RANK; r <= rowCount; r += AD_EVERY) {
    ranks.push(r);
  }
  return ranks;
}

export const AD_SLOT_CONSTANTS = { FIRST_AD_AFTER_RANK, AD_EVERY } as const;
