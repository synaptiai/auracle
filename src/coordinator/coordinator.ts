// Run coordinator — docs/v1-architecture.md section 4.3. Obeys DEC-04,
// DEC-25, DEC-27, DEC-28.
//
// A plain state machine: no framework, no agent loop, no control flow from
// the model.
//
//   received -> classified -> retrieved -> composed -> gated
//     -> executing          (automatic path, internal writes only)
//     -> awaiting_approval  (customer replies, DEC-12)
//     -> resolved | escalated | superseded | abandoned
//
// Three tasks per section 4.3:
//   1. Each step is journaled before it acts (step_journal).
//   2. Every write carries the fencing epoch (DEC-28) through the ledger
//      insert path in src/ledger/insert.ts.
//   3. The limits on cost, steps and clock time are applied. Hitting a limit
//      is not an error: the run goes to 'escalated' and keeps its partial
//      work (DEC-25).

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

import type { EgressAdapter, ReplyProvenance } from '../adapters/types.js';
import { parkGatedReply } from '../approval/bridge.js';
import { classifyTicket } from '../classifier/classifier.js';
import { composeAnswer } from '../composer/composer.js';
import { checkGroundedness } from '../groundedness/groundedness.js';
import {
  fencedInsert,
  fencedTransition,
  type FencedOutboxInput,
} from '../ledger/insert.js';
import { deriveIdemKey } from '../ledger/keys.js';
import type { ModelProvider, PinnedVersions } from '../models/provider.js';
import { evaluatePolicy } from '../policy/policy.js';
import type { AdapterCapabilities, RiskTier } from '../policy/policy.js';
import { COMPENSATION_ACTION_CLASS } from '../relay/relay.js';
import { hybridSearch } from '../retriever/retriever.js';
import type { RetrievedDoc } from '../retriever/types.js';

/** Active states of the coordinator, in walk order (section 4.3). */
export const RUN_STATES = [
  'received',
  'classified',
  'retrieved',
  'composed',
  'gated',
  'executing',
  'awaiting_approval',
] as const;

export type ActiveRunState = (typeof RUN_STATES)[number];
export type TerminalRunState = 'resolved' | 'escalated' | 'superseded' | 'abandoned';

/**
 * DEC-27: hash(ticket_id) % N gives the partition. One consumer owns each
 * partition, so two runs on one ticket cannot occur together in normal
 * operation; the fencing epoch covers the rebalance overlap.
 */
export function partitionOf(ticketId: string, partitionCount: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < ticketId.length; i++) {
    hash ^= ticketId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % partitionCount;
}

/** DEC-25 limits. Reaching one escalates the run; it is never an error. */
export interface RunLimits {
  maxCostCents: number;
  maxSteps: number;
  deadlineAt: Date;
}

/** The taxonomy view the coordinator needs: classifier labels plus policy tiers. */
export interface CoordinatorTaxonomy {
  intents: readonly { id: string; label: string; risk_tier: RiskTier }[];
}

export interface CoordinatorDeps {
  pool: Pool;
  provider: ModelProvider;
  taxonomy: CoordinatorTaxonomy;
  capabilities: AdapterCapabilities;
  /**
   * The adapter this ticket came from (DEC-11): the gated branch parks each
   * customer reply as a draft inside that same target system.
   */
  egress: EgressAdapter;
  /** DEC-26: pinned versions carried on every model call and every write. */
  pins: PinnedVersions;
  /**
   * Model pin for the retrieval embedding, separate from pins.modelVer:
   * stealth chat models do not embed, so the query vector may come from a
   * different model. Falls back to pins.modelVer when absent.
   */
  embedModelVer?: string;
  limits: RunLimits;
  /** DEC-27: partition count N. */
  partitionCount: number;
}

/**
 * What the run would do once gated through. The action class and payload are
 * action semantics: they feed the DEC-24 idempotency key derivation.
 */
export interface CoordinateInput {
  ticketId: string;
  ticketText: string;
  /** DEC-28: fencing token for this run's writes. Must not decrease per ticket. */
  epoch: bigint;
  actionClass: string;
  actionPayload: Record<string, unknown>;
  delivery: 'at_least_once' | 'at_most_once';
  /**
   * DEC-12: true for customer replies. Such actions always gate, whatever the
   * gates read, and the run stops at 'awaiting_approval'.
   */
  isCustomerVisible: boolean;
  /**
   * DEC-14: the adopter's disclosure text, attached to every gated reply
   * before it enters the target system's draft state.
   */
  disclosure: string;
  /**
   * V2 open item 7: arrival time from the intake row. The ledger copies it
   * onto the run row, so queue wait stays readable after the ack deletes
   * the intake row. Absent for callers with no queue.
   */
  enqueuedAt?: Date;
}

