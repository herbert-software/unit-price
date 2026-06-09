// SpecParserLLM — the domain port for tier2. Input `RawProduct`, output a
// Zod-validated `ParsedSpec` or a DISTINGUISHABLE failure signal. The port
// speaks only domain language; it must NOT leak provider SDK types to callers.
//
// Failure taxonomy (discriminated union):
//  - transport: timeout / network / upstream 5xx / empty response (retryable)
//  - config:    missing/invalid API key (NOT retryable — startup concern)
//  - invalid:   the model returned something that fails ParsedSpec Zod (rejected,
//               not silently adopted; downstream forces confidence <= 0.5)
//
// A structurally-valid object with all-empty fields is NOT a transport failure:
// it is a valid parse result that flows downstream into tier banding (typically
// the uncomputable terminal state).
import { LoadAPIKeyError, generateObject } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { ParsedSpecSchema, type ParsedSpec, type RawProduct } from '@unit-price/core';
import { ConfigError, DEFAULT_MODEL, loadLlmConfig, type LlmConfig } from './config.js';

/** Optional per-call options. The `tier` slot reserves the future upgrade path
 * (validation-fail -> retry with a stronger model). This change implements only
 * the cheap tier; passing or omitting `tier` must both be legal. */
export interface ParseOptions {
  /** Reserved upgrade slot. Ignored this change (single tier only). */
  tier?: 'cheap' | 'strong';
}

export type ParseResult =
  | { ok: true; spec: ParsedSpec }
  | { ok: false; kind: 'transport'; message: string }
  | { ok: false; kind: 'config'; message: string }
  | { ok: false; kind: 'invalid'; message: string };

/** The domain port. Implementations return domain types only. */
export interface SpecParserLLM {
  parse(input: RawProduct, opts?: ParseOptions): Promise<ParseResult>;
}

const SYSTEM_PROMPT = [
  'You extract structured beverage specs from a product title.',
  'Return only the fields you can determine from the title; leave others null.',
  'Volume units must be one of ml, L, g, kg (normalize 毫升/mL -> ml, 升 -> L).',
  'Do NOT decide price, unit conversion, comparability, or category — leave category as given.',
  'multipliers must be [1]. Do not invent values.',
].join(' ');

function buildUserPrompt(input: RawProduct): string {
  return `Title: ${input.title}\nCategory: ${input.categoryHint ?? 'beverage'}`;
}

/**
 * Map a thrown AI-SDK / provider error to a distinguishable failure signal.
 * A missing/invalid key is `config` (not retryable); everything else — empty
 * response, no-object-generated, network/timeout/upstream 5xx — is `transport`.
 */
function classifyError(err: unknown): ParseResult {
  if (err instanceof ConfigError || err instanceof LoadAPIKeyError) {
    return { ok: false, kind: 'config', message: String((err as Error).message) };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, kind: 'transport', message };
}

/**
 * AI-SDK implementation of the port: Vercel AI SDK `generateObject` over the
 * OpenAI-compatible provider pointed at OpenRouter. The model id comes from
 * config (D3). The raw LLM output is re-validated against ParsedSpecSchema; a
 * failure is reported as `invalid` (rejected, not silently adopted).
 */
export class AiSdkSpecParser implements SpecParserLLM {
  private readonly config: LlmConfig;

  constructor(config?: LlmConfig) {
    // Resolving config here surfaces a missing key as ConfigError at construction
    // time. Prefer startup fail-fast (see index.ts) so /parse never hits this.
    this.config = config ?? loadLlmConfig();
  }

  async parse(input: RawProduct, _opts?: ParseOptions): Promise<ParseResult> {
    // `_opts.tier` is the reserved upgrade slot; ignored this change.
    let raw: unknown;
    try {
      const provider = createOpenAICompatible({
        name: 'openrouter',
        baseURL: this.config.baseURL,
        apiKey: this.config.apiKey,
      });
      const result = await generateObject({
        model: provider.chatModel(this.config.model),
        schema: ParsedSpecSchema,
        system: SYSTEM_PROMPT,
        prompt: buildUserPrompt(input),
      });
      raw = result.object;
    } catch (err) {
      return classifyError(err);
    }

    // Re-validate against the domain schema. generateObject already validates,
    // but re-checking keeps the port authoritative and guards prompt-fallback
    // providers that may not enforce the schema natively.
    const parsed = ParsedSpecSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, kind: 'invalid', message: parsed.error.message };
    }
    return { ok: true, spec: parsed.data };
  }
}

export { DEFAULT_MODEL };
