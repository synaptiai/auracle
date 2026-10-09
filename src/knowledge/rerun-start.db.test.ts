// The attempt a published document asks for, as the consumer starts it
// (DEC-50, DEC-49).
//
// Each case walks a real turn through the coordinator with the fake model the
// suites share, publishes a document from it, embeds the document through the
// consumer's own embedding path, and runs the consumer's scans. Every row is
// synthetic (DEC-18).
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { HelpdeskAdapter } from '../adapters/helpdesk.js';
import { CUSTOMER_REPLY_ACTION_CLASS } from '../adapters/types.js';
import { startSentBackAttempts } from '../coordinator/consumer.js';
import type { ConsumerOptions } from '../coordinator/consumer.js';
import { coordinateTicket } from '../coordinator/coordinator.js';
import type { CoordinatorDeps } from '../coordinator/coordinator.js';
import { enqueueTicket } from '../coordinator/intake.js';
import { dbUrl, readerDbUrl } from '../db/config.js';
import { takeHold } from '../holds/hold.js';
import { embedPendingDocuments } from '../kb/embed-pending.js';
import { readDays } from '../bands/query.js';
import { readLatency } from '../latency/query.js';
import { fencedTransition } from '../ledger/insert.js';
import { FakeProvider } from '../models/fake.js';
import type { FakeStep } from '../models/fake.js';
import { closeRun } from '../outcomes/close.js';
import { sendBackRun } from '../outcomes/send-back.js';
import { snoozeRun, unsnoozeExpired } from '../outcomes/snooze.js';
import type { AdapterCapabilities } from '../policy/policy.js';
import { indexDocument } from '../retriever/retriever.js';
import { truncateLedger } from '../test-support/schema.js';
import { replyDigest } from '../approval/shown.js';
import { fencedInsert } from '../ledger/insert.js';
import { sendBackRun as sendBack } from '../outcomes/send-back.js';
import { publishDocument } from './publish.js';
import { RERUN_STALE_HOURS, readCaseReruns } from './rerun.js';
import { startPublishedReruns } from './rerun-start.js';

const pool = new Pool({ connectionString: dbUrl(), max: 8 });
// The readers connect as the role that cannot act beyond a read.
const readers = new Pool({ connectionString: readerDbUrl(), max: 4 });
await pool.query('SELECT 1');

afterAll(async () => {
  await readers.end();
  await pool.end();
});

const PARTITIONS = 8;
const ALL = [0, 1, 2, 3, 4, 5, 6, 7];
const PINS = { promptVer: 'rerun-prompt', modelVer: 'rerun-model' };
const TICKET_TEXT = 'Can I pause my plan while I travel?';
const DISCLOSURE = 'This reply was drafted by an automated assistant and approved by a person.';
const VEC = Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0));

function capabilities(): AdapterCapabilities {
  return {
    supportsIdempotencyKey: true,
    supportsReadBack: true,
    supportsDraftState: true,
    supportsStructuredFields: true,
    supportsThreading: true,
    supportsLedgerReply: true,
  };
}

const classify = (): FakeStep[] => Array.from({ length: 9 }, () => ({ text: 'plan_pause' }));

function depsWith(egress: HelpdeskAdapter, script: FakeStep[]): CoordinatorDeps & { provider: FakeProvider } {
  return {
    pool,
    provider: new FakeProvider(script),
    taxonomy: { intents: [{ id: 'plan_pause', label: 'Plan pause', risk_tier: 'low' }] },
    capabilities: capabilities(),
    egress,
    pins: PINS,
    limits: { maxCostMicros: 100_000_000, maxSteps: 50, deadlineAt: new Date(Date.now() + 60_000) },
    partitionCount: PARTITIONS,
  };
}

function helpdeskWith(ticketId: string): HelpdeskAdapter {
  return new HelpdeskAdapter([
    { ticketId, subject: 'Plan pause', queue: 'billing', status: 'open', customerAddress: null },
  ]);
}

function optionsFor(): ConsumerOptions {
  return {
    partitions: ALL,
    intervalMs: 1000,
    action: {
      actionClass: CUSTOMER_REPLY_ACTION_CLASS,
      actionPayload: { summary: 'plan pause answer' },
      delivery: 'at_least_once',
      isCustomerVisible: true,
      disclosure: DISCLOSURE,
    },
  };
}

interface Case {
  readonly runId: string;
  readonly ticketId: string;
  readonly conversationId: string;
  readonly turnNumber: number;
  readonly egress: HelpdeskAdapter;
}

/** Turn one of a fresh conversation, walked to an abstention or to a parked reply. */
async function walked(outcome: 'escalated' | 'awaiting_approval'): Promise<Case> {
  const ticketId = `T-${randomUUID().slice(0, 8)}`;
  const enqueued = await enqueueTicket(
    pool,
    { ticketId, messageId: `m-1-${ticketId}@mail.example`, ticketText: TICKET_TEXT, product: 'aurora' },
    PARTITIONS,
  );
  const egress = helpdeskWith(ticketId);
  const script: FakeStep[] = [
    ...classify(),
    { vectors: [VEC] },
    { text: outcome === 'escalated' ? 'ABSTAIN' : '[doc:d1] Plans renew monthly.' },
    ...(outcome === 'escalated' ? [] : [{ text: 'VERDICT: SUPPORTED' }]),
  ];
  const result = await coordinateTicket(depsWith(egress, script), {
    ticketId,
    ticketText: TICKET_TEXT,
    epoch: 1n,
    partition: enqueued.partition,
    conversationId: enqueued.conversationId,
    turnNumber: enqueued.turnNumber,
    product: 'aurora',
    actionClass: CUSTOMER_REPLY_ACTION_CLASS,
    actionPayload: { summary: 'plan pause answer' },
    delivery: 'at_least_once',
    isCustomerVisible: true,
    disclosure: DISCLOSURE,
  });
  expect(result.outcome).toBe(outcome);
  return {
    runId: result.runId, ticketId, conversationId: enqueued.conversationId, turnNumber: enqueued.turnNumber,
    egress,
  };
}

