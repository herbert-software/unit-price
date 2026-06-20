// Pure search-term normalization, extracted from SearchEntry so the codepoint-based
// length gate + truncation are unit-testable without the Taro component runtime.
//
// Length boundaries are measured in Unicode CODE POINTS (`[...s]`), NOT UTF-16
// `.length`: UTF-16 counts an emoji / rare CJK (`𠮷`) as 2, which would mis-trigger
// the gate and split a surrogate pair on `.slice`. Same code-point discipline as the
// server, so URL / board title / actual filter term stay consistent.
export const SEARCH_MAX_CODEPOINTS = 64;
export const SEARCH_MIN_CODEPOINTS = 2;

export type SearchTermResult =
  | { kind: 'empty' } // trim → length 0: no intent, do nothing (no nav, no request)
  | { kind: 'too-short' } // length 1: intent but too wide (server 400 parity) — hint, no nav
  | { kind: 'ok'; term: string }; // length ≥ 2: code-point-truncated term, ready to navigate

/** Normalize a raw search input: trim, measure by code points, truncate to 64. */
export function normalizeSearchTerm(raw: string): SearchTermResult {
  const trimmed = raw.trim();
  const cps = [...trimmed];
  if (cps.length === 0) return { kind: 'empty' };
  if (cps.length < SEARCH_MIN_CODEPOINTS) return { kind: 'too-short' };
  // Truncate to ≤ 64 code points (never splits a surrogate pair, unlike .slice on
  // the raw string) so the encoded URL, board title, and server filter all agree.
  return { kind: 'ok', term: cps.slice(0, SEARCH_MAX_CODEPOINTS).join('') };
}
