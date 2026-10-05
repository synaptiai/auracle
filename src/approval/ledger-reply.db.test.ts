// Integration suite for DEC-44's approval path: the ledger holds the reply.
//
// For an adapter whose helpdesk cannot send the copy it parks, the approval
// sends the text the ledger holds, and the parked copy is only ever checked
// against it. The coordinator runs with a FakeProvider and a real ledger, and
// the helpdesk is the fixture-backed reference adapter, so a real parked copy
// is compared without a network. Synthetic data only (DEC-18).
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HelpdeskAdapter } from '../adapters/helpdesk.js';
import { COMPENSATION_ACTION_CLASS, CUSTOMER_REPLY_ACTION_CLASS } from '../adapters/types.js';
import { coordinateTicket } from '../coordinator/coordinator.js';
import type { CoordinatorDeps } from '../coordinator/coordinator.js';
import { enqueueTicket } from '../coordinator/intake.js';
import { dbUrl } from '../db/config.js';
import { deriveIdemKey } from '../ledger/keys.js';
import { fencedInsert } from '../ledger/insert.js';
import { journalFinish, journalStart } from '../ledger/journal-write.js';
import { recordSavedReply } from '../ledger/conversation.js';
import { FakeProvider } from '../models/fake.js';
import type { FakeStep } from '../models/fake.js';
import type { AdapterCapabilities } from '../policy/policy.js';
import { indexDocument } from '../retriever/retriever.js';
import { truncateLedger } from '../test-support/schema.js';

import { approveRun } from './approve.js';
import { approvalEditDistance } from './edit_distance.js';
import { replyDigest } from './shown.js';

const pool = new Pool({ connectionString: dbUrl(), max: 10 });

// src/test-support/db-global-setup.ts guarantees a reachable database before
// the workers fork: it starts a container, or probes an explicit
// DATABASE_URL and fails the run. A failure here is therefore a fault, and
// a suite that skipped itself instead would report success while proving
// nothing.
await pool.query('SELECT 1');

const PINS = { promptVer: 'ledger-reply-prompt', modelVer: 'ledger-reply-model' };
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

/** One axis of the embedding space, so the retriever's match is exact. */
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
    { ticketId, subject: 'Cannot sign in', queue: 'accounts', status: 'open', customerAddress: null },
  ]);
}

/** Opens a conversation and parks a customer reply on its first turn. */
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

interface ParkedRow {
  body: string;
  disclosure?: string;
  provenance?: { generatedBy: string; modelId: string; promptVer: string; generatedAt: string };
}

async function readPark(runId: string): Promise<ParkedRow> {
  const rows = await pool.query(
    "SELECT result FROM step_journal WHERE run_id = $1 AND step_id = 'park'",
    [runId],
  );
  return rows.rows[0]!.result as ParkedRow;
}

async function runState(runId: string): Promise<string | undefined> {
  const rows = await pool.query('SELECT state FROM run WHERE run_id = $1', [runId]);
  return rows.rows[0]?.state as string | undefined;
}

async function outboxRow(runId: string): Promise<
  { idem_key: string; status: string; payload: unknown; reply: unknown } | undefined
> {
  const rows = await pool.query(
    'SELECT idem_key, status, payload, reply FROM outbox WHERE run_id = $1',
    [runId],
  );
  return rows.rows[0] as { idem_key: string; status: string; payload: unknown; reply: unknown } | undefined;
}

async function sentText(conversationId: string, turnNumber: number): Promise<string | null> {
  const rows = await pool.query<{ approved_reply_text: string | null }>(
    'SELECT approved_reply_text FROM turn WHERE conversation_id = $1 AND turn_number = $2',
    [conversationId, turnNumber],
  );
  return rows.rows[0]?.approved_reply_text ?? null;
}

/** Save one reply the way the console does: one transaction, one update. */
async function saveReply(conversationId: string, turnNumber: number, bodyText: string): Promise<void> {
  const client = await pool.connect();
  try {
    await recordSavedReply(client, {
      conversationId,
      turnNumber,
      bodyText,
      savedBy: 'reviewer-a@example.test',
      savedBySource: 'roster',
    });
  } finally {
    client.release();
  }
}

