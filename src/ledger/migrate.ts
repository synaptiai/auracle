// Versioned schema migrations over db/*.sql (V2 open item 6).
// Run via `pnpm run db:migrate` (executes the built dist/ledger/migrate.js).
//
// The runner keeps the numbered-file approach: plain SQL, lexical order,
// no framework. It adds a schema_version table so an applied file is
// skipped by record instead of by IF NOT EXISTS, each file applies and
// records inside one transaction, and an out-of-order file is refused.
// Migrations are forward-only; see docs/operations.md for the rollback story.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadDotEnv } from '../config/env.js';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { runEntry } from '../cli/entry.js';
import { errorMessage } from '../errors.js';
import { startedAsCommand } from '../corpus/output-path.js';
import { guardLedgerPool, logLedgerPoolError } from '../db/client-errors.js';
const defaultDbDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../db',
);

const VERSION_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version    integer     PRIMARY KEY,
  filename   text        NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

// Lower-case letters, digits and underscores only. The runner quotes a name
// into the repair it suggests, and a quote in the name would end the string.
const FILE_PATTERN = /^(\d+)_[a-z0-9_]+\.sql$/;

export interface MigrationFile {
  version: number;
  filename: string;
}

export interface MigrateResult {
  /** Files this run applied, in application order. */
  applied: MigrationFile[];
  /** Files already recorded in schema_version and therefore skipped. */
  skipped: MigrationFile[];
}

/** Reads db/*.sql, parses the leading number as the version, sorts by it. */
export async function discoverMigrations(
  dir: string,
): Promise<MigrationFile[]> {
  const names = (await readdir(dir)).filter((name) => name.endsWith('.sql'));
  if (names.length === 0) throw new Error(`No .sql files found in ${dir}`);
  const parsed = names.map((filename) => {
    const match = FILE_PATTERN.exec(filename);
    if (!match || !match[1]) {
      throw new Error(
        `${filename} does not match NNN_name.sql, with a name of lower-case letters, digits and`
          + ' underscores; rename it before migrating',
      );
    }
    return { version: Number(match[1]), filename };
  });
  const versions = new Set(parsed.map((m) => m.version));
  if (versions.size !== parsed.length) {
    throw new Error('Two migration files share one version number');
  }
  return parsed.sort((a, b) => a.version - b.version);
}

/**
 * Applies every not-yet-recorded migration in version order.
 *
 * Requires a single dedicated connection (a PoolClient from pool.connect(),
 * never a Pool): BEGIN, the migration SQL and COMMIT must land on one
 * session, and a multi-client Pool would scatter them across connections.
 *
 * Each migration runs in one transaction together with its schema_version
 * insert, so a crash or failure leaves no half-applied file and no false
 * record. A file whose version is below the highest recorded version is
 * refused: applying it out of order could break later migrations.
 */
export async function migrate(
  client: PoolClient,
  dbDir: string = defaultDbDir,
): Promise<MigrateResult> {
  await client.query(VERSION_TABLE_SQL);
  const files = await discoverMigrations(dbDir);
  const { rows } = await client.query<{ version: number; filename: string }>(
    'SELECT version, filename FROM schema_version',
  );
  const appliedVersions = new Set(rows.map((row) => row.version));
  // A version recorded under another file came from another history of this
  // directory: a number reused on a branch, or a file renamed. Skipping it
  // would leave this file's schema missing with no error, so every writer
  // that needs it would fail later. Refused before anything is applied.
  const recorded = new Map(rows.map((row) => [row.version, row.filename]));
  for (const file of files) {
    const name = recorded.get(file.version);
    if (name !== undefined && name !== file.filename) {
      throw new Error(
        `version ${file.version} is recorded as ${name}, but the directory holds ${file.filename}. `
          + 'Either a row inserted by hand names the file wrongly, or the ledger was migrated from another '
          + `history of db/. Once the ledger holds what ${file.filename} creates, record it with: `
          + `UPDATE schema_version SET filename = '${file.filename}' WHERE version = ${file.version}`,
      );
    }
  }
  const highestApplied = rows.reduce((max, row) => Math.max(max, row.version), 0);

  const result: MigrateResult = { applied: [], skipped: [] };
  for (const file of files) {
    if (appliedVersions.has(file.version)) {
      result.skipped.push(file);
      continue;
    }
    if (file.version < highestApplied) {
      throw new Error(
        `${file.filename} is older than recorded version ${highestApplied} ` +
          'and cannot be applied out of order',
      );
    }
    const sql = await readFile(path.join(dbDir, file.filename), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_version (version, filename) VALUES ($1, $2)',
        [file.version, file.filename],
      );
    } catch (err) {
      // A ROLLBACK on a broken connection throws its own transport error. Let
      // it replace this failure and the operator loses the lock or timeout
      // message the by-hand procedures in db/ depend on.
      let rolledBack = true;
      let rollbackFault = '';
      await client.query('ROLLBACK').catch((rollbackError: unknown) => {
        rolledBack = false;
        rollbackFault = errorMessage(rollbackError);
      });
      throw new Error(
        rolledBack
          ? `${file.filename} failed and rolled back: ${errorMessage(err)}`
          : `${file.filename} failed: ${errorMessage(err)}. Its rollback failed too: ${rollbackFault}`,
      );
    }
    await client.query('COMMIT');
    result.applied.push(file);
  }
  return result;
}

async function main(): Promise<void> {
  loadDotEnv();
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set.');
    process.exitCode = 1;
    return;
  }

  const pool = guardLedgerPool(new Pool({ connectionString: databaseUrl, max: 1 }), logLedgerPoolError('the migrator'));
  try {
    // One dedicated connection: the transactional guarantee in migrate()
    // requires every statement on a single session.
    const client = await pool.connect();
    try {
      const result = await migrate(client);
      for (const file of result.applied) {
        console.log(`applied ${file.filename}`);
      }
      for (const file of result.skipped) {
        console.log(`skipped ${file.filename} (already applied)`);
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

// CLI entry only when run directly; tests import migrate() instead.
//
// The shared helper, not a copy of its comparison. The raw equality this
// replaced was the pre-fix rule: Node resolves `import.meta.url` through
// symlinks while `process.argv[1]` is the path as typed, so run through a
// symlinked directory the two disagreed and `pnpm run db:migrate` applied
// nothing and exited 0 — a migration reporting success while never running.
if (startedAsCommand(import.meta.url, process.argv[1])) {
  void runEntry(main);
}
