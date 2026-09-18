// End-to-end suite for the approval completion path (DEC-12) against the
// compose Postgres: gated -> parked draft -> approve -> relay sends.
//
// The coordinator runs with a FakeProvider and a real ledger; the helpdesk
// is the fixture-backed reference adapter; every approval runs through the
// same transactional entrypoint an operator or helpdesk webhook would call.
// Synthetic data only (DEC-18).
import { randomUUID } from 'node:crypto';

import { truncateLedger } from '../test-support/schema.js';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { claimPartition, conversationHistory } from '../coordinator/consumer.js';
import { coordinateTicket } from '../coordinator/coordinator.js';
import type { CoordinatorDeps } from '../coordinator/coordinator.js';
import { enqueueTicket } from '../coordinator/intake.js';
import { HelpdeskAdapter } from '../adapters/helpdesk.js';
import { dbUrl } from '../db/config.js';
import { deriveIdemKey } from '../ledger/keys.js';
import { FakeProvider } from '../models/fake.js';
import type { FakeStep } from '../models/fake.js';
import type { AdapterCapabilities } from '../policy/policy.js';
// The relay routes this one action class through the draft path.
import { COMPENSATION_ACTION_CLASS, CUSTOMER_REPLY_ACTION_CLASS } from '../adapters/types.js';
import { relayPending } from '../relay/relay.js';
import { indexDocument } from '../retriever/retriever.js';

import { readRun } from '../escalations/query.js';
import { approveRun } from './approve.js';
import { holdHistory, readHold, takeHold } from '../holds/hold.js';
import { replyDigest } from './shown.js';
import { approvalEditDistance } from './edit_distance.js';

const pool = new Pool({ connectionString: dbUrl(), max: 10 });

// src/test-support/db-global-setup.ts guarantees a reachable database before
// the workers fork: it starts a container, or probes an explicit
// DATABASE_URL and fails the run. A failure here is therefore a fault, and
// a suite that skipped itself instead would report success while proving
// nothing.
await pool.query('SELECT 1');


const PINS = { promptVer: 'approval-test-prompt', modelVer: 'approval-test-model' };
const CAPABILITIES: AdapterCapabilities = {
  supportsIdempotencyKey: true,
  supportsReadBack: true,
  supportsDraftState: true,
  supportsStructuredFields: true,
  supportsThreading: true,
};
const DIM = 1536;
const TICKET_TEXT = 'I cannot sign in to my account. How do I reset my password?';
const DISCLOSURE = 'This reply was drafted by an automated assistant and approved by a person.';

// Seeded PRNG so every run uses identical synthetic vectors (DEC-18).
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function unitVector(seed: number): number[] {
  const rand = mulberry32(seed);
  const v = Array.from({ length: DIM }, () => rand() * 2 - 1);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

const VEC = unitVector(42);

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
    taxonomy: {
      intents: [
        { id: 'password_reset', label: 'Password reset', risk_tier: 'low' },
      ],
    },
    capabilities: CAPABILITIES,
    egress,
    pins: PINS,
    limits: {
      maxCostMicros: 100_000_000,
      maxSteps: 50,
      deadlineAt: new Date(Date.now() + 60_000),
    },
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

async function parkReply(ticketId: string): Promise<{
  runId: string;
  draftExternalId: string;
  helpdesk: HelpdeskAdapter;
}> {
  const helpdesk = helpdeskWith(ticketId);
  const result = await coordinateTicket(makeDeps(helpdesk), {
    ticketId,
    ticketText: TICKET_TEXT,
    epoch: 1n,
    actionClass: CUSTOMER_REPLY_ACTION_CLASS,
    actionPayload: { summary: 'password reset answer' },
    delivery: 'at_least_once',
    isCustomerVisible: true,
    disclosure: DISCLOSURE,
  });
  if (result.outcome !== 'awaiting_approval') {
    throw new Error(`expected awaiting_approval, got ${result.outcome}`);
  }
  return { runId: result.runId, draftExternalId: result.draftExternalId!, helpdesk };
}

async function runState(runId: string): Promise<string | undefined> {
  const rows = await pool.query('SELECT state FROM run WHERE run_id = $1', [runId]);
  return rows.rows[0]?.state as string | undefined;
}

/** The reply text the ledger holds for a parked run (the console's draft). */
async function parkedBody(runId: string): Promise<string> {
  const rows = await pool.query(
    "SELECT result->>'body' AS body FROM step_journal WHERE run_id = $1 AND step_id = 'park'",
    [runId],
  );
  return rows.rows[0]!.body as string;
}

async function outboxRows(runId: string): Promise<
  { idem_key: string; epoch: string; action_class: string; delivery: string; status: string; payload: unknown }[]
> {
  const rows = await pool.query(
    `SELECT idem_key, epoch::text AS epoch, action_class, delivery, status, payload
     FROM outbox WHERE run_id = $1`,
    [runId],
  );
  return rows.rows as { idem_key: string; epoch: string; action_class: string; delivery: string; status: string; payload: unknown }[];
}

/** Opens a conversation and parks a reply on its first turn. */
async function parkReplyOnTurnOne(
  ticketId: string,
  actionClass: string,
  isCustomerVisible: boolean,
): Promise<{
  runId: string;
  conversationId: string;
  draftExternalId: string | null;
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
    actionClass,
    actionPayload: isCustomerVisible
      ? { summary: 'password reset answer' }
      : { reason: 'refund sent to the wrong account' },
    delivery: isCustomerVisible ? 'at_least_once' : 'at_most_once',
    isCustomerVisible,
    disclosure: DISCLOSURE,
  });
  if (result.outcome !== 'awaiting_approval') {
    throw new Error(`expected awaiting_approval, got ${result.outcome}`);
  }
  return {
    runId: result.runId,
    conversationId: enqueued.conversationId,
    draftExternalId: result.draftExternalId,
    helpdesk,
  };
}

