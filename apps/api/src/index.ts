// @unit-price/api — Hono backend (public API + LLM tier2).
// Wires the AI-SDK SpecParserLLM port into the POST /parse orchestration.
//
// Config vs runtime boundary: clean titles parse via tier1 with no LLM/key, so
// the app builds even without OPENROUTER_API_KEY. A genuinely missing key only
// surfaces as a distinguishable runtime config-error if a request reaches tier2.
import type { RawProduct } from '@unit-price/core';
import { ConfigError, configPresent, loadLlmConfig } from './config.js';
import { AiSdkSpecParser, type ParseOptions, type ParseResult, type SpecParserLLM } from './llm.js';
import { createApp } from './routes.js';

export { createApp, type AppDeps } from './routes.js';
export { ParseRequestSchema, ParseResponseSchema } from './routes.js';
export {
  orchestrate,
  type ParseResponse,
  type OrchestrationOutcome,
} from './orchestrate.js';
export {
  AiSdkSpecParser,
  type SpecParserLLM,
  type ParseResult,
  type ParseOptions,
} from './llm.js';
export { ConfigError, DEFAULT_MODEL, loadLlmConfig, configPresent } from './config.js';

/**
 * A thin lazy wrapper that defers `loadLlmConfig()` (which throws ConfigError on
 * a missing key) until the first parse, so building the app never throws and
 * clean titles keep working without a key.
 */
class LazySpecParser implements SpecParserLLM {
  private inner: AiSdkSpecParser | null = null;

  async parse(input: RawProduct, opts?: ParseOptions): Promise<ParseResult> {
    if (this.inner === null) {
      try {
        this.inner = new AiSdkSpecParser(loadLlmConfig());
      } catch (err) {
        if (err instanceof ConfigError) {
          return { ok: false, kind: 'config', message: err.message };
        }
        throw err;
      }
    }
    return this.inner.parse(input, opts);
  }
}

/** Build the production app with the real (lazy) AI-SDK port. */
export function buildApp() {
  if (!configPresent()) {
    console.warn(
      '[startup] OPENROUTER_API_KEY not set: tier2 (LLM) is unavailable; clean titles still parse via tier1.',
    );
  }
  return createApp({ llm: new LazySpecParser() });
}

export default buildApp;
