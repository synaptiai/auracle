// What reached a person today, against what arrived.
//
// Arrivals are inbound messages, one turn each. What reached the queue is the
// part of those arrivals whose run parked for a person, counted once per
// message however many runs retried it, and dated by when the message arrived.
// "Today" is the UTC day, as bands and latency read it.
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { dbUrl, readerDbUrl } from '../db/config.js';
import { enqueueTicket } from '../coordinator/intake.js';
import { fencedInsert } from '../ledger/insert.js';
import { truncateLedger } from '../test-support/schema.js';
import { readQueueToday } from './today.js';

const pool = new Pool({ connectionString: dbUrl() });
// The readers connect as the role that cannot act beyond a read.
const readers = new Pool({ connectionString: readerDbUrl(), max: 4 });
await pool.query('SELECT 1');

const NOW = new Date('2026-09-14T15:00:00Z');
const YESTERDAY = new Date('2026-09-13T23:30:00Z');

async function arrive(): Promise<{ conversationId: string; turnNumber: number; ticketId: string }> {
  const ticketId = 'T-' + randomUUID().slice(0, 8);
  const result = await enqueueTicket(
    pool,
    { ticketId, messageId: randomUUID(), ticketText: 'a synthetic question' },
    4,
  );
  return { conversationId: result.conversationId, turnNumber: result.turnNumber, ticketId };
}

async function runFor(
  turn: { conversationId: string; turnNumber: number; ticketId: string },
  state: string,
  epoch: bigint,
): Promise<string> {
  const runId = randomUUID();
  const inserted = await fencedInsert(
    pool,
    {
      runId,
      ticketId: turn.ticketId,
      partition: 0,
      epoch,
      state,
      promptVer: 'p1',
      modelVer: 'm1',
      conversationId: turn.conversationId,
      turnNumber: turn.turnNumber,
      deadlineAt: new Date(Date.now() + 60_000),
    },
    null,
  );
  expect(inserted).toEqual({ outcome: 'accepted' });
  return runId;
}

async function park(runId: string, status: 'done' | 'parking' | 'failed' = 'done'): Promise<void> {
  await pool.query(
    `INSERT INTO step_journal (run_id, step_id, status, result, prompt_ver, model_ver, cost_micros)
     VALUES ($1, 'park', $2, $3, 'today-test-prompt', 'today-test-model', 0)`,
    [runId, status, JSON.stringify({ actionClass: 'customer_reply', delivery: 'at_most_once', body: 'a draft' })],
  );
}

async function arrivedAt(turn: { conversationId: string }, at: Date): Promise<void> {
  await pool.query('UPDATE turn SET created_at = $2 WHERE conversation_id = $1', [turn.conversationId, at]);
}

async function stamp(table: 'run', column: 'created_at', id: string, at: Date): Promise<void> {
  await pool.query(`UPDATE ${table} SET ${column} = $2 WHERE run_id = $1`, [id, at]);
}

