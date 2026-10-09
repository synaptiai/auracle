// A redelivered message never earns its turn a second customer reply.
//
// A message source delivers at least once, so a message the system already
// answered can arrive again. Intake files it on the same turn (DEC-38), and
// the consumer walks it to a second park. On a helpdesk that takes no
// idempotency key, every park creates a new draft, so the second park holds
// a new handle, and approving it would derive a new send key (DEC-24): the
// outbox key alone would not stop a second reply. These cases walk that path
// through the real queue, the real consumer poll and the real relay.
// Synthetic data only (DEC-18).
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { HelpdeskAdapter } from '../adapters/helpdesk.js';
import { IMAP_SMTP_CAPABILITIES } from '../adapters/imap-smtp.js';
import type { DraftReply } from '../adapters/types.js';
import { COMPENSATION_ACTION_CLASS, CUSTOMER_REPLY_ACTION_CLASS } from '../adapters/types.js';
import { processQueuedTickets, startSentBackAttempts } from '../coordinator/consumer.js';
import type { ConsumerOptions } from '../coordinator/consumer.js';
import { coordinateTicket } from '../coordinator/coordinator.js';
import type { CoordinatorDeps } from '../coordinator/coordinator.js';
import type { CoordinateInput, CoordinateOutcome } from '../coordinator/types.js';
import { enqueueTicket } from '../coordinator/intake.js';
import { listRuns, readRun } from '../escalations/query.js';
import { dbUrl } from '../db/config.js';
import { FakeProvider } from '../models/fake.js';
import type { FakeStep } from '../models/fake.js';
import type { AdapterCapabilities } from '../policy/policy.js';
import { relayPending } from '../relay/relay.js';
import { indexDocument } from '../retriever/retriever.js';
import { asIfRacing } from '../test-support/race-twin.js';
import { truncateLedger } from '../test-support/schema.js';

import { snoozeRun } from '../outcomes/snooze.js';

import { approveRun } from './approve.js';
import { undoApproval } from './undo.js';

const pool = new Pool({ connectionString: dbUrl(), max: 8 });
await pool.query('SELECT 1');

afterAll(async () => {
  await pool.end();
});

const PARTITIONS = 8;
const PINS = { promptVer: 'redelivery-prompt', modelVer: 'redelivery-model' };
const TICKET_TEXT = 'I cannot sign in to my account. How do I reset my password?';
const DISCLOSURE = 'This reply was drafted by an automated assistant and approved by a person.';
const VEC = Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0));

/**
 * A helpdesk that parks a new draft on every park, whatever the key.
 *
 * FreeScout's shape: its API takes no idempotency key, so a second park of
 * one reply is a second draft thread with a handle of its own. The in-memory
 * helpdesk returns the first draft for a repeated key, which is the shape
 * that hides this path.
 */
class NewDraftEachPark extends HelpdeskAdapter {
  /** How many drafts this helpdesk now holds. */
  parks = 0;

  override async createDraft(reply: DraftReply): Promise<{ readonly draftExternalId: string }> {
    this.parks += 1;
    return super.createDraft({ ...reply, idemKey: `${reply.idemKey}#park-${String(this.parks)}` });
  }
}

/** FreeScout's declaration, for the paths a customer reply takes. */
const NO_IDEMPOTENCY: AdapterCapabilities = {
  supportsIdempotencyKey: false,
  supportsReadBack: false,
  supportsDraftState: true,
  supportsStructuredFields: false,
  supportsThreading: true,
  supportsLedgerReply: false,
};

function happyScript(): FakeStep[] {
  return [
    ...Array.from({ length: 9 }, () => ({ text: 'password_reset' })),
    { vectors: [VEC] },
    { text: '[doc:d1] Open the account settings page and choose reset password.' },
    { text: 'VERDICT: SUPPORTED' },
  ];
}

function deps(egress: HelpdeskAdapter, capabilities: AdapterCapabilities): CoordinatorDeps {
  return {
    pool,
    // Three walks' worth: the first delivery and up to two redeliveries.
    provider: new FakeProvider([...happyScript(), ...happyScript(), ...happyScript()]),
    taxonomy: { intents: [{ id: 'password_reset', label: 'Password reset', risk_tier: 'low' }] },
    capabilities,
    egress,
    pins: PINS,
    limits: { maxCostMicros: 100_000_000, maxSteps: 50, deadlineAt: new Date(Date.now() + 60_000) },
    partitionCount: PARTITIONS,
  };
}

const OPTIONS: ConsumerOptions = {
  partitions: [0, 1, 2, 3, 4, 5, 6, 7],
  intervalMs: 1000,
  action: {
    actionClass: CUSTOMER_REPLY_ACTION_CLASS,
    actionPayload: { summary: 'password reset answer' },
    delivery: 'at_least_once',
    isCustomerVisible: true,
    disclosure: DISCLOSURE,
  },
};

interface TurnRun {
  readonly runId: string;
  readonly state: string;
  readonly draft: string | null;
}

async function runsOfTurn(ticketId: string): Promise<TurnRun[]> {
  const { rows } = await pool.query<{ run_id: string; state: string; draft: string | null }>(
    `SELECT r.run_id, r.state, j.result->>'draftExternalId' AS draft
       FROM run r LEFT JOIN step_journal j ON j.run_id = r.run_id AND j.step_id = 'park'
      WHERE r.ticket_id = $1 AND r.turn_number IS NOT NULL
      ORDER BY r.created_at`,
    [ticketId],
  );
  return rows.map((row) => ({ runId: row.run_id, state: row.state, draft: row.draft }));
}

/** The conversation and turn a run serves. */
async function turnOf(runId: string): Promise<{ conversationId: string; turnNumber: number }> {
  const { rows } = await pool.query<{ conversation_id: string; turn_number: number }>(
    'SELECT conversation_id, turn_number FROM run WHERE run_id = $1',
    [runId],
  );
  return { conversationId: rows[0]!.conversation_id, turnNumber: rows[0]!.turn_number };
}

