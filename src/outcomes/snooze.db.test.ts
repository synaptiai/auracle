/**
 * DEC-48: a case a reviewer puts aside for a period.
 *
 * The cases are about the three things a snooze must do. It takes the case
 * out of the queue without ending it, and records when it is due back. It
 * comes back when the period ends, or ends `superseded` when the customer
 * writes first. And it never counts as work: the reservation (DEC-46) is
 * untouched, and no record reaches the relay.
 */
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { HelpdeskAdapter } from '../adapters/helpdesk.js';
import { CUSTOMER_REPLY_ACTION_CLASS } from '../adapters/types.js';
import { replyDigest } from '../approval/shown.js';
import { coordinateTicket } from '../coordinator/coordinator.js';
import type { CoordinatorDeps } from '../coordinator/coordinator.js';
import { ackTicket, enqueueTicket } from '../coordinator/intake.js';
import { dbUrl } from '../db/config.js';
import { takeHold, readHold } from '../holds/hold.js';
import { FakeProvider } from '../models/fake.js';
import type { FakeStep } from '../models/fake.js';
import type { AdapterCapabilities } from '../policy/policy.js';
import { indexDocument } from '../retriever/retriever.js';
import { truncateLedger } from '../test-support/schema.js';

import { MAX_SNOOZE_MS, MIN_SNOOZE_MS, endSnoozedIn, snoozeRun, unsnoozeExpired } from './snooze.js';

const pool = new Pool({ connectionString: dbUrl(), max: 8 });

afterAll(async () => {
  await pool.end();
});

await pool.query('SELECT 1');

const PINS = { promptVer: 'snooze-prompt', modelVer: 'snooze-model' };
const CAPABILITIES: AdapterCapabilities = {
  supportsIdempotencyKey: true,
  supportsReadBack: true,
  supportsDraftState: true,
  supportsStructuredFields: true,
  supportsThreading: true,
  supportsLedgerReply: false,
};
const TICKET_TEXT = 'I cannot sign in to my account. How do I reset my password?';
const DISCLOSURE = 'This reply was drafted by an automated assistant and approved by a person.';
const VEC = Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0));

/** Two hours, the period most cases here set. */
const PERIOD_MS = 2 * 60 * 60_000;

function happyScript(): FakeStep[] {
  return [
    ...Array.from({ length: 9 }, () => ({ text: 'password_reset' })),
    { vectors: [VEC] },
    { text: '[doc:d1] Open the account settings page and choose reset password.' },
    { text: 'VERDICT: SUPPORTED' },
  ];
}

function makeDeps(egress: HelpdeskAdapter): CoordinatorDeps {
  return {
    pool,
    provider: new FakeProvider(happyScript()),
    taxonomy: { intents: [{ id: 'password_reset', label: 'Password reset', risk_tier: 'low' }] },
    capabilities: CAPABILITIES,
    egress,
    pins: PINS,
    limits: { maxCostMicros: 100_000_000, maxSteps: 50, deadlineAt: new Date(Date.now() + 60_000) },
    partitionCount: 8,
  };
}

function helpdeskWith(ticketId: string): HelpdeskAdapter {
  return new HelpdeskAdapter([
    { ticketId, subject: 'Cannot sign in', queue: 'accounts', status: 'open', customerAddress: null },
  ]);
}

interface Parked {
  readonly runId: string;
  readonly ticketId: string;
  readonly conversationId: string;
  readonly partition: number;
  readonly parkedBody: string;
}

