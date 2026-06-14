// Access governance for the public API: API-key authentication, per-key rate
// limiting, and usage counting — all as a PRE-middleware in front of /parse.
//
// Governance is an INJECTABLE dependency (like the LLM port): production injects
// the real implementation (reads `API_KEYS` allowlist + `GOVERNANCE_KV`), local
// dev injects a pass-through no-op so a keyless `wrangler dev` can smoke /parse
// without being blocked by 401/429.
//
// Status-code priority on a protected endpoint (top-down short-circuit):
//   ① auth   401 auth-missing / auth-malformed | 403 auth-forbidden
//   ② rate   429 rate-limited (+ Retry-After)
//   ③ usage  (records admission; never short-circuits a 2xx)
//   ④ business (parse-api: 400/200/500/503)
// Governance error codes (auth-missing/auth-malformed/auth-forbidden/
// rate-limited) are pairwise DISTINCT from parse-api's existing codes
// (invalid-request/config-error/insufficient-information/internal) so failures
// are mechanically distinguishable.
import type { MiddlewareHandler } from 'hono';
import type { AppEnv, Bindings } from './bindings.js';

/** Fixed-window length in seconds (module constant; configurable if needed). */
export const RATE_LIMIT_WINDOW_SECONDS = 60;
/** Max admitted requests per key per window (module constant; configurable). */
export const RATE_LIMIT_MAX = 60;

/** Governance error codes. Pairwise distinct from parse-api's codes. */
export type GovernanceErrorCode =
  | 'auth-missing'
  | 'auth-malformed'
  | 'auth-forbidden'
  | 'rate-limited'
  | 'config-error';

/** Result of authenticating a request. */
export type AuthResult =
  | { ok: true; key: string }
  | { ok: false; status: 401 | 403 | 500; code: GovernanceErrorCode; message: string };

/** Result of a rate-limit check. */
export type RateResult =
  | { ok: true }
  | { ok: false; retryAfterSeconds: number };

/**
 * Injectable governance port. The middleware runs these in the fixed order
 * authenticate → checkRateLimit → recordUsage → next(). Both a real and a no-op
 * implementation satisfy this interface.
 */
export interface Governance {
  /** Authenticate from request headers against the env-derived allowlist. */
  authenticate(env: Bindings, headers: Headers): AuthResult;
  /** Fixed-window per-key rate check. MUST fail-open on KV failure. */
  checkRateLimit(env: Bindings, key: string): Promise<RateResult>;
  /**
   * Admission usage counting (metadata only). MUST NOT throw to the caller.
   * `amount` defaults to 1 (the admission baseline) and is back-compatible; a
   * caller (e.g. batch overflow accounting) may pass a larger increment. The
   * caller MUST guarantee `amount >= 1` — this port adds it as-is and does NOT
   * guard against `amount <= 0` (a negative would corrupt the KV count).
   */
  recordUsage(env: Bindings, key: string, amount?: number): Promise<void>;
}

/** Bearer prefix (case-insensitive scheme per RFC 7235). */
const BEARER_PREFIX = /^Bearer\s+(.*)$/i;
/** A syntactically valid key: non-empty, no whitespace/control chars. */
const KEY_FORMAT = /^[\w.\-]+$/;

/**
 * Extract the candidate key from headers with STRICT precedence: if
 * `Authorization` is present it is authoritative (no fallback to X-API-Key when
 * its value is malformed). Returns a discriminated result so the middleware can
 * map (no header → missing, bad value → malformed, good value → present).
 */
function extractKey(
  headers: Headers,
): { kind: 'missing' } | { kind: 'malformed' } | { kind: 'present'; key: string } {
  const auth = headers.get('authorization');
  if (auth !== null) {
    // Authorization present and authoritative — do NOT fall back to X-API-Key.
    const m = BEARER_PREFIX.exec(auth.trim());
    if (m === null) return { kind: 'malformed' }; // non-Bearer form (e.g. Basic …)
    const value = (m[1] ?? '').trim();
    if (value === '' || !KEY_FORMAT.test(value)) return { kind: 'malformed' };
    return { kind: 'present', key: value };
  }

  const xApiKey = headers.get('x-api-key');
  if (xApiKey !== null) {
    const value = xApiKey.trim();
    if (value === '' || !KEY_FORMAT.test(value)) return { kind: 'malformed' };
    return { kind: 'present', key: value };
  }

  return { kind: 'missing' };
}

