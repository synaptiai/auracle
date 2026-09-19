/**
 * DEC-51: a console send waits for a hold period, and an undo inside it
 * returns the run to approval and removes every effect of the approval.
 *
 * The cases are about two things a console send must guarantee: nothing is
 * sent while the window is open, and an undo that reports success means the
 * customer received nothing. Both are proved against a real ledger and a real
 * relay scan, because both are races between two processes.
 */
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { HelpdeskAdapter } from '../adapters/helpdesk.js';
import { CUSTOMER_REPLY_ACTION_CLASS } from '../adapters/types.js';
import type { EgressAdapter, LedgerReply, DeliveryState } from '../adapters/types.js';
import { coordinateTicket } from '../coordinator/coordinator.js';
import type { CoordinatorDeps } from '../coordinator/coordinator.js';
import { enqueueTicket } from '../coordinator/intake.js';
import { dbUrl } from '../db/config.js';
import { FakeProvider } from '../models/fake.js';
import type { FakeStep } from '../models/fake.js';
import type { AdapterCapabilities } from '../policy/policy.js';
import { relayOne, relayPending } from '../relay/relay.js';
import { indexDocument } from '../retriever/retriever.js';
import { truncateLedger } from '../test-support/schema.js';

import { approveRun } from './approve.js';
import { readApprovalHold, undoApproval } from './undo.js';

const pool = new Pool({ connectionString: dbUrl(), max: 8 });

afterAll(async () => {
  await pool.end();
});

await pool.query('SELECT 1');

const PINS = { promptVer: 'undo-prompt', modelVer: 'undo-model' };
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

/** The period a console send waits, in the cases that are not about time. */
const HOLD_MS = 60_000;

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

