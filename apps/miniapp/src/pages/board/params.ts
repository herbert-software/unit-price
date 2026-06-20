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

// Two route-param paths with DIFFERENT decode contracts:
//
//   name (分类下钻): a FIXED CJK taxonomy name — no literal `%`/`+`. WeChat's
//   onLoad(options) URL-decodes query values once, so an already-decoded CJK name
//   would make a second decodeURIComponent throw on any literal `%`. We can't pin
//   Taro 4.2's exact decode behavior from here, so decode-once-with-raw-fallback is
//   correct whether Taro hands back a decoded or a raw value, never crashes, and is
//   harmless for fixed CJK (idempotent). The name path is UNCHANGED.
//   ponytail: a URL round-trip can't tell a literal `%XX` from an encoded one — fine
//   for the fixed CJK category taxonomy (no `%`/`+`); revisit if names gain them.
//
//   q (搜索): FREE TEXT that may contain a literal `%NN` (e.g. `100%20纯` / `a%20b`).
//   The try-decode-catch-raw fallback only fires when decodeURIComponent THROWS — it
//   is useless for "decoded successfully but WRONG" (`%20` silently folded to a
//   space). So q must NOT reuse that fallback; its decode count is pinned
//   DETERMINISTICALLY (exactly 1 end-to-end: SearchEntry encodes once → exactly one
//   decode restores it).
//   ponytail: assumes Taro onLoad decodes query once (per the comment above); task
//   5.3 must confirm on a real device. If onLoad decodes 0×, change q to a single
//   decodeURIComponent here.
export function readBoardParams(p: { category?: string; name?: string; q?: string }): BoardParams {
  const category = p.category || undefined;

  // q: under "onLoad decodes once", the value here is ALREADY the original term
  // (SearchEntry did ONE encodeURIComponent → onLoad decoded it once). Use it AS-IS;
  // do NOT decode again (would double-decode `100%20纯` → `100 纯`) and do NOT apply
  // the name fallback (it cannot detect a successful-but-wrong decode).
  const q = p.q || undefined;

  // name path: unchanged decode-once-with-raw-fallback for the fixed CJK taxonomy.
  const rawName = p.name;
  let decodedName: string | undefined;
  if (rawName) {
    try {
      decodedName = decodeURIComponent(rawName);
    } catch {
      decodedName = rawName;
    }
  }

  return { category, q, name: deriveBoardTitle(q, decodedName) };
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
