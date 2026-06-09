import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CorpusLoadError, loadCorpus } from './corpus.js';

describe('loadCorpus', () => {
  it('loads valid JSONL samples', () => {
    const jsonl = [
      '{"title":"水 550ml*24","source":"manual","priceCents":3590,"samPkgNum":24,"samPkgUnit":"瓶","samUnitPrice":1.5}',
      '{"title":"可乐 330ml*6","source":"har:cap.har","isCompare":true}',
    ].join('\n');

    const samples = loadCorpus(jsonl);

    expect(samples).toHaveLength(2);
    expect(samples[0]).toMatchObject({
      title: '水 550ml*24',
      source: 'manual',
      priceCents: 3590,
      samPkgNum: 24,
      samUnitPrice: 1.5,
    });
    expect(samples[1]).toMatchObject({ title: '可乐 330ml*6', isCompare: true });
  });

  it('accepts samples with only title (truth fields optional)', () => {
    const samples = loadCorpus('{"title":"某商品","source":"manual"}');
    expect(samples).toHaveLength(1);
    expect(samples[0]?.priceCents).toBeUndefined();
    expect(samples[0]?.samPkgNum).toBeUndefined();
  });

  it('ignores blank / whitespace-only lines', () => {
    const jsonl = '\n{"title":"水","source":"manual"}\n   \n';
    expect(loadCorpus(jsonl)).toHaveLength(1);
  });

  it('rejects a line missing title with its line number', () => {
    const jsonl = [
      '{"title":"水","source":"manual"}',
      '{"source":"manual","priceCents":100}',
    ].join('\n');

    try {
      loadCorpus(jsonl);
      expect.fail('expected loadCorpus to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CorpusLoadError);
      expect((err as CorpusLoadError).line).toBe(2);
      expect((err as Error).message).toContain('line 2');
      expect((err as Error).message).toContain('title');
    }
  });

  it('rejects a line with empty title with its line number', () => {
    const jsonl = '{"title":"","source":"manual"}';
    try {
      loadCorpus(jsonl);
      expect.fail('expected loadCorpus to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CorpusLoadError);
      expect((err as CorpusLoadError).line).toBe(1);
      expect((err as Error).message).toContain('non-empty');
    }
  });

  it('rejects a negative priceCents with its line number', () => {
    const jsonl = [
      '{"title":"水","source":"manual"}',
      '{"title":"X 330ml*6","source":"manual","priceCents":-6000}',
    ].join('\n');
    try {
      loadCorpus(jsonl);
      expect.fail('expected loadCorpus to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CorpusLoadError);
      expect((err as CorpusLoadError).line).toBe(2);
      expect((err as Error).message).toContain('line 2');
      expect((err as Error).message).toContain('priceCents');
    }
  });

  it('rejects invalid JSON with its line number, not a silent skip', () => {
    const jsonl = [
      '{"title":"水","source":"manual"}',
      '{not json}',
    ].join('\n');
    try {
      loadCorpus(jsonl);
      expect.fail('expected loadCorpus to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CorpusLoadError);
      expect((err as CorpusLoadError).line).toBe(2);
      expect((err as Error).message).toContain('invalid JSON');
    }
  });

  it('loads the desensitized sample corpus (smoke)', () => {
    const path = fileURLToPath(
      new URL('../corpus/beverages.sample.jsonl', import.meta.url),
    );
    const jsonl = readFileSync(path, 'utf8');
    const samples = loadCorpus(jsonl);
    expect(samples.length).toBeGreaterThanOrEqual(2);
    expect(samples[0]?.title).toBeTruthy();
  });
});
