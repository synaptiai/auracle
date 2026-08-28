// End-to-end integration test for the full V1 flow (section 4.3 + 4.4)
// against the compose Postgres with the fake model provider.
//
// One suite walks every path a ticket can take, with real ledger writes at
// each hop:
//
//   (a) automatic   classify -> retrieve -> compose -> gate -> policy auto
//                   -> outbox -> relay -> adapter performAction, run resolved
//   (b) gated       customer reply parked as a draft with disclosure and
//                   provenance, run awaiting_approval, approve entrypoint
//                   enqueues (recording the approval-edit distance in the
//                   same commit), relay sends the draft, run resolved
//   (c) DEC-30      a send whose delivery state is unknown escalates the run
//                   and never retries
//   (d) DEC-28      a stale-epoch write is refused mid-flow; partial work stays
//
// Each hop asserts ledger state, outbox records, journal entries and the
// adapter-side effects. Synthetic data only (DEC-18).
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { approveRun } from '../approval/approve.js';
import { approvalEditDistance } from '../approval/edit_distance.js';
import { coordinateTicket } from '../coordinator/coordinator.js';
import type { CoordinateInput, CoordinatorDeps } from '../coordinator/coordinator.js';
import type {
  AdapterCapabilities,
  DeliveryState,
  EgressAdapter,
} from '../adapters/types.js';
import { HelpdeskAdapter } from '../adapters/helpdesk.js';
import { dbUrl } from '../db/config.js';
import { deriveIdemKey } from '../ledger/keys.js';
import { FakeProvider } from '../models/fake.js';
import type { FakeStep } from '../models/fake.js';
import type {
  ChatRequest,
  ChatResult,
  EmbeddingRequest,
  EmbeddingResult,
  ModelProvider,
  PinnedVersions,
} from '../models/provider.js';
import { fencedTransition } from '../ledger/insert.js';
import type { AdapterCapabilities as PolicyCapabilities } from '../policy/policy.js';
import { CUSTOMER_REPLY_ACTION_CLASS, relayPending } from '../relay/relay.js';
import { indexDocument } from '../retriever/retriever.js';

const pool = new Pool({ connectionString: dbUrl(), max: 10 });

let dbUp = true;
try {
  await pool.query('SELECT 1');
} catch {
  dbUp = false;
}

const dbDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../db');
const LEDGER_DDL = readFileSync(path.join(dbDir, '001_ledger.sql'), 'utf8');
const DOCUMENTS_DDL = readFileSync(path.join(dbDir, '002_documents.sql'), 'utf8');
const EDIT_DISTANCE_DDL = readFileSync(path.join(dbDir, '003_approval_edit_distance.sql'), 'utf8');
const TIMING_DDL = readFileSync(path.join(dbDir, '005_run_timing.sql'), 'utf8');

const PINS = { promptVer: 'e2e-flow-prompt', modelVer: 'e2e-flow-model' };
const CAPABILITIES = {
  supportsIdempotencyKey: true,
  supportsReadBack: true,
  supportsDraftState: true,
  supportsStructuredFields: true,
  supportsThreading: true,
} satisfies AdapterCapabilities;
const DIM = 1536;
const TICKET_TEXT = 'I cannot sign in to my account. How do I reset my password?';
const DISCLOSURE = 'This reply was drafted by an automated assistant and approved by a person.';
/** The queue the automatic routing action moves the ticket into. */
const TARGET_QUEUE = 'password-support';

// Seeded PRNG so every run uses identical synthetic vectors (DEC-18).
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) >>> 0;
    return t / 4294967296;
  };
}

