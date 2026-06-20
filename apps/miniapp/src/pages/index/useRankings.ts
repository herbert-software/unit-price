// Rankings data layer + paginated state machine for the read-only list screen.
//
// Transport: Taro.request (WeChat has no fetch). URL is built by api-client's
// buildRankingsUrl and the response body is validated by parseRankingsResponse
// (a throw → ZodError or network error → the relevant error state). The miniapp
// NEVER hand-rolls the response type or skips validation.
//
// State machine distinguishes the two error positions the spec mandates:
//   - FIRST-SCREEN error (initial load fails OR parse throws, list still empty)
//     → whole-screen error + retry. Modeled as phase==='error' with items===[].
//   - PAGE error (a next page fails while a list is already loaded) → KEEP the
//     loaded list, expose a per-page local retry. Modeled as pageError===true
//     with items preserved; NEVER clears items back to a whole-screen error.
import { useCallback, useRef, useState } from 'react';
import Taro from '@tarojs/taro';
import {
  buildRankingsUrl,
  parseRankingsResponse,
  type RankingsItem,
} from '@unit-price/api-client';
import { BASE, BASE_IS_PLACEHOLDER, PAGE_SIZE } from './config';

/** Coarse lifecycle phase driving the screen-level three-state render. */
export type RankingsPhase =
  | 'idle' // before first load
  | 'loading' // first-screen load in flight, no list yet
  | 'ready' // have a (possibly empty) validated list
  | 'error'; // FIRST-SCREEN error: initial load/parse failed, list empty

export interface RankingsState {
  phase: RankingsPhase;
  items: RankingsItem[];
  /** True while a NEXT page (offset>0) request is in flight (footer spinner). */
  pageLoading: boolean;
  /** True when a next-page load failed but the existing list is preserved. */
  pageError: boolean;
  /** True once a page returned [] — no more pages, stop requesting. */
  reachedEnd: boolean;
}

export interface RankingsApi extends RankingsState {
  /** Kick off the very first page load (offset=0). Idempotent-ish: callers
   *  guard via phase. */
  loadFirst: () => void;
  /** Pull-to-refresh: reset offset=0, REPLACE the list with the fresh first
   *  page. Resolves after the request settles (so the page can stop the native
   *  pull-down spinner). */
  refresh: () => Promise<void>;
  /** Reach-bottom: load the next page (offset += limit) and APPEND. No-op while
   *  a page is loading, after reaching the end, or in a first-screen error. */
  loadNext: () => void;
  /** Whole-screen retry after a first-screen error. */
  retryFirst: () => void;
  /** Local retry for the failed next page (keeps the loaded list). */
  retryNext: () => void;
}

/** PURE: build one /rankings page URL from the page cursor + scope params.
 *  Extracted so the "pagination keeps q (and category)" invariant — every page,
 *  including page 2 (offset > 0), carries the same filter — is unit-testable
 *  without the Taro runtime. category/q undefined → buildRankingsUrl omits them
 *  (identical to the un-scoped 榜单 Tab URL). */
export function buildPageUrl(
  base: string,
  offset: number,
  category?: string,
  q?: string,
): string {
  return buildRankingsUrl(base, { limit: PAGE_SIZE, offset, category, q });
}

/** One validated /rankings page fetch. Throws on network failure OR validation
 *  failure (parseRankingsResponse bubbles ZodError) — callers map to error
 *  state. */
async function fetchPage(offset: number, category?: string, q?: string): Promise<RankingsItem[]> {
  // Loud, clear failure on an unfilled BASE placeholder (the `[手动验证]` step):
  // surfaces a distinct "BASE 未配置" message via the error state instead of a
  // generic URL-parse error, so the placeholder can never be mistaken for a real
  // config or silently ship. (buildRankingsUrl would also throw on the
  // placeholder, but with a less actionable message.)
  if (BASE_IS_PLACEHOLDER) {
    throw new Error('BASE 未配置：请在 src/pages/index/config.ts 填入 prod worker 域名（[手动验证]，见任务 5.2）');
  }
  const url = buildPageUrl(BASE, offset, category, q);
  const res = await Taro.request({ url, method: 'GET' });
  // parseRankingsResponse is fail-closed: a bad body throws ZodError here.
  return parseRankingsResponse(res.data);
}