async function publish(c: Case, shown?: string): Promise<string> {
  const outcome = await publishDocument(pool, {
    ...(shown === undefined ? {} : { shown }),
    runId: c.runId,
    title: 'Pausing a plan',
    body: 'A plan may be paused once a year, for up to two months, from the billing page.',
    products: ['aurora'],
    owner: 'kb-team',
    reviewBy: '2999-01-01',
    writtenBy: 'reviewer-a',
    catalogue: ['aurora'],
    ledgerReply: true,
  });
  expect(outcome).toMatchObject({ outcome: 'published', rerun: { status: 'waiting' } });
  return (outcome as { docId: string }).docId;
}

/** The consumer's own embedding path, with the fake model's vector. */
async function embed(): Promise<void> {
  const report = await embedPendingDocuments(pool, new FakeProvider([{ vectors: [VEC] }]), 'embed-model');
  expect(report.embedded.length).toBeGreaterThan(0);
}

const scan = (partitions: readonly number[] = ALL) =>
  startPublishedReruns(pool, { partitions, ledgerReply: true });

async function request(docId: string): Promise<Record<string, unknown>> {
  const { rows } = await pool.query(
    'SELECT status, reason, started_attempt, ended_at IS NOT NULL AS ended FROM document_rerun WHERE doc_id = $1',
    [docId],
  );
  return rows[0] as Record<string, unknown>;
}

async function turnAttempt(c: Case): Promise<number> {
  const { rows } = await pool.query<{ attempt: number }>(
    'SELECT attempt FROM turn WHERE conversation_id = $1 AND turn_number = $2',
    [c.conversationId, c.turnNumber],
  );
  return rows[0]!.attempt;
}

async function runFacts(runId: string): Promise<Record<string, unknown>> {
  const { rows } = await pool.query(
    'SELECT state, finished_at, sent_back_at, send_back_note FROM run WHERE run_id = $1',
    [runId],
  );
  return rows[0] as Record<string, unknown>;
}

beforeEach(async () => {
  await truncateLedger(pool);
  await indexDocument(
    pool,
    {
      docId: 'd1', kind: 'document', title: 'Plan billing', body: 'Plans renew monthly on the billing page.',
      owner: 'synthetic-owner', reviewBy: '2999-01-01',
    },
    VEC,
  );
});

