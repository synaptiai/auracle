// Integration suite for the run coordinator (section 4.3) against the
// compose Postgres: full runs on the automatic path (resolved), the approval
// path for customer replies (DEC-12), escalation by policy gate and by DEC-25
// limits with partial work kept, replay supersession through the zero-row
// outbox rule (section 4.2 rule 2, DEC-24) and stale-epoch refusal (DEC-28).
//
// The model is a FakeProvider with scripted responses; every ledger write is
// real. Synthetic data only (DEC-18).
import { randomUUID } from 'node:crypto';
import { SEED_THRESHOLDS, makeThresholds } from '../policy/policy.js';

import { applyLedgerSchema } from '../test-support/schema.js';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { coordinateTicket, partitionOf } from './coordinator.js';
import type { CoordinateInput, CoordinatorDeps } from './coordinator.js';
import { HelpdeskAdapter } from '../adapters/helpdesk.js';
import type { ModelProvider } from '../models/provider.js';
import type { EgressAdapter } from '../adapters/types.js';
import { dbUrl } from '../db/config.js';
import { deriveIdemKey } from '../ledger/keys.js';
import { FakeProvider, ONE_CENT_IN_MICROS } from '../models/fake.js';
import type { FakeStep } from '../models/fake.js';
import type { AdapterCapabilities } from '../policy/policy.js';
import { COMPENSATION_ACTION_CLASS, CUSTOMER_REPLY_ACTION_CLASS } from '../adapters/types.js';
import { indexDocument } from '../retriever/retriever.js';

const pool = new Pool({ connectionString: dbUrl(), max: 10 });

// src/test-support/global-setup.ts guarantees a reachable database before
// the workers fork: it starts a container, or probes an explicit
// DATABASE_URL and fails the run. A failure here is therefore a fault, and
// a suite that skipped itself instead would report success while proving
// nothing.
await pool.query('SELECT 1');


const PINS = { promptVer: 'coord-test-prompt', modelVer: 'coord-test-model' };
const CAPABILITIES: AdapterCapabilities = {
  supportsIdempotencyKey: true,
  supportsReadBack: true,
  supportsDraftState: true,
  supportsStructuredFields: true,
  supportsThreading: true,
};
const DIM = 1536;

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

const TICKET_TEXT = 'I cannot sign in to my account. How do I reset my password?';

/** DEC-14: the adopter's disclosure text attached to every gated reply. */
const DISCLOSURE = 'This reply was drafted by an automated assistant and approved by a person.';

/**
 * A fixture-backed helpdesk holding one synthetic ticket, so the gated
 * branch can park a draft against it (DEC-18: synthetic ids only).
 */
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

/**
 * Script for a run that passes both gates:
 * 9 classifier samples, one embed call, the composer draft, the claim
 * splitter, and one judge verdict. Chat defaults to 1 cent in FakeProvider,
 * so a full automatic run spends 12 cents.
 */
function happyScript(): FakeStep[] {
  return [
    ...Array.from({ length: 9 }, () => ({ text: 'password_reset' })),
    { vectors: [VEC] },
    { text: '[doc:d1] Open the account settings page and choose reset password.' },
    { text: 'VERDICT: SUPPORTED' },
  ];
}

