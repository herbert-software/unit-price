// Pure route-param reading for the board, extracted so the decode + title branches
// are unit-testable without the Taro runtime (the page itself can't run under vitest).
export interface BoardParams {
  /** Cohort slug, or undefined for the un-scoped list (missing / blank route). */
  category: string | undefined;
  /** Decoded free-text search term, or undefined when not a search entry. */
  q: string | undefined;
  /** Display title for setNavigationBarTitle (already derived by precedence). */
  name: string;
}

// Real-device measurement (task 5.3): Taro 4.2 / WeChat hands route values to
// useRouter().params RAW — it does NOT decode the query. So both the fixed-CJK `name`
// (分类下钻) and the free-text `q` (搜索, encodeURIComponent'd once by SearchEntry)
// arrive still-encoded and each needs exactly ONE decode here.
//
// decode-once-with-raw-fallback: decodeURIComponent only throws on a malformed escape
// (e.g. a hand-typed `?q=100%`), so fall back to the raw value then. For values that
// came through encodeURIComponent (the only real entry path) it is exactly the inverse;
// the fallback just keeps a hand-typed malformed route from crashing onLoad.
function decodeOnce(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

export function readBoardParams(p: { category?: string; name?: string; q?: string }): BoardParams {
  const category = p.category || undefined;
  const q = p.q ? decodeOnce(p.q) : undefined;
  const name = p.name ? decodeOnce(p.name) : undefined;
  return { category, q, name: deriveBoardTitle(q, name) };
}

// Title precedence (judged on the DECODED, non-empty q — NOT on q-key presence, so a
// hand-typed `?q=` does not surface an empty "搜索："):
//   decoded q (trim non-empty) ? `搜索：<decoded q>` : (name ?? `分类榜`)
export function deriveBoardTitle(q: string | undefined, name: string | undefined): string {
  if (q !== undefined && q.trim() !== '') {
    return `搜索：${q}`;
  }
  return name ?? '分类榜';
}
