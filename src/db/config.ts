import { Pool } from 'pg';

import { errorMessage } from '../errors.js';
import { terminalText } from '../cli/terminal-text.js';
import { logLine } from '../log/line.js';
import { guardLedgerPool, logLedgerPoolError } from './client-errors.js';
import { driverParameters } from './driver-parameters.js';
import { LEDGER_IDENTITY, type LedgerIdentity, probeReaders } from './probe-readers.js';

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

/**
 * The compose ledger as the readers' role sees it. The password is the compose
 * stack's local default, as `auracle` is the writer's.
 */
const COMPOSE_READER_DEFAULT_URL = 'postgres://auracle_reader:auracle_reader@localhost:5433/auracle';

/**
 * The ledger as the readers' role, `auracle_reader`, connects to it.
 *
 * `boundedRead` refuses a session that can act beyond a read, so a reader
 * handed the writer's pool fails its first read rather than running with the
 * writer's rights. Under `pnpm test` the per-file setup publishes this URL
 * beside `DATABASE_URL`.
 */
export function readerDbUrl(): string {
  return process.env.READER_DATABASE_URL ?? COMPOSE_READER_DEFAULT_URL;
}

/**
 * The readers' URL for a long-running process, which must never guess, by the
 * rule `requireDbUrl` gives for the writer's.
 */
export function requireReaderDbUrl(processName: string): string {
  const configured = process.env.READER_DATABASE_URL;
  if (configured !== undefined && configured.length > 0) return configured;
  // The compose default only beside the writer's own compose default. A
  // writer aimed at another ledger with the reader left to the default would
  // show reviewers one ledger while their approvals write to another.
  const writer = process.env.DATABASE_URL;
  const needs = `${processName} needs READER_DATABASE_URL, the ledger as the auracle_reader role connects to it. `
    + `Its readers refuse a session that can act beyond a read, so the writer's DATABASE_URL cannot stand in.`;
  if (process.env[ALLOW_COMPOSE_DEFAULT] === '1') {
    let writerIsCompose: boolean;
    try {
      writerIsCompose = writer === undefined || writer.length === 0 || namesComposeLedger(writer);
    } catch (error) {
      throw new Error(
        `${needs} DATABASE_URL could not be read: ${errorMessage(error)}. Correct it, or set READER_DATABASE_URL.`,
      );
    }
    if (writerIsCompose) return COMPOSE_READER_DEFAULT_URL;
    throw new Error(
      `${needs} ${ALLOW_COMPOSE_DEFAULT}=1 allows the compose default only beside the compose writer, `
        + `and DATABASE_URL names another ledger. Set READER_DATABASE_URL to that ledger.`,
    );
  }
  throw new Error(`${needs} Set READER_DATABASE_URL, or set ${ALLOW_COMPOSE_DEFAULT}=1 for a local run.`);
}

/**
 * Proves the readers' pool connects as the readers' role, to the ledger the
 * writer's pool reaches, or throws saying which it does not.
 *
 * Both pools would pass a probe of their own when the two URLs name two
 * ledgers. A page would then join a run read from one to a journal read from
 * the other, and an approval would write to a ledger nobody is shown.
 */
export async function assertOneLedger(writers: Pool, readers: Pool, processName: string): Promise<void> {
  const reader = await probeReaders(readers, processName);
  const { rows: [writer] } = await writers.query<LedgerIdentity>(LEDGER_IDENTITY);
  if (writer!.database !== reader.database || writer!.started !== reader.started) {
    throw new Error(
      `${processName}: READER_DATABASE_URL reaches the database '${reader.database}' on a server started at `
        + `${reader.started_at}, and DATABASE_URL reaches '${writer!.database}' on a server started at `
        + `${writer!.started_at}. Both must name one ledger.`,
    );
  }
}

/**
 * Whether a URL names the compose ledger, however it spells it: the local
 * host by any of its names, port 5433, database `auracle`, user `auracle`.
 * It reads the URL as the driver does, which lets a query parameter replace
 * the host, port, user or database. A URL the driver cannot read throws.
 */
function namesComposeLedger(url: string): boolean {
  const parsed = driverParameters(url);
  return ['localhost', '127.0.0.1', '::1'].includes(parsed.host.toLowerCase())
    && parsed.port === 5433
    && parsed.database === 'auracle'
    && parsed.user === 'auracle';
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
export async function probeLedger(
  pool: Pool,
  processName: string,
  variable: 'DATABASE_URL' | 'READER_DATABASE_URL' = 'DATABASE_URL',
): Promise<void> {
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    throw new Error(
      `${processName} cannot reach the ledger named by ${variable}: `
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
