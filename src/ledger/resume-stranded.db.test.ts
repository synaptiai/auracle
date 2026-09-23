// The ledger write that hands a turn back to the run that parked its draft
// (#122). Its rules are checked here directly, against runs seeded through
// the same insert every run takes, because the walks that reach it can only
// build some of the states the rules exist for. Synthetic data only (DEC-18).
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { dbUrl } from '../db/config.js';
import { truncateLedger } from '../test-support/schema.js';

import { fencedInsert, resumeStrandedRun } from './insert.js';

const pool = new Pool({ connectionString: dbUrl() });
await pool.query('SELECT 1');

afterAll(async () => {
  await pool.end();
});

/** A run on `ticketId` at `epoch`, in `state`. The insert raises the fence. */
async function run(ticketId: string, epoch: bigint, state = 'gated'): Promise<string> {
  const runId = randomUUID();
  const inserted = await fencedInsert(pool, {
    runId,
    ticketId,
    partition: 0,
    epoch,
    state,
    promptVer: 'p1',
    modelVer: 'm1',
    deadlineAt: new Date(Date.now() + 60_000),
  }, null);
  expect(inserted).toEqual({ outcome: 'accepted' });
  return runId;
}

interface RunRow {
  state: string;
  epoch: string;
  finished: boolean;
  cost: string;
  steps: number;
}

async function stateOf(runId: string): Promise<RunRow> {
  const { rows } = await pool.query<RunRow>(
    `SELECT state, epoch::text AS epoch, finished_at IS NOT NULL AS finished,
            cost_micros::text AS cost, steps_used AS steps
       FROM run WHERE run_id = $1`,
    [runId],
  );
  return rows[0]!;
}

/** What a refused write must leave: every column it could have touched. */
async function untouched(...runIds: string[]): Promise<RunRow[]> {
  return Promise.all(runIds.map(stateOf));
}

/** Distinct totals, so a swapped or dropped column shows. */
const COST = 700;
const STEPS = 5;

let recorded = 0;

function resume(runId: string, strandedRunId: string): ReturnType<typeof resumeStrandedRun> {
  return resumeStrandedRun(pool, {
    runId,
    strandedRunId,
    costMicros: COST,
    stepsUsed: STEPS,
    afterWrite: async () => {
      recorded += 1;
    },
  });
}