async function distance(runId: string): Promise<number | null> {
  const rows = await pool.query('SELECT approval_edit_distance FROM run WHERE run_id = $1', [runId]);
  return rows.rows[0]?.approval_edit_distance as number | null;
}

describe('DEC-44: the approval sends the reply the ledger holds', () => {
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

  it('sends the parked body when nobody edited it, and records it as sent', async () => {
    const { runId, conversationId, draftExternalId, helpdesk } = await parkOnTurnOne('T-' + randomUUID().slice(0, 8));
    const parked = await readPark(runId);

    const approval = await approveRun(pool, runId, {
      ledgerReply: true,
      readDraft: helpdesk,
    });

    expect(approval.outcome).toBe('approved');
    expect(await runState(runId)).toBe('resolved');

    // The record carries what to send, with the disclosure and provenance the
    // adapter would have attached (DEC-14, DEC-33), and it still names the
    // parked handle: on this path the handle addresses the ticket.
    const row = await outboxRow(runId);
    expect(row?.status).toBe('pending');
    expect(row?.payload).toEqual({ draftExternalId });
    expect(row?.reply).toMatchObject({
      bodyText: parked.body,
      disclosure: DISCLOSURE,
      provenance: { promptVer: PINS.promptVer, modelId: PINS.modelVer },
    });

    // An unedited approval still records the pair: what was sent, and that
    // the person changed nothing (section 4.10).
    expect(await sentText(conversationId, 1)).toBe(parked.body);
    expect(await distance(runId)).toBe(0);
  });

  it('sends the text a person saved, and measures the edit from the parked body', async () => {
    const { runId, conversationId, helpdesk } = await parkOnTurnOne('T-' + randomUUID().slice(0, 8));
    const parked = await readPark(runId);
    const edited = `${parked.body} The link stays valid for one hour.`;
    await saveReply(conversationId, 1, edited);

    const approval = await approveRun(pool, runId, { ledgerReply: true, readDraft: helpdesk });

    expect(approval.outcome).toBe('approved');
    const row = await outboxRow(runId);
    expect((row?.reply as { bodyText: string }).bodyText).toBe(edited);
    expect(await sentText(conversationId, 1)).toBe(edited);
    expect(await distance(runId)).toBe(approvalEditDistance(parked.body, edited));
    expect(await distance(runId)).toBeGreaterThan(0);
  });

  it('refuses when the copy in the helpdesk was edited after the park, and shows both texts', async () => {
    const { runId, helpdesk, draftExternalId } = await parkOnTurnOne('T-' + randomUUID().slice(0, 8));
    const parked = await readPark(runId);
    const copyEdit = `${parked.body} Ask the billing team about your last invoice.`;
    helpdesk.editDraft(draftExternalId, copyEdit);

    const approval = await approveRun(pool, runId, { ledgerReply: true, readDraft: helpdesk });

    expect(approval).toEqual({
      outcome: 'copy_changed',
      ledgerText: parked.body,
      copyText: copyEdit,
    });
    // Nothing was sent, and nothing was resolved: the person chooses next.
    expect(await runState(runId)).toBe('awaiting_approval');
    expect(await outboxRow(runId)).toBeUndefined();
  });

  // The refusal is a choice, not a dead end: the console offers the helpdesk
  // copy as one of the texts to send, and a reviewer who takes it writes that
  // text onto the turn. An approval that refused again would leave no way to
  // send the very text the refusal was about.
  it('approves the copy once a reviewer saved it as the reply', async () => {
    const { runId, conversationId, helpdesk, draftExternalId } = await parkOnTurnOne(
      'T-' + randomUUID().slice(0, 8),
    );
    const parked = await readPark(runId);
    const copyEdit = `${parked.body} Ask the billing team about your last invoice.`;
    helpdesk.editDraft(draftExternalId, copyEdit);

    // The refusal, first: nothing is sent, and both texts come back.
    expect(await approveRun(pool, runId, { ledgerReply: true, readDraft: helpdesk })).toEqual({
      outcome: 'copy_changed',
      ledgerText: parked.body,
      copyText: copyEdit,
    });

    // The reviewer takes the copy, which is the console's own save.
    await saveReply(conversationId, 1, copyEdit);

    expect(await approveRun(pool, runId, { ledgerReply: true, readDraft: helpdesk }))
      .toMatchObject({ outcome: 'approved' });
    const row = await outboxRow(runId);
    expect((row?.reply as { bodyText: string }).bodyText).toBe(copyEdit);
    expect(await sentText(conversationId, 1)).toBe(copyEdit);
  });

  // The text this approval sends is resolved before its transaction opens,
  // and the digest is checked under the run's lock. A save that lands between
  // the two would otherwise send text the reviewer's page never showed, while
  // the case recorded the text the lock held.
  it('refuses when the reply moves between the read and the row lock', async () => {
    const { runId, conversationId } = await parkOnTurnOne('T-' + randomUUID().slice(0, 8));
    const parked = await readPark(runId);
    const second = 'The second reviewer wrote this.';
    await saveReply(conversationId, 1, second);

    // The page this approval came from was drawn before that save: it showed
    // the parked body. The read-back then restores it, which is the save that
    // lands inside the window.
    const racingReadBack = {
      readDraft: async (): Promise<{ readonly body: string } | null> => {
        await saveReply(conversationId, 1, parked.body);
        return { body: parked.body };
      },
    };
    const approval = await approveRun(pool, runId, {
      ledgerReply: true,
      readDraft: racingReadBack,
      shown: replyDigest(parked.body),
    });

    expect(approval).toEqual({ outcome: 'shown_changed' });
    expect(await runState(runId)).toBe('awaiting_approval');
    expect(await outboxRow(runId)).toBeUndefined();
  });

  it('approves when the copy differs only in the whitespace a channel rewraps', async () => {
    const { runId, helpdesk, draftExternalId } = await parkOnTurnOne('T-' + randomUUID().slice(0, 8));
    const parked = await readPark(runId);
    helpdesk.editDraft(draftExternalId, parked.body.replace('. ', '.\n  '));

    expect(await approveRun(pool, runId, { ledgerReply: true, readDraft: helpdesk }))
      .toMatchObject({ outcome: 'approved' });
  });

  // The other half of the choice. The copy is in a helpdesk this system
  // cannot write into, so nothing a reviewer could do would make the two
  // texts agree: without this, the refusal's second branch would be a dead
  // end, and the reviewer's own text could never be sent through the console.
  it('sends the ledger reply past an acknowledged copy edit', async () => {
    const { runId, conversationId, helpdesk, draftExternalId } = await parkOnTurnOne(
      'T-' + randomUUID().slice(0, 8),
    );
    const parked = await readPark(runId);
    const copyEdit = `${parked.body} Ask the billing team about your last invoice.`;
    helpdesk.editDraft(draftExternalId, copyEdit);

    const approval = await approveRun(pool, runId, {
      ledgerReply: true,
      readDraft: helpdesk,
      copyAcknowledged: replyDigest(copyEdit),
    });

    expect(approval).toMatchObject({ outcome: 'approved', copyAcknowledged: true });
    const row = await outboxRow(runId);
    expect(row?.reply).toMatchObject({ bodyText: parked.body });
    expect(await sentText(conversationId, 1)).toBe(parked.body);
  });

  // Bound to the text the person read: a copy that moved again is a refusal,
  // and the acknowledgement of the older text does not carry over to it.
  it('refuses a copy that changed again after the acknowledgement', async () => {
    const { runId, helpdesk, draftExternalId } = await parkOnTurnOne('T-' + randomUUID().slice(0, 8));
    const parked = await readPark(runId);
    const first = `${parked.body} Ask the billing team about your last invoice.`;
    helpdesk.editDraft(draftExternalId, first);
    const second = `${first} And here is a second edit.`;
    helpdesk.editDraft(draftExternalId, second);

    const approval = await approveRun(pool, runId, {
      ledgerReply: true,
      readDraft: helpdesk,
      copyAcknowledged: replyDigest(first),
    });

    expect(approval).toEqual({
      outcome: 'copy_changed',
      ledgerText: parked.body,
      copyText: second,
    });
    expect(await runState(runId)).toBe('awaiting_approval');
  });

  // An acknowledgement that names nothing the helpdesk holds is not a
  // decision about text anybody read, so it does not suppress the refusal.
  it('refuses an acknowledgement no copy matches', async () => {
    const { runId, helpdesk, draftExternalId } = await parkOnTurnOne('T-' + randomUUID().slice(0, 8));
    const parked = await readPark(runId);
    helpdesk.editDraft(draftExternalId, `${parked.body} Ask the billing team.`);

    const approval = await approveRun(pool, runId, {
      ledgerReply: true,
      readDraft: helpdesk,
      copyAcknowledged: replyDigest('a text no helpdesk holds'),
    });

    expect(approval.outcome).toBe('copy_changed');
  });

  // A copy a person cleared holds no text. Comparing it would refuse a send
  // the page then cannot offer a way past: the console's only control for a
  // copy saves it as the reply, and `saveReply` refuses an empty reply.
  it('sends the ledger reply when the copy holds no text at all', async () => {
    const { runId, conversationId } = await parkOnTurnOne('T-' + randomUUID().slice(0, 8));
    const parked = await readPark(runId);
    // A helpdesk can hold a thread whose text a person cleared, and the
    // reference adapter cannot be made to: `editDraft` refuses an empty body.
    // So this reads the copy through the answer a real helpdesk gives.
    const emptied = {
      readDraft: async (): Promise<{ readonly body: string } | null> => ({ body: '   ' }),
    };

    const approval = await approveRun(pool, runId, { ledgerReply: true, readDraft: emptied });

    expect(approval).toMatchObject({ outcome: 'approved' });
    expect(await sentText(conversationId, 1)).toBe(parked.body);
  });

  it('makes no comparison when the caller supplies no read-back', async () => {
    const { runId, helpdesk, draftExternalId } = await parkOnTurnOne('T-' + randomUUID().slice(0, 8));
    const parked = await readPark(runId);
    // An edit nobody can read is an edit nobody compares. The ledger's reply
    // is what sends, so the copy's state decides nothing here.
    helpdesk.editDraft(draftExternalId, 'A copy this approval never reads.');

    const approval = await approveRun(pool, runId, { ledgerReply: true });

    expect(approval.outcome).toBe('approved');
    expect((await outboxRow(runId))?.reply).toMatchObject({ bodyText: parked.body });
  });

  it('refuses a reply the ledger holds with no disclosure (DEC-14)', async () => {
    const { runId, helpdesk } = await parkOnTurnOne('T-' + randomUUID().slice(0, 8));
    // A park journaled before DEC-44 recorded no disclosure and no
    // provenance. Removed here rather than seeded, so the rest of the record
    // is the one the coordinator wrote.
    await pool.query(
      "UPDATE step_journal SET result = result - 'disclosure' - 'provenance'"
        + " WHERE run_id = $1 AND step_id = 'park'",
      [runId],
    );

    const approval = await approveRun(pool, runId, { ledgerReply: true, readDraft: helpdesk });

    expect(approval).toEqual({ outcome: 'no_disclosure' });
    expect(await runState(runId)).toBe('awaiting_approval');
    expect(await outboxRow(runId)).toBeUndefined();
  });

  it('refuses a caller that names both the ledger reply and a body', async () => {
    const { runId } = await parkOnTurnOne('T-' + randomUUID().slice(0, 8));

    await expect(
      approveRun(pool, runId, { ledgerReply: true, finalBody: 'a body the caller prefers' }),
    ).rejects.toThrow(/both ledgerReply and finalBody/);
  });

  // DEC-49 rejects a key that folds in a digest of the body, so an edited
  // reply must derive the key an unedited one derives. Two runs on one ticket
  // and one turn derive one key, and the second is refused as superseded
  // precisely because its text did not reach the key.
  it('derives one key whether or not the reply was edited', async () => {
    const { runId, conversationId, draftExternalId, helpdesk } = await parkOnTurnOne('T-' + randomUUID().slice(0, 8));
    const parked = await readPark(runId);
    const edited = `${parked.body} One more synthetic sentence.`;
    await saveReply(conversationId, 1, edited);
    expect((await approveRun(pool, runId, { ledgerReply: true, readDraft: helpdesk })).outcome).toBe('approved');
    const first = await outboxRow(runId);

    // A second run serving the same ticket and turn, with a different parked
    // body. Only its text differs from the first, so only a key that folds in
    // the text could let it through.
    const other = randomUUID();
    await fencedInsert(pool, {
      runId: other,
      ticketId: (await pool.query('SELECT ticket_id FROM run WHERE run_id = $1', [runId])).rows[0]!
        .ticket_id as string,
      partition: 0,
      epoch: 1n,
      state: 'awaiting_approval',
      promptVer: PINS.promptVer,
      modelVer: PINS.modelVer,
      conversationId,
      turnNumber: 1,
      deadlineAt: new Date(Date.now() + 60_000),
    }, null);
    await journalStart(pool, { runId: other, stepId: 'park', ...PINS, costMicros: 0 });
    await journalFinish(pool, {
      runId: other,
      stepId: 'park',
      status: 'done',
      costMicros: 0,
      result: {
        draftExternalId,
        actionClass: CUSTOMER_REPLY_ACTION_CLASS,
        delivery: 'at_least_once',
        turnNumber: 1,
        body: 'A different reply entirely, parked on the same turn.',
        disclosure: DISCLOSURE,
        provenance: parked.provenance,
      },
    });

    // A turn takes one reply, so the second run's approval is refused before
    // it derives anything (DEC-49): the first approval's record closes the
    // turn. Before that refusal existed the key collision stopped it instead.
    expect(await approveRun(pool, other, { ledgerReply: true })).toEqual({ outcome: 'turn_closed' });
    expect(await outboxRow(other)).toBeUndefined();
    expect(await outboxRow(runId)).toEqual(first);
    // And the key claim itself, which that refusal no longer exercises: the
    // key the second run would derive is the first one's, because only its
    // text differs and the text is not in the key (DEC-49).
    const ticketId = (await pool.query('SELECT ticket_id FROM run WHERE run_id = $1', [runId]))
      .rows[0]!.ticket_id as string;
    expect(deriveIdemKey({
      actionClass: CUSTOMER_REPLY_ACTION_CLASS,
      ticketId,
      turnNumber: 1,
      conversationId,
      payload: { draftExternalId },
    })).toBe(first?.idem_key);
  });

  // DEC-44 governs a customer reply, and only a customer reply. A ledger-only
  // park (DEC-34 compensation) holds no reply and journals no disclosure: it
  // is a ledger-only write, and this path leaves it to `performAction`. A
  // refusal here would strand every compensation on any adapter whose
  // helpdesk cannot send its parked copy.
  it('approves a ledger-only park, which carries no reply to send', async () => {
    const ticketId = 'T-' + randomUUID().slice(0, 8);
    const helpdesk = helpdeskWith(ticketId);
    const result = await coordinateTicket(makeDeps(helpdesk), {
      ticketId,
      ticketText: TICKET_TEXT,
      epoch: 1n,
      actionClass: COMPENSATION_ACTION_CLASS,
      actionPayload: { reason: 'refund sent to the wrong account' },
      delivery: 'at_most_once',
      isCustomerVisible: false,
      disclosure: DISCLOSURE,
    });
    if (result.outcome !== 'awaiting_approval') {
      throw new Error(`expected awaiting_approval, got ${result.outcome}`);
    }

    expect(await approveRun(pool, result.runId, { ledgerReply: true }))
      .toMatchObject({ outcome: 'approved' });

    // The record is the action the park journaled, and it carries no reply:
    // the relay performs it rather than sending a text nothing approved.
    const row = await outboxRow(result.runId);
    expect(row?.payload).toMatchObject({ reason: 'refund sent to the wrong account' });
    expect(row?.reply).toBeNull();
  });

  afterAll(async () => {
    await pool.end();
  });
});
