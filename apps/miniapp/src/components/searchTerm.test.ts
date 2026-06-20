import { describe, it, expect } from 'vitest';
import { normalizeSearchTerm } from './searchTerm';

describe('normalizeSearchTerm — code-point length gate (NOT UTF-16 .length)', () => {
  it('0 code points (empty / whitespace-only) → empty (no nav, no request)', () => {
    expect(normalizeSearchTerm('')).toEqual({ kind: 'empty' });
    expect(normalizeSearchTerm('   ')).toEqual({ kind: 'empty' });
    // Full-width space is stripped by ECMAScript trim → also empty.
    expect(normalizeSearchTerm('　')).toEqual({ kind: 'empty' });
  });

  it('1 code point → too-short (server 400 parity, inline hint)', () => {
    expect(normalizeSearchTerm('水')).toEqual({ kind: 'too-short' });
    expect(normalizeSearchTerm(' 水 ')).toEqual({ kind: 'too-short' });
    // A single astral code point (𠮷) is ONE code point — UTF-16 .length would say
    // 2 and wrongly pass the gate; the code-point count correctly rejects it.
    expect('𠮷'.length).toBe(2); // sanity: surrogate pair occupies 2 UTF-16 units
    expect(normalizeSearchTerm('𠮷')).toEqual({ kind: 'too-short' });
  });

  it('2 code points → ok (trimmed term)', () => {
    expect(normalizeSearchTerm('可乐')).toEqual({ kind: 'ok', term: '可乐' });
    // Two astral code points pass even though UTF-16 .length is 4.
    expect(normalizeSearchTerm('𠮷𠮷')).toEqual({ kind: 'ok', term: '𠮷𠮷' });
  });

  it('truncates to 64 code points (BMP) without splitting', () => {
    const term65 = '可'.repeat(65);
    const res = normalizeSearchTerm(term65);
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') {
      expect([...res.term].length).toBe(64);
      expect(res.term).toBe('可'.repeat(64));
    }
  });

  it('truncates by code point at a surrogate-pair boundary (no orphan surrogate)', () => {
    // 65 astral code points = 130 UTF-16 units. A naive .slice(0, 64) on the raw
    // string would cut mid-pair; code-point truncation must keep exactly 64 whole
    // code points and never leave a lone surrogate.
    const term65 = '𠮷'.repeat(65);
    const res = normalizeSearchTerm(term65);
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') {
      expect([...res.term].length).toBe(64);
      expect(res.term).toBe('𠮷'.repeat(64));
      // No unpaired surrogate left dangling.
      expect(res.term).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    }
  });
});
