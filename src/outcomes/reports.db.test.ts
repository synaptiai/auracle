// Each console outcome, run for real, against the two published reports
// (DEC-48, DEC-49).
//
// DEC-48's table states what `bands` and `latency` make of each outcome. The
// close, snooze and send-back suites check that by seeding a finished row
// and asking how each report counts it. A seeded row proves the counting and
// not the outcome: an outcome that wrote one more column, or moved one more
// run, would pass. So each case here parks a real reply, reads both reports,
// runs the outcome through its own entry point, and reads them again.
//
// The totals are the claim the table makes for every row: no outcome adds a
// run to either report or removes one. The cells say where the run moves
// inside them, and each case checks its row's cells, following a rewrite to
// its send and a send-back to its next attempt where the cell describes them. A hand-over has its own case in
// src/holds/holds.db.test.ts. Synthetic data only (DEC-18).
import { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { freeScoutCapabilities, FreeScoutEgressAdapter } from '../adapters/freescout.js';
import { CUSTOMER_REPLY_ACTION_CLASS } from '../adapters/types.js';
import { approveRun } from '../approval/approve.js';
import { rewriteReply } from '../approval/rewrite.js';
import { readDays } from '../bands/query.js';
import { startSentBackAttempts } from '../coordinator/consumer.js';
import { coordinateTicket } from '../coordinator/coordinator.js';
import type { CoordinatorDeps } from '../coordinator/coordinator.js';
import { enqueueTicket } from '../coordinator/intake.js';
import { dbUrl, readerDbUrl } from '../db/config.js';
import { readLatency } from '../latency/query.js';
import type { LatencyReport } from '../latency/query.js';
import { FakeProvider } from '../models/fake.js';
import type { FakeStep } from '../models/fake.js';
import { relayPending } from '../relay/relay.js';
import { indexDocument } from '../retriever/retriever.js';
import {
  FREESCOUT_TEST_API_KEY,
  FREESCOUT_TEST_USER_ID,
  FakeFreeScout,
} from '../test-support/freescout-wire.js';
import { truncateLedger } from '../test-support/schema.js';

import { closeRun } from './close.js';
import { sendBackRun } from './send-back.js';
import { snoozeRun } from './snooze.js';

const pool = new Pool({ connectionString: dbUrl(), max: 10 });
// The readers connect as the role that cannot act beyond a read.
const readers = new Pool({ connectionString: readerDbUrl(), max: 4 });

// src/test-support/db-global-setup.ts guarantees a reachable database before
// the workers fork. A failure here is a fault, and a suite that skipped
// itself instead would report success while proving nothing.
await pool.query('SELECT 1');

const PINS = { promptVer: 'reports-prompt', modelVer: 'reports-model' };
// A FreeScout instance whose operator proved the note: the adapter that
// declares a ledger-held reply, so every outcome below runs the path DEC-44
// and DEC-49 describe, and a send reaches a helpdesk over HTTP.
const CAPABILITIES = freeScoutCapabilities(true);
let instance: FakeFreeScout;
let adapter: FreeScoutEgressAdapter;
const TICKET_TEXT = 'I cannot sign in to my account. How do I reset my password?';
const DISCLOSURE = 'This reply was drafted by an automated assistant and approved by a person.';
const VEC = Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0));
const REVIEWER = 'synthetic-reviewer@example.test';
const FROM = new Date(Date.now() - 86_400_000);
const TO = new Date(Date.now() + 86_400_000);

function script(reply = '[doc:d1] Open the account settings page and choose reset password.'): FakeStep[] {
  return [
    ...Array.from({ length: 9 }, () => ({ text: 'password_reset' })),
    { vectors: [VEC] },
    { text: reply },
    { text: 'VERDICT: SUPPORTED' },
  ];
}

function makeDeps(provider: FakeProvider): CoordinatorDeps {
  return {
    pool,
    provider,
    taxonomy: { intents: [{ id: 'password_reset', label: 'Password reset', risk_tier: 'low' }] },
    capabilities: CAPABILITIES,
    egress: adapter,
    pins: PINS,
    limits: { maxCostMicros: 100_000_000, maxSteps: 50, deadlineAt: new Date(Date.now() + 60_000) },
    partitionCount: 8,
  };
}