describe('handing a turn back to the run that parked its draft', () => {
  beforeEach(async () => {
    await truncateLedger(pool);
    recorded = 0;
  });

  it('moves the stranded run to wait, keeps its epoch, and ends the walking run', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const stranded = await run(ticketId, 10n);
    const walking = await run(ticketId, 11n);

    const before = await stateOf(stranded);
    expect(await resume(walking, stranded)).toEqual({ outcome: 'resumed' });
    // The stranded run's park finished after its last accepted write.
    expect(await stateOf(stranded)).toEqual({
      ...before, state: 'awaiting_approval', steps: before.steps + 1,
    });
    expect(await stateOf(walking)).toEqual({
      state: 'superseded', epoch: '11', finished: true, cost: String(COST), steps: STEPS,
    });
    expect(recorded).toBe(1);
  });

  // A ticket with no fence row holds no newer owner to refuse this one.
  it('hands the turn back on a ticket whose fence row is gone', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const stranded = await run(ticketId, 10n);
    const walking = await run(ticketId, 11n);
    await pool.query('DELETE FROM ticket_epoch WHERE ticket_id = $1', [ticketId]);

    expect(await resume(walking, stranded)).toEqual({ outcome: 'resumed' });
    expect((await stateOf(stranded)).state).toBe('awaiting_approval');
  });

  it('answers unknown_run for a run the ledger does not hold, and writes nothing', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const walking = await run(ticketId, 11n);
    const before = await untouched(walking);

    expect(await resume(walking, randomUUID())).toEqual({ outcome: 'unknown_run' });
    expect(await untouched(walking)).toEqual(before);
    expect(recorded).toBe(0);
  });

  // The stopping run's record commits with both state moves or not at all.
  // Without it the stranded run would wait with nothing saying why.
  it('rolls both state moves back when the record fails, and the pool still serves', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const stranded = await run(ticketId, 10n);
    const walking = await run(ticketId, 11n);
    const before = await untouched(stranded, walking);

    await expect(resumeStrandedRun(pool, {
      runId: walking,
      strandedRunId: stranded,
      costMicros: COST,
      stepsUsed: STEPS,
      afterWrite: async () => {
        throw new Error('the record could not be written');
      },
    })).rejects.toThrow('the record could not be written');
    expect(await untouched(stranded, walking)).toEqual(before);
    expect((await pool.query('SELECT 1 AS ok')).rows).toEqual([{ ok: 1 }]);
  });

  // DEC-28: a walking run the fence has passed may not write, even to hand
  // a turn back. A newer owner holds it, and would find the draft itself.
  it('refuses a walking run whose own lease went stale, and writes nothing', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const stranded = await run(ticketId, 10n);
    const walking = await run(ticketId, 11n);
    await run(ticketId, 12n);
    const before = await untouched(stranded, walking);

    expect(await resume(walking, stranded))
      .toEqual({ outcome: 'stale_epoch', highestAcceptedEpoch: 12n });
    expect(await untouched(stranded, walking)).toEqual(before);
    expect(recorded).toBe(0);
  });

  // The fence is keyed on the ticket, so it says nothing about a run of
  // another ticket, and that run's draft sits in another helpdesk ticket.
  it('refuses a run of another ticket', async () => {
    const stranded = await run(`T-${randomUUID().slice(0, 8)}`, 10n);
    const walking = await run(`T-${randomUUID().slice(0, 8)}`, 11n);
    const before = await untouched(stranded, walking);

    expect(await resume(walking, stranded)).toEqual({ outcome: 'not_stranded' });
    expect(await untouched(stranded, walking)).toEqual(before);
    expect(recorded).toBe(0);
  });

  it('refuses a run at the walking epoch, whose own walk may still move it', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const stranded = await run(ticketId, 11n);
    const walking = await run(ticketId, 11n);
    const before = await untouched(stranded, walking);

    expect(await resume(walking, stranded)).toEqual({ outcome: 'not_stranded' });
    expect(await untouched(stranded, walking)).toEqual(before);
    expect(recorded).toBe(0);
  });

  it('refuses a walking run that is not in flight', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const stranded = await run(ticketId, 10n);
    const walking = await run(ticketId, 11n, 'resolved');
    const before = await untouched(stranded, walking);

    expect(await resume(walking, stranded))
      .toEqual({ outcome: 'wrong_state', currentState: 'resolved' });
    expect(await untouched(stranded, walking)).toEqual(before);
    expect(recorded).toBe(0);
  });

  // Intake takes the fence and then a conversation's snoozed runs (DEC-48).
  // A write that held a snoozed run while it waited for the fence would close
  // a cycle with it. This one judges both runs first, so it refuses a run
  // that left flight without waiting for the fence at all.
  it('refuses a run that left flight without waiting for the fence', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const stranded = await run(ticketId, 10n);
    const walking = await run(ticketId, 11n);
    await pool.query("UPDATE run SET state = 'snoozed' WHERE run_id = $1", [stranded]);

    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT epoch FROM ticket_epoch WHERE ticket_id = $1 FOR UPDATE', [ticketId]);
      const answer = await Promise.race([
        resume(walking, stranded),
        new Promise((resolve) => setTimeout(() => resolve('waited for the fence'), 2_000)),
      ]);
      expect(answer).toEqual({ outcome: 'not_stranded' });
      expect(recorded).toBe(0);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect((await stateOf(stranded)).state).toBe('snoozed');
  });
});
