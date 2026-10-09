// Two runs of one turn and attempt waiting at once, each with a reply.
//
// A reply park refuses a twin: a redelivered message that finds another run
// of its turn and attempt waiting with a reply parks nothing. On one ticket,
// a walk that overlaps an older one gives the turn back to the older run,
// because the fence refuses the older walk's next state move. The state still
// exists outside those paths. Runs parked before the refusal can hold it,
// and so can two tickets of one conversation, which the fence does not
// order against each other. The guards that hold a turn to one reply — the
// approval's, the save's, the send-back's and the consumer's scan — exist
// for that state, so their suites build it here.
import type { Pool } from 'pg';

/**
 * Runs `walk` as though `runId` had not parked yet.
 *
 * The waiting run reads as in flight, with no park on record, while `walk`
 * runs. Then it waits again with its park restored, so the walk parks beside
 * it: two runs of one turn and attempt, each waiting with a reply.
 */
export async function asIfRacing<T>(pool: Pool, runId: string, walk: () => Promise<T>): Promise<T> {
  const { rows } = await pool.query<{ state: string }>(
    'SELECT state FROM run WHERE run_id = $1',
    [runId],
  );
  const state = rows[0]?.state;
  if (state === undefined) throw new Error(`no run ${runId} to race`);
  const hidden = await pool.query(
    "UPDATE step_journal SET step_id = 'park:racing' WHERE run_id = $1 AND step_id = 'park'",
    [runId],
  );
  if (hidden.rowCount !== 1) throw new Error(`run ${runId} has no park to race`);
  await pool.query("UPDATE run SET state = 'gated' WHERE run_id = $1", [runId]);
  try {
    return await walk();
  } finally {
    await pool.query('UPDATE run SET state = $2 WHERE run_id = $1', [runId, state]);
    await pool.query(
      "UPDATE step_journal SET step_id = 'park' WHERE run_id = $1 AND step_id = 'park:racing'",
      [runId],
    );
  }
}