async function parkOnTurnOne(ticketId: string): Promise<{
  runId: string;
  conversationId: string;
  draftExternalId: string;
  helpdesk: HelpdeskAdapter;
}> {
  const enqueued = await enqueueTicket(
    pool,
    { ticketId, messageId: `m-1-${ticketId}@example.test`, ticketText: TICKET_TEXT },
    8,
  );
  const helpdesk = helpdeskWith(ticketId);
  const result = await coordinateTicket(makeDeps(helpdesk), {
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
  return {
    runId: result.runId,
    conversationId: enqueued.conversationId,
    draftExternalId: result.draftExternalId!,
    helpdesk,
  };
}

interface OutboxRow {
  idem_key: string;
  status: string;
  not_before: Date | null;
  payload: unknown;
  reply: unknown;
}

async function outboxRow(runId: string): Promise<OutboxRow | undefined> {
  const rows = await pool.query(
    'SELECT idem_key, status, not_before, payload, reply FROM outbox WHERE run_id = $1',
    [runId],
  );
  return rows.rows[0] as OutboxRow | undefined;
}

async function runRow(runId: string): Promise<{
  state: string;
  finished_at: Date | null;
  approved_by: string | null;
  approved_by_source: string | null;
  approval_edit_distance: number | null;
}> {
  const rows = await pool.query(
    'SELECT state, finished_at, approved_by, approved_by_source, approval_edit_distance'
      + ' FROM run WHERE run_id = $1',
    [runId],
  );
  return rows.rows[0] as never;
}

async function approvedReplyText(conversationId: string, turnNumber: number): Promise<string | null> {
  const rows = await pool.query<{ approved_reply_text: string | null }>(
    'SELECT approved_reply_text FROM turn WHERE conversation_id = $1 AND turn_number = $2',
    [conversationId, turnNumber],
  );
  return rows.rows[0]?.approved_reply_text ?? null;
}

/**
 * The adapter the relay scan sends through.
 *
 * The park and the approval use the reference helpdesk, which declares no
 * ledger reply: its parked copy is what sends on that path. A record the
 * ledger holds needs an adapter that declares the capability (DEC-44), so the
 * scan takes this one and records what it was told to send.
 */
class LedgerEgress implements EgressAdapter {
  readonly name = 'ledger-egress';

  readonly capabilities = Object.freeze({
    supportsIdempotencyKey: true,
    supportsReadBack: false,
    supportsDraftState: true,
    supportsStructuredFields: true,
    supportsThreading: true,
    supportsLedgerReply: true,
  });

  readonly sends: LedgerReply[] = [];

  async createDraft(): Promise<{ readonly draftExternalId: string }> {
    throw new Error('the relay never parks drafts; the approval bridge does');
  }

  async sendDraft(): Promise<{ readonly externalId: string }> {
    throw new Error('this adapter sends the reply the ledger holds');
  }

  async sendLedgerReply(reply: LedgerReply): Promise<{ readonly externalId: string }> {
    this.sends.push(reply);
    return { externalId: `egress-${this.sends.length}` };
  }

  async performAction(): Promise<{ readonly externalId: string }> {
    throw new Error('unreachable in these cases');
  }

  async readBack(): Promise<DeliveryState> {
    throw new Error('this adapter declares no read-back');
  }
}

/** One scan, through an adapter that can send a held reply. */
async function scan(egress: LedgerEgress): Promise<string[]> {
  return (await relayPending(pool, egress)).map((result) => result.outcome);
}

beforeEach(async () => {
  await truncateLedger(pool);
  // The retriever's index, so a park can retrieve the document the fake
  // provider's script cites. Without it the coordinator escalates instead of
  // parking, and every case below would be about the wrong thing.
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

describe('DEC-51: a console send waits for a hold period', () => {
  it('stamps the hold on the record, and no scan sends it while it stands', async () => {
    const { runId, conversationId, helpdesk } = await parkOnTurnOne('T-' + randomUUID().slice(0, 8));

    const approval = await approveRun(pool, runId, {
      ledgerReply: true,
      readDraft: helpdesk,
      sendHoldMs: HOLD_MS,
    });
    expect(approval.outcome).toBe('approved');

    const row = await outboxRow(runId);
    expect(row?.status).toBe('pending');
    // The hold is on the record, ahead of the clock the column's default read.
    expect(row?.not_before).toBeInstanceOf(Date);
    expect(row!.not_before!.getTime() - Date.now()).toBeGreaterThan(HOLD_MS / 2);

    // The scan itself does not see it: a held record is not a record to send.
    const egress = new LedgerEgress();
    expect(await scan(egress)).toEqual([]);
    expect(egress.sends).toHaveLength(0);
    // The run is resolved — held, not waiting.
    expect((await runRow(runId)).state).toBe('resolved');
    expect(await approvedReplyText(conversationId, 1)).not.toBeNull();
  });

  it('sends it once the period has passed', async () => {
    const { runId, helpdesk } = await parkOnTurnOne('T-' + randomUUID().slice(0, 8));
    await approveRun(pool, runId, { ledgerReply: true, readDraft: helpdesk, sendHoldMs: HOLD_MS });

    // Time passing, without waiting for it: the hold is a moment on the row.
    await pool.query(
      "UPDATE outbox SET not_before = clock_timestamp() - interval '1 second' WHERE run_id = $1",
      [runId],
    );

    const egress = new LedgerEgress();
    expect(await scan(egress)).toEqual(['sent']);
    expect(egress.sends).toHaveLength(1);
    expect((await outboxRow(runId))?.status).toBe('sent');
  });

  // The command line is not the batch. An operator approving one run by hand
  // has no undo to offer, so nothing is held.
  it('holds nothing when the caller names no period', async () => {
    const { runId, helpdesk } = await parkOnTurnOne('T-' + randomUUID().slice(0, 8));
    await approveRun(pool, runId, { ledgerReply: true, readDraft: helpdesk });

    expect((await outboxRow(runId))?.not_before).toBeNull();
    expect(await scan(new LedgerEgress())).toEqual(['sent']);
  });

  // DEC-51: a reply on the DEC-40 draft path gets no hold and no undo, because
  // its helpdesk draft can be sent by hand at any moment. No undo could
  // promise that nothing was sent.
  it('holds nothing on the draft path, whatever the caller names', async () => {
    const { runId, helpdesk } = await parkOnTurnOne('T-' + randomUUID().slice(0, 8));
    await approveRun(pool, runId, { readDraft: helpdesk, sendHoldMs: HOLD_MS });

    expect((await outboxRow(runId))?.not_before).toBeNull();
  });

  // T-4: the moment is the period the caller named, measured from the
  // ledger's own clock. A lower bound alone passes a hold that is a hundred
  // times too long, and one stamped from the console's host clock.
  it('stamps the moment the caller named, and no further', async () => {
    const { runId, helpdesk } = await parkOnTurnOne('T-' + randomUUID().slice(0, 8));
    const before = await pool.query('SELECT clock_timestamp() AS now');
    await approveRun(pool, runId, { ledgerReply: true, readDraft: helpdesk, sendHoldMs: HOLD_MS });

    const row = await outboxRow(runId);
    const left = row!.not_before!.getTime() - new Date(before.rows[0].now).getTime();
    expect(left).toBeGreaterThan(HOLD_MS - 2_000);
    // And not a millisecond past it: a hold stamped from a host clock ahead
    // of the ledger's would be one the relay reads as longer than it is.
    expect(left).toBeLessThanOrEqual(HOLD_MS + 2_000);
  });
});

/**
 * What a page reads to draw a window (DEC-51).
 *
 * The three answers a page draws differently: a record still held, one whose
 * window has gone, and one the relay has sent. A read that ignored the status
 * would call a sent record held, and a page counting it down would promise a
 * way back that is not there.
 */
describe('DEC-51: the window a page reads', () => {
  it('answers held, sent and no-record, each with its own status', async () => {
    const { runId, helpdesk } = await parkOnTurnOne('T-' + randomUUID().slice(0, 8));
    await approveRun(pool, runId, { ledgerReply: true, readDraft: helpdesk, sendHoldMs: HOLD_MS });

    const held = await readApprovalHold(pool, runId);
    expect(held).toMatchObject({ held: true, status: 'pending' });
    // The window is what is left, not the period that was set.
    expect(held!.remainingMs).toBeGreaterThan(0);
    expect(held!.remainingMs).toBeLessThanOrEqual(HOLD_MS);

    // The window has gone: the record is still pending, so the relay may
    // send it at any moment, and no window is left to count.
    await pool.query(
      "UPDATE outbox SET not_before = clock_timestamp() - interval '1 second' WHERE run_id = $1",
      [runId],
    );
    expect(await readApprovalHold(pool, runId))
      .toEqual({ held: false, remainingMs: 0, status: 'pending' });

    // Sent. Not held, and not a window either.
    await pool.query("UPDATE outbox SET status = 'sent' WHERE run_id = $1", [runId]);
    expect(await readApprovalHold(pool, runId))
      .toEqual({ held: false, remainingMs: 0, status: 'sent' });

    // Escalated while its moment was still ahead, which is what the fence
    // stopping a held record does (DEC-30). The moment is in the future and
    // the record is not pending: a read that tested the moment alone would
    // report a window, and the case page would offer a way back on a record
    // the ledger has already escalated.
    await pool.query(
      "UPDATE outbox SET status = 'fenced', not_before = clock_timestamp() + interval '1 minute'"
        + ' WHERE run_id = $1',
      [runId],
    );
    expect(await readApprovalHold(pool, runId))
      .toEqual({ held: false, remainingMs: 0, status: 'fenced' });

    // A run the ledger does not hold at all: its own answer, because a page
    // that drew "not held" would be stating a fact nobody established.
    expect(await readApprovalHold(pool, randomUUID())).toBeNull();
  });

  // The draft path holds nothing, so a page reads no window there.
  it('answers not held for a record with no hold, whatever else it holds', async () => {
    const { runId, helpdesk } = await parkOnTurnOne('T-' + randomUUID().slice(0, 8));
    await approveRun(pool, runId, { ledgerReply: true, readDraft: helpdesk });

    expect(await readApprovalHold(pool, runId))
      .toEqual({ held: false, remainingMs: 0, status: 'pending' });
  });
});

describe('DEC-51: the undo', () => {
  it('returns the run to approval and removes every effect of the approval', async () => {
    const { runId, conversationId, helpdesk } = await parkOnTurnOne('T-' + randomUUID().slice(0, 8));
    await approveRun(pool, runId, { ledgerReply: true, readDraft: helpdesk, sendHoldMs: HOLD_MS });
    expect((await runRow(runId)).state).toBe('resolved');
    expect(await approvedReplyText(conversationId, 1)).not.toBeNull();

    const undone = await undoApproval(pool, runId, { reviewer: 'synthetic-reviewer@example.test' });

    expect(undone.outcome).toBe('undone');
    const run = await runRow(runId);
    expect(run.state).toBe('awaiting_approval');
    expect(run.finished_at).toBeNull();
    expect(run.approved_by).toBeNull();
    expect(run.approved_by_source).toBeNull();
    expect(run.approval_edit_distance).toBeNull();
    expect(await approvedReplyText(conversationId, 1)).toBeNull();
    // The row is gone, so its key is free: nothing of the approval remains.
    expect(await outboxRow(runId)).toBeUndefined();
    // The journal names the person. The case page draws its timeline from
    // that table, and an undo with no row would leave a case that came back
    // to the queue with nothing saying who brought it back.
    const journal = await pool.query(
      "SELECT status, result FROM step_journal WHERE run_id = $1 AND step_id = 'undo'",
      [runId],
    );
    expect(journal.rows).toEqual([
      { status: 'done', result: { reviewer: 'synthetic-reviewer@example.test' } },
    ]);
  });

  // The reviewer who changes their mind twice. The journal has one row per
  // step, so the second undo has to replace the first rather than insert
  // beside it: an insert raises on the primary key and rolls the whole undo
  // back, which is the one way this function could refuse a send it can
  // still take back.
  it('undoes a case that was confirmed and undone once already', async () => {
    const { runId, helpdesk } = await parkOnTurnOne('T-' + randomUUID().slice(0, 8));
    const first = 'synthetic-first@example.test';
    const second = 'synthetic-second@example.test';

    await approveRun(pool, runId, { ledgerReply: true, readDraft: helpdesk, sendHoldMs: HOLD_MS });
    expect(await undoApproval(pool, runId, { reviewer: first })).toEqual({ outcome: 'undone' });
    await approveRun(pool, runId, { ledgerReply: true, readDraft: helpdesk, sendHoldMs: HOLD_MS });

    expect(await undoApproval(pool, runId, { reviewer: second })).toEqual({ outcome: 'undone' });
    const journal = await pool.query(
      "SELECT result FROM step_journal WHERE run_id = $1 AND step_id = 'undo'",
      [runId],
    );
    // One row, and it names the person who undid it last.
    expect(journal.rows).toEqual([{ result: { reviewer: second } }]);
    expect((await runRow(runId)).state).toBe('awaiting_approval');
  });

  // One turn can be served by more than one run, and each approval writes the
  // turn's approved text. Two approvals of one action derive one DEC-24 key
  // today, so the second answers `superseded` and the state below cannot be
  // reached through the console yet. It becomes reachable when an attempt
  // enters the key, which is why the undo carries the guard: it clears the
  // column only where the text is its own record's.
  //
  // The state is built here rather than driven, because that is what the
  // guard is: a statement about which rows a write may touch, tested at the
  // row it protects.
  it("leaves the turn's text alone when another approval wrote it", async () => {
    const { runId, conversationId, helpdesk } = await parkOnTurnOne('T-' + randomUUID().slice(0, 8));
    await approveRun(pool, runId, { ledgerReply: true, readDraft: helpdesk, sendHoldMs: HOLD_MS });
    const mine = await approvedReplyText(conversationId, 1);
    expect(mine).not.toBeNull();

    // A later approval of another run on this turn: the record's text is one
    // thing, what the turn now holds is another.
    const theirs = 'A second run served this turn, and this is the text it approved.';
    await pool.query(
      'UPDATE turn SET approved_reply_text = $2 WHERE conversation_id = $1 AND turn_number = 1',
      [conversationId, theirs],
    );

    expect(await undoApproval(pool, runId, { reviewer: 'synthetic-reviewer@example.test' }))
      .toEqual({ outcome: 'undone' });

    // The undo took its own effects back and left the other approval's record
    // standing. Without the guard this reads null: the record of a reply a
    // customer received, gone, and the agent half of the next turn's prompt
    // with it (DEC-37).
    expect(await approvedReplyText(conversationId, 1)).toBe(theirs);
    expect((await outboxRow(runId))).toBeUndefined();
  });

  // ERR-6: the arm that waits for another writer. The console's patience is
  // five seconds, so this case holds the row past it and asserts both the
  // answer and that nothing was touched.
  it('answers busy when another writer holds the row, and changes nothing', async () => {
    const { runId, conversationId, helpdesk } = await parkOnTurnOne('T-' + randomUUID().slice(0, 8));
    await approveRun(pool, runId, { ledgerReply: true, readDraft: helpdesk, sendHoldMs: HOLD_MS });

    // A second session takes the outbox row's lock and keeps it, as the relay
    // does across its send.
    const other = await pool.connect();
    try {
      await other.query('BEGIN');
      await other.query('SELECT status FROM outbox WHERE run_id = $1 FOR UPDATE', [runId]);

      const started = Date.now();
      expect(await undoApproval(pool, runId, { reviewer: 'synthetic-reviewer@example.test' }))
        .toEqual({ outcome: 'busy' });
      // It waited for the lock rather than answering `busy` for any reason.
      expect(Date.now() - started).toBeGreaterThan(1_000);
    } finally {
      await other.query('ROLLBACK');
      other.release();
    }

    // Nothing was undone: the approval stands, and the record is still there.
    expect((await runRow(runId)).state).toBe('resolved');
    expect(await approvedReplyText(conversationId, 1)).not.toBeNull();
    expect(await outboxRow(runId)).toBeDefined();
    // And the pool is usable afterwards: a connection released with its
    // transaction state unread would poison the next borrower.
    expect(await readApprovalHold(pool, runId)).toMatchObject({ held: true });
  });

  // A record that never had a hold. `sendHoldMs: 0` is a decision to send at
  // once and still writes a moment, so the case is an approval that named no
  // period at all — a command-line one, or an approval written by a process
  // that predates DEC-51. There is no window to be inside, so the undo
  // refuses rather than deleting a record the relay may send this instant.
  it('refuses a record that never had a hold, rather than undoing it', async () => {
    const { runId, conversationId, helpdesk } = await parkOnTurnOne('T-' + randomUUID().slice(0, 8));
    await approveRun(pool, runId, { ledgerReply: true, readDraft: helpdesk });
    expect((await outboxRow(runId))?.not_before).toBeNull();

    expect(await undoApproval(pool, runId, { reviewer: 'synthetic-reviewer@example.test' }))
      .toEqual({ outcome: 'window_passed' });
    // Nothing was reversed on the way to that answer.
    expect((await runRow(runId)).state).toBe('resolved');
    expect(await approvedReplyText(conversationId, 1)).not.toBeNull();
    expect(await outboxRow(runId)).toBeDefined();
  });

  it('sends nothing, and the approval that follows sends one reply', async () => {
    const { runId, conversationId, helpdesk } = await parkOnTurnOne('T-' + randomUUID().slice(0, 8));
    await approveRun(pool, runId, { ledgerReply: true, readDraft: helpdesk, sendHoldMs: HOLD_MS });

    const egress = new LedgerEgress();
    await undoApproval(pool, runId, { reviewer: 'synthetic-reviewer@example.test' });
    expect(await scan(egress)).toEqual([]);
    expect(egress.sends).toHaveLength(0);

    // Confirming again sends each reply once: the second approval takes the
    // key the undo released, and no earlier attempt is in flight.
    await approveRun(pool, runId, { ledgerReply: true, readDraft: helpdesk, sendHoldMs: 0 });
    expect(await scan(egress)).toEqual(['sent']);
    expect(egress.sends).toHaveLength(1);
    expect(await approvedReplyText(conversationId, 1)).not.toBeNull();
  });

  // The window is the hold period. Outside it the relay may send at any
  // moment, so an undo that claimed success would be a promise nobody kept.
  it('refuses once the window has passed', async () => {
    const { runId, helpdesk } = await parkOnTurnOne('T-' + randomUUID().slice(0, 8));
    await approveRun(pool, runId, { ledgerReply: true, readDraft: helpdesk, sendHoldMs: HOLD_MS });
    await pool.query(
      "UPDATE outbox SET not_before = clock_timestamp() - interval '1 second' WHERE run_id = $1",
      [runId],
    );

    expect(await undoApproval(pool, runId, { reviewer: 'synthetic-reviewer@example.test' }))
      .toEqual({ outcome: 'window_passed' });
    expect((await runRow(runId)).state).toBe('resolved');
    expect(await outboxRow(runId)).toBeDefined();
  });

  it('refuses once the relay has sent the record', async () => {
    const { runId, helpdesk } = await parkOnTurnOne('T-' + randomUUID().slice(0, 8));
    await approveRun(pool, runId, { ledgerReply: true, readDraft: helpdesk, sendHoldMs: 0 });
    expect(await scan(new LedgerEgress())).toEqual(['sent']);

    expect(await undoApproval(pool, runId, { reviewer: 'synthetic-reviewer@example.test' }))
      .toEqual({ outcome: 'already_sent' });
    expect((await outboxRow(runId))?.status).toBe('sent');
  });

  it('refuses a case that has no approval to undo', async () => {
    const { runId } = await parkOnTurnOne('T-' + randomUUID().slice(0, 8));

    expect(await undoApproval(pool, runId, { reviewer: 'synthetic-reviewer@example.test' }))
      .toEqual({ outcome: 'nothing_to_undo' });
    expect(await undoApproval(pool, randomUUID(), { reviewer: 'synthetic-reviewer@example.test' }))
      .toEqual({ outcome: 'unknown_run' });
  });

  // The guarantee, and the reason the relay takes the run's row lock across
  // its send. An undo that arrived while the send was in flight must not
  // report success: the customer has the reply.
  it('refuses while a send holds the row, and reports it once the send lands', async () => {
    const { runId, helpdesk } = await parkOnTurnOne('T-' + randomUUID().slice(0, 8));
    await approveRun(pool, runId, { ledgerReply: true, readDraft: helpdesk, sendHoldMs: 0 });

    // A send that blocks halfway: the far side is reached, the status is not
    // yet written, and the run's row is locked for the whole of it.
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const egress = new LedgerEgress();
    const original = egress.sendLedgerReply.bind(egress);
    egress.sendLedgerReply = async (reply: LedgerReply): Promise<{ readonly externalId: string }> => {
      const sent = await original(reply);
      await blocked;
      return sent;
    };

    const scanning = relayPending(pool, egress);
    await new Promise((resolve) => setTimeout(resolve, 150));

    // The undo begins while the send is in flight. It waits on the lock, and
    // it refuses: by the time it reads the record, the send has landed.
    const undone = undoApproval(pool, runId, { reviewer: 'synthetic-reviewer@example.test' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    release();

    expect((await scanning).map((result) => result.outcome)).toEqual(['sent']);
    expect(await undone).toEqual({ outcome: 'already_sent' });
    expect(egress.sends).toHaveLength(1);
    expect((await runRow(runId)).state).toBe('resolved');
  });

  // A scan reads its rows, then walks up to one. If an undo removes the row
  // in between, the send re-reads it under the lock and sends nothing.
  it('sends nothing for a record removed between the scan and the send', async () => {
    const { runId, helpdesk } = await parkOnTurnOne('T-' + randomUUID().slice(0, 8));
    await approveRun(pool, runId, { ledgerReply: true, readDraft: helpdesk, sendHoldMs: HOLD_MS });

    const row = await outboxRow(runId);
    const scanned = {
      run_id: runId,
      step_id: 'approve',
      ticket_id: 'T-scanned',
      idem_key: row!.idem_key,
      epoch: '1',
      delivery: 'at_least_once',
      action_class: 'customer_reply',
      payload: row!.payload,
      reply: row!.reply,
      not_before: row!.not_before,
    };
    await undoApproval(pool, runId, { reviewer: 'synthetic-reviewer@example.test' });

    const egress = new LedgerEgress();
    expect(await relayOne(pool, egress, scanned)).toEqual({ idemKey: row!.idem_key, outcome: 'undone' });
    expect(egress.sends).toHaveLength(0);
  });

  // The clock is read after the lock, not at transaction start. `now()` is
  // fixed when the transaction begins, so an undo that waited on the relay's
  // lock would recheck the window with the time it waited from — and delete a
  // row whose hold ended while it waited.
  it('reads the window after it holds the lock, not when it began', async () => {
    const { runId, helpdesk } = await parkOnTurnOne('T-' + randomUUID().slice(0, 8));
    await approveRun(pool, runId, { ledgerReply: true, readDraft: helpdesk, sendHoldMs: 400 });
    await pool.query(
      'UPDATE outbox SET not_before = clock_timestamp() + interval \'300 milliseconds\''
        + ' WHERE run_id = $1',
      [runId],
    );

    // Another writer holds the run: the undo begins now and blocks.
    const holder = await pool.connect();
    let undone;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT run_id FROM run WHERE run_id = $1 FOR UPDATE', [runId]);

      undone = undoApproval(pool, runId, { reviewer: 'synthetic-reviewer@example.test' });
      // Long enough for the hold to end while the undo waits for the lock.
      await new Promise((resolve) => setTimeout(resolve, 500));
      await holder.query('COMMIT');

      expect(await undone).toEqual({ outcome: 'window_passed' });
    } finally {
      holder.release();
    }
    expect((await runRow(runId)).state).toBe('resolved');
    expect(await outboxRow(runId)).toBeDefined();
  });
});
