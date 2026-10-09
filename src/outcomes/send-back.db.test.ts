/**
 * DEC-49: a case a reviewer sends back for a new attempt.
 *
 * The cases are about what a send-back must guarantee. It starts a new run on
 * the same turn, with the reviewer's note as an instruction, and that run
 * never gets back the draft the reviewer rejected — so every key of the turn
 * carries the attempt. It sends nothing itself: no outbox record commits with
 * it, and the reply the rejected run composed stays where it was.
 *
 * It also has conditions, and each is a case: a helpdesk copy a person could
 * send, a turn with a record that may have reached the customer, a reply that
 * moved under the reviewer, and a note that says nothing or says too much.
 * Each refusal sends the reviewer somewhere different, so each is its own
 * answer.
 *
 * The scan is the other half of one behavior, so it is tested here: the
 * console writes the request, and the consumer that owns the conversation
 * starts the attempt.
 */
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { HelpdeskAdapter } from '../adapters/helpdesk.js';
import { COMPENSATION_ACTION_CLASS, CUSTOMER_REPLY_ACTION_CLASS } from '../adapters/types.js';
import { approveRun } from '../approval/approve.js';
import { saveReply } from '../approval/save-reply.js';
import { undoApproval } from '../approval/undo.js';
import { replyDigest } from '../approval/shown.js';
import { startSentBackAttempts } from '../coordinator/consumer.js';
import type { ConsumerOptions } from '../coordinator/consumer.js';
import { coordinateTicket } from '../coordinator/coordinator.js';
import type { CoordinatorDeps } from '../coordinator/coordinator.js';
import { enqueueTicket } from '../coordinator/intake.js';
import { processQueuedTickets } from '../coordinator/consumer.js';
import { dbUrl } from '../db/config.js';
import { takeHold } from '../holds/hold.js';
import { FakeProvider } from '../models/fake.js';
import type { FakeStep } from '../models/fake.js';
import type { AdapterCapabilities } from '../policy/policy.js';
import { indexDocument } from '../retriever/retriever.js';
import { asIfRacing } from '../test-support/race-twin.js';
import { lockWaitSeen } from '../test-support/lock-wait.js';
import { truncateLedger } from '../test-support/schema.js';

import { MAX_SEND_BACK_NOTE_CHARS, recordSendBackIn, sendBackRun } from './send-back.js';

const pool = new Pool({ connectionString: dbUrl(), max: 8 });

afterAll(async () => {
  await pool.end();
});

await pool.query('SELECT 1');

const PINS = { promptVer: 'send-back-prompt', modelVer: 'send-back-model' };
const TICKET_TEXT = 'I cannot sign in to my account. How do I reset my password?';
const DISCLOSURE = 'This reply was drafted by an automated assistant and approved by a person.';
const VEC = Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0));
const NOTE = 'The customer asked twice. Say what happens to the second request.';

/**
 * The adapter an approval may send the ledger's reply through (DEC-44).
 *
 * It is a switch, because it is what the send-back's first refusal reads: a
 * helpdesk that can send the copy it parks leaves a copy a person could send,
 * and one that cannot leaves the reply with the ledger.
 */
function capabilities(ledgerReply: boolean): AdapterCapabilities {
  return {
    supportsIdempotencyKey: true,
    supportsReadBack: true,
    supportsDraftState: true,
    supportsStructuredFields: true,
    supportsThreading: true,
    supportsLedgerReply: ledgerReply,
  };
}

function happyScript(reply = '[doc:d1] Open the account settings page and choose reset password.'): FakeStep[] {
  return [
    ...Array.from({ length: 9 }, () => ({ text: 'password_reset' })),
    { vectors: [VEC] },
    { text: reply },
    { text: 'VERDICT: SUPPORTED' },
  ];
}

function makeDeps(egress: HelpdeskAdapter, options: {
  ledgerReply?: boolean;
  script?: FakeStep[];
} = {}): CoordinatorDeps {
  return {
    pool,
    provider: new FakeProvider(options.script ?? happyScript()),
    taxonomy: { intents: [{ id: 'password_reset', label: 'Password reset', risk_tier: 'low' }] },
    capabilities: capabilities(options.ledgerReply ?? true),
    egress,
    pins: PINS,
    limits: { maxCostMicros: 100_000_000, maxSteps: 50, deadlineAt: new Date(Date.now() + 60_000) },
    partitionCount: PARTITIONS,
  };
}

function helpdeskWith(ticketId: string): HelpdeskAdapter {
  return new HelpdeskAdapter([
    {
      ticketId,
      subject: 'Cannot sign in',
      queue: 'accounts',
      status: 'open',
      customerAddress: null,
    },
  ]);
}

const PARTITIONS = 8;

function actionSpec(): ConsumerOptions['action'] {
  return {
    actionClass: CUSTOMER_REPLY_ACTION_CLASS,
    actionPayload: { summary: 'password reset answer' },
    delivery: 'at_least_once',
    isCustomerVisible: true,
    disclosure: DISCLOSURE,
  };
}

function optionsFor(partitions: number[] = [0, 1, 2, 3, 4, 5, 6, 7]): ConsumerOptions {
  return { partitions, intervalMs: 1000, action: actionSpec() };
}

interface Parked {
  readonly runId: string;
  readonly conversationId: string;
  readonly turnNumber: number;
  /** The body the park journalled, which is the reply the ledger holds. */
  readonly parkedBody: string;
  readonly draftExternalId: string | null;
}

/**
 * One customer reply, parked on turn one of a fresh conversation.
 *
 * `customerVisible: false` parks in the ledger alone (DEC-34): no adapter
 * call, no draft handle, and a journaled action payload instead. It stands in
 * for a gated write with nothing to park.
 */
async function parkOnTurnOne(ticketId: string, parkOptions: {
  customerVisible?: boolean;
  ledgerReply?: boolean;
  /** Reuse one helpdesk across attempts, as a deployment does. */
  egress?: HelpdeskAdapter;
} = {}): Promise<Parked> {
  const customerVisible = parkOptions.customerVisible ?? true;
  const enqueued = await enqueueTicket(
    pool,
    { ticketId, messageId: `m-1-${ticketId}@example.test`, ticketText: TICKET_TEXT },
    PARTITIONS,
  );
  const egress = parkOptions.egress ?? helpdeskWith(ticketId);
  const result = await coordinateTicket(
    makeDeps(egress, { ledgerReply: parkOptions.ledgerReply ?? true }),
    {
      ticketId,
      ticketText: TICKET_TEXT,
      epoch: 1n,
      conversationId: enqueued.conversationId,
      turnNumber: enqueued.turnNumber,
      // A ledger-only park (DEC-34) is what a compensation is: gated on
      // irreversibility, with no customer draft to park.
      actionClass: customerVisible ? CUSTOMER_REPLY_ACTION_CLASS : COMPENSATION_ACTION_CLASS,
      actionPayload: customerVisible
        ? { summary: 'password reset answer' }
        : { reason: 'refund sent to the wrong account' },
      delivery: customerVisible ? 'at_least_once' : 'at_most_once',
      isCustomerVisible: customerVisible,
      disclosure: DISCLOSURE,
    },
  );
  if (result.outcome !== 'awaiting_approval') {
    throw new Error(`expected awaiting_approval, got ${result.outcome}`);
  }
  const parked = await pool.query<{ body: string; draft: string | null }>(
    "SELECT result->>'body' AS body, result->>'draftExternalId' AS draft"
      + " FROM step_journal WHERE run_id = $1 AND step_id = 'park'",
    [result.runId],
  );
  const row = parked.rows[0];
  // Read as values and refused when absent, so no case in this file can
  // compare two nulls and pass. A park row with no body or no reply is a
  // fixture that never parked, and every assertion below would be vacuous.
  // The key itself is not read: the 'parking' row is the crash marker and the
  // step's `done` write replaces its result, so the key is gone by the time
  // the park returns. What it buys is the draft the adapter hands back.
  if (row === undefined || typeof row.body !== 'string') {
    throw new Error(`the park for ${result.runId} journalled no body`);
  }
  return {
    runId: result.runId,
    conversationId: enqueued.conversationId,
    turnNumber: enqueued.turnNumber,
    parkedBody: row.body,
    draftExternalId: row.draft,
  };
}

