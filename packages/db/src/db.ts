// Connection layer: wraps an injected connection (Cloudflare D1 binding in
// production, better-sqlite3 handle locally/in tests) into a tagged drizzle
// instance. This layer never fetches a binding itself — the caller injects it.
//
// A missing/unopenable connection fails loudly at initialization; we never
// return a seemingly usable empty instance.
//
// The union is tagged because atomic-write semantics differ per driver:
// better-sqlite3 transactions are native and synchronous (the callback must
// not await), while D1 rejects explicit BEGIN/COMMIT — atomic writes go
// through `batch()` (the whole group commits or rolls back together).
import type { Database as SqliteHandle } from 'better-sqlite3';
import {
  drizzle as drizzleSqlite,
  type BetterSQLite3Database,
} from 'drizzle-orm/better-sqlite3';
import {
  drizzle as drizzleD1,
  type AnyD1Database,
  type DrizzleD1Database,
} from 'drizzle-orm/d1';
import * as schema from './schema.js';

/** Minimal structural shape of a Cloudflare D1 binding (Worker-injected). */
export interface D1BindingLike {
  prepare(query: string): unknown;
  batch(statements: unknown[]): Promise<unknown[]>;
}

/** An injectable connection: open better-sqlite3 handle or D1 binding. */
export type DbConnection = SqliteHandle | D1BindingLike;

/** Tagged drizzle database; the tag drives per-driver transaction handling. */
export type Db =
  | { kind: 'sqlite'; orm: BetterSQLite3Database<typeof schema> }
  | { kind: 'd1'; orm: DrizzleD1Database<typeof schema> };

function isSqliteHandle(connection: DbConnection): connection is SqliteHandle {
  return typeof (connection as SqliteHandle).pragma === 'function';
}

function isD1Binding(connection: DbConnection): connection is D1BindingLike {
  return (
    typeof (connection as D1BindingLike).batch === 'function' &&
    typeof (connection as D1BindingLike).prepare === 'function'
  );
}

/**
 * Initialize the database from an injected connection. Throws a clear error
 * when the connection is missing, closed, or of an unrecognized shape.
 */
export function createDb(connection: DbConnection | null | undefined): Db {
  if (connection == null) {
    throw new Error(
      'DB connection missing: inject a Cloudflare D1 binding or an open better-sqlite3 handle',
    );
  }
  if (isSqliteHandle(connection)) {
    if (!connection.open) {
      throw new Error(
        'DB connection unusable: the better-sqlite3 handle is not open',
      );
    }
    // Idempotent defense: bare SQLite defaults foreign_keys OFF and driver
    // behavior can drift across versions/swaps — explicit ON aligns with
    // D1's always-enforced foreign keys.
    connection.pragma('foreign_keys = ON');
    return { kind: 'sqlite', orm: drizzleSqlite(connection, { schema }) };
  }
  if (isD1Binding(connection)) {
    return {
      kind: 'd1',
      orm: drizzleD1(connection as unknown as AnyD1Database, { schema }),
    };
  }
  throw new Error(
    'DB connection unrecognized: expected a D1 binding or a better-sqlite3 handle',
  );
}
