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
  /** D1 database binding (production pipeline; not consumed by /parse). */
  DB?: D1Database;
  /** KV namespace for governance (rate-limit + usage counters). */
  GOVERNANCE_KV?: KVNamespace;
}
