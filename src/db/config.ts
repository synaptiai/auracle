import { Pool } from 'pg';

import { errorMessage } from '../errors.js';
import { terminalText } from '../cli/terminal-text.js';
import { logLine } from '../log/line.js';
import { guardLedgerPool, logLedgerPoolError } from './client-errors.js';

// Mirrors the credentials in docker-compose.yml. Compose cannot export
// environment variables to the host shell, so this fallback is the default.
//
// Under `pnpm test`, Vitest's setup file (src/test-support/db-url.setup.ts)
// overwrites DATABASE_URL with the per-run ephemeral Postgres URI before any
// suite imports this module, so tests always prefer that container; an
// explicit shell export wins over the compose default everywhere else.
const COMPOSE_DEFAULT_URL = 'postgres://auracle:auracle@localhost:5433/auracle';

export function dbUrl(): string {
  return process.env.DATABASE_URL ?? COMPOSE_DEFAULT_URL;
}

/** Set to '1' to let a daemon fall back to the compose default. */
export const ALLOW_COMPOSE_DEFAULT = 'AURACLE_ALLOW_COMPOSE_DEFAULT';

/**
 * The database URL for a long-running process, which must never guess.
 *
 * `dbUrl()` falls back to the compose default, and `migrate.ts` refuses to
 * run without the variable. That asymmetry is the hazard, not the fallback:
 * an operator who loses the variable sees the migration fail, exports it in
 * that shell, migrates the real database, and reads success — while the
 * daemons, started from a unit file, keep the compose default. Intake, the
 * consumer and the relay then all agree with each other on a throwaway
 * database, so no component errors and every health signal is green.
 *
 * A local run that genuinely wants the compose default says so explicitly.
 */
export function requireDbUrl(processName: string): string {
  const configured = process.env.DATABASE_URL;
  if (configured !== undefined && configured.length > 0) return configured;
  if (process.env[ALLOW_COMPOSE_DEFAULT] === '1') return COMPOSE_DEFAULT_URL;
  throw new Error(
    `${processName} needs DATABASE_URL. It refuses the compose default, because a daemon `
      + `that guesses its database processes real traffic against the wrong one and reports `
      + `health while doing it. Set DATABASE_URL, or set ${ALLOW_COMPOSE_DEFAULT}=1 for a local run.`,
  );
}

/**
 * Proves a pool can reach its database, or throws saying it cannot.
 *
 * A `pg.Pool` connects lazily, so a wrong `DATABASE_URL` starts a process
 * cleanly and fails one request at a time. The operator reads the listening
 * line and believes it — the same hazard `requireDbUrl` names for guessing,
 * arriving one step later.
 *
 * It lives here rather than at the call site so a caller needs no statement
 * of its own. The operator console is held to naming no SQL at all, and a
 * probe written there would be the first one.
 */
export async function probeLedger(pool: Pool, processName: string): Promise<void> {
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    throw new Error(
      `${processName} cannot reach the ledger named by DATABASE_URL: `
        + (errorMessage(error)),
    );
  }
}

export async function tryConnect(): Promise<Pool | null> {
  const pool = guardLedgerPool(new Pool({ connectionString: dbUrl(), max: 1 }), logLedgerPoolError('the ledger probe'));
  try {
    await pool.query('SELECT 1');
    return pool;
  } catch (error) {
    // The caller only learns "no pool", which reads the same for a database
    // that is down, a wrong password and an SSL requirement.
    console.error(
      logLine({
        event: 'db_connect_failed',
        error: errorMessage(error),
      }),
    );
    await pool.end();
    return null;
  }
}

/**
 * Closes a job's pool, reporting a teardown that fails without replacing the
 * fault that caused it.
 *
 * Three jobs carried a copy of this block and only one of them set the exit
 * code. Logging a failed close and exiting 0 told a supervisor the run had
 * succeeded, and the two handlers in the same file then disagreed about the
 * same class of fault. This is the copy that was right.
 *
 * The rejection is swallowed deliberately. It runs in a `finally`, where a
 * throw would replace whatever sent us there — and the connection is
 * likeliest to be broken exactly when the query already failed, so the
 * operator needs the query's error and not the pool's. It is still reported,
 * because a swallowed rejection on the path where nothing else went wrong is
 * a fault nobody ever hears about.
 */
export async function closeLedger(pool: Pool, jobName: string): Promise<void> {
  await pool.end().catch((error: unknown) => {
    console.error(`${jobName}: the connection pool did not close cleanly: ${terminalText(errorMessage(error))}`);
    process.exitCode = 1;
  });
}
