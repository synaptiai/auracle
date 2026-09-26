// The ledger end state an end-to-end case records in its artifact.
//
// Every column is read, so a new column shows up as a diff in the committed
// artifact rather than passing unseen. The rows come back in a fixed order,
// because an artifact must render the same bytes from the same end state.
import type { Pool } from 'pg';

/** The run row, its journal and its outbox rows, for one run. */
export async function captureRun(
  pool: Pool,
  runId: string,
): Promise<{ run: unknown; journal: unknown[]; outbox: unknown[] }> {
  const run = await pool.query('SELECT * FROM run WHERE run_id = $1', [runId]);
  const journal = await pool.query('SELECT * FROM step_journal WHERE run_id = $1 ORDER BY step_id', [runId]);
  const outbox = await pool.query('SELECT * FROM outbox WHERE run_id = $1 ORDER BY idem_key', [runId]);
  return { run: run.rows[0] ?? null, journal: journal.rows, outbox: outbox.rows };
}

/** The accepted fencing epoch for one ticket (DEC-28), or null when none. */
export async function captureEpoch(pool: Pool, ticketId: string): Promise<string | null> {
  const rows = await pool.query<{ epoch: string }>(
    'SELECT epoch::text AS epoch FROM ticket_epoch WHERE ticket_id = $1',
    [ticketId],
  );
  return rows.rows[0]?.epoch ?? null;
}