/** One parked customer reply on the first turn of a new conversation. */
async function parkOnTurnOne(): Promise<string> {
  // A FreeScout conversation id is a number, and the ticket id is that id.
  const ticketId = String(10_000 + Math.floor(Math.random() * 90_000));
  instance.conversations.set(ticketId, []);
  const enqueued = await enqueueTicket(
    pool,
    { ticketId, messageId: `m-1-${ticketId}@example.test`, ticketText: TICKET_TEXT },
    8,
  );
  const result = await coordinateTicket(makeDeps(new FakeProvider(script())), {
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
    throw new Error(`expected the reply to park, got ${result.outcome}`);
  }
  return result.runId;
}

/** Both reports, and the parts of them each case compares. */
async function reports(): Promise<{
  dayRuns: number;
  editDistance: { notReached: number; pending: number; count: number };
  latency: LatencyReport;
  service: { count: number; unfinished: number; snoozed: number; rejected: number };
}> {
  const days = await readDays(pool, FROM, TO);
  // One day holds the run. Without this the comparisons below would pass
  // against a window that covered nothing.
  expect(days).toHaveLength(1);
  const sample = days[0]!.samples.approval_edit_distance;
  const latency = await readLatency(readers);
  expect(latency.partitions).toHaveLength(1);
  const service = latency.partitions[0]!.service;
  return {
    dayRuns: days[0]!.runs,
    editDistance: { notReached: sample.notReached, pending: sample.pending, count: sample.count },
    latency,
    service: {
      count: service.count,
      unfinished: service.unfinished,
      snoozed: service.snoozed,
      rejected: service.rejected,
    },
  };
}

/** The totals DEC-48 holds every outcome to: no run added, none removed. */
function expectSameTotals(before: Awaited<ReturnType<typeof reports>>, after: typeof before): void {
  expect(after.dayRuns).toBe(before.dayRuns);
  expect(after.latency.runs).toBe(before.latency.runs);
  expect(after.latency.partitions.map((partition) => partition.runs))
    .toEqual(before.latency.partitions.map((partition) => partition.runs));
}

describe('DEC-48: each outcome, run for real, counts for what it is', () => {
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
    await instance.stop();
    await truncateLedger(pool);
  });

  afterAll(async () => {
    await readers.end();
    await pool.end();
  });

  it('starts from a reply waiting for a person, which both reports count once', async () => {
    // The state every case below moves out of. A waiting run has no edit
    // distance yet and may still get one, and its service time is unfinished.
    await parkOnTurnOne();
    const before = await reports();
    expect(before.dayRuns).toBe(1);
    expect(before.editDistance).toEqual({ notReached: 1, pending: 1, count: 0 });
    expect(before.latency.runs).toBe(1);
    expect(before.service).toEqual({ count: 0, unfinished: 1, snoozed: 0, rejected: 0 });
  });

  it('a close: not reached and no longer pending in bands, and finished in latency', async () => {
    const runId = await parkOnTurnOne();
    const before = await reports();

    expect(await closeRun(pool, runId, {
      reason: 'The customer wrote that it is resolved.',
      closedBy: REVIEWER,
      closedBySource: 'roster',
      ledgerReply: true,
    })).toMatchObject({ outcome: 'closed' });

    const after = await reports();
    expectSameTotals(before, after);
    // "No edit distance, so the run counts as not reached": still not
    // reached, and no longer a run whose distance may yet land.
    expect(after.editDistance).toEqual({
      notReached: before.editDistance.notReached,
      pending: before.editDistance.pending - 1,
      count: before.editDistance.count,
    });
    // "Finished": its service time is now measured.
    expect(after.service).toEqual({
      ...before.service,
      count: before.service.count + 1,
      unfinished: before.service.unfinished - 1,
    });
  });

  it('a snooze: still pending in bands, and in a class of its own in latency', async () => {
    const runId = await parkOnTurnOne();
    const before = await reports();

    expect(await snoozeRun(pool, runId, {
      periodMs: 3_600_000,
      snoozedBy: REVIEWER,
      snoozedBySource: 'roster',
      ledgerReply: true,
    })).toMatchObject({ outcome: 'snoozed' });

    const after = await reports();
    expectSameTotals(before, after);
    // "Pending, beside awaiting_approval": bands reads it exactly as before.
    expect(after.editDistance).toEqual(before.editDistance);
    // "A class of its own": the wait never counts as service time.
    expect(after.service).toEqual({
      ...before.service,
      snoozed: before.service.snoozed + 1,
      unfinished: before.service.unfinished - 1,
    });
  });

  it('a rewrite: both reports unchanged until the send', async () => {
    const runId = await parkOnTurnOne();
    const before = await reports();
    const daysBefore = await readDays(pool, FROM, TO);

    expect(await rewriteReply(pool, runId, 'A reply a person wrote from scratch.', {
      rewrittenBy: REVIEWER,
      rewrittenBySource: 'roster',
      ledgerReply: true,
    })).toEqual({ outcome: 'rewritten' });

    // "Unchanged until the send" in bands, and "unchanged" in latency: the
    // whole of each report, not only its totals.
    expect(await readDays(pool, FROM, TO)).toEqual(daysBefore);
    expect(await readLatency(readers)).toEqual(before.latency);

    // "The edit distance counts, and a full rewrite reads near 1": the send,
    // which is where bands takes the distance from.
    expect(await approveRun(pool, runId, {
      ledgerReply: true,
      readDraft: adapter,
      approvedBy: REVIEWER,
      approvedBySource: 'roster',
    })).toMatchObject({ outcome: 'approved' });
    expect((await relayPending(pool, adapter)).map((result) => result.outcome)).toEqual(['sent']);
    const sent = await reports();
    expectSameTotals(before, sent);
    expect(sent.editDistance).toEqual({
      notReached: before.editDistance.notReached - 1,
      pending: before.editDistance.pending - 1,
      count: before.editDistance.count + 1,
    });
    // Normalised, so 1 is a reply with nothing of the draft left. The person's
    // reply shares no sentence with the model's draft.
    const distance = (await readDays(pool, FROM, TO))[0]!.samples.approval_edit_distance.value;
    expect(distance).toBeGreaterThan(0.8);
    expect(distance).toBeLessThanOrEqual(1);
  });

  it('a send back: no longer pending in bands, and rejected in latency', async () => {
    const runId = await parkOnTurnOne();
    const before = await reports();

    expect(await sendBackRun(pool, runId, {
      note: 'The customer asked about billing, not the password.',
      sentBackBy: REVIEWER,
      sentBackBySource: 'roster',
      ledgerReply: true,
    })).toMatchObject({ outcome: 'sent_back' });

    const after = await reports();
    expectSameTotals(before, after);
    // The old attempt ends superseded and gets no distance, so it is no
    // longer one whose distance may land. The turn still counts once.
    expect(after.editDistance).toEqual({
      notReached: before.editDistance.notReached,
      pending: before.editDistance.pending - 1,
      count: before.editDistance.count,
    });
    // "A rejected attempt sits in a class of its own, apart from service time."
    expect(after.service).toEqual({
      ...before.service,
      rejected: before.service.rejected + 1,
      unfinished: before.service.unfinished - 1,
    });

    // "The turn counts once, from its final attempt, and an attempt a
    // reviewer's note steered counts as assisted": the next attempt, started
    // the way the consumer starts it.
    const started = await startSentBackAttempts(
      makeDeps(new FakeProvider(script('[doc:d1] Your billing question is answered in the account settings.'))),
      {
        partitions: [0, 1, 2, 3, 4, 5, 6, 7],
        intervalMs: 1000,
        action: {
          actionClass: CUSTOMER_REPLY_ACTION_CLASS,
          actionPayload: { summary: 'password reset answer' },
          delivery: 'at_least_once',
          isCustomerVisible: true,
          disclosure: DISCLOSURE,
        },
      },
    );
    expect(started).toHaveLength(1);
    const days = await readDays(pool, FROM, TO);
    expect(days).toHaveLength(1);
    expect(days[0]!.runs).toBe(before.dayRuns);
    expect(days[0]!.assisted).toBe(1);
    // Latency counts runs, not turns, so the new attempt is one more run, and
    // the rejected one stays in its class.
    const latency = await readLatency(readers);
    expect(latency.runs).toBe(before.latency.runs + 1);
    expect(latency.partitions.reduce((sum, partition) => sum + partition.service.rejected, 0)).toBe(1);
  });
});
