/**
 * DEC-48: a reply a reviewer rewrote from scratch.
 *
 * The criterion's own file. A person's reply replaces the one the ledger
 * holds, keeps the adopter's disclosure, and carries a provenance that names
 * a person with no model and no prompt. The gate's verdict belongs to the
 * draft it replaced, so no reader reports coverage for this reply.
 *
 * The coordinator runs with a FakeProvider and a real ledger, and the parked
 * copy is the fixture-backed reference adapter's. Synthetic data only
 * (DEC-18).
 */
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { HelpdeskAdapter } from '../adapters/helpdesk.js';
import { CUSTOMER_REPLY_ACTION_CLASS } from '../adapters/types.js';
import { coordinateTicket } from '../coordinator/coordinator.js';
import type { CoordinatorDeps } from '../coordinator/coordinator.js';
import { enqueueTicket } from '../coordinator/intake.js';
import { dbUrl } from '../db/config.js';
import { readRunJournal } from '../journal/query.js';
import { readSavedReply } from '../ledger/conversation.js';
import { FakeProvider } from '../models/fake.js';
import type { FakeStep } from '../models/fake.js';
import type { AdapterCapabilities } from '../policy/policy.js';
import { indexDocument } from '../retriever/retriever.js';
import { truncateLedger } from '../test-support/schema.js';

import { approveRun } from './approve.js';
import { saveReply } from './save-reply.js';
import { rewriteReply } from './rewrite.js';
import { replyDigest } from './shown.js';

const pool = new Pool({ connectionString: dbUrl(), max: 10 });

afterAll(async () => {
  await pool.end();
});

await pool.query('SELECT 1');

const PINS = { promptVer: 'rewrite-prompt', modelVer: 'rewrite-model' };
const CAPABILITIES: AdapterCapabilities = {
  supportsIdempotencyKey: true,
  supportsReadBack: true,
  supportsDraftState: true,
  supportsStructuredFields: true,
  supportsThreading: true,
  supportsLedgerReply: true,
};
const TICKET_TEXT = 'I cannot sign in to my account. How do I reset my password?';
const DISCLOSURE = 'This reply was drafted by an automated assistant and approved by a person.';
const VEC = Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0));

/** What the reviewer writes, and it shares no wording with the draft. */
const PERSON_TEXT = 'Call the service desk on the number in your welcome pack, and quote your account id.';

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

interface Parked {
  readonly runId: string;
  readonly ticketId: string;
  readonly conversationId: string;
  readonly turnNumber: number;
  readonly parkedBody: string;
}

/** One parked customer reply on the first turn of a new conversation. */
async function parkOnTurnOne(): Promise<Parked> {
  const ticketId = 'T-' + randomUUID().slice(0, 8);
  const enqueued = await enqueueTicket(
    pool,
    { ticketId, messageId: `m-1-${ticketId}@example.test`, ticketText: TICKET_TEXT },
    8,
  );
  const helpdesk = new HelpdeskAdapter([
    { ticketId, subject: 'Cannot sign in', queue: 'accounts', status: 'open', customerAddress: null },
  ]);
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
  const rows = await pool.query<{ body: string }>(
    "SELECT result->>'body' AS body FROM step_journal WHERE run_id = $1 AND step_id = 'park'",
    [result.runId],
  );
  return {
    runId: result.runId,
    ticketId,
    conversationId: enqueued.conversationId,
    turnNumber: enqueued.turnNumber,
    parkedBody: rows.rows[0]!.body,
  };
}

async function journalRows(runId: string): Promise<Array<{ step_id: string; result: unknown }>> {
  const rows = await pool.query(
    'SELECT step_id, result FROM step_journal WHERE run_id = $1',
    [runId],
  );
  return rows.rows as never;
}

