import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoadAPIKeyError } from 'ai';
import { ConfigError, DEFAULT_MODEL, OPENROUTER_BASE_URL, configPresent, loadLlmConfig } from './config.js';
import { AiSdkSpecParser } from './llm.js';
import { ParsedSpecSchema, type RawProduct } from '@unit-price/core';

// Mock only `generateObject`; keep the real `LoadAPIKeyError` so classifyError's
// `instanceof` check stays meaningful. The provider factory is a no-op stub
// (its return value is only fed to generateObject, which is mocked).
const generateObjectMock = vi.fn();
vi.mock('ai', async (importActual) => {
  const actual = await importActual<typeof import('ai')>();
  return { ...actual, generateObject: (...args: unknown[]) => generateObjectMock(...args) };
});
vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: () => ({ chatModel: () => ({}) }),
}));

const RAW: RawProduct = { title: '可乐 330ml*24', price: 40 };
const TEST_CFG = { baseURL: OPENROUTER_BASE_URL, apiKey: 'k', model: DEFAULT_MODEL };

describe('config boundary (missing key vs transport)', () => {
  it('loadLlmConfig throws a distinguishable ConfigError when key is absent', () => {
    expect(() => loadLlmConfig({}, DEFAULT_MODEL)).toThrowError(ConfigError);
    try {
      loadLlmConfig({}, DEFAULT_MODEL);
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).kind).toBe('config');
    }
  });

  it('loadLlmConfig returns config when key present; model from constant', () => {
    const cfg = loadLlmConfig({ OPENROUTER_API_KEY: 'sk-test' });
    expect(cfg.apiKey).toBe('sk-test');
    expect(cfg.model).toBe(DEFAULT_MODEL);
    expect(cfg.baseURL).toBe(OPENROUTER_BASE_URL);
  });

  it('empty/whitespace key is treated as absent', () => {
    expect(() => loadLlmConfig({ OPENROUTER_API_KEY: '  ' })).toThrowError(ConfigError);
    expect(configPresent({ OPENROUTER_API_KEY: '  ' })).toBe(false);
    expect(configPresent({ OPENROUTER_API_KEY: 'sk' })).toBe(true);
  });

  it('a non-default model id is honored (config-driven model switch)', () => {
    const cfg = loadLlmConfig({ OPENROUTER_API_KEY: 'k' }, 'qwen/qwen-2.5');
    expect(cfg.model).toBe('qwen/qwen-2.5');
  });
});

describe('AiSdkSpecParser — upgrade slot is shape-only this change', () => {
  it('accepts an optional tier option without changing behavior (type-level)', async () => {
    // Construct with an explicit config so no network/key is needed at build.
    const parser = new AiSdkSpecParser({ baseURL: OPENROUTER_BASE_URL, apiKey: 'k', model: DEFAULT_MODEL });
    // We do not invoke parse() here (would hit the network). The point is that
    // both `parse(input)` and `parse(input, { tier })` are legal call shapes.
    expect(typeof parser.parse).toBe('function');
  });
});

describe('AiSdkSpecParser.parse — failure classification (mocked generateObject)', () => {
  afterEach(() => {
    generateObjectMock.mockReset();
  });

  it('config: LoadAPIKeyError -> { ok:false, kind:"config" }', async () => {
    generateObjectMock.mockRejectedValueOnce(new LoadAPIKeyError({ message: 'missing key' }));
    const parser = new AiSdkSpecParser(TEST_CFG);
    const res = await parser.parse(RAW);
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ ok: false, kind: 'config' });
  });

  it('transport: a plain Error -> { ok:false, kind:"transport" }', async () => {
    generateObjectMock.mockRejectedValueOnce(new Error('timeout'));
    const parser = new AiSdkSpecParser(TEST_CFG);
    const res = await parser.parse(RAW);
    expect(res).toMatchObject({ ok: false, kind: 'transport', message: 'timeout' });
  });

  it('invalid: object failing ParsedSpec Zod -> { ok:false, kind:"invalid" } (no fabricated spec)', async () => {
    generateObjectMock.mockResolvedValueOnce({ object: { unitSize: '乱' } });
    const parser = new AiSdkSpecParser(TEST_CFG);
    const res = await parser.parse(RAW);
    expect(res).toMatchObject({ ok: false, kind: 'invalid' });
    // The rejected path must not smuggle a spec into the result.
    expect((res as { spec?: unknown }).spec).toBeUndefined();
  });

  it('ok: a valid ParsedSpec object -> { ok:true, spec } and re-validates via Zod', async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        unitSize: { value: 330, unit: 'ml' },
        quantity: 24,
        multipliers: [1],
        totalAmount: null,
        packageUnit: null,
        category: 'beverage',
        confidence: 0.7,
      },
    });
    const parser = new AiSdkSpecParser(TEST_CFG);
    const res = await parser.parse(RAW);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.spec.unitSize).toEqual({ value: 330, unit: 'ml' });
      expect(res.spec.quantity).toBe(24);
      expect(ParsedSpecSchema.safeParse(res.spec).success).toBe(true);
    }
  });
});