async function parkOnTurnOne(ticketId: string): Promise<Parked> {
  const enqueued = await enqueueTicket(
    pool,
    { ticketId, messageId: `m-1-${ticketId}@example.test`, ticketText: TICKET_TEXT },
    8,
  );
  const result = await coordinateTicket(makeDeps(helpdeskWith(ticketId)), {
    ticketId,
    ticketText: TICKET_TEXT,
    epoch: 1n,
    conversationId: enqueued.conversationId,
    turnNumber: enqueued.turnNumber,
    actionClass: CUSTOMER_REPLY_ACTION_CLASS,
    actionPayload: { summary: 'password reset answer' },
    delivery: 'at_least_once',
    isCustomerVisible: true,
    disclosure: DISCLOSURE,
  });
  if (result.outcome !== 'awaiting_approval') {
    throw new Error(`expected awaiting_approval, got ${result.outcome}`);
  }
  const rows = await pool.query<{ partition: number; body: string }>(
    `SELECT r.partition, j.result->>'body' AS body
       FROM run r JOIN step_journal j ON j.run_id = r.run_id AND j.step_id = 'park'
      WHERE r.run_id = $1`,
    [result.runId],
  );
  return {
    runId: result.runId,
    ticketId,
    conversationId: enqueued.conversationId,
    partition: rows.rows[0]!.partition,
    parkedBody: rows.rows[0]!.body,
  };
}

interface RunRow {
  state: string;
  snoozed_until: Date | null;
  finished_at: Date | null;
  approved_by: string | null;
}

async function runRow(runId: string): Promise<RunRow> {
  const rows = await pool.query(
    'SELECT state, snoozed_until, finished_at, approved_by FROM run WHERE run_id = $1',
    [runId],
  );
  return rows.rows[0] as never;
}

async function outboxCount(runId: string): Promise<number> {
  const rows = await pool.query<{ n: string }>(
    'SELECT count(*) AS n FROM outbox WHERE run_id = $1',
    [runId],
  );
  return Number(rows.rows[0]!.n);
}

/** Moves a snoozed run's period into the past, so the returner reads it as due. */
async function expire(runId: string): Promise<void> {
  await pool.query(
    "UPDATE run SET snoozed_until = now() - interval '1 second' WHERE run_id = $1",
    [runId],
  );
}

async function journalRows(runId: string): Promise<Array<{ step_id: string; result: unknown }>> {
  const rows = await pool.query(
    'SELECT step_id, result FROM step_journal WHERE run_id = $1 ORDER BY step_id',
    [runId],
  );
  return rows.rows as never;
}

beforeEach(async () => {
  await truncateLedger(pool);
  await indexDocument(
    pool,
    {
      docId: 'd1',
      kind: 'document',
      title: 'Reset your password',
      body: 'Open the account settings page and choose security. Choose reset password and follow the link we email you.',
      owner: 'synthetic-owner',
      reviewBy: '2999-01-01',
    },
    VEC,
  );
});