function makeDeps(
  script: FakeStep[],
  limits?: Partial<CoordinatorDeps['limits']>,
  egress: EgressAdapter = new HelpdeskAdapter(),
  provider: ModelProvider = new FakeProvider(script),
): CoordinatorDeps {
  return {
    pool,
    provider,
    taxonomy: {
      intents: [
        { id: 'password_reset', label: 'Password reset', risk_tier: 'low' },
        { id: 'billing_question', label: 'Billing question', risk_tier: 'low' },
        { id: 'other', label: 'Everything else', risk_tier: 'medium' },
      ],
    },
    capabilities: CAPABILITIES,
    egress,
    pins: PINS,
    limits: {
      maxCostMicros: 100_000_000,
      maxSteps: 50,
      deadlineAt: new Date(Date.now() + 60_000),
      ...limits,
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
    actionPayload: { queue: 'password-support' },
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

async function runState(runId: string): Promise<string | undefined> {
  const rows = await pool.query('SELECT state FROM run WHERE run_id = $1', [runId]);
  return rows.rows[0]?.state as string | undefined;
}

/**
 * Journal rows for one run, ordered by step id.
 *
 * That order is alphabetical, not causal: step_journal carries no sequence
 * column, so the order a run walked its steps is not recoverable from it.
 * Assert the set of steps, never the sequence — a list assertion here reads
 * like an order check and cannot detect a reordered pipeline.
 */
async function journalRows(runId: string): Promise<{ step_id: string; status: string; result: unknown }[]> {
  const rows = await pool.query(
    'SELECT step_id, status, result FROM step_journal WHERE run_id = $1 ORDER BY step_id',
    [runId],
  );
  return rows.rows as { step_id: string; status: string; result: unknown }[];
}

describe('section 4.3 run coordinator', () => {
  beforeEach(async () => {
    await applyLedgerSchema(pool);
    await pool.query('TRUNCATE run, ticket_epoch, step_journal, outbox, document');
    await indexFixtureDoc();
  });

  afterEach(async () => {
    await pool.query('TRUNCATE run, ticket_epoch, step_journal, outbox, document');
  });

  it('drives an automatic run to resolved with journal, cost and a fenced outbox record', async () => {
    const ticketId = 'T-' + randomUUID().slice(0, 8);
    const deps = makeDeps(happyScript());

    const result = await coordinateTicket(deps, autoInput(ticketId, 1n));

    expect(result.outcome).toBe('resolved');
    expect(await runState(result.runId)).toBe('resolved');

    const runRow = await pool.query(
      'SELECT cost_micros, steps_used, partition FROM run WHERE run_id = $1',
      [result.runId],
    );
    expect(runRow.rows[0]).toMatchObject({
      // 12 chat calls at the FakeProvider default of 1 cent; the embed call costs 0.
      cost_micros: 11 * ONE_CENT_IN_MICROS,
      steps_used: 5,
      partition: partitionOf(ticketId, 8),
    });

    const steps = await journalRows(result.runId);
    expect(steps.map((s) => s.step_id).sort()).toEqual([
      'classify',
      'compose',
      'execute',
      'gate',
      'retrieve',
    ]);
    const classify = steps.find((s) => s.step_id === 'classify');
    expect(classify).toMatchObject({ status: 'done' });
    expect(classify?.result).toMatchObject({
      intentId: 'password_reset',
      agreement: 1,
    });
    for (const step of steps) expect(step.status).not.toBe('started');

    const outboxRow = await pool.query(
      'SELECT idem_key, epoch::text AS epoch, action_class, delivery, status, payload FROM outbox WHERE run_id = $1',
      [result.runId],
    );
    expect(outboxRow.rows).toHaveLength(1);
    expect(outboxRow.rows[0]).toMatchObject({
      action_class: 'route_ticket',
      delivery: 'at_most_once',
      status: 'pending',
      payload: { queue: 'password-support' },
    });
    expect((outboxRow.rows[0] as Record<string, unknown>)['idem_key']).toBe(
      deriveIdemKey({
        actionClass: 'route_ticket',
        ticketId,
        payload: { queue: 'password-support' },
      }),
    );
    expect((outboxRow.rows[0] as Record<string, unknown>)['epoch']).toBe('1');

    const fence = await pool.query(
      'SELECT epoch::text AS epoch FROM ticket_epoch WHERE ticket_id = $1',
      [ticketId],
    );
    expect(fence.rows[0]?.epoch).toBe('1');
  });

  it('pins the retrieval embedding to deps.embedModelVer, not the chat pin', async () => {
    const ticketId = 'T-' + randomUUID().slice(0, 8);
    const provider = new FakeProvider(happyScript());
    const deps: CoordinatorDeps = {
      ...makeDeps([], undefined, undefined, provider),
      embedModelVer: 'embed-test-model',
    };

    const result = await coordinateTicket(deps, autoInput(ticketId, 1n));
    expect(result.outcome).toBe('resolved');

    const embedCalls = provider.calls.filter((c) => c.kind === 'embed');
    expect(embedCalls).toHaveLength(1);
    expect(embedCalls[0]?.modelVer).toBe('embed-test-model');
    // Chat calls keep the chat pin; only the embed call moves.
    const chatCall = provider.calls.find((c) => c.kind === 'chat');
    expect(chatCall?.modelVer).toBe(PINS.modelVer);
  });

  it('journals the embedding pin on the retrieve step (DEC-26)', async () => {
    const ticketId = 'T-' + randomUUID().slice(0, 8);
    const deps = makeDeps(happyScript());

    const result = await coordinateTicket(deps, autoInput(ticketId, 1n));
    expect(result.outcome).toBe('resolved');

    const retrieve = (await journalRows(result.runId)).find(
      (s) => s.step_id === 'retrieve',
    );
    // Fallback path: no embedModelVer given, so the chat pin is journaled.
    expect(retrieve?.result).toMatchObject({ embed_model_ver: PINS.modelVer });
  });

  it('parks a customer reply and lands the run in awaiting_approval (DEC-12)', async () => {
    const ticketId = 'T-' + randomUUID().slice(0, 8);
    const helpdesk = helpdeskWith(ticketId);
    const deps = makeDeps(happyScript(), undefined, helpdesk);

    const result = await coordinateTicket(deps, replyInput(ticketId, 1n));

    expect(result.outcome).toBe('awaiting_approval');
    if (result.outcome !== 'awaiting_approval') return;
    expect(await runState(result.runId)).toBe('awaiting_approval');

    // The draft sits in the target system with disclosure and provenance
    // attached (DEC-14, DEC-33), still in draft state.
    expect(result.draftExternalId).not.toBeNull();
    const draft = helpdesk.getDraft(result.draftExternalId!);
    expect(draft).toMatchObject({
      ticketExternalId: ticketId,
      status: 'draft',
      disclosure: DISCLOSURE,
      body: expect.stringContaining('account settings'),
      provenance: {
        generatedBy: 'auracle',
        modelId: PINS.modelVer,
        promptVer: PINS.promptVer,
      },
    });
    expect(draft?.provenance.generatedAt).toEqual(expect.any(String));

    // No customer-visible work sits in the outbox while the run waits.
    const outboxCount = await pool.query(
      'SELECT count(*)::int AS n FROM outbox WHERE run_id = $1',
      [result.runId],
    );
    expect(outboxCount.rows[0]?.n).toBe(0);

    // The journal records the parked handle plus the action semantics the
    // approve entrypoint needs later.
    const steps = await journalRows(result.runId);
    expect(steps.find((s) => s.step_id === 'park')?.result).toMatchObject({
      draftExternalId: result.draftExternalId!,
      actionClass: CUSTOMER_REPLY_ACTION_CLASS,
      delivery: 'at_least_once',
    });
    const gate = steps.find((s) => s.step_id === 'gate');
    expect(gate?.result).toMatchObject({ decision: 'gated', groundedness: 1 });
    expect(steps.find((s) => s.step_id === 'execute')).toBeUndefined();
  });

  // deps.thresholds is the line that makes a fitted artifact reach a live
  // gate. Delete it and every other case in this file still passes: they all
  // run on evidence that clears the seeds, so the seed and the fitted value
  // agree and the wiring is invisible. This case picks evidence where they
  // disagree (DEC-13).
  it('applies the thresholds it was given, not the compiled-in seeds', async () => {
    // Modal intent takes 7 of 9 samples: agreement 0.78. That clears the 0.6
    // seed, so this same script resolves under the default deps.
    const script: FakeStep[] = [
      ...[
        'password_reset',
        'password_reset',
        'password_reset',
        'password_reset',
        'password_reset',
        'password_reset',
        'password_reset',
        'billing_question',
        'other',
      ].map((text) => ({ text })),
      { vectors: [VEC] },
      { text: '[doc:d1] Open the account settings page and choose reset password.' },
      { text: 'VERDICT: SUPPORTED' },
    ];

    const seeded = await coordinateTicket(
      makeDeps([...script]),
      autoInput('T-' + randomUUID().slice(0, 8), 1n),
    );
    expect(seeded.outcome).toBe('resolved');

    // The same evidence against a fitted threshold of 0.8 escalates.
    const fitted = await coordinateTicket(
      {
        ...makeDeps([...script]),
        thresholds: makeThresholds({ ...SEED_THRESHOLDS, agreement: 0.8 }),
      },
      autoInput('T-' + randomUUID().slice(0, 8), 1n),
    );

    expect(fitted.outcome).toBe('escalated');
    if (fitted.outcome === 'escalated') expect(fitted.reason).toBe('policy_escalated');

    // The gate journal records the decision AND the numbers that produced
    // it. During a rolling restart two consumers can run different fits, and
    // a verdict with no record of its gate cannot be explained afterwards.
    const steps = await journalRows(fitted.runId);
    expect(steps.find((s) => s.step_id === 'gate')?.result).toMatchObject({
      decision: 'escalate',
      thresholds: { agreement: 0.8, groundednessBlock: 0.7, groundednessReview: 0.8 },
    });

    const seededSteps = await journalRows(seeded.runId);
    expect(seededSteps.find((s) => s.step_id === 'gate')?.result).toMatchObject({
      thresholds: { agreement: SEED_THRESHOLDS.agreement },
    });
  });

  it('escalates when classifier agreement falls below the gate and keeps partial work', async () => {
    const ticketId = 'T-' + randomUUID().slice(0, 8);
    // Modal intent takes 4 of 9 samples: agreement 0.44 < GATE_AGREEMENT.
    // The run still walks retrieve -> compose -> gate; the policy engine
    // escalates there.
    const script: FakeStep[] = [
      ...[
        'password_reset',
        'billing_question',
        'other',
        'password_reset',
        'billing_question',
        'other',
        'password_reset',
        'billing_question',
        'password_reset',
      ].map((text) => ({ text })),
      { vectors: [VEC] },
      { text: '[doc:d1] Open the account settings page and choose reset password.' },
        { text: 'VERDICT: SUPPORTED' },
    ];
    const deps = makeDeps(script);

    const result = await coordinateTicket(deps, autoInput(ticketId, 1n));

    expect(result.outcome).toBe('escalated');
    if (result.outcome === 'escalated') expect(result.reason).toBe('policy_escalated');
    expect(await runState(result.runId)).toBe('escalated');

    const runRow = await pool.query(
      'SELECT cost_micros, steps_used FROM run WHERE run_id = $1',
      [result.runId],
    );
    expect(runRow.rows[0]).toMatchObject({
      cost_micros: 11 * ONE_CENT_IN_MICROS,
      steps_used: 4,
    });

    const steps = await journalRows(result.runId);
    // The set of steps the run journaled. Causal order is 'classify',
    // 'retrieve', 'compose', 'gate', 'escalate'; the journal cannot record it.
    expect(new Set(steps.map((s) => s.step_id))).toEqual(
      new Set(['classify', 'retrieve', 'compose', 'gate', 'escalate']),
    );
    const classify = steps.find((s) => s.step_id === 'classify');
    expect(classify?.result).toMatchObject({ intentId: 'password_reset', agreement: 4 / 9 });
    expect(steps.find((s) => s.step_id === 'escalate')?.result).toMatchObject({
      reason: 'policy_escalated',
    });
  });

  it('escalates on the step limit without error and keeps the partial work (DEC-25)', async () => {
    const ticketId = 'T-' + randomUUID().slice(0, 8);
    const deps = makeDeps(happyScript(), { maxSteps: 2 });

    const result = await coordinateTicket(deps, autoInput(ticketId, 1n));

    expect(result.outcome).toBe('escalated');
    if (result.outcome === 'escalated') expect(result.reason).toBe('limit_steps');
    expect(await runState(result.runId)).toBe('escalated');

    const runRow = await pool.query(
      'SELECT cost_micros, steps_used FROM run WHERE run_id = $1',
      [result.runId],
    );
    // Classify spent 9 cents over two steps; compose never ran.
    expect(runRow.rows[0]).toMatchObject({
      cost_micros: 9 * ONE_CENT_IN_MICROS,
      steps_used: 2,
    });
    // Set, not sequence: the run went classify, retrieve, escalate.
    expect(new Set((await journalRows(result.runId)).map((s) => s.step_id))).toEqual(
      new Set(['classify', 'retrieve', 'escalate']),
    );
  });

  it('records a sub-cent spend instead of losing it to rounding (DEC-25)', async () => {
    // The defect this replaced: cost was stored in cents, and
    // Math.round(0.000841 * 100) is 0. A whole run of real calls recorded
    // nothing, so the limit summed zeros and could never fire on spend.
    const ticketId = 'T-' + randomUUID().slice(0, 8);
    const PER_CALL_MICROS = 841;
    const script = happyScript().map((step) =>
      'text' in step ? { ...step, costMicros: PER_CALL_MICROS } : step,
    );
    const deps = makeDeps(script);

    const result = await coordinateTicket(deps, autoInput(ticketId, 1n));
    expect(result.outcome).toBe('resolved');

    const runRow = await pool.query(
      'SELECT cost_micros FROM run WHERE run_id = $1',
      [result.runId],
    );
    // Eleven chat calls; the embedding call is scripted with no cost.
    expect(runRow.rows[0]?.cost_micros).toBe(11 * PER_CALL_MICROS);
    // In cents every one of those calls would have rounded to zero.
    expect(Math.round(PER_CALL_MICROS / 10_000)).toBe(0);
  });

  it('escalates on the cost limit and keeps its partial work (DEC-25)', async () => {
    // The only limit no test drove. FakeProvider charges one cent per chat
    // call, so the 9 classifier samples spend 9 cents; a 5 cent ceiling is
    // already breached when the retrieve step checks it. Cents are written
    // in micro-dollars, the unit the ledger stores (DEC-25).
    const ticketId = 'T-' + randomUUID().slice(0, 8);
    const deps = makeDeps(happyScript(), { maxCostMicros: 5 * ONE_CENT_IN_MICROS });

    const result = await coordinateTicket(deps, autoInput(ticketId, 1n));

    expect(result.outcome).toBe('escalated');
    if (result.outcome === 'escalated') {
      expect(result.reason).toBe('limit_cost');
    }
    expect(await runState(result.runId)).toBe('escalated');

    // Reaching a limit is not an error: the run keeps what it already did.
    const runRow = await pool.query(
      'SELECT cost_micros, steps_used FROM run WHERE run_id = $1',
      [result.runId],
    );
    expect(runRow.rows[0]).toMatchObject({
      cost_micros: 9 * ONE_CENT_IN_MICROS,
      steps_used: 1,
    });
    expect(new Set((await journalRows(result.runId)).map((s) => s.step_id))).toEqual(
      new Set(['classify', 'escalate']),
    );

    // No outbox record: the run never reached the executing path.
    const outbox = await pool.query('SELECT 1 FROM outbox WHERE run_id = $1', [
      result.runId,
    ]);
    expect(outbox.rows).toHaveLength(0);
  });

  it('escalates an expired clock before any model call', async () => {
    const ticketId = 'T-' + randomUUID().slice(0, 8);
    const provider = new FakeProvider([]);
    const deps: CoordinatorDeps = {
      ...makeDeps([]),
      provider,
      limits: {
        maxCostMicros: 100_000_000,
        maxSteps: 50,
        deadlineAt: new Date(Date.now() - 1000),
      },
    };

    const result = await coordinateTicket(deps, autoInput(ticketId, 1n));

    expect(result.outcome).toBe('escalated');
    if (result.outcome === 'escalated') expect(result.reason).toBe('limit_clock');
    expect(provider.calls).toHaveLength(0);
    expect(await runState(result.runId)).toBe('escalated');
    expect(new Set((await journalRows(result.runId)).map((s) => s.step_id))).toEqual(
      new Set(['escalate']),
    );
  });

  it('stops a replayed semantic action superseded, never executing (section 4.2 rule 2)', async () => {
    const ticketId = 'T-' + randomUUID().slice(0, 8);

    const first = await coordinateTicket(makeDeps(happyScript()), autoInput(ticketId, 1n));
    expect(first.outcome).toBe('resolved');

    // Same ticket, same routing semantics: the DEC-24 key collides with the
    // committed outbox row, so the second run loses the insert and stops.
    const second = await coordinateTicket(makeDeps(happyScript()), autoInput(ticketId, 2n));
    expect(second.outcome).toBe('superseded');

    expect(await runState(first.runId)).toBe('resolved');
    expect(await runState(second.runId)).toBe('superseded');

    const total = await pool.query(
      'SELECT count(*)::int AS n FROM outbox WHERE idem_key = $1',
      [
        deriveIdemKey({
          actionClass: 'route_ticket',
          ticketId,
          payload: { queue: 'password-support' },
        }),
      ],
    );
    expect(total.rows[0]?.n).toBe(1);
  });

  it('refuses a run whose epoch is below the highest accepted epoch (DEC-28)', async () => {
    const ticketId = 'T-' + randomUUID().slice(0, 8);
    await pool.query('INSERT INTO ticket_epoch (ticket_id, epoch) VALUES ($1, $2)', [
      ticketId,
      '100',
    ]);

    const result = await coordinateTicket(makeDeps([]), autoInput(ticketId, 99n));

    expect(result.outcome).toBe('stale_epoch');
    if (result.outcome === 'stale_epoch') expect(result.highestAcceptedEpoch).toBe(100n);
    const runs = await pool.query('SELECT 1 FROM run WHERE ticket_id = $1', [ticketId]);
    expect(runs.rows).toHaveLength(0);
  });

  describe('V2 compensation of an irreversible action', () => {
    /** A sent refund was wrong; the system proposes compensating it. */
    function compensationInput(ticketId: string, epoch: bigint): CoordinateInput {
      return {
        ...autoInput(ticketId, epoch),
        actionClass: COMPENSATION_ACTION_CLASS,
        actionPayload: { reason: 'refund sent to the wrong account' },
        delivery: 'at_most_once',
        isCustomerVisible: false,
      };
    }

    it('parks in the ledger only and stops at awaiting_approval', async () => {
      const ticketId = 'T-' + randomUUID().slice(0, 8);
      const helpdesk = helpdeskWith(ticketId);

      const result = await coordinateTicket(
        makeDeps(happyScript(), undefined, helpdesk),
        compensationInput(ticketId, 1n),
      );

      expect(result.outcome).toBe('awaiting_approval');
      if (result.outcome !== 'awaiting_approval') return;
      expect(await runState(result.runId)).toBe('awaiting_approval');
      // No adapter call happened: a compensation has no customer-visible
      // draft to park (DEC-11), so there is no handle to return.
      expect(result.draftExternalId).toBeNull();
      expect(helpdesk.listDeliveries()).toHaveLength(0);

      // No relayable record exists while the run waits; approval inserts it.
      const outboxCount = await pool.query(
        'SELECT count(*)::int AS n FROM outbox WHERE run_id = $1',
        [result.runId],
      );
      expect(outboxCount.rows[0]?.n).toBe(0);

      // The gate gated on irreversibility, not on evidence or risk tier:
      // both gates passed and the tier is low.
      const steps = await journalRows(result.runId);
      expect(steps.find((s) => s.step_id === 'gate')?.result).toMatchObject({
        decision: 'gated',
        groundedness: 1,
      });
      // The park step carries everything approveRun needs: semantics,
      // declared rule, rationale body and the action payload verbatim.
      expect(steps.find((s) => s.step_id === 'park')?.result).toMatchObject({
        actionClass: COMPENSATION_ACTION_CLASS,
        delivery: 'at_most_once',
        body: expect.stringContaining('account settings'),
        payload: { reason: 'refund sent to the wrong account' },
      });
    });

    it('refuses a compensation that declares any other delivery rule (DEC-29)', async () => {
      const ticketId = 'T-' + randomUUID().slice(0, 8);

      await expect(
        coordinateTicket(makeDeps(happyScript()), {
          ...compensationInput(ticketId, 1n),
          delivery: 'at_least_once',
        }),
      ).rejects.toThrow(/declares delivery 'at_most_once'/);

      // The refusal happens before any state change.
      const runs = await pool.query('SELECT count(*)::int AS n FROM run WHERE ticket_id = $1', [
        ticketId,
      ]);
      expect(runs.rows[0]?.n).toBe(0);
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('escalates instead of parking a second draft after a crash mid-park (DEC-11)', async () => {
    // createDraft reaches the helpdesk before the ledger can record the
    // handle. Simulate a run that died in exactly that window: a park step
    // left 'parking' with no handle, on this ticket, under another run.
    const ticketId = 'T-' + randomUUID().slice(0, 8);
    const orphanRunId = randomUUID();
    await pool.query(
      `INSERT INTO run (run_id, ticket_id, partition, epoch, state, prompt_ver,
                        model_ver, deadline_at)
       VALUES ($1, $2, 0, 1, 'gated', 'p', 'm', now() + interval '1 hour')`,
      [orphanRunId, ticketId],
    );
    await pool.query(
      `INSERT INTO step_journal (run_id, step_id, status, result, prompt_ver,
                                 model_ver, cost_micros)
       VALUES ($1, 'park', 'parking', '{}'::jsonb, 'p', 'm', 0)`,
      [orphanRunId],
    );

    const helpdesk = helpdeskWith(ticketId);
    const deps = makeDeps(happyScript(), undefined, helpdesk);

    const result = await coordinateTicket(deps, replyInput(ticketId, 2n));

    expect(result.outcome).toBe('escalated');
    if (result.outcome === 'escalated') {
      expect(result.reason).toBe('park_unresolved');
    }
    // The decisive assertion: the retry put no second draft in front of the
    // customer. Only the orphan the earlier run left behind exists.
    const drafts = await pool.query(
      `SELECT sj.result->>'draftExternalId' AS handle
         FROM step_journal sj JOIN run r ON r.run_id = sj.run_id
        WHERE r.ticket_id = $1 AND sj.step_id = 'park'
          AND sj.result->>'draftExternalId' IS NOT NULL`,
      [ticketId],
    );
    expect(drafts.rows).toHaveLength(0);
  });
});
