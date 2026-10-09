// One migrated template database per run, cloned per test file.
//
// The database suites truncate tables between cases, so two files that share
// one database corrupt each other. One shared database forces one file at a
// time, which makes the database step slow in CI.
//
// So each file gets its own database. `CREATE DATABASE ... TEMPLATE` copies
// a migrated database at the file-system level, which costs far less than
// replaying sixteen migrations, so the isolation is nearly free.
//
// The template is migrated through the real `migrate()` path rather than by
// applying the SQL files directly. That matters: `migrate()` records versions
// in `schema_version` and refuses a file it has already applied, so a suite
// running against a clone sees exactly the schema an adopter gets, applied the
// way an adopter applies it.
//
// ## Every name carries a run id
//
// A run must never touch another run's databases. A teardown that matched
// `datname LIKE 'auracle_t_%'` would, because `_` is a single-character
// wildcard: that pattern matches `auracle_template`, the template the same
// run builds, and any bystander database called `auracle_test`,
// `auracle_tickets` and so on. The teardown would terminate their backends and
// drop them, so two concurrent runs against one server would destroy each
// other, and so would a database that belongs to no run.
//
// So the names carry a run id, the match is `starts_with` rather than `LIKE`
// (no wildcard semantics at all), and a run only ever drops what it created.
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { PoolClient } from 'pg';

import { errorMessage } from '../errors.js';
import { migrate } from '../ledger/migrate.js';
import { READER_ROLE, restateReaderRole, revokeTempFromPublic } from '../ledger/reader-role.js';
import { assertLocalHost, postgresHost } from './local-host.js';

/**
 * The password the readers' role logs in with on a test server: the compose
 * stack's own default. A run sets it on the whole server, because a role is the
 * server's: a compose stack that set its own `AURACLE_READER_PASSWORD` needs a
 * `db:migrate` after a test run.
 */
const TEST_READER_CREDENTIAL = 'auracle_reader';

/**
 * The connections the role may hold during a test run. The files run in
 * parallel and each opens a reader pool, so the production limit of ten would
 * refuse them. A `db:migrate` restates the production limit.
 */
const TEST_READER_CONNECTION_LIMIT = 200;

/** Set to '1' to let a test run set the readers' login on a host that is not this machine. */
export const ALLOW_REMOTE_DB = 'AURACLE_TEST_ALLOW_REMOTE_DB';

/**
 * Refuses to set the readers' login on a server that is not this machine.
 *
 * The role and its password belong to the whole server. A run aimed at a
 * shared server with an explicit DATABASE_URL would reset the password every
 * service on it uses to a value printed in this repository.
 */
function assertLocalDbHost(url: string): void {
  assertLocalHost(
    postgresHost(url),
    ALLOW_REMOTE_DB,
    `refusing to create ${READER_ROLE} and set its login for the whole server`,
  );
}

/**
 * The same database as `url`, as the readers' role connects to it. Every reader
 * runs through `boundedRead`, which refuses the writer's session.
 */
export function asReader(url: string): string {
  const parsed = new URL(url);
  parsed.username = READER_ROLE;
  parsed.password = TEST_READER_CREDENTIAL;
  return parsed.toString();
}

/** Fixed part of every clone name. Never used as a LIKE pattern. */
export const CLONE_PREFIX = 'auracle_clone_';

/** Fixed part of every template name. */
export const TEMPLATE_PREFIX = 'auracle_tmpl_';

/** Identifies one `vitest run`. Every database this run creates carries it. */
export function newRunId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

/** The template database this run migrates and clones from. */
export function templateName(runId: string): string {
  return `${TEMPLATE_PREFIX}${runId}`;
}

/** The prefix every clone of this run shares. */
export function clonePrefix(runId: string): string {
  return `${CLONE_PREFIX}${runId}_`;
}

