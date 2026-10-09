// The explicit clock, against a real database.
//
// The clock is a trailing parameter on the two fenced writes. These cases
// read the row back, because a statement test proves what was sent and not
// what was stored, and the column carries a DEFAULT that would hide a
// dropped binding.
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { dbUrl } from '../db/config.js';
import { truncateLedger } from '../test-support/schema.js';
import {
  LedgerClockError,
  fencedInsert,
  fencedTransition,
  type FencedRunInput,
  type FencedOutboxInput,
} from './insert.js';

const pool = new Pool({ connectionString: dbUrl(), max: 10 });

// The global setup guarantees a reachable database before the workers fork.
await pool.query('SELECT 1');

// One teardown for the whole file. Ending the pool inside the first
// describe's afterAll left the second describe with a closed pool, and every
// case in it failed on the schema apply rather than on anything it asserted.
afterAll(async () => {
  await truncateLedger(pool);
  await pool.end();
});

const MINUTE = 60_000;
const CREATED = new Date('2026-07-04T09:15:00.000Z');
const ARRIVED = new Date('2026-07-04T09:14:30.000Z');
const FINISHED = new Date('2026-07-04T09:16:00.000Z');

function makeRun(overrides: Partial<FencedRunInput> = {}): FencedRunInput {
  return {
    runId: randomUUID(),
    ticketId: 'T-' + randomUUID().slice(0, 8),
    partition: 0,
    epoch: 1n,
    state: 'queued',
    promptVer: 'p1',
    modelVer: 'm1',
    deadlineAt: new Date(Date.now() + MINUTE),
    ...overrides,
  };
}

function makeOutbox(idemKey: string): FencedOutboxInput {
  return {
    stepId: 's1',
    idemKey,
    actionClass: 'reply',
    delivery: 'at_least_once',
    payload: { note: 'synthetic' },
  };
}

async function readTiming(runId: string): Promise<{
  createdAt: Date;
  enqueuedAt: Date | null;
  finishedAt: Date | null;
  state: string;
}> {
  const { rows } = await pool.query(
    'SELECT created_at, enqueued_at, finished_at, state FROM run WHERE run_id = $1',
    [runId],
  );
  const row = rows[0] as Record<string, unknown>;
  return {
    createdAt: row['created_at'] as Date,
    enqueuedAt: row['enqueued_at'] as Date | null,
    finishedAt: row['finished_at'] as Date | null,
    state: row['state'] as string,
  };
}

async function runCount(): Promise<number> {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM run');
  return (rows[0] as { n: number }).n;
}