/** Parse a comma-separated allowlist secret (selected by name) into a set. */
function parseAllowlist(env: Bindings, varName: 'API_KEYS' | 'ADMIN_API_KEYS'): Set<string> {
  const raw = env[varName] ?? '';
  return new Set(
    raw
      .split(',')
      .map((k) => k.trim())
      .filter((k) => k !== ''),
  );
}

/**
 * Real governance: reads `API_KEYS` (allowlist) and `GOVERNANCE_KV` from the
 * injected env. Initialization-time config validation (empty/missing
 * `API_KEYS`) surfaces as a 500 config-error per request — NOT a silent empty
 * allowlist that would punt every valid key to 403.
 */
export function createRealGovernance(opts: { allowlistVar?: 'API_KEYS' | 'ADMIN_API_KEYS' } = {}): Governance {
  const allowlistVar = opts.allowlistVar ?? 'API_KEYS';
  return {
    authenticate(env, headers): AuthResult {
      const extracted = extractKey(headers);

      // Allowlist missing/empty is a CONFIGURATION error, not auth-forbidden.
      // Surface it as 500 config-error rather than silently 403-ing valid keys.
      const allowlist = parseAllowlist(env, allowlistVar);
      if (allowlist.size === 0) {
        // Secret-source diagnostics go to server logs ONLY; the client message
        // is generalized so the response body never names a secret.
        console.warn('[governance] config-error: allowlist', allowlistVar, 'is missing or empty');
        return {
          ok: false,
          status: 500,
          code: 'config-error',
          message: 'service configuration error',
        };
      }

      if (extracted.kind === 'missing') {
        return { ok: false, status: 401, code: 'auth-missing', message: 'missing API key' };
      }
      if (extracted.kind === 'malformed') {
        return { ok: false, status: 401, code: 'auth-malformed', message: 'malformed API key' };
      }
      if (!allowlist.has(extracted.key)) {
        return { ok: false, status: 403, code: 'auth-forbidden', message: 'API key not recognized' };
      }
      return { ok: true, key: extracted.key };
    },

    async checkRateLimit(env, key): Promise<RateResult> {
      const kv = env.GOVERNANCE_KV;
      // No KV bound is a degraded/dev condition: fail-open (do not 429/5xx).
      if (kv === undefined) return { ok: true };

      const now = Math.floor(Date.now() / 1000);
      const windowStart = now - (now % RATE_LIMIT_WINDOW_SECONDS);
      const kvKey = `rl:${key}:${windowStart}`;

      try {
        const current = await kv.get(kvKey);
        const count = current === null ? 0 : Number.parseInt(current, 10);
        const safeCount = Number.isNaN(count) ? 0 : count;

        if (safeCount >= RATE_LIMIT_MAX) {
          // Retry-After = remaining seconds in the current window (round up,
          // capped at the window length).
          const retryAfterSeconds = Math.min(
            RATE_LIMIT_WINDOW_SECONDS,
            Math.max(1, windowStart + RATE_LIMIT_WINDOW_SECONDS - now),
          );
          return { ok: false, retryAfterSeconds };
        }

        // Non-atomic read-modify-write: acceptable approximation for an
        // anti-abuse limiter (see design risk note). TTL = window length so the
        // counter self-expires.
        await kv.put(kvKey, String(safeCount + 1), { expirationTtl: RATE_LIMIT_WINDOW_SECONDS });
        return { ok: true };
      } catch (err) {
        // KV jitter MUST fail-open (admit + warn) — never fail-closed.
        console.warn('[governance] rate-limit KV failure, failing open:', err);
        return { ok: true };
      }
    },

    async recordUsage(env, key, amount = 1): Promise<void> {
      const kv = env.GOVERNANCE_KV;
      if (kv === undefined) return;

      // Admission counting: metadata only (key / count / time). NEVER record
      // business data (title/price). Write failure only warns — it MUST NOT
      // change the /parse response (no 200 → 5xx downgrade).
      const usageKey = `usage:${key}`;
      try {
        // Stored value is a JSON payload `{ key, count, lastSeen }` — read the
        // prior count from the PARSED object, not parseInt on the raw string
        // (which begins with `{` and would yield NaN, pinning count to 1).
        const current = await kv.get(usageKey);
        let prev = 0;
        if (current !== null) {
          try {
            const parsed = JSON.parse(current) as { count?: unknown };
            if (typeof parsed.count === 'number' && Number.isFinite(parsed.count)) {
              prev = parsed.count;
            }
          } catch {
            prev = 0; // corrupt/legacy value: restart the counter rather than crash
          }
        }
        const payload = JSON.stringify({
          key,
          count: prev + (amount ?? 1),
          lastSeen: new Date().toISOString(),
        });
        await kv.put(usageKey, payload);
      } catch (err) {
        console.warn('[governance] usage write failed (response unaffected):', err);
      }
    },
  };
}

