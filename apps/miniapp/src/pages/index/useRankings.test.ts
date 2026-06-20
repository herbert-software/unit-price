import { describe, it, expect, vi } from 'vitest';

// useRankings.ts imports @tarojs/taro at module load (for Taro.request). Stub it so
// the pure buildPageUrl helper can be imported under vitest without the native
// runtime. We only exercise buildPageUrl here (URL threading), not the hook itself —
// a React/Taro renderer isn't wired up in this package.
vi.mock('@tarojs/taro', () => ({ default: { request: vi.fn() } }));
// config.ts reads a BASE constant; import the real one (no Taro dep).

import { buildPageUrl } from './useRankings';
import { PAGE_SIZE } from './config';

const BASE = 'https://api.example.com';

describe('buildPageUrl — pagination keeps the q filter (regression for runNext)', () => {
  it('page 1 (offset 0) carries q', () => {
    expect(buildPageUrl(BASE, 0, undefined, '可乐')).toBe(
      `${BASE}/rankings?limit=${PAGE_SIZE}&offset=0&q=%E5%8F%AF%E4%B9%90`,
    );
  });

  it('page 2 (offset = PAGE_SIZE) STILL carries the same q (not dropped/staled)', () => {
    // The whole point of task 4.1: runNext must thread q into fetchPage too, or
    // page 2 would request /rankings WITHOUT q and mix cohort rows into the search.
    expect(buildPageUrl(BASE, PAGE_SIZE, undefined, '可乐')).toBe(
      `${BASE}/rankings?limit=${PAGE_SIZE}&offset=${PAGE_SIZE}&q=%E5%8F%AF%E4%B9%90`,
    );
  });

  it('q + category coexist across pages', () => {
    expect(buildPageUrl(BASE, PAGE_SIZE, 'soft-drink', '可乐')).toBe(
      `${BASE}/rankings?limit=${PAGE_SIZE}&offset=${PAGE_SIZE}&category=soft-drink&q=%E5%8F%AF%E4%B9%90`,
    );
  });

  it('no q → URL identical to the un-scoped 榜单 behavior (no q= key)', () => {
    expect(buildPageUrl(BASE, PAGE_SIZE, undefined, undefined)).toBe(
      `${BASE}/rankings?limit=${PAGE_SIZE}&offset=${PAGE_SIZE}`,
    );
  });
});