async function sentReplies(ticketId: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM outbox o JOIN run r ON r.run_id = o.run_id
      WHERE r.ticket_id = $1 AND o.status = 'sent' AND o.payload ? 'draftExternalId'`,
    [ticketId],
  );
  return rows[0]!.n;
}

/**
 * Resolves once some backend of this database waits on a lock, or when
 * `ms` passes. The caller then reads whether the work it started finished.
 */
async function lockWaitSeen(ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const { rows } = await pool.query<{ waiting: number }>(
      `SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if (rows[0]!.waiting > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The log lines that parse as objects, as the log reader reads them. */
function faultLines(lines: readonly string[]): Record<string, unknown>[] {
  return lines.flatMap((line) => {
    try {
      const parsed: unknown = JSON.parse(line);
      return typeof parsed === 'object' && parsed !== null ? [parsed as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  });
}

/** One delivery of a message, walked by the consumer's poll. */
async function deliver(d: CoordinatorDeps, ticketId: string, options = OPTIONS): Promise<void> {
  const message = { ticketId, messageId: `m-${ticketId}@example.test`, ticketText: TICKET_TEXT };
  const queued = await enqueueTicket(pool, message, PARTITIONS);
  expect(queued.enqueued).toBe(true);
  await processQueuedTickets(d, options);
}

async function supersedeRecord(runId: string): Promise<Record<string, unknown> | null> {
  const { rows } = await pool.query<{ result: Record<string, unknown> }>(
    "SELECT result FROM step_journal WHERE run_id = $1 AND step_id = 'supersede'",
    [runId],
  );
  return rows[0]?.result ?? null;
}

/** A message queued once, as the consumer would hand it to a walk. */
async function queuedInput(ticketId: string): Promise<Omit<CoordinateInput, 'epoch'>> {
  const message = { ticketId, messageId: `m-${ticketId}@example.test`, ticketText: TICKET_TEXT };
  const queued = await enqueueTicket(pool, message, PARTITIONS);
  expect(queued.enqueued).toBe(true);
  return {
    ticketId,
    ticketText: TICKET_TEXT,
    conversationId: queued.conversationId,
    turnNumber: queued.turnNumber,
    attempt: 1,
    partition: queued.partition,
    ...OPTIONS.action,
  };
}

/**
 * Two walks that overlap: the older walks `input` at epoch 10, and the newer
 * walks `newerInput` straight after the older records its park, before the
 * older's state move. A rebalance, or a retry after a crash, has this shape.
 */
async function walkOverlapping(
  d: CoordinatorDeps,
  input: Omit<CoordinateInput, 'epoch'>,
  newerInput: CoordinateInput,
  newerDeps: CoordinatorDeps = d,
): Promise<{ older: CoordinateOutcome; newer: CoordinateOutcome }> {
  let newer: CoordinateOutcome | null = null;
  const query = pool.query.bind(pool) as (text: unknown, values?: unknown[]) => Promise<unknown>;
  const overlapping = {
    connect: pool.connect.bind(pool),
    query: async (text: unknown, values?: unknown[]) => {
      const result = await query(text, values);
      const params = values ?? [];
      if (newer === null && typeof text === 'string' && text.includes('step_journal')
        && params.includes('park') && params.includes('done')
        && JSON.stringify(params).includes('draftExternalId')) {
        newer = await coordinateTicket(newerDeps, newerInput);
      }
      return result;
    },
  } as unknown as Pool;
  const older = await coordinateTicket({ ...d, pool: overlapping }, { ...input, epoch: 10n });
  if (newer === null) throw new Error('the newer walk never ran: the older walk parked no draft');
  return { older, newer };
}

function ticketOf(ticketId: string): ConstructorParameters<typeof HelpdeskAdapter>[0] {
  return [{ ticketId, subject: 'Cannot sign in', queue: 'accounts', status: 'open', customerAddress: null }];
}

describe('a message redelivered on a turn that is answered, or about to be', () => {
  beforeEach(async () => {
    await truncateLedger(pool);
    await indexDocument(
      pool,
      {
        docId: 'd1',
        kind: 'document',
        title: 'Reset your password',
        body: 'Open the account settings page and choose security. Choose reset password.',
        owner: 'synthetic-owner',
        reviewBy: '2999-01-01',
      },
      VEC,
    );
  });

  // The source redelivers after its ack, once the reply went out. The queue
  // row is gone, so it queues again, on the same turn (DEC-38).
  it('parks no second draft on an answered turn, and says which run answered it', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const egress = new NewDraftEachPark(ticketOf(ticketId));
    const d = deps(egress, NO_IDEMPOTENCY);
    await deliver(d, ticketId);
    const [first] = await runsOfTurn(ticketId);
    expect(await approveRun(pool, first!.runId)).toMatchObject({ outcome: 'approved' });
    await relayPending(pool, egress);
    expect(await sentReplies(ticketId)).toBe(1);

    await deliver(d, ticketId);
    const runs = await runsOfTurn(ticketId);
    expect(runs).toHaveLength(2);
    const second = runs[1]!;
    // No draft reached the helpdesk, where an agent could have sent it.
    expect(second.draft).toBeNull();
    expect(egress.parks).toBe(1);
    // The run stops where a person reading it sees why.
    expect(second.state).toBe('superseded');
    expect(await supersedeRecord(second.runId))
      .toEqual({ reason: 'turn_answered', answeredBy: first!.runId });
    expect(await approveRun(pool, second.runId)).toMatchObject({ outcome: 'not_awaiting_approval' });
    await relayPending(pool, egress);
    expect(await sentReplies(ticketId)).toBe(1);
  });

  // The source redelivers while the first run still waits for a person. It
  // is the same request, so the waiting run owns it: the redelivery parks
  // nothing, and no second draft reaches a helpdesk that takes no key.
  it("parks no twin while the turn's reply waits, and names the run that owns it", async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const egress = new NewDraftEachPark(ticketOf(ticketId));
    const d = deps(egress, NO_IDEMPOTENCY);
    await deliver(d, ticketId);
    await deliver(d, ticketId);
    const [waiting, redelivered] = await runsOfTurn(ticketId);
    expect(waiting?.state).toBe('awaiting_approval');
    expect(redelivered?.state).toBe('superseded');
    expect(redelivered?.draft).toBeNull();
    expect(egress.parks).toBe(1);
    expect(await supersedeRecord(redelivered!.runId))
      .toEqual({ reason: 'reply_waiting', waitingRun: waiting!.runId });

    expect(await approveRun(pool, waiting!.runId)).toMatchObject({ outcome: 'approved' });
    await relayPending(pool, egress);
    expect(await sentReplies(ticketId)).toBe(1);
  });

  // Two walks that both read the turn before either park lands still park
  // twice, and on a helpdesk that takes no key they hold two drafts. The
  // approval and the scan hold that turn to one reply, whichever is approved
  // first.
  it('holds two raced parks to one reply, whichever is approved first', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const egress = new NewDraftEachPark(ticketOf(ticketId));
    const d = deps(egress, NO_IDEMPOTENCY);
    await deliver(d, ticketId);
    const [older] = await runsOfTurn(ticketId);
    await asIfRacing(pool, older!.runId, () => deliver(d, ticketId));
    const [, newer] = await runsOfTurn(ticketId);
    expect(older?.state).toBe('awaiting_approval');
    expect(newer?.state).toBe('awaiting_approval');
    expect(newer!.draft).not.toBe(older!.draft);

    expect(await approveRun(pool, newer!.runId)).toMatchObject({ outcome: 'approved' });
    expect(await approveRun(pool, older!.runId)).toEqual({ outcome: 'turn_closed' });
    await relayPending(pool, egress);
    expect(await sentReplies(ticketId)).toBe(1);

    // The consumer's next scan takes the refused run out of the queue, and
    // records why.
    await startSentBackAttempts(d, OPTIONS);
    const after = (await runsOfTurn(ticketId)).find((run) => run.runId === older!.runId)!;
    expect(after.state).toBe('superseded');
    expect(await supersedeRecord(older!.runId))
      .toEqual({ reason: 'turn_answered', answeredBy: newer!.runId });
  });

  // The scan picks its runs before it commits. An undo inside a held send
  // can remove the record that answered the turn in between, and the turn is
  // open again: the scan leaves the run waiting and writes no reason that
  // its own commit would disprove.
  it('leaves a run waiting when the answer is undone under the scan', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const egress = new NewDraftEachPark(ticketOf(ticketId));
    const d = deps(egress, NO_IDEMPOTENCY);
    await deliver(d, ticketId);
    const [older] = await runsOfTurn(ticketId);
    await asIfRacing(pool, older!.runId, () => deliver(d, ticketId));
    const [, newer] = await runsOfTurn(ticketId);
    expect(await approveRun(pool, newer!.runId)).toMatchObject({ outcome: 'approved' });

    // The scan's own read, then the record gone before its commit.
    const query = pool.query.bind(pool) as (text: unknown, values?: unknown[]) => Promise<unknown>;
    let removed = false;
    const racing = {
      query: async (text: unknown, values?: unknown[]) => {
        const result = await query(text, values);
        if (!removed && typeof text === 'string' && text.includes('AS rejected')) {
          removed = true;
          await pool.query('DELETE FROM outbox WHERE run_id = $1', [newer!.runId]);
        }
        return result;
      },
      connect: pool.connect.bind(pool),
    } as unknown as Pool;
    await startSentBackAttempts({ ...d, pool: racing }, OPTIONS);
    expect(removed).toBe(true);
    const after = (await runsOfTurn(ticketId)).find((run) => run.runId === older!.runId)!;
    expect(after.state).toBe('awaiting_approval');
    expect(await supersedeRecord(older!.runId)).toBeNull();
  });

  // An approval that lands while the park reads the turn. One statement reads
  // both answers, so it sees the approval either not yet committed, with the
  // run still waiting, or committed, with its record: either way the park
  // stops. Two reads could pass between the two and park a second draft.
  it("parks no twin when the waiting run is approved during the park's read", async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const egress = new NewDraftEachPark(ticketOf(ticketId));
    const d = deps(egress, NO_IDEMPOTENCY);
    await deliver(d, ticketId);
    const [waiting] = await runsOfTurn(ticketId);
    const query = pool.query.bind(pool) as (text: unknown, values?: unknown[]) => Promise<unknown>;
    let approved = false;
    const approving = {
      query: async (text: unknown, values?: unknown[]) => {
        const result = await query(text, values);
        // Straight after the park's read of the turn's reply record.
        if (!approved && typeof text === 'string' && text.includes("o.payload ? 'draftExternalId'")
          && text.includes('FROM outbox o')) {
          approved = true;
          expect(await approveRun(pool, waiting!.runId)).toMatchObject({ outcome: 'approved' });
        }
        return result;
      },
      connect: pool.connect.bind(pool),
    } as unknown as Pool;
    await deliver({ ...d, pool: approving }, ticketId);
    expect(approved).toBe(true);
    expect(egress.parks).toBe(1);
    const redelivered = (await runsOfTurn(ticketId))[1]!;
    expect(redelivered.state).toBe('superseded');
    expect(redelivered.draft).toBeNull();
    // The read saw the run still waiting, before the approval committed.
    expect(await supersedeRecord(redelivered.runId))
      .toEqual({ reason: 'reply_waiting', waitingRun: waiting!.runId });
  });

  // The other order: the approval commits just before the park's read, so the
  // one read sees its record instead.
  it("parks no twin when the waiting run is approved just before the park's read", async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const egress = new NewDraftEachPark(ticketOf(ticketId));
    const d = deps(egress, NO_IDEMPOTENCY);
    await deliver(d, ticketId);
    const [waiting] = await runsOfTurn(ticketId);
    const query = pool.query.bind(pool) as (text: unknown, values?: unknown[]) => Promise<unknown>;
    let approved = false;
    const approving = {
      query: async (text: unknown, values?: unknown[]) => {
        if (!approved && typeof text === 'string' && text.includes("o.payload ? 'draftExternalId'")
          && text.includes('FROM outbox o')) {
          approved = true;
          expect(await approveRun(pool, waiting!.runId)).toMatchObject({ outcome: 'approved' });
        }
        return query(text, values);
      },
      connect: pool.connect.bind(pool),
    } as unknown as Pool;
    await deliver({ ...d, pool: approving }, ticketId);
    expect(approved).toBe(true);
    expect(egress.parks).toBe(1);
    const redelivered = (await runsOfTurn(ticketId))[1]!;
    expect(redelivered.state).toBe('superseded');
    expect(await supersedeRecord(redelivered.runId))
      .toEqual({ reason: 'turn_answered', answeredBy: waiting!.runId });
  });

  // A snoozed run still owns the turn's reply: it comes back when its period
  // ends, and the redelivery must not park a second draft meanwhile.
  it("parks no twin while the turn's reply is snoozed", async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const egress = new NewDraftEachPark(ticketOf(ticketId));
    const d = deps(egress, NO_IDEMPOTENCY);
    await deliver(d, ticketId);
    const [waiting] = await runsOfTurn(ticketId);
    expect(await snoozeRun(pool, waiting!.runId, { periodMs: 3_600_000 }))
      .toMatchObject({ outcome: 'snoozed' });
    await deliver(d, ticketId);
    const redelivered = (await runsOfTurn(ticketId))[1]!;
    expect(egress.parks).toBe(1);
    expect(redelivered.state).toBe('superseded');
    expect(await supersedeRecord(redelivered.runId))
      .toEqual({ reason: 'reply_waiting', waitingRun: waiting!.runId });
  });

  // The undo takes the turn's lock before it removes a record, the lock the
  // scan reads the turn's reply under. A writer that holds it past the
  // undo's wait makes the undo refuse as busy, and remove nothing.
  it("holds an undo behind the turn's lock", async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const egress = new NewDraftEachPark(ticketOf(ticketId));
    // A held send exists where the ledger holds the reply (DEC-44, DEC-51).
    const d = deps(egress, { ...NO_IDEMPOTENCY, supportsLedgerReply: true });
    await deliver(d, ticketId);
    const [run] = await runsOfTurn(ticketId);
    expect(await approveRun(pool, run!.runId, { ledgerReply: true, sendHoldMs: 600_000 }))
      .toMatchObject({ outcome: 'approved' });
    const turn = await pool.query<{ conversation_id: string; turn_number: number }>(
      'SELECT conversation_id, turn_number FROM run WHERE run_id = $1',
      [run!.runId],
    );
    // The turn names another approval's text, so the undo's own update of it
    // matches no row and takes no lock: the lock this case holds is the only
    // thing in the undo's way.
    await pool.query(
      "UPDATE turn SET approved_reply_text = 'another approval' WHERE conversation_id = $1 AND turn_number = $2",
      [turn.rows[0]!.conversation_id, turn.rows[0]!.turn_number],
    );
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        'SELECT 1 FROM turn WHERE conversation_id = $1 AND turn_number = $2 FOR UPDATE',
        [turn.rows[0]!.conversation_id, turn.rows[0]!.turn_number],
      );
      // The undo refuses while the lock is held, rather than removing a
      // record a scan may be reading, and removes nothing.
      expect(await undoApproval(pool, run!.runId, { reviewer: 'anna@example.test' }))
        .toEqual({ outcome: 'busy' });
      const outbox = await pool.query('SELECT 1 FROM outbox WHERE run_id = $1', [run!.runId]);
      expect(outbox.rowCount).toBe(1);
      await holder.query('COMMIT');
      // Released, the same undo goes through.
      expect(await undoApproval(pool, run!.runId, { reviewer: 'anna@example.test' }))
        .toMatchObject({ outcome: 'undone' });
    } finally {
      holder.release();
    }
  });

  // The undo's wait is one budget across its locks. A writer that holds one
  // lock for most of it leaves only the rest for the next, so the answer
  // comes inside the budget and not after two full waits. One case per later
  // lock, because each is narrowed on its own before it is taken.
  for (const { first, next } of [
    { first: 'record', next: 'run' },
    { first: 'run', next: 'turn' },
  ] as const) {
    it(`answers busy within one budget when the ${first} is held and then the ${next}`, async () => {
      const ticketId = `T-${randomUUID().slice(0, 8)}`;
      const egress = new NewDraftEachPark(ticketOf(ticketId));
      const d = deps(egress, { ...NO_IDEMPOTENCY, supportsLedgerReply: true });
      await deliver(d, ticketId);
      const [run] = await runsOfTurn(ticketId);
      expect(await approveRun(pool, run!.runId, { ledgerReply: true, sendHoldMs: 600_000 }))
        .toMatchObject({ outcome: 'approved' });
      const turn = await turnOf(run!.runId);
      await pool.query(
        "UPDATE turn SET approved_reply_text = 'another approval' WHERE conversation_id = $1 AND turn_number = $2",
        [turn.conversationId, turn.turnNumber],
      );
      const lock = {
        record: ["SELECT 1 FROM outbox WHERE run_id = $1 AND step_id = 'approve' FOR UPDATE", [run!.runId]],
        run: ['SELECT 1 FROM run WHERE run_id = $1 FOR UPDATE', [run!.runId]],
        turn: [
          'SELECT 1 FROM turn WHERE conversation_id = $1 AND turn_number = $2 FOR UPDATE',
          [turn.conversationId, turn.turnNumber],
        ],
      } as const;
      const firstHolder = await pool.connect();
      const nextHolder = await pool.connect();
      try {
        await firstHolder.query('BEGIN');
        await firstHolder.query(lock[first][0], [...lock[first][1]]);
        await nextHolder.query('BEGIN');
        await nextHolder.query(lock[next][0], [...lock[next][1]]);
        const started = Date.now();
        const undo = undoApproval(pool, run!.runId, { reviewer: 'anna@example.test' });
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        await firstHolder.query('COMMIT');
        expect(await undo).toEqual({ outcome: 'busy' });
        // The undo waited its budget: about three seconds on the first lock,
        // then what was left on the next. Five seconds in all, not three and
        // then five more. A budget restarted on the next lock takes at least
        // eight, so the ceiling sits between the two with room for a loaded
        // host.
        const took = Date.now() - started;
        expect(took).toBeGreaterThanOrEqual(4_500);
        expect(took).toBeLessThan(7_500);
      } finally {
        await firstHolder.query('ROLLBACK').catch(() => undefined);
        await nextHolder.query('ROLLBACK');
        firstHolder.release();
        nextHolder.release();
      }
      const record = await pool.query('SELECT 1 FROM outbox WHERE run_id = $1', [run!.runId]);
      expect(record.rowCount).toBe(1);
    });
  }

  // The order the lock exists for: an undo that starts inside the scan's own
  // transaction, after the scan read the turn's reply. The undo waits for the
  // turn's lock until the scan commits, so the reason the scan records is
  // true when it commits. The undo then goes through.
  it('holds an undo that lands inside the scan until the scan commits', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const egress = new NewDraftEachPark(ticketOf(ticketId));
    const d = deps(egress, { ...NO_IDEMPOTENCY, supportsLedgerReply: true });
    await deliver(d, ticketId);
    const [older] = await runsOfTurn(ticketId);
    await asIfRacing(pool, older!.runId, () => deliver(d, ticketId));
    const [, newer] = await runsOfTurn(ticketId);
    expect(await approveRun(pool, newer!.runId, { ledgerReply: true, sendHoldMs: 600_000 }))
      .toMatchObject({ outcome: 'approved' });
    // The turn names another approval's text, so the undo's own update of it
    // matches no row and takes no lock: the turn's lock is the only thing
    // that can hold the undo back.
    const turn = await turnOf(newer!.runId);
    await pool.query(
      "UPDATE turn SET approved_reply_text = 'another approval' WHERE conversation_id = $1 AND turn_number = $2",
      [turn.conversationId, turn.turnNumber],
    );

    let undo: Promise<unknown> | null = null;
    let settledInScan: boolean | null = null;
    let recordsInScan: number | null = null;
    const connect = pool.connect.bind(pool);
    const inScan = {
      query: pool.query.bind(pool),
      connect: async () => {
        const client = await connect();
        if (undo !== null) return client;
        const original = client.query;
        const query = original.bind(client) as (...args: unknown[]) => Promise<unknown>;
        (client as unknown as { query: unknown }).query = async (...args: unknown[]) => {
          const result = await query(...args);
          const text = args[0];
          // Straight after the scan's read of the turn's reply, in its commit.
          if (undo === null && typeof text === 'string' && text.includes("o.payload ? 'draftExternalId'")
            && text.includes('ORDER BY r.created_at, r.run_id')) {
            client.query = original;
            let settled = false;
            undo = undoApproval(pool, newer!.runId, { reviewer: 'anna@example.test' })
              .finally(() => { settled = true; });
            // Until the undo waits on a lock, or long enough for one that does
            // not wait to commit. Postgres reports the wait, so a slow host
            // moves the moment and not the result.
            await lockWaitSeen(3_000);
            settledInScan = settled;
            const record = await pool.query('SELECT 1 FROM outbox WHERE run_id = $1', [newer!.runId]);
            recordsInScan = record.rowCount;
          }
          return result;
        };
        return client;
      },
    } as unknown as Pool;
    await startSentBackAttempts({ ...d, pool: inScan }, OPTIONS);
    // While the scan held the turn, the undo waited and removed nothing.
    expect(settledInScan).toBe(false);
    expect(recordsInScan).toBe(1);
    expect(await supersedeRecord(older!.runId))
      .toEqual({ reason: 'turn_answered', answeredBy: newer!.runId });
    // Once the scan committed, the undo went through.
    expect(await undo).toEqual({ outcome: 'undone' });
    const record = await pool.query('SELECT 1 FROM outbox WHERE run_id = $1', [newer!.runId]);
    expect(record.rowCount).toBe(0);
  });

  // DEC-51: an undo that reports success guarantees nothing was sent, so it
  // reads the clock after the last lock it waits on. An undo that began
  // inside the hold, and waited on the turn's lock past its end, refuses.
  it("refuses an undo whose hold ended while it waited on the turn's lock", async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const egress = new NewDraftEachPark(ticketOf(ticketId));
    const d = deps(egress, { ...NO_IDEMPOTENCY, supportsLedgerReply: true });
    await deliver(d, ticketId);
    const [run] = await runsOfTurn(ticketId);
    expect(await approveRun(pool, run!.runId, { ledgerReply: true, sendHoldMs: 2_000 }))
      .toMatchObject({ outcome: 'approved' });
    const turn = await turnOf(run!.runId);
    await pool.query(
      "UPDATE turn SET approved_reply_text = 'another approval' WHERE conversation_id = $1 AND turn_number = $2",
      [turn.conversationId, turn.turnNumber],
    );
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        'SELECT 1 FROM turn WHERE conversation_id = $1 AND turn_number = $2 FOR UPDATE',
        [turn.conversationId, turn.turnNumber],
      );
      // Started inside the hold, with the time it has left read from the
      // record, so a slow machine moves the release rather than the result.
      const held = await pool.query<{ remaining: number }>(
        `SELECT EXTRACT(EPOCH FROM (not_before - clock_timestamp())) * 1000 AS remaining
           FROM outbox WHERE run_id = $1 AND step_id = 'approve'`,
        [run!.runId],
      );
      const remaining = Number(held.rows[0]!.remaining);
      expect(remaining).toBeGreaterThan(0);
      const undo = undoApproval(pool, run!.runId, { reviewer: 'anna@example.test' });
      // Released after the hold ended, and inside the undo's own wait.
      await new Promise((resolve) => setTimeout(resolve, remaining + 300));
      await holder.query('COMMIT');
      expect(await undo).toEqual({ outcome: 'window_passed' });
    } finally {
      holder.release();
    }
    const record = await pool.query('SELECT 1 FROM outbox WHERE run_id = $1', [run!.runId]);
    expect(record.rowCount).toBe(1);
  });

  // Two walks of one message on one ticket can overlap: a rebalance hands the
  // partition to a new owner mid-walk, or a retry follows a crash between
  // the park and its state move. The older walk parked a draft and then
  // stopped stale (DEC-28), so it never waited. The newer walk is the same
  // request (DEC-24), so the turn goes back to the run that parked the draft,
  // the newer run stops, and no second draft is made.
  it('hands the turn back to the older walk that parked its draft, and parks no second', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const egress = new NewDraftEachPark(ticketOf(ticketId));
    const d = deps(egress, NO_IDEMPOTENCY);
    const input = await queuedInput(ticketId);
    const { older, newer } = await walkOverlapping(d, input, { ...input, epoch: 11n });

    // The older walk's own state move is still refused: the fence moved.
    expect(older).toMatchObject({ outcome: 'stale_epoch' });
    expect(newer).toMatchObject({ outcome: 'superseded' });
    const [first, second] = await runsOfTurn(ticketId);
    expect(first!.state).toBe('awaiting_approval');
    expect(second!.state).toBe('superseded');
    expect(await supersedeRecord(second!.runId))
      .toEqual({ reason: 'draft_parked', parkedBy: first!.runId });
    // One draft in the helpdesk, and the run that waits named it.
    expect(egress.parks).toBe(1);
    expect(first!.draft).not.toBeNull();
    expect(second!.draft).toBeNull();
    // Its totals count its park, as a run that parked unhindered does.
    const plain = `T-${randomUUID().slice(0, 8)}`;
    await deliver(deps(new NewDraftEachPark(ticketOf(plain)), NO_IDEMPOTENCY), plain);
    const steps = await pool.query<{ ticket_id: string; steps_used: number }>(
      'SELECT ticket_id, steps_used FROM run WHERE ticket_id = ANY($1) AND state = $2',
      [[ticketId, plain], 'awaiting_approval'],
    );
    const used = new Map(steps.rows.map((row) => [row.ticket_id, row.steps_used]));
    expect(used.get(ticketId)).toBe(used.get(plain));

    expect(await approveRun(pool, first!.runId)).toMatchObject({ outcome: 'approved' });
    await relayPending(pool, egress);
    expect(await sentReplies(ticketId)).toBe(1);
  });

  // The newer walk composed and gated its own reply before it found the older
  // park, and a retry can compose different text. The queue shows the run
  // that waits, and that run's own gate judged the draft it parked.
  it('queues the run whose own gate judged the draft, not the newer walk', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const egress = new NewDraftEachPark(ticketOf(ticketId));
    const d = deps(egress, NO_IDEMPOTENCY);
    const recomposed: FakeStep[] = [
      ...Array.from({ length: 9 }, () => ({ text: 'password_reset' })),
      { vectors: [VEC] },
      { text: '[doc:d1] Choose security in the account settings, then reset password.' },
      { text: 'VERDICT: UNSUPPORTED' },
    ];
    const newerDeps = { ...d, provider: new FakeProvider(recomposed) };
    const input = await queuedInput(ticketId);
    await walkOverlapping(d, input, { ...input, epoch: 11n }, newerDeps);

    const [first, second] = await runsOfTurn(ticketId);
    const queued = (await listRuns(pool, ['awaiting_approval']))
      .filter((item) => item.runId === first!.runId || item.runId === second!.runId);
    expect(queued.map((item) => item.runId)).toEqual([first!.runId]);
    // The older walk's gate read its draft as supported, the newer walk's not.
    expect(queued[0]!.coverage).toBe(1);
    const newerGate = await pool.query<{ groundedness: number }>(
      "SELECT (result->>'groundedness')::float AS groundedness FROM step_journal WHERE run_id = $1 AND step_id = 'gate'",
      [second!.runId],
    );
    expect(newerGate.rows[0]!.groundedness).toBe(0);
  });

  // A walk of the fenced owner that has not reached the helpdesk yet stops at
  // its marker. A newer walk ran its whole walk in the gap after the older
  // walk's checks, so the older walk never calls the helpdesk.
  it('stops a stale walk at its park marker, before it reaches the helpdesk', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const egress = new NewDraftEachPark(ticketOf(ticketId));
    const d = deps(egress, NO_IDEMPOTENCY);
    const input = await queuedInput(ticketId);
    let newer: CoordinateOutcome | null = null;
    const query = pool.query.bind(pool) as (text: unknown, values?: unknown[]) => Promise<unknown>;
    const inGap = {
      connect: pool.connect.bind(pool),
      // Straight after the older walk opens its park row, past every check.
      query: async (text: unknown, values?: unknown[]) => {
        const result = await query(text, values);
        const params = values ?? [];
        if (newer === null && typeof text === 'string' && text.includes('step_journal')
          && params.includes('park') && params.includes('started')) {
          newer = await coordinateTicket(d, { ...input, epoch: 11n });
        }
        return result;
      },
    } as unknown as Pool;
    const older = await coordinateTicket({ ...d, pool: inGap }, { ...input, epoch: 10n });

    expect(newer).toMatchObject({ outcome: 'awaiting_approval' });
    expect(older).toMatchObject({ outcome: 'stale_epoch' });
    expect(egress.parks).toBe(1);
    const [first] = await runsOfTurn(ticketId);
    // The older run holds no draft and no crash marker, and its park row
    // says the step ended.
    expect(first!.draft).toBeNull();
    const marker = await pool.query<{ status: string; result: Record<string, unknown> }>(
      "SELECT status, result FROM step_journal WHERE run_id = $1 AND step_id = 'park'",
      [first!.runId],
    );
    expect(marker.rows).toEqual([{
      status: 'superseded',
      result: { actionClass: CUSTOMER_REPLY_ACTION_CLASS, delivery: 'at_least_once' },
    }]);
  });

  // A walk at the same epoch is not fenced by the newer one, so its own state
  // move may still land. The turn is handed back only to a walk the fence
  // has stopped.
  it('hands back no draft a walk at the same epoch parked, since it may still move', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const egress = new NewDraftEachPark(ticketOf(ticketId));
    const d = deps(egress, NO_IDEMPOTENCY);
    const input = await queuedInput(ticketId);
    const { older, newer } = await walkOverlapping(d, input, { ...input, epoch: 10n });

    expect(older).toMatchObject({ outcome: 'awaiting_approval' });
    expect(newer).toMatchObject({ outcome: 'awaiting_approval' });
    const [, second] = await runsOfTurn(ticketId);
    expect(await supersedeRecord(second!.runId)).toBeNull();
  });

  // The read that finds a stranded run takes no lock. A run that left flight
  // before the write locked it is never moved back to wait: a finished run
  // stays finished.
  it('moves no run back to wait when it left flight after the read found it', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const egress = new NewDraftEachPark(ticketOf(ticketId));
    const d = deps(egress, NO_IDEMPOTENCY);
    const input = await queuedInput(ticketId);
    // Strand the older walk: a walk of another attempt takes the fence and
    // leaves the older walk's park where it stopped.
    await walkOverlapping(d, input, { ...input, attempt: 2, epoch: 11n });
    const [first] = await runsOfTurn(ticketId);
    expect(first!.state).toBe('gated');

    const query = pool.query.bind(pool) as (text: unknown, values?: unknown[]) => Promise<unknown>;
    let moved = false;
    const afterRead = {
      connect: pool.connect.bind(pool),
      query: async (text: unknown, values?: unknown[]) => {
        const result = await query(text, values);
        if (!moved && typeof text === 'string' && text.includes("jsonb_typeof(park.result->'draftExternalId')")) {
          moved = true;
          await query("UPDATE run SET state = 'resolved' WHERE run_id = $1", [first!.runId]);
        }
        return result;
      },
    } as unknown as Pool;
    const third = await coordinateTicket({ ...d, pool: afterRead }, { ...input, epoch: 12n });

    expect(moved).toBe(true);
    expect(third).toMatchObject({ outcome: 'awaiting_approval' });
    const state = await pool.query<{ state: string }>('SELECT state FROM run WHERE run_id = $1', [first!.runId]);
    expect(state.rows[0]!.state).toBe('resolved');
  });

  // A walk with no turn names no request. Matching it on the ticket alone
  // would read another message as the same one, and answer neither.
  it('hands back no draft to a walk that has no turn', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const egress = new NewDraftEachPark(ticketOf(ticketId));
    const d = deps(egress, NO_IDEMPOTENCY);
    const { conversationId: _c, turnNumber: _t, ...turnless } = await queuedInput(ticketId);
    // A walk of one message with no turn, stranded by a walk of another
    // attempt, as a row queued before turns existed would be.
    await walkOverlapping(d, turnless, { ...turnless, attempt: 2, epoch: 11n });
    const stranded = await pool.query<{ run_id: string; state: string }>(
      'SELECT run_id, state FROM run WHERE ticket_id = $1 AND attempt = 1',
      [ticketId],
    );
    expect(stranded.rows).toHaveLength(1);
    expect(stranded.rows[0]!.state).toBe('gated');

    // Another message of the ticket, also with no turn.
    const other = await coordinateTicket(d, { ...turnless, epoch: 12n });

    expect(other).toMatchObject({ outcome: 'awaiting_approval' });
    const state = await pool.query<{ state: string }>(
      'SELECT state FROM run WHERE run_id = $1',
      [stranded.rows[0]!.run_id],
    );
    expect(state.rows[0]!.state).toBe('gated');
  });

  // A later attempt is a new request (DEC-49): the draft of the attempt
  // before it is the one a reviewer rejected, so it is never handed back.
  it('hands back no draft an overlapping walk parked for another attempt', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const egress = new NewDraftEachPark(ticketOf(ticketId));
    const d = deps(egress, NO_IDEMPOTENCY);
    const input = await queuedInput(ticketId);
    const { newer } = await walkOverlapping(d, input, { ...input, attempt: 2, epoch: 11n });

    expect(newer).toMatchObject({ outcome: 'awaiting_approval' });
    const [, second] = await runsOfTurn(ticketId);
    expect(egress.parks).toBe(2);
    expect(await supersedeRecord(second!.runId)).toBeNull();
  });

  // The fence is keyed on the ticket, so a walk of another ticket does not
  // stop the older walk, and a draft parked on one helpdesk ticket is not
  // another ticket's draft.
  it('hands back no draft an overlapping walk parked on another ticket', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const otherTicket = `T-${randomUUID().slice(0, 8)}`;
    const egress = new NewDraftEachPark([...ticketOf(ticketId)!, ...ticketOf(otherTicket)!]);
    const d = deps(egress, NO_IDEMPOTENCY);
    const input = await queuedInput(ticketId);
    const { older, newer } = await walkOverlapping(
      d,
      input,
      { ...input, ticketId: otherTicket, epoch: 11n },
    );

    expect(older).toMatchObject({ outcome: 'awaiting_approval' });
    expect(newer).toMatchObject({ outcome: 'awaiting_approval' });
    expect(egress.parks).toBe(2);
    const [other] = await runsOfTurn(otherTicket);
    expect(await supersedeRecord(other!.runId)).toBeNull();
  });

  // The key an approval derives names the park's action class (DEC-24), so a
  // park of another class is another request, whatever it parked.
  it('hands back no draft an overlapping walk parked for another action class', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const egress = new NewDraftEachPark(ticketOf(ticketId));
    const d = deps(egress, NO_IDEMPOTENCY);
    const input = await queuedInput(ticketId);
    const { newer } = await walkOverlapping(
      d,
      input,
      { ...input, actionClass: 'follow_up_reply', epoch: 11n },
    );

    expect(newer).toMatchObject({ outcome: 'awaiting_approval' });
    const [, second] = await runsOfTurn(ticketId);
    expect(egress.parks).toBe(2);
    expect(await supersedeRecord(second!.runId)).toBeNull();
  });

  // A profile change between the two parks: the second parks in the ledger
  // alone, as a gated write shows no customer. It is still the turn's reply,
  // so it stops as the first case's does rather than writing a record the
  // relay would refuse as malformed.
  // A reply of the reply's class parked in the ledger alone is still the
  // turn's reply. Once another run answers the turn, the approval refuses it,
  // the queue says why, and the consumer's scan ends it naming that run.
  it('holds a reply parked in the ledger alone to the turn another run answered', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const egress = new NewDraftEachPark(ticketOf(ticketId));
    const d = deps(egress, NO_IDEMPOTENCY);
    await deliver(d, ticketId);
    const [first] = await runsOfTurn(ticketId);
    const ledgerOnly = { ...OPTIONS, action: { ...OPTIONS.action, isCustomerVisible: false } };
    await asIfRacing(pool, first!.runId, () => deliver(d, ticketId, ledgerOnly));
    const second = (await runsOfTurn(ticketId))[1]!;
    expect(second.state).toBe('awaiting_approval');
    expect(second.draft).toBeNull();

    expect(await approveRun(pool, first!.runId)).toMatchObject({ outcome: 'approved' });
    await relayPending(pool, egress);
    expect(await sentReplies(ticketId)).toBe(1);

    expect((await readRun(pool, second.runId))?.turnClosed).toBe(true);
    expect(await approveRun(pool, second.runId)).toMatchObject({ outcome: 'turn_closed' });

    await startSentBackAttempts(d, OPTIONS);
    const ended = (await runsOfTurn(ticketId))[1]!;
    expect(ended.state).toBe('superseded');
    expect(await supersedeRecord(ended.runId))
      .toEqual({ reason: 'turn_answered', answeredBy: first!.runId });
  });

  // The scan ends each run in its own commit. One run whose end faults is
  // logged and left for the next pass, and the runs after it still end.
  it("ends the other answered runs when one run's end faults", async () => {
    const twins: { ticketId: string; first: string; second: string }[] = [];
    for (let i = 0; i < 2; i += 1) {
      const ticketId = `T-${randomUUID().slice(0, 8)}`;
      const egress = new NewDraftEachPark(ticketOf(ticketId));
      const d = deps(egress, NO_IDEMPOTENCY);
      await deliver(d, ticketId);
      const [first] = await runsOfTurn(ticketId);
      await asIfRacing(pool, first!.runId, () => deliver(d, ticketId));
      const [, second] = await runsOfTurn(ticketId);
      twins.push({ ticketId, first: first!.runId, second: second!.runId });
    }
    // Answered after both exist: a delivery runs the scan, and would end the
    // first twin before this case's own scan.
    for (const twin of twins) {
      expect(await approveRun(pool, twin.first)).toMatchObject({ outcome: 'approved' });
    }
    const seconds = twins.map((twin) => twin.second);
    // Whichever run the scan reaches first faults, so the other one is the
    // run after it, whatever order the scan reads them in.
    let faulted: string | null = null;

    const connect = pool.connect.bind(pool);
    const faulty = {
      query: pool.query.bind(pool),
      connect: async () => {
        const client = await connect();
        const original = client.query;
        const query = original.bind(client) as (...args: unknown[]) => Promise<unknown>;
        (client as unknown as { query: unknown }).query = async (...args: unknown[]) => {
          const values = (args[1] ?? []) as unknown[];
          const run = seconds.find((id) => values.includes(id));
          if (faulted === null && run !== undefined && typeof args[0] === 'string'
            && args[0].includes('step_journal') && values.includes('supersede')) {
            faulted = run;
            throw new Error('the journal refused the row');
          }
          return query(...args);
        };
        const release = client.release.bind(client);
        (client as unknown as { release: unknown }).release = (...args: unknown[]) => {
          client.query = original;
          return (release as (...a: unknown[]) => void)(...args);
        };
        return client;
      },
    } as unknown as Pool;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let lines: string[] = [];
    try {
      const d = deps(new NewDraftEachPark(ticketOf(twins[0]!.ticketId)), NO_IDEMPOTENCY);
      await startSentBackAttempts({ ...d, pool: faulty }, OPTIONS);
      lines = logged.mock.calls.map((call) => String(call[0]));
    } finally {
      logged.mockRestore();
    }
    expect(faulted).not.toBeNull();
    const faulting = twins.find((twin) => twin.second === faulted)!;
    const ending = twins.find((twin) => twin.second !== faulted)!;
    expect(faultLines(lines)).toContainEqual(expect.objectContaining({
      event: 'waiting_run_end_failed', runId: faulting.second, reason: 'turn_answered',
    }));
    const states = await pool.query<{ run_id: string; state: string }>(
      'SELECT run_id, state FROM run WHERE run_id = ANY($1)',
      [[faulting.second, ending.second]],
    );
    const stateOf = new Map(states.rows.map((row) => [row.run_id, row.state]));
    expect(stateOf.get(faulting.second)).toBe('awaiting_approval');
    expect(stateOf.get(ending.second)).toBe('superseded');
    expect(await supersedeRecord(ending.second))
      .toEqual({ reason: 'turn_answered', answeredBy: ending.first });
  });

  // The same loop ends the waiting runs of a sent-back attempt. Its fault is
  // logged with that reason, and the other rejected runs still end.
  it("ends the other rejected runs when one run's end faults", async () => {
    const waiting: { ticketId: string; runId: string }[] = [];
    for (let i = 0; i < 2; i += 1) {
      const ticketId = `T-${randomUUID().slice(0, 8)}`;
      await deliver(deps(new NewDraftEachPark(ticketOf(ticketId)), NO_IDEMPOTENCY), ticketId);
      const [run] = await runsOfTurn(ticketId);
      waiting.push({ ticketId, runId: run!.runId });
    }
    // A reviewer sent each turn back: the turn moved to its next attempt.
    for (const { runId } of waiting) {
      const turn = await turnOf(runId);
      await pool.query(
        'UPDATE turn SET attempt = 2 WHERE conversation_id = $1 AND turn_number = $2',
        [turn.conversationId, turn.turnNumber],
      );
    }
    const ids = waiting.map((run) => run.runId);
    let faulted: string | null = null;
    const connect = pool.connect.bind(pool);
    const faulty = {
      query: pool.query.bind(pool),
      connect: async () => {
        const client = await connect();
        const original = client.query;
        const query = original.bind(client) as (...args: unknown[]) => Promise<unknown>;
        (client as unknown as { query: unknown }).query = async (...args: unknown[]) => {
          const values = (args[1] ?? []) as unknown[];
          const run = ids.find((id) => values.includes(id));
          if (faulted === null && run !== undefined && typeof args[0] === 'string'
            && args[0].includes('step_journal') && values.includes('supersede')) {
            faulted = run;
            throw new Error('the journal refused the row');
          }
          return query(...args);
        };
        const release = client.release.bind(client);
        (client as unknown as { release: unknown }).release = (...args: unknown[]) => {
          client.query = original;
          return (release as (...a: unknown[]) => void)(...args);
        };
        return client;
      },
    } as unknown as Pool;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let lines: string[] = [];
    try {
      // The scan alone, as the consumer runs it before each poll.
      const d = deps(new NewDraftEachPark(ticketOf(waiting[0]!.ticketId)), NO_IDEMPOTENCY);
      await startSentBackAttempts({ ...d, pool: faulty }, OPTIONS);
      lines = logged.mock.calls.map((call) => String(call[0]));
    } finally {
      logged.mockRestore();
    }
    expect(faulted).not.toBeNull();
    const other = ids.find((id) => id !== faulted)!;
    expect(faultLines(lines)).toContainEqual(expect.objectContaining({
      event: 'waiting_run_end_failed', runId: faulted, reason: 'attempt_rejected',
    }));
    const states = await pool.query<{ run_id: string; state: string }>(
      'SELECT run_id, state FROM run WHERE run_id = ANY($1)',
      [ids],
    );
    const stateOf = new Map(states.rows.map((row) => [row.run_id, row.state]));
    expect(stateOf.get(faulted!)).toBe('awaiting_approval');
    expect(stateOf.get(other)).toBe('superseded');
    expect(await supersedeRecord(other)).toEqual({ reason: 'attempt_rejected' });
  });

  it('stops a reply parked in the ledger alone on an answered turn', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const egress = new NewDraftEachPark(ticketOf(ticketId));
    const d = deps(egress, NO_IDEMPOTENCY);
    await deliver(d, ticketId);
    const [first] = await runsOfTurn(ticketId);
    expect(await approveRun(pool, first!.runId)).toMatchObject({ outcome: 'approved' });
    await relayPending(pool, egress);

    await deliver(d, ticketId, { ...OPTIONS, action: { ...OPTIONS.action, isCustomerVisible: false } });
    const second = (await runsOfTurn(ticketId))[1]!;
    expect(second.state).toBe('superseded');
    expect(await supersedeRecord(second.runId))
      .toEqual({ reason: 'turn_answered', answeredBy: first!.runId });
    expect(await sentReplies(ticketId)).toBe(1);
  });

  // What answers a turn: a record of a customer reply, nothing else. A
  // compensation's record on the turn is not a reply (DEC-34), and a record
  // the relay refused as malformed never reaches the customer.
  it('parks again when the turn holds a compensation record, not a reply', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const egress = new NewDraftEachPark(ticketOf(ticketId));
    const d = deps(egress, NO_IDEMPOTENCY);
    await deliver(d, ticketId);
    const [first] = await runsOfTurn(ticketId);
    expect(await approveRun(pool, first!.runId)).toMatchObject({ outcome: 'approved' });
    // The first run's record, reshaped into a compensation's: no draft named.
    await pool.query(
      `UPDATE outbox SET action_class = 'compensate', payload = payload - 'draftExternalId'
        WHERE run_id = $1`,
      [first!.runId],
    );
    await deliver(d, ticketId);
    const second = (await runsOfTurn(ticketId))[1]!;
    expect(second.state).toBe('awaiting_approval');
    expect(egress.parks).toBe(2);
    expect(await supersedeRecord(second.runId)).toBeNull();
  });

  // DEC-34 from the other side: a compensation that waits on the turn is not
  // the turn's reply, so a reply walk of the same turn and attempt parks.
  it('parks a reply beside a compensation that waits on the same turn', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const egress = new NewDraftEachPark(ticketOf(ticketId));
    const d = deps(egress, NO_IDEMPOTENCY);
    await deliver(d, ticketId, {
      ...OPTIONS,
      action: {
        ...OPTIONS.action,
        actionClass: COMPENSATION_ACTION_CLASS,
        actionPayload: { amount: 500 },
        delivery: 'at_most_once',
        isCustomerVisible: false,
      },
    });
    const [compensation] = await runsOfTurn(ticketId);
    expect(compensation!.state).toBe('awaiting_approval');
    expect(egress.parks).toBe(0);

    await deliver(d, ticketId);
    const reply = (await runsOfTurn(ticketId))[1]!;
    expect(reply.state).toBe('awaiting_approval');
    expect(egress.parks).toBe(1);
    expect(await supersedeRecord(reply.runId)).toBeNull();
  });

  it.each(['malformed', 'not_sent'])("parks again when the turn's only record was refused as %s", async (status) => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const egress = new NewDraftEachPark(ticketOf(ticketId));
    const d = deps(egress, NO_IDEMPOTENCY);
    await deliver(d, ticketId);
    const [first] = await runsOfTurn(ticketId);
    expect(await approveRun(pool, first!.runId)).toMatchObject({ outcome: 'approved' });
    await pool.query('UPDATE outbox SET status = $2 WHERE run_id = $1', [first!.runId, status]);
    await deliver(d, ticketId);
    const second = (await runsOfTurn(ticketId))[1]!;
    expect(second.state).toBe('awaiting_approval');
    // A draft of its own: the first run finished, so its park is not one a
    // stopped walk left behind for this one to take.
    expect(egress.parks).toBe(2);
    expect(await supersedeRecord(second.runId)).toBeNull();
  });

  // Two reply records on one turn, as raced twins can leave: the record names
  // the earliest, the reply the customer received first.
  it('names the earliest run when two replies hold the turn', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const egress = new NewDraftEachPark(ticketOf(ticketId));
    const d = deps(egress, NO_IDEMPOTENCY);
    await deliver(d, ticketId);
    const [older] = await runsOfTurn(ticketId);
    await asIfRacing(pool, older!.runId, () => deliver(d, ticketId));
    const [, newer] = await runsOfTurn(ticketId);
    expect(await approveRun(pool, older!.runId)).toMatchObject({ outcome: 'approved' });
    // A second record on the turn, the newer run's, under a key of its own.
    await pool.query(
      `INSERT INTO outbox (run_id, step_id, idem_key, epoch, action_class, delivery, payload, status)
       SELECT $2, step_id, idem_key || ':twin', epoch, action_class, delivery, payload, status
         FROM outbox WHERE run_id = $1`,
      [older!.runId, newer!.runId],
    );
    await deliver(d, ticketId);
    const third = (await runsOfTurn(ticketId))[2]!;
    expect(await supersedeRecord(third.runId))
      .toEqual({ reason: 'turn_answered', answeredBy: older!.runId });
  });

  // The IMAP/SMTP shape, with the adapter's own declaration. A raced twin
  // there finds the same draft again (the real adapter does so in
  // src/e2e/v1-email-flow.db.test.ts), and a second approval still sends
  // nothing.
  it('sends once on the IMAP/SMTP shape, which finds the same draft again', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const egress = new HelpdeskAdapter(ticketOf(ticketId));
    const d = deps(egress, IMAP_SMTP_CAPABILITIES);
    await deliver(d, ticketId);
    const [older] = await runsOfTurn(ticketId);
    await asIfRacing(pool, older!.runId, () => deliver(d, ticketId));
    const [, newer] = await runsOfTurn(ticketId);
    expect(newer!.draft).toBe(older!.draft);
    expect(await approveRun(pool, older!.runId)).toMatchObject({ outcome: 'approved' });
    expect(await approveRun(pool, newer!.runId)).toEqual({ outcome: 'turn_closed' });
    await relayPending(pool, egress);
    expect(await sentReplies(ticketId)).toBe(1);
  });
});