export type EscalationReason =
  | 'limit_cost'
  | 'limit_steps'
  | 'limit_clock'
  | 'composer_abstained'
  | 'policy_escalated';

export type CoordinateOutcome =
  | { runId: string; outcome: 'resolved' }
  | { runId: string; outcome: 'awaiting_approval'; draftExternalId: string | null }
  | { runId: string; outcome: 'escalated'; reason: EscalationReason }
  | { runId: string; outcome: 'superseded' }
  | { runId: string; outcome: 'stale_epoch'; highestAcceptedEpoch: bigint };

interface Progress {
  costCents: number;
  stepsUsed: number;
}

/**
 * Wraps the provider so every model call reports its cost into one total
 * (DEC-25). The components keep their own interfaces; the coordinator sees
 * the spend without changing them.
 */
function meterProvider(provider: ModelProvider): {
  provider: ModelProvider;
  cost: () => number;
} {
  let costCents = 0;
  return {
    provider: {
      async complete(call) {
        const result = await provider.complete(call);
        costCents += result.costCents;
        return result;
      },
      async embed(call) {
        const result = await provider.embed(call);
        costCents += result.costCents;
        return result;
      },
    },
    cost: () => costCents,
  };
}

/**
 * DEC-33 provenance for text this system composed: the pinned model and
 * prompt versions plus the composition time, in ISO 8601.
 */
