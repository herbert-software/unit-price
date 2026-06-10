// D1-branch verification via a minimal fake binding: createDb must tag a
// D1-shaped connection as kind 'd1', and saveParsed on that branch must issue
// its two inserts through a single batch() call (D1's atomic-write API) with
// no explicit BEGIN/COMMIT anywhere (D1 rejects explicit transactions).
//
// This pins the dispatch contract (which API our code calls); the platform
// semantics of batch() itself (atomic rollback, BEGIN rejected, FK enforced)
// are verified against real workerd D1 in d1-workerd.test.ts.
import {
  calculate,
  ParsedSpecSchema,
  type CalcResult,
  type ParsedSpec,
} from '@unit-price/core';
import { describe, expect, it } from 'vitest';
import { createDb, type D1BindingLike } from '../db.js';
import { createRepository } from '../repository.js';

/** Full consistent spec: 1L × 6 bottles, explicit 6L total. */
const fullSpec: ParsedSpec = ParsedSpecSchema.parse({
  unitSize: { value: 1, unit: 'L' },
  quantity: 6,
  multipliers: [1],
  totalAmount: { value: 6, unit: 'L' },
  packageUnit: '瓶',
  category: 'beverage',
  confidence: 0.9,
});

/** Real core output for the full spec at ¥39.9. */
const fullCalc: CalcResult = calculate(fullSpec, 39.9);

interface FakeStatement {
  sql: string;
  params: unknown[];
}

/**
 * Minimal D1-shaped binding: chainable prepared statements that record SQL,
 * and a batch() that records the statement group and returns D1Result shapes.
 */
function createFakeD1() {
  const preparedSql: string[] = [];
  const batchCalls: string[][] = [];
  const successResult = () => ({ success: true, results: [], meta: {} });

  const binding: D1BindingLike = {
    prepare(query: string) {
      preparedSql.push(query);
      const statement: FakeStatement & Record<string, unknown> = {
        sql: query,
        params: [],
        bind(...params: unknown[]) {
          statement.params = params;
          return statement;
        },
        async run() {
          return successResult();
        },
        async all() {
          return successResult();
        },
        async first() {
          return null;
        },
        async raw() {
          return [];
        },
      };
      return statement;
    },
    async batch(statements: unknown[]) {
      batchCalls.push(statements.map((s) => (s as FakeStatement).sql));
      return statements.map(successResult);
    },
  };
  return { binding, preparedSql, batchCalls };
}

describe('D1 branch dispatch (fake binding)', () => {
  it('createDb tags a D1-shaped binding as kind "d1"', () => {
    const { binding } = createFakeD1();
    expect(createDb(binding).kind).toBe('d1');
  });

  it('saveParsed issues exactly one batch of two INSERTs, with no explicit BEGIN', async () => {
    const { binding, preparedSql, batchCalls } = createFakeD1();
    const repo = createRepository(createDb(binding));

    await repo.saveParsed({ rawId: 'raw-1', spec: fullSpec, calc: fullCalc });

    expect(batchCalls).toHaveLength(1);
    const [statements] = batchCalls;
    expect(statements).toHaveLength(2);
    expect(statements![0]).toMatch(/^insert into "product"/i);
    expect(statements![1]).toMatch(/^insert into "unit_price"/i);
    expect(preparedSql.length).toBeGreaterThanOrEqual(2);
    for (const sql of preparedSql) {
      expect(sql).not.toMatch(/^begin/i);
    }
  });
});