describe('a re-run a published document asked for (DEC-50)', () => {
  it('waits while the document waits for its embedding, and changes nothing', async () => {
    const c = await walked('escalated');
    const docId = await publish(c);
    expect(await scan()).toEqual({ started: [], dropped: [], failed: [], faults: [] });
    expect(await request(docId)).toEqual({ status: 'waiting', reason: null, started_attempt: null, ended: false });
    expect(await turnAttempt(c)).toBe(1);
  });

  it('raises an escalated turn once the document is embedded, and leaves the escalated run as it was', async () => {
    const c = await walked('escalated');
    const before = await runFacts(c.runId);
    const latencyBefore = await readLatency(readers);
    const docId = await publish(c);
    await embed();
    expect(await scan()).toEqual({ started: [docId], dropped: [], failed: [], faults: [] });
    expect(await request(docId)).toEqual({ status: 'started', reason: null, started_attempt: 2, ended: true });
    expect(await turnAttempt(c)).toBe(2);
    // Latency reads the run's state, finish and send-back mark, and none moved:
    // the escalated run's service time stays the system's work.
    expect(await runFacts(c.runId)).toEqual(before);
    expect(before['sent_back_at']).toBeNull();
    expect(await readLatency(readers)).toEqual(latencyBefore);
    // A second scan finds nothing waiting.
    expect(await scan()).toEqual({ started: [], dropped: [], failed: [], faults: [] });

    // The send-back scan walks the attempt with no note, and the new reply
    // cites the published document, so retrieval found it.
    const walk = depsWith(c.egress, [
      ...classify(),
      { vectors: [VEC] },
      { text: `[doc:${docId}] A plan may be paused once a year, for up to two months.` },
      { text: 'VERDICT: SUPPORTED' },
    ]);
    const started = await startSentBackAttempts(walk, optionsFor());
    expect(started).toHaveLength(1);
    const next = await pool.query<{ state: string; attempt: number; product: string }>(
      'SELECT state, attempt, product FROM run WHERE run_id = $1',
      [started[0]],
    );
    expect(next.rows[0]).toEqual({ state: 'awaiting_approval', attempt: 2, product: 'aurora' });
    const prompts = walk.provider.calls.flatMap((call) => (call.messages ?? []).map((m) => m.content));
    expect(prompts.some((text) => text.includes('A reviewer sent this back'))).toBe(false);
    // And the request is served once.
    expect(await startSentBackAttempts(walk, optionsFor())).toHaveLength(0);
  });

  it('ends a parked case through the send-back, with no note, and names the document', async () => {
    const c = await walked('awaiting_approval');
    await takeHold(pool, { runId: c.runId, reviewer: 'reviewer-a', lapseMs: 600_000 });
    const docId = await publish(c);
    await embed();
    expect(await scan()).toEqual({ started: [docId], dropped: [], failed: [], faults: [] });
    const run = await runFacts(c.runId);
    expect(run['state']).toBe('superseded');
    expect(run['sent_back_at']).not.toBeNull();
    expect(run['send_back_note']).toBeNull();
    expect(await turnAttempt(c)).toBe(2);
    const record = await pool.query<{ result: Record<string, unknown> }>(
      "SELECT result FROM step_journal WHERE run_id = $1 AND step_id = 'send_back'",
      [c.runId],
    );
    expect(record.rows[0]?.result).toMatchObject({
      note: null, reviewer: 'reviewer-a', reviewerSource: 'roster', attempt: 1,
      document: docId, documentTitle: 'Pausing a plan',
    });
    const hold = await pool.query<{ release_kind: string | null }>(
      'SELECT release_kind FROM case_hold WHERE run_id = $1',
      [c.runId],
    );
    expect(hold.rows[0]?.release_kind).toBe('send_back');
    expect(await request(docId)).toMatchObject({ status: 'started', started_attempt: 2 });
  });

  it('never starts an attempt whose document failed to embed', async () => {
    const c = await walked('escalated');
    const docId = await publish(c);
    // The state the consumer's embedding path leaves after its third refusal.
    await pool.query(
      `UPDATE document SET embedding_status = 'failed', embedding_failures = 3,
              embedding_error = 'the model refused the input: HTTP 400' WHERE doc_id = $1`,
      [docId],
    );
    expect(await scan()).toEqual({ started: [], dropped: [], failed: [docId], faults: [] });
    expect(await request(docId)).toEqual({ status: 'failed', reason: null, started_attempt: null, ended: true });
    expect(await turnAttempt(c)).toBe(1);
  });

  it('drops the request of a case that changed first, and names how', async () => {
    const closed = await walked('awaiting_approval');
    const closedDoc = await publish(closed);
    await embed();
    expect(await closeRun(pool, closed.runId, { reason: 'Answered by phone.' }))
      .toMatchObject({ outcome: 'closed' });

    const approved = await walked('awaiting_approval');
    const approvedDoc = await publish(approved);
    await embed();
    // The state an approval leaves, with the reply it records.
    expect(await fencedTransition(pool, {
      runId: approved.runId, state: 'resolved', costMicros: 0, stepsUsed: 0, fromState: 'awaiting_approval',
      afterWrite: async (client) => {
        await client.query("UPDATE run SET approved_by = 'reviewer-b', approved_by_source = 'roster' WHERE run_id = $1", [approved.runId]);
      },
    })).toEqual({ outcome: 'accepted' });

    const snoozed = await walked('awaiting_approval');
    const snoozedDoc = await publish(snoozed);
    await embed();
    expect(await snoozeRun(pool, snoozed.runId, { periodMs: 60_000 })).toMatchObject({ outcome: 'snoozed' });
    // Back in the queue before the embedding: it was still snoozed first.
    await pool.query("UPDATE run SET snoozed_until = now() - interval '1 second' WHERE run_id = $1", [snoozed.runId]);
    expect(await unsnoozeExpired(pool, ALL)).toEqual([snoozed.runId]);

    const sentBack = await walked('awaiting_approval');
    const sentBackDoc = await publish(sentBack);
    await embed();
    expect(await sendBackRun(pool, sentBack.runId, { note: 'Answer the second question.', ledgerReply: true }))
      .toEqual({ outcome: 'sent_back' });

    const answered = await walked('escalated');
    const answeredDoc = await publish(answered);
    await embed();
    await pool.query(
      `INSERT INTO outbox (run_id, step_id, idem_key, epoch, action_class, delivery, payload, status)
       VALUES ($1, 'approve', $2, 1, $3, 'at_least_once', '{}'::jsonb, 'sent')`,
      [answered.runId, `answered-${randomUUID()}`, CUSTOMER_REPLY_ACTION_CLASS],
    );

    const report = await scan();
    expect(report.started).toEqual([]);
    expect(new Map(report.dropped.map((d) => [d.docId, d.reason]))).toEqual(new Map([
      [closedDoc, 'closed'], [approvedDoc, 'approved'], [snoozedDoc, 'snoozed'],
      [sentBackDoc, 'another_attempt'], [answeredDoc, 'answered'],
    ]));
    // The request a send-back dropped left the reviewer's attempt as it was.
    expect(await turnAttempt(sentBack)).toBe(2);
    expect(await turnAttempt(answered)).toBe(1);
  });

  it('draws on the case what the scan then does', async () => {
    const c = await walked('escalated');
    const docId = await publish(c);
    const page = () => readCaseReruns(readers, c.runId, true);
    expect(await page()).toEqual([{ docId, title: 'Pausing a plan', state: { kind: 'waiting', on: 'document' } }]);
    await embed();
    expect(await page()).toEqual([{ docId, title: 'Pausing a plan', state: { kind: 'starting', faults: 0 } }]);
    await scan();
    expect(await page()).toEqual([{ docId, title: 'Pausing a plan', state: { kind: 'started', attempt: 2, runId: null } }]);
    const walk = depsWith(c.egress, [
      ...classify(), { vectors: [VEC] }, { text: `[doc:${docId}] A plan may be paused once a year.` },
      { text: 'VERDICT: SUPPORTED' },
    ]);
    const [next] = await startSentBackAttempts(walk, optionsFor());
    expect(await page()).toEqual([{ docId, title: 'Pausing a plan', state: { kind: 'started', attempt: 2, runId: next } }]);

    // A case closed while its document waits says so before any scan, and
    // the scan then records the same reason.
    const closed = await walked('awaiting_approval');
    const closedDoc = await publish(closed);
    await closeRun(pool, closed.runId, { reason: 'Answered by phone.' });
    expect(await readCaseReruns(readers, closed.runId, true))
      .toEqual([{ docId: closedDoc, title: 'Pausing a plan', state: { kind: 'dropped', reason: 'closed' } }]);
    await pool.query(
      "UPDATE document SET embedding_status = 'failed', embedding_error = 'refused' WHERE doc_id = $1",
      [closedDoc],
    );
    expect((await scan()).dropped).toEqual([{ docId: closedDoc, reason: 'closed' }]);

    // A failed document says why, from the document's own record.
    const failing = await walked('escalated');
    const failingDoc = await publish(failing);
    await pool.query(
      "UPDATE document SET embedding_status = 'failed', embedding_error = 'the model refused the input: HTTP 400' WHERE doc_id = $1",
      [failingDoc],
    );
    const failedState = { kind: 'failed', error: 'the model refused the input: HTTP 400' };
    expect(await readCaseReruns(readers, failing.runId, true))
      .toEqual([{ docId: failingDoc, title: 'Pausing a plan', state: failedState }]);
    await scan();
    expect(await readCaseReruns(readers, failing.runId, true))
      .toEqual([{ docId: failingDoc, title: 'Pausing a plan', state: failedState }]);
  });

  it("serves only the requests of the consumer's own partitions", async () => {
    const c = await walked('escalated');
    const docId = await publish(c);
    await embed();
    const { rows } = await pool.query<{ partition: number }>('SELECT partition FROM run WHERE run_id = $1', [c.runId]);
    const others = ALL.filter((p) => p !== rows[0]!.partition);
    expect(await scan(others)).toEqual({ started: [], dropped: [], failed: [], faults: [] });
    expect(await request(docId)).toMatchObject({ status: 'waiting' });
    expect(await scan([rows[0]!.partition])).toMatchObject({ started: [docId] });
  });
});

