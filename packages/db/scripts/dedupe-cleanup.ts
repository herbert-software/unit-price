// One-shot, OPTIONAL historical-dedup cleanup for a NON-EMPTY legacy `product`
// table, to be run BEFORE applying the `dedupe_key` column + unique-index
// migration. It collapses equivalent `product` rows (and their `unit_price`)
// down to the oldest one per dedupe key.
//
// Migration paths (single source of truth: the empty table is the only
// automatically-supported path):
//   • Empty table — the ONLY auto-supported path. SQLite adds the NOT NULL
//     `dedupe_key` column + UNIQUE INDEX to an empty table directly (prod will
//     drop the whole records table; the test harness uses an empty `:memory:`
//     db), with no back-fill and no unique-index collisions. This script is NOT
//     needed there.
//   • Non-empty legacy db (local data that may contain equivalent duplicates) —
//     NOT auto-supported (SQLite rejects adding a NOT NULL no-DEFAULT column to
//     a non-empty table, and a back-fill would collide on the new unique index).
//     Resolve by either (a) drop & re-migrate (simplest; the data has no value),
//     or (b) run THIS script first (app-level key dedup) then apply the
//     column + constraint migration.
//
// This script is OPTIONAL and is deliberately NOT wired into deploy.yml /
// the automatic deploy path — production drops the whole records table instead
// of cleaning it.
//
// Why app-level keying (NOT `GROUP BY dedupe_key`): this runs BEFORE the
// `dedupe_key` column exists (it is the "dedup before adding the constraint"
// tool), so the column is unavailable — grouping by it would be a chicken-and-
// egg error. Instead each `product` row's spec is decoded and re-keyed with
// `computeDedupeKey`, exactly the same key the write path will compute, so the
// cleanup converges onto the same buckets the future unique index enforces.
//
// "Keep the oldest" = keep `MIN(rowid)` per key: SQLite's implicit `rowid` is
// monotonic with insertion order on an ordinary rowid table (`product` is not
// WITHOUT ROWID), so the smallest rowid in a key bucket is the earliest insert.
//
// Usage (from packages/db):
//   DB_FILE=./.local/dev.sqlite pnpm dedupe:cleanup            # apply deletes
//   DB_FILE=./.local/dev.sqlite pnpm dedupe:cleanup --dry-run  # report only
// DB_FILE accepts a bare path or a `file:` URL (drizzle.config style); it
// defaults to ./.local/dev.sqlite to match drizzle.config.
import Database from 'better-sqlite3';
import { ParsedSpecSchema } from '@unit-price/core';
import { decodeJson, decodeMeasurement } from '../src/codec.js';
import { computeDedupeKey } from '../src/dedupe.js';

/** Resolve DB_FILE (bare path or `file:` URL) to a better-sqlite3 path. */
function resolveDbPath(): string {
  const raw = process.env.DB_FILE ?? 'file:./.local/dev.sqlite';
  return raw.startsWith('file:') ? raw.slice('file:'.length) : raw;
}

/** A `product` row as read via raw SQL, with its implicit rowid. */
interface ProductRow {
  rowid: number;
  id: string;
  raw_id: string;
  unit_size_value: number | null;
  unit_size_unit: string | null;
  quantity: number | null;
  multipliers: string;
  total_amount_value: number | null;
  total_amount_unit: string | null;
  package_unit: string | null;
  category: string;
  confidence: number;
}

/**
 * Decode a raw `product` row into a ParsedSpec and compute its dedupe key —
 * mirrors `getProduct`'s decode (decodeMeasurement / decodeJson) and reuses
 * `computeDedupeKey`, so the bucketing matches the write-path key exactly.
 */
function keyForRow(row: ProductRow): string {
  const spec = ParsedSpecSchema.parse({
    unitSize: decodeMeasurement(row.unit_size_value, row.unit_size_unit),
    quantity: row.quantity,
    multipliers: decodeJson(row.multipliers),
    totalAmount: decodeMeasurement(row.total_amount_value, row.total_amount_unit),
    packageUnit: row.package_unit,
    category: row.category,
    confidence: row.confidence,
  });
  return computeDedupeKey(row.raw_id, spec);
}

function main(): void {
  const dryRun = process.argv.includes('--dry-run');
  const dbPath = resolveDbPath();
  const handle = new Database(dbPath);
  handle.pragma('foreign_keys = ON');

  try {
    // Read every product row WITH its implicit rowid (drizzle does not expose
    // rowid, so this is bare SQL). Order by rowid so "first seen" is the
    // earliest insert.
    const rows = handle
      .prepare(
        'SELECT rowid AS rowid, id, raw_id, unit_size_value, unit_size_unit, quantity, multipliers, total_amount_value, total_amount_unit, package_unit, category, confidence FROM product ORDER BY rowid ASC',
      )
      .all() as ProductRow[];

    // Bucket by app-computed key; keep MIN(rowid) (the first encountered, since
    // we ordered by rowid ASC), collect the rest as deletions.
    const keepByKey = new Map<string, ProductRow>();
    const toDelete: ProductRow[] = [];
    for (const row of rows) {
      const key = keyForRow(row);
      const kept = keepByKey.get(key);
      if (kept == null) {
        keepByKey.set(key, row);
      } else {
        toDelete.push(row);
      }
    }

    // Count unit_price rows that pair with the to-delete products (deleted too).
    const countUnitPrice = handle.prepare(
      'SELECT count(*) AS c FROM unit_price WHERE product_id = ?',
    );
    let unitPriceDeleteCount = 0;
    for (const row of toDelete) {
      const r = countUnitPrice.get(row.id) as { c: number };
      unitPriceDeleteCount += r.c;
    }

    // Report (always — the human-readable summary doubles as the dry-run output).
    console.error(`db: ${dbPath}`);
    console.error(
      `product rows: ${rows.length} total, ${keepByKey.size} distinct keys, ` +
        `${toDelete.length} duplicate product rows to delete ` +
        `(+ ${unitPriceDeleteCount} unit_price rows).`,
    );
    for (const [key, kept] of keepByKey) {
      const dupes = toDelete.filter((d) => keyForRow(d) === key);
      if (dupes.length > 0) {
        console.error(
          `  key kept product ${kept.id} (rowid ${kept.rowid}); ` +
            `deleting ${dupes.map((d) => `${d.id}(rowid ${d.rowid})`).join(', ')}`,
        );
      }
    }

    if (dryRun) {
      console.error('--dry-run: no rows deleted.');
      return;
    }
    if (toDelete.length === 0) {
      console.error('nothing to delete.');
      return;
    }

    // Delete in a single transaction: corrections + unit_price first (both FK
    // children pointing at product.id), then product (FK parent) — respects the
    // foreign-key order so foreign_keys=ON doesn't abort the transaction.
    const delCorrections = handle.prepare(
      'DELETE FROM corrections WHERE product_id = ?',
    );
    const delUnitPrice = handle.prepare(
      'DELETE FROM unit_price WHERE product_id = ?',
    );
    const delProduct = handle.prepare('DELETE FROM product WHERE id = ?');
    const run = handle.transaction((victims: ProductRow[]) => {
      for (const row of victims) {
        delCorrections.run(row.id);
        delUnitPrice.run(row.id);
        delProduct.run(row.id);
      }
    });
    run(toDelete);
    console.error(
      `deleted ${toDelete.length} product rows and ${unitPriceDeleteCount} unit_price rows.`,
    );
  } finally {
    handle.close();
  }
}

main();
