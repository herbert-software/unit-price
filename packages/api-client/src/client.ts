// Transport-agnostic helpers for the GET /rankings contract: a pure URL
// serializer + a fail-closed response validator. NEITHER sends a request —
// each client wires its own transport (miniapp: Taro.request, web/plugin:
// fetch) and feeds the response body to parseRankingsResponse.
import { RankingsResponseSchema, type RankingsResponse } from './rankings.js';

/** Optional GET /rankings query parameters (all values serialized verbatim). */
export interface RankingsParams {
  limit?: number;
  offset?: number;
  category?: string;
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
  // Fail-fast on a non-clean-origin base. `new URL` both validates the scheme
  // and lets us assert the origin carries no path/query/fragment. A URL whose
  // pathname is exactly "/" (the parser's normalization of a bare origin) plus
  // no search/hash is the only accepted shape.
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    throw new Error(`buildRankingsUrl: base must be a clean http(s) origin, got: ${base}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`buildRankingsUrl: base must use http(s) scheme, got: ${base}`);
  }
  // STRICT: the raw base must ALREADY BE the canonical origin (modulo one
  // optional trailing slash). `parsed.origin` for http(s) is exactly
  // `scheme://host[:port]` (lowercased host, default port omitted, no path/
  // query/fragment/userinfo), so this single equality rejects EVERY non-canonical
  // form in one shot — a missing `//` (`https:host`), a path or dot-segment
  // (`/v1`, `/.`), a query/fragment, userinfo, an uppercase host, an explicit
  // default port, etc. We fail fast on a misconfigured base rather than silently
  // canonicalizing it (the base is a controlled config constant — a non-canonical
  // value is a config error, not input to normalize).
  if (base.replace(/\/$/, '') !== parsed.origin) {
    throw new Error(
      `buildRankingsUrl: base must be exactly a clean origin ${parsed.origin} (no path/query/fragment/userinfo, canonical host), got: ${base}`,
    );
  }

  // Build from the canonical origin. After the equality gate above, `base` is
  // already canonical, so this is `<base-without-trailing-slash>/rankings`.
  const url = `${parsed.origin}/rankings`;

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