/** A second run of the case's turn at its attempt, as a redelivered message parks one. */
async function twin(c: Case, state: string, draft: string | null): Promise<string> {
  const runId = randomUUID();
  const { rows } = await pool.query<{ partition: number }>('SELECT partition FROM run WHERE run_id = $1', [c.runId]);
  expect(await fencedInsert(pool, {
    runId, ticketId: c.ticketId, partition: rows[0]!.partition, epoch: 50n, state, promptVer: 'p', modelVer: 'm',
    conversationId: c.conversationId, turnNumber: c.turnNumber, attempt: 1, product: 'aurora',
    deadlineAt: new Date(Date.now() + 60_000),
  }, null)).toEqual({ outcome: 'accepted' });
  if (draft !== null) {
    await pool.query(
      `INSERT INTO step_journal (run_id, step_id, status, result, prompt_ver, model_ver, cost_micros)
       VALUES ($1, 'park', 'done', $2, 'p', 'm', 0)`,
      [runId, JSON.stringify({ body: 'A twin reply.', draftExternalId: draft, turnNumber: c.turnNumber })],
    );
  }
  return runId;
}

describe('a re-run the reviews tried to break (DEC-50, DEC-49)', () => {
  it('clears a saved reply on the turn when it starts an escalated case, and journals it', async () => {
    const c = await walked('escalated');
    await twin(c, 'awaiting_approval', null);
    await pool.query('UPDATE turn SET saved_reply_text = $3 WHERE conversation_id = $1 AND turn_number = $2',
      [c.conversationId, c.turnNumber, 'A reply a reviewer saved on the twin.']);
    const docId = await publish(c);
    await embed();
    expect((await scan()).started).toEqual([docId]);
    const turn = await pool.query('SELECT saved_reply_text FROM turn WHERE conversation_id = $1', [c.conversationId]);
    expect(turn.rows[0].saved_reply_text).toBeNull();
    const record = await pool.query<{ result: Record<string, unknown> }>(
      "SELECT result FROM step_journal WHERE run_id = $1 AND step_id = 'send_back'", [c.runId]);
    expect(record.rows[0]?.result).toMatchObject({
      note: null, clearedReply: 'A reply a reviewer saved on the twin.', documentTitle: 'Pausing a plan', attempt: 1,
    });
    // Still unstamped, so latency keeps it as the system's work.
    expect((await runFacts(c.runId))['sent_back_at']).toBeNull();
  });

  it("drops the request when a twin of the attempt left a helpdesk copy a person could send", async () => {
    const c = await walked('escalated');
    await twin(c, 'awaiting_approval', '7001');
    const docId = await publishDocument(pool, {
      runId: c.runId, title: 'Pausing a plan', body: 'A plan may be paused once a year.', products: ['aurora'],
      owner: 'kb-team', reviewBy: '2999-01-01', writtenBy: 'reviewer-a', catalogue: ['aurora'], ledgerReply: false,
    });
    expect(docId).toMatchObject({ outcome: 'published', rerun: { status: 'dropped', reason: 'copy_could_send' } });
    expect(await turnAttempt(c)).toBe(1);
  });

  it('drops a request on the draft path that the console believed the ledger held', async () => {
    const c = await walked('awaiting_approval');
    const docId = await publish(c);
    await embed();
    expect(await startPublishedReruns(pool, { partitions: ALL, ledgerReply: false }))
      .toMatchObject({ started: [], dropped: [{ docId, reason: 'copy_could_send' }] });
    expect(await turnAttempt(c)).toBe(1);
  });

  it('drops the request once the customer writes again', async () => {
    const c = await walked('escalated');
    const docId = await publish(c);
    await enqueueTicket(pool, {
      ticketId: c.ticketId, messageId: `m-2-${c.ticketId}@mail.example`, ticketText: 'Are you there?',
      linkage: { priorMessageIds: [`m-1-${c.ticketId}@mail.example`] }, product: 'aurora',
    }, PARTITIONS);
    await embed();
    expect((await scan()).dropped).toEqual([{ docId, reason: 'newer_turn' }]);
  });

  it('drops the request when a person saved the reply after publishing (DEC-46)', async () => {
    const c = await walked('awaiting_approval');
    const parked = await pool.query<{ body: string }>(
      "SELECT result->>'body' AS body FROM step_journal WHERE run_id = $1 AND step_id = 'park'", [c.runId]);
    const docId = await publish(c, replyDigest(parked.rows[0]!.body));
    await pool.query('UPDATE turn SET saved_reply_text = $3 WHERE conversation_id = $1 AND turn_number = $2',
      [c.conversationId, c.turnNumber, 'A reviewer edited this after publishing.']);
    await embed();
    expect((await scan()).dropped).toEqual([{ docId, reason: 'reply_changed' }]);
    expect((await runFacts(c.runId))['state']).toBe('awaiting_approval');
  });

  it('waits while the run is still in the system, rather than dropping it', async () => {
    const c = await walked('escalated');
    const walking = await twin(c, 'classified', null);
    const outcome = await publishDocument(pool, {
      runId: walking, title: 'Pausing a plan', body: 'A plan may be paused once a year.', products: ['aurora'],
      owner: 'kb-team', reviewBy: '2999-01-01', writtenBy: 'reviewer-a', catalogue: ['aurora'], ledgerReply: true,
    });
    expect(outcome).toMatchObject({ outcome: 'published', rerun: { status: 'waiting' } });
    await embed();
    expect(await scan()).toEqual({ started: [], dropped: [], failed: [], faults: [] });
    expect(await readCaseReruns(readers, walking, true)).toMatchObject([{ state: { kind: 'waiting', on: 'case' } }]);
  });

  it('reads a request that keeps faulting after the others', async () => {
    const first = await walked('escalated');
    const firstDoc = await publish(first);
    await embed();
    const second = await walked('escalated');
    const secondDoc = await publish(second);
    await embed();
    // The state a fault leaves once its delay has passed.
    await pool.query('UPDATE document_rerun SET faults = 3, checked_at = now() WHERE doc_id = $1', [firstDoc]);
    expect((await startPublishedReruns(pool, { partitions: ALL, ledgerReply: true, batch: 1 })).started)
      .toEqual([secondDoc]);
  });

  it('walks the attempt a document asked for with no earlier note, and names it in an escalation', async () => {
    // Attempt 1 parks and is sent back with a note; attempt 2 abstains; a
    // document published from attempt 2 asks for attempt 3.
    const c = await walked('awaiting_approval');
    const NOTE = 'Say what happens to the second request.';
    expect(await sendBack(pool, c.runId, { note: NOTE, ledgerReply: true })).toEqual({ outcome: 'sent_back' });
    const [second] = await startSentBackAttempts(depsWith(c.egress, [...classify(), { vectors: [VEC] }, { text: 'ABSTAIN' }]), optionsFor());
    expect((await runFacts(second!))['state']).toBe('escalated');
    const docId = await publish({ ...c, runId: second! });
    await embed();
    expect((await scan()).started).toEqual([docId]);
    expect(await turnAttempt(c)).toBe(3);
    const walk = depsWith(c.egress, [
      ...classify(), { vectors: [VEC] }, { text: `[doc:${docId}] A plan may be paused once a year.` },
      { text: 'VERDICT: SUPPORTED' },
    ]);
    const [third] = await startSentBackAttempts(walk, optionsFor());
    expect((await pool.query('SELECT attempt FROM run WHERE run_id = $1', [third])).rows[0].attempt).toBe(3);
    const prompts = walk.provider.calls.flatMap((call) => (call.messages ?? []).map((m) => m.content));
    expect(prompts.some((text) => text.includes(NOTE))).toBe(false);

    // A reply that reached the turn after the start ends the attempt with a
    // reason that names the document's request, not a send-back.
    const other = await walked('escalated');
    const otherDoc = await publish(other);
    await embed();
    expect((await scan()).started).toEqual([otherDoc]);
    await pool.query(
      `INSERT INTO outbox (run_id, step_id, idem_key, epoch, action_class, delivery, payload, status)
       VALUES ($1, 'approve', $2, 1, $3, 'at_least_once', '{}'::jsonb, 'sent')`,
      [other.runId, `sent-${randomUUID()}`, CUSTOMER_REPLY_ACTION_CLASS],
    );
    expect(await startSentBackAttempts(depsWith(other.egress, []), optionsFor())).toEqual([]);
    const ended = await pool.query<{ reason: string }>(
      `SELECT j.result->>'reason' AS reason FROM step_journal j JOIN run r ON r.run_id = j.run_id
        WHERE r.conversation_id = $1 AND j.step_id = 'escalate' AND r.attempt = 2`,
      [other.conversationId],
    );
    expect(ended.rows[0]?.reason).toMatch(/^rerun_dropped on turn 1:/);
  });
});

