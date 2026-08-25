// Versioned schema migrations over db/*.sql (V2 open item 6).
// Run via `npm run db:migrate` (executes the built dist/ledger/migrate.js).
//
// The runner keeps the numbered-file approach: plain SQL, lexical order,
// no framework. It adds a schema_version table so an applied file is
// skipped by record instead of by IF NOT EXISTS, each file applies and
// records inside one transaction, and an out-of-order file is refused.
// Migrations are forward-only; see docs/operations.md for the rollback story.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
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

const FILE_PATTERN = /^(\d+)_.+\.sql$/;

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
        `${filename} does not match NNN_name.sql; rename it before migrating`,
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
 * Each migration runs in one transaction together with its schema_version
 * insert, so a crash or failure leaves no half-applied file and no false
 * record. A file whose version is below the highest recorded version is
 * refused: applying it out of order could break later migrations.
 */
export async function migrate(
  client: PoolClient | Pool,
  dbDir: string = defaultDbDir,
): Promise<MigrateResult> {
  await client.query(VERSION_TABLE_SQL);
  const files = await discoverMigrations(dbDir);
  const { rows } = await client.query<{ version: number }>(
    'SELECT version FROM schema_version',
  );
  const appliedVersions = new Set(rows.map((row) => row.version));
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
      await client.query('ROLLBACK');
      throw new Error(
        `${file.filename} failed and rolled back: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    await client.query('COMMIT');
    result.applied.push(file);
  }
  return result;
}

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set.');
    process.exitCode = 1;
    return;
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const result = await migrate(pool);
    for (const file of result.applied) {
      console.log(`applied ${file.filename}`);
    }
    for (const file of result.skipped) {
      console.log(`skipped ${file.filename} (already applied)`);
    }
  } finally {
    await pool.end();
  }
}

// CLI entry only when run directly; tests import migrate() instead.
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