/** The moment the turn's reply records, which the send reports as its own. */
async function capturedAt(parked: Parked): Promise<string | null> {
  const rows = await pool.query<{ generatedAt: string | null }>(
    "SELECT saved_reply_provenance ->> 'generatedAt' AS \"generatedAt\" FROM turn"
      + ' WHERE conversation_id = $1 AND turn_number = $2',
    [parked.conversationId, parked.turnNumber],
  );
  return rows.rows[0]?.generatedAt ?? null;
}

async function runState(runId: string): Promise<string> {
  const rows = await pool.query<{ state: string }>('SELECT state FROM run WHERE run_id = $1', [runId]);
  return rows.rows[0]!.state;
}

/**
 * A second run parked on the same turn, the shape a crash retry leaves: the
 * consumer files one run per attempt, and both park on the turn they answer.
 */
async function parkAgain(parked: Parked): Promise<{ runId: string }> {
  const helpdesk = new HelpdeskAdapter([
    {
      ticketId: parked.ticketId, subject: 'Cannot sign in', queue: 'accounts',
      status: 'open', customerAddress: null,
    },
  ]);
  const result = await coordinateTicket(makeDeps(helpdesk), {
    ticketId: parked.ticketId,
    ticketText: TICKET_TEXT,
    epoch: 2n,
    conversationId: parked.conversationId,
    turnNumber: parked.turnNumber,
    actionClass: CUSTOMER_REPLY_ACTION_CLASS,
    actionPayload: { summary: 'password reset answer' },
    delivery: 'at_least_once',
    isCustomerVisible: true,
    disclosure: DISCLOSURE,
  });
  if (result.outcome !== 'awaiting_approval') {
    throw new Error(`expected awaiting_approval, got ${result.outcome}`);
  }
  return { runId: result.runId };
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

describe('DEC-48: a reply a person rewrote from scratch', () => {
  it('replaces the reply the turn holds, and records who wrote it', async () => {
    const parked = await parkOnTurnOne();

    expect(await rewriteReply(pool, parked.runId, PERSON_TEXT, {
      rewrittenBy: 'anna@example.test',
      rewrittenBySource: 'roster',
      ledgerReply: true,
    })).toEqual({ outcome: 'rewritten' });

    // The turn holds the person's text, and the approval will send it.
    expect(
      await readSavedReply(pool, {
        conversationId: parked.conversationId,
        turnNumber: parked.turnNumber,
      }),
    ).toBe(PERSON_TEXT);

    // No state moves: a rewrite is not an outcome until something sends it.
    expect(await runState(parked.runId)).toBe('awaiting_approval');
    const outbox = await pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM outbox WHERE run_id = $1',
      [parked.runId],
    );
    expect(outbox.rows[0]!.n).toBe('0');

    // The record: who wrote it, what the name proves, and the digest of the
    // reply it replaced.
    const rewrite = (await journalRows(parked.runId)).find((row) => row.step_id === 'rewrite');
    expect(rewrite?.result).toMatchObject({
      reviewer: 'anna@example.test',
      reviewerSource: 'roster',
      cleared: replyDigest(parked.parkedBody),
    });

    // The drafted body stays in the journal: it is what the approval measures
    // an edit distance against, and the record of what the model wrote.
    const park = (await journalRows(parked.runId)).find((row) => row.step_id === 'park');
    expect((park?.result as { body: string }).body).toBe(parked.parkedBody);
  });

  it('refuses where the adapter can send the copy it parked (DEC-44)', async () => {
    const parked = await parkOnTurnOne();

    expect(await rewriteReply(pool, parked.runId, PERSON_TEXT, {
      rewrittenBy: 'anna@example.test',
    })).toEqual({ outcome: 'not_ledger_reply' });
    expect(await readSavedReply(pool, {
      conversationId: parked.conversationId,
      turnNumber: parked.turnNumber,
    })).toBeNull();
    expect((await journalRows(parked.runId)).some((row) => row.step_id === 'rewrite')).toBe(false);
  });

  it('refuses an empty reply, a run that is not waiting, and one the ledger does not hold', async () => {
    const parked = await parkOnTurnOne();

    expect(await rewriteReply(pool, parked.runId, '   \n  ', { ledgerReply: true }))
      .toEqual({ outcome: 'empty_reply' });
    expect(await rewriteReply(pool, randomUUID(), PERSON_TEXT, { ledgerReply: true }))
      .toEqual({ outcome: 'unknown_run' });

    await pool.query("UPDATE run SET state = 'resolved' WHERE run_id = $1", [parked.runId]);
    expect(await rewriteReply(pool, parked.runId, PERSON_TEXT, { ledgerReply: true }))
      .toEqual({ outcome: 'not_awaiting_approval', state: 'resolved' });
  });

  it('refuses a page whose reply moved, and takes the one that did not (DEC-46)', async () => {
    const parked = await parkOnTurnOne();

    expect(await rewriteReply(pool, parked.runId, PERSON_TEXT, {
      ledgerReply: true,
      shown: replyDigest(`${parked.parkedBody} Edited elsewhere.`),
    })).toEqual({ outcome: 'shown_changed' });
    expect(await readSavedReply(pool, {
      conversationId: parked.conversationId,
      turnNumber: parked.turnNumber,
    })).toBeNull();

    expect(await rewriteReply(pool, parked.runId, PERSON_TEXT, {
      ledgerReply: true,
      shown: replyDigest(parked.parkedBody),
    })).toEqual({ outcome: 'rewritten' });
  });

  // The send, which is the half a person never sees in the ledger. The reply
  // reaches the customer with the adopter's disclosure and a provenance that
  // names a person: the model that drafted the text this replaced wrote
  // nothing here, and a trailer naming it would be a false claim.
  it('sends the person text with the adopter disclosure, and names no model', async () => {
    const parked = await parkOnTurnOne();
    await rewriteReply(pool, parked.runId, PERSON_TEXT, {
      rewrittenBy: 'anna@example.test',
      rewrittenBySource: 'roster',
      ledgerReply: true,
    });

    expect(await approveRun(pool, parked.runId, {
      ledgerReply: true,
      approvedBy: 'anna@example.test',
      approvedBySource: 'roster',
    })).toMatchObject({ outcome: 'approved' });

    const rows = await pool.query<{ reply: Record<string, unknown> }>(
      'SELECT reply FROM outbox WHERE run_id = $1',
      [parked.runId],
    );
    const reply = rows.rows[0]!.reply as {
      bodyText: string;
      disclosure: string;
      provenance: Record<string, unknown>;
    };
    expect(reply.bodyText).toBe(PERSON_TEXT);
    expect(reply.disclosure).toBe(DISCLOSURE);
    expect(reply.provenance['generatedBy']).toBe('person');
    expect(reply.provenance).not.toHaveProperty('modelId');
    expect(reply.provenance).not.toHaveProperty('promptVer');
    expect(typeof reply.provenance['generatedAt']).toBe('string');
  });

  // A reply the model wrote is unaffected: the same path still carries its
  // own provenance, so this change narrows nothing for the automatic draft.
  // The P1 the adversarial pass executed: a turn is served by every run that
  // answers it, so the author has to travel with the text. Reading it from
  // the approving run's own journal made that run the author of a text its
  // sibling's reviewer wrote, and the customer received a person's words
  // under the model's name.
  it('sends the person text when a sibling run of the same turn is approved', async () => {
    const first = await parkOnTurnOne();
    const second = await parkAgain(first);
    expect(second.runId).not.toBe(first.runId);

    expect(await rewriteReply(pool, first.runId, PERSON_TEXT, {
      rewrittenBy: 'anna@example.test',
      rewrittenBySource: 'roster',
      ledgerReply: true,
    })).toEqual({ outcome: 'rewritten' });

    // The other run is the one approved: a retry a reviewer picked.
    expect(await approveRun(pool, second.runId, {
      ledgerReply: true,
      approvedBy: 'bo@example.test',
      approvedBySource: 'roster',
    })).toMatchObject({ outcome: 'approved' });

    const rows = await pool.query<{
      reply: { bodyText: string; provenance: Record<string, unknown> };
    }>('SELECT reply FROM outbox WHERE run_id = $1', [second.runId]);
    const reply = rows.rows[0]!.reply;
    expect(reply.bodyText).toBe(PERSON_TEXT);
    expect(reply.provenance['generatedBy']).toBe('person');
    expect(reply.provenance).not.toHaveProperty('modelId');
  });

  // And the sibling's page reports the same thing about the same text.
  it('reports the sibling run as one whose reply a person wrote', async () => {
    const first = await parkOnTurnOne();
    const second = await parkAgain(first);
    await rewriteReply(pool, first.runId, PERSON_TEXT, { ledgerReply: true });

    const sibling = await readRunJournal(pool, second.runId);
    expect(sibling?.rewrite).not.toBeNull();
    // The record belongs to the run that wrote it, so the sibling reads it as
    // unnamed rather than borrowing its sibling's reviewer.
    expect(sibling?.rewrite?.reviewer).toBeNull();
    expect(sibling?.rewrite?.at).toBeNull();
  });

  // A save after a rewrite is the same reply, written later: the moment the
  // trailer prints has to be the last write, not the first.
  it('dates the reply to the last write when a save follows a rewrite', async () => {
    const parked = await parkOnTurnOne();
    await rewriteReply(pool, parked.runId, PERSON_TEXT, {
      rewrittenBy: 'anna@example.test',
      ledgerReply: true,
    });
    const rewritten = await capturedAt(parked);
    expect(rewritten).not.toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 5));
    await saveReply(pool, parked.runId, `${PERSON_TEXT} And again.`);
    const saved = await capturedAt(parked);
    expect(saved).not.toBeNull();
    expect(new Date(saved!).getTime()).toBeGreaterThan(new Date(rewritten!).getTime());

    expect(await approveRun(pool, parked.runId, {
      ledgerReply: true, approvedBy: 'anna@example.test', approvedBySource: 'roster',
    })).toMatchObject({ outcome: 'approved' });
    const rows = await pool.query<{ reply: { bodyText: string; provenance: { generatedAt: string } } }>(
      'SELECT reply FROM outbox WHERE run_id = $1', [parked.runId]);
    expect(rows.rows[0]!.reply.bodyText).toBe(`${PERSON_TEXT} And again.`);
    expect(rows.rows[0]!.reply.provenance.generatedAt).toBe(saved);
  });

  it('refuses a run whose park names no turn, and one whose park holds no reply', async () => {
    const noTurn = await parkOnTurnOne();
    await pool.query(
      "UPDATE step_journal SET result = result - 'turnNumber'"
        + " WHERE run_id = $1 AND step_id = 'park'",
      [noTurn.runId],
    );
    expect(await rewriteReply(pool, noTurn.runId, PERSON_TEXT, { ledgerReply: true }))
      .toEqual({ outcome: 'no_turn' });

    // DEC-34: a ledger-only park. Its approval performs an action and sends
    // nothing, so a reply written here would reach nobody.
    const noReply = await parkOnTurnOne();
    await pool.query(
      "UPDATE step_journal SET result = result - 'draftExternalId'"
        + " WHERE run_id = $1 AND step_id = 'park'",
      [noReply.runId],
    );
    expect(await rewriteReply(pool, noReply.runId, PERSON_TEXT, { ledgerReply: true }))
      .toEqual({ outcome: 'no_reply' });
    expect(await readSavedReply(pool, {
      conversationId: noReply.conversationId,
      turnNumber: noReply.turnNumber,
    })).toBeNull();
  });

  it('refuses a reply holding a character the ledger cannot store', async () => {
    const parked = await parkOnTurnOne();

    // A NUL makes Postgres raise; an unpaired surrogate is silently replaced
    // by the driver's encoder, so the customer would receive other text.
    for (const text of ['A report.\u0000And more.', 'A report \ud800 and more.']) {
      expect(await rewriteReply(pool, parked.runId, text, { ledgerReply: true }), JSON.stringify(text))
        .toEqual({ outcome: 'unprintable_reply' });
    }
    expect(await readSavedReply(pool, {
      conversationId: parked.conversationId,
      turnNumber: parked.turnNumber,
    })).toBeNull();
    // The storable text with a paired surrogate is a code point, and passes.
    expect(await rewriteReply(pool, parked.runId, 'A report \ud83d\ude00 and more.', { ledgerReply: true }))
      .toEqual({ outcome: 'rewritten' });
  });

  it('puts the reply aside again, and refuses a page whose text moved', async () => {
    const parked = await parkOnTurnOne();
    expect(await rewriteReply(pool, parked.runId, PERSON_TEXT, {
      rewrittenBy: 'anna@example.test', ledgerReply: true,
    })).toEqual({ outcome: 'rewritten' });

    // The ordinary repeat: the reviewer writes again. The row is the step's
    // own, so the second act replaces it rather than raising.
    await saveReply(pool, parked.runId, 'An edit of my own reply.');
    expect(await rewriteReply(pool, parked.runId, 'A third reply, written later.', {
      rewrittenBy: 'bo@example.test', ledgerReply: true,
      shown: replyDigest('An edit of my own reply.'),
    })).toEqual({ outcome: 'rewritten' });

    const rows = await journalRows(parked.runId);
    const rewrites = rows.filter((row) => row.step_id === 'rewrite');
    expect(rewrites).toHaveLength(1);
    expect(rewrites[0]!.result).toMatchObject({ reviewer: 'bo@example.test' });
    // The digest is of the reply the second rewrite replaced: the edit, not
    // the parked body the first one replaced.
    expect((rewrites[0]!.result as { cleared: string }).cleared)
      .toBe(replyDigest('An edit of my own reply.'));

    // And a page that drew the draft is refused: the reply moved since.
    expect(await rewriteReply(pool, parked.runId, 'A fourth reply.', {
      ledgerReply: true, shown: replyDigest(parked.parkedBody),
    })).toEqual({ outcome: 'shown_changed' });
  });

  it('leaves a model reply carrying the model provenance', async () => {
    const parked = await parkOnTurnOne();

    expect(await approveRun(pool, parked.runId, {
      ledgerReply: true,
      approvedBy: 'anna@example.test',
      approvedBySource: 'roster',
    })).toMatchObject({ outcome: 'approved' });

    const rows = await pool.query<{ reply: { bodyText: string; provenance: Record<string, unknown> } }>(
      'SELECT reply FROM outbox WHERE run_id = $1',
      [parked.runId],
    );
    expect(rows.rows[0]!.reply.bodyText).toBe(parked.parkedBody);
    expect(rows.rows[0]!.reply.provenance['generatedBy']).toBe('auracle');
    expect(rows.rows[0]!.reply.provenance['modelId']).toBe(PINS.modelVer);
  });

  // The gate judged the draft. Its record stays — the run that gated it is
  // the run that journalled it — and the journal says which reply it belongs
  // to, so no reader reports it as the verdict on a person's words.
  it('reports the gate verdict as the replaced draft, not as the reply', async () => {
    const parked = await parkOnTurnOne();
    const before = await readRunJournal(pool, parked.runId);
    expect(before?.coverage?.groundedness).not.toBeNull();

    await rewriteReply(pool, parked.runId, PERSON_TEXT, {
      rewrittenBy: 'anna@example.test',
      rewrittenBySource: 'roster',
      ledgerReply: true,
    });

    const after = await readRunJournal(pool, parked.runId);
    expect(after?.rewrite).toMatchObject({ reviewer: 'anna@example.test', reviewerSource: 'roster' });
    // The record of the draft the gate judged is still there to read.
    expect(after?.coverage?.groundedness).toBe(before?.coverage?.groundedness);
  });
});
