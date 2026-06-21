import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import {
  ComputeRequestSchema,
  ComputeResultSchema,
  buildComputeUrl,
  parseComputeResponse,
  type ComputeRequest,
  type ComputeResult,
} from './compute.js';
import type { RankingsItem } from './rankings.js';

// A minimal valid neighbor row (mirrors client.test.ts's validItem) — proves the
// response REUSES RankingsItemSchema verbatim for `neighbors`.
const validNeighbor: RankingsItem = {
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

// A representative valid request: per-unit size × quantity path, ml axis.
const validRequest: ComputeRequest = {
  totalPrice: 40,
  quantity: 24,
  unitSize: { value: 330, unit: 'ml' },
  category: 'soft-drink',
};

// A representative valid result: per100ml axis, positioned with one neighbor.
const validResult: ComputeResult = {
  per100ml: 0.505,
  per100g: null,
  formula: '40 / (330 * 24 * 1) * 100',
  axis: 'per_100ml',
  rank: 1,
  total: 42,
  percentile: 0,
  neighbors: [validNeighbor],
};

describe('ComputeRequestSchema', () => {
  it('round-trips a valid unitSize+quantity request unchanged', () => {
    expect(ComputeRequestSchema.parse(validRequest)).toEqual(validRequest);
  });

  it('round-trips a valid totalAmount request unchanged', () => {
    const req: ComputeRequest = {
      totalPrice: 12.5,
      totalAmount: { value: 1.5, unit: 'L' },
      category: 'soft-drink',
    };
    expect(ComputeRequestSchema.parse(req)).toEqual(req);
  });

  it('accepts a g/kg mass request (axis legality is the server concern, not this schema)', () => {
    const req: ComputeRequest = {
      totalPrice: 30,
      quantity: 6,
      unitSize: { value: 500, unit: 'g' },
      category: 'dairy',
    };
    expect(ComputeRequestSchema.parse(req)).toEqual(req);
  });

  it('rejects totalPrice <= 0 (zero)', () => {
    expect(() => ComputeRequestSchema.parse({ ...validRequest, totalPrice: 0 })).toThrow(ZodError);
  });

  it('rejects totalPrice <= 0 (negative)', () => {
    expect(() => ComputeRequestSchema.parse({ ...validRequest, totalPrice: -5 })).toThrow(ZodError);
  });

  it('rejects a non-positive unitSize value', () => {
    const bad = { ...validRequest, unitSize: { value: 0, unit: 'ml' } };
    expect(() => ComputeRequestSchema.parse(bad)).toThrow(ZodError);
  });

  it('rejects an illegal unit (not in ml/L/g/kg)', () => {
    const bad = { ...validRequest, unitSize: { value: 330, unit: 'oz' } };
    expect(() => ComputeRequestSchema.parse(bad)).toThrow(ZodError);
  });

  it('rejects a non-integer quantity', () => {
    expect(() => ComputeRequestSchema.parse({ ...validRequest, quantity: 2.5 })).toThrow(ZodError);
  });

  it('rejects a non-positive quantity', () => {
    expect(() => ComputeRequestSchema.parse({ ...validRequest, quantity: 0 })).toThrow(ZodError);
  });

  it('rejects an empty category', () => {
    expect(() => ComputeRequestSchema.parse({ ...validRequest, category: '' })).toThrow(ZodError);
  });

  it('rejects a missing category', () => {
    const { category: _omit, ...missing } = validRequest;
    expect(() => ComputeRequestSchema.parse(missing)).toThrow(ZodError);
  });

  it('rejects a missing totalPrice', () => {
    const { totalPrice: _omit, ...missing } = validRequest;
    expect(() => ComputeRequestSchema.parse(missing)).toThrow(ZodError);
  });

  it('rejects a body with BOTH unitSize AND totalAmount (二选一互斥)', () => {
    const both = {
      totalPrice: 40,
      quantity: 24,
      unitSize: { value: 330, unit: 'ml' },
      totalAmount: { value: 1500, unit: 'ml' },
      category: 'soft-drink',
    };
    expect(() => ComputeRequestSchema.parse(both)).toThrow(ZodError);
  });

  it('accepts totalAmount-only (the other mutually-exclusive path still passes)', () => {
    const req: ComputeRequest = {
      totalPrice: 12.5,
      totalAmount: { value: 1.5, unit: 'L' },
      category: 'soft-drink',
    };
    expect(ComputeRequestSchema.parse(req)).toEqual(req);
  });
});

describe('ComputeResultSchema', () => {
  it('round-trips a valid per100ml result unchanged', () => {
    expect(ComputeResultSchema.parse(validResult)).toEqual(validResult);
  });

  it('round-trips a valid per100g result (other axis) unchanged', () => {
    const res: ComputeResult = {
      per100ml: null,
      per100g: 1.2,
      formula: '36 / (500 * 6 * 1) * 100',
      axis: 'per_100g',
      rank: 3,
      total: 10,
      percentile: 20,
      neighbors: [],
    };
    expect(ComputeResultSchema.parse(res)).toEqual(res);
  });

  it('accepts empty neighbors (empty/boundary cohort → 200, not 404)', () => {
    expect(ComputeResultSchema.parse({ ...validResult, neighbors: [] })).toEqual({
      ...validResult,
      neighbors: [],
    });
  });

  it('rejects an empty formula (a successful result always carries one)', () => {
    expect(() => ComputeResultSchema.parse({ ...validResult, formula: '' })).toThrow(ZodError);
  });

  it('rejects an unknown axis value', () => {
    expect(() => ComputeResultSchema.parse({ ...validResult, axis: 'per_liter' })).toThrow(ZodError);
  });

  it('rejects rank < 1', () => {
    expect(() => ComputeResultSchema.parse({ ...validResult, rank: 0 })).toThrow(ZodError);
  });

  it('rejects a negative total', () => {
    expect(() => ComputeResultSchema.parse({ ...validResult, total: -1 })).toThrow(ZodError);
  });

  it('rejects a malformed neighbor row (missing required RankingsItem field)', () => {
    const { per100ml: _omit, ...badNeighbor } = validNeighbor;
    const bad = { ...validResult, neighbors: [badNeighbor] };
    expect(() => ComputeResultSchema.parse(bad)).toThrow(ZodError);
  });

  it('rejects a neighbor with wrong-typed warnings (not string[])', () => {
    const bad = { ...validResult, neighbors: [{ ...validNeighbor, warnings: [1, 2] }] };
    expect(() => ComputeResultSchema.parse(bad)).toThrow(ZodError);
  });

  it('rejects a both-null result (uncomputable is a 400, never a 200 with two nulls)', () => {
    const bad = { ...validResult, per100ml: null, per100g: null };
    expect(() => ComputeResultSchema.parse(bad)).toThrow(ZodError);
  });

  it('rejects a both-non-null result (exactly one axis must be non-null)', () => {
    const bad = { ...validResult, per100ml: 0.5, per100g: 1.2 };
    expect(() => ComputeResultSchema.parse(bad)).toThrow(ZodError);
  });

  it('rejects an axis-mismatched result (axis per_100ml but per100g is the non-null one)', () => {
    const bad = { ...validResult, axis: 'per_100g', per100ml: 0.5, per100g: null };
    expect(() => ComputeResultSchema.parse(bad)).toThrow(ZodError);
  });

  it('parseComputeResponse fails a both-null body (jitless path)', () => {
    const bad = { ...validResult, per100ml: null, per100g: null };
    expect(() => parseComputeResponse(bad)).toThrow(ZodError);
  });
});

describe('buildComputeUrl', () => {
  it('returns <origin>/compute for a clean origin (no query params)', () => {
    expect(buildComputeUrl('https://api.example.com')).toBe('https://api.example.com/compute');
  });

  it('regularizes one trailing slash on base', () => {
    expect(buildComputeUrl('https://api.example.com/')).toBe('https://api.example.com/compute');
  });

  it('accepts a canonical base WITH an explicit non-default port', () => {
    expect(buildComputeUrl('https://api.example.com:8080')).toBe(
      'https://api.example.com:8080/compute',
    );
  });

  it('fail-fast: base with a path segment throws (same contract as buildRankingsUrl)', () => {
    expect(() => buildComputeUrl('https://api.example.com/v1')).toThrow();
  });

  it('fail-fast: base with a query string throws', () => {
    expect(() => buildComputeUrl('https://api.example.com?a=1')).toThrow();
  });

  it('fail-fast: base with a fragment throws', () => {
    expect(() => buildComputeUrl('https://api.example.com#x')).toThrow();
  });

  it('fail-fast: empty-string base throws', () => {
    expect(() => buildComputeUrl('')).toThrow();
  });

  it('fail-fast: non-http(s) scheme base throws', () => {
    expect(() => buildComputeUrl('ftp://api.example.com')).toThrow();
  });

  it('fail-fast: base with userinfo throws', () => {
    expect(() => buildComputeUrl('https://user:pw@api.example.com')).toThrow();
  });

  it('fail-fast: special-scheme base without "//" throws', () => {
    expect(() => buildComputeUrl('https:api.example.com')).toThrow();
  });

  it('fail-fast: explicit default port (non-canonical) throws', () => {
    expect(() => buildComputeUrl('https://api.example.com:443')).toThrow();
  });

  it('fail-fast: uppercase host (non-canonical) throws', () => {
    expect(() => buildComputeUrl('https://API.EXAMPLE.COM')).toThrow();
  });
});

describe('parseComputeResponse', () => {
  // These exercise the jitless parse path (jitless: true is hardcoded inside
  // parseComputeResponse — the WeChat-weapp eval-disabled constraint).
  it('passes a valid response through and returns it (jitless path)', () => {
    expect(parseComputeResponse(validResult)).toEqual(validResult);
  });

  it('passes a valid empty-neighbors response (jitless path)', () => {
    const res = { ...validResult, neighbors: [] };
    expect(parseComputeResponse(res)).toEqual(res);
  });

  it('throws ZodError (fail-closed) when formula is empty (jitless path)', () => {
    expect(() => parseComputeResponse({ ...validResult, formula: '' })).toThrow(ZodError);
  });

  it('throws ZodError when a required field is missing (jitless path)', () => {
    const { axis: _omit, ...missing } = validResult;
    expect(() => parseComputeResponse(missing)).toThrow(ZodError);
  });

  it('throws ZodError when a neighbor row is malformed (jitless path)', () => {
    const bad = { ...validResult, neighbors: [{ ...validNeighbor, warnings: 'nope' }] };
    expect(() => parseComputeResponse(bad)).toThrow(ZodError);
  });

  it('throws ZodError when the body is not an object (jitless path)', () => {
    expect(() => parseComputeResponse([validResult])).toThrow(ZodError);
  });
});

describe('compute.ts does NOT depend on core (decision D3 — keeps it weapp-safe)', () => {
  // Static source check on the IMPORT GRAPH only: compute.ts MUST NOT import
  // `@unit-price/core` / `packages/core`. Reusing RankingsItemSchema is via the
  // sibling `./rankings.js` module (intra-package), never a direct core import.
  // This guards the invariant that dragging core through api-client into weapp
  // re-triggers the known transpile + eval-ban pitfalls. We scan ESM
  // import/export-from statements (NOT prose) so the comment that DOCUMENTS the
  // constraint can mention core without tripping the check.
  const rawSource = readFileSync(fileURLToPath(new URL('./compute.ts', import.meta.url)), 'utf8');
  // Strip block + line comments so the comment that DOCUMENTS the no-core
  // constraint (it mentions `@unit-price/core` in prose) cannot trip the check —
  // we scan only real import/export-from statements.
  const source = rawSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const moduleSpecifiers = [...source.matchAll(/(?:import|export)[^'"`;]*?from\s*['"`]([^'"`]+)['"`]/g)]
    .map((m) => m[1])
    .concat([...source.matchAll(/import\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1]));

  it('imports no module from @unit-price/core', () => {
    expect(moduleSpecifiers.some((s) => s.includes('@unit-price/core'))).toBe(false);
  });

  it('imports no module from packages/core', () => {
    expect(moduleSpecifiers.some((s) => s.includes('packages/core'))).toBe(false);
  });

  it('its only non-sibling import specifier is zod (sibling = ./rankings.js, ./client.js)', () => {
    // Sanity: every import resolves to zod or an intra-package sibling — proving
    // the reuse of RankingsItemSchema is via ./rankings.js, not core.
    for (const spec of moduleSpecifiers) {
      expect(spec === 'zod' || spec.startsWith('./')).toBe(true);
    }
  });
});
