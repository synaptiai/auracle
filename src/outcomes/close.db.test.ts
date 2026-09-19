/**
 * DEC-48: a reviewer closes a case with no reply.
 *
 * The cases are about what a close must guarantee. It never sends: no outbox
 * record commits with it, and no reply text reaches the turn. It ends the
 * work on the case: the hold goes, under a kind of its own. And it records
 * who closed it and why, on the run it finished.
 *
 * The refusals are held to their own reasons, because each one sends a
 * reviewer somewhere else: a case that is not waiting, a page whose reply
 * moved under them, and a reason that says nothing.
 */
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { HelpdeskAdapter } from '../adapters/helpdesk.js';
import { CUSTOMER_REPLY_ACTION_CLASS } from '../adapters/types.js';
import type { AdapterCapabilities } from '../policy/policy.js';
import { approveRun } from '../approval/approve.js';
import { replyDigest } from '../approval/shown.js';
import { coordinateTicket } from '../coordinator/coordinator.js';
import type { CoordinatorDeps } from '../coordinator/coordinator.js';
import { enqueueTicket } from '../coordinator/intake.js';
import { dbUrl } from '../db/config.js';
import { takeHold } from '../holds/hold.js';
import { FakeProvider } from '../models/fake.js';
import type { FakeStep } from '../models/fake.js';
import { indexDocument } from '../retriever/retriever.js';
import { truncateLedger } from '../test-support/schema.js';

import { MAX_CLOSE_REASON_CHARS, closeRun } from './close.js';

const pool = new Pool({ connectionString: dbUrl(), max: 8 });

afterAll(async () => {
  await pool.end();
});

await pool.query('SELECT 1');

const PINS = { promptVer: 'close-prompt', modelVer: 'close-model' };
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
    {
      ticketId,
      subject: 'Cannot sign in',
      queue: 'accounts',
      status: 'open',
      customerAddress: null,
    },
  ]);
}

interface Parked {
  readonly runId: string;
  readonly conversationId: string;
  readonly turnNumber: number;
  /** The body the park journalled, which is the reply the ledger holds. */
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
  const parked = await pool.query<{ body: string }>(
    "SELECT result->>'body' AS body FROM step_journal WHERE run_id = $1 AND step_id = 'park'",
    [result.runId],
  );
  return {
    runId: result.runId,
    conversationId: enqueued.conversationId,
    turnNumber: enqueued.turnNumber,
    parkedBody: parked.rows[0]!.body,
  };
}

