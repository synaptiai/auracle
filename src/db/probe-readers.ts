// The readers' pool, proved at startup.
import type { Pool } from 'pg';

import { boundedRead } from './bounded-read.js';

/**
 * The ledger a connection reaches: its database, on one running server. The
 * start time compared is a count of microseconds, because its text as a
 * timestamp follows each session's TimeZone and DateStyle. The UTC text is for
 * a person to read.
 */
export const LEDGER_IDENTITY = `SELECT current_database() AS database,
  (extract(epoch FROM pg_postmaster_start_time()) * 1000000)::bigint::text AS started,
  to_char(pg_postmaster_start_time() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || ' UTC' AS started_at`;

/** The row LEDGER_IDENTITY returns. */
export interface LedgerIdentity {
  readonly database: string;
  readonly started: string;
  readonly started_at: string;
}

/**
 * Proves a readers' pool connects as the readers' role, or throws saying it
 * does not, and returns the ledger it reaches.
 *
 * `SELECT 1` succeeds for any role, so a READER_DATABASE_URL that names the
 * writer would start a console whose every reader page then refused. This runs
 * one bounded read, so the role check refuses that URL at startup instead.
 */
export async function probeReaders(pool: Pool, processName: string): Promise<LedgerIdentity> {
  const rows = await boundedRead(pool, `${processName}: READER_DATABASE_URL`, 5_000, 6_000, (query) =>
    query<LedgerIdentity>(LEDGER_IDENTITY));
  return rows[0]!;
}