// `category` (optional) scopes every page fetch to one cohort via
// /rankings?category=<slug>; `q` (optional) filters by product title via
// /rankings?q=<term>. Both are stable per mount (route params) — passing them
// undefined yields the original un-scoped 榜单 Tab behavior unchanged. q MUST flow
// into ALL THREE fetchPage calls + ALL THREE useCallback deps (same as category):
// dropping it from runNext would let page 2 use a stale q and mix cohort rows into
// the search results (latent because board remounts per navigateTo, but guarded
// here against regression).
export function useRankings(category?: string, q?: string): RankingsApi {
  const [state, setState] = useState<RankingsState>({
    phase: 'idle',
    items: [],
    pageLoading: false,
    pageError: false,
    reachedEnd: false,
  });

  // Next offset to request. Kept in a ref so concurrent callbacks read the live
  // value without stale closures; mirrors items.length on the happy path but is
  // the authoritative cursor.
  const offsetRef = useRef(0);
  // Guards against overlapping in-flight requests (double pull / rapid scroll).
  const inFlightRef = useRef(false);

  const runFirst = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setState((s) => ({ ...s, phase: s.items.length ? s.phase : 'loading' }));
    try {
      const page = await fetchPage(0, category, q);
      offsetRef.current = page.length;
      setState({
        phase: 'ready',
        items: page,
        pageLoading: false,
        pageError: false,
        reachedEnd: page.length < PAGE_SIZE,
      });
    } catch {
      // First-screen error: initial load/parse failed → whole-screen error.
      offsetRef.current = 0;
      setState({
        phase: 'error',
        items: [],
        pageLoading: false,
        pageError: false,
        reachedEnd: false,
      });
    } finally {
      inFlightRef.current = false;
    }
  }, [category, q]);

  const loadFirst = useCallback(() => {
    setState((s) => {
      if (s.phase === 'idle') {
        void runFirst();
      }
      return s;
    });
  }, [runFirst]);

  const retryFirst = useCallback(() => {
    void runFirst();
  }, [runFirst]);

  const refresh = useCallback(async () => {
    // Pull-to-refresh always resets to offset=0 and replaces the list, even if
    // the screen was previously in a first-screen error state.
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const page = await fetchPage(0, category, q);
      offsetRef.current = page.length;
      setState({
        phase: 'ready',
        items: page,
        pageLoading: false,
        pageError: false,
        reachedEnd: page.length < PAGE_SIZE,
      });
    } catch {
      setState((s) => {
        // If we already had a list, refresh failure must NOT wipe it. Keep the
        // list as-is WITHOUT raising pageError: that footer's retry maps to
        // next-page loading (retryNext → runNext → append), which is wrong for a
        // failed refresh. The pull-to-refresh gesture is itself the retry
        // affordance. If we had nothing, fall back to the whole-screen error.
        if (s.items.length) {
          return { ...s, phase: 'ready', pageLoading: false, pageError: false };
        }
        return {
          phase: 'error',
          items: [],
          pageLoading: false,
          pageError: false,
          reachedEnd: false,
        };
      });
    } finally {
      inFlightRef.current = false;
    }
  }, [category, q]);

  const runNext = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setState((s) => ({ ...s, pageLoading: true, pageError: false }));
    try {
      const page = await fetchPage(offsetRef.current, category, q);
      if (page.length === 0) {
        // Empty page → reached the end, stop requesting.
        setState((s) => ({ ...s, pageLoading: false, reachedEnd: true }));
      } else {
        offsetRef.current += page.length;
        setState((s) => ({
          ...s,
          items: [...s.items, ...page],
          pageLoading: false,
          reachedEnd: page.length < PAGE_SIZE,
        }));
      }
    } catch {
      // Page error: KEEP the existing list, expose a local retry. Never clears
      // items / never reverts to the whole-screen error state.
      setState((s) => ({ ...s, pageLoading: false, pageError: true }));
    } finally {
      inFlightRef.current = false;
    }
  }, [category, q]);

  const loadNext = useCallback(() => {
    setState((s) => {
      // Only paginate from a healthy list with more pages and nothing in flight.
      if (
        s.phase === 'ready' &&
        !s.pageLoading &&
        !s.pageError &&
        !s.reachedEnd &&
        s.items.length > 0
      ) {
        void runNext();
      }
      return s;
    });
  }, [runNext]);

  const retryNext = useCallback(() => {
    setState((s) => {
      if (s.phase === 'ready' && !s.pageLoading) {
        void runNext();
      }
      return s;
    });
  }, [runNext]);

  return {
    ...state,
    loadFirst,
    refresh,
    loadNext,
    retryFirst,
    retryNext,
  };
}