describe('a re-run the second review tried to break (DEC-50, DEC-46)', () => {
  it('reads an empty saved reply as none, at the publish and at the scan', async () => {
    const c = await walked('escalated');
    await pool.query("UPDATE turn SET saved_reply_text = '' WHERE conversation_id = $1", [c.conversationId]);
    const docId = await publish(c);
    await embed();
    expect((await scan()).started).toEqual([docId]);
  });

  it('starts a parked case published with the digest of the reply it holds', async () => {
    const c = await walked('awaiting_approval');
    const parked = await pool.query<{ body: string }>(
      "SELECT result->>'body' AS body FROM step_journal WHERE run_id = $1 AND step_id = 'park'", [c.runId]);
    const docId = await publish(c, replyDigest(parked.rows[0]!.body));
    await embed();
    expect((await scan()).started).toEqual([docId]);
    expect((await runFacts(c.runId))['state']).toBe('superseded');
  });

  it('drops the request of an escalated case when a reply was saved on a twin after the publish', async () => {
    const c = await walked('escalated');
    await twin(c, 'awaiting_approval', null);
    const docId = await publish(c);
    await pool.query('UPDATE turn SET saved_reply_text = $3 WHERE conversation_id = $1 AND turn_number = $2',
      [c.conversationId, c.turnNumber, 'Saved on the twin after the publish.']);
    await embed();
    expect((await scan()).dropped).toEqual([{ docId, reason: 'reply_changed' }]);
    const turn = await pool.query('SELECT saved_reply_text FROM turn WHERE conversation_id = $1', [c.conversationId]);
    expect(turn.rows[0].saved_reply_text).toBe('Saved on the twin after the publish.');
  });

  it('waits for a live walk past its deadline, and ends once the run is stale', async () => {
    const c = await walked('escalated');
    const walking = await twin(c, 'composed', null);
    const outcome = await publishDocument(pool, {
      runId: walking, title: 'Pausing a plan', body: 'A plan may be paused once a year.', products: ['aurora'],
      owner: 'kb-team', reviewBy: '2999-01-01', writtenBy: 'reviewer-a', catalogue: ['aurora'], ledgerReply: true,
    });
    const docId = (outcome as { docId: string }).docId;
    await embed();
    expect(await scan()).toEqual({ started: [], dropped: [], failed: [], faults: [] });
    // Past its deadline a walk may still be alive, so the request waits.
    await pool.query("UPDATE run SET deadline_at = now() - interval '1 second' WHERE run_id = $1", [walking]);
    expect(await scan()).toEqual({ started: [], dropped: [], failed: [], faults: [] });
    await pool.query(
      `UPDATE run SET created_at = now() - interval '${String(RERUN_STALE_HOURS)} hours' - interval '1 second'
        WHERE run_id = $1`,
      [walking],
    );
    expect((await scan()).dropped).toEqual([{ docId, reason: 'ended' }]);
    // The run then reaches a person after all, and the same post asks again.
    await pool.query("UPDATE run SET state = 'escalated', finished_at = now() WHERE run_id = $1", [walking]);
    expect(await publishDocument(pool, {
      runId: walking, title: 'Pausing a plan', body: 'A plan may be paused once a year.', products: ['aurora'],
      owner: 'kb-team', reviewBy: '2999-01-01', writtenBy: 'reviewer-a', catalogue: ['aurora'], ledgerReply: true,
    })).toEqual({ outcome: 'published', docId, repeated: true, rerun: { status: 'waiting' } });
    expect(await request(docId)).toMatchObject({ status: 'waiting', reason: null });
    // The rule judges it afresh, so the next scan starts the attempt.
    expect((await scan()).started).toEqual([docId]);
    expect(await request(docId)).toMatchObject({ status: 'started' });
  });

  it('keeps a request ended by a saved reply ended when the same post comes again', async () => {
    const c = await walked('escalated');
    await twin(c, 'awaiting_approval', null);
    const post = {
      runId: c.runId, title: 'Pausing a plan', body: 'A plan may be paused once a year.', products: ['aurora'],
      owner: 'kb-team', reviewBy: '2999-01-01', writtenBy: 'reviewer-a', catalogue: ['aurora'], ledgerReply: true,
    };
    const docId = (await publishDocument(pool, post) as { docId: string }).docId;
    await pool.query('UPDATE turn SET saved_reply_text = $3 WHERE conversation_id = $1 AND turn_number = $2',
      [c.conversationId, c.turnNumber, 'Saved by a person after the publish.']);
    await embed();
    expect((await scan()).dropped).toEqual([{ docId, reason: 'reply_changed' }]);
    // The form was written before the save, so posting it again undoes nothing.
    expect(await publishDocument(pool, post)).toEqual({
      outcome: 'published', docId, repeated: true, rerun: { status: 'dropped', reason: 'reply_changed' },
    });
    expect(await scan()).toEqual({ started: [], dropped: [], failed: [], faults: [] });
    const turn = await pool.query('SELECT saved_reply_text FROM turn WHERE conversation_id = $1', [c.conversationId]);
    expect(turn.rows[0].saved_reply_text).toBe('Saved by a person after the publish.');
    expect(await turnAttempt(c)).toBe(1);
  });

  it('leaves a request that an act of a person ended as it is when the same post comes again', async () => {
    const c = await walked('escalated');
    const post = {
      runId: c.runId, title: 'Pausing a plan', body: 'A plan may be paused once a year.', products: ['aurora'],
      owner: 'kb-team', reviewBy: '2999-01-01', writtenBy: 'reviewer-a', catalogue: ['aurora'], ledgerReply: true,
    };
    const docId = (await publishDocument(pool, post) as { docId: string }).docId;
    await embed();
    // A reason that only a person's act gives, with the case as it was before
    // that act. Only the reason then keeps the post from asking again.
    await pool.query(
      "UPDATE document_rerun SET status = 'dropped', reason = 'snoozed', ended_at = now() WHERE doc_id = $1", [docId]);
    expect(await publishDocument(pool, post)).toEqual({
      outcome: 'published', docId, repeated: true, rerun: { status: 'dropped', reason: 'snoozed' },
    });
    expect(await scan()).toEqual({ started: [], dropped: [], failed: [], faults: [] });
    expect(await turnAttempt(c)).toBe(1);
  });

  it('ends a request asked for again when the case was snoozed and woken since the first post', async () => {
    const c = await walked('escalated');
    const walking = await twin(c, 'composed', null);
    const post = {
      runId: walking, title: 'Pausing a plan', body: 'A plan may be paused once a year.', products: ['aurora'],
      owner: 'kb-team', reviewBy: '2999-01-01', writtenBy: 'reviewer-a', catalogue: ['aurora'], ledgerReply: true,
    };
    const docId = (await publishDocument(pool, post) as { docId: string }).docId;
    await embed();
    await pool.query(
      `UPDATE run SET created_at = now() - interval '${String(RERUN_STALE_HOURS)} hours' - interval '1 second'
        WHERE run_id = $1`,
      [walking],
    );
    expect((await scan()).dropped).toEqual([{ docId, reason: 'ended' }]);
    // The late walk parks the run, and a person snoozes it and it wakes.
    await pool.query("UPDATE run SET state = 'awaiting_approval' WHERE run_id = $1", [walking]);
    expect(await snoozeRun(pool, walking, { periodMs: 60_000 })).toMatchObject({ outcome: 'snoozed' });
    await pool.query("UPDATE run SET snoozed_until = now() - interval '1 second' WHERE run_id = $1", [walking]);
    expect(await unsnoozeExpired(pool, ALL)).toEqual([walking]);
    expect(await publishDocument(pool, post)).toEqual({
      outcome: 'published', docId, repeated: true, rerun: { status: 'dropped', reason: 'snoozed' },
    });
    expect(await scan()).toEqual({ started: [], dropped: [], failed: [], faults: [] });
    expect(await turnAttempt(c)).toBe(1);
  });

  it('asks again for a request that ended on a stale run, and still ends it for a reply saved since', async () => {
    const c = await walked('escalated');
    const walking = await twin(c, 'composed', null);
    const post = {
      runId: walking, title: 'Pausing a plan', body: 'A plan may be paused once a year.', products: ['aurora'],
      owner: 'kb-team', reviewBy: '2999-01-01', writtenBy: 'reviewer-a', catalogue: ['aurora'], ledgerReply: true,
    };
    const docId = (await publishDocument(pool, post) as { docId: string }).docId;
    await embed();
    await pool.query(
      `UPDATE run SET created_at = now() - interval '${String(RERUN_STALE_HOURS)} hours' - interval '1 second'
        WHERE run_id = $1`,
      [walking],
    );
    expect((await scan()).dropped).toEqual([{ docId, reason: 'ended' }]);
    await pool.query("UPDATE run SET state = 'escalated', finished_at = now() WHERE run_id = $1", [walking]);
    // A person saves a reply before the reviewer posts again.
    await pool.query('UPDATE turn SET saved_reply_text = $3 WHERE conversation_id = $1 AND turn_number = $2',
      [c.conversationId, c.turnNumber, 'Saved by a person before the repost.']);
    expect(await publishDocument(pool, post)).toEqual({
      outcome: 'published', docId, repeated: true, rerun: { status: 'dropped', reason: 'reply_changed' },
    });
    expect(await scan()).toEqual({ started: [], dropped: [], failed: [], faults: [] });
    const turn = await pool.query('SELECT saved_reply_text FROM turn WHERE conversation_id = $1', [c.conversationId]);
    expect(turn.rows[0].saved_reply_text).toBe('Saved by a person before the repost.');
  });

  it('asks again for a dropped request and reports that its document failed to embed', async () => {
    const c = await walked('escalated');
    const walking = await twin(c, 'composed', null);
    const post = {
      runId: walking, title: 'Pausing a plan', body: 'A plan may be paused once a year.', products: ['aurora'],
      owner: 'kb-team', reviewBy: '2999-01-01', writtenBy: 'reviewer-a', catalogue: ['aurora'], ledgerReply: true,
    };
    const docId = (await publishDocument(pool, post) as { docId: string }).docId;
    await pool.query(
      `UPDATE run SET created_at = now() - interval '${String(RERUN_STALE_HOURS)} hours' - interval '1 second'
        WHERE run_id = $1`,
      [walking],
    );
    expect((await scan()).dropped).toEqual([{ docId, reason: 'ended' }]);
    await pool.query(
      `UPDATE document SET embedding_status = 'failed', embedding_failures = 3,
              embedding_error = 'the model refused the input: HTTP 400' WHERE doc_id = $1`,
      [docId],
    );
    await pool.query("UPDATE run SET state = 'escalated', finished_at = now() WHERE run_id = $1", [walking]);
    expect(await publishDocument(pool, post))
      .toEqual({ outcome: 'published', docId, repeated: true, rerun: { status: 'failed' } });
    expect(await request(docId)).toEqual({ status: 'failed', reason: null, started_attempt: null, ended: true });
    expect(await turnAttempt(c)).toBe(1);
  });

  it('reads a waiting request after the ones it has not read yet', async () => {
    const first = await walked('escalated');
    const walking = await twin(first, 'composed', null);
    const waitingDoc = (await publishDocument(pool, {
      runId: walking, title: 'Pausing a plan', body: 'A plan may be paused once a year.', products: ['aurora'],
      owner: 'kb-team', reviewBy: '2999-01-01', writtenBy: 'reviewer-a', catalogue: ['aurora'], ledgerReply: true,
    }) as { docId: string }).docId;
    await embed();
    expect((await startPublishedReruns(pool, { partitions: ALL, ledgerReply: true, batch: 1 })).started).toEqual([]);
    const second = await walked('escalated');
    const secondDoc = await publish(second);
    await embed();
    expect((await startPublishedReruns(pool, { partitions: ALL, ledgerReply: true, batch: 1 })).started)
      .toEqual([secondDoc]);
    expect(await request(waitingDoc)).toMatchObject({ status: 'waiting' });
  });
});