async function runRow(runId: string): Promise<{ state: string; finished_at: Date | null }> {
  const rows = await pool.query(
    'SELECT state, finished_at FROM run WHERE run_id = $1',
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

interface CloseRow {
  status: string;
  result: { reason?: string; reviewer?: string; reviewerSource?: string } | null;
}

async function closeRow(runId: string): Promise<CloseRow | undefined> {
  const rows = await pool.query(
    "SELECT status, result FROM step_journal WHERE run_id = $1 AND step_id = 'close'",
    [runId],
  );
  return rows.rows[0] as CloseRow | undefined;
}

async function holdRow(runId: string): Promise<{
  released_at: Date | null; released_by: string | null; release_kind: string | null;
} | undefined> {
  const rows = await pool.query(
    'SELECT released_at, released_by, release_kind FROM case_hold WHERE run_id = $1',
    [runId],
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

describe('DEC-48: a case closed with no reply', () => {
  it('finishes the run with no send, and records who closed it and why', async () => {
    const { runId, conversationId, turnNumber } = await parkOnTurnOne(`T-${randomUUID().slice(0, 8)}`);

    const outcome = await closeRun(pool, runId, {
      reason: '  Duplicate of ticket T-4471.  ',
      closedBy: 'anna@example.test',
      closedBySource: 'roster',
    });
    expect(outcome).toEqual({ outcome: 'closed' });

    const run = await runRow(runId);
    expect(run.state).toBe('closed');
    expect(run.finished_at).not.toBeNull();

    // Nothing sends for a close. Not an empty record: no record at all.
    expect(await outboxCount(runId)).toBe(0);
    const turn = await pool.query<{ approved_reply_text: string | null }>(
      'SELECT approved_reply_text FROM turn WHERE conversation_id = $1 AND turn_number = $2',
      [conversationId, turnNumber],
    );
    expect(turn.rows[0]!.approved_reply_text).toBeNull();

    // The record DEC-48 asks for: the reviewer and the reason, beside it.
    // Trimmed, because a form field arrives with what the person typed around
    // the reason rather than in it.
    expect(await closeRow(runId)).toEqual({
      status: 'done',
      result: {
        reason: 'Duplicate of ticket T-4471.',
        reviewer: 'anna@example.test',
        reviewerSource: 'roster',
      },
    });
  });

  it('ends the hold on the case, under a kind of its own', async () => {
    const { runId } = await parkOnTurnOne(`T-${randomUUID().slice(0, 8)}`);
    await takeHold(pool, { runId, reviewer: 'anna@example.test', lapseMs: 20 * 60_000 });

    await closeRun(pool, runId, { reason: 'No longer needed.', closedBy: 'anna@example.test' });

    const hold = await holdRow(runId);
    expect(hold?.released_by).toBe('anna@example.test');
    // `close`, never `send`. A close sends nothing, so a send here would put
    // an event in the team's history that never happened.
    expect(hold?.release_kind).toBe('close');
    expect(hold?.released_at).not.toBeNull();
    expect(await holdEvents(runId)).toEqual(['take', 'close']);
  });

  it('ends a hold somebody else took, because the case leaves the queue', async () => {
    const { runId } = await parkOnTurnOne(`T-${randomUUID().slice(0, 8)}`);
    await takeHold(pool, { runId, reviewer: 'anna@example.test', lapseMs: 20 * 60_000 });

    // Maintainer's ruling for the approval, applied to the close (DEC-46): a
    // hold left on a case that has left the queue reads as a lapse later.
    await closeRun(pool, runId, { reason: 'Handled by phone.', closedBy: 'bo@example.test' });

    const hold = await holdRow(runId);
    expect(hold?.release_kind).toBe('close');
    expect(hold?.released_by).toBe('bo@example.test');
  });

  it('records an unnamed closer as unattributed, and proves nothing by it', async () => {
    const { runId } = await parkOnTurnOne(`T-${randomUUID().slice(0, 8)}`);

    await closeRun(pool, runId, { reason: 'Spam.' });

    expect((await closeRow(runId))?.result).toEqual({
      reason: 'Spam.',
      reviewer: 'unattributed',
      // DEC-45: the name nobody holds proves nothing, and the source says so
      // rather than defaulting to a claim.
      reviewerSource: 'none',
    });
  });

  // A hold that ran out is nobody's, so the close releases nothing and the
  // history says the lapse rather than re-attributing the end of the work to
  // whoever closed it. The close commits either way: the case leaves the
  // queue whatever the hold was doing.
  it('closes a case whose hold had lapsed, and records the lapse as a lapse', async () => {
    const { runId } = await parkOnTurnOne(`T-${randomUUID().slice(0, 8)}`);
    await takeHold(pool, { runId, reviewer: 'anna@example.test', lapseMs: 20 * 60_000 });
    await pool.query('UPDATE case_hold SET lapses_at = now() WHERE run_id = $1', [runId]);

    expect(await closeRun(pool, runId, { reason: 'Settled.', closedBy: 'bo@example.test' }))
      .toEqual({ outcome: 'closed' });

    const hold = await holdRow(runId);
    expect(hold?.release_kind).toBe('lapse');
    expect(hold?.released_by).toBeNull();
    expect(await holdEvents(runId)).toEqual(['take', 'lapse']);
  });

  it('refuses a run that is not waiting for a person, and names its state', async () => {
    const { runId } = await parkOnTurnOne(`T-${randomUUID().slice(0, 8)}`);
    await approveRun(pool, runId, { approvedBy: 'anna@example.test' });

    const outcome = await closeRun(pool, runId, { reason: 'Too late.', closedBy: 'anna@example.test' });
    expect(outcome).toEqual({ outcome: 'not_awaiting_approval', state: 'resolved' });

    // And nothing was written for the refusal.
    expect(await closeRow(runId)).toBeUndefined();
  });

  it('refuses a second close, which names the state the first one left', async () => {
    const { runId } = await parkOnTurnOne(`T-${randomUUID().slice(0, 8)}`);
    expect((await closeRun(pool, runId, { reason: 'First.', closedBy: 'anna@example.test' })))
      .toEqual({ outcome: 'closed' });

    expect(await closeRun(pool, runId, { reason: 'Second.', closedBy: 'bo@example.test' }))
      .toEqual({ outcome: 'not_awaiting_approval', state: 'closed' });
    // The first reason stands. A second row would have replaced the record of
    // the person who actually closed it.
    expect((await closeRow(runId))?.result?.reviewer).toBe('anna@example.test');
  });

  it('refuses a close from a page whose reply moved, and closes the one that did not', async () => {
    const { runId, parkedBody } = await parkOnTurnOne(`T-${randomUUID().slice(0, 8)}`);

    // The reply the ledger holds, as a page would have drawn it.
    const drawn = replyDigest(parkedBody);
    // Another text: a page drawn before somebody saved an edit to this reply,
    // or a page this console never rendered.
    const stale = replyDigest(`${parkedBody} Edited by somebody else.`);
    expect(stale).not.toBe(drawn);

    expect(await closeRun(pool, runId, { reason: 'Not needed.', closedBy: 'anna@example.test', shown: stale }))
      .toEqual({ outcome: 'shown_changed' });
    expect((await runRow(runId)).state).toBe('awaiting_approval');
    expect(await closeRow(runId)).toBeUndefined();

    // The same call with the digest the page would have carried closes it, so
    // the refusal above is the guard rather than a refusal to close at all.
    expect(await closeRun(pool, runId, { reason: 'Not needed.', closedBy: 'anna@example.test', shown: drawn }))
      .toEqual({ outcome: 'closed' });
    expect((await runRow(runId)).state).toBe('closed');
  });

  it('checks the digest against the reply a person saved, where the ledger holds it', async () => {
    const { runId, conversationId, turnNumber, parkedBody } = await parkOnTurnOne(
      `T-${randomUUID().slice(0, 8)}`,
    );
    const saved = `${parkedBody} Signed, the accounts team.`;
    await pool.query(
      'UPDATE turn SET saved_reply_text = $3 WHERE conversation_id = $1 AND turn_number = $2',
      [conversationId, turnNumber, saved],
    );

    // DEC-44, DEC-46: on an adapter whose ledger holds the reply, that reply
    // is what the page drew, so the parked body's digest is a page the
    // reviewer is no longer reading.
    expect(await closeRun(pool, runId, {
      reason: 'Not needed.', closedBy: 'anna@example.test', ledgerReply: true, shown: replyDigest(parkedBody),
    })).toEqual({ outcome: 'shown_changed' });
    expect(await closeRun(pool, runId, {
      reason: 'Not needed.', closedBy: 'anna@example.test', ledgerReply: true, shown: replyDigest(saved),
    })).toEqual({ outcome: 'closed' });
  });

  // DEC-44: which text a page drew depends on the adapter. On the draft path
  // the helpdesk holds the copy that sends, so the case page draws the parked
  // body and its reviewer read that. Comparing the saved reply there refuses
  // every close of a case whose turn carries one — a case nobody could close
  // — and the refusal tells the reviewer to open a page that would draw the
  // same text again.
  it('compares the text the caller showed, which the adapter decides', async () => {
    const { runId, conversationId, turnNumber, parkedBody } = await parkOnTurnOne(
      `T-${randomUUID().slice(0, 8)}`,
    );
    const saved = `${parkedBody} Signed, the accounts team.`;
    await pool.query(
      'UPDATE turn SET saved_reply_text = $3 WHERE conversation_id = $1 AND turn_number = $2',
      [conversationId, turnNumber, saved],
    );

    // The draft path: the page drew the parked body, and the close compares
    // that. The saved reply is not what the console showed anybody.
    expect(await closeRun(pool, runId, {
      reason: 'Not needed.', closedBy: 'anna@example.test', ledgerReply: false, shown: replyDigest(parkedBody),
    })).toEqual({ outcome: 'closed' });
  });

  it('refuses a reason that says nothing, or one longer than the bound', async () => {
    const { runId } = await parkOnTurnOne(`T-${randomUUID().slice(0, 8)}`);

    expect(await closeRun(pool, runId, { reason: '   ', closedBy: 'anna@example.test' }))
      .toEqual({ outcome: 'empty_reason' });
    expect(await closeRun(pool, runId, { reason: 'x'.repeat(MAX_CLOSE_REASON_CHARS + 1), closedBy: 'anna@example.test' }))
      .toEqual({ outcome: 'reason_too_long' });

    // Both refusals happen before any write, so the case is still waiting.
    expect((await runRow(runId)).state).toBe('awaiting_approval');
    expect(await closeRow(runId)).toBeUndefined();
  });

  it('closes a case at exactly the reason bound, so the bound is the limit and not one less', async () => {
    const { runId } = await parkOnTurnOne(`T-${randomUUID().slice(0, 8)}`);
    const reason = 'x'.repeat(MAX_CLOSE_REASON_CHARS);

    expect(await closeRun(pool, runId, { reason, closedBy: 'anna@example.test' }))
      .toEqual({ outcome: 'closed' });
    expect((await closeRow(runId))?.result?.reason).toBe(reason);
  });

  // A reason that cannot be stored is a request this ledger declines, not a
  // fault. Postgres `text` and `jsonb` both refuse a NUL, and a lone
  // surrogate is not text any encoder can write: either one raises inside the
  // journal insert, and the console then answers 500 about a close that wrote
  // nothing.
  it('refuses a reason the ledger cannot store, rather than raising', async () => {
    const { runId } = await parkOnTurnOne(`T-${randomUUID().slice(0, 8)}`);
    const reasons = [
      `Duplicate${String.fromCharCode(0)}of T-1`,
      `Duplicate ${String.fromCharCode(0xd800)} of T-1`,
    ];

    for (const reason of reasons) {
      expect(await closeRun(pool, runId, { reason, closedBy: 'anna@example.test' }))
        .toEqual({ outcome: 'unprintable_reason' });
    }

    // Refused before any write, so the case is still waiting.
    expect((await runRow(runId)).state).toBe('awaiting_approval');
    expect(await closeRow(runId)).toBeUndefined();
  });

  it('refuses a run the ledger does not hold', async () => {
    expect(await closeRun(pool, randomUUID(), { reason: 'Not needed.' }))
      .toEqual({ outcome: 'unknown_run' });
  });

  it('commits one close when two arrive together', async () => {
    const { runId } = await parkOnTurnOne(`T-${randomUUID().slice(0, 8)}`);

    const outcomes = await Promise.all([
      closeRun(pool, runId, { reason: 'Anna closed it.', closedBy: 'anna@example.test' }),
      closeRun(pool, runId, { reason: 'Bo closed it.', closedBy: 'bo@example.test' }),
    ]);

    // The row lock decides: one commits and one finds the state gone. Both
    // outcomes are answered rather than one racing the other.
    expect(outcomes.filter((outcome) => outcome.outcome === 'closed')).toHaveLength(1);
    const refused = outcomes.filter((outcome) => outcome.outcome === 'not_awaiting_approval');
    expect(refused).toEqual([{ outcome: 'not_awaiting_approval', state: 'closed' }]);
    // And one record of the close, naming the person who made it. Two rows
    // would mean the loser wrote something.
    const rows = await pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM step_journal WHERE run_id = $1 AND step_id = 'close'",
      [runId],
    );
    expect(Number(rows.rows[0]!.n)).toBe(1);
    // And the row belongs to the close that won, not the one that lost.
    const recorded = await closeRow(runId);
    expect(['anna@example.test', 'bo@example.test']).toContain(recorded?.result?.reviewer);
    expect(recorded?.result?.reason).toBe(
      outcomes[0]!.outcome === 'closed' ? 'Anna closed it.' : 'Bo closed it.',
    );
  });
});
