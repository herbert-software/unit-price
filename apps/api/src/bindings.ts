// Runtime-agnostic shape contract for `c.env` (the injected binding set).
//
// On Cloudflare Workers these come from the fetch handler's `env` argument
// (secrets + D1 + KV). On the Node dev entry the entry layer packs `process.env`
// into the same shape and injects it as `env`, so the app reads one path.
//
// All four are OPTIONAL at the type level (dev/no-op paths may lack them);
// required-ness is enforced at the injection entry at runtime, not by the type.
import type { D1Database, KVNamespace } from '@cloudflare/workers-types';

export interface Bindings {
  /** OpenRouter LLM key (secret). Used only by the stateless tier2 path. */
  OPENROUTER_API_KEY?: string;
  /** Governance allowlist (secret, comma-separated). Consumed by governance. */
  API_KEYS?: string;
  /** 独立 admin 白名单(逗号分隔,secret)。仅 /admin/* tier 用,与公共 API_KEYS 分离。 */
  ADMIN_API_KEYS?: string;
  /** admin 审计日志 key HMAC 的 keying 输入(secret 或部署 salt)。与 ADMIN_API_KEYS 不同源。 */
  AUDIT_LOG_HMAC_SECRET?: string;
  /** D1 database binding (production pipeline; not consumed by /parse). */
  DB?: D1Database;
  /** KV namespace for governance (rate-limit + usage counters). */
  GOVERNANCE_KV?: KVNamespace;
}

/**
 * Hono environment for the app: the binding set plus context Variables. Defined
 * on this shared leaf (both routes.ts and governance.ts already import Bindings
 * from here) so the `Variables` SOT lives alongside the `Bindings` SOT and the
 * existing `routes → governance` dependency direction is preserved.
 *
 * `govKey` is set by governanceMiddleware after auth so handlers can attribute
 * usage (e.g. batch overflow accounting) to the authenticated key.
 *
 * `adminKey` is set by the admin authenticate-only middleware after auth admits
 * the request (the raw key, request-context only — NEVER logged in cleartext;
 * audit logs record only its keyed hash).
 */
export type AppEnv = { Bindings: Bindings; Variables: { govKey: string; adminKey?: string } };