describe('two documents from one case (DEC-50)', () => {
  it('starts one attempt once both are embedded, and marks both started', async () => {
    const c = await walked('escalated');
    const first = await publish(c);
    await embed();
    const second = (await publishDocument(pool, {
      runId: c.runId, title: 'Pausing twice', body: 'A second pause needs a new request.', products: ['aurora'],
      owner: 'kb-team', reviewBy: '2999-01-01', writtenBy: 'reviewer-a', catalogue: ['aurora'], ledgerReply: true,
    }) as { docId: string }).docId;
    // The second waits for its embedding, and the first waits with it.
    expect(await scan()).toEqual({ started: [], dropped: [], failed: [], faults: [] });
    expect(await turnAttempt(c)).toBe(1);
    await embed();
    // Both started with the one attempt, each named once, though the scan's own
    // batch also held the second.
    const report = await scan();
    expect({ ...report, started: [...report.started].sort() })
      .toEqual({ started: [first, second].sort(), dropped: [], failed: [], faults: [] });
    expect(await turnAttempt(c)).toBe(2);
    expect(await request(first)).toMatchObject({ status: 'started', started_attempt: 2 });
    expect(await request(second)).toMatchObject({ status: 'started', started_attempt: 2 });
  });
});

describe('a sibling whose own guard refuses (DEC-46)', () => {
  it('is not marked started with the attempt another document asked for', async () => {
    const c = await walked('escalated');
    const first = await publish(c);
    await embed();
    await pool.query('UPDATE turn SET saved_reply_text = $3 WHERE conversation_id = $1 AND turn_number = $2',
      [c.conversationId, c.turnNumber, 'A reply saved after the first publish.']);
    const second = (await publishDocument(pool, {
      runId: c.runId, title: 'Pausing twice', body: 'A second pause needs a new request.', products: ['aurora'],
      owner: 'kb-team', reviewBy: '2999-01-01', writtenBy: 'reviewer-a', catalogue: ['aurora'], ledgerReply: true,
    }) as { docId: string }).docId;
    await embed();
    // The first is in a fault's delay, so the scan settles the second first.
    await pool.query("UPDATE document_rerun SET retry_after = now() + interval '1 hour' WHERE doc_id = $1", [first]);
    // It ends by its own reason, in the start's own transaction, and the
    // report the consumer logs names it.
    expect(await scan()).toEqual({
      started: [second], dropped: [{ docId: first, reason: 'reply_changed' }], failed: [], faults: [],
    });
    expect(await request(first)).toMatchObject({ status: 'dropped', reason: 'reply_changed' });
  });
});