async function approvedReplyOn(
  conversationId: string,
  turnNumber: number,
): Promise<string | null> {
  const rows = await pool.query<{ approved_reply_text: string | null }>(
    'SELECT approved_reply_text FROM turn WHERE conversation_id = $1 AND turn_number = $2',
    [conversationId, turnNumber],
  );
  return rows.rows[0]?.approved_reply_text ?? null;
}

describe('approval completion path (DEC-12 end to end)', () => {
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

  afterEach(async () => {
    await truncateLedger(pool);
  });

  it('runs gated -> parked draft -> approve -> relay send end to end', async () => {
    const ticketId = 'T-' + randomUUID().slice(0, 8);
    const { runId, draftExternalId, helpdesk } = await parkReply(ticketId);

    // Before approval nothing is relayable: the run waits, the outbox is empty.
    expect(await runState(runId)).toBe('awaiting_approval');
    expect(await relayPending(pool, helpdesk)).toEqual([]);

    const approval = await approveRun(pool, runId);
    expect(approval.outcome).toBe('approved');

    // DEC-42. Recorded on every approval, and this is the console's own call:
    // no final body, so no edit distance. An adopter reading the ledger meets
    // that pair, and a test asserting the two always travel together would be
    // asserting something the system does not do.
    const approver = await pool.query(
      'SELECT approved_by, approval_edit_distance FROM run WHERE run_id = $1',
      [runId],
    );
    expect(approver.rows[0]?.approved_by).toBe('unattributed');
    expect(approver.rows[0]?.approval_edit_distance).toBeNull();

    const idemKey = deriveIdemKey({
      actionClass: CUSTOMER_REPLY_ACTION_CLASS,
      ticketId,
      payload: { draftExternalId },
    });
    expect(approval).toEqual({ outcome: 'approved', idemKey });
    expect(await runState(runId)).toBe('resolved');

    const rows = await outboxRows(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      idem_key: idemKey,
      epoch: '1', // DEC-28: the record carries the run's fencing epoch
      delivery: 'at_least_once', // DEC-29: the rule from the action class
      status: 'pending',
      payload: { draftExternalId },
    });

    // The relay sends the approved draft through the same adapter.
    expect(await relayPending(pool, helpdesk)).toEqual([
      { idemKey, outcome: 'sent' },
    ]);
    const sentRows = await outboxRows(runId);
    expect(sentRows[0]).toMatchObject({ status: 'sent' });
    expect(helpdesk.getDraft(draftExternalId)?.status).toBe('sent');
    expect(helpdesk.listDeliveries()).toHaveLength(1);

    // A repeat pass sends nothing more: the key dedupes (DEC-24).
    expect(await relayPending(pool, helpdesk)).toEqual([]);
    expect(helpdesk.listDeliveries()).toHaveLength(1);

    // A second approve call loses the state race under the lock.
    expect(await approveRun(pool, runId)).toEqual({
      outcome: 'not_awaiting_approval',
      state: 'resolved',
    });
    expect(await outboxRows(runId)).toHaveLength(1);
  });

  // Issue #113, criterion 4: the record an approval writes before a
  // deployment restart is sent after it, exactly once. The restart leaves
  // the ticket's fence alone (the run has finished), and the record's DEC-24
  // key is what makes the single send provable.
  it('sends an approved record after a consumer restart, exactly once', async () => {
    const ticketId = 'T-' + randomUUID().slice(0, 8);
    const { runId, draftExternalId, helpdesk } = await parkReply(ticketId);
    const { rows } = await pool.query('SELECT partition FROM run WHERE run_id = $1', [runId]);

    const idemKey = deriveIdemKey({
      actionClass: CUSTOMER_REPLY_ACTION_CLASS,
      ticketId,
      conversationId: null,
      payload: { draftExternalId },
    });
    expect(await approveRun(pool, runId)).toEqual({ outcome: 'approved', idemKey });
    expect(await outboxRows(runId)).toMatchObject([{ status: 'pending' }]);

    // The deployment restarts: the claim runs, and finds no in-flight run.
    await claimPartition(pool, rows[0]!.partition as number);

    expect(await relayPending(pool, helpdesk)).toEqual([{ idemKey, outcome: 'sent' }]);
    expect(helpdesk.listDeliveries()).toHaveLength(1);
    expect(await outboxRows(runId)).toMatchObject([{ status: 'sent' }]);

    // The restart changed nothing about the record: a second scan sends none.
    expect(await relayPending(pool, helpdesk)).toEqual([]);
    expect(helpdesk.listDeliveries()).toHaveLength(1);
  });

  // Issue #113, criterion 3: a later run on the same ticket takes a higher
  // epoch, and the reply parked before it must not wait forever. It stays
  // approvable — the branch this case pins — and its record keeps its own
  // epoch, which is what the relay reads.
  it('approves a reply parked before a later run starts on its ticket', async () => {
    const ticketId = 'T-' + randomUUID().slice(0, 8);
    const parked = await parkReplyOnTurnOne(ticketId, CUSTOMER_REPLY_ACTION_CLASS, true);

    // The customer writes again. The follow-up is its own turn, so it parks
    // its own draft at the ticket's next epoch.
    const followUp = await enqueueTicket(
      pool,
      { ticketId, messageId: `m-2-${ticketId}@example.test`, ticketText: 'It still fails.' },
      8,
    );
    const later = await coordinateTicket(makeDeps(helpdeskWith(ticketId)), {
      ticketId,
      ticketText: 'It still fails.',
      epoch: 2n,
      conversationId: followUp.conversationId,
      turnNumber: followUp.turnNumber,
      actionClass: CUSTOMER_REPLY_ACTION_CLASS,
      actionPayload: { summary: 'the second answer' },
      delivery: 'at_least_once',
      isCustomerVisible: true,
      disclosure: DISCLOSURE,
    });
    expect(later.outcome).toBe('awaiting_approval');
    const fence = await pool.query(
      'SELECT epoch::text AS epoch FROM ticket_epoch WHERE ticket_id = $1',
      [ticketId],
    );
    expect(fence.rows[0]?.epoch).toBe('2');

    // The first reply still commits, and its record keeps the first epoch.
    expect(await approveRun(pool, parked.runId)).toMatchObject({ outcome: 'approved' });
    expect(await runState(parked.runId)).toBe('resolved');
    const outbox = await outboxRows(parked.runId);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ epoch: '1', status: 'pending' });

    // The later reply waits its own turn out: its run is untouched, and it
    // has no record until a person approves it.
    expect(await runState(later.runId)).toBe('awaiting_approval');
    expect(await outboxRows(later.runId)).toHaveLength(0);
  });

  it('reads the edited draft back and records the true distance (section 4.10)', async () => {
    const ticketId = 'T-' + randomUUID().slice(0, 8);
    const { runId, draftExternalId, helpdesk } = await parkReply(ticketId);
    const parkedBody = helpdesk.getDraft(draftExternalId)!.body;

    // A person edits the draft in the helpdesk, then approves with
    // read-back: the distance must measure the parked body against the
    // edited body, not against a hand-copied string.
    const editedBody = parkedBody + ' The link stays valid for one hour.';
    await helpdesk.editDraft(draftExternalId, editedBody);

    const approval = await approveRun(pool, runId, { readDraft: helpdesk });
    expect(approval.outcome).toBe('approved');
    expect(await runState(runId)).toBe('resolved');

    const rows = await pool.query(
      'SELECT approval_edit_distance FROM run WHERE run_id = $1',
      [runId],
    );
    expect(rows.rows[0]!.approval_edit_distance).toBe(
      approvalEditDistance(parkedBody, editedBody),
    );
  });

  it('records a distance of exactly 0 when read-back finds no edit', async () => {
    const ticketId = 'T-' + randomUUID().slice(0, 8);
    const { runId, helpdesk } = await parkReply(ticketId);

    const approval = await approveRun(pool, runId, { readDraft: helpdesk });
    expect(approval.outcome).toBe('approved');

    const rows = await pool.query(
      'SELECT approval_edit_distance FROM run WHERE run_id = $1',
      [runId],
    );
    expect(rows.rows[0]!.approval_edit_distance).toBe(0);
  });

  it('refuses the approval when read-back finds no draft, and nothing commits', async () => {
    const ticketId = 'T-' + randomUUID().slice(0, 8);
    const { runId, draftExternalId } = await parkReply(ticketId);

    // A fresh adapter holds no parked draft: read-back cannot find what
    // the person would have edited. Approving anyway would fabricate the
    // distance, so the call refuses before any write.
    const refusal = await approveRun(pool, runId, { readDraft: new HelpdeskAdapter() });
    expect(refusal).toEqual({ outcome: 'draft_missing', draftExternalId });
    expect(await runState(runId)).toBe('awaiting_approval');
    expect(await outboxRows(runId)).toEqual([]);
    const rows = await pool.query(
      'SELECT approval_edit_distance FROM run WHERE run_id = $1',
      [runId],
    );
    expect(rows.rows[0]!.approval_edit_distance).toBeNull();

    // The refusal blocks nothing: the operator reconciles by hand and the
    // manual approval path still works.
    expect(await approveRun(pool, runId)).toMatchObject({ outcome: 'approved' });
  });

  // A read that fails is not a missing draft, and the console reports it as
  // its own outcome. That rests on the read running before the transaction:
  // the fault reaches the caller unchanged, and nothing commits.
  // The console checks an approval's outcome against this flag: an approval
  // records an approver on every path, and nothing else does (DEC-42).
  it('reads a run as approved once an approval records its approver, and not before', async () => {
    const ticketId = 'T-' + randomUUID().slice(0, 8);
    const { runId } = await parkReply(ticketId);
    expect((await readRun(pool, runId))?.approved).toBe(false);
    expect(await approveRun(pool, runId)).toMatchObject({ outcome: 'approved' });
    expect((await readRun(pool, runId))?.approved).toBe(true);
  });

  it('lets a read-back fault through unchanged, and nothing commits', async () => {
    const ticketId = 'T-' + randomUUID().slice(0, 8);
    const { runId } = await parkReply(ticketId);
    const fault = new Error('the helpdesk did not answer');
    await expect(approveRun(pool, runId, {
      readDraft: { readDraft: async () => { throw fault; } },
    })).rejects.toBe(fault);
    expect(await runState(runId)).toBe('awaiting_approval');
    expect(await outboxRows(runId)).toEqual([]);
    const rows = await pool.query(
      'SELECT approval_edit_distance, approved_by FROM run WHERE run_id = $1',
      [runId],
    );
    expect(rows.rows[0]).toEqual({ approval_edit_distance: null, approved_by: null });
  });

  it('lets an explicit final body win over read-back', async () => {
    const ticketId = 'T-' + randomUUID().slice(0, 8);
    const { runId, draftExternalId, helpdesk } = await parkReply(ticketId);
    const parkedBody = helpdesk.getDraft(draftExternalId)!.body;

    // The adapter holds an edit, but the caller captured an explicit body;
    // the explicit capture is authoritative.
    await helpdesk.editDraft(draftExternalId, parkedBody + ' Edited in the helpdesk.');
    const explicitBody = parkedBody + ' Captured explicitly.';

    const approval = await approveRun(pool, runId, {
      finalBody: explicitBody,
      readDraft: helpdesk,
    });
    expect(approval.outcome).toBe('approved');

    const rows = await pool.query(
      'SELECT approval_edit_distance FROM run WHERE run_id = $1',
      [runId],
    );
    expect(rows.rows[0]!.approval_edit_distance).toBe(
      approvalEditDistance(parkedBody, explicitBody),
    );
  });

  it('reports unknown_run for an id that never existed', async () => {
    expect(await approveRun(pool, randomUUID())).toEqual({ outcome: 'unknown_run' });
  });

  it('runs compensation: ledger-only park -> approve -> performAction end to end', async () => {
    const ticketId = 'T-' + randomUUID().slice(0, 8);
    const helpdesk = helpdeskWith(ticketId);
    const result = await coordinateTicket(makeDeps(helpdesk), {
      ticketId,
      ticketText: TICKET_TEXT,
      epoch: 1n,
      actionClass: COMPENSATION_ACTION_CLASS,
      actionPayload: { reason: 'refund sent to the wrong account' },
      // DEC-29: the class declares at_most_once; the coordinator refuses
      // anything else.
      delivery: 'at_most_once',
      isCustomerVisible: false,
      disclosure: DISCLOSURE,
    });
    if (result.outcome !== 'awaiting_approval') {
      throw new Error(`unexpected ${result.outcome}`);
    }
    const runId = result.runId;

    const approval = await approveRun(pool, runId);
    expect(approval.outcome).toBe('approved');

    const idemKey = deriveIdemKey({
      actionClass: COMPENSATION_ACTION_CLASS,
      ticketId,
      payload: { reason: 'refund sent to the wrong account' },
    });
    expect(await runState(runId)).toBe('resolved');
    const rows = await outboxRows(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      idem_key: idemKey,
      action_class: COMPENSATION_ACTION_CLASS,
      delivery: 'at_most_once', // DEC-29: declared by the action class
      status: 'pending',
      payload: { reason: 'refund sent to the wrong account' },
    });

    // The relay routes the non-reply class through performAction; the
    // adapter records the compensating credit against the ticket.
    expect(await relayPending(pool, helpdesk)).toEqual([
      { idemKey, outcome: 'sent' },
    ]);
    expect(helpdesk.listDeliveries()).toHaveLength(1);

    // A repeat pass sends nothing more (DEC-24): a replayed compensation
    // never pays twice.
    expect(await relayPending(pool, helpdesk)).toEqual([]);
    expect(helpdesk.listDeliveries()).toHaveLength(1);
  });

  it('records the approved reply on the turn it answers, for a later prompt', async () => {
    // DEC-37: history is both halves of the conversation. Without the reply
    // the prompt of turn 2 reads as a monologue, and a threshold fitted on it
    // is fitted on a conversation that never happened.
    const ticketId = 'T-' + randomUUID().slice(0, 8);
    const { runId, conversationId } = await parkReplyOnTurnOne(
      ticketId,
      CUSTOMER_REPLY_ACTION_CLASS,
      true,
    );
    const sentBody = 'Open account settings and choose reset password.';

    expect(await approvedReplyOn(conversationId, 1)).toBeNull();
    expect(await approveRun(pool, runId, { finalBody: sentBody })).toMatchObject({
      outcome: 'approved',
    });
    expect(await approvedReplyOn(conversationId, 1)).toBe(sentBody);

    // The next turn sees the customer's message and the reply that answered
    // it, in that order and both under turn 1.
    await enqueueTicket(
      pool,
      { ticketId, messageId: `m-2-${ticketId}@example.test`, ticketText: 'That worked, thanks.' },
      8,
    );
    expect(await conversationHistory(pool, conversationId, 2)).toEqual([
      { turnNumber: 1, author: 'customer', bodyText: TICKET_TEXT },
      { turnNumber: 1, author: 'agent', bodyText: sentBody },
    ]);
  });

  it('records no reply for a ledger-only compensation park (DEC-34)', async () => {
    // A compensation is an internal write with no customer-visible text.
    // Recording one would show the customer's own history an action they
    // never saw.
    const ticketId = 'T-' + randomUUID().slice(0, 8);
    const { runId, conversationId } = await parkReplyOnTurnOne(
      ticketId,
      COMPENSATION_ACTION_CLASS,
      false,
    );

    expect(await approveRun(pool, runId)).toMatchObject({ outcome: 'approved' });
    expect(await approvedReplyOn(conversationId, 1)).toBeNull();

    await enqueueTicket(
      pool,
      { ticketId, messageId: `m-2-${ticketId}@example.test`, ticketText: 'Any news?' },
      8,
    );
    expect(await conversationHistory(pool, conversationId, 2)).toEqual([
      { turnNumber: 1, author: 'customer', bodyText: TICKET_TEXT },
    ]);
  });

  it('falls back to the parked body when the approval captures no final text', async () => {
    // approveRun without finalBody and without read-back: the person sent
    // the draft as parked, so that body is what the conversation carries.
    const ticketId = 'T-' + randomUUID().slice(0, 8);
    const { runId, conversationId, draftExternalId, helpdesk } = await parkReplyOnTurnOne(
      ticketId,
      CUSTOMER_REPLY_ACTION_CLASS,
      true,
    );
    const parked = helpdesk.getDraft(draftExternalId!)!.body;

    expect(await approveRun(pool, runId)).toMatchObject({ outcome: 'approved' });
    expect(await approvedReplyOn(conversationId, 1)).toBe(parked);
  });

  it('refuses to approve a run that never reached awaiting_approval', async () => {
    const ticketId = 'T-' + randomUUID().slice(0, 8);
    const helpdesk = helpdeskWith(ticketId);
    const result = await coordinateTicket(makeDeps(helpdesk), {
      ticketId,
      ticketText: TICKET_TEXT,
      epoch: 1n,
      actionClass: 'route_ticket',
      actionPayload: { queue: 'password-support' },
      delivery: 'at_most_once',
      isCustomerVisible: false,
      disclosure: DISCLOSURE,
    });
    if (result.outcome !== 'resolved') throw new Error(`unexpected ${result.outcome}`);

    expect(await approveRun(pool, result.runId)).toEqual({
      outcome: 'not_awaiting_approval',
      state: 'resolved',
    });
  });

  // Issue #113, criterion 1: the defect through a real consumer start, not a
  // hand-raised epoch. Every deployment claims its partitions, and a reply
  // parked for a person is not in flight in any consumer — so the claim must
  // leave it approvable. The count the claim returns is asserted in
  // consumer.db.test.ts, beside the tickets it does and does not move.
  it('approves a reply parked before a consumer start (issue #113)', async () => {
    const ticketId = 'T-' + randomUUID().slice(0, 8);
    const { runId, draftExternalId } = await parkReply(ticketId);
    const { rows } = await pool.query('SELECT partition FROM run WHERE run_id = $1', [runId]);

    // The claim finds nothing in flight on this ticket, so it moves no fence.
    expect(await claimPartition(pool, rows[0]!.partition as number)).toBe(0);

    const idemKey = deriveIdemKey({
      actionClass: CUSTOMER_REPLY_ACTION_CLASS,
      ticketId,
      conversationId: null,
      payload: { draftExternalId },
    });
    expect(await approveRun(pool, runId)).toEqual({ outcome: 'approved', idemKey });
    expect(await runState(runId)).toBe('resolved');
    const outbox = await outboxRows(runId);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      idem_key: idemKey,
      epoch: '1',
      status: 'pending',
      action_class: CUSTOMER_REPLY_ACTION_CLASS,
    });
    expect(outbox[0]!.payload).toEqual({ draftExternalId });
  });

  // Issue #113 inverted this case. It pinned the refusal that stranded a
  // reply: a person approving a parked draft has nothing to do with the
  // fence another run raised. The record the approval writes still carries
  // the parked run's own epoch, which is what the relay reads.
  it('approves a parked run when the fencing epoch moved on (DEC-28)', async () => {
    const ticketId = 'T-' + randomUUID().slice(0, 8);
    const { runId, draftExternalId } = await parkReply(ticketId);

    // A rebalance handed the ticket to another owner at a higher epoch.
    await pool.query('UPDATE ticket_epoch SET epoch = $2 WHERE ticket_id = $1', [
      ticketId,
      '50',
    ]);

    const idemKey = deriveIdemKey({
      actionClass: CUSTOMER_REPLY_ACTION_CLASS,
      ticketId,
      conversationId: null,
      payload: { draftExternalId },
    });
    expect(await approveRun(pool, runId)).toEqual({ outcome: 'approved', idemKey });
    expect(await runState(runId)).toBe('resolved');
    const outbox = await outboxRows(runId);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      idem_key: idemKey,
      epoch: '1',
      status: 'pending',
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  // DEC-42: what a trusted proxy supplies reaches the column, and what it
  // cannot supply is recorded as nobody rather than left null.
  it('records the approver a caller named', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const { runId } = await parkReply(ticketId);
    expect((await approveRun(pool, runId, { approvedBy: 'ops-oncall' })).outcome)
      .toBe('approved');
    const { rows } = await pool.query(
      'SELECT approved_by FROM run WHERE run_id = $1',
      [runId],
    );
    expect(rows[0]?.approved_by).toBe('ops-oncall');
  });

  it('records nobody when the named approver is not a value it will keep', async () => {
    const ticketId = `T-${randomUUID().slice(0, 8)}`;
    const { runId } = await parkReply(ticketId);
    expect((await approveRun(pool, runId, { approvedBy: 'a'.repeat(300) })).outcome)
      .toBe('approved');
    const { rows } = await pool.query(
      'SELECT approved_by, approved_by_source FROM run WHERE run_id = $1',
      [runId],
    );
    expect(rows[0]?.approved_by).toBe('unattributed');
    // DEC-45: a name nobody holds has no source, and 'none' says so — the
    // same reading the migration gives every historical `unattributed` row.
    expect(rows[0]?.approved_by_source).toBe('none');
  });

  // Criterion 3 of #107, and DEC-46: sending ends the sender's hold on the
  // case, and it does so in the transaction that records the send.
  it('releases the sender\'s hold in the transaction that sends', async () => {
    const ticket = `T-${randomUUID().slice(0, 8)}`;
    const parked = await parkReply(ticket);
    await takeHold(pool, {
      runId: parked.runId, reviewer: 'anna@example.test', lapseMs: 1_200_000,
    });

    expect((await approveRun(pool, parked.runId, {
      approvedBy: 'anna@example.test',
      approvedBySource: 'roster',
    })).outcome).toBe('approved');

    // The hold is released, and the history says the send ended it.
    expect(await readHold(pool, parked.runId)).toBeNull();
    const { rows } = await pool.query(
      'SELECT release_kind, released_by FROM case_hold WHERE run_id = $1',
      [parked.runId],
    );
    expect(rows[0]).toMatchObject({ release_kind: 'send', released_by: 'anna@example.test' });
    expect((await holdHistory(pool, parked.runId)).map((event) => event.kind))
      .toEqual(['take', 'send']);
  });

  // Risk row "Release on send": an approval that does not commit must not
  // release anything. A release written before the approval commits, or
  // outside its transaction, leaves a case nobody holds and a send nobody
  // made.
  it('leaves the hold in place when the approval does not commit', async () => {
    const ticket = `T-${randomUUID().slice(0, 8)}`;
    const parked = await parkReply(ticket);
    await takeHold(pool, {
      runId: parked.runId, reviewer: 'anna@example.test', lapseMs: 1_200_000,
    });
    // The run leaves the queue under Anna: her approval is now a request the
    // ledger refuses, and nothing about it may commit.
    await pool.query("UPDATE run SET state = 'resolved' WHERE run_id = $1", [parked.runId]);

    const outcome = await approveRun(pool, parked.runId, {
      approvedBy: 'anna@example.test',
      approvedBySource: 'roster',
    });
    expect(outcome.outcome).not.toBe('approved');

    const hold = await readHold(pool, parked.runId);
    expect(hold?.reviewer).toBe('anna@example.test');
    expect((await holdHistory(pool, parked.runId)).map((event) => event.kind)).toEqual(['take']);
  });

  // Criterion 9, the risk row's own discriminating check. The reviewer read
  // the reply on the case page and the console put a digest of that text in
  // the form. The ledger recomputes it under the run's lock, so a reply
  // rewritten after they read it is refused, named, and commits nothing —
  // including the read-back's edit distance, which would otherwise measure a
  // text the person never saw.
  it('refuses a reply that changed since the reviewer read it', async () => {
    const ticket = `T-${randomUUID().slice(0, 8)}`;
    const parked = await parkReply(ticket);
    const shown = replyDigest(await parkedBody(parked.runId));

    // The saved reply changes after the page was drawn. The ledger holds the
    // new text and the form holds the digest of the old one.
    await pool.query(
      `UPDATE step_journal SET result = jsonb_set(result, '{body}', to_jsonb($2::text))
        WHERE run_id = $1 AND step_id = 'park'`,
      [parked.runId, 'A different reply entirely.'],
    );

    const outcome = await approveRun(pool, parked.runId, {
      approvedBy: 'anna@example.test',
      approvedBySource: 'roster',
      shown,
    });
    expect(outcome).toEqual({ outcome: 'shown_changed' });
    // Nothing committed: the run still waits, no record left for the relay,
    // and no approver was written beside a move that did not happen.
    expect(await runState(parked.runId)).toBe('awaiting_approval');
    expect(await outboxRows(parked.runId)).toEqual([]);
    const run = await pool.query(
      'SELECT approved_by, approved_by_source FROM run WHERE run_id = $1',
      [parked.runId],
    );
    expect(run.rows[0]).toMatchObject({ approved_by: null, approved_by_source: null });
  });

  // The risk row's exact wrong version: a guard that compares the reply the
  // approval read when it started instead of the reply the ledger holds under
  // the lock. The window here is real — `readDraft` runs after the parked
  // record is read and before the transaction opens — and a guard reading
  // outside it approves a reply the reviewer never saw.
  it('reads the reply under the lock, not when the approval began', async () => {
    const ticket = `T-${randomUUID().slice(0, 8)}`;
    const parked = await parkReply(ticket);
    const shown = replyDigest(await parkedBody(parked.runId));

    const readDraft = {
      readDraft: async () => {
        await pool.query(
          `UPDATE step_journal SET result = jsonb_set(result, '{body}', to_jsonb($2::text))
            WHERE run_id = $1 AND step_id = 'park'`,
          [parked.runId, 'Rewritten while the approval was in flight.'],
        );
        return { body: 'The helpdesk copy.' };
      },
    };

    expect(await approveRun(pool, parked.runId, {
      approvedBy: 'anna@example.test',
      approvedBySource: 'roster',
      shown,
      readDraft,
    })).toEqual({ outcome: 'shown_changed' });
    expect(await runState(parked.runId)).toBe('awaiting_approval');
  });

  // The other half: the digest of the text the ledger holds is the one the
  // reviewer was shown, so the approval commits.
  it('approves the reply whose digest is the one the reviewer read', async () => {
    const ticket = `T-${randomUUID().slice(0, 8)}`;
    const parked = await parkReply(ticket);
    const shown = replyDigest(await parkedBody(parked.runId));

    expect((await approveRun(pool, parked.runId, {
      approvedBy: 'anna@example.test',
      approvedBySource: 'roster',
      shown,
    })).outcome).toBe('approved');
    expect(await runState(parked.runId)).toBe('resolved');
    expect(await outboxRows(parked.runId)).toHaveLength(1);
  });

  // Criterion 9: `pnpm run approve` passes no digest and is exempt, and so is
  // any other caller that names none. The guard is a statement about a page a
  // person was reading, and a caller with no page has none to compare.
  it('approves without a digest, which is the command line\'s path', async () => {
    const ticket = `T-${randomUUID().slice(0, 8)}`;
    const parked = await parkReply(ticket);
    expect((await approveRun(pool, parked.runId, {
      approvedBy: 'anna@example.test',
      approvedBySource: 'roster',
    })).outcome).toBe('approved');
  });

  // And the arm that leaves the queue without sending anything. Another run
  // holds the semantic key, so this approval sent nothing and named nobody:
  // a `send` recorded here would credit a person with a send they did not
  // make. The hold ends by its period, and the history says so.
  it('leaves the hold for its period when the approval is superseded', async () => {
    const ticket = `T-${randomUUID().slice(0, 8)}`;
    const first = await parkReply(ticket);
    expect((await approveRun(pool, first.runId, {
      approvedBy: 'anna@example.test',
      approvedBySource: 'roster',
    })).outcome).toBe('approved');

    // A second run on the same ticket parks the same action, so its record
    // collides on the semantic key (DEC-24) and the ledger supersedes it.
    const second = await parkReply(ticket);
    await takeHold(pool, {
      runId: second.runId, reviewer: 'anna@example.test', lapseMs: 1_200_000,
    });

    expect((await approveRun(pool, second.runId, {
      approvedBy: 'anna@example.test',
      approvedBySource: 'roster',
    })).outcome).toBe('superseded');
    // Still held, with no send recorded: the case is out of the queue, and
    // the hold ends when its period does.
    expect((await readHold(pool, second.runId))?.reviewer).toBe('anna@example.test');
    expect((await holdHistory(pool, second.runId)).map((event) => event.kind)).toEqual(['take']);
  });

  // The command line names nobody, and the send still ends the hold: the case
  // has left the queue either way, and a hold left on it would be recorded as
  // a lapse instead. `released_by` carries the ledger's own word for a
  // nameless approver, which is what `run.approved_by` records.
  it('ends the hold on a send that named nobody', async () => {
    const ticket = `T-${randomUUID().slice(0, 8)}`;
    const parked = await parkReply(ticket);
    await takeHold(pool, {
      runId: parked.runId, reviewer: 'anna@example.test', lapseMs: 1_200_000,
    });

    expect((await approveRun(pool, parked.runId)).outcome).toBe('approved');
    expect(await readHold(pool, parked.runId)).toBeNull();
    const { rows } = await pool.query(
      'SELECT reviewer, released_by, release_kind FROM case_hold WHERE run_id = $1',
      [parked.runId],
    );
    expect(rows[0]).toMatchObject({
      reviewer: 'anna@example.test',
      released_by: 'unattributed',
      release_kind: 'send',
    });
    expect((await holdHistory(pool, parked.runId)).map((event) => [event.kind, event.reviewer]))
      .toEqual([['take', 'anna@example.test'], ['send', 'unattributed']]);
  });

  // Criterion 8, and the maintainer's ruling of 2026-09-18: the send ends the
  // hold on the case it resolved, whoever holds it. The case has left the
  // queue, so a hold on it would say somebody is still working it — and the
  // history would read as a lapse twenty minutes later instead of the send
  // that ended it, overstating the time the case held a person.
  it('ends the hold on the case a send resolves, whoever held it', async () => {
    const ticket = `T-${randomUUID().slice(0, 8)}`;
    const parked = await parkReply(ticket);
    await takeHold(pool, {
      runId: parked.runId, reviewer: 'anna@example.test', lapseMs: 1_200_000,
    });

    // Bo holds nothing, and approves the case Anna is reading. The
    // reservation is advisory (DEC-46), and the send is what ends it.
    expect((await approveRun(pool, parked.runId, {
      approvedBy: 'bo@example.test',
      approvedBySource: 'roster',
    })).outcome).toBe('approved');

    expect(await readHold(pool, parked.runId)).toBeNull();
    expect((await holdHistory(pool, parked.runId)).map((event) => [event.kind, event.reviewer]))
      .toEqual([['take', 'anna@example.test'], ['send', 'bo@example.test']]);
    // The row keeps whose hold it was, and says who ended it.
    const { rows } = await pool.query(
      'SELECT reviewer, released_by, release_kind FROM case_hold WHERE run_id = $1',
      [parked.runId],
    );
    expect(rows[0]).toMatchObject({
      reviewer: 'anna@example.test',
      released_by: 'bo@example.test',
      release_kind: 'send',
    });
  });

  // Criterion 8: the reservation is advisory. An approval asks nobody to hold
  // the case, so the reviewer who opens a case from a stale queue — or from a
  // bookmark — still approves it. Nothing is recorded, because nothing
  // happened: the case was simply nobody's.
  it('approves a case nobody holds, and records no hold', async () => {
    const ticket = `T-${randomUUID().slice(0, 8)}`;
    const parked = await parkReply(ticket);
    expect(await readHold(pool, parked.runId)).toBeNull();

    expect((await approveRun(pool, parked.runId, {
      approvedBy: 'bo@example.test',
      approvedBySource: 'roster',
    })).outcome).toBe('approved');
    expect(await holdHistory(pool, parked.runId)).toEqual([]);
  });

  // DEC-45: the name and where it came from are recorded together, because
  // a reader who cannot tell a verified identity from a claim has neither.
  it('records where the name came from, on each path', async () => {
    const rosterTicket = `T-${randomUUID().slice(0, 8)}`;
    const rosterPark = await parkReply(rosterTicket);
    expect(
      (await approveRun(pool, rosterPark.runId, {
        approvedBy: 'anna@example.test',
        approvedBySource: 'roster',
      })).outcome,
    ).toBe('approved');

    const claimTicket = `T-${randomUUID().slice(0, 8)}`;
    const claimPark = await parkReply(claimTicket);
    expect(
      (await approveRun(pool, claimPark.runId, { approvedBy: 'ops-oncall' })).outcome,
    ).toBe('approved');

    const bareTicket = `T-${randomUUID().slice(0, 8)}`;
    const barePark = await parkReply(bareTicket);
    expect((await approveRun(pool, barePark.runId)).outcome).toBe('approved');

    const named = await pool.query(
      `SELECT r.approved_by, r.approved_by_source FROM run r
        WHERE r.run_id = ANY($1)`,
      [[rosterPark.runId, claimPark.runId, barePark.runId]],
    );
    expect(named.rows.length).toBe(3);
    const byRun = new Map<string, string>();
    for (const row of named.rows) byRun.set(row.approved_by as string, row.approved_by_source as string);
    // The console named a reviewer it verified; a caller named one it merely
    // claimed, which is the default; nobody named one at all.
    expect(byRun.get('anna@example.test')).toBe('roster');
    expect(byRun.get('ops-oncall')).toBe('header');
    expect(byRun.get('unattributed')).toBe('none');
  });

});
