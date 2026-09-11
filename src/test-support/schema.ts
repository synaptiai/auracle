// Applies the real ledger schema to a test database, and clears it between
// cases.
//
// Every database suite used to name the migration files it wanted, so a new
// migration reached none of them and the suites ran against a stale shape.
// This walks db/*.sql in version order through the same discovery the
// migrator uses, so a suite always sees the schema an adopter would get.
//
// Cleanup had the same problem one level down. `TRUNCATE` was written 49
// times across 30 files in ten different table lists: fourteen omitted
// `intake`, five omitted `conversation` and `turn`. A suite that skips a
// table leaves rows for the next file, which is an order-dependent flake and
// the reason the database project could not run its files in parallel.
// Adding a table under `db/` meant editing twenty-two files, and nothing
// failed when that was missed.
//
// `truncateLedger` asks the database what tables exist instead. A table added
// by a migration is cleared by every suite from the moment it exists, with no
// edit anywhere.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Pool, PoolClient } from 'pg';

import { discoverMigrations } from '../ledger/migrate.js';

const DB_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../db',
);

/**
 * Tables the truncation must not touch.
 *
 * `schema_version` is the migrator's own record. Clearing it would tell the
 * next `migrate()` that nothing had been applied, and a template database
 * would then be re-migrated on top of itself.
 */
const KEEP = new Set(['schema_version']);

/** Applies every migration under `db/`, oldest version first. */
export async function applyLedgerSchema(pool: Pool): Promise<void> {
  for (const migration of await discoverMigrations(DB_DIR)) {
    const sql = await readFile(path.join(DB_DIR, migration.filename), 'utf8');
    await pool.query(sql);
  }
}

/**
 * Empties every ledger table, whatever the schema currently holds.
 *
 * One statement, so the tables go together and no foreign key sees a
 * half-cleared database. `RESTART IDENTITY` resets sequences, and `CASCADE`
 * covers a table that a later migration points at this one.
 *
 * The list comes from `information_schema.tables` at call time. That is the
 * whole point: a hand-written list is a second declaration of the schema, and
 * it had already drifted ten ways.
 */
export async function truncateLedger(db: Pool | PoolClient): Promise<void> {
  const { rows } = await db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
  );
  const tables = rows
    .map((row) => row.table_name)
    .filter((name) => !KEEP.has(name));
  if (tables.length === 0) return;
  const quoted = tables.map((name) => `"${name}"`).join(', ');
  await db.query(`TRUNCATE ${quoted} RESTART IDENTITY CASCADE`);
}
