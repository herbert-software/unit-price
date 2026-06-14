// Boundary assertions on the generated migration SQL and the migrated
// database: portable types only (no Postgres-only constructs); the taxonomy
// tables (tag/product_tag/store_category_map/category_closure) now exist, but
// `comparison_group` stays forbidden (comparison is a dynamic query, never a
// materialized table).
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

  it('creates the core + taxonomy tables — but never comparison_group', () => {
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
      'tag',
      'product_tag',
      'store_category_map',
      'category_closure',
    ]) {
      expect(names).toContain(required);
    }
    // comparison_group is forbidden: comparison is a dynamic query (category
    // closure ∧ attribute), never a materialized table.
    expect(names).not.toContain('comparison_group');
    // Nothing beyond the known tables + the drizzle migration journal.
    const unexpected = names.filter(
      (n) =>
        ![
          'product_raw',
          'product',
          'unit_price',
          'corrections',
          'tag',
          'product_tag',
          'store_category_map',
          'category_closure',
          '__drizzle_migrations',
        ].includes(n),
    );
    expect(unexpected).toEqual([]);
  });

  it('adds the two product columns with portable types (rankable NOT NULL DEFAULT 0)', () => {
    const { handle } = openTestDb();
    const cols = handle
      .prepare("PRAGMA table_info('product')")
      .all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const pending = cols.find((c) => c.name === 'pending_category_tag_id');
    const rankable = cols.find((c) => c.name === 'rankable');
    expect(pending).toBeDefined();
    // pending is nullable TEXT (no NOT NULL constraint).
    expect(pending?.type.toUpperCase()).toContain('TEXT');
    expect(pending?.notnull).toBe(0);
    // rankable is INTEGER NOT NULL DEFAULT 0 — safe to add on a non-empty table.
    expect(rankable).toBeDefined();
    expect(rankable?.type.toUpperCase()).toContain('INT');
    expect(rankable?.notnull).toBe(1);
    expect(String(rankable?.dflt_value)).toBe('0');
  });

  it('seeds no placeholder comparable units (per_100g / per_100sheet)', async () => {
    const { handle, db } = openTestDb();
    const { seedTaxonomy } = await import('../seed.js');
    await seedTaxonomy(db);
    const units = (
      handle
        .prepare(
          'SELECT DISTINCT comparable_unit AS u FROM tag WHERE comparable_unit IS NOT NULL',
        )
        .all() as Array<{ u: string }>
    ).map((r) => r.u);
    expect(units).not.toContain('per_100g');
    expect(units).not.toContain('per_100sheet');
    expect(units).toEqual(['per_100ml']);
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
