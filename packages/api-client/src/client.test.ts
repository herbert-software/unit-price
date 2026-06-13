import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import { buildRankingsUrl, parseRankingsResponse } from './client.js';
import type { RankingsItem } from './rankings.js';

// A minimal valid ranking row, reused across parse tests.
const validItem: RankingsItem = {
  rank: 1,
  title: '可乐 330ml*24',
  priceCents: 4000,
  per100ml: 0.505,
  formula: '40 / (330 * 24 * 1) * 100',
  confidence: 0.95,
  warnings: [],
  store: 'sam',
  storeSku: 'sku-1',
  sourceUrl: null,
};

describe('buildRankingsUrl', () => {
  it('joins ONLY the given params (limit/offset given, category omitted → no category)', () => {
    expect(buildRankingsUrl('https://api.example.com', { limit: 50, offset: 100 })).toBe(
      'https://api.example.com/rankings?limit=50&offset=100',
    );
  });

  it('regularizes a trailing slash on base and returns <base>/rankings for all-default {}', () => {
    expect(buildRankingsUrl('https://api.example.com/', {})).toBe('https://api.example.com/rankings');
  });

  it('returns <base>/rankings when params is omitted entirely', () => {
    expect(buildRankingsUrl('https://api.example.com')).toBe('https://api.example.com/rankings');
  });

  it('encodes param values with encodeURIComponent', () => {
    expect(buildRankingsUrl('https://api.example.com', { category: 'soft drink' })).toBe(
      'https://api.example.com/rankings?category=soft%20drink',
    );
  });

  it('serializes server-400 values verbatim WITHOUT throwing or mutating (limit:0)', () => {
    expect(buildRankingsUrl('https://api.example.com', { limit: 0 })).toBe(
      'https://api.example.com/rankings?limit=0',
    );
  });

  it('serializes a non-enum category verbatim WITHOUT throwing (category:alcohol)', () => {
    expect(buildRankingsUrl('https://api.example.com', { category: 'alcohol' })).toBe(
      'https://api.example.com/rankings?category=alcohol',
    );
  });

  it('joins all three given params in limit/offset/category order', () => {
    expect(
      buildRankingsUrl('https://api.example.com', { limit: 20, offset: 40, category: 'beverage' }),
    ).toBe('https://api.example.com/rankings?limit=20&offset=40&category=beverage');
  });

  it('fail-fast: base with a path segment throws', () => {
    expect(() => buildRankingsUrl('https://api.example.com/v1', { limit: 10 })).toThrow();
  });

  it('fail-fast: base with a query string throws', () => {
    expect(() => buildRankingsUrl('https://api.example.com?a=1', { limit: 10 })).toThrow();
  });

  it('fail-fast: base with a fragment throws', () => {
    expect(() => buildRankingsUrl('https://api.example.com#x', {})).toThrow();
  });

  it('fail-fast: empty-string base throws', () => {
    expect(() => buildRankingsUrl('', {})).toThrow();
  });

  it('fail-fast: non-http(s) scheme base throws', () => {
    expect(() => buildRankingsUrl('ftp://api.example.com', {})).toThrow();
  });

  it('fail-fast: base with userinfo throws', () => {
    expect(() => buildRankingsUrl('https://user:pw@api.example.com', {})).toThrow();
  });

  it('fail-fast: non-canonical base with a dot-segment throws (not silently normalized)', () => {
    // `https://x/.` parses (pathname normalizes to "/") but is NOT a canonical
    // origin — the strict equality gate rejects it rather than canonicalizing.
    expect(() => buildRankingsUrl('https://api.example.com/.', { limit: 5 })).toThrow();
  });

  it('fail-fast: special-scheme base without "//" throws (not silently normalized)', () => {
    // `https:api.example.com` parses to a real origin but its raw form is not the
    // canonical `https://api.example.com` → rejected.
    expect(() => buildRankingsUrl('https:api.example.com', {})).toThrow();
  });

  it('fail-fast: explicit default port (non-canonical) throws', () => {
    // `:443` is the https default; `parsed.origin` drops it, so the raw base is
    // non-canonical and rejected.
    expect(() => buildRankingsUrl('https://api.example.com:443', {})).toThrow();
  });

  it('fail-fast: uppercase host (non-canonical) throws', () => {
    // `parsed.origin` lowercases the host, so an uppercase raw host ≠ origin.
    expect(() => buildRankingsUrl('https://API.EXAMPLE.COM', {})).toThrow();
  });

  it('fail-fast: uppercase scheme (non-canonical) throws', () => {
    // `parsed.origin` lowercases the scheme, so `HTTP://...` raw ≠ origin.
    expect(() => buildRankingsUrl('HTTP://api.example.com', {})).toThrow();
  });

  it('fail-fast: double trailing slash (non-canonical) throws', () => {
    // Only ONE trailing slash is stripped; `https://x//` → `https://x/` ≠ origin.
    expect(() => buildRankingsUrl('https://api.example.com//', {})).toThrow();
  });

  it('accepts a canonical base WITH an explicit non-default port', () => {
    expect(buildRankingsUrl('https://api.example.com:8080', { offset: 0 })).toBe(
      'https://api.example.com:8080/rankings?offset=0',
    );
  });
});

describe('parseRankingsResponse', () => {
  it('passes a valid response array through and returns it', () => {
    const json: unknown = [validItem];
    const parsed = parseRankingsResponse(json);
    expect(parsed).toEqual([validItem]);
  });

  it('accepts an empty array (empty library / out-of-range offset)', () => {
    expect(parseRankingsResponse([])).toEqual([]);
  });

  it('throws ZodError when warnings is not string[]', () => {
    const bad: unknown = [{ ...validItem, warnings: [1, 2, 3] }];
    expect(() => parseRankingsResponse(bad)).toThrow(ZodError);
  });

  it('throws ZodError when a required field is missing', () => {
    const { per100ml: _omit, ...missingField } = validItem;
    const bad: unknown = [missingField];
    expect(() => parseRankingsResponse(bad)).toThrow(ZodError);
  });

  it('throws ZodError when the top-level body is not an array', () => {
    expect(() => parseRankingsResponse({ items: [validItem] })).toThrow(ZodError);
  });
});
