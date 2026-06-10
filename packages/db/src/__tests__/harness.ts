// Test harness: in-memory better-sqlite3 with the real Drizzle migrations
// applied, and `PRAGMA foreign_keys=ON` set explicitly — bare SQLite defaults
// foreign keys OFF and driver behavior can drift across versions/swaps, while
// D1 always enforces them; without the pragma the saveParsed FK/rollback
// assertions would pass vacuously.
import Database from 'better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { fileURLToPath } from 'node:url';
import { createDb, type Db } from '../db.js';
import { createRepository, type Repository } from '../repository.js';

export const migrationsFolder = fileURLToPath(
  new URL('../../drizzle', import.meta.url),
);

export interface TestDb {
  handle: Database.Database;
  db: Db;
  repo: Repository;
}

export function openTestDb(): TestDb {
  const handle = new Database(':memory:');
  handle.pragma('foreign_keys = ON');
  const db = createDb(handle);
  if (db.kind !== 'sqlite') {
    throw new Error('test harness expected a better-sqlite3-backed Db');
  }
  migrate(db.orm, { migrationsFolder });
  return { handle, db, repo: createRepository(db) };
}

export function countRows(handle: Database.Database, table: string): number {
  const row = handle
    .prepare(`SELECT count(*) AS c FROM ${table}`)
    .get() as { c: number };
  return row.c;
}
