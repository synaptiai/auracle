// The ledger end state an end-to-end case records in its artifact.
//
// Every column is read, so a new column shows up as a diff in the committed
// artifact rather than passing unseen. The rows come back in a fixed order,
// because an artifact must render the same bytes from the same end state.
import type { Pool } from 'pg';

/**
 * The run row, its journal, its outbox rows and the gate record it holds, for
 * one run. The gate record is the routing screen's row for the run's product
 * and intent (db/037), and null when the run holds none: it never reached the
 * gate, the fence refused its move to gated, or a newer run holds the record.
 */
export async function captureRun(
  pool: Pool,
  runId: string,
): Promise<{ run: unknown; journal: unknown[]; outbox: unknown[]; gateRecord: unknown }> {
  const run = await pool.query('SELECT * FROM run WHERE run_id = $1', [runId]);
  const journal = await pool.query('SELECT * FROM step_journal WHERE run_id = $1 ORDER BY step_id', [runId]);
  const outbox = await pool.query('SELECT * FROM outbox WHERE run_id = $1 ORDER BY idem_key', [runId]);
  const gateRecord = await pool.query('SELECT * FROM gate_latest WHERE run_id = $1', [runId]);
  return { run: run.rows[0] ?? null, journal: journal.rows, outbox: outbox.rows, gateRecord: gateRecord.rows[0] ?? null };
}

/** The accepted fencing epoch for one ticket (DEC-28), or null when none. */
export async function captureEpoch(pool: Pool, ticketId: string): Promise<string | null> {
  const rows = await pool.query<{ epoch: string }>(
    'SELECT epoch::text AS epoch FROM ticket_epoch WHERE ticket_id = $1',
    [ticketId],
  );
  return rows.rows[0]?.epoch ?? null;
}
