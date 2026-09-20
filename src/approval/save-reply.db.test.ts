// Integration suite for the console's save (DEC-44): the reply a reviewer
// edits is written to the ledger, and the same guard the approval applies
// applies here.
//
// The coordinator runs with a FakeProvider and a real ledger, and the parked
// copy is the fixture-backed reference adapter's. Synthetic data only
// (DEC-18).
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HelpdeskAdapter } from '../adapters/helpdesk.js';
import { CUSTOMER_REPLY_ACTION_CLASS } from '../adapters/types.js';
import { coordinateTicket } from '../coordinator/coordinator.js';
import type { CoordinatorDeps } from '../coordinator/coordinator.js';
import { enqueueTicket } from '../coordinator/intake.js';
import { dbUrl } from '../db/config.js';
import { readSavedReply } from '../ledger/conversation.js';
import { FakeProvider } from '../models/fake.js';
import type { FakeStep } from '../models/fake.js';
import type { AdapterCapabilities } from '../policy/policy.js';
import { indexDocument } from '../retriever/retriever.js';
import { truncateLedger } from '../test-support/schema.js';

import { replyDigest } from './shown.js';
import { saveReply } from './save-reply.js';

const pool = new Pool({ connectionString: dbUrl(), max: 10 });

// src/test-support/db-global-setup.ts guarantees a reachable database before
// the workers fork: it starts a container, or probes an explicit
// DATABASE_URL and fails the run. A failure here is therefore a fault, and
// a suite that skipped itself instead would report success while proving
// nothing.
await pool.query('SELECT 1');

const PINS = { promptVer: 'saved-reply-prompt', modelVer: 'saved-reply-model' };
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

/** One parked customer reply on the first turn of a new conversation. */
async function parkOnTurnOne(): Promise<{
  runId: string;
  conversationId: string;
  parkedBody: string;
}> {
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
  const parked = await pool.query(
    "SELECT result->>'body' AS body FROM step_journal WHERE run_id = $1 AND step_id = 'park'",
    [result.runId],
  );
  return {
    runId: result.runId,
    conversationId: enqueued.conversationId,
    parkedBody: parked.rows[0]!.body as string,
  };
}

async function saved(conversationId: string): Promise<string | null> {
  return readSavedReply(pool, { conversationId, turnNumber: 1 });
}

describe('DEC-44: the console saves the reply a reviewer edited', () => {
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

  it('writes the text onto the turn, and the reload shows it', async () => {
    const { runId, conversationId } = await parkOnTurnOne();

    const saved_ = await saveReply(pool, runId, '  Open the account settings page and reset it.  ');

    expect(saved_).toEqual({ outcome: 'saved' });
    // Trimmed, so a stray newline from a textarea is not part of the reply a
    // later approval measures.
    expect(await saved(conversationId)).toBe('Open the account settings page and reset it.');
  });

  it('overwrites, so a second save is the one that stands', async () => {
    const { runId, conversationId } = await parkOnTurnOne();

    await saveReply(pool, runId, 'The first text.');
    await saveReply(pool, runId, 'The second text.');

    expect(await saved(conversationId)).toBe('The second text.');
  });

  it('refuses a text with nothing in it', async () => {
    const { runId, conversationId } = await parkOnTurnOne();

    expect(await saveReply(pool, runId, '   \n  ')).toEqual({ outcome: 'empty_reply' });
    expect(await saved(conversationId)).toBeNull();
  });

  it('refuses a run the ledger does not hold', async () => {
    expect(await saveReply(pool, randomUUID(), 'a reply')).toEqual({ outcome: 'unknown_run' });
  });

  it('refuses a run that is not waiting for approval, naming its state', async () => {
    const { runId, conversationId } = await parkOnTurnOne();
    await pool.query("UPDATE run SET state = 'resolved' WHERE run_id = $1", [runId]);

    expect(await saveReply(pool, runId, 'a reply')).toEqual({
      outcome: 'not_awaiting_approval',
      state: 'resolved',
    });
    expect(await saved(conversationId)).toBeNull();
  });

  it('refuses a save whose page showed other text (DEC-46)', async () => {
    const { runId, conversationId, parkedBody } = await parkOnTurnOne();
    await saveReply(pool, runId, 'What the second reviewer read.');

    // The first reviewer's page held the parked body; the ledger moved on.
    expect(await saveReply(pool, runId, 'The first reviewer writes now.', {
      shown: replyDigest(parkedBody),
    })).toEqual({ outcome: 'shown_changed' });
    expect(await saved(conversationId)).toBe('What the second reviewer read.');
  });

  it('accepts a save whose page showed the reply the ledger still holds', async () => {
    const { runId, conversationId, parkedBody } = await parkOnTurnOne();

    expect(await saveReply(pool, runId, 'An edit of the drafted reply.', {
      shown: replyDigest(parkedBody),
    })).toEqual({ outcome: 'saved' });
    expect(await saved(conversationId)).toBe('An edit of the drafted reply.');
  });

  it('refuses a run whose park names no turn, because there is no row to write', async () => {
    const { runId } = await parkOnTurnOne();
    await pool.query(
      "UPDATE step_journal SET result = result - 'turnNumber'"
        + " WHERE run_id = $1 AND step_id = 'park'",
      [runId],
    );

    expect(await saveReply(pool, runId, 'a reply')).toEqual({ outcome: 'no_turn' });
  });

  // DEC-48: the same column the rewrite writes, and the same hole until the
  // class was swept. A NUL makes Postgres raise; an unpaired surrogate is
  // silently replaced by the driver, so the customer would receive other text.
  it('refuses a reply holding a character the ledger cannot store', async () => {
    const { runId, conversationId } = await parkOnTurnOne();

    for (const text of ['An edit.\u0000And more.', 'An edit \ud800 and more.']) {
      expect(await saveReply(pool, runId, text), JSON.stringify(text))
        .toEqual({ outcome: 'unprintable_reply' });
    }
    expect(await saved(conversationId)).toBeNull();
    // A paired surrogate is one code point, and passes.
    expect(await saveReply(pool, runId, 'An edit \ud83d\ude00 and more.'))
      .toEqual({ outcome: 'saved' });
  });

  afterAll(async () => {
    await pool.end();
  });
});