describe('fencedInsert with an explicit clock', () => {
  beforeEach(async () => {
    await truncateLedger(pool);
  });

  it('stores the supplied created_at', async () => {
    const run = makeRun({ enqueuedAt: ARRIVED });
    expect(await fencedInsert(pool, run, null, { createdAt: CREATED })).toEqual({
      outcome: 'accepted',
    });
    const timing = await readTiming(run.runId);
    expect(timing.createdAt.toISOString()).toBe(CREATED.toISOString());
    expect(timing.enqueuedAt?.toISOString()).toBe(ARRIVED.toISOString());
  });

  // The non-goal, read off the stored row rather than off the statement.
  it('still records now() when no clock is supplied', async () => {
    const before = Date.now();
    const run = makeRun();
    expect(await fencedInsert(pool, run, null)).toEqual({ outcome: 'accepted' });
    const timing = await readTiming(run.runId);
    expect(timing.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(timing.createdAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect(timing.finishedAt).toBeNull();
  });

  // A run inserted already terminal never transitions, so the insert is the
  // only chance to stamp its finish. The clock's finish used to be dropped
  // here in silence, and the latency reader then labelled the row
  // `unstamped` and left it out of the service distribution.
  it('stamps the finish on a run inserted already terminal', async () => {
    const run = makeRun({ state: 'resolved', enqueuedAt: ARRIVED });
    expect(
      await fencedInsert(pool, run, null, { createdAt: CREATED, finishedAt: FINISHED }),
    ).toEqual({ outcome: 'accepted' });
    const timing = await readTiming(run.runId);
    expect(timing.state).toBe('resolved');
    expect(timing.createdAt.toISOString()).toBe(CREATED.toISOString());
    expect(timing.finishedAt?.toISOString()).toBe(FINISHED.toISOString());
  });

  // Nobody said when it finished, so the column says nothing. That reads as
  // `unstamped` to the latency reader, which is the honest label.
  it('leaves the finish null on a terminal insert whose clock carries none', async () => {
    const run = makeRun({ state: 'resolved' });
    expect(await fencedInsert(pool, run, null, { createdAt: CREATED })).toEqual({
      outcome: 'accepted',
    });
    expect((await readTiming(run.runId)).finishedAt).toBeNull();
  });

  // A finish for a state that has not finished is refused, not dropped.
  it('refuses a finish on a non-terminal insert and stores nothing', async () => {
    const run = makeRun({ state: 'queued' });
    await expect(
      fencedInsert(pool, run, null, { createdAt: CREATED, finishedAt: FINISHED }),
    ).rejects.toThrow(LedgerClockError);
    expect(await runCount()).toBe(0);
  });

  // A Date that carries no time used to clear the guards, open the
  // transaction, upsert the epoch and then throw a bare RangeError.
  it('refuses a Date that carries no time and stores nothing', async () => {
    const run = makeRun();
    await expect(
      fencedInsert(pool, run, null, { createdAt: new Date('nonsense') }),
    ).rejects.toThrow(LedgerClockError);
    expect(await runCount()).toBe(0);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM ticket_epoch');
    expect((rows[0] as { n: number }).n).toBe(0);
  });

  it('refuses a created_at before the arrival time and stores nothing', async () => {
    const run = makeRun({ enqueuedAt: CREATED });
    await expect(
      fencedInsert(pool, run, null, { createdAt: ARRIVED }),
    ).rejects.toThrow(LedgerClockError);
    expect(await runCount()).toBe(0);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM ticket_epoch');
    expect((rows[0] as { n: number }).n).toBe(0);
  });

  it('refuses a finished_at before the created_at and stores nothing', async () => {
    const run = makeRun();
    await expect(
      fencedInsert(pool, run, null, { createdAt: FINISHED, finishedAt: CREATED }),
    ).rejects.toThrow(LedgerClockError);
    expect(await runCount()).toBe(0);
  });

  // Section 4.2 rule 2: the losing insert lands 'superseded', which is
  // terminal. With a clock and no finish the column stays null, and the
  // latency reader counts the row under `unstamped`. The creation instant
  // looked honest — such a run never ran — but the reader keys `never_ran`
  // on both version pins reading 'intake', so a seeded row carrying any
  // other pins would have read as a measured service time of exactly zero
  // and entered the percentiles. `seeded-history.db.test.ts` asserts that
  // through the reader.
  it('leaves the superseded finish null when the clock carries none', async () => {
    const first = makeRun({ ticketId: 'T-shared-2' });
    const key = 'idem-' + randomUUID();
    expect(await fencedInsert(pool, first, makeOutbox(key))).toEqual({ outcome: 'accepted' });

    const second = makeRun({ ticketId: 'T-shared-2' });
    expect(
      await fencedInsert(pool, second, makeOutbox(key), { createdAt: CREATED }),
    ).toEqual({ outcome: 'superseded' });

    const timing = await readTiming(second.runId);
    expect(timing.state).toBe('superseded');
    expect(timing.createdAt.toISOString()).toBe(CREATED.toISOString());
    expect(timing.finishedAt).toBeNull();
  });

  // A terminal state that loses the race still stamps the finish it was
  // given: that run did finish, and the caller said when.
  it('stamps the superseded finish from a terminal insert clock', async () => {
    const key = 'idem-' + randomUUID();
    const first = makeRun({ ticketId: 'T-shared-4' });
    expect(await fencedInsert(pool, first, makeOutbox(key))).toEqual({ outcome: 'accepted' });

    const second = makeRun({ ticketId: 'T-shared-4', state: 'resolved' });
    expect(
      await fencedInsert(pool, second, makeOutbox(key), {
        createdAt: CREATED,
        finishedAt: FINISHED,
      }),
    ).toEqual({ outcome: 'superseded' });
    const timing = await readTiming(second.runId);
    expect(timing.state).toBe('superseded');
    expect(timing.finishedAt?.toISOString()).toBe(FINISHED.toISOString());
  });

  it('leaves the superseded finish at now() when no clock is supplied', async () => {
    const before = Date.now();
    const first = makeRun({ ticketId: 'T-shared-3' });
    const key = 'idem-' + randomUUID();
    expect(await fencedInsert(pool, first, makeOutbox(key))).toEqual({ outcome: 'accepted' });

    const second = makeRun({ ticketId: 'T-shared-3' });
    expect(await fencedInsert(pool, second, makeOutbox(key))).toEqual({
      outcome: 'superseded',
    });
    const timing = await readTiming(second.runId);
    // Bounded on both sides. A COALESCE bind that selected the wrong column,
    // deadline_at say, would satisfy a lower bound alone.
    expect(timing.finishedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(timing.finishedAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  // The clock is the only thing that changes. A refusal happens before
  // BEGIN, and an accepted clock must not disturb the epoch rule.
  it('still refuses a stale epoch, clock or no clock', async () => {
    const ticketId = 'T-fence';
    expect(
      await fencedInsert(pool, makeRun({ ticketId, epoch: 5n }), null, { createdAt: CREATED }),
    ).toEqual({ outcome: 'accepted' });
    expect(
      await fencedInsert(pool, makeRun({ ticketId, epoch: 4n }), null, { createdAt: CREATED }),
    ).toEqual({ outcome: 'stale_epoch', highestAcceptedEpoch: 5n });
  });
});

describe('fencedTransition with an explicit clock', () => {
  beforeEach(async () => {
    await truncateLedger(pool);
  });

  async function seeded(): Promise<FencedRunInput> {
    const run = makeRun({ enqueuedAt: ARRIVED });
    expect(await fencedInsert(pool, run, null, { createdAt: CREATED })).toEqual({
      outcome: 'accepted',
    });
    return run;
  }

  it('stamps a terminal finish from the clock', async () => {
    const run = await seeded();
    expect(
      await fencedTransition(
        pool,
        { runId: run.runId, state: 'resolved', costMicros: 10, stepsUsed: 2 },
        { finishedAt: FINISHED },
      ),
    ).toEqual({ outcome: 'accepted' });
    const timing = await readTiming(run.runId);
    expect(timing.state).toBe('resolved');
    expect(timing.finishedAt?.toISOString()).toBe(FINISHED.toISOString());
  });

  it('still stamps now() when no clock is supplied', async () => {
    const before = Date.now();
    const run = makeRun();
    expect(await fencedInsert(pool, run, null)).toEqual({ outcome: 'accepted' });
    expect(
      await fencedTransition(pool, {
        runId: run.runId,
        state: 'resolved',
        costMicros: 0,
        stepsUsed: 0,
      }),
    ).toEqual({ outcome: 'accepted' });
    const timing = await readTiming(run.runId);
    expect(timing.finishedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(timing.finishedAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  // The reference is the stored created_at, not a value the caller repeats.
  // A caller that had to repeat it could disagree with the row.
  it('refuses a finish before the stored created_at, and stores nothing', async () => {
    const run = await seeded();
    await expect(
      fencedTransition(
        pool,
        { runId: run.runId, state: 'resolved', costMicros: 0, stepsUsed: 0 },
        { finishedAt: ARRIVED },
      ),
    ).rejects.toThrow(LedgerClockError);
    const timing = await readTiming(run.runId);
    expect(timing.state).toBe('queued');
    expect(timing.finishedAt).toBeNull();
  });

  // A transition that asks for a non-terminal state and carries no outbox
  // record can never stamp a finish, so a clock there is a caller bug. It
  // used to be order-checked and then discarded in silence, while the insert
  // side refused the matching case. The two sides read as one decision now.
  it('refuses a clock on a non-terminal transition that carries no outbox', async () => {
    const run = await seeded();
    let caught: unknown;
    try {
      await fencedTransition(
        pool,
        { runId: run.runId, state: 'classified', costMicros: 0, stepsUsed: 1 },
        { finishedAt: FINISHED },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LedgerClockError);
    expect((caught as Error).message).toContain('carries no outbox record');
    const timing = await readTiming(run.runId);
    expect(timing.state).toBe('queued');
    expect(timing.finishedAt).toBeNull();
  });

  // The same request carrying an outbox record is accepted, because a
  // zero-row insert lands it 'superseded', and that branch does stamp.
  it('accepts a clock on a non-terminal transition that carries an outbox', async () => {
    const run = await seeded();
    expect(
      await fencedTransition(
        pool,
        {
          runId: run.runId,
          state: 'executing',
          costMicros: 0,
          stepsUsed: 1,
          outbox: makeOutbox('idem-' + randomUUID()),
        },
        { finishedAt: FINISHED },
      ),
    ).toEqual({ outcome: 'accepted' });
    const timing = await readTiming(run.runId);
    expect(timing.state).toBe('executing');
    expect(timing.finishedAt).toBeNull();
  });

  it('stamps the superseded finish from the clock', async () => {
    const first = await seeded();
    const key = 'idem-' + randomUUID();
    expect(
      await fencedTransition(pool, {
        runId: first.runId,
        state: 'executing',
        costMicros: 0,
        stepsUsed: 1,
        outbox: makeOutbox(key),
      }),
    ).toEqual({ outcome: 'accepted' });

    const second = await seeded();
    expect(
      await fencedTransition(
        pool,
        {
          runId: second.runId,
          state: 'executing',
          costMicros: 0,
          stepsUsed: 1,
          outbox: makeOutbox(key),
        },
        { finishedAt: FINISHED },
      ),
    ).toEqual({ outcome: 'superseded' });
    const timing = await readTiming(second.runId);
    expect(timing.state).toBe('superseded');
    expect(timing.finishedAt?.toISOString()).toBe(FINISHED.toISOString());
  });

  // The transition-side refusal is the one that happens inside the
  // transaction, and on the superseded branch it happens after the outbox
  // insert has already run. The rollback must undo that too, so the first
  // run's outbox row survives and the second run does not move.
  it('refuses a finish on the superseded branch and rolls the outbox back', async () => {
    const first = await seeded();
    const key = 'idem-' + randomUUID();
    expect(
      await fencedTransition(pool, {
        runId: first.runId,
        state: 'executing',
        costMicros: 0,
        stepsUsed: 1,
        outbox: makeOutbox(key),
      }),
    ).toEqual({ outcome: 'accepted' });

    const second = await seeded();
    await expect(
      fencedTransition(
        pool,
        {
          runId: second.runId,
          state: 'executing',
          costMicros: 0,
          stepsUsed: 1,
          outbox: makeOutbox(key),
        },
        { finishedAt: ARRIVED },
      ),
    ).rejects.toThrow(LedgerClockError);

    const timing = await readTiming(second.runId);
    expect(timing.state).toBe('queued');
    expect(timing.finishedAt).toBeNull();
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM outbox');
    expect((rows[0] as { n: number }).n).toBe(1);
  });

  // The comparison the database makes, at the precision it holds. A run
  // created by now() carries microseconds; node-postgres truncates them
  // downward when it parses the column into a JS Date. A check written in
  // JavaScript against that truncated value accepted a finish equal to it,
  // and the database then read that finish as earlier than the creation, so
  // the latency reader labelled the row 'unordered' and dropped it.
  it('refuses a finish equal to the truncated created_at of a now() row', async () => {
    const run = makeRun();
    expect(await fencedInsert(pool, run, null)).toEqual({ outcome: 'accepted' });
    const stored = await readTiming(run.runId);

    // The value a JS reader sees, which is at or below the stored value.
    const truncated = new Date(stored.createdAt.getTime());
    const { rows } = await pool.query(
      'SELECT (created_at > $2::timestamptz) AS lost_precision FROM run WHERE run_id = $1',
      [run.runId, truncated.toISOString()],
    );
    const lostPrecision = (rows[0] as { lost_precision: boolean }).lost_precision;

    const result = fencedTransition(
      pool,
      { runId: run.runId, state: 'resolved', costMicros: 0, stepsUsed: 0 },
      { finishedAt: truncated },
    );
    if (lostPrecision) {
      // now() carried sub-millisecond digits, so the truncated value really
      // is earlier than the stored one. The database says so and the write
      // refuses it.
      await expect(result).rejects.toThrow(LedgerClockError);
      const after = await readTiming(run.runId);
      expect(after.state).toBe('queued');
      expect(after.finishedAt).toBeNull();
    } else {
      // now() landed on a whole millisecond, so the pair is equal, and equal
      // is ordered.
      expect(await result).toEqual({ outcome: 'accepted' });
    }

    // Either way, the reader must not see an unordered row.
    const { rows: check } = await pool.query(
      'SELECT count(*)::int AS n FROM run WHERE finished_at < created_at',
    );
    expect((check[0] as { n: number }).n).toBe(0);
  });

  // A millisecond after, which is the finest a JS `Date` can express. A
  // caller cannot supply a sub-millisecond finish at all: the API takes a
  // `Date`, and node-postgres hands the column back truncated, so a value
  // read from a row and passed straight back is at or below the stored one.
  // That is why the comparison belongs in the database.
  it('accepts a finish a millisecond after the stored created_at', async () => {
    const run = makeRun();
    expect(await fencedInsert(pool, run, null)).toEqual({ outcome: 'accepted' });
    const stored = await readTiming(run.runId);
    expect(
      await fencedTransition(
        pool,
        { runId: run.runId, state: 'resolved', costMicros: 0, stepsUsed: 0 },
        { finishedAt: new Date(stored.createdAt.getTime() + 1) },
      ),
    ).toEqual({ outcome: 'accepted' });
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM run WHERE finished_at < created_at',
    );
    expect((rows[0] as { n: number }).n).toBe(0);
  });

  // Section 4.2, liveness. The clock is checked before the outbox insert and
  // whatever state was requested. Checked later, or only for a terminal
  // target, a caller's bad clock decided the outcome of a race: the losing
  // run threw instead of reaching 'superseded' and stopping, and only when a
  // race happened at all.
  it('refuses a bad clock on a non-terminal transition, race or no race', async () => {
    const run = await seeded();
    await expect(
      fencedTransition(
        pool,
        { runId: run.runId, state: 'executing', costMicros: 0, stepsUsed: 1 },
        { finishedAt: ARRIVED },
      ),
    ).rejects.toThrow(LedgerClockError);
    const timing = await readTiming(run.runId);
    expect(timing.state).toBe('queued');
    expect(timing.finishedAt).toBeNull();
  });

  it('lets a good clock reach superseded on a non-terminal transition', async () => {
    const first = await seeded();
    const key = 'idem-' + randomUUID();
    expect(
      await fencedTransition(pool, {
        runId: first.runId,
        state: 'executing',
        costMicros: 0,
        stepsUsed: 1,
        outbox: makeOutbox(key),
      }),
    ).toEqual({ outcome: 'accepted' });

    const second = await seeded();
    expect(
      await fencedTransition(
        pool,
        {
          runId: second.runId,
          state: 'executing',
          costMicros: 0,
          stepsUsed: 1,
          outbox: makeOutbox(key),
        },
        { finishedAt: FINISHED },
      ),
    ).toEqual({ outcome: 'superseded' });
    expect((await readTiming(second.runId)).finishedAt?.toISOString()).toBe(
      FINISHED.toISOString(),
    );
  });

  // The clock is now checked before wrong_state and before stale_epoch, and
  // that ordering is the contract. It changed with the liveness fix: a
  // caller's bad clock used to be reported only on the paths that reached
  // the terminal branch, so a seeder loop hitting wrong_state never learned
  // its clock was garbage, and the same garbage threw on the next run that
  // did reach it. A refusal now happens on every path, before any write.
  it('refuses a bad clock even when the state is wrong', async () => {
    const run = await seeded();
    await expect(
      fencedTransition(
        pool,
        {
          runId: run.runId,
          state: 'resolved',
          costMicros: 0,
          stepsUsed: 0,
          fromState: 'composed',
        },
        { finishedAt: ARRIVED },
      ),
    ).rejects.toThrow(LedgerClockError);
    const timing = await readTiming(run.runId);
    expect(timing.state).toBe('queued');
    expect(timing.finishedAt).toBeNull();
  });

  it('still returns wrong_state when the clock is good', async () => {
    const run = await seeded();
    expect(
      await fencedTransition(
        pool,
        {
          runId: run.runId,
          state: 'resolved',
          costMicros: 0,
          stepsUsed: 0,
          fromState: 'composed',
        },
        { finishedAt: FINISHED },
      ),
    ).toEqual({ outcome: 'wrong_state', currentState: 'queued' });
    expect((await readTiming(run.runId)).finishedAt).toBeNull();
  });

  it('refuses a bad clock even when the epoch is stale', async () => {
    const run = await seeded();
    expect(
      await fencedInsert(pool, makeRun({ ticketId: run.ticketId, epoch: 9n }), null, {
        createdAt: CREATED,
      }),
    ).toEqual({ outcome: 'accepted' });
    await expect(
      fencedTransition(
        pool,
        { runId: run.runId, state: 'resolved', costMicros: 0, stepsUsed: 0 },
        { finishedAt: ARRIVED },
      ),
    ).rejects.toThrow(LedgerClockError);
    expect((await readTiming(run.runId)).finishedAt).toBeNull();
  });

  it('still returns stale_epoch when the clock is good', async () => {
    const run = await seeded();
    expect(
      await fencedInsert(pool, makeRun({ ticketId: run.ticketId, epoch: 9n }), null, {
        createdAt: CREATED,
      }),
    ).toEqual({ outcome: 'accepted' });
    expect(
      await fencedTransition(
        pool,
        { runId: run.runId, state: 'resolved', costMicros: 0, stepsUsed: 0 },
        { finishedAt: FINISHED },
      ),
    ).toEqual({ outcome: 'stale_epoch', highestAcceptedEpoch: 9n });
    expect((await readTiming(run.runId)).finishedAt).toBeNull();
  });

  it('refuses an unknown run before it reads the clock', async () => {
    expect(
      await fencedTransition(
        pool,
        { runId: randomUUID(), state: 'resolved', costMicros: 0, stepsUsed: 0 },
        { finishedAt: FINISHED },
      ),
    ).toEqual({ outcome: 'unknown_run' });
  });
});