interface RunFacts {
  state: string;
  attempt: number;
  finished_at: Date | null;
  sent_back_at: Date | null;
  send_back_note: string | null;
}

async function runRow(runId: string): Promise<RunFacts> {
  const rows = await pool.query(
    'SELECT state, attempt, finished_at, sent_back_at, send_back_note FROM run WHERE run_id = $1',
    [runId],
  );
  return rows.rows[0] as RunFacts;
}

/** Every run of one turn, oldest attempt first. */
async function runsOfTurn(conversationId: string, turnNumber: number): Promise<RunFacts[]> {
  const rows = await pool.query(
    `SELECT state, attempt, finished_at, sent_back_at, send_back_note FROM run
      WHERE conversation_id = $1 AND turn_number = $2 ORDER BY attempt, created_at, run_id`,
    [conversationId, turnNumber],
  );
  return rows.rows as RunFacts[];
}

async function journalRow(
  runId: string,
  stepId: string,
): Promise<{ status: string; result: Record<string, unknown> | null } | undefined> {
  const rows = await pool.query(
    'SELECT status, result FROM step_journal WHERE run_id = $1 AND step_id = $2',
    [runId, stepId],
  );
  return rows.rows[0] as never;
}

async function holdEvents(runId: string): Promise<string[]> {
  const rows = await pool.query<{ kind: string }>(
    'SELECT kind FROM case_hold_event WHERE run_id = $1 ORDER BY event_id',
    [runId],
  );
  return rows.rows.map((row) => row.kind);
}

/**
 * An outbox record on the turn, written directly.
 *
 * No console path produces this today: a waiting run has no outbox record,
 * and the only writer of one is an approval, which ends the wait. It is the
 * state DEC-49's second condition is about, and the state any future path
 * that returns a run to approval would produce, so it is constructed here
 * rather than left untested.
 */