describe('what reached a person today', () => {
  beforeEach(async () => {
    await truncateLedger(pool);
  });

  afterEach(async () => {
    await truncateLedger(pool);
  });

  afterAll(async () => {
    await readers.end();
    await pool.end();
  });

  it('counts inbound messages, and the runs that parked for a person', async () => {
    const parked = await arrive();
    const answered = await arrive();
    await arrive(); // arrived; no run has picked it up yet
    await pool.query('UPDATE turn SET created_at = $1', [NOW]);

    const waiting = await runFor(parked, 'awaiting_approval', 1n);
    await park(waiting);
    await stamp('run', 'created_at', waiting, NOW);
    const resolved = await runFor(answered, 'resolved', 1n);
    await stamp('run', 'created_at', resolved, NOW);

    expect(await readQueueToday(readers, NOW)).toEqual({ day: '2026-09-14', arrived: 3, reachedQueue: 1 });
  });

  // A run approved later in the day has left the queue, but it did reach a
  // person, so it still counts.
  it('counts a parked run whose approval already resolved it', async () => {
    const turn = await arrive();
    await pool.query('UPDATE turn SET created_at = $2 WHERE conversation_id = $1', [turn.conversationId, NOW]);
    const run = await runFor(turn, 'resolved', 1n);
    await park(run);
    await stamp('run', 'created_at', run, NOW);

    expect(await readQueueToday(readers, NOW)).toMatchObject({ reachedQueue: 1 });
  });

  // Two runs of one message are one case for a person, not two.
  it('counts one message once however many runs parked it', async () => {
    const turn = await arrive();
    await pool.query('UPDATE turn SET created_at = $2 WHERE conversation_id = $1', [turn.conversationId, NOW]);
    const first = await runFor(turn, 'superseded', 1n);
    await park(first);
    const retry = await runFor(turn, 'awaiting_approval', 2n);
    await park(retry);
    await stamp('run', 'created_at', first, NOW);
    await stamp('run', 'created_at', retry, NOW);

    expect(await readQueueToday(readers, NOW)).toEqual({ day: '2026-09-14', arrived: 1, reachedQueue: 1 });
  });

  // The UTC day, and nothing from the day before.
  it('leaves out yesterday, on the UTC calendar', async () => {
    const old = await arrive();
    await pool.query('UPDATE turn SET created_at = $2 WHERE conversation_id = $1', [old.conversationId, YESTERDAY]);
    const run = await runFor(old, 'awaiting_approval', 1n);
    await park(run);
    await stamp('run', 'created_at', run, YESTERDAY);

    expect(await readQueueToday(readers, NOW)).toEqual({ day: '2026-09-14', arrived: 0, reachedQueue: 0 });
  });

  // Dated by the message, not the run. A message that arrived before midnight
  // and parked after it belongs to the day it arrived.
  it('dates a parked case by the day its message arrived', async () => {
    const late = await arrive();
    await arrivedAt(late, new Date('2026-09-13T23:58:00Z'));
    const run = await runFor(late, 'awaiting_approval', 1n);
    await park(run);
    await stamp('run', 'created_at', run, new Date('2026-09-14T00:02:00Z'));

    expect(await readQueueToday(readers, NOW)).toEqual({ day: '2026-09-14', arrived: 0, reachedQueue: 0 });
    expect(await readQueueToday(readers, new Date('2026-09-13T12:00:00Z')))
      .toEqual({ day: '2026-09-13', arrived: 1, reachedQueue: 1 });
  });

  // A redelivery the next day makes a new run and no new turn. It is still
  // yesterday's message.
  it('does not count a message again when a later run retries it', async () => {
    const turn = await arrive();
    await arrivedAt(turn, YESTERDAY);
    const first = await runFor(turn, 'superseded', 1n);
    await park(first);
    await stamp('run', 'created_at', first, YESTERDAY);
    const retry = await runFor(turn, 'awaiting_approval', 2n);
    await park(retry);
    await stamp('run', 'created_at', retry, NOW);

    expect(await readQueueToday(readers, NOW)).toEqual({ day: '2026-09-14', arrived: 0, reachedQueue: 0 });
  });

  // A park that crashed mid-write, or failed, put nothing in front of a person.
  it('does not count a park that did not finish', async () => {
    for (const status of ['parking', 'failed'] as const) {
      const turn = await arrive();
      await arrivedAt(turn, NOW);
      const run = await runFor(turn, 'escalated', 1n);
      await park(run, status);
      await stamp('run', 'created_at', run, NOW);
    }

    expect(await readQueueToday(readers, NOW)).toEqual({ day: '2026-09-14', arrived: 2, reachedQueue: 0 });
  });

  // A run from before runs recorded their message has no turn to date it by,
  // so its own start day places it, once.
  it('places a run with no recorded message by its own start day', async () => {
    const turn = await arrive();
    const run = await runFor(turn, 'awaiting_approval', 1n);
    await park(run);
    await pool.query('UPDATE run SET conversation_id = NULL, turn_number = NULL, created_at = $2 WHERE run_id = $1', [run, NOW]);
    await arrivedAt(turn, YESTERDAY);

    expect(await readQueueToday(readers, NOW)).toEqual({ day: '2026-09-14', arrived: 0, reachedQueue: 1 });
  });

  // The day is UTC whatever zone the session runs in. A session far east of
  // UTC puts 23:30Z yesterday on today's local date.
  it('reads the UTC day in a session set to another zone', async () => {
    const early = await arrive();
    await arrivedAt(early, YESTERDAY);
    const today = await arrive();
    await arrivedAt(today, new Date('2026-09-14T00:30:00Z'));
    const run = await runFor(today, 'awaiting_approval', 1n);
    await park(run);
    await stamp('run', 'created_at', run, new Date('2026-09-14T00:30:00Z'));

    const auckland = new Pool({ connectionString: readerDbUrl(), options: '-c TimeZone=Pacific/Auckland' });
    try {
      const zone = await auckland.query<{ TimeZone: string }>('SHOW TimeZone');
      expect(zone.rows[0]!.TimeZone).toBe('Pacific/Auckland');
      expect(await readQueueToday(auckland, NOW)).toEqual({ day: '2026-09-14', arrived: 1, reachedQueue: 1 });
    } finally {
      await auckland.end();
    }
  });

  // The day is half-open: its first instant counts, the next day's first
  // instant does not. For a message and for a run that recorded none.
  it('counts from the first instant of the day and stops before the next', async () => {
    const START = new Date('2026-09-14T00:00:00Z');
    const NEXT = new Date('2026-09-15T00:00:00Z');
    for (const at of [START, NEXT]) {
      const turn = await arrive();
      await arrivedAt(turn, at);
      const run = await runFor(turn, 'awaiting_approval', 1n);
      await park(run);
      await stamp('run', 'created_at', run, at);
    }
    for (const at of [YESTERDAY, START, NEXT]) {
      const orphan = await arrive();
      const run = await runFor(orphan, 'awaiting_approval', 1n);
      await park(run);
      await pool.query(
        'UPDATE run SET conversation_id = NULL, turn_number = NULL, created_at = $2 WHERE run_id = $1',
        [run, at],
      );
      await arrivedAt(orphan, new Date('2026-09-10T12:00:00Z'));
    }

    // One turn and one run with no turn, both at the day's first instant.
    expect(await readQueueToday(readers, NOW)).toEqual({ day: '2026-09-14', arrived: 1, reachedQueue: 2 });
  });

  // The console reads this on every load of its landing page, so a read that
  // cannot finish gives up rather than holding a pool connection. A lock on
  // turn makes the wait certain.
  it('gives up when the read outlasts its timeout', async () => {
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE turn IN ACCESS EXCLUSIVE MODE');
      const started = Date.now();
      await expect(readQueueToday(readers, NOW, 200)).rejects.toThrow(/statement timeout/);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  });

  // The connection that timed out goes back to the pool usable, with no
  // timeout left on it. A pool of one makes the next reads use that same
  // connection.
  it('returns the connection that timed out clean', async () => {
    const single = new Pool({ connectionString: readerDbUrl(), max: 1 });
    const holder = await pool.connect();
    let locked = false;
    const backend = async (): Promise<number> =>
      (await single.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    try {
      const before = await backend();
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE turn IN ACCESS EXCLUSIVE MODE');
      locked = true;
      await expect(readQueueToday(single, NOW, 200)).rejects.toThrow(/statement timeout/);
      await holder.query('ROLLBACK');
      locked = false;
      // The same session, not a replacement the pool opened after dropping it.
      expect(await backend()).toBe(before);
      expect(await readQueueToday(single, NOW)).toEqual({ day: '2026-09-14', arrived: 0, reachedQueue: 0 });
      const setting = await single.query<{ statement_timeout: string; in_tx: boolean }>(
        `SELECT current_setting('statement_timeout') AS statement_timeout,
                now() <> statement_timestamp() AS in_tx`,
      );
      expect(setting.rows[0]).toEqual({ statement_timeout: '0', in_tx: false });
      expect(await backend()).toBe(before);
    } finally {
      if (locked) await holder.query('ROLLBACK');
      holder.release();
      await single.end();
    }
  });

  // A connection that died answers no statement timeout, because the server
  // cannot reach the client. The client gives up on its own bound, and the
  // connection it gave up on is destroyed, never returned. A lock stands in for
  // the silence: the server-side timeout is set far past the client's.
  it('gives up on its own bound and destroys the connection it gave up on', async () => {
    const single = new Pool({ connectionString: readerDbUrl(), max: 1 });
    const holder = await pool.connect();
    let locked = false;
    const backend = async (): Promise<number> =>
      (await single.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    try {
      const before = await backend();
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE turn IN ACCESS EXCLUSIVE MODE');
      locked = true;
      const started = Date.now();
      await expect(readQueueToday(single, NOW, 60_000, 300)).rejects.toThrow(/timeout/i);
      expect(Date.now() - started).toBeLessThan(5_000);
      await holder.query('ROLLBACK');
      locked = false;
      // A new session: the pool dropped the one it could not trust.
      expect(await backend()).not.toBe(before);
      expect(await readQueueToday(single, NOW)).toEqual({ day: '2026-09-14', arrived: 0, reachedQueue: 0 });
    } finally {
      if (locked) await holder.query('ROLLBACK');
      holder.release();
      await single.end();
    }
  });

  // A bound of NaN, Infinity, 0 or more than a timer keeps bounds nothing, so
  // it is refused, and no connection is taken for it.
  it('refuses a bound outside 1 to 2147483647 milliseconds', async () => {
    const counting = new Pool({ connectionString: readerDbUrl(), max: 1 });
    try {
      const cases = [
        [Number.NaN, 1_000], [2_000, Number.POSITIVE_INFINITY], [0, 1_000], [2_000, 2_147_483_648],
      ] as const;
      for (const [timeout, client] of cases) {
        await expect(readQueueToday(counting, NOW, timeout, client))
          .rejects.toThrow(/must be between 1 and 2147483647 milliseconds/);
      }
      // The default client bound is a second past the statement's, so a
      // statement bound within a second of the limit is refused as well.
      await expect(readQueueToday(counting, NOW, 2_147_483_000))
        .rejects.toThrow(/clientTimeoutMs must be between/);
      expect(counting.totalCount).toBe(0);
    } finally {
      await counting.end();
    }
  });

  // A run with no park row went nowhere near a person.
  it('does not count a run that never parked', async () => {
    const turn = await arrive();
    await pool.query('UPDATE turn SET created_at = $2 WHERE conversation_id = $1', [turn.conversationId, NOW]);
    const run = await runFor(turn, 'escalated', 1n);
    await stamp('run', 'created_at', run, NOW);

    expect(await readQueueToday(readers, NOW)).toMatchObject({ reachedQueue: 0 });
  });
});
