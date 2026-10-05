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
import { readSavedReply, recordSavedReply } from '../ledger/conversation.js';
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

async function saver(conversationId: string): Promise<{ by: string | null; source: string | null }> {
  const rows = await pool.query<{ by: string | null; source: string | null }>(
    `SELECT saved_reply_by AS by, saved_reply_by_source AS source FROM turn
      WHERE conversation_id = $1 AND turn_number = 1`,
    [conversationId],
  );
  return rows.rows[0] ?? { by: null, source: null };
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

  it('records who saved the reply and where that name came from (DEC-45)', async () => {
    const { runId, conversationId } = await parkOnTurnOne();

    await saveReply(pool, runId, 'A reply a person edited.', {
      savedBy: 'reviewer-a@example.test',
      savedBySource: 'roster',
    });

    expect(await saver(conversationId)).toEqual({ by: 'reviewer-a@example.test', source: 'roster' });
  });

  it('names the latest saver, because the latest text is theirs', async () => {
    const { runId, conversationId } = await parkOnTurnOne();

    await saveReply(pool, runId, 'The first text.', { savedBy: 'reviewer-a@example.test', savedBySource: 'roster' });
    await saveReply(pool, runId, 'The second text.', { savedBy: 'reviewer-b@example.test', savedBySource: 'header' });

    expect(await saved(conversationId)).toBe('The second text.');
    expect(await saver(conversationId)).toEqual({ by: 'reviewer-b@example.test', source: 'header' });
  });

  it('records a save nobody named as unattributed, not as a person', async () => {
    const { runId, conversationId } = await parkOnTurnOne();

    await saveReply(pool, runId, 'A reply with no named author.');

    expect(await saver(conversationId)).toEqual({ by: 'unattributed', source: 'none' });
  });

  it('refuses a saver with no source, and a source outside the vocabulary', async () => {
    // The pair is the record. The database holds it to that, so a write from
    // outside this code cannot leave a name with no account of where it came from.
    const { conversationId } = await parkOnTurnOne();
    await expect(
      pool.query(
        `UPDATE turn SET saved_reply_by = 'reviewer-a@example.test'
          WHERE conversation_id = $1 AND turn_number = 1`,
        [conversationId],
      ),
    ).rejects.toThrow(/saved_reply_by/);
    await expect(
      pool.query(
        `UPDATE turn SET saved_reply_by = 'reviewer-a@example.test', saved_reply_by_source = 'guess'
          WHERE conversation_id = $1 AND turn_number = 1`,
        [conversationId],
      ),
    ).rejects.toThrow(/saved_reply_by_source/);
  });

  it('refuses a name paired with a source that contradicts it', async () => {
    // `none` means nobody was named, and `unattributed` is how that is written.
    const { runId, conversationId } = await parkOnTurnOne();
    await saveReply(pool, runId, 'A reply a person edited.', { savedBy: 'reviewer-a@example.test' });
    for (const [by, source] of [['unattributed', 'roster'], ['reviewer-a@example.test', 'none']]) {
      await expect(
        pool.query(
          `UPDATE turn SET saved_reply_by = $2, saved_reply_by_source = $3
            WHERE conversation_id = $1 AND turn_number = 1`,
          [conversationId, by, source],
        ),
        `${by} with ${source}`,
      ).rejects.toThrow(/saved_reply_by_source_check/);
    }
  });

  it('records a saver the way every writer does, whichever caller writes the turn', async () => {
    // The lowest writer checks the name itself, so a caller that skips the
    // check cannot store a name the others would refuse (DEC-42, DEC-45).
    const { conversationId } = await parkOnTurnOne();
    const client = await pool.connect();
    try {
      await recordSavedReply(client, {
        conversationId,
        turnNumber: 1,
        bodyText: 'A reply written by a caller off the console.',
        savedBy: '  reviewer-a@example.test  ',
        savedBySource: 'none',
      });
    } finally {
      client.release();
    }
    expect(await saver(conversationId)).toEqual({ by: 'reviewer-a@example.test', source: 'header' });
  });

  it('refuses a saver with an empty name', async () => {
    // An empty name names nobody, and `unattributed` is how that is written.
    const { runId, conversationId } = await parkOnTurnOne();
    await saveReply(pool, runId, 'A reply a person edited.', { savedBy: 'reviewer-a@example.test' });
    await expect(
      pool.query(
        `UPDATE turn SET saved_reply_by = '', saved_reply_by_source = 'roster'
          WHERE conversation_id = $1 AND turn_number = 1`,
        [conversationId],
      ),
    ).rejects.toThrow(/saved_reply_by/);
  });

  it('records a named saver claimed as none as a claim, rather than failing the save', async () => {
    // `none` means nobody was named, and a name was. The pairing rule the
    // database holds would otherwise refuse the save as an error.
    const { runId, conversationId } = await parkOnTurnOne();

    expect(
      await saveReply(pool, runId, 'A reply a person edited.', {
        savedBy: 'reviewer-a@example.test',
        savedBySource: 'none',
      }),
    ).toEqual({ outcome: 'saved' });
    expect(await saver(conversationId)).toEqual({ by: 'reviewer-a@example.test', source: 'header' });
  });

  it('still runs the purge the runbook gave before this column existed', async () => {
    // Adopters copied that statement, because the repository ships no purge
    // job. It clears the text and not the saver. Refusing it would stop the
    // erasure of every customer message it also clears.
    const { runId, conversationId } = await parkOnTurnOne();
    await saveReply(pool, runId, 'A reply a person edited.', { savedBy: 'reviewer-a@example.test' });

    await pool.query(
      `UPDATE turn
          SET body_text = NULL, approved_reply_text = NULL, saved_reply_text = NULL
        WHERE conversation_id = $1`,
      [conversationId],
    );

    expect(await saved(conversationId)).toBeNull();
  });

  it('lets the retention purge clear the words and their saver together', async () => {
    // The statement the runbook gives an adopter for clearing text by age.
    const { runId, conversationId } = await parkOnTurnOne();
    await saveReply(pool, runId, 'A reply a person edited.', { savedBy: 'reviewer-a@example.test' });

    await pool.query(
      `UPDATE turn
          SET body_text = NULL, approved_reply_text = NULL, saved_reply_text = NULL,
              saved_reply_by = NULL, saved_reply_by_source = NULL
        WHERE conversation_id = $1`,
      [conversationId],
    );

    expect(await saved(conversationId)).toBeNull();
    expect(await saver(conversationId)).toEqual({ by: null, source: null });
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