function replyProvenanceFor(pins: PinnedVersions): ReplyProvenance {
  return {
    generatedBy: 'auracle',
    modelId: pins.modelVer,
    promptVer: pins.promptVer,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Drives one ticket from 'received' to a terminal state or to
 * 'awaiting_approval'. One call walks the whole machine; each hop inside is
 * journaled before it acts and written through the fenced ledger path.
 */
export async function coordinateTicket(
  deps: CoordinatorDeps,
  input: CoordinateInput,
): Promise<CoordinateOutcome> {
  // DEC-29: the action class declares its delivery rule. Compensation
  // declares `at_most_once` — a duplicate refund costs money — so any
  // other rule is a caller defect, refused before any state change.
  if (
    input.actionClass === COMPENSATION_ACTION_CLASS
    && input.delivery !== 'at_most_once'
  ) {
    throw new Error(
      `action class '${COMPENSATION_ACTION_CLASS}' declares delivery 'at_most_once', got '${input.delivery}'`,
    );
  }

  const runId = randomUUID();
  const progress: Progress = { costCents: 0, stepsUsed: 0 };
  const meter = meterProvider(deps.provider);

  // Run creation through the existing ledger insert path. No outbox record:
  // receiving a ticket produces no external action, so rule 2 of section 4.2
  // does not operate here.
  const started = await fencedInsert(
    deps.pool,
    {
      runId,
      ticketId: input.ticketId,
      partition: partitionOf(input.ticketId, deps.partitionCount),
      epoch: input.epoch,
      state: 'received',
      promptVer: deps.pins.promptVer,
      modelVer: deps.pins.modelVer,
      deadlineAt: deps.limits.deadlineAt,
      ...(input.enqueuedAt === undefined ? {} : { enqueuedAt: input.enqueuedAt }),
    },
    null,
  );
  if (started.outcome === 'stale_epoch') {
    return {
      runId,
      outcome: 'stale_epoch',
      highestAcceptedEpoch: started.highestAcceptedEpoch,
    };
  }

  const limitHit = (): EscalationReason | null => {
    if (meter.cost() >= deps.limits.maxCostCents) return 'limit_cost';
    if (progress.stepsUsed >= deps.limits.maxSteps) return 'limit_steps';
    if (Date.now() >= deps.limits.deadlineAt.getTime()) return 'limit_clock';
    return null;
  };

  const journalStart = async (stepId: string): Promise<void> => {
    await deps.pool.query(
      `INSERT INTO step_journal (run_id, step_id, status, prompt_ver, model_ver, cost_cents)
       VALUES ($1, $2, 'started', $3, $4, $5)`,
      [runId, stepId, deps.pins.promptVer, deps.pins.modelVer, meter.cost()],
    );
  };

  const journalFinish = async (
    stepId: string,
    status: string,
    result: Record<string, unknown>,
  ): Promise<void> => {
    await deps.pool.query(
      `UPDATE step_journal SET status = $3, result = $4, cost_cents = $5
       WHERE run_id = $1 AND step_id = $2`,
      [runId, stepId, status, JSON.stringify(result), meter.cost()],
    );
  };

  // Every write carries the epoch; the ledger refuses it when this run's
  // lease went stale (DEC-28). Returns non-null when the run must stop here.
  const transitionOrStop = async (
    state: ActiveRunState | TerminalRunState,
    outbox?: FencedOutboxInput,
  ): Promise<CoordinateOutcome | null> => {
    const r = await fencedTransition(deps.pool, {
      runId,
      state,
      costCents: meter.cost(),
      stepsUsed: progress.stepsUsed,
      ...(outbox === undefined ? {} : { outbox }),
    });
    if (r.outcome === 'accepted') return null;
    if (r.outcome === 'superseded') return { runId, outcome: 'superseded' };
    if (r.outcome === 'stale_epoch') {
      return {
        runId,
        outcome: 'stale_epoch',
        highestAcceptedEpoch: r.highestAcceptedEpoch,
      };
    }
    throw new Error(`transition target vanished from the ledger: ${runId}`);
  };

  const stopEscalated = async (
    reason: EscalationReason,
  ): Promise<CoordinateOutcome> => {
    await journalStart('escalate');
    await journalFinish('escalate', 'done', { reason });
    const stop = await transitionOrStop('escalated');
    return stop ?? { runId, outcome: 'escalated', reason };
  };

  // --- classify -----------------------------------------------------------

  const earlyLimit = limitHit();
  if (earlyLimit !== null) return stopEscalated(earlyLimit);

  await journalStart('classify');
  const classification = await classifyTicket(meter.provider, {
    taxonomy: deps.taxonomy,
    ticketText: input.ticketText,
    ...deps.pins,
  });
  progress.stepsUsed++;
  await journalFinish('classify', 'done', {
    intentId: classification.intentId,
    agreement: classification.agreement,
  });
  const classified = await transitionOrStop('classified');
  if (classified !== null) return classified;

  // --- retrieve -----------------------------------------------------------

  const retrieveLimit = limitHit();
  if (retrieveLimit !== null) return stopEscalated(retrieveLimit);

  await journalStart('retrieve');
  const embedModelVer = deps.embedModelVer ?? deps.pins.modelVer;
  const embedded = await meter.provider.embed({
    input: [input.ticketText],
    ...deps.pins,
    modelVer: embedModelVer,
  });
  const queryVector = embedded.vectors[0];
  if (queryVector === undefined) {
    throw new Error('embedder returned no vector for the retrieval query');
  }
  const docs: RetrievedDoc[] = await hybridSearch(
    deps.pool,
    input.ticketText,
    queryVector,
    { limit: 5 },
  );
  progress.stepsUsed++;
  await journalFinish('retrieve', 'done', {
    docIds: docs.map((doc) => doc.docId),
    // DEC-26 truthfulness: the step's model_ver column carries the chat pin;
    // the embedding pin is recorded here.
    embed_model_ver: embedModelVer,
  });
  const retrieved = await transitionOrStop('retrieved');
  if (retrieved !== null) return retrieved;

  // --- compose ------------------------------------------------------------

  const composeLimit = limitHit();
  if (composeLimit !== null) return stopEscalated(composeLimit);

  await journalStart('compose');
  const composed = await composeAnswer(
    { question: input.ticketText, docs },
    { provider: meter.provider, ...deps.pins },
  );
  progress.stepsUsed++;
  await journalFinish('compose', composed.abstained ? 'abstained' : 'done', {
    abstained: composed.abstained,
    claimCount: composed.claims.length,
    staleDocumentIds: composed.staleDocuments.map((doc) => doc.docId),
  });
  if (composed.abstained || composed.draft === null) {
    // DEC-07: an abstain is a correct output, not an error. A person closes
    // the knowledge gap, so the run keeps its partial work and escalates.
    return stopEscalated('composer_abstained');
  }
  const composedOk = await transitionOrStop('composed');
  if (composedOk !== null) return composedOk;

  // --- gate ---------------------------------------------------------------

  const gateLimit = limitHit();
  if (gateLimit !== null) return stopEscalated(gateLimit);

  await journalStart('gate');
  const grounded = await checkGroundedness(
    { draft: composed.draft, retrievedTexts: docs.map((doc) => doc.body) },
    { provider: meter.provider, versions: deps.pins },
  );
  const intent = deps.taxonomy.intents.find((i) => i.id === classification.intentId);
  if (intent === undefined) {
    throw new Error(
      `classified intent ${classification.intentId} is absent from the taxonomy`,
    );
  }
  const decision = evaluatePolicy({
    riskTier: intent.risk_tier,
    agreement: classification.agreement,
    groundedness: grounded.groundedness,
    capabilities: deps.capabilities,
    action: {
      isWrite: true,
      isCustomerVisible: input.isCustomerVisible,
      // V2: compensation of an irreversible action always gates (DEC-03),
      // whatever the gates read. Derived from the class, so a caller
      // cannot mark a compensation reversible.
      isIrreversible: input.actionClass === COMPENSATION_ACTION_CLASS,
    },
  });
  progress.stepsUsed++;
  await journalFinish('gate', 'done', {
    groundedness: grounded.groundedness,
    decision,
  });
  const gated = await transitionOrStop('gated');
  if (gated !== null) return gated;

  if (decision === 'escalate') {
    return stopEscalated('policy_escalated');
  }
  if (decision === 'gated') {
    await journalStart('park');

    if (!input.isCustomerVisible) {
      // V2: compensation of an irreversible action (DEC-03). No adapter
      // call: a compensation has no customer-visible draft to park in the
      // helpdesk (DEC-11), and approval queues a `performAction` record,
      // not a `sendDraft` one. The composed text is the rationale a
      // person reads when approving; it also keeps the edit-distance
      // measurement (section 4.10) available. The action payload goes
      // into the journal verbatim: approveRun copies it onto the outbox.
      progress.stepsUsed++;
      await journalFinish('park', 'done', {
        actionClass: input.actionClass,
        delivery: input.delivery,
        body: composed.draft,
        payload: input.actionPayload,
      });
      const awaiting = await transitionOrStop('awaiting_approval');
      if (awaiting !== null) return awaiting;
      return { runId, outcome: 'awaiting_approval', draftExternalId: null };
    }

    // The approval path, including every customer reply (DEC-12). The bridge
    // parks the draft inside the target system (DEC-11) with the disclosure
    // and machine-readable provenance attached (DEC-14, DEC-33); a refusal
    // throws before any adapter call. The parked handle goes into the
    // journal, then the run stops at 'awaiting_approval'. No outbox record
    // yet: the approve entrypoint inserts it after a person approves.
    const parked = await parkGatedReply(deps.egress, {
      ticketExternalId: input.ticketId,
      body: composed.draft,
      disclosure: input.disclosure,
      provenance: replyProvenanceFor(deps.pins),
    });
    progress.stepsUsed++;
    await journalFinish('park', 'done', {
      draftExternalId: parked.draftExternalId,
      actionClass: input.actionClass,
      delivery: input.delivery,
      // The parked body, exactly as it entered the target system. The
      // approve entrypoint measures the person's edit against it
      // (section 4.10) from the ledger alone.
      body: composed.draft,
    });
    const awaiting = await transitionOrStop('awaiting_approval');
    if (awaiting !== null) return awaiting;
    return { runId, outcome: 'awaiting_approval', draftExternalId: parked.draftExternalId };
  }

  // --- execute (automatic path, internal writes only) ----------------------

  const executeLimit = limitHit();
  if (executeLimit !== null) return stopEscalated(executeLimit);

  await journalStart('execute');
  const idemKey = deriveIdemKey({
    actionClass: input.actionClass,
    ticketId: input.ticketId,
    payload: input.actionPayload,
  });
  progress.stepsUsed++;
  const executing = await transitionOrStop('executing', {
    stepId: 'execute',
    idemKey,
    actionClass: input.actionClass,
    delivery: input.delivery,
    payload: input.actionPayload,
  });
  if (executing !== null) {
    // Section 4.2 rule 2 end to end: a replayed semantic action loses the
    // outbox insert and stops superseded, never executing.
    await journalFinish('execute', 'superseded', { idemKey });
    return executing;
  }
  await journalFinish('execute', 'done', { idemKey });

  const resolved = await transitionOrStop('resolved');
  if (resolved !== null) return resolved;
  return { runId, outcome: 'resolved' };
}
