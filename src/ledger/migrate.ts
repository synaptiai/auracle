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
import { isDeepStrictEqual } from 'node:util';

import { loadDotEnv } from '../config/env.js';
import pg, { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { runEntry } from '../cli/entry.js';
import { errorMessage } from '../errors.js';
import { startedAsCommand } from '../corpus/output-path.js';
import { guardLedgerPool, logLedgerPoolError } from '../db/client-errors.js';
import { type DriverParameters, driverParameters } from '../db/driver-parameters.js';
import {
  READER_ROLE,
  ReaderRightsLeft,
  acquireRestateLock,
  readerCredential,
  readerReach,
  releaseRestateLock,
  restateReaderRole,
  whyLocked,
} from './reader-role.js';

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
  options: { readonly lockTimeoutMs?: number } = {},
): Promise<MigrateResult> {
  // Two migrators on one ledger run in turn: the second waits, then finds
  // the first one's files applied.
  try {
    await acquireRestateLock(client, options.lockTimeoutMs);
  } catch (error) {
    throw Object.assign(
      new Error(`nothing was migrated: ${whyLocked(error, READER_ROLE)}${errorMessage(error)}${needsSuperuser(error)}`),
      { code: (error as { code?: string }).code },
    );
  }
  try {
    return await migrateHoldingLock(client, dbDir);
  } catch (error) {
    // migrateHoldingLock names each file it reaches. A failure before the
    // first one applied nothing.
    if (error instanceof NothingApplied) {
      throw Object.assign(new Error(`nothing was migrated: ${errorMessage(error.cause)}`), {
        code: (error.cause as { code?: string }).code,
      });
    }
    throw error;
  } finally {
    await releaseRestateLock(client);
  }
}

/**
 * A hint for a refusal (42501) of the migration lock. From migration 041 on,
 * a restate revokes pg_advisory_lock from PUBLIC, so only a superuser takes it.
 */
function needsSuperuser(error: unknown): string {
  return (error as { code?: string }).code === '42501'
    ? '. db:migrate needs a superuser from migration 041 on.'
    : '';
}

/** What migrate() will apply: the files, the versions recorded, and the highest. */
async function planMigrations(
  client: PoolClient,
  dbDir: string,
): Promise<{ files: MigrationFile[]; appliedVersions: Set<number>; highestApplied: number }> {
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
  return { files, appliedVersions, highestApplied };
}

/** A failure in migrate() before it reached any file. */
class NothingApplied extends Error {
  constructor(cause: unknown) {
    super(errorMessage(cause), { cause });
  }
}

/** migrate() while it holds the migration lock. */
async function migrateHoldingLock(client: PoolClient, dbDir: string): Promise<MigrateResult> {
  let plan: { files: MigrationFile[]; appliedVersions: Set<number>; highestApplied: number };
  try {
    plan = await planMigrations(client, dbDir);
  } catch (error) {
    throw new NothingApplied(error);
  }
  const { files, appliedVersions, highestApplied } = plan;


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
    // The files this run committed before this one stay committed, so a
    // failure names them.
    const before = result.applied.length === 0
      ? ''
      : `. This run applied ${result.applied.map((applied) => applied.filename).join(', ')} before it.`;
    let sql: string;
    try {
      sql = await readFile(path.join(dbDir, file.filename), 'utf8');
    } catch (err) {
      throw new Error(`${file.filename} could not be read: ${errorMessage(err)}${before}`);
    }
    try {
      await client.query('BEGIN');
    } catch (err) {
      // No transaction opened, so nothing rolls back.
      throw new Error(`${file.filename} could not start its transaction: ${errorMessage(err)}${before}`);
    }
    let committing = false;
    try {
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_version (version, filename) VALUES ($1, $2)',
        [file.version, file.filename],
      );
      committing = true;
      await client.query('COMMIT');
    } catch (err) {
      // A commit the server refused rolled back. One that failed off the
      // server, such as a lost connection, may follow the commit.
      if (committing && !(err instanceof pg.DatabaseError)) {
        throw new Error(
          `${file.filename} failed at its commit, and whether it committed is unknown: ${errorMessage(err)}${before}`,
        );
      }
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
          ? `${file.filename} failed and rolled back: ${errorMessage(err)}${before}`
          : `${file.filename} failed: ${errorMessage(err)}. Its rollback failed too: ${rollbackFault}${before}`,
      );
    }
    result.applied.push(file);
  }
  return result;
}

