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

// Taro hands params RAW (task 5.3): the value here is SearchEntry's
// encodeURIComponent output, so readBoardParams decodes it exactly once. Feed encoded
// inputs and assert the decoded term, matching the real end-to-end round-trip.
describe('readBoardParams — q (decode once)', () => {
  it('decodes a plain CJK q', () => {
    expect(readBoardParams({ q: encodeURIComponent('可乐') }).q).toBe('可乐');
  });

  it('round-trips a term containing a literal escape (no over/under decode)', () => {
    // SearchEntry sends encodeURIComponent('100%20纯') = '100%2520%E7%BA%AF';
    // exactly one decode here must restore '100%20纯', not fold %20 → space.
    expect(readBoardParams({ q: encodeURIComponent('100%20纯') }).q).toBe('100%20纯');
    expect(readBoardParams({ q: encodeURIComponent('a%20b') }).q).toBe('a%20b');
  });

  it('round-trips a term containing a literal + (encodeURIComponent → %2B)', () => {
    expect(readBoardParams({ q: encodeURIComponent('100+200') }).q).toBe('100+200');
  });

  it('falls back to raw on a malformed escape (hand-typed route, no crash)', () => {
    expect(readBoardParams({ q: '100%' }).q).toBe('100%');
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
