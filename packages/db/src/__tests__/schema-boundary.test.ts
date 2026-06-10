// Boundary assertions on the generated migration SQL and the migrated
// database: portable types only (no Postgres-only constructs) and no
// category/comparison tables (those belong to later changes).
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { countRows, migrationsFolder, openTestDb } from './harness.js';

function readMigrationSql(): string {
  const files = readdirSync(migrationsFolder).filter((f) => f.endsWith('.sql'));
  expect(files.length).toBeGreaterThan(0);
  return files
    .map((f) => readFileSync(join(migrationsFolder, f), 'utf8'))
    .join('\n');
}

describe('schema boundaries', () => {
  it('migration SQL contains no Postgres-only types', () => {
    const sql = readMigrationSql();
    expect(sql).not.toMatch(/jsonb/i);
    expect(sql).not.toMatch(/\bserial\b/i);
    expect(sql).not.toMatch(/\bnumeric\b/i);
    expect(sql).not.toMatch(/autoincrement/i);
    // Native array columns (`text[]`, `integer[]`, …).
    expect(sql).not.toMatch(/\w\[\]/);
  });

  it('primary keys are TEXT (app-generated ids, no integer autoincrement)', () => {
    const sql = readMigrationSql();
    const pkLines = sql
      .split('\n')
      .filter((line) => /PRIMARY KEY/i.test(line));
    expect(pkLines.length).toBeGreaterThan(0);
    for (const line of pkLines) {
      expect(line).toMatch(/text\s+PRIMARY KEY/i);
    }
  });

  it('creates only the four core tables — no category/comparison tables', () => {
    const { handle } = openTestDb();
    const names = (
      handle
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);

    for (const required of [
      'product_raw',
      'product',
      'unit_price',
      'corrections',
    ]) {
      expect(names).toContain(required);
    }
    for (const forbidden of [
      'tag',
      'product_tag',
      'store_category_map',
      'category_closure',
      'comparison_group',
    ]) {
      expect(names).not.toContain(forbidden);
    }
    // Nothing beyond the core tables + the drizzle migration journal.
    const unexpected = names.filter(
      (n) =>
        ![
          'product_raw',
          'product',
          'unit_price',
          'corrections',
          '__drizzle_migrations',
        ].includes(n),
    );
    expect(unexpected).toEqual([]);
  });

  it('re-running migrate on an already-migrated database is idempotent', () => {
    const { handle, db } = openTestDb();
    if (db.kind !== 'sqlite') {
      throw new Error('test expected a better-sqlite3-backed Db');
    }
    const before = countRows(handle, '__drizzle_migrations');
    expect(() => migrate(db.orm, { migrationsFolder })).not.toThrow();
    expect(countRows(handle, '__drizzle_migrations')).toBe(before);
  });
});
