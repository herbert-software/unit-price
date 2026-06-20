import { describe, it, expect } from 'vitest';
import { readBoardParams, deriveBoardTitle } from './params';

describe('readBoardParams', () => {
  it('reads category; folds missing/blank to undefined (un-scoped list)', () => {
    expect(readBoardParams({ category: 'soft-drink' }).category).toBe('soft-drink');
    expect(readBoardParams({}).category).toBeUndefined();
    expect(readBoardParams({ category: '' }).category).toBeUndefined();
  });

  it('name defaults when absent', () => {
    expect(readBoardParams({}).name).toBe('分类榜');
  });

  it('decodes an encoded name', () => {
    expect(readBoardParams({ name: encodeURIComponent('软饮') }).name).toBe('软饮');
  });

  it('never throws on a name with a literal % (already-decoded input)', () => {
    // decodeURIComponent('100%纯果汁') would throw URIError → fallback to raw.
    expect(readBoardParams({ name: '100%纯果汁' }).name).toBe('100%纯果汁');
  });
});

// NOTE: these q tests are decode-strategy-CONDITIONAL. They simulate the documented
// assumption "Taro onLoad decodes the query once" by feeding readBoardParams the
// ALREADY-DECODED value (what SearchEntry's single encodeURIComponent + one onLoad
// decode yields). They do NOT prove the platform's actual decode count — that is
// pinned only by the real-device measurement in task 5.3.
describe('readBoardParams — q (deterministic, no second decode)', () => {
  it('passes a plain CJK q through unchanged', () => {
    expect(readBoardParams({ q: '可乐' }).q).toBe('可乐');
  });

  it('preserves a literal valid-looking escape byte-for-byte (no double decode)', () => {
    // The killer case: a SECOND decodeURIComponent would fold `%20` → space,
    // silently rewriting `100%20纯` to `100 纯`. readBoardParams must NOT decode q.
    expect(readBoardParams({ q: '100%20纯' }).q).toBe('100%20纯');
    expect(readBoardParams({ q: 'a%20b' }).q).toBe('a%20b');
  });

  it('preserves an incomplete escape byte-for-byte (would throw if re-decoded)', () => {
    expect(readBoardParams({ q: '100%' }).q).toBe('100%');
  });

  it('preserves a literal + byte-for-byte (no `+`→space query folding)', () => {
    expect(readBoardParams({ q: '100+200' }).q).toBe('100+200');
  });

  it('q absent → undefined; blank q → undefined (not a search)', () => {
    expect(readBoardParams({}).q).toBeUndefined();
    expect(readBoardParams({ q: '' }).q).toBeUndefined();
  });
});

describe('deriveBoardTitle — precedence on the DECODED, non-empty q', () => {
  it('decoded non-empty q → 搜索：<decoded q> (uses the decoded term, not encoded)', () => {
    expect(deriveBoardTitle('可乐', undefined)).toBe('搜索：可乐');
    expect(deriveBoardTitle('100%20纯', undefined)).toBe('搜索：100%20纯');
  });

  it('q wins over name when both present (future cohort-scoped search)', () => {
    expect(deriveBoardTitle('可乐', '软饮')).toBe('搜索：可乐');
  });

  it('name-only (分类下钻) → name', () => {
    expect(deriveBoardTitle(undefined, '软饮')).toBe('软饮');
  });

  it('blank/whitespace q → falls through to name (no empty 搜索：)', () => {
    expect(deriveBoardTitle('', '软饮')).toBe('软饮');
    expect(deriveBoardTitle('   ', '软饮')).toBe('软饮');
  });

  it('neither q nor name (hand-typed route) → default 分类榜', () => {
    expect(deriveBoardTitle(undefined, undefined)).toBe('分类榜');
    expect(deriveBoardTitle('', undefined)).toBe('分类榜');
  });

  it('readBoardParams wires the precedence: q-only route titles 搜索：<q>', () => {
    expect(readBoardParams({ q: '可乐' }).name).toBe('搜索：可乐');
  });
});