/**
 * The password READER_DATABASE_URL carries, and that URL, to log in as the
 * role through. Both or neither: a login set with no URL to check it by
 * would be one nothing reports.
 */
type ReaderLogin =
  | {
    readonly credential: string;
    readonly readerUrl: string;
    /** DATABASE_URL, which READER_DATABASE_URL must name the database of. */
    readonly migratorUrl: string;
  }
  | { readonly credential?: undefined; readonly readerUrl?: undefined; readonly migratorUrl?: undefined };

export type RestateReadersOptions = ReaderLogin & {
  /** The role to restate. A test restates a role of its own. */
  readonly role?: string;
  readonly connectionLimit?: number;
  /** How long the restate waits for its lock. A test shortens it. */
  readonly lockTimeoutMs?: number;
  /** Where the lines go. The command prints them. */
  readonly say?: { log(line: string): void; warn(line: string): void };
};

/**
 * How READER_DATABASE_URL differs from DATABASE_URL, as the driver reads
 * them, or nothing when both name one database the same way: the same host,
 * port and database, and the same TLS setting. It connects nowhere, so no
 * credential goes to a host READER_DATABASE_URL names before the role is
 * restated. The as-role login after the restate checks the server itself.
 */
function howReaderUrlDiffers(readerUrl: string, migratorUrl: string): string | undefined {
  // A host name is read in any case. A socket directory is a path, and a
  // path keeps its case. Two addresses are two hosts, even two of this
  // machine: a server can listen on each at one port.
  const host = (name: string): string => (name.startsWith('/') ? name : name.toLowerCase());
  const there = driverParameters(readerUrl);
  const here = driverParameters(migratorUrl);
  if (host(there.host) !== host(here.host) || there.port !== here.port || there.database !== here.database) {
    return 'another host, port or database';
  }
  // The role's own login after the restate uses the readers' URL. A weaker
  // TLS setting there would send its password where the migrator's is safe.
  // A client certificate is the login's own, and is not compared.
  const theirs = tlsProtection(there.ssl);
  const ours = tlsProtection(here.ssl);
  if (theirs.level < ours.level) return 'a weaker TLS setting';
  if (ours.level >= 2 && ours.ca !== undefined && !isDeepStrictEqual(theirs.ca, ours.ca)) {
    return 'a weaker TLS setting';
  }
  return undefined;
}

/**
 * How the driver protects a login, from its own reading of a URL: 0 sends
 * it in clear, 1 encrypts it and checks no certificate, 2 checks the
 * certificate and not the server's name, 3 checks both. `ca` is the
 * authority a check trusts, when the URL names one. The driver reads
 * `require`, `verify-ca` and `verify-full` alike, unless `uselibpqcompat`
 * gives `verify-ca` libpq's meaning: it replaces the name check.
 */
function tlsProtection(ssl: DriverParameters['ssl']): { level: 0 | 1 | 2 | 3; ca: unknown } {
  if (!ssl) return { level: 0, ca: undefined };
  if (typeof ssl !== 'object') return { level: 3, ca: undefined };
  if (ssl.rejectUnauthorized === false) return { level: 1, ca: ssl.ca };
  return { level: ssl.checkServerIdentity === undefined ? 3 : 2, ca: ssl.ca };
}

/**
 * After the migrations (issue #153): restates the readers' role, gives it its
 * login when a credential is given, then logs in as it to see which ledger and
 * which other databases it reaches. Every message names the state it leaves.
 */
export async function restateReaders(client: PoolClient, options: RestateReadersOptions = {}): Promise<void> {
  const role = options.role ?? READER_ROLE;
  const say = options.say ?? { log: (line: string) => console.log(line), warn: (line: string) => console.warn(line) };
  // The login is set on the server DATABASE_URL names. A READER_DATABASE_URL
  // that names another database would set it here and check it there, so the
  // two are compared first.
  const differs = options.readerUrl === undefined ? undefined : howReaderUrlDiffers(options.readerUrl, options.migratorUrl);
  if (differs !== undefined) {
    throw new Error(
      `the migrations applied, and READER_DATABASE_URL names ${differs} than DATABASE_URL, `
        + `so ${role} was not restated and its login is unchanged. Give both URLs the same host, port and `
        + 'database, and a TLS setting as strong, and migrate again.',
    );
  }
  try {
    await acquireRestateLock(client, options.lockTimeoutMs);
  } catch (error) {
    throw Object.assign(
      new Error(
        `the migrations applied, and ${role} was not restated and its login is unchanged: `
          + `${whyLocked(error, role)}${errorMessage(error)}${needsSuperuser(error)}`,
      ),
      { code: (error as { code?: string }).code },
    );
  }
  try {
    await restateHoldingLock(client, role, say, options);
  } finally {
    await releaseRestateLock(client);
  }
}

