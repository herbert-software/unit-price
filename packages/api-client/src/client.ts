// Transport-agnostic helpers for the GET /rankings and GET /categories
// contracts: pure URL serializers + fail-closed response validators. NONE send
// a request — each client wires its own transport (miniapp: Taro.request,
// web/plugin: fetch) and feeds the response body to the matching parse* helper.
import { RankingsResponseSchema, type RankingsResponse } from './rankings.js';
import { CategoryTreeResponseSchema, type CategoryTreeResponse } from './categories.js';

/** Optional GET /rankings query parameters (all values serialized verbatim). */
export interface RankingsParams {
  limit?: number;
  offset?: number;
  category?: string;
}

/**
 * Validate that `base` is a clean `http(s)` origin (`https://host[:port]`) with
 * NO path segment, query, or fragment, and return its canonical origin. SHARED
 * by every URL builder so the fail-fast contract has ONE definition (never a
 * second divergent copy).
 *
 * `new URL` both validates the scheme and lets us assert the origin carries no
 * path/query/fragment. The STRICT equality `base.replace(/\/$/, '') ===
 * parsed.origin` rejects EVERY non-canonical form in one shot — a missing `//`
 * (`https:host`), a path or dot-segment (`/v1`, `/.`), a query/fragment,
 * userinfo, an uppercase host, an explicit default port, a double trailing
 * slash, etc. — because `parsed.origin` for http(s) is exactly
 * `scheme://host[:port]` (lowercased host, default port omitted, no path/query/
 * fragment/userinfo). We fail fast on a misconfigured base rather than silently
 * canonicalizing it (the base is a controlled config constant — a non-canonical
 * value is a config error, not input to normalize). `caller` names the public
 * helper in the thrown message so misuse points at the right call site.
 */
function cleanOrigin(base: string, caller: string): string {
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    throw new Error(`${caller}: base must be a clean http(s) origin, got: ${base}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${caller}: base must use http(s) scheme, got: ${base}`);
  }
  if (base.replace(/\/$/, '') !== parsed.origin) {
    throw new Error(
      `${caller}: base must be exactly a clean origin ${parsed.origin} (no path/query/fragment/userinfo, canonical host), got: ${base}`,
    );
  }
  return parsed.origin;
}

/**
 * Serialize a GET /rankings URL from a clean API origin + the given query
 * params. PURE: does not send a request, does NOT validate param VALUES (value
 * legality — e.g. `limit=0`, `category=alcohol` — is the server's `400` concern
 * per the rankings-api query-boundary requirement; this function only serializes
 * what it is given).
 *
 * `base` MUST be a clean `http(s)` origin (`https://host[:port]`) with NO path
 * segment, query, or fragment. Anything else (a path like `/v1`, a `?`/`#`, an
 * empty string, or a non-`http(s)` scheme) is a configuration misuse and THROWS
 * (fail-fast) — never a silently-malformed URL. The trailing slash of `base` is
 * stripped, `/rankings` is appended, then only the GIVEN params are joined as
 * `?k=v&...`, each value `encodeURIComponent`-encoded. All-default `{}` returns
 * `<base>/rankings` (no `?` string).
 */
export function buildRankingsUrl(base: string, params: RankingsParams = {}): string {
  // Fail-fast on a non-clean-origin base via the SHARED validator (same contract
  // as buildCategoriesUrl). Returns the canonical origin to build from.
  const origin = cleanOrigin(base, 'buildRankingsUrl');
  const url = `${origin}/rankings`;

  // Join ONLY the given params (skip undefined), values encodeURIComponent-
  // encoded. No value validation: serialize whatever was passed.
  const pairs: string[] = [];
  if (params.limit !== undefined) pairs.push(`limit=${encodeURIComponent(String(params.limit))}`);
  if (params.offset !== undefined) pairs.push(`offset=${encodeURIComponent(String(params.offset))}`);
  if (params.category !== undefined) {
    pairs.push(`category=${encodeURIComponent(String(params.category))}`);
  }

  return pairs.length === 0 ? url : `${url}?${pairs.join('&')}`;
}

/**
 * Validate an untrusted GET /rankings response body against the contract.
 * Uses `RankingsResponseSchema.parse` (fail-CLOSED): on a schema mismatch the
 * raised `ZodError` bubbles up UNWRAPPED — callers catch any throw and enter
 * their error state (they do not depend on the error shape). NEVER returns
 * unvalidated or partial data.
 *
 * `jitless: true` forces Zod's interpreted parser instead of its `new Function`
 * JIT fast-path, keeping this validator runnable in eval-restricted runtimes.
 * The WeChat mini-program forbids `new Function` — and its non-throwing stub
 * even defeats Zod's eval probe, so the JIT path fails with `fn is not a
 * function` deep in `_zod.parse`. The per-parse override (vs global config) is
 * immune to schema-construction timing and propagates to nested schemas via the
 * shared parse context. Validation semantics are unchanged; the cost is one
 * interpreted parse of a small payload (negligible; on Cloudflare Workers Zod is
 * already eval-disabled).
 */
export function parseRankingsResponse(json: unknown): RankingsResponse {
  return RankingsResponseSchema.parse(json, { jitless: true });
}

/**
 * Serialize a GET /categories URL from a clean API origin. PURE: does not send a
 * request. `/categories` takes NO query parameters this period, so there is no
 * param-serialization branch — the result is always `<origin>/categories`.
 *
 * `base` MUST be a clean `http(s)` origin (`https://host[:port]`) with NO path
 * segment, query, or fragment; it is validated by the SAME `cleanOrigin` helper
 * as `buildRankingsUrl` (one fail-fast contract, no divergent copy). Anything
 * else throws (fail-fast) — never a silently-malformed URL.
 */
export function buildCategoriesUrl(base: string): string {
  const origin = cleanOrigin(base, 'buildCategoriesUrl');
  return `${origin}/categories`;
}

/**
 * Validate an untrusted GET /categories response body against the contract.
 * Signature mirrors `parseRankingsResponse(json)` EXACTLY: a single `json`
 * param, `{ jitless: true }` hardcoded internally (NEVER exposed as a caller
 * option). Uses `CategoryTreeResponseSchema.parse` (fail-CLOSED): on a schema
 * mismatch the raised `ZodError` bubbles up UNWRAPPED. NEVER returns unvalidated
 * or partial data.
 *
 * `jitless: true` forces Zod's interpreted parser instead of its `new Function`
 * JIT fast-path, keeping this validator runnable in eval-restricted runtimes
 * (the WeChat mini-program forbids `new Function` — and its non-throwing stub
 * defeats Zod's eval probe, so the JIT path fails deep in `_zod.parse`). Same
 * runtime constraint and known pitfall as `parseRankingsResponse`.
 */
export function parseCategoryTreeResponse(json: unknown): CategoryTreeResponse {
  return CategoryTreeResponseSchema.parse(json, { jitless: true });
}
