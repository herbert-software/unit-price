// @unit-price/api — Hono backend (public API + LLM tier2).
// Wires the AI-SDK SpecParserLLM port into the POST /parse orchestration.
//
// Config vs runtime boundary: clean titles parse via tier1 with no LLM/key, so
// the app builds even without OPENROUTER_API_KEY. A genuinely missing key only
// surfaces as a distinguishable runtime config-error if a request reaches tier2.
import type { RawProduct } from '@unit-price/core';
import type { Bindings } from './bindings.js';
import { ConfigError, loadLlmConfig } from './config.js';
import { AiSdkSpecParser, type ParseOptions, type ParseResult, type SpecParserLLM } from './llm.js';
import { createApp } from './routes.js';
import { createRealGovernance } from './governance.js';

export { createApp, type AppDeps } from './routes.js';
export {
  createRealGovernance,
  createNoopGovernance,
  governanceMiddleware,
  type Governance,
} from './governance.js';
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
export type { Bindings } from './bindings.js';

/**
 * A thin lazy wrapper bound to ONE request's injected env. It defers
 * `loadLlmConfig(env)` (which throws ConfigError on a missing key) until the
 * first parse, so building the app never throws and clean titles keep working
 * without a key. Built per request (see `makeLlm`) so two requests with
 * different env never share a resolved config — no isolate cross-request bleed.
 */
class LazySpecParser implements SpecParserLLM {
  private inner: AiSdkSpecParser | null = null;

  private readonly env: Bindings;

  constructor(env: Bindings | undefined) {
    // Hono passes `c.env` which is `undefined` when no env is injected (e.g. a
    // bare Node entry not yet bridging env). Treat that as an empty env so a
    // missing key surfaces as ConfigError, not a TypeError.
    this.env = env ?? {};
  }

  async parse(input: RawProduct, opts?: ParseOptions): Promise<ParseResult> {
    if (this.inner === null) {
      try {
        this.inner = new AiSdkSpecParser(loadLlmConfig(this.env));
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

/**
 * The default LLM factory: a fresh env-bound lazy parser per request from the
 * injected `c.env`, so config is resolved at request time from each request's
 * own env (no cross-request env bleed). Shared by the production Workers entry
 * (`buildApp`/`worker.ts`) and the Node dev entry (`server.ts`) so both wire the
 * same parser, differing only in the injected governance.
 */
export const defaultMakeLlm = (env: Bindings): SpecParserLLM => new LazySpecParser(env);

/**
 * Build the production app with the real AI-SDK port and the REAL governance
 * implementation. The production Workers entry (`worker.ts`) uses this; it must
 * never be given the no-op governance (public-endpoint wide-open guardrail).
 */
export function buildApp() {
  return createApp({
    makeLlm: defaultMakeLlm,
    governance: createRealGovernance(),
  });
}

export default buildApp;