/** Replaces the database name in a Postgres connection URI. */
export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/** The database a connection URI names. */
export function databaseOf(url: string): string {
  return new URL(url).pathname.replace(/^\//, '');
}

/**
 * Creates this run's template and migrates it.
 *
 * The admin URI names the server's original database, not the template:
 * `CREATE DATABASE ... TEMPLATE t` refuses to run while any session is
 * connected to `t`, so nothing may hold a connection to it after this
 * resolves. The pool below is closed before the function returns for exactly
 * that reason.
 */
export async function prepareTemplate(adminUrl: string, runId: string): Promise<void> {
  // Before the first statement: migration 041 creates the role on the whole
  // server, so a run on a remote server would change it before refusing.
  assertLocalDbHost(adminUrl);
  const name = templateName(runId);
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    // The name carries a fresh run id, so this cannot be another run's.
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }

  const template = new Pool({ connectionString: withDatabase(adminUrl, name), max: 1 });
  try {
    const client = await template.connect();
    try {
      await migrate(client);
      // The role is the server's, so this is the one place a run restates it
      // and sets its login, as `pnpm run db:migrate` does after the migrations.
      await restateWithRetry(client);
    } finally {
      client.release();
    }
  } finally {
    // Nothing may hold this open, or every clone fails.
    await template.end();
  }
}

/**
 * Restates the readers' role for a test run. The role is the server's, and
 * its lock is the database's, so two runs on one server can update the role
 * at once; Postgres refuses the second with "tuple concurrently updated".
 * That clears by waiting, so it is retried.
 */
async function restateWithRetry(client: PoolClient): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await restateReaderRole(client, {
        credential: TEST_READER_CREDENTIAL,
        connectionLimit: TEST_READER_CONNECTION_LIMIT,
      });
      return;
    } catch (error) {
      // Only after a clean rollback: a connection that failed to roll back
      // cannot run the next attempt.
      const raced = /tuple concurrently updated/.test(errorMessage(error))
        && (error as { rollbackFailed?: boolean }).rollbackFailed !== true;
      if (!raced || Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 200));
    }
  }
}

/**
 * Clones this run's template into a fresh database and returns its URI.
 *
 * Retries on the one contention Postgres reports here. Several workers call
 * this at once, and `CREATE DATABASE` takes a lock on the template; a loser
 * sees `source database ... is being accessed by other users` (55006) and
 * tries again. A duplicate name (42P04) cannot clear by waiting, because the
 * name is fixed by the caller, so it is not retried.
 */
export async function cloneTemplate(
  adminUrl: string,
  runId: string,
  label: string,
): Promise<string> {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  const name = `${clonePrefix(runId)}${label}`;
  try {
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${templateName(runId)}"`);
        // A clone copies the template's tables and functions, and not the
        // database's own rights: PUBLIC gets TEMP back, which the readers' role
        // must not hold.
        await revokeTempFromPublic(admin, name);
        return withDatabase(adminUrl, name);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== '55006' || Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 150));
      }
    }
  } finally {
    await admin.end();
  }
}

/**
 * Drops the databases this run created, and nothing else.
 *
 * `starts_with` rather than `LIKE`: the prefix holds underscores, and in a
 * LIKE pattern an underscore matches any character. That is how an earlier
 * version dropped its own template and any database whose name happened to
 * fit.
 */
export async function dropRunDatabases(adminUrl: string, runId: string): Promise<string[]> {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  const dropped: string[] = [];
  try {
    const { rows } = await admin.query<{ datname: string }>(
      `SELECT datname FROM pg_database
        WHERE starts_with(datname, $1) OR datname = $2`,
      [clonePrefix(runId), templateName(runId)],
    );
    for (const row of rows) {
      // A worker that died without closing its pool would otherwise block the
      // drop and leave the database behind. Scoped to this run's own names.
      await admin.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
        [row.datname],
      );
      await admin.query(`DROP DATABASE IF EXISTS "${row.datname}"`);
      dropped.push(row.datname);
    }
  } finally {
    await admin.end();
  }
  return dropped;
}