/**
 * Pass-through no-op governance for local dev / `wrangler dev`: every check
 * passes, usage is a no-op. NEVER inject this into the production worker entry
 * (doing so would make the public endpoint run wide open).
 */
export function createNoopGovernance(): Governance {
  return {
    authenticate(_env, _headers): AuthResult {
      return { ok: true, key: 'noop' };
    },
    async checkRateLimit(): Promise<RateResult> {
      return { ok: true };
    },
    async recordUsage(_env, _key, _amount?): Promise<void> {
      // no-op (ignores amount, like all other inputs)
    },
  };
}

/**
 * Hono middleware factory wrapping a Governance port. Runs the three governance
 * gates in the fixed order authenticate → checkRateLimit → recordUsage, then
 * `next()`. Short-circuits with a JSON error body on any failed gate. Mount this
 * on /parse only — /health is exempt from the entire chain.
 */
export function governanceMiddleware(gov: Governance): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    // ① Authentication. Unauthenticated requests MUST NOT reach rate limiting
    //    (so unregistered keys can't blow up KV counter slots).
    const auth = gov.authenticate(c.env, c.req.raw.headers);
    if (!auth.ok) {
      return c.json({ error: auth.code, message: auth.message }, auth.status);
    }

    // Expose the authenticated key to downstream handlers (e.g. batch overflow
    // usage accounting) via the context Variable.
    c.set('govKey', auth.key);

    // ② Rate limit (after auth). Over-limit short-circuits before business.
    const rate = await gov.checkRateLimit(c.env, auth.key);
    if (!rate.ok) {
      c.header('Retry-After', String(rate.retryAfterSeconds));
      return c.json({ error: 'rate-limited', message: 'rate limit exceeded' }, 429);
    }

    // ③ Usage (admission counting, before business). Records the admitted call
    //    even if business later lands 500/503. Failure only warns inside the
    //    port — it never changes the response.
    await gov.recordUsage(c.env, auth.key);

    // ④ Business.
    await next();
  };
}

/**
 * Admin 端点专用 authenticate-only 中间件。只跑 authenticate → 失败 return /
 * 成功 next()。**不**跑 checkRateLimit、**不**跑 recordUsage、**不**设 govKey
 * (admin tier 结构上不抵达公共限频/用量门)。鉴权放行后把原始 key 暂存到
 * `adminKey`(仅 context、绝不原文落日志),供 handler 出 keyed-哈希审计行。
 * 每个 /admin/* 路由各自挂(Hono 精确路径,无前缀 catch-all)。
 */
export function authOnlyMiddleware(gov: Governance): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const auth = gov.authenticate(c.env, c.req.raw.headers);
    if (!auth.ok) {
      return c.json({ error: auth.code, message: auth.message }, auth.status);
    }
    c.set('adminKey', auth.key);
    await next();
  };
}
