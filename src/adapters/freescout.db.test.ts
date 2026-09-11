/**
 * The FreeScout adapter across the whole gated path (DEC-11, DEC-12,
 * section 4.10): coordinator gates the reply, the approval bridge parks a
 * draft over HTTP, a person edits it, the approval reads it back and records
 * the true edit distance, and the relay sends it.
 *
 * The helpdesk suite proves this path against an adapter that keeps its
 * drafts in a Map. This one proves it against an adapter that speaks HTTP,
 * declares both delivery guarantees false, and cannot read delivery state
 * back. Those are the differences that decide whether the path still works,
 * so they need their own run rather than an argument.
 *
 * The server is the documented FreeScout wire contract, not FreeScout. See
 * `src/test-support/freescout-wire.ts`. Synthetic throughout (DEC-18).
 */
import { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { approveRun } from '../approval/approve.js';
import { approvalEditDistance } from '../approval/edit_distance.js';
import { coordinateTicket } from '../coordinator/coordinator.js';
import type { CoordinatorDeps } from '../coordinator/coordinator.js';
import { dbUrl } from '../db/config.js';
import { FakeProvider } from '../models/fake.js';
import type { FakeStep } from '../models/fake.js';
import { relayPending } from '../relay/relay.js';
import { indexDocument } from '../retriever/retriever.js';
import { truncateLedger } from '../test-support/schema.js';
import {
  FREESCOUT_TEST_API_KEY,
  FREESCOUT_TEST_USER_ID,
  FakeFreeScout,
} from '../test-support/freescout-wire.js';

import { FREESCOUT_CAPABILITIES, FreeScoutEgressAdapter, parseDraftId } from './freescout.js';
import { CUSTOMER_REPLY_ACTION_CLASS } from './types.js';

const pool = new Pool({ connectionString: dbUrl(), max: 10 });

// src/test-support/db-global-setup.ts guarantees a reachable database before the
// workers fork. A failure here is a fault, and a suite that skipped itself
// instead would report success while proving nothing.
await pool.query('SELECT 1');

const PINS = { promptVer: 'freescout-test-prompt', modelVer: 'freescout-test-model' };
const DIM = 1536;
const TICKET_TEXT = 'I cannot sign in to my account. How do I reset my password?';
const DISCLOSURE = 'This reply was drafted by an automated assistant and approved by a person.';

/** Seeded PRNG so every run uses identical synthetic vectors (DEC-18). */
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

let instance: FakeFreeScout;
let adapter: FreeScoutEgressAdapter;

function makeDeps(): CoordinatorDeps {
  return {
    pool,
    provider: new FakeProvider(happyScript()),
    taxonomy: { intents: [{ id: 'password_reset', label: 'Password reset', risk_tier: 'low' }] },
    capabilities: FREESCOUT_CAPABILITIES,
    egress: adapter,
    pins: PINS,
    limits: {
      maxCostMicros: 100_000_000,
      maxSteps: 50,
      deadlineAt: new Date(Date.now() + 60_000),
    },
    partitionCount: 8,
  };
}

/** Gates one customer reply and parks it as a FreeScout draft. */
async function parkReply(): Promise<{ runId: string; draftExternalId: string }> {
  const conversationId = String(Math.floor(Math.random() * 100_000) + 1);
  instance.conversations.set(conversationId, []);
  const result = await coordinateTicket(makeDeps(), {
    ticketId: conversationId,
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
  return { runId: result.runId, draftExternalId: result.draftExternalId! };
}

async function runState(runId: string): Promise<string | undefined> {
  const rows = await pool.query('SELECT state FROM run WHERE run_id = $1', [runId]);
  return rows.rows[0]?.state as string | undefined;
}

async function recordedDistance(runId: string): Promise<number | null> {
  const rows = await pool.query('SELECT approval_edit_distance FROM run WHERE run_id = $1', [
    runId,
  ]);
  return rows.rows[0]!.approval_edit_distance as number | null;
}

describe('the gated path through a FreeScout instance (DEC-11, DEC-12)', () => {
  beforeEach(async () => {
    instance = new FakeFreeScout();
    await instance.start();
    adapter = new FreeScoutEgressAdapter({
      baseUrl: instance.baseUrl,
      apiKey: FREESCOUT_TEST_API_KEY,
      userId: FREESCOUT_TEST_USER_ID,
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

  it('parks the gated reply as a draft in the instance, and waits for a person', async () => {
    const { runId, draftExternalId } = await parkReply();

    expect(await runState(runId)).toBe('awaiting_approval');
    const { conversationId, threadId } = parseDraftId(draftExternalId);
    const parked = instance
      .threadsOf(conversationId)
      .find((thread) => String(thread.id) === threadId);
    expect(parked?.state).toBe('draft');
    expect(parked?.body).toContain(DISCLOSURE);
  });

  it('measures what the person edited, then sends it and resolves the run', async () => {
    const { runId, draftExternalId } = await parkReply();
    const { conversationId, threadId } = parseDraftId(draftExternalId);
    const parkedBody = (await adapter.readDraft(draftExternalId))!.body;
    const parkedRaw = instance
      .threadsOf(conversationId)
      .find((thread) => String(thread.id) === threadId)!.body;

    // A person edits the reply in the FreeScout UI. The disclosure trailer
    // this adapter appended stays on the thread, and must not be counted as
    // their edit (section 4.10).
    const editedBody = `${parkedBody}\nThe link stays valid for one hour.`;
    instance.editThread(
      conversationId,
      threadId,
      parkedRaw.replace(parkedBody, editedBody),
    );

    const approval = await approveRun(pool, runId, { readDraft: adapter });
    expect(approval.outcome).toBe('approved');
    expect(await recordedDistance(runId)).toBe(approvalEditDistance(parkedBody, editedBody));

    // The relay sends the approved draft through the same adapter.
    const relayed = await relayPending(pool, adapter);
    expect(relayed.map((result) => result.outcome)).toEqual(['sent']);
    expect(await runState(runId)).toBe('resolved');

    const published = instance
      .threadsOf(conversationId)
      .filter((thread) => thread.state === 'published');
    expect(published).toHaveLength(1);
    // The whole body reaches the customer, disclosure included (DEC-14).
    expect(published[0]?.body).toContain(editedBody);
    expect(published[0]?.body).toContain(DISCLOSURE);

    // A repeat pass sends nothing more: the outbox status is what guards a
    // second send here, because this adapter honours no idempotency key.
    expect(await relayPending(pool, adapter)).toEqual([]);
    expect(
      instance.threadsOf(conversationId).filter((thread) => thread.state === 'published'),
    ).toHaveLength(1);
  });

  it('refuses the approval when the draft is gone, and nothing commits', async () => {
    const { runId, draftExternalId } = await parkReply();
    const { conversationId } = parseDraftId(draftExternalId);

    // A person deleted the draft in FreeScout. Read-back cannot find what
    // they would have edited, so approving would fabricate the distance.
    instance.conversations.set(conversationId, []);

    const refusal = await approveRun(pool, runId, { readDraft: adapter });
    expect(refusal).toEqual({ outcome: 'draft_missing', draftExternalId });
    expect(await runState(runId)).toBe('awaiting_approval');
    expect(await recordedDistance(runId)).toBeNull();
    const outbox = await pool.query('SELECT 1 FROM outbox WHERE run_id = $1', [runId]);
    expect(outbox.rows).toHaveLength(0);
  });

  it('escalates rather than reconcile when a send fails, because it cannot read back (DEC-30)', async () => {
    const { runId, draftExternalId } = await parkReply();
    const { conversationId } = parseDraftId(draftExternalId);

    const approval = await approveRun(pool, runId, { readDraft: adapter });
    expect(approval.outcome).toBe('approved');

    // The send fails after the draft was read: the published thread never
    // lands. With no read-back the state stays unknown, and DEC-30 forbids a
    // blind retry, so the relay escalates instead.
    instance.createStatus = 500;
    const relayed = await relayPending(pool, adapter);
    expect(relayed.map((result) => result.outcome)).toEqual(['delivery_unknown_escalated']);
    expect(
      instance.threadsOf(conversationId).filter((thread) => thread.state === 'published'),
    ).toHaveLength(0);
  });

  afterAll(async () => {
    await pool.end();
  });
});
