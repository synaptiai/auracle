// A backdated history is indistinguishable from a naturally-aged one (issue #22).
//
// This is the acceptance criterion the seam exists for. Every run below is
// written through the real fenced path with an explicit clock and is never
// touched again: no UPDATE sets a timestamp afterwards. The two readers then
// describe the history, and the figures they report are the figures this
// suite chose.
//
// The older latency suite writes its timings with an UPDATE after the insert,
// because before the seam there was no other way. That proves the query. It
// cannot prove that the write path can produce such a row, which is what
// issue #23's seeder depends on.
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { dbUrl } from '../db/config.js';
import { applyLedgerSchema } from '../test-support/schema.js';
import { readDays } from '../bands/query.js';
import { readLatency } from '../latency/query.js';
import {
  fencedInsert,
  fencedTransition,
  type FencedOutboxInput,
  type FencedRunInput,
} from './insert.js';

const pool = new Pool({ connectionString: dbUrl(), max: 10 });

await pool.query('SELECT 1');

const SECOND = 1000;

/**
 * One finished run whose whole timeline this suite chose.
 *
 * The arrival, the pickup and the finish all go in through the fenced path.
 * Nothing here writes a timestamp with an UPDATE.
 */
async function seedFinishedRun(opts: {
  partition: number;
  createdAt: Date;
  waitMs: number;
  serviceMs: number;
  state?: string;
}): Promise<string> {
  const run: FencedRunInput = {
    runId: randomUUID(),
    ticketId: 'T-' + randomUUID().slice(0, 8),
    partition: opts.partition,
    epoch: 1n,
    state: 'queued',
    promptVer: 'p1',
    modelVer: 'm1',
    deadlineAt: new Date(opts.createdAt.getTime() + 60 * SECOND),
    enqueuedAt: new Date(opts.createdAt.getTime() - opts.waitMs),
  };
  expect(await fencedInsert(pool, run, null, { createdAt: opts.createdAt })).toEqual({
    outcome: 'accepted',
  });
  expect(
    await fencedTransition(
      pool,
      {
        runId: run.runId,
        state: opts.state ?? 'resolved',
        costMicros: 1234,
        stepsUsed: 3,
      },
      { finishedAt: new Date(opts.createdAt.getTime() + opts.serviceMs) },
    ),
  ).toEqual({ outcome: 'accepted' });
  return run.runId;
}

/**
 * A run that lost the outbox race, written with a backdated clock.
 *
 * Section 4.2 rule 2 lands it 'superseded', which is terminal. The clock
 * carries no finish, because the insert refuses one for a state that has not
 * finished, so the finish column stays null.
 */
async function seedSupersededLoser(createdAt: Date, idemKey: string): Promise<string> {
  const outbox: FencedOutboxInput = {
    stepId: 's1',
    idemKey,
    actionClass: 'reply',
    delivery: 'at_least_once',
    payload: { note: 'synthetic' },
  };
  const winner: FencedRunInput = {
    runId: randomUUID(),
    ticketId: 'T-' + randomUUID().slice(0, 8),
    partition: 0,
    epoch: 1n,
    state: 'queued',
    promptVer: 'p1',
    modelVer: 'm1',
    deadlineAt: new Date(createdAt.getTime() + 60 * SECOND),
  };
  expect(await fencedInsert(pool, winner, outbox, { createdAt })).toEqual({
    outcome: 'accepted',
  });
  const loser: FencedRunInput = { ...winner, runId: randomUUID() };
  expect(await fencedInsert(pool, loser, outbox, { createdAt })).toEqual({
    outcome: 'superseded',
  });
  return loser.runId;
}

const DAY_ONE = '2026-06-01';
const DAY_TWO = '2026-06-02';