describe('a sibling whose document failed to embed', () => {
  it('ends failed with the start, and the report names it', async () => {
    const c = await walked('escalated');
    const first = await publish(c);
    await pool.query(
      "UPDATE document SET embedding_status = 'failed', embedding_error = 'refused' WHERE doc_id = $1", [first]);
    await pool.query("UPDATE document_rerun SET retry_after = now() + interval '1 hour' WHERE doc_id = $1", [first]);
    const second = (await publishDocument(pool, {
      runId: c.runId, title: 'Pausing twice', body: 'A second pause needs a new request.', products: ['aurora'],
      owner: 'kb-team', reviewBy: '2999-01-01', writtenBy: 'reviewer-a', catalogue: ['aurora'], ledgerReply: true,
    }) as { docId: string }).docId;
    await embed();
    expect(await scan()).toEqual({ started: [second], dropped: [], failed: [first], faults: [] });
    expect(await request(first)).toMatchObject({ status: 'failed' });
  });
});

describe('what a re-run changes elsewhere (DEC-50)', () => {
  it('counts the case once in bands, before and after the attempt it asked for, as assisted after', async () => {
    const c = await walked('escalated');
    const from = new Date(Date.now() - 86_400_000);
    const to = new Date(Date.now() + 86_400_000);
    const total = async (): Promise<{ runs: number; assisted: number }> => {
      const days = await readDays(pool, from, to);
      return {
        runs: days.reduce((sum, day) => sum + day.runs, 0),
        assisted: days.reduce((sum, day) => sum + day.assisted, 0),
      };
    };
    expect(await total()).toEqual({ runs: 1, assisted: 0 });
    const docId = await publish(c);
    await embed();
    expect((await scan()).started).toEqual([docId]);
    const walk = depsWith(c.egress, [
      ...classify(), { vectors: [VEC] }, { text: `[doc:${docId}] A plan may be paused once a year.` },
      { text: 'VERDICT: SUPPORTED' },
    ]);
    expect(await startSentBackAttempts(walk, optionsFor())).toHaveLength(1);
    expect(await total()).toEqual({ runs: 1, assisted: 1 });
  });

  it('delays a request that faulted, and reads it again once the delay passes', async () => {
    const c = await walked('escalated');
    const docId = await publish(c);
    await embed();
    // A real fault in the start's own transaction.
    await pool.query(`CREATE OR REPLACE FUNCTION rerun_refuse() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'refused by the test'; END $$`);
    await pool.query(`CREATE TRIGGER rerun_refuse BEFORE UPDATE ON document_rerun
      FOR EACH ROW WHEN (NEW.status = 'started') EXECUTE FUNCTION rerun_refuse()`);
    try {
      expect((await scan()).faults).toEqual([{ docId, error: 'refused by the test' }]);
    } finally {
      await pool.query('DROP TRIGGER rerun_refuse ON document_rerun');
      await pool.query('DROP FUNCTION rerun_refuse()');
    }
    const delayed = await pool.query<{ faults: number; minutes: number }>(
      `SELECT faults, round(extract(epoch FROM retry_after - clock_timestamp()) / 60)::int AS minutes
         FROM document_rerun WHERE doc_id = $1`,
      [docId],
    );
    expect(delayed.rows[0]).toEqual({ faults: 1, minutes: 1 });
    // Inside the delay the scan leaves it alone. After it, a request no scan
    // has read yet comes first, and the faulted one after it.
    expect(await scan()).toEqual({ started: [], dropped: [], failed: [], faults: [] });
    await pool.query("UPDATE document_rerun SET retry_after = now() - interval '1 second' WHERE doc_id = $1", [docId]);
    const fresh = await walked('escalated');
    const freshDoc = await publish(fresh);
    await embed();
    expect((await startPublishedReruns(pool, { partitions: ALL, ledgerReply: true, batch: 1 })).started)
      .toEqual([freshDoc]);
    expect((await scan()).started).toEqual([docId]);
    expect(await turnAttempt(c)).toBe(2);
  });
});
