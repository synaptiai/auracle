// One migrated template database per run, cloned per test file.
//
// The database suites used to share one database and run one file at a time,
// because they truncate tables between cases and two files at once corrupt
// each other. Serial execution was the 3-minute step in CI.
//
// Each file gets its own database now. `CREATE DATABASE ... TEMPLATE` copies
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
// A run must never touch another run's databases, and the first version of
// this file did. It matched `datname LIKE 'auracle_t_%'`, where `_` is a
// single-character wildcard: that pattern matches `auracle_template` — the
// template the same run had just built — and any bystander database called
// `auracle_test`, `auracle_tickets` and so on. Teardown terminated their
// backends and dropped them. Two concurrent runs against one server destroyed
// each other, measured, and a database belonging to no run at all was equally
// exposed.
//
// So the names carry a run id, the match is `starts_with` rather than `LIKE`
// (no wildcard semantics at all), and a run only ever drops what it created.
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';

import { migrate } from '../ledger/migrate.js';

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
    } finally {
      client.release();
    }
  } finally {
    // Nothing may hold this open, or every clone fails.
    await template.end();
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