async function recordOnTurn(
  runId: string,
  status: string,
): Promise<void> {
  // The shape a customer reply's record has: its payload names the draft it
  // sends, which is how a reader tells a reply's record from an action's.
  await pool.query(
    `INSERT INTO outbox (run_id, step_id, idem_key, epoch, action_class, delivery,
                         payload, status)
     VALUES ($1, 'approve', $2, 1, $3, 'at_least_once', $4::jsonb, $5)`,
    [runId, `turn-record-${randomUUID()}`, CUSTOMER_REPLY_ACTION_CLASS,
      JSON.stringify({ draftExternalId: `hd-outside-${randomUUID().slice(0, 8)}` }), status],
  );
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

describe('DEC-49: a case a reviewer sends back', () => {
  it('ends the run, records the note and the reviewer, and releases the hold', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const { runId } = await parkOnTurnOne(ticketId);
    await takeHold(pool, { runId, reviewer: 'anna@example.test', lapseMs: 60_000 });

    const outcome = await sendBackRun(pool, runId, {
      note: `  ${NOTE}  `,
      sentBackBy: 'anna@example.test',
      sentBackBySource: 'roster',
      shown: replyDigest((await journalRow(runId, 'park'))!.result!['body'] as string),
      ledgerReply: true,
    });

    expect(outcome).toEqual({ outcome: 'sent_back' });
    const run = await runRow(runId);
    // Terminal, so the same commit stamps the finish (V2 open item 7).
    expect(run.state).toBe('superseded');
    expect(run.finished_at).toBeInstanceOf(Date);
    // The marker the consumer's scan reads, and the instruction it hands the
    // next attempt. The note is trimmed.
    expect(run.sent_back_at).toBeInstanceOf(Date);
    expect(run.send_back_note).toBe(NOTE);
    expect(run.attempt).toBe(1);

    const journal = await journalRow(runId, 'send_back');
    expect(journal?.status).toBe('done');
    expect(journal?.result).toMatchObject({
      note: NOTE,
      reviewer: 'anna@example.test',
      reviewerSource: 'roster',
      attempt: 1,
    });

    // The case leaves the queue for good, so the reservation ends here — with
    // a kind of its own, because the history is what a team reads.
    expect(await holdEvents(runId)).toContain('send_back');
  });

  it('sends nothing: the turn gains no outbox record', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const { runId, conversationId, turnNumber } = await parkOnTurnOne(ticketId);

    await sendBackRun(pool, runId, { note: NOTE, ledgerReply: true });

    const rows = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM outbox o
         JOIN run r ON r.run_id = o.run_id
        WHERE r.conversation_id = $1 AND r.turn_number = $2`,
      [conversationId, turnNumber],
    );
    expect(Number(rows.rows[0]!.n)).toBe(0);
    // And the reply the rejected run composed is still on its journal, not
    // deleted: nothing here can prove the customer never saw it.
    const park = await journalRow(runId, 'park');
    expect(park?.result?.['body']).toBeTypeOf('string');
  });

  it('refuses where the helpdesk holds a copy a person could send', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    // The DEC-40 draft path: the adapter's helpdesk sends the copy it parks,
    // so the reviewer may have sent it by hand already and nothing sees that.
    const { runId } = await parkOnTurnOne(ticketId, { ledgerReply: false });

    const outcome = await sendBackRun(pool, runId, {
      note: NOTE,
      shown: replyDigest((await journalRow(runId, 'park'))!.result!['body'] as string),
      ledgerReply: false,
    });

    expect(outcome).toEqual({ outcome: 'copy_could_send' });
    const run = await runRow(runId);
    expect(run.state).toBe('awaiting_approval');
    expect(run.sent_back_at).toBeNull();
  });

  it('starts a new attempt where the park created no draft at all', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    // A ledger-only park (DEC-34): nothing is in the helpdesk to send, so the
    // adapter's inability to send a ledger reply is not what decides here.
    const { runId } = await parkOnTurnOne(ticketId, {
      customerVisible: false,
      ledgerReply: false,
    });

    const outcome = await sendBackRun(pool, runId, { note: NOTE, ledgerReply: false });

    expect(outcome).toEqual({ outcome: 'sent_back' });
    expect((await runRow(runId)).state).toBe('superseded');
  });

  // A record in any of these is a reply that reached the customer, may have,
  // or will: `pending` is an approved reply the relay has not drained yet.
  for (const status of ['pending', 'sent', 'fenced', 'delivery_unknown'] as const) {
    it(`refuses when the turn has a ${status} record, which closes it`, async () => {
      const ticketId = `T-${randomUUID().slice(0, 8)}`;
      const { runId } = await parkOnTurnOne(ticketId);
      await recordOnTurn(runId, status);

      const outcome = await sendBackRun(pool, runId, { note: NOTE, ledgerReply: true });

      expect(outcome).toEqual({ outcome: 'turn_may_have_reached' });
      expect((await runRow(runId)).state).toBe('awaiting_approval');
    });
  }

  // Neither record was ever sent, and the relay will never send it.
  for (const status of ['malformed', 'not_sent'] as const) {
    it(`leaves the turn open for a ${status} record, which the relay will never send`, async () => {
      const ticketId = `T-${randomUUID().slice(0, 8)}`;
      const { runId } = await parkOnTurnOne(ticketId);
      await recordOnTurn(runId, status);

      const outcome = await sendBackRun(pool, runId, { note: NOTE, ledgerReply: true });

      expect(outcome).toEqual({ outcome: 'sent_back' });
    });
  }

  it('refuses a run that is not waiting for a person, and names its state', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const { runId } = await parkOnTurnOne(ticketId);
    await sendBackRun(pool, runId, { note: NOTE, ledgerReply: true });

    const again = await sendBackRun(pool, runId, { note: NOTE, ledgerReply: true });

    expect(again).toEqual({ outcome: 'not_awaiting_approval', state: 'superseded' });
  });

  it('refuses a note that says nothing, one over the bound, and one the ledger cannot store', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const { runId } = await parkOnTurnOne(ticketId);
    const shown = replyDigest((await journalRow(runId, 'park'))!.result!['body'] as string);
    const options = { shown, ledgerReply: true };

    expect(await sendBackRun(pool, runId, { ...options, note: '   ' }))
      .toEqual({ outcome: 'note_empty' });
    expect(await sendBackRun(pool, runId, { ...options, note: 'x'.repeat(MAX_SEND_BACK_NOTE_CHARS + 1) }))
      .toEqual({ outcome: 'note_too_long' });
    // A NUL is not text the ledger can store, and a write that raised on it
    // would answer a fault about a case nobody touched.
    expect(await sendBackRun(pool, runId, { ...options, note: `a${String.fromCharCode(0)}b` }))
      .toEqual({ outcome: 'unprintable_note' });
    // And the bound is a bound, not an off-by-one: exactly the maximum passes.
    const atTheBound = await sendBackRun(pool, runId, {
      ...options,
      note: 'x'.repeat(MAX_SEND_BACK_NOTE_CHARS),
    });
    expect(atTheBound).toEqual({ outcome: 'sent_back' });
  });

  it('refuses a reply that changed under the reviewer (DEC-46)', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const { runId } = await parkOnTurnOne(ticketId);

    const outcome = await sendBackRun(pool, runId, {
      note: NOTE,
      shown: replyDigest('a reply this reviewer never read'),
      ledgerReply: true,
    });

    expect(outcome).toEqual({ outcome: 'shown_changed' });
    expect((await runRow(runId)).state).toBe('awaiting_approval');
  });
});

describe('DEC-49: the next attempt', () => {
  it('starts a new run on the same turn, and it never gets the rejected draft back', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    // One helpdesk across both attempts, as a deployment has: it is the
    // thing that finds a draft by key, so reusing an adapter is what makes
    // `never gets the draft back` a claim about the system rather than about
    // two counters that both start at one.
    const egress = helpdeskWith(ticketId);
    const first = await parkOnTurnOne(ticketId, { egress });
    await sendBackRun(pool, first.runId, { note: NOTE, ledgerReply: true });

    // The note reaches the second walk's composer, and the script answers it
    // with other words: a re-attempt that composed the rejected text byte for
    // byte would leave every claim below true of the wrong thing.
    const provider = new FakeProvider(happyScript(
      '[doc:d1] Reset it from the account settings page, and the second request is answered once.',
    ));
    const deps = { ...makeDeps(egress, { ledgerReply: true }), provider };
    const started = await startSentBackAttempts(deps, optionsFor());

    expect(started).toHaveLength(1);
    const runs = await runsOfTurn(first.conversationId, first.turnNumber);
    expect(runs.map((run) => run.attempt)).toEqual([1, 2]);
    // The rejected attempt ended, and the new one waits for a person.
    expect(runs[1]!.state).toBe('awaiting_approval');

    // The draft is the observable claim, and the adapter is the reader that
    // decides it: it finds a draft by key, so an attempt whose key matched
    // the rejected one would be handed that draft back. One adapter served
    // both parks, and it minted a second draft for the second attempt.
    //
    // The park key itself is not asserted here because it cannot be read: the
    // 'parking' row is the crash marker, and the step's `done` write replaces
    // its result, so the key is gone by the time the park returns. What the
    // key buys is exactly the draft below.
    const secondPark = await journalRow(started[0]!, 'park');
    const secondDraft = secondPark?.result?.['draftExternalId'];
    expect(typeof secondDraft).toBe('string');
    expect(secondDraft).not.toBe(first.draftExternalId);
    // And it is a new reply, not the rejected text under a new handle. Both
    // read as strings first: an assertion that two absent values differ
    // passes on a fixture that parked nothing, which is the defect this pair
    // of cases exists to catch rather than to repeat.
    const secondBody = secondPark?.result?.['body'];
    expect(typeof secondBody).toBe('string');
    expect(secondBody).not.toBe(first.parkedBody);

    // An instruction, never a retrieved document: the note reaches the
    // composer's prompt and no other model call of the walk (DEC-37).
    const calls = provider.calls;
    expect(calls.filter((call) => call.kind === 'chat').length).toBeGreaterThan(9);
    const carrying = calls.filter((call) =>
      (call.messages ?? []).some((message) => message.content.includes(NOTE)));
    expect(carrying).toHaveLength(1);
  });

  // The order production runs in: the poll comes first in every scan, so a
  // message redelivered after a reviewer sent the case back is polled while
  // the request is still standing. A case that started the attempt first and
  // enqueued second tested the harmless order, and passed while this failed.
  it('holds a message redelivered before the scan, and never hands it the rejected draft', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const egress = helpdeskWith(ticketId);
    const first = await parkOnTurnOne(ticketId, { egress });
    await sendBackRun(pool, first.runId, { note: NOTE, ledgerReply: true });

    await enqueueTicket(
      pool,
      { ticketId, messageId: `m-1-${ticketId}@example.test`, ticketText: TICKET_TEXT },
      PARTITIONS,
    );
    const provider = new FakeProvider([...happyScript(), ...happyScript()]);
    const deps: CoordinatorDeps = { ...makeDeps(egress, { ledgerReply: true }), provider };

    // One pass, in production order: the poll, then the scan.
    await processQueuedTickets(deps, optionsFor());
    await startSentBackAttempts(deps, optionsFor());
    // And the next pass, which serves the held message.
    await processQueuedTickets(deps, optionsFor());

    const drafts = await pool.query<{ attempt: number; draft: string | null; state: string }>(
      `SELECT r.attempt, j.result->>'draftExternalId' AS draft, r.state
         FROM run r JOIN step_journal j ON j.run_id = r.run_id AND j.step_id = 'park'
        WHERE r.conversation_id = $1 AND r.turn_number = $2
        ORDER BY r.attempt, r.created_at`,
      [first.conversationId, first.turnNumber],
    );
    // No run of this turn waits for a person holding the draft the reviewer
    // rejected. The only one that holds it is the run that was sent back.
    const waiting = drafts.rows.filter((row) => row.state === 'awaiting_approval');
    expect(waiting.length).toBeGreaterThan(0);
    for (const row of waiting) {
      expect(row.draft, `attempt ${String(row.attempt)}`).not.toBe(first.draftExternalId);
      expect(row.attempt).toBe(2);
    }
    // And the note reached a composer: the attempt the request started read it.
    const carrying = provider.calls.filter((call) =>
      (call.messages ?? []).some((message) => message.content.includes(NOTE)));
    expect(carrying).toHaveLength(1);
  });

  it('keeps a redelivered message in the attempt the turn is on', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const egress = helpdeskWith(ticketId);
    const first = await parkOnTurnOne(ticketId, { egress });
    await sendBackRun(pool, first.runId, { note: NOTE, ledgerReply: true });

    // Two walks' worth of script: the re-attempt, and the redelivery's retry.
    const provider = new FakeProvider([...happyScript(), ...happyScript()]);
    const deps: CoordinatorDeps = { ...makeDeps(egress, { ledgerReply: true }), provider };
    expect(await startSentBackAttempts(deps, optionsFor())).toHaveLength(1);

    // The source redelivers the same message after its ack. The queue row is
    // gone and the turn is reused, so this is a retry of the turn — of the
    // attempt the turn is ON, and not a new first attempt.
    const again = await enqueueTicket(
      pool,
      { ticketId, messageId: `m-1-${ticketId}@example.test`, ticketText: TICKET_TEXT },
      PARTITIONS,
    );
    expect(again.turnNumber).toBe(first.turnNumber);

    await processQueuedTickets(deps, optionsFor());

    const runs = await runsOfTurn(first.conversationId, first.turnNumber);
    // Two runs, both attempt 2: the re-attempt and the redelivery's retry of
    // it. A run that took attempt 1 would derive the rejected attempt's keys.
    expect(runs.map((run) => run.attempt)).toEqual([1, 2, 2]);
    const [, reattempt, retry] = await pool.query<{ run_id: string; state: string }>(
      `SELECT run_id, state FROM run WHERE conversation_id = $1 AND turn_number = $2
        ORDER BY attempt, created_at, run_id`,
      [first.conversationId, first.turnNumber],
    ).then((result) => result.rows);
    // The retry is the same request as the re-attempt, which waits with its
    // reply, so it parks nothing and names the run that owns it. Read at
    // attempt 1, it would have found no reply waiting and parked again.
    expect(reattempt!.state).toBe('awaiting_approval');
    expect(retry!.state).toBe('superseded');
    expect(await journalRow(retry!.run_id, 'park')).toBeUndefined();
    expect(await journalRow(retry!.run_id, 'supersede')).toMatchObject({
      status: 'done', result: { reason: 'reply_waiting', waitingRun: reattempt!.run_id },
    });
  });

  // The record is shared with the attempt a published document asks for,
  // which passes the document's author. It records a name the way every other
  // writer does (DEC-42, DEC-45), whichever caller hands it one.
  it('records the reviewer as every other writer does: trimmed, with a source that fits it', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const parked = await parkOnTurnOne(ticketId);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await recordSendBackIn(client, {
        runId: parked.runId,
        conversationId: parked.conversationId,
        turnNumber: parked.turnNumber,
        runAttempt: 1,
        note: NOTE,
        reviewer: '  anna@example.test  ',
        reviewerSource: 'none',
      });
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const journal = await journalRow(parked.runId, 'send_back');
    expect(journal?.result?.['reviewer']).toBe('anna@example.test');
    expect(journal?.result?.['reviewerSource']).toBe('header');
  });

  it('names nobody for a cleared reply saved before the saver was recorded', async () => {
    // Migration 039 added the saver. A reply saved before it has none, and the
    // record says nothing rather than naming somebody.
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const parked = await parkOnTurnOne(ticketId);
    await pool.query(
      'UPDATE turn SET saved_reply_text = $3 WHERE conversation_id = $1 AND turn_number = $2',
      [parked.conversationId, parked.turnNumber, 'A reply saved before the saver was kept.'],
    );

    await sendBackRun(pool, parked.runId, { note: NOTE, ledgerReply: true });

    const journal = await journalRow(parked.runId, 'send_back');
    expect(journal?.result?.['clearedReply']).toBe('A reply saved before the saver was kept.');
    expect(journal?.result).not.toHaveProperty('clearedBy');
    expect(journal?.result).not.toHaveProperty('clearedBySource');
  });

  it('clears the reply a person saved, so the new attempt is what sends', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const egress = helpdeskWith(ticketId);
    const first = await parkOnTurnOne(ticketId, { egress });
    // The reviewer repairs the draft by hand, then decides the answer was
    // wrong and sends the case back. The approval prefers the saved text over
    // the park body (DEC-48), so a save left standing would make the new
    // attempt inert: its reviewer would approve the new reply and the
    // customer would receive the older, saved one.
    await saveReply(pool, first.runId, 'A reply I wrote by hand.', {
      savedBy: 'anna@example.test',
      savedBySource: 'roster',
    });

    await sendBackRun(pool, first.runId, { note: NOTE, ledgerReply: true });

    const held = await pool.query<{
      text: string | null;
      provenance: unknown;
      by: string | null;
      source: string | null;
    }>(
      'SELECT saved_reply_text AS text, saved_reply_provenance AS provenance,'
        + ' saved_reply_by AS by, saved_reply_by_source AS source FROM turn'
        + ' WHERE conversation_id = $1 AND turn_number = $2',
      [first.conversationId, first.turnNumber],
    );
    expect(held.rows[0]?.text).toBeNull();
    expect(held.rows[0]?.provenance).toBeNull();
    // The saver goes with the words: a name beside no text names nothing.
    expect(held.rows[0]?.by).toBeNull();
    expect(held.rows[0]?.source).toBeNull();
    // And what was cleared is recorded: a person's words do not disappear
    // without a record of them.
    const journal = await journalRow(first.runId, 'send_back');
    expect(journal?.result?.['clearedReply']).toBe('A reply I wrote by hand.');
    // And whose words they were, which the turn no longer says (DEC-45).
    expect(journal?.result?.['clearedBy']).toBe('anna@example.test');
    expect(journal?.result?.['clearedBySource']).toBe('roster');

    // The new attempt composes other words, and those are what an approval
    // sends.
    const provider = new FakeProvider(happyScript('[doc:d1] Resetting is in the account settings.'));
    const deps: CoordinatorDeps = { ...makeDeps(egress, { ledgerReply: true }), provider };
    const started = await startSentBackAttempts(deps, optionsFor());
    expect(started).toHaveLength(1);

    expect(await approveRun(pool, started[0]!, {
      ledgerReply: true, approvedBy: 'anna@example.test', approvedBySource: 'roster',
    })).toMatchObject({ outcome: 'approved' });
    const outbox = await pool.query<{ body: string }>(
      "SELECT reply->>'bodyText' AS body FROM outbox WHERE run_id = $1",
      [started[0]!],
    );
    expect(outbox.rows[0]?.body).toBe('Resetting is in the account settings.');
    expect(outbox.rows[0]?.body).not.toBe('A reply I wrote by hand.');
  });

  it('serves the request once: a second scan starts no further attempt', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const first = await parkOnTurnOne(ticketId);
    await sendBackRun(pool, first.runId, { note: NOTE, ledgerReply: true });

    const deps = makeDeps(helpdeskWith(ticketId), { ledgerReply: true });
    expect(await startSentBackAttempts(deps, optionsFor())).toHaveLength(1);
    expect(await startSentBackAttempts(deps, optionsFor())).toHaveLength(0);

    const runs = await runsOfTurn(first.conversationId, first.turnNumber);
    expect(runs).toHaveLength(2);
  });

  it('serves a request only to the consumer that owns the conversation', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const first = await parkOnTurnOne(ticketId);
    await sendBackRun(pool, first.runId, { note: NOTE, ledgerReply: true });

    const run = await runRow(first.runId);
    expect(run.state).toBe('superseded');
    const partition = await pool.query<{ partition: number }>(
      'SELECT partition FROM run WHERE run_id = $1',
      [first.runId],
    );
    const owned = partition.rows[0]!.partition;
    const others = [0, 1, 2, 3, 4, 5, 6, 7].filter((p) => p !== owned)

    expect(await startSentBackAttempts(
      makeDeps(helpdeskWith(ticketId), { ledgerReply: true }),
      optionsFor(others),
    )).toHaveLength(0);
  });

  it('leaves the request standing when an attempt dies, and starts the next one', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const first = await parkOnTurnOne(ticketId);
    await sendBackRun(pool, first.runId, { note: NOTE, ledgerReply: true });

    // A provider with no script throws on the walk's first model call, which
    // is the transient fault the poll path retries a message for.
    const failing = makeDeps(helpdeskWith(ticketId), { ledgerReply: true, script: [] });
    expect(await startSentBackAttempts(failing, optionsFor())).toHaveLength(0);
    const afterFailure = await runsOfTurn(first.conversationId, first.turnNumber);
    expect(afterFailure.map((run) => run.attempt)).toEqual([1, 2]);
    // The dead attempt never landed: it sits in a state nobody is walking.
    expect(afterFailure[1]!.state).not.toBe('awaiting_approval');

    // The retry is the same attempt. A crash retry stays in its attempt
    // (DEC-49), so its keys are the keys the dead one derived, and a draft the
    // dead one had already parked would be recognised rather than doubled.
    const working = makeDeps(helpdeskWith(ticketId), { ledgerReply: true });
    expect(await startSentBackAttempts(working, optionsFor())).toHaveLength(1);
    const recovered = await runsOfTurn(first.conversationId, first.turnNumber);
    expect(recovered.map((run) => run.attempt)).toEqual([1, 2, 2]);
    expect(recovered[2]!.state).toBe('awaiting_approval');
  });

  it('escalates a turn whose attempts keep dying, rather than walking it forever', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const first = await parkOnTurnOne(ticketId);
    await sendBackRun(pool, first.runId, { note: NOTE, ledgerReply: true });

    const failing = makeDeps(helpdeskWith(ticketId), { ledgerReply: true, script: [] });
    // Five attempts die. The sixth scan does not start one.
    for (let scan = 0; scan < 5; scan += 1) {
      await startSentBackAttempts(failing, optionsFor());
    }
    expect(await startSentBackAttempts(failing, optionsFor())).toHaveLength(0);

    const runs = await runsOfTurn(first.conversationId, first.turnNumber);
    // The rejected attempt, five dead retries of attempt 2, and the
    // escalation: a FRESH run at the same attempt, filed at the ticket's
    // current fence. The dead retries cannot be ended here — their state is in
    // flight, so the fence governs them, and a bump moves it above them for
    // good.
    expect(runs.map((run) => run.attempt)).toEqual([1, 2, 2, 2, 2, 2, 2]);
    expect(runs[6]!.state).toBe('escalated');
    // And the dead retries keep their own rows, states and spend: the
    // escalation writes a new one and touches none of them.
    for (const dead of runs.slice(1, 6)) {
      expect(dead.state).not.toBe('escalated');
    }
    const escalated = await journalRow(
      (await pool.query<{ run_id: string }>(
        `SELECT run_id FROM run WHERE conversation_id = $1 AND turn_number = $2
            AND state = 'escalated'`,
        [first.conversationId, first.turnNumber],
      )).rows[0]!.run_id,
      'escalate',
    );
    expect(String(escalated?.result?.['reason'])).toContain('send_back_failed');

    // And the turn stops: a later scan starts nothing further.
    expect(await startSentBackAttempts(failing, optionsFor())).toHaveLength(0);
    expect((await runsOfTurn(first.conversationId, first.turnNumber))).toHaveLength(7);
  });

  it('files the escalation even when the fence has moved, so the turn cannot strand', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const first = await parkOnTurnOne(ticketId);
    await sendBackRun(pool, first.runId, { note: NOTE, ledgerReply: true });

    const failing = makeDeps(helpdeskWith(ticketId), { ledgerReply: true, script: [] });
    for (let scan = 0; scan < 5; scan += 1) {
      await startSentBackAttempts(failing, optionsFor());
    }
    // A restart or a new run on the ticket: `claimPartition` bumps the fence
    // of every ticket holding a run in flight, which a dead attempt is. An
    // escalation that went through the run's own epoch would be refused
    // `stale_epoch` on every later scan, and the turn would be served by
    // nobody.
    await pool.query(
      "INSERT INTO ticket_epoch (ticket_id, epoch) VALUES ($1, 99)"
        + ' ON CONFLICT (ticket_id) DO UPDATE SET epoch = 99',
      [ticketId],
    );

    expect(await startSentBackAttempts(failing, optionsFor())).toHaveLength(0);

    const runs = await runsOfTurn(first.conversationId, first.turnNumber);
    expect(runs.at(-1)!.state).toBe('escalated');
    // And the turn stops, rather than re-attempting the same refused write on
    // every scan.
    expect(await startSentBackAttempts(failing, optionsFor())).toHaveLength(0);
    expect(await runsOfTurn(first.conversationId, first.turnNumber)).toHaveLength(runs.length);
  });

  it('refuses to walk a turn that holds no question, and escalates it instead', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const first = await parkOnTurnOne(ticketId);
    await sendBackRun(pool, first.runId, { note: NOTE, ledgerReply: true });
    // A turn whose text is gone: erased by the retention path, or recorded
    // before db/010. The note is not a question (DEC-37), so an attempt
    // walked here spends a classifier, a retrieval and a composition
    // answering nothing.
    await pool.query(
      'UPDATE turn SET body_text = NULL WHERE conversation_id = $1 AND turn_number = $2',
      [first.conversationId, first.turnNumber],
    );
    // And no queued copy of it either: the park's own queue row would be
    // acked by the consumer in production, and the scan reads a queued row's
    // words when the turn holds none.
    await pool.query('DELETE FROM intake WHERE conversation_id = $1', [first.conversationId]);

    const provider = new FakeProvider(happyScript());
    const deps = { ...makeDeps(helpdeskWith(ticketId), { ledgerReply: true }), provider };
    expect(await startSentBackAttempts(deps, optionsFor())).toHaveLength(0);
    // No model call was made at all: an empty script throws on the first one.
    expect(provider.calls).toHaveLength(0);

    const runs = await runsOfTurn(first.conversationId, first.turnNumber);
    expect(runs.map((run) => run.attempt)).toEqual([1, 2]);
    expect(runs[1]!.state).toBe('escalated');
  });
});

// DEC-49: two runs of one turn can wait at one attempt — a message redelivered
// after its ack joins the attempt its turn is on. A send-back rejects the
// attempt, so every writer of the other run is refused, and the turn row's
// lock is what orders them.
describe('DEC-49: twin runs at one attempt', () => {
  /** Park turn one, then redeliver its message so a second run waits beside it. */
  async function twins(ticketId: string): Promise<{
    first: Parked; twinRunId: string; egress: HelpdeskAdapter;
  }> {
    const egress = helpdeskWith(ticketId);
    const first = await parkOnTurnOne(ticketId, { egress });
    await enqueueTicket(
      pool,
      { ticketId, messageId: `m-1-${ticketId}@example.test`, ticketText: TICKET_TEXT },
      PARTITIONS,
    );
    // A twin as a race leaves it: the park refuses a redelivered reply on a
    // turn whose reply already waits.
    await asIfRacing(pool, first.runId, () => processQueuedTickets(
      { ...makeDeps(egress, { ledgerReply: true }), provider: new FakeProvider(happyScript()) },
      optionsFor(),
    ));
    const twin = await pool.query<{ run_id: string; attempt: number; state: string }>(
      `SELECT run_id, attempt, state FROM run
        WHERE conversation_id = $1 AND turn_number = $2 AND run_id <> $3`,
      [first.conversationId, first.turnNumber, first.runId],
    );
    // Non-vacuity: the twin exists, waits, and shares the attempt.
    expect(twin.rows).toHaveLength(1);
    expect(twin.rows[0]!.attempt).toBe(1);
    expect(twin.rows[0]!.state).toBe('awaiting_approval');
    return { first, twinRunId: twin.rows[0]!.run_id, egress };
  }

  // A reply park refuses a twin, but only one of its own attempt. Between a
  // send-back and the scan that ends the rejected attempt's sibling, that
  // sibling still waits, and the new attempt's walk must park regardless.
  it('parks the new attempt while a sibling of the rejected one still waits', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const { first, twinRunId, egress } = await twins(ticketId);
    await sendBackRun(pool, first.runId, { note: NOTE, ledgerReply: true });
    expect((await runRow(twinRunId)).state).toBe('awaiting_approval');

    const result = await coordinateTicket(makeDeps(egress, { ledgerReply: true }), {
      ticketId,
      ticketText: TICKET_TEXT,
      epoch: 10n,
      conversationId: first.conversationId,
      turnNumber: first.turnNumber,
      attempt: 2,
      ...actionSpec(),
    });
    expect(result.outcome).toBe('awaiting_approval');
  });

  it('accepts one of two send-backs on one turn, however they race', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const { first, twinRunId } = await twins(ticketId);

    // Two requests on two connections, one per run. Whatever order they land
    // in, one is accepted and one refused. This case does not force the two to
    // interleave at the lock — the next one does, and it is the one that fails
    // when the turn row is read without it.
    const [a, b] = await Promise.all([
      sendBackRun(pool, first.runId, { note: 'Note A.', ledgerReply: true }),
      sendBackRun(pool, twinRunId, { note: 'Note B.', ledgerReply: true }),
    ]);
    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(['attempt_pending', 'sent_back']);

    // And one scan starts one attempt, at attempt 2.
    const deps = makeDeps(helpdeskWith(ticketId), { ledgerReply: true });
    expect(await startSentBackAttempts(deps, optionsFor())).toHaveLength(1);
    const attempts = await pool.query<{ attempt: number; n: string }>(
      `SELECT attempt, count(*) AS n FROM run
        WHERE conversation_id = $1 AND turn_number = $2 AND attempt > 1
        GROUP BY attempt`,
      [first.conversationId, first.turnNumber],
    );
    expect(attempts.rows).toEqual([{ attempt: 2, n: '1' }]);
  });

  // The interleaving the race above cannot force: another send-back holds the
  // turn row and has not committed. The check must wait for it and read the
  // attempt it raised — a plain read would see the old attempt, pass, and send
  // the turn back a second time once the first commits.
  it('waits for a send-back in flight on the same turn, and reads the attempt it raised', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const { first, twinRunId } = await twins(ticketId);

    // Stand in for reviewer A's send-back, mid-transaction: the turn row
    // locked, the attempt about to be raised, nothing committed yet.
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        'SELECT attempt FROM turn WHERE conversation_id = $1 AND turn_number = $2 FOR UPDATE',
        [first.conversationId, first.turnNumber],
      );

      const second = sendBackRun(pool, twinRunId, { note: 'Note B.', ledgerReply: true });
      // Wait until reviewer B's write is blocked on a lock, rather than for a
      // fixed time: it must have started before A commits.
      expect(await lockWaitSeen(pool), 'reviewer B waits on the turn lock').toBe(true);
      await holder.query(
        'UPDATE turn SET attempt = 2 WHERE conversation_id = $1 AND turn_number = $2',
        [first.conversationId, first.turnNumber],
      );
      await holder.query('COMMIT');

      expect(await second).toEqual({ outcome: 'attempt_pending' });
    } finally {
      holder.release();
    }
    const turn = await pool.query<{ attempt: number }>(
      'SELECT attempt FROM turn WHERE conversation_id = $1 AND turn_number = $2',
      [first.conversationId, first.turnNumber],
    );
    expect(turn.rows[0]?.attempt).toBe(2);
    expect((await runRow(twinRunId)).state).toBe('awaiting_approval');
  });

  it('refuses to approve, save or rewrite the other run of a rejected attempt', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const { first, twinRunId } = await twins(ticketId);
    await sendBackRun(pool, first.runId, { note: NOTE, ledgerReply: true });

    // The twin still waits and shows the reply the reviewer rejected. Sending
    // it would put that reply on the wire beside the new attempt's.
    expect(await approveRun(pool, twinRunId, {
      ledgerReply: true, approvedBy: 'bo@example.test', approvedBySource: 'roster',
    })).toEqual({ outcome: 'sent_back' });
    // And a save on it would shadow the new attempt: the approval prefers the
    // saved text over the park body.
    expect(await saveReply(pool, twinRunId, 'A reply for the rejected attempt.'))
      .toEqual({ outcome: 'sent_back' });
    const held = await pool.query<{ text: string | null }>(
      'SELECT saved_reply_text AS text FROM turn WHERE conversation_id = $1 AND turn_number = $2',
      [first.conversationId, first.turnNumber],
    );
    expect(held.rows[0]?.text).toBeNull();
    const outbox = await pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM outbox WHERE run_id = $1', [twinRunId],
    );
    expect(Number(outbox.rows[0]!.n)).toBe(0);

    // The consumer's scan takes it out of the queue, and records why.
    await startSentBackAttempts(makeDeps(helpdeskWith(ticketId), { ledgerReply: true }), optionsFor());
    expect((await runRow(twinRunId)).state).toBe('superseded');
    expect(await journalRow(twinRunId, 'supersede')).toMatchObject({
      status: 'done', result: { reason: 'attempt_rejected' },
    });
  });

  // The path production reaches: a sibling approved first, its reply held for
  // the DEC-51 window, then the other run sent back. The held reply will go
  // out, so a new attempt beside it would be a second reply on one turn.
  it('refuses a send-back while a sibling approval waits to go out', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const { first, twinRunId } = await twins(ticketId);
    expect(await approveRun(pool, twinRunId, {
      ledgerReply: true, approvedBy: 'bo@example.test', approvedBySource: 'roster',
      sendHoldMs: 60_000,
    })).toMatchObject({ outcome: 'approved' });

    expect(await sendBackRun(pool, first.runId, { note: NOTE, ledgerReply: true }))
      .toEqual({ outcome: 'turn_may_have_reached' });
    const turn = await pool.query<{ attempt: number }>(
      'SELECT attempt FROM turn WHERE conversation_id = $1 AND turn_number = $2',
      [first.conversationId, first.turnNumber],
    );
    expect(turn.rows[0]?.attempt).toBe(1);
  });

  // The scan's own check is the guard for a record the console cannot write
  // after a send-back — the send-back refuses a closed turn and every approval
  // of a rejected attempt is refused. Another path can: a run of the same
  // conversation with no turn, a seed, a replay. So the record is written
  // here by hand, as such a path would, after the send-back commits.
  it('drops the request, and the held redelivery with it, when a record closes the turn', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const egress = helpdeskWith(ticketId);
    const first = await parkOnTurnOne(ticketId, { egress });
    await sendBackRun(pool, first.runId, { note: NOTE, ledgerReply: true });
    // A redelivered message, held by the queue while the attempt is due.
    await enqueueTicket(
      pool,
      { ticketId, messageId: `m-1-${ticketId}@example.test`, ticketText: TICKET_TEXT },
      PARTITIONS,
    );
    const outside = await pool.query<{ run_id: string }>(
      `INSERT INTO run (run_id, ticket_id, partition, epoch, state, prompt_ver, model_ver,
                        deadline_at, finished_at, conversation_id, turn_number)
       VALUES (gen_random_uuid(), $1, 0, 1, 'resolved', 'p', 'm', now(), now(), $2, $3)
       RETURNING run_id`,
      [ticketId, first.conversationId, first.turnNumber],
    );
    await recordOnTurn(outside.rows[0]!.run_id, 'sent');

    // Two queued rows the removal must not reach: the conversation's next
    // turn, which is another message the customer sent, and another ticket.
    const nextTurn = await enqueueTicket(
      pool,
      { ticketId, messageId: `m-2-${ticketId}@example.test`, ticketText: 'And one more thing.' },
      PARTITIONS,
    );
    expect(nextTurn.turnNumber).toBe(first.turnNumber + 1);
    const otherTicket = `T-${randomUUID().slice(0, 8)}`;
    await enqueueTicket(
      pool,
      { ticketId: otherTicket, messageId: `m-1-${otherTicket}@example.test`, ticketText: TICKET_TEXT },
      PARTITIONS,
    );

    const provider = new FakeProvider([...happyScript(), ...happyScript()]);
    const deps: CoordinatorDeps = { ...makeDeps(egress, { ledgerReply: true }), provider };
    // The scan alone: the poll would walk the two rows above, which are not
    // this case's subject, and the rows are counted before any walk.
    expect(await startSentBackAttempts(deps, optionsFor())).toHaveLength(0);
    const survivors = await pool.query<{ ticket_id: string; turn_number: number }>(
      'SELECT ticket_id, turn_number FROM intake ORDER BY ticket_id, turn_number',
    );
    expect(survivors.rows).toEqual(
      [
        { ticket_id: ticketId, turn_number: first.turnNumber + 1 },
        { ticket_id: otherTicket, turn_number: 1 },
      ].sort((a, b) => a.ticket_id.localeCompare(b.ticket_id)),
    );
    // Then the pass in production order, restricted to this turn's facts: the
    // redelivery is gone, so nothing walks this turn's attempt.
    await pool.query('DELETE FROM intake WHERE ticket_id = $1 OR turn_number <> $2', [
      otherTicket, first.turnNumber,
    ]);
    await processQueuedTickets(deps, optionsFor());

    // No walk at all, by the scan or by the redelivery the escalation would
    // otherwise have released: a second reply would reach a customer who has
    // one.
    expect(provider.calls).toHaveLength(0);
    const queued = await pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM intake WHERE conversation_id = $1 AND turn_number = $2',
      [first.conversationId, first.turnNumber],
    );
    expect(Number(queued.rows[0]!.n)).toBe(0);
    const escalated = await pool.query<{ reason: string }>(
      `SELECT j.result->>'reason' AS reason FROM run r
         JOIN step_journal j ON j.run_id = r.run_id AND j.step_id = 'escalate'
        WHERE r.conversation_id = $1 AND r.turn_number = $2 AND r.state = 'escalated'`,
      [first.conversationId, first.turnNumber],
    );
    expect(escalated.rows[0]?.reason).toContain('send_back_dropped');
    // What left the queue is counted on the row an operator reads.
    const counted = await pool.query<{ n: string }>(
      `SELECT j.result->>'heldMessagesRemoved' AS n FROM run r
         JOIN step_journal j ON j.run_id = r.run_id AND j.step_id = 'escalate'
        WHERE r.conversation_id = $1 AND r.turn_number = $2 AND r.state = 'escalated'`,
      [first.conversationId, first.turnNumber],
    );
    expect(counted.rows[0]?.n).toBe('1');
    const waiting = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM run
        WHERE conversation_id = $1 AND turn_number = $2 AND state = 'awaiting_approval'`,
      [first.conversationId, first.turnNumber],
    );
    expect(Number(waiting.rows[0]!.n)).toBe(0);
  });

  // A rebalance overlap: two owners scan the same partition at once. The
  // first to commit lands the attempt; the second reads it landed under the
  // turn's lock and files nothing.
  it('files one escalation when two owners drop the same turn at once', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const first = await parkOnTurnOne(ticketId);
    await sendBackRun(pool, first.runId, { note: NOTE, ledgerReply: true });
    const outside = await pool.query<{ run_id: string }>(
      `INSERT INTO run (run_id, ticket_id, partition, epoch, state, prompt_ver, model_ver,
                        deadline_at, finished_at, conversation_id, turn_number)
       VALUES (gen_random_uuid(), $1, 0, 1, 'resolved', 'p', 'm', now(), now(), $2, $3)
       RETURNING run_id`,
      [ticketId, first.conversationId, first.turnNumber],
    );
    await recordOnTurn(outside.rows[0]!.run_id, 'sent');

    const owner = (): CoordinatorDeps => makeDeps(helpdeskWith(ticketId), { ledgerReply: true });
    await Promise.all([
      startSentBackAttempts(owner(), optionsFor()),
      startSentBackAttempts(owner(), optionsFor()),
    ]);

    const escalations = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM run
        WHERE conversation_id = $1 AND turn_number = $2 AND state = 'escalated'`,
      [first.conversationId, first.turnNumber],
    );
    expect(Number(escalations.rows[0]!.n)).toBe(1);
  });

  // A send-back that lands while a queued message's walk is failing. The
  // abandonment that follows is filed at the attempt the walk was at, not the
  // attempt the turn moved to: filed at the new one it would land the
  // reviewer's request, and the scan would start nothing.
  it('files an abandonment at the attempt it failed at, leaving the request due', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const egress = helpdeskWith(ticketId);
    const first = await parkOnTurnOne(ticketId, { egress });
    await enqueueTicket(
      pool,
      { ticketId, messageId: `m-1-${ticketId}@example.test`, ticketText: TICKET_TEXT },
      PARTITIONS,
    );
    let sentBack = false;
    const failing = new FakeProvider([]);
    const provider = new Proxy(failing, {
      get(target, prop, receiver) {
        if (prop === 'complete') {
          return async () => {
            if (!sentBack) {
              sentBack = true;
              expect(await sendBackRun(pool, first.runId, { note: NOTE, ledgerReply: true }))
                .toEqual({ outcome: 'sent_back' });
            }
            throw new Error('the provider is down');
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const deps: CoordinatorDeps = { ...makeDeps(egress, { ledgerReply: true }), provider };
    await processQueuedTickets(deps, { ...optionsFor(), maxIntakeAttempts: 1 });

    const abandoned = await pool.query<{ attempt: number }>(
      `SELECT attempt FROM run
        WHERE conversation_id = $1 AND turn_number = $2 AND prompt_ver = 'intake'`,
      [first.conversationId, first.turnNumber],
    );
    expect(abandoned.rows).toEqual([{ attempt: 1 }]);

    // The request the reviewer made is still served, with their note.
    const working = new FakeProvider(happyScript());
    expect(await startSentBackAttempts(
      { ...makeDeps(egress, { ledgerReply: true }), provider: working }, optionsFor(),
    )).toHaveLength(1);
    expect(working.calls.filter((call) =>
      (call.messages ?? []).some((message) => message.content.includes(NOTE)))).toHaveLength(1);
  });

  // A turn with no text, and a held redelivery that has it. The attempt the
  // reviewer asked for walks with the held message's words and the note
  // together, rather than escalating the turn and letting the message walk
  // later without the note.
  it('walks a turn with no text on a held message\'s words, with the note', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const egress = helpdeskWith(ticketId);
    const first = await parkOnTurnOne(ticketId, { egress });
    await sendBackRun(pool, first.runId, { note: NOTE, ledgerReply: true });
    await enqueueTicket(
      pool,
      { ticketId, messageId: `m-1-${ticketId}@example.test`, ticketText: TICKET_TEXT },
      PARTITIONS,
    );
    await pool.query(
      'UPDATE turn SET body_text = NULL WHERE conversation_id = $1 AND turn_number = $2',
      [first.conversationId, first.turnNumber],
    );

    const provider = new FakeProvider(happyScript());
    const deps: CoordinatorDeps = { ...makeDeps(egress, { ledgerReply: true }), provider };
    expect(await startSentBackAttempts(deps, optionsFor())).toHaveLength(1);
    const composer = provider.calls.find((call) =>
      (call.messages ?? []).some((message) => message.content.includes(NOTE)));
    const prompt = composer?.messages?.at(-1)?.content ?? '';
    expect(prompt).toContain(NOTE);
    expect(prompt).toContain(TICKET_TEXT);
    // No escalation: the turn did hold a question, in the queue.
    const escalated = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM run
        WHERE conversation_id = $1 AND turn_number = $2 AND state = 'escalated'`,
      [first.conversationId, first.turnNumber],
    );
    expect(Number(escalated.rows[0]!.n)).toBe(0);
  });

  // The last double-send path the fourth pass found: a record another path
  // wrote closes the turn, the scan drops the request, and a message
  // redelivered AFTER the drop walks the raised attempt with fresh keys. Its
  // reply may be parked, but a turn takes one reply: the approval refuses it.
  it('refuses the approval of a reply on a turn that already has one', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const egress = helpdeskWith(ticketId);
    const first = await parkOnTurnOne(ticketId, { egress });
    await sendBackRun(pool, first.runId, { note: NOTE, ledgerReply: true });
    const outside = await pool.query<{ run_id: string }>(
      `INSERT INTO run (run_id, ticket_id, partition, epoch, state, prompt_ver, model_ver,
                        deadline_at, finished_at, conversation_id, turn_number)
       VALUES (gen_random_uuid(), $1, 0, 1, 'resolved', 'p', 'm', now(), now(), $2, $3)
       RETURNING run_id`,
      [ticketId, first.conversationId, first.turnNumber],
    );
    await recordOnTurn(outside.rows[0]!.run_id, 'sent');

    const deps: CoordinatorDeps = {
      ...makeDeps(egress, { ledgerReply: true }),
      provider: new FakeProvider(happyScript()),
    };
    expect(await startSentBackAttempts(deps, optionsFor())).toHaveLength(0);
    // After the drop: the redelivery is not held any more, and walks.
    await enqueueTicket(
      pool,
      { ticketId, messageId: `m-1-${ticketId}@example.test`, ticketText: TICKET_TEXT },
      PARTITIONS,
    );
    await processQueuedTickets(deps, optionsFor());
    // The redelivery walked at the raised attempt and parked nothing: the turn
    // already holds a reply, so the park stops it superseded. A reply on that
    // turn could never be approved anyway.
    const walked = await pool.query<{ run_id: string; state: string }>(
      `SELECT run_id, state FROM run
        WHERE conversation_id = $1 AND turn_number = $2 AND attempt = 2
          AND prompt_ver <> 'intake'`,
      [first.conversationId, first.turnNumber],
    );
    expect(walked.rows).toHaveLength(1);
    expect(walked.rows[0]!.state).toBe('superseded');
    expect(await approveRun(pool, walked.rows[0]!.run_id, {
      ledgerReply: true, approvedBy: 'bo@example.test', approvedBySource: 'roster',
    })).toEqual({ outcome: 'not_awaiting_approval', state: 'superseded' });
    const replies = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM outbox o JOIN run r ON r.run_id = o.run_id
        WHERE r.conversation_id = $1 AND o.status IN ('pending', 'sent')`,
      [first.conversationId],
    );
    expect(Number(replies.rows[0]!.n)).toBe(1);
  });

  // Twin runs of one attempt, both waiting. The first approval's record
  // closes the turn; the second is refused before it derives anything, and
  // the consumer then ends it, so it does not wait in the queue for ever.
  it('refuses the second twin once the first twin\'s reply is on its way, then ends it', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const { first, twinRunId } = await twins(ticketId);
    expect(await approveRun(pool, first.runId, {
      ledgerReply: true, approvedBy: 'anna@example.test', approvedBySource: 'roster',
      sendHoldMs: 60_000,
    })).toMatchObject({ outcome: 'approved' });

    expect(await approveRun(pool, twinRunId, {
      ledgerReply: true, approvedBy: 'bo@example.test', approvedBySource: 'roster',
    })).toEqual({ outcome: 'turn_closed' });

    await startSentBackAttempts(makeDeps(helpdeskWith(ticketId), { ledgerReply: true }), optionsFor());
    expect((await runRow(twinRunId)).state).toBe('superseded');
    // And the record names the run whose reply answered the turn.
    expect(await journalRow(twinRunId, 'supersede')).toMatchObject({
      status: 'done', result: { reason: 'turn_answered', answeredBy: first.runId },
    });
  });

  // The control the fifth pass found missing. A record on a run with no turn
  // number answered some message of the conversation, and nothing says which:
  // it closes no turn. Read as every turn's record, it refused every later
  // turn's reply for good.
  it('lets a later turn be approved beside a record that names no turn', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const first = await parkOnTurnOne(ticketId);
    const turnless = await pool.query<{ run_id: string }>(
      `INSERT INTO run (run_id, ticket_id, partition, epoch, state, prompt_ver, model_ver,
                        deadline_at, finished_at, conversation_id)
       VALUES (gen_random_uuid(), $1, 0, 1, 'resolved', 'p', 'm', now(), now(), $2)
       RETURNING run_id`,
      [ticketId, first.conversationId],
    );
    await recordOnTurn(turnless.rows[0]!.run_id, 'sent');

    expect(await approveRun(pool, first.runId, {
      ledgerReply: true, approvedBy: 'anna@example.test', approvedBySource: 'roster',
    })).toMatchObject({ outcome: 'approved' });
  });

  // DEC-34: a compensation is not a reply. A reply approved on the turn does
  // not make it a second one, so it is approved and the consumer leaves it.
  it('approves a compensation on a turn whose reply already went out', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const egress = helpdeskWith(ticketId);
    const first = await parkOnTurnOne(ticketId, { egress });
    expect(await approveRun(pool, first.runId, {
      ledgerReply: true, approvedBy: 'anna@example.test', approvedBySource: 'roster',
    })).toMatchObject({ outcome: 'approved' });

    const compensation = await coordinateTicket(makeDeps(egress, { ledgerReply: true }), {
      ticketId,
      ticketText: TICKET_TEXT,
      epoch: 'next',
      conversationId: first.conversationId,
      turnNumber: first.turnNumber,
      actionClass: COMPENSATION_ACTION_CLASS,
      actionPayload: { reason: 'refund sent to the wrong account' },
      delivery: 'at_most_once',
      isCustomerVisible: false,
      disclosure: DISCLOSURE,
    });
    expect(compensation.outcome).toBe('awaiting_approval');
    await startSentBackAttempts(makeDeps(egress, { ledgerReply: true }), optionsFor());
    expect((await runRow(compensation.runId)).state).toBe('awaiting_approval');
    expect(await approveRun(pool, compensation.runId, { approvedBy: 'anna@example.test' }))
      .toMatchObject({ outcome: 'approved' });
  });

  // The other direction of DEC-34: a compensation's record on the turn is not
  // a reply, so it does not close the turn to the reply waiting on it.
  it('approves a reply on a turn whose only record is a compensation\'s', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const egress = helpdeskWith(ticketId);
    const first = await parkOnTurnOne(ticketId, { egress });
    const compensation = await coordinateTicket(makeDeps(egress, { ledgerReply: true }), {
      ticketId,
      ticketText: TICKET_TEXT,
      epoch: 'next',
      conversationId: first.conversationId,
      turnNumber: first.turnNumber,
      actionClass: COMPENSATION_ACTION_CLASS,
      actionPayload: { reason: 'refund sent to the wrong account' },
      delivery: 'at_most_once',
      isCustomerVisible: false,
      disclosure: DISCLOSURE,
    });
    expect(await approveRun(pool, compensation.runId, { approvedBy: 'anna@example.test' }))
      .toMatchObject({ outcome: 'approved' });

    expect(await approveRun(pool, first.runId, {
      ledgerReply: true, approvedBy: 'anna@example.test', approvedBySource: 'roster',
    })).toMatchObject({ outcome: 'approved' });
  });

  // The sweep ends the twin while the other twin's held send stands. If that
  // approval is then undone, its own run returns to the queue: the case is
  // still approvable, on the run that was undone, and the twin — the same
  // attempt, the same reply — does not come back.
  it('leaves the case approvable when a held approval is undone after the sweep', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const { first, twinRunId } = await twins(ticketId);
    expect(await approveRun(pool, first.runId, {
      ledgerReply: true, approvedBy: 'anna@example.test', approvedBySource: 'roster',
      sendHoldMs: 60_000,
    })).toMatchObject({ outcome: 'approved' });
    await startSentBackAttempts(makeDeps(helpdeskWith(ticketId), { ledgerReply: true }), optionsFor());
    expect((await runRow(twinRunId)).state).toBe('superseded');

    expect(await undoApproval(pool, first.runId, { reviewer: 'anna@example.test' }))
      .toMatchObject({ outcome: 'undone' });
    expect((await runRow(first.runId)).state).toBe('awaiting_approval');
    // The turn is open again, so a scan ends nothing more.
    await startSentBackAttempts(makeDeps(helpdeskWith(ticketId), { ledgerReply: true }), optionsFor());
    expect((await runRow(first.runId)).state).toBe('awaiting_approval');
    expect(await approveRun(pool, first.runId, {
      ledgerReply: true, approvedBy: 'anna@example.test', approvedBySource: 'roster',
    })).toMatchObject({ outcome: 'approved' });
  });
});
