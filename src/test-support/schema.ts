// Applies the real ledger schema to a test database.
//
// Every database suite used to name the migration files it wanted, so a new
// migration reached none of them and the suites ran against a stale shape.
// This walks db/*.sql in version order through the same discovery the
// migrator uses, so a suite always sees the schema an adopter would get.
//
// It applies the files directly rather than through `migrate()`: the runner
// records versions in `schema_version` and refuses a file it has already
// applied, while a suite re-applies the schema between cases. Every
// migration is therefore written to be safe to re-apply.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Pool } from 'pg';

import { discoverMigrations } from '../ledger/migrate.js';

const DB_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../db',
);

/** Applies every migration under `db/`, oldest version first. */
export async function applyLedgerSchema(pool: Pool): Promise<void> {
  for (const migration of await discoverMigrations(DB_DIR)) {
    const sql = await readFile(path.join(DB_DIR, migration.filename), 'utf8');
    await pool.query(sql);
  }
}
