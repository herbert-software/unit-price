// Runtime/config boundary for the LLM provider. `OPENROUTER_API_KEY` missing is
// a CONFIG error (not a transient transport failure): callers fail-fast at
// startup or surface a distinguishable config-error, never a retryable signal.
//
// The cheap-tier model is a configuration constant (D3): switching providers or
// models is just changing this string — no business code changes.

import type { Bindings } from './bindings.js';

/** OpenRouter OpenAI-compatible base URL. */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/** Cheap-tier model id (this change implements a single tier; see D4). */
export const DEFAULT_MODEL = 'deepseek/deepseek-chat';

/** Env var holding the single OpenRouter key. */
export const API_KEY_ENV = 'OPENROUTER_API_KEY';

export interface LlmConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

/**
 * Thrown when `OPENROUTER_API_KEY` is absent. This is a CONFIG error and must
 * be distinguishable from a transient transport failure. Prefer calling
 * `assertConfigOrThrow()` at startup so `/parse` never hits this branch.
 */
export class ConfigError extends Error {
  readonly kind = 'config' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Read the LLM config from the INJECTED env (no global `process.env` fallback —
 * Workers has no module-load-time env). Throws `ConfigError` if the API key is
 * missing/empty. The model is taken from the configuration constant unless
 * overridden (kept for testability / the future upgrade tier).
 */
export function loadLlmConfig(env: Pick<Bindings, 'OPENROUTER_API_KEY'>, model = DEFAULT_MODEL): LlmConfig {
  const apiKey = env.OPENROUTER_API_KEY;
  if (apiKey === undefined || apiKey.trim() === '') {
    throw new ConfigError(`Missing ${API_KEY_ENV} (configuration error, not a transport failure)`);
  }
  return { baseURL: OPENROUTER_BASE_URL, apiKey, model };
}

/** Startup fail-fast helper: returns true if config is present in the env. */
export function configPresent(env: Pick<Bindings, 'OPENROUTER_API_KEY'>): boolean {
  const apiKey = env.OPENROUTER_API_KEY;
  return apiKey !== undefined && apiKey.trim() !== '';
}