function unitVector(seed: number): number[] {
  const rand = mulberry32(seed);
  const v = Array.from({ length: DIM }, () => rand() * 2 - 1);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

// One shared direction for document and query, so dense retrieval ranks the
// fixture document first regardless of the lexical channel.
const VEC = unitVector(42);

/**
 * Script for a run that passes both gates: 9 classifier samples, one embed
 * call, the composer draft, the claim splitter, one judge verdict. Chat
 * defaults to 1 cent in FakeProvider, so a full run spends 12 cents.
 */
function happyScript(): FakeStep[] {
  return [
    ...Array.from({ length: 9 }, () => ({ text: 'password_reset' })),
    { vectors: [VEC] },
    { text: '[doc:d1] Open the account settings page and choose reset password.' },
    { text: '- Open the account settings page and choose reset password.' },
    { text: 'VERDICT: SUPPORTED' },
  ];
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

interface DepsOverrides {
  provider?: ModelProvider;
  egress?: EgressAdapter;
}

function makeDeps(script: FakeStep[], overrides: DepsOverrides = {}): CoordinatorDeps {
  return {
    pool,
    provider: overrides.provider ?? new FakeProvider(script),
    taxonomy: {
      intents: [
        { id: 'password_reset', label: 'Password reset', risk_tier: 'low' },
        { id: 'billing_question', label: 'Billing question', risk_tier: 'low' },
        { id: 'other', label: 'Everything else', risk_tier: 'medium' },
      ],
    },
    capabilities: CAPABILITIES satisfies PolicyCapabilities,
    egress: overrides.egress ?? new HelpdeskAdapter(),
    pins: PINS,
    limits: {
      maxCostCents: 10_000,
      maxSteps: 50,
      deadlineAt: new Date(Date.now() + 60_000),
    },
    partitionCount: 8,
  };
}

function autoInput(ticketId: string, epoch: bigint): CoordinateInput {
  return {
    ticketId,
    ticketText: TICKET_TEXT,
    epoch,
    actionClass: 'route_ticket',
    actionPayload: { queue: TARGET_QUEUE },
    delivery: 'at_most_once',
    isCustomerVisible: false,
    disclosure: DISCLOSURE,
  };
}

/** A customer reply: always gated (DEC-12), always parked with disclosure. */
function replyInput(ticketId: string, epoch: bigint): CoordinateInput {
  return {
    ...autoInput(ticketId, epoch),
    actionClass: CUSTOMER_REPLY_ACTION_CLASS,
    actionPayload: { summary: 'password reset answer' },
    delivery: 'at_least_once',
    isCustomerVisible: true,
  };
}

async function indexFixtureDoc(): Promise<void> {
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
}

type RunRow = {
  state: string;
  cost_cents: number;
  steps_used: number;
  approval_edit_distance: number | null;
};

async function runRow(runId: string): Promise<RunRow | undefined> {
  const rows = await pool.query(
    `SELECT state, cost_cents, steps_used, approval_edit_distance
     FROM run WHERE run_id = $1`,
    [runId],
  );
  return rows.rows[0] as RunRow | undefined;
}

async function journalRows(
  runId: string,
): Promise<{ step_id: string; status: string; result: unknown }[]> {
  const rows = await pool.query(
    'SELECT step_id, status, result FROM step_journal WHERE run_id = $1 ORDER BY step_id',
    [runId],
  );
  return rows.rows as { step_id: string; status: string; result: unknown }[];
}

async function outboxRows(runId: string): Promise<
  { step_id: string; idem_key: string; epoch: string; action_class: string; delivery: string; status: string; payload: unknown }[]
> {
  const rows = await pool.query(
    `SELECT step_id, idem_key, epoch::text AS epoch, action_class, delivery, status, payload
     FROM outbox WHERE run_id = $1`,
    [runId],
  );
  return rows.rows as {
    step_id: string;
    idem_key: string;
    epoch: string;
    action_class: string;
    delivery: string;
    status: string;
    payload: unknown;
  }[];
}

async function ticketEpoch(ticketId: string): Promise<string | undefined> {
  const rows = await pool.query(
    'SELECT epoch::text AS epoch FROM ticket_epoch WHERE ticket_id = $1',
    [ticketId],
  );
  return rows.rows[0]?.epoch as string | undefined;
}

/**
 * Egress fake for the DEC-30 case: no idempotency support, no read-back,
 * and every send fails after transmit, leaving the delivery state unknown.
 */
class UnknownDeliveryEgress implements EgressAdapter {
  readonly name = 'unknown-delivery';

  readonly capabilities: AdapterCapabilities = Object.freeze({
    supportsIdempotencyKey: false,
    supportsReadBack: false,
    supportsDraftState: false,
    supportsStructuredFields: false,
    supportsThreading: false,
  });

  attempts = 0;

  async createDraft(): Promise<{ readonly draftExternalId: string }> {
    throw new Error('this fake never parks drafts');
  }

  async sendDraft(): Promise<{ readonly externalId: string }> {
    this.attempts += 1;
    throw new Error('connection lost mid-send; delivery state unknown');
  }

  async performAction(): Promise<{ readonly externalId: string }> {
    this.attempts += 1;
    throw new Error('connection lost mid-write; delivery state unknown');
  }

  async readBack(): Promise<DeliveryState> {
    throw new Error('read-back must not run without supportsReadBack');
  }
}

/**
 * Provider wrapper for the fencing case: bumps the ticket's accepted epoch
 * while the retrieve step runs, simulating another writer taking the lease
 * between two coordinator hops (DEC-27 rebalance overlap).
 */
class EpochBumpingProvider implements ModelProvider {
  constructor(
    private readonly inner: FakeProvider,
    private readonly ticketId: string,
    private readonly bumpTo: bigint,
  ) {}

  complete(call: ChatRequest & PinnedVersions): Promise<ChatResult> {
    return this.inner.complete(call);
  }

  async embed(call: EmbeddingRequest & PinnedVersions): Promise<EmbeddingResult> {
    // The 'classified' transition has committed; the next fenced write must
    // see a higher accepted epoch than this run carries.
    await pool.query('UPDATE ticket_epoch SET epoch = $2 WHERE ticket_id = $1', [
      this.ticketId,
      this.bumpTo.toString(),
    ]);
    return this.inner.embed(call);
  }
}

describe.skipIf(!dbUp)('V1 flow end to end', () => {
  beforeEach(async () => {
    await pool.query(LEDGER_DDL);
    await pool.query(DOCUMENTS_DDL);
    await pool.query(EDIT_DISTANCE_DDL);
    await pool.query(TIMING_DDL);
    await pool.query('TRUNCATE run, ticket_epoch, step_journal, outbox, document');
    await indexFixtureDoc();
  });

  afterEach(async () => {
    await pool.query('TRUNCATE run, ticket_epoch, step_journal, outbox, document');
  });

  it('(a) automatic path: classify -> gate auto -> outbox -> relay applies the write once', async () => {
    const ticketId = 'T-' + randomUUID().slice(0, 8);
    const helpdesk = helpdeskWith(ticketId);

    const result = await coordinateTicket(makeDeps(happyScript(), { egress: helpdesk }), autoInput(ticketId, 1n));
    expect(result.outcome).toBe('resolved');
    if (result.outcome !== 'resolved') return;
    const { runId } = result;

    // Ledger: the run resolved with full cost and step accounting.
    expect(await runRow(runId)).toMatchObject({
      state: 'resolved',
      cost_cents: 12, // 12 chat calls at FakeProvider's 1-cent default; embed costs 0
      steps_used: 5,
      approval_edit_distance: null, // never approved; stays out of the daily sample
    });
    expect(await ticketEpoch(ticketId)).toBe('1');

    // Journal: every hop done, gate decision recorded.
    const steps = await journalRows(runId);
    expect(steps.map((s) => s.step_id).sort()).toEqual([
      'classify',
      'compose',
      'execute',
      'gate',
      'retrieve',
    ]);
    for (const step of steps) expect(step.status).toBe('done');
    expect(steps.find((s) => s.step_id === 'classify')?.result).toMatchObject({
      intentId: 'password_reset',
      agreement: 1,
    });
    expect(steps.find((s) => s.step_id === 'gate')?.result).toMatchObject({
      groundedness: 1,
      decision: 'auto',
    });

    // Outbox: exactly one pending record carrying the semantic key (DEC-24),
    // the run's epoch (DEC-28) and the declared delivery rule (DEC-29).
    const expectedKey = deriveIdemKey({
      actionClass: 'route_ticket',
      ticketId,
      payload: { queue: TARGET_QUEUE },
    });
    expect(await outboxRows(runId)).toEqual([
      {
        step_id: 'execute',
        idem_key: expectedKey,
        epoch: '1',
        action_class: 'route_ticket',
        delivery: 'at_most_once',
        status: 'pending',
        payload: { queue: TARGET_QUEUE },
      },
    ]);

    // Relay: sends through performAction, then sets the status second.
    expect(await relayPending(pool, helpdesk)).toEqual([
      { idemKey: expectedKey, outcome: 'sent' },
    ]);

    expect(await outboxRows(runId)).toEqual([
      expect.objectContaining({ idem_key: expectedKey, status: 'sent' }),
    ]);
    expect((await runRow(runId))?.state).toBe('resolved'); // success touches nothing else

    // Adapter-side effect applied exactly once: the ticket moved queues.
    expect(helpdesk.getTicket(ticketId)?.queue).toBe(TARGET_QUEUE);
    expect(helpdesk.listDeliveries()).toHaveLength(1);

    // A later scan finds nothing pending and never re-applies (DEC-24).
    expect(await relayPending(pool, helpdesk)).toEqual([]);
    expect(helpdesk.listDeliveries()).toHaveLength(1);
  });

  it('(b) gated path: park draft -> approve records edit distance -> relay sends the draft', async () => {
    const ticketId = 'T-' + randomUUID().slice(0, 8);
    const helpdesk = helpdeskWith(ticketId);

    const result = await coordinateTicket(makeDeps(happyScript(), { egress: helpdesk }), replyInput(ticketId, 1n));
    expect(result.outcome).toBe('awaiting_approval');
    if (result.outcome !== 'awaiting_approval') return;
    const { runId, draftExternalId } = result;

    // Ledger: waiting on a person; nothing relayable yet.
    expect(await runRow(runId)).toMatchObject({ state: 'awaiting_approval' });
    expect(await outboxRows(runId)).toEqual([]);

    // Adapter side: the draft sits in the target system with disclosure
    // (DEC-14) and provenance (DEC-33) attached.
    const draft = helpdesk.getDraft(draftExternalId);
    expect(draft).toMatchObject({
      ticketExternalId: ticketId,
      status: 'draft',
      disclosure: DISCLOSURE,
      provenance: {
        generatedBy: 'auracle',
        modelId: PINS.modelVer,
        promptVer: PINS.promptVer,
      },
    });
    expect(draft?.body).toContain('account settings');

    // Journal: the park step holds everything approve needs later, ledger-only.
    const park = (await journalRows(runId)).find((s) => s.step_id === 'park');
    expect(park?.result).toMatchObject({
      draftExternalId,
      actionClass: CUSTOMER_REPLY_ACTION_CLASS,
      delivery: 'at_least_once',
      body: draft?.body,
    });

    // A person edits the draft before sending. Approve enqueues the send and
    // records the edit distance in the same commit as the state move.
    const finalBody = draft!.body + ' Thank you.';
    const approval = await approveRun(pool, runId, { finalBody });
    expect(approval).toEqual({
      outcome: 'approved',
      idemKey: deriveIdemKey({
        actionClass: CUSTOMER_REPLY_ACTION_CLASS,
        ticketId,
        payload: { draftExternalId },
      }),
    });

    // One row read back shows both writes visible together after the
    // commit. That alone cannot distinguish one commit from two; the
    // rollback case in the next test proves they also fail together.
    const afterApproval = await runRow(runId);
    expect(afterApproval?.state).toBe('resolved');
    expect(afterApproval?.approval_edit_distance).toBeGreaterThan(0);
    expect(afterApproval?.approval_edit_distance).toBeLessThan(1);

    // Outbox: the relayable record, still pending until the relay scans.
    const rows = await outboxRows(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      idem_key: approval.idemKey,
      epoch: '1',
      action_class: CUSTOMER_REPLY_ACTION_CLASS,
      delivery: 'at_least_once',
      status: 'pending',
      payload: { draftExternalId },
    });

    // Relay routes the customer reply through sendDraft.
    expect(await relayPending(pool, helpdesk)).toEqual([
      { idemKey: approval.idemKey, outcome: 'sent' },
    ]);
    expect(helpdesk.getDraft(draftExternalId)?.status).toBe('sent');
    expect(helpdesk.listDeliveries()).toHaveLength(1);

    // A repeat pass dedupes on the semantic key (DEC-24).
    expect(await relayPending(pool, helpdesk)).toEqual([]);
    expect(helpdesk.listDeliveries()).toHaveLength(1);
  });

  it('(b) a failing measurement rolls the whole approval back (atomicity)', async () => {
    // The crash-safety half of the card: if the measurement write fails
    // inside the approval transaction, the approval itself must not commit.
    // A crash can lose both sides together, never one.
    const ticketId = 'T-' + randomUUID().slice(0, 8);
    const helpdesk = helpdeskWith(ticketId);
    const result = await coordinateTicket(makeDeps(happyScript(), { egress: helpdesk }), replyInput(ticketId, 1n));
    if (result.outcome !== 'awaiting_approval') throw new Error(`unexpected ${result.outcome}`);
    const { runId, draftExternalId } = result;

    const idemKey = deriveIdemKey({
      actionClass: CUSTOMER_REPLY_ACTION_CLASS,
      ticketId,
      payload: { draftExternalId },
    });
    await expect(
      fencedTransition(pool, {
        runId,
        state: 'resolved',
        costCents: 12,
        stepsUsed: 4,
        fromState: 'awaiting_approval',
        outbox: {
          stepId: 'approve',
          idemKey,
          actionClass: CUSTOMER_REPLY_ACTION_CLASS,
          delivery: 'at_least_once',
          payload: { draftExternalId },
        },
        afterWrite: async () => {
          throw new Error('measurement write failed');
        },
      }),
    ).rejects.toThrow('measurement write failed');

    // Nothing committed: the run keeps its prior state, no relayable record
    // exists, and the metric stays null for the daily sample.
    const after = await runRow(runId);
    expect(after?.state).toBe('awaiting_approval');
    expect(after?.approval_edit_distance).toBeNull();
    expect(await outboxRows(runId)).toEqual([]);

    // The key never landed either: an approve call after recovery still
    // inserts its outbox row under the same semantic identity (DEC-24).
    expect(await approveRun(pool, runId)).toEqual({ outcome: 'approved', idemKey });
    expect((await runRow(runId))?.state).toBe('resolved');
  });

  it('(b) approving without a captured body leaves the edit distance null', async () => {
    const ticketId = 'T-' + randomUUID().slice(0, 8);
    const helpdesk = helpdeskWith(ticketId);
    const result = await coordinateTicket(makeDeps(happyScript(), { egress: helpdesk }), replyInput(ticketId, 1n));
    if (result.outcome !== 'awaiting_approval') throw new Error(`unexpected ${result.outcome}`);

    expect(await approveRun(pool, result.runId)).toMatchObject({ outcome: 'approved' });
    const after = await runRow(result.runId);
    expect(after?.state).toBe('resolved');
    expect(after?.approval_edit_distance).toBeNull();
  });

  it('(b) approving an unchanged body records an edit distance of exactly 0', async () => {
    const ticketId = 'T-' + randomUUID().slice(0, 8);
    const helpdesk = helpdeskWith(ticketId);
    const result = await coordinateTicket(makeDeps(happyScript(), { egress: helpdesk }), replyInput(ticketId, 1n));
    if (result.outcome !== 'awaiting_approval') throw new Error(`unexpected ${result.outcome}`);
    const parkedBody = helpdesk.getDraft(result.draftExternalId!)!.body;

    await approveRun(pool, result.runId, { finalBody: parkedBody });
    expect((await runRow(result.runId))?.approval_edit_distance).toBe(0);
  });

  it('(b) approving with read-back records the true distance and sends the edited draft', async () => {
    const ticketId = 'T-' + randomUUID().slice(0, 8);
    const helpdesk = helpdeskWith(ticketId);
    const result = await coordinateTicket(makeDeps(happyScript(), { egress: helpdesk }), replyInput(ticketId, 1n));
    if (result.outcome !== 'awaiting_approval') throw new Error(`unexpected ${result.outcome}`);
    const { runId, draftExternalId } = result;
    const parkedBody = helpdesk.getDraft(draftExternalId)!.body;

    // A person edits the parked draft in the helpdesk, then approves with
    // read-back: the CLI fetches the current body from the adapter, so the
    // distance measures the parked body against the real edit.
    const editedBody = parkedBody + ' The link stays valid for one hour.';
    await helpdesk.editDraft(draftExternalId, editedBody);

    const approval = await approveRun(pool, runId, { readDraft: helpdesk });
    expect(approval.outcome).toBe('approved');
    const after = await runRow(runId);
    expect(after?.state).toBe('resolved');
    expect(after?.approval_edit_distance).toBe(approvalEditDistance(parkedBody, editedBody));

    // The relay sends through the same adapter, so the customer receives
    // the edited body the metric measured.
    expect(await relayPending(pool, helpdesk)).toHaveLength(1);
    expect(helpdesk.getDraft(draftExternalId)?.body).toBe(editedBody);
    expect(helpdesk.getDraft(draftExternalId)?.status).toBe('sent');
  });

  it('(b) read-back finds no draft and refuses the approval', async () => {
    const ticketId = 'T-' + randomUUID().slice(0, 8);
    const helpdesk = helpdeskWith(ticketId);
    const result = await coordinateTicket(makeDeps(happyScript(), { egress: helpdesk }), replyInput(ticketId, 1n));
    if (result.outcome !== 'awaiting_approval') throw new Error(`unexpected ${result.outcome}`);
    const { runId, draftExternalId } = result;

    // The draft is gone from the target system. Approving would fabricate
    // the distance, so the call refuses and commits nothing.
    const refusal = await approveRun(pool, runId, { readDraft: new HelpdeskAdapter() });
    expect(refusal).toEqual({ outcome: 'draft_missing', draftExternalId });
    expect((await runRow(runId))?.state).toBe('awaiting_approval');
    expect((await runRow(runId))?.approval_edit_distance).toBeNull();
    expect(await outboxRows(runId)).toEqual([]);
  });

  it('(c) DEC-30: a send with unknown delivery state escalates and never retries', async () => {
    const ticketId = 'T-' + randomUUID().slice(0, 8);

    // The run takes the automatic path against the honest capability set.
    const result = await coordinateTicket(makeDeps(happyScript()), autoInput(ticketId, 1n));
    expect(result.outcome).toBe('resolved');

    // At relay time only a degraded adapter remains: no idempotency support,
    // no read-back, and the send dies mid-flight. The delivery state is
    // unknown, so the record must escalate, not retry.
    const egress = new UnknownDeliveryEgress();
    const rows = await outboxRows(result.runId);
    expect(rows).toHaveLength(1);
    const idemKey = rows[0]!.idem_key;

    expect(await relayPending(pool, egress)).toEqual([
      { idemKey, outcome: 'delivery_unknown_escalated' },
    ]);
    expect(egress.attempts).toBe(1);

    // Ledger: the record states the uncertainty, the run left 'resolved'
    // for the approval path (DEC-30 hand-off).
    expect(rows[0]).toMatchObject({ status: 'pending' });
    expect(await outboxRows(result.runId)).toEqual([
      expect.objectContaining({ idem_key: idemKey, status: 'delivery_unknown' }),
    ]);
    expect((await runRow(result.runId))?.state).toBe('escalated');

    // A later scan finds nothing pending: escalation is terminal for the
    // relay, so no second attempt can ever happen.
    await expect(relayPending(pool, egress)).resolves.toEqual([]);
    expect(egress.attempts).toBe(1);
  });

  it('(d) fencing: a stale-epoch write is refused mid-flow and partial work stays', async () => {
    const ticketId = 'T-' + randomUUID().slice(0, 8);
    const deps = makeDeps(happyScript(), {
      provider: new EpochBumpingProvider(new FakeProvider(happyScript()), ticketId, 999n),
    });

    const result = await coordinateTicket(deps, autoInput(ticketId, 1n));

    // DEC-28: the run's epoch (1) lost to the ticket's accepted epoch (999).
    expect(result.outcome).toBe('stale_epoch');
    if (result.outcome !== 'stale_epoch') return;
    expect(result.highestAcceptedEpoch).toBe(999n);

    // Partial work kept (section 4.3): the run stopped where it stood when
    // the fence fired — classified, one model step spent.
    const after = await runRow(result.runId);
    expect(after).toMatchObject({ state: 'classified', cost_cents: 9, steps_used: 1 });
    expect(await ticketEpoch(ticketId)).toBe('999');

    const steps = await journalRows(result.runId);
    expect(steps.find((s) => s.step_id === 'classify')).toMatchObject({ status: 'done' });
    // Retrieve finished its work; only its fenced transition was refused.
    expect(steps.find((s) => s.step_id === 'retrieve')).toMatchObject({ status: 'done' });

    // Nothing external was ever queued.
    expect(await outboxRows(result.runId)).toEqual([]);
  });

  afterAll(async () => {
    await pool.end();
  });
});
