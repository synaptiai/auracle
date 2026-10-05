// End-to-end: a reviewer's edited reply reaches the customer (DEC-44, DEC-14).
//
// One case walks every hop with real ledger writes and a real HTTP exchange:
//
//   coordinator gates the reply and parks an internal note in a FreeScout
//   instance whose operator proved the note (FREESCOUT_INTERNAL_NOTE)
//   -> the reviewer saves an edited text on the case (saveReply)
//   -> the reviewer approves it (approveRun, ledgerReply)
//   -> the relay drains the outbox and sends the ledger's text
//   -> the instance holds a published message with that text, the
//      adopter's disclosure and the provenance under it
//
// The save, the relay and the adapter each have a suite of their own. This
// is the one that follows the reviewer's words from the save to the wire,
// and it checks the exact text the helpdesk received. The case ends by
// settling an artifact against src/e2e/artifacts/v1-edited-reply/
// (AGENTS.md, rule 3). Synthetic data only (DEC-18).
import { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { freeScoutCapabilities, FreeScoutEgressAdapter, parseDraftId } from '../adapters/freescout.js';
import { CUSTOMER_REPLY_ACTION_CLASS } from '../adapters/types.js';
import { approveRun } from '../approval/approve.js';
import { saveReply } from '../approval/save-reply.js';
import { replyDigest } from '../approval/shown.js';
import { coordinateTicket } from '../coordinator/coordinator.js';
import type { CoordinateInput, CoordinatorDeps } from '../coordinator/coordinator.js';
import { enqueueTicket } from '../coordinator/intake.js';
import { dbUrl } from '../db/config.js';
import { FakeProvider } from '../models/fake.js';
import type { FakeStep } from '../models/fake.js';
import { relayPending } from '../relay/relay.js';
import { indexDocument } from '../retriever/retriever.js';
import { E2eArtifact } from '../test-support/e2e-artifact.js';
import { captureRun } from '../test-support/e2e-ledger.js';
import {
  FREESCOUT_TEST_API_KEY,
  FREESCOUT_TEST_USER_ID,
  FakeFreeScout,
} from '../test-support/freescout-wire.js';
import { truncateLedger } from '../test-support/schema.js';

const pool = new Pool({ connectionString: dbUrl(), max: 10 });

// src/test-support/db-global-setup.ts guarantees a reachable database before
// the workers fork. A failure here is a fault, and a suite that skipped
// itself instead would report success while proving nothing.
await pool.query('SELECT 1');

const PINS = { promptVer: 'e2e-edited-prompt', modelVer: 'e2e-edited-model' };
const TICKET_TEXT = 'I was charged twice for one order. Can you refund the duplicate?';
const DISCLOSURE = 'This reply was drafted by an automated assistant and approved by a person.';
/** The FreeScout conversation the ticket is, and so the ticket id. */
const CONVERSATION = '4101';
const REVIEWER = 'synthetic-reviewer@example.test';
/** A second reviewer approves, so the saver and the approver can be told apart. */
const APPROVER = 'synthetic-approver@example.test';
/** The words the reviewer saves in place of the model's draft. */
const EDITED =
  'We refunded the duplicate charge today. Your bank posts refunds in five business days.';
const DIM = 1536;
/** One shared direction for document and query, so retrieval ranks the document first. */
const VEC = Array.from({ length: DIM }, (_, index) => (index === 0 ? 1 : 0));

const FIXTURE_DOC = {
  docId: 'd1',
  kind: 'document',
  title: 'Refund a duplicate charge',
  body: 'A duplicate charge is refunded to the original card. Banks post refunds in five business days.',
  owner: 'synthetic-owner',
  reviewBy: '2999-01-01',
} as const;

function script(): FakeStep[] {
  return [
    ...Array.from({ length: 9 }, () => ({ text: 'billing_question' })),
    { vectors: [VEC] },
    { text: '[doc:d1] We will refund the duplicate charge to your card.' },
    { text: 'VERDICT: SUPPORTED' },
  ];
}

const TAXONOMY = {
  intents: [{ id: 'billing_question', label: 'Billing question', risk_tier: 'low' }],
} as const;
const LIMITS = { maxCostMicros: 100_000_000, maxSteps: 50 } as const;

let instance: FakeFreeScout;
let adapter: FreeScoutEgressAdapter;

function makeDeps(): CoordinatorDeps {
  return {
    pool,
    provider: new FakeProvider(script()),
    taxonomy: { intents: TAXONOMY.intents.map((intent) => ({ ...intent })) },
    capabilities: freeScoutCapabilities(true),
    egress: adapter,
    pins: PINS,
    limits: { ...LIMITS, deadlineAt: new Date(Date.now() + 60_000) },
    partitionCount: 8,
  };
}

describe('an edited reply, from the save to the customer', () => {
  beforeEach(async () => {
    instance = new FakeFreeScout();
    await instance.start();
    adapter = new FreeScoutEgressAdapter({
      baseUrl: instance.baseUrl,
      apiKey: FREESCOUT_TEST_API_KEY,
      userId: FREESCOUT_TEST_USER_ID,
      internalNote: true,
      timeoutMs: 5_000,
    });
    await truncateLedger(pool);
    await indexDocument(pool, { ...FIXTURE_DOC }, VEC);
    instance.conversations.set(CONVERSATION, []);
  });

  afterEach(async () => {
    await instance.stop();
    await truncateLedger(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('sends the text the reviewer saved, with the disclosure, and names who saved it', async () => {
    const enqueued = await enqueueTicket(
      pool,
      { ticketId: CONVERSATION, messageId: `m-1-${CONVERSATION}@example.test`, ticketText: TICKET_TEXT },
      8,
    );
    const ticket: CoordinateInput = {
      ticketId: CONVERSATION,
      ticketText: TICKET_TEXT,
      epoch: 1n,
      conversationId: enqueued.conversationId,
      turnNumber: enqueued.turnNumber,
      actionClass: CUSTOMER_REPLY_ACTION_CLASS,
      actionPayload: { summary: 'duplicate charge refund' },
      delivery: 'at_least_once',
      isCustomerVisible: true,
      disclosure: DISCLOSURE,
    };
    const artifact = new E2eArtifact('v1-edited-reply/saved-edit-reaches-customer', {
      seed: null,
      inputs: {
        ticket,
        script: script(),
        document: FIXTURE_DOC,
        taxonomy: TAXONOMY,
        capabilities: freeScoutCapabilities(true),
        pins: PINS,
        reviewer: REVIEWER,
        approver: APPROVER,
        edited: EDITED,
      },
    });
    artifact.vary(enqueued.conversationId, 'conversation');

    // 1. The coordinator gates the reply and parks an internal note.
    const gated = await coordinateTicket(makeDeps(), ticket);
    if (gated.outcome !== 'awaiting_approval') {
      throw new Error(`expected the reply to park, got ${gated.outcome}`);
    }
    const runId = gated.runId;
    const park = await pool.query<{ body: string; provenance: { generatedAt: string } }>(
      "SELECT result->>'body' AS body, result->'provenance' AS provenance FROM step_journal WHERE run_id = $1 AND step_id = 'park'",
      [runId],
    );
    const parkedBody = park.rows[0]!.body;
    const parkedAt = park.rows[0]!.provenance.generatedAt;
    artifact.vary(parkedAt, 'parked-at');
    expect(parkedBody).not.toBe(EDITED);
    const { threadId: noteId } = parseDraftId(gated.draftExternalId!);
    expect(instance.threadsOf(CONVERSATION).map((thread) => [String(thread.id), thread.type]))
      .toEqual([[noteId, 'note']]);

    // 2. The reviewer saves an edit, from a page that drew the parked reply.
    expect(
      await saveReply(pool, runId, EDITED, {
        shown: replyDigest(parkedBody),
        savedBy: REVIEWER,
        savedBySource: 'roster',
      }),
    ).toEqual({ outcome: 'saved' });

    // 3. The reviewer approves it, from a page that drew the saved text.
    const approval = await approveRun(pool, runId, {
      ledgerReply: true,
      readDraft: adapter,
      approvedBy: APPROVER,
      approvedBySource: 'roster',
      shown: replyDigest(EDITED),
    });
    expect(approval.outcome).toBe('approved');

    // 4. The relay sends the reply the ledger holds.
    const relayed = await relayPending(pool, adapter);
    expect(relayed.map((result) => result.outcome)).toEqual(['sent']);

    // 5. The instance holds the reviewer's words as a published message. The
    // expected text is the trailer DEC-14 and DEC-33 require, in the text form
    // src/adapters/reply-text.ts states for a channel with no structured
    // fields: the reply, the separator line, the disclosure, then the
    // provenance the park journalled. The words, the disclosure and the
    // provenance come from this case's inputs and the park's journal row, not
    // from that module. An edit keeps the model as the author, because a
    // person edited its draft rather than writing a new one (DEC-48).
    const expected =
      `${EDITED}\n\n-- \n${DISCLOSURE}\n\n`
      + `generated-by: auracle\nmodel: ${PINS.modelVer}\nprompt-version: ${PINS.promptVer}\n`
      + `generated-at: ${parkedAt}\n`;
    const threads = instance.threadsOf(CONVERSATION);
    const sent = threads.filter((thread) => thread.type === 'message');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.state).toBe('published');
    expect(sent[0]!.body).toBe(expected);
    // The note stays where it was, and it was never the copy that sent.
    expect(threads.find((thread) => String(thread.id) === noteId)?.body).toContain(parkedBody);

    // 6. The ledger names who saved the words and, apart from them, who
    // approved them. Two people, so a write that mixed the columns would show.
    const run = await pool.query<{ approved_by: string; approved_by_source: string }>(
      'SELECT approved_by, approved_by_source FROM run WHERE run_id = $1',
      [runId],
    );
    expect(run.rows[0]).toEqual({ approved_by: APPROVER, approved_by_source: 'roster' });
    const turn = await pool.query<{
      saved: string;
      approved: string;
      saved_by: string;
      saved_by_source: string;
    }>(
      `SELECT saved_reply_text AS saved, approved_reply_text AS approved,
              saved_reply_by AS saved_by, saved_reply_by_source AS saved_by_source
         FROM turn WHERE conversation_id = $1 AND turn_number = $2`,
      [enqueued.conversationId, enqueued.turnNumber],
    );
    expect(turn.rows[0]).toEqual({
      saved: EDITED,
      approved: EDITED,
      saved_by: REVIEWER,
      saved_by_source: 'roster',
    });

    // The key and the partition derive from the conversation id, which the
    // intake mints per run (DEC-24, DEC-36), so both vary with it.
    if (approval.outcome === 'approved') artifact.vary(approval.idemKey, 'idem-key');
    const partition = await pool.query<{ partition: number }>(
      'SELECT partition FROM run WHERE run_id = $1',
      [runId],
    );
    artifact.vary(String(partition.rows[0]!.partition), 'partition', ['partition']);
    artifact.observe('approval', approval);
    artifact.observe('relay', relayed.map((result) => result.outcome));
    artifact.observe('turn', turn.rows[0]);
    artifact.observe('helpdesk', threads.map((thread) => ({
      type: thread.type,
      state: thread.state,
      body: thread.body,
    })));
    artifact.observe('ledger', await captureRun(pool, runId));
    artifact.finish();
  });
});