describe('DEC-48: a snoozed case', () => {
  it('takes the case out of the queue without ending it, and records when it is due', async () => {
    const { runId } = await parkOnTurnOne(`T-${randomUUID().slice(0, 8)}`);
    await takeHold(pool, { runId, reviewer: 'anna@example.test', lapseMs: 20 * 60_000 });

    expect(await snoozeRun(pool, runId, {
      periodMs: PERIOD_MS,
      snoozedBy: 'anna@example.test',
      snoozedBySource: 'roster',
    })).toEqual({ outcome: 'snoozed' });

    const run = await runRow(runId);
    expect(run.state).toBe('snoozed');
    // Not terminal: no finish time, and the case is not resolved.
    expect(run.finished_at).toBeNull();
    // Due back one period from the ledger's own clock, to the second.
    const due = run.snoozed_until!.getTime() - Date.now();
    expect(Math.abs(due - PERIOD_MS)).toBeLessThan(5_000);
    // Nothing sends, and no approver is recorded: a snooze is not an
    // approval.
    expect(await outboxCount(runId)).toBe(0);
    expect(run.approved_by).toBeNull();

    // The record of who set it and when it is due. The moment is the one the
    // column holds, to the millisecond: a missing field here would otherwise
    // read as the string "undefined" and pass.
    const snooze = (await journalRows(runId)).find((row) => row.step_id === 'snooze');
    expect(snooze?.result).toMatchObject({ reviewer: 'anna@example.test', reviewerSource: 'roster' });
    const journalled = (snooze?.result as { until: string }).until;
    expect(typeof journalled).toBe('string');
    expect(new Date(journalled).toISOString()).toBe(run.snoozed_until!.toISOString());

    // DEC-46 is unaffected by a snooze: the reservation is the holder's, and
    // it stays theirs while the case is put aside.
    expect((await readHold(pool, runId))?.reviewer).toBe('anna@example.test');
  });

  it('refuses a period outside its bounds, and one that is not whole milliseconds', async () => {
    const { runId } = await parkOnTurnOne(`T-${randomUUID().slice(0, 8)}`);

    expect(await snoozeRun(pool, runId, { periodMs: MIN_SNOOZE_MS - 1, snoozedBy: 'anna@example.test' }))
      .toEqual({ outcome: 'period_out_of_range' });
    expect(await snoozeRun(pool, runId, { periodMs: MAX_SNOOZE_MS + 1, snoozedBy: 'anna@example.test' }))
      .toEqual({ outcome: 'period_out_of_range' });

    // What a caller that does not read the form sends. The console answers a
    // non-numeric field with the infinity sentinel, and the ledger refuses it
    // here rather than storing it: the guard runs before the first statement,
    // so no row is read and the case stays where it is.
    const malformed = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      1.5,
      -1,
      0,
      2 ** 53,
    ];
    for (const periodMs of malformed) {
      expect(await snoozeRun(pool, runId, { periodMs, snoozedBy: 'anna@example.test' }), String(periodMs))
        .toEqual({ outcome: 'period_out_of_range' });
    }
    expect((await runRow(runId)).state).toBe('awaiting_approval');

    // The bounds themselves are inside, both of them: the floor and the
    // ceiling are values the callers may set, not values the guard refuses.
    expect(await snoozeRun(pool, runId, { periodMs: MIN_SNOOZE_MS, snoozedBy: 'anna@example.test' }))
      .toEqual({ outcome: 'snoozed' });
    const ceiling = await parkOnTurnOne(`T-${randomUUID().slice(0, 8)}`);
    expect(await snoozeRun(pool, ceiling.runId, {
      periodMs: MAX_SNOOZE_MS,
      snoozedBy: 'anna@example.test',
    })).toEqual({ outcome: 'snoozed' });
  });

  it('answers a run the ledger does not hold, and records who set the snooze', async () => {
    expect(await snoozeRun(pool, randomUUID(), { periodMs: PERIOD_MS, snoozedBy: 'anna@example.test' }))
      .toEqual({ outcome: 'unknown_run' });

    const { runId } = await parkOnTurnOne(`T-${randomUUID().slice(0, 8)}`);
    // DEC-42, DEC-45: a name with no source stated is the header's, and no
    // name at all is recorded as unattributed rather than left out.
    expect(await snoozeRun(pool, runId, { periodMs: PERIOD_MS, snoozedBy: 'anna@example.test' }))
      .toEqual({ outcome: 'snoozed' });
    const named = (await journalRows(runId)).find((row) => row.step_id === 'snooze');
    expect(named?.result).toMatchObject({ reviewer: 'anna@example.test', reviewerSource: 'header' });

    const second = await parkOnTurnOne(`T-${randomUUID().slice(0, 8)}`);
    expect(await snoozeRun(pool, second.runId, { periodMs: PERIOD_MS }))
      .toEqual({ outcome: 'snoozed' });
    const anonymous = (await journalRows(second.runId)).find((row) => row.step_id === 'snooze');
    expect(anonymous?.result).toMatchObject({ reviewerSource: 'none' });
  });

  it('puts a returned case aside again, and brings it back a second time', async () => {
    // The ordinary repeat: the period ends, the case returns to the queue,
    // and the reviewer sets another period. Both journal rows are the step's
    // own, so the second cycle rewrites them and the pair names the latest.
    const parked = await parkOnTurnOne(`T-${randomUUID().slice(0, 8)}`);
    await snoozeRun(pool, parked.runId, { periodMs: PERIOD_MS, snoozedBy: 'anna@example.test' });
    await expire(parked.runId);
    expect(await unsnoozeExpired(pool, [parked.partition])).toEqual([parked.runId]);

    expect(await snoozeRun(pool, parked.runId, { periodMs: PERIOD_MS, snoozedBy: 'bo@example.test' }))
      .toEqual({ outcome: 'snoozed' });
    expect((await runRow(parked.runId)).state).toBe('snoozed');

    await expire(parked.runId);
    expect(await unsnoozeExpired(pool, [parked.partition])).toEqual([parked.runId]);
    expect((await runRow(parked.runId)).state).toBe('awaiting_approval');
    expect(await outboxCount(parked.runId)).toBe(0);

    const rows = await journalRows(parked.runId);
    const snooze = rows.filter((row) => row.step_id === 'snooze');
    const unsnooze = rows.filter((row) => row.step_id === 'unsnooze');
    expect(snooze).toHaveLength(1);
    expect(unsnooze).toHaveLength(1);
    expect(snooze[0]!.result).toMatchObject({ reviewer: 'bo@example.test', periodMs: PERIOD_MS });
  });

  it('returns a due case while another writer holds the ticket fence', async () => {
    // The lock order. Intake takes the fence row first and then the runs of
    // that conversation (`endSnoozedIn`); a returner that reached for the
    // fence after its own run row closed a cycle with it, and Postgres
    // aborted one of the two. The returner therefore takes no fence lock:
    // what guards this write is the run row, the state it requires, and the
    // parked escape, so a writer holding the fence cannot block it.
    const parked = await parkOnTurnOne(`T-${randomUUID().slice(0, 8)}`);
    await snoozeRun(pool, parked.runId, { periodMs: PERIOD_MS, snoozedBy: 'anna@example.test' });
    await expire(parked.runId);

    const client = await pool.connect();
    let returning: Promise<string[]> | null = null;
    try {
      await client.query('BEGIN');
      // Intake's first lock, held for the whole transaction.
      await client.query('SELECT epoch FROM ticket_epoch WHERE ticket_id = $1 FOR UPDATE', [
        parked.ticketId,
      ]);

      returning = unsnoozeExpired(pool, [parked.partition]);
      const waited = await Promise.race([
        returning.then(() => 'returned' as const),
        new Promise<'waited'>((resolve) => setTimeout(() => resolve('waited'), 5_000)),
      ]);
      // Released before the assertion, so a run that waited does not leave a
      // blocked query behind on a pooled connection.
      await client.query('COMMIT');
      expect(waited).toBe('returned');
      expect(await returning).toEqual([parked.runId]);
    } finally {
      if (returning !== null) await returning.catch(() => []);
      client.release();
    }

    // And the message's side of intake then finds nothing to supersede: the
    // case it would have ended had already returned.
    const late = await pool.query(
      "UPDATE run SET state = 'superseded' WHERE run_id = $1 AND state = 'snoozed' RETURNING run_id",
      [parked.runId],
    );
    expect(late.rowCount).toBe(0);
    expect((await runRow(parked.runId)).state).toBe('awaiting_approval');
  });

  it('refuses a run that is not waiting for a person, and names its state', async () => {
    const { runId } = await parkOnTurnOne(`T-${randomUUID().slice(0, 8)}`);
    await snoozeRun(pool, runId, { periodMs: PERIOD_MS, snoozedBy: 'anna@example.test' });

    expect(await snoozeRun(pool, runId, { periodMs: PERIOD_MS, snoozedBy: 'bo@example.test' }))
      .toEqual({ outcome: 'not_awaiting_approval', state: 'snoozed' });
  });

  it('refuses a snooze from a page whose reply moved, and takes the one that did not', async () => {
    const { runId, parkedBody } = await parkOnTurnOne(`T-${randomUUID().slice(0, 8)}`);

    expect(await snoozeRun(pool, runId, {
      periodMs: PERIOD_MS,
      snoozedBy: 'anna@example.test',
      shown: replyDigest(`${parkedBody} Edited elsewhere.`),
    })).toEqual({ outcome: 'shown_changed' });
    expect((await runRow(runId)).state).toBe('awaiting_approval');

    expect(await snoozeRun(pool, runId, {
      periodMs: PERIOD_MS,
      snoozedBy: 'anna@example.test',
      shown: replyDigest(parkedBody),
    })).toEqual({ outcome: 'snoozed' });
  });

  it('returns a due case to the queue, and leaves one that is not due yet', async () => {
    const due = await parkOnTurnOne(`T-${randomUUID().slice(0, 8)}`);
    const later = await parkOnTurnOne(`T-${randomUUID().slice(0, 8)}`);
    await snoozeRun(pool, due.runId, { periodMs: PERIOD_MS, snoozedBy: 'anna@example.test' });
    await snoozeRun(pool, later.runId, { periodMs: PERIOD_MS, snoozedBy: 'anna@example.test' });
    // The period of one of them has passed.
    await expire(due.runId);

    const returned = await unsnoozeExpired(pool, [0, 1, 2, 3, 4, 5, 6, 7]);
    expect(returned).toEqual([due.runId]);

    const run = await runRow(due.runId);
    expect(run.state).toBe('awaiting_approval');
    // The moment stays: it is the record that the run was ever snoozed.
    expect(run.snoozed_until).not.toBeNull();
    expect(run.finished_at).toBeNull();
    // The return is journalled, and writes no record.
    expect((await journalRows(due.runId)).some((row) => row.step_id === 'unsnooze')).toBe(true);
    expect(await outboxCount(due.runId)).toBe(0);

    expect((await runRow(later.runId)).state).toBe('snoozed');
  });

  it('returns only the cases of the partitions it was asked about', async () => {
    const parked = await parkOnTurnOne(`T-${randomUUID().slice(0, 8)}`);
    await snoozeRun(pool, parked.runId, { periodMs: PERIOD_MS, snoozedBy: 'anna@example.test' });
    await expire(parked.runId);

    const other = [...Array(8).keys()].filter((p) => p !== parked.partition);
    expect(await unsnoozeExpired(pool, other)).toEqual([]);
    expect((await runRow(parked.runId)).state).toBe('snoozed');
  });

  it('ends the snooze when the customer writes, and leaves the turn to the new run', async () => {
    const parked = await parkOnTurnOne(`T-${randomUUID().slice(0, 8)}`);
    await snoozeRun(pool, parked.runId, { periodMs: PERIOD_MS, snoozedBy: 'anna@example.test' });

    // The next message of the same conversation, in intake's own transaction.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      expect(await endSnoozedIn(client, parked.conversationId)).toEqual([parked.runId]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const run = await runRow(parked.runId);
    expect(run.state).toBe('superseded');
    // A terminal state, so the finish is stamped in the same commit.
    expect(run.finished_at).not.toBeNull();
    expect(await outboxCount(parked.runId)).toBe(0);

    // Nothing left to return, and the second call is a no-op.
    const client2 = await pool.connect();
    try {
      await client2.query('BEGIN');
      expect(await endSnoozedIn(client2, parked.conversationId)).toEqual([]);
      await client2.query('COMMIT');
    } finally {
      client2.release();
    }
  });

  // The wiring, and not only the function: a snooze the customer answers has
  // to end through the path their message takes. `endSnoozedIn` was written
  // and tested before anything called it, and this is the case that fails
  // when intake forgets.
  it('ends the snooze through intake when the customer writes again', async () => {
    const parked = await parkOnTurnOne(`T-${randomUUID().slice(0, 8)}`);
    await snoozeRun(pool, parked.runId, { periodMs: PERIOD_MS, snoozedBy: 'anna@example.test' });

    await enqueueTicket(
      pool,
      {
        ticketId: parked.ticketId,
        messageId: `m-2-${parked.ticketId}@example.test`,
        ticketText: 'Any news on this?',
      },
      8,
    );

    const run = await runRow(parked.runId);
    expect(run.state).toBe('superseded');
    expect(run.finished_at).not.toBeNull();
    expect(await outboxCount(parked.runId)).toBe(0);

    // The clock then finds nothing to bring back. A run a newer turn replaced
    // never returns, even once its period has passed.
    await expire(parked.runId);
    expect(await unsnoozeExpired(pool, [parked.partition])).toEqual([]);
    expect((await runRow(parked.runId)).state).toBe('superseded');
  });

  // A redelivery is not the customer writing again. The same message arriving
  // twice must not end a snooze a later turn's reviewer set.
  //
  // The message is acked first, so the redelivery meets the conversation's
  // own record of the turn rather than the queue row it was already holding.
  // Without the ack this case never reaches the guard it names: intake answers
  // from the queue row and the test passes whatever the guard does.
  it('leaves a snooze standing when an old message is redelivered', async () => {
    const parked = await parkOnTurnOne(`T-${randomUUID().slice(0, 8)}`);
    await snoozeRun(pool, parked.runId, { periodMs: PERIOD_MS, snoozedBy: 'anna@example.test' });

    // The consumer's own ack, so the queue row the first delivery left is gone.
    await ackTicket(pool, parked.ticketId, `m-1-${parked.ticketId}@example.test`);
    // The first message of this conversation, arriving again.
    const again = await enqueueTicket(
      pool,
      {
        ticketId: parked.ticketId,
        messageId: `m-1-${parked.ticketId}@example.test`,
        ticketText: TICKET_TEXT,
      },
      8,
    );
    // The path, and not only the outcome: one queued row, and the turn the
    // conversation already held. A second turn would say the guard was passed.
    expect(again.enqueued).toBe(true);
    const turns = await pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM turn WHERE conversation_id = $1',
      [parked.conversationId],
    );
    expect(turns.rows[0]!.n).toBe('1');
    expect((await runRow(parked.runId)).state).toBe('snoozed');
  });

  // The clock is the ordinary winner: the period ends, the case comes back,
  // and the customer writes after it. The returned run still answered the
  // older turn, so the newer one replaces it rather than leaving it in the
  // queue beside the new run.
  it('ends a case the clock already returned when the customer writes', async () => {
    const parked = await parkOnTurnOne(`T-${randomUUID().slice(0, 8)}`);
    await snoozeRun(pool, parked.runId, { periodMs: PERIOD_MS, snoozedBy: 'anna@example.test' });
    await expire(parked.runId);
    expect(await unsnoozeExpired(pool, [parked.partition])).toEqual([parked.runId]);
    expect((await runRow(parked.runId)).state).toBe('awaiting_approval');

    await enqueueTicket(
      pool,
      {
        ticketId: parked.ticketId,
        messageId: `m-2-${parked.ticketId}@example.test`,
        ticketText: 'Any news on this?',
      },
      8,
    );

    const run = await runRow(parked.runId);
    expect(run.state).toBe('superseded');
    expect(run.finished_at).not.toBeNull();
    expect(await outboxCount(parked.runId)).toBe(0);
  });

  it('does not end a run that is waiting for a person rather than snoozed', async () => {
    const parked = await parkOnTurnOne(`T-${randomUUID().slice(0, 8)}`);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      expect(await endSnoozedIn(client, parked.conversationId)).toEqual([]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    expect((await runRow(parked.runId)).state).toBe('awaiting_approval');
    // The part the widened predicate turns on: a case nobody put aside
    // carries no moment, so it stays a person's to answer.
    expect((await runRow(parked.runId)).snoozed_until).toBeNull();
  });
});