describe('a history seeded through the fenced path', () => {
  beforeEach(async () => {
    await applyLedgerSchema(pool);
    await pool.query(
      'TRUNCATE run, ticket_epoch, step_journal, outbox, intake, conversation, turn',
    );
  });

  afterAll(async () => {
    await pool.query(
      'TRUNCATE run, ticket_epoch, step_journal, outbox, intake, conversation, turn',
    );
    await pool.end();
  });

  it('reports the queue waits and service times the seeder chose', async () => {
    for (const [waitMs, serviceMs] of [
      [30 * SECOND, 10 * SECOND],
      [60 * SECOND, 20 * SECOND],
      [90 * SECOND, 30 * SECOND],
    ]) {
      await seedFinishedRun({
        partition: 0,
        createdAt: new Date(`${DAY_ONE}T12:00:00.000Z`),
        waitMs: waitMs!,
        serviceMs: serviceMs!,
      });
    }

    const report = await readLatency(pool);
    expect(report.runs).toBe(3);
    expect(report.partitions).toHaveLength(1);
    const p = report.partitions[0]!;
    expect(p.partition).toBe(0);

    // percentile_disc returns a duration some run actually took, so these
    // are three of the six numbers written above and not an interpolation.
    expect(p.wait.count).toBe(3);
    expect(p.wait.p50Ms).toBe(60 * SECOND);
    expect(p.wait.p95Ms).toBe(90 * SECOND);
    expect(p.wait.maxMs).toBe(90 * SECOND);
    expect(p.service.count).toBe(3);
    expect(p.service.p50Ms).toBe(20 * SECOND);
    expect(p.service.p95Ms).toBe(30 * SECOND);
    expect(p.service.maxMs).toBe(30 * SECOND);
  });

  // A seeded run that landed in 'unordered' would still appear in the report,
  // just in the column that means the row taught the reader nothing. So the
  // absence of every shortfall count is asserted, not assumed.
  it('lands in no shortfall column', async () => {
    await seedFinishedRun({
      partition: 0,
      createdAt: new Date(`${DAY_ONE}T12:00:00.000Z`),
      waitMs: 45 * SECOND,
      serviceMs: 15 * SECOND,
    });
    const p = (await readLatency(pool)).partitions[0]!;
    expect(p.wait.unmeasured).toBe(0);
    expect(p.wait.unordered).toBe(0);
    expect(p.service.unfinished).toBe(0);
    expect(p.service.unstamped).toBe(0);
    expect(p.service.unordered).toBe(0);
    expect(p.service.neverRan).toBe(0);
  });

  // The window is the whole point of a backdated history: a report that
  // could not exclude the seeded past would judge every day against itself.
  it('answers a window that excludes the backdated day', async () => {
    await seedFinishedRun({
      partition: 0,
      createdAt: new Date(`${DAY_ONE}T12:00:00.000Z`),
      waitMs: 30 * SECOND,
      serviceMs: 10 * SECOND,
    });
    await seedFinishedRun({
      partition: 1,
      createdAt: new Date(`${DAY_TWO}T12:00:00.000Z`),
      waitMs: 70 * SECOND,
      serviceMs: 25 * SECOND,
    });

    const all = await readLatency(pool);
    expect(all.runs).toBe(2);
    expect(all.partitions.map((x) => x.partition)).toEqual([0, 1]);

    const windowed = await readLatency(pool, { since: new Date(`${DAY_TWO}T00:00:00.000Z`) });
    expect(windowed.runs).toBe(1);
    expect(windowed.partitions).toHaveLength(1);
    expect(windowed.partitions[0]!.partition).toBe(1);
    expect(windowed.partitions[0]!.wait.p50Ms).toBe(70 * SECOND);
  });

  // `pnpm run bands` keys a day on created_at. Two backdated UTC days must
  // read as two days, which is what lets one day be judged against the
  // measured days before it.
  it('reads as separate UTC days to the control-band query', async () => {
    await seedFinishedRun({
      partition: 0,
      createdAt: new Date(`${DAY_ONE}T23:59:59.000Z`),
      waitMs: 10 * SECOND,
      serviceMs: 5 * SECOND,
    });
    await seedFinishedRun({
      partition: 0,
      createdAt: new Date(`${DAY_TWO}T00:00:01.000Z`),
      waitMs: 10 * SECOND,
      serviceMs: 5 * SECOND,
    });
    await seedFinishedRun({
      partition: 0,
      createdAt: new Date(`${DAY_TWO}T10:00:00.000Z`),
      waitMs: 10 * SECOND,
      serviceMs: 5 * SECOND,
    });

    const days = await readDays(
      pool,
      new Date(`${DAY_ONE}T00:00:00.000Z`),
      new Date('2026-06-03T00:00:00.000Z'),
    );
    expect(days.map((d) => d.day)).toEqual([DAY_ONE, DAY_TWO]);
    expect(days.map((d) => d.runs)).toEqual([1, 2]);
  });

  // The reader's `never_ran` label keys on both version pins reading
  // 'intake', not on a zero duration. So a seeded loser stamped with its own
  // creation instant read as `measured` with a service time of exactly zero
  // and entered the percentiles, and a history in which some runs lose the
  // race reported a service p50 no run took. The column stays null instead,
  // and the reader counts the row under `unstamped`, which is what it is.
  it('keeps a superseded loser out of the service percentiles', async () => {
    const createdAt = new Date(`${DAY_ONE}T12:00:00.000Z`);
    // One run that really did take 30 seconds, so the percentile has support.
    await seedFinishedRun({ partition: 0, createdAt, waitMs: 10 * SECOND, serviceMs: 30 * SECOND });
    // Three losers, enough to move a p50 if they counted as zero.
    for (let i = 0; i < 3; i += 1) {
      await seedSupersededLoser(createdAt, `idem-loser-${i}`);
    }

    const p = (await readLatency(pool)).partitions[0]!;
    expect(p.service.count).toBe(1);
    expect(p.service.p50Ms).toBe(30 * SECOND);
    expect(p.service.unstamped).toBe(3);
    // The three winners are still 'queued', so they sit under `unfinished`.
    // Each is a real row and it is counted as one, which is the point: no
    // count is inferred and no zero is manufactured.
    expect(p.service.unfinished).toBe(3);
    expect(p.service.unordered).toBe(0);
    expect(p.service.neverRan).toBe(0);
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM run WHERE state = 'superseded' AND finished_at IS NOT NULL",
    );
    expect((rows[0] as { n: number }).n).toBe(0);
  });

  // A day the window excludes produces no row, and a backdated history must
  // not leak into it. This is the property `pnpm run bands` relies on when
  // it says it never includes the day under test.
  it('produces no row for a day the window excludes', async () => {
    await seedFinishedRun({
      partition: 0,
      createdAt: new Date(`${DAY_ONE}T12:00:00.000Z`),
      waitMs: 10 * SECOND,
      serviceMs: 5 * SECOND,
    });
    const days = await readDays(
      pool,
      new Date(`${DAY_TWO}T00:00:00.000Z`),
      new Date('2026-06-03T00:00:00.000Z'),
    );
    expect(days).toEqual([]);
  });
});
