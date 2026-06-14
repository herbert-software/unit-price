import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import { CategoryTreeResponseSchema } from './categories.js';
import { buildCategoriesUrl, parseCategoryTreeResponse } from './client.js';
import type { CategoryTreeNode } from './categories.js';

// A representative tree: root (rankable=false but rankableCount>0, the default
// ranking), a soft-drink parent + leaf (rankable=true via per_100ml), and an
// alcohol node (rankable=false, rankableCount=0). Covers the inheritance-derived
// distinctions the category-tree-api contract pins down.
const rootNode: CategoryTreeNode = {
  slug: 'beverage',
  name: '饮料',
  parentSlug: null,
  comparableUnit: null,
  rankable: false,
  rankableCount: 329,
};
const softDrinkLeaf: CategoryTreeNode = {
  slug: 'carbonated',
  name: '碳酸饮料',
  parentSlug: 'soft-drink',
  comparableUnit: 'per_100ml',
  rankable: true,
  rankableCount: 42,
};
const alcoholNode: CategoryTreeNode = {
  slug: 'alcohol',
  name: '酒类',
  parentSlug: 'beverage',
  comparableUnit: null,
  rankable: false,
  rankableCount: 0,
};
const validResponse = { nodes: [rootNode, softDrinkLeaf, alcoholNode] };

describe('CategoryTreeResponseSchema', () => {
  it('parses a valid tree: root rankable=false/count>0, soft-drink leaf, alcohol node', () => {
    expect(CategoryTreeResponseSchema.parse(validResponse)).toEqual(validResponse);
  });

  it('parses an empty tree (unseeded taxonomy → 200 { nodes: [] })', () => {
    expect(CategoryTreeResponseSchema.parse({ nodes: [] })).toEqual({ nodes: [] });
  });

  it('rejects a node missing a required field (slug)', () => {
    const { slug: _omit, ...missing } = rootNode;
    expect(() => CategoryTreeResponseSchema.parse({ nodes: [missing] })).toThrow(ZodError);
  });

  it('rejects a wrong-typed field (rankable not boolean)', () => {
    const bad = { nodes: [{ ...softDrinkLeaf, rankable: 'yes' }] };
    expect(() => CategoryTreeResponseSchema.parse(bad)).toThrow(ZodError);
  });

  it('rejects a non-integer rankableCount', () => {
    const bad = { nodes: [{ ...rootNode, rankableCount: 3.5 }] };
    expect(() => CategoryTreeResponseSchema.parse(bad)).toThrow(ZodError);
  });

  it('rejects a negative rankableCount', () => {
    const bad = { nodes: [{ ...rootNode, rankableCount: -1 }] };
    expect(() => CategoryTreeResponseSchema.parse(bad)).toThrow(ZodError);
  });

  it('rejects an unknown comparableUnit value (not in the core enum)', () => {
    const bad = { nodes: [{ ...softDrinkLeaf, comparableUnit: 'per_liter' }] };
    expect(() => CategoryTreeResponseSchema.parse(bad)).toThrow(ZodError);
  });

  it('rejects nodes that is not an array', () => {
    expect(() => CategoryTreeResponseSchema.parse({ nodes: rootNode })).toThrow(ZodError);
  });

  it('rejects a top-level body that is a bare array (must be wrapped in { nodes })', () => {
    expect(() => CategoryTreeResponseSchema.parse([rootNode])).toThrow(ZodError);
  });
});

describe('buildCategoriesUrl', () => {
  it('returns <origin>/categories for a clean origin (no query params)', () => {
    expect(buildCategoriesUrl('https://api.example.com')).toBe('https://api.example.com/categories');
  });

  it('regularizes one trailing slash on base', () => {
    expect(buildCategoriesUrl('https://api.example.com/')).toBe(
      'https://api.example.com/categories',
    );
  });

  it('accepts a canonical base WITH an explicit non-default port', () => {
    expect(buildCategoriesUrl('https://api.example.com:8080')).toBe(
      'https://api.example.com:8080/categories',
    );
  });

  it('fail-fast: base with a path segment throws (same contract as buildRankingsUrl)', () => {
    expect(() => buildCategoriesUrl('https://api.example.com/v1')).toThrow();
  });

  it('fail-fast: base with a query string throws', () => {
    expect(() => buildCategoriesUrl('https://api.example.com?a=1')).toThrow();
  });

  it('fail-fast: base with a fragment throws', () => {
    expect(() => buildCategoriesUrl('https://api.example.com#x')).toThrow();
  });

  it('fail-fast: empty-string base throws', () => {
    expect(() => buildCategoriesUrl('')).toThrow();
  });

  it('fail-fast: non-http(s) scheme base throws', () => {
    expect(() => buildCategoriesUrl('ftp://api.example.com')).toThrow();
  });

  it('fail-fast: base with userinfo throws', () => {
    expect(() => buildCategoriesUrl('https://user:pw@api.example.com')).toThrow();
  });

  it('fail-fast: special-scheme base without "//" throws', () => {
    expect(() => buildCategoriesUrl('https:api.example.com')).toThrow();
  });

  it('fail-fast: explicit default port (non-canonical) throws', () => {
    expect(() => buildCategoriesUrl('https://api.example.com:443')).toThrow();
  });

  it('fail-fast: uppercase host (non-canonical) throws', () => {
    expect(() => buildCategoriesUrl('https://API.EXAMPLE.COM')).toThrow();
  });
});

describe('parseCategoryTreeResponse', () => {
  // These exercise the jitless parse path (jitless: true is hardcoded inside
  // parseCategoryTreeResponse — the WeChat-weapp eval-disabled constraint).
  it('passes a valid response through and returns it (jitless path)', () => {
    expect(parseCategoryTreeResponse(validResponse)).toEqual(validResponse);
  });

  it('accepts an empty tree { nodes: [] } (jitless path)', () => {
    expect(parseCategoryTreeResponse({ nodes: [] })).toEqual({ nodes: [] });
  });

  it('throws ZodError (fail-closed) when a node field is missing (jitless path)', () => {
    const { name: _omit, ...missing } = rootNode;
    expect(() => parseCategoryTreeResponse({ nodes: [missing] })).toThrow(ZodError);
  });

  it('throws ZodError when rankableCount is non-integer (jitless path)', () => {
    expect(() => parseCategoryTreeResponse({ nodes: [{ ...rootNode, rankableCount: 1.5 }] })).toThrow(
      ZodError,
    );
  });

  it('throws ZodError when a field is wrong-typed (jitless path)', () => {
    expect(() =>
      parseCategoryTreeResponse({ nodes: [{ ...softDrinkLeaf, rankable: 1 }] }),
    ).toThrow(ZodError);
  });

  it('throws ZodError when nodes is not an array (jitless path)', () => {
    expect(() => parseCategoryTreeResponse({ nodes: 'x' })).toThrow(ZodError);
  });
});