/** restateReaders after its checks, while it holds the migration lock. */
async function restateHoldingLock(
  client: PoolClient,
  role: string,
  say: { log(line: string): void; warn(line: string): void },
  options: RestateReadersOptions,
): Promise<void> {
  let created: boolean;
  try {
    ({ created } = await restateReaderRole(client, {
      ...(options.role === undefined ? {} : { role: options.role }),
      ...(options.connectionLimit === undefined ? {} : { connectionLimit: options.connectionLimit }),
      ...(options.credential === undefined ? {} : { credential: options.credential }),
      ...(options.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: options.lockTimeoutMs }),
    }));
  } catch (error) {
    if (error instanceof ReaderRightsLeft) throw error;
    const superuser = (error as { code?: string }).code === '42501'
      ? ` Restating ${role} needs a superuser: on PostgreSQL 16 no other role can strip a role's attributes.`
      : '';
    throw new Error(`the migrations applied. ${errorMessage(error)}${superuser}`);
  }
  const restated = created ? `created and restated ${role}, which the server lacked` : `restated ${role}`;
  if (options.credential === undefined) {
    say.log(`${restated}; READER_DATABASE_URL is not set, so its login is unchanged`);
    return;
  }
  say.log(`${restated}, which logs in with the password READER_DATABASE_URL names`);
  // The role's rights are taken in this database only, so log in as it and
  // see where else it can.
  let reach;
  try {
    reach = await readerReach(client, options.readerUrl);
  } catch (error) {
    throw new Error(
      `the migrations applied, and ${created ? `${role} was created and restated` : `${role} was restated`} `
        + `with its login. Checking where it can log in failed: ${errorMessage(error)}`,
    );
  }
  if (!reach.sameLedger) {
    throw new Error(
      `READER_DATABASE_URL reaches another database or server than DATABASE_URL. ${role} was `
        + 'restated here, and its login here now uses the password READER_DATABASE_URL carries. Set '
        + 'READER_DATABASE_URL to this ledger and migrate again.',
    );
  }
  if (reach.otherDatabases.length > 0) {
    say.warn(
      `${role} can log in to ${reach.otherDatabases.join(', ')}. In a database that is not another ledger, `
        + 'PUBLIC\'s rights there can act beyond a read: limit the login in pg_hba.conf. See "The readers\' role" '
        + 'in docs/operations.md.',
    );
  }
  if (reach.undetermined.length > 0) {
    say.warn(
      `${role}'s login to these databases failed for a reason other than a refusal, so `
        + `whether it can log in there is unknown: ${reach.undetermined.join('; ')}`,
    );
  }
  if (reach.otherDatabases.length === 0 && reach.undetermined.length === 0) {
    say.log(`${role} logs in to no other database on the server through READER_DATABASE_URL's host`);
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set.');
    process.exitCode = 1;
    return;
  }
  // The driver's own reading, so a bad URL is named before anything runs.
  try {
    driverParameters(databaseUrl);
  } catch (error) {
    throw new Error(`DATABASE_URL could not be read: ${errorMessage(error)}, so nothing was migrated.`);
  }

  // Issue #153: the readers' URL is checked before any file applies, so a bad
  // one fails the run before it migrates anything.
  const readerUrl = process.env['READER_DATABASE_URL'];
  let credential: string | undefined;
  try {
    credential = readerUrl !== undefined && readerUrl.length > 0 ? readerCredential(readerUrl) : undefined;
  } catch (error) {
    throw new Error(`${errorMessage(error).replace(/\.$/, '')}, so nothing was migrated.`);
  }
  const differs = credential === undefined ? undefined : howReaderUrlDiffers(readerUrl!, databaseUrl);
  if (differs !== undefined) {
    throw new Error(
      `READER_DATABASE_URL names ${differs} than DATABASE_URL, so nothing was migrated. `
        + 'Give both URLs the same host, port and database, and a TLS setting as strong, and migrate again.',
    );
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
      await restateReaders(client, credential === undefined
        ? {}
        : { credential, readerUrl: readerUrl!, migratorUrl: databaseUrl });
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
