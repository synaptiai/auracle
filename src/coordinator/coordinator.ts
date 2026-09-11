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

import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

import type { EgressAdapter, ReplyProvenance } from '../adapters/types.js';
import { parkGatedReply } from '../approval/bridge.js';
import { PermanentEgressError } from '../adapters/types.js';
import { classifyTicket } from '../classifier/classifier.js';
import { composeAnswer } from '../composer/composer.js';
import { checkGroundedness } from '../groundedness/groundedness.js';
import {
  fencedInsert,
  fencedTransition,
  type FencedOutboxInput,
} from '../ledger/insert.js';
import { deriveIdemKey } from '../ledger/keys.js';
import { UnreadableAnswerError } from '../models/provider.js';
import type { ModelProvider, PinnedVersions } from '../models/provider.js';
import { SEED_THRESHOLDS, evaluatePolicyDetailed } from '../policy/policy.js';
import type { AdapterCapabilities, GateThresholds, RiskTier } from '../policy/policy.js';
import { COMPENSATION_ACTION_CLASS } from '../adapters/types.js';
import { hybridSearch } from '../retriever/retriever.js';
import type { RetrievedDoc } from '../retriever/types.js';
import { errorMessage } from '../errors.js';

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
 * DEC-36: hash(partition key) % N gives the partition. One consumer owns each
 * partition, so two runs of one conversation cannot occur together in normal
 * operation; the fencing epoch covers the rebalance overlap.
 *
 * The key is the conversation id for a V2 turn, so every turn of one
 * conversation lands on one consumer. A V1-era run and a replay run have no
 * conversation, and pass the ticket id instead (DEC-27 behaviour).
 */
export function partitionOf(partitionKey: string, partitionCount: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < partitionKey.length; i++) {
    hash ^= partitionKey.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % partitionCount;
}

/** DEC-25 limits. Reaching one escalates the run; it is never an error. */
export interface RunLimits {
  maxCostMicros: number;
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
   * the chat model does not embed, so the query vector may come from a
   * different model. Falls back to pins.modelVer when absent.
   */
  embedModelVer?: string;
  limits: RunLimits;
  /**
   * The gate numbers this process runs on. Resolved once at startup by
   * resolveThresholds, so a fitted artifact reaches the engine and a seeded
   * run says so in its log. Absent means the documented seeds.
   */
  thresholds?: GateThresholds;
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
  /**
   * DEC-28: the partition the intake row was filed under. The run row must
   * record the same one, because `claimPartition` bumps a ticket's fence by
   * joining through `run.partition`. Recomputing it here instead would use
   * this process's PARTITION_COUNT, and enqueue and consume read that
   * variable independently; a mismatch would make the rebalance bump the
   * wrong fences and silently stop protecting the ticket. Absent for
   * callers with no queue, which then fall back to the computed value.
   */
  partition?: number;
  /**
   * DEC-38: the turn that requested this action. Absent for a caller with no
   * conversation, whose keys then keep their V1 form.
   */
  turnNumber?: number;
  /**
   * DEC-35: the conversation this turn belongs to. Null on a V1-era run and
   * on a replay run, which have no conversation; the partition key then
   * falls back to the ticket id.
   */
  conversationId?: string | null;
  /**
   * DEC-35: the participant the conversation records. Passed to the egress so
   * the recipient it resolves is checked against the ledger, never against the
   * ticket id alone.
   */
  customerAddress?: string | null;
  /**
   * Prior turns of this conversation, oldest first. Empty on a first turn.
   *
   * DEC-37: the classifier and the composer read it. The gates never do, so
   * history can never stand in for retrieved evidence.
   */
  history?: readonly ConversationTurn[];
}

/**
 * One earlier turn of a conversation, as the prompts see it (DEC-37).
 *
 * Text only: the gates never read history, so nothing here can stand in for
 * retrieved evidence.
 */
export interface ConversationTurn {
  turnNumber: number;
  author: 'customer' | 'agent' | 'system';
  bodyText: string;
}

export type EscalationReason =
  | 'limit_cost'
  | 'limit_steps'
  | 'limit_clock'
  | 'composer_abstained'
  | 'policy_escalated'
  | 'park_unresolved'
  /** The egress refused the action and a retry can never clear it. */
  | 'egress_refused'
  /** The coverage judge answered, and the answer carried no verdict. */
  | 'gate_unreadable'
  /** The composer answered, and the answer carried neither a draft nor an abstain. */
  | 'composer_unreadable'
  /** Every classifier sample was unreadable, so agreement measured nothing. */
  | 'classifier_unreadable'
  /** Samples were readable and named no intent this taxonomy holds. */
  | 'classifier_no_label'
  /** The embedder answered with something the retriever could not read. */
  | 'retriever_unreadable';

export type CoordinateOutcome =
  | { runId: string; outcome: 'resolved' }
  | { runId: string; outcome: 'awaiting_approval'; draftExternalId: string | null }
  | { runId: string; outcome: 'escalated'; reason: EscalationReason }
  | { runId: string; outcome: 'superseded' }
  | { runId: string; outcome: 'stale_epoch'; highestAcceptedEpoch: bigint };

/**
 * Step count for the run. Cost is not here: it lives in the meter, which
 * wraps the provider and is the single reader for the DEC-25 limit and for
 * every journal write.
 */
interface Progress {
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
  let costMicros = 0;
  return {
    provider: {
      async complete(call) {
        let result;
        try {
          result = await provider.complete(call);
        } catch (error) {
          // A refused call still cost money. A truncated one exhausted its
          // answer budget by definition, so it is the most expensive call of
          // the run, and metering only the calls that returned understated
          // the run by its largest one (DEC-25). Counting it here covers
          // every caller, including the classifier, which reads an
          // unreadable sample as a vote against agreement and moves on.
          if (error instanceof UnreadableAnswerError) costMicros += error.costMicros;
          throw error;
        }
        costMicros += result.costMicros;
        return result;
      },
      async embed(call) {
        let result;
        try {
          result = await provider.embed(call);
        } catch (error) {
          // The same credit the chat path takes. An embed fault carries zero
          // today, but an asymmetry here would silently swallow a real number
          // the moment one carried it (DEC-25).
          if (error instanceof UnreadableAnswerError) costMicros += error.costMicros;
          throw error;
        }
        costMicros += result.costMicros;
        return result;
      },
    },
    cost: () => costMicros,
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
 * True when an earlier run on this ticket began parking a draft and never
 * recorded the outcome.
 *
 * `createDraft` mutates the target system before the ledger learns the draft
 * handle. A crash in that window leaves a draft nobody can name: the journal
 * row is still 'parking' and carries no handle. Parking again would put a
 * second draft in front of the customer, so the retry escalates instead and
 * a person reconciles the one that is already there.
 */
async function priorParkUnresolved(
  pool: Pool,
  ticketId: string,
  runId: string,
): Promise<boolean> {
  const rows = await pool.query(
    `SELECT 1
       FROM step_journal sj
       JOIN run r ON r.run_id = sj.run_id
      WHERE r.ticket_id = $1
        AND sj.step_id = 'park'
        AND sj.status = 'parking'
        AND sj.run_id <> $2
      LIMIT 1`,
    [ticketId, runId],
  );
  return rows.rows.length > 0;
}

/**
 * Drives one ticket from 'received' to a terminal state or to
 * 'awaiting_approval'. One call walks the whole machine; each hop inside is
 * journaled before it acts and written through the fenced ledger path.
 */

/**
 * A document body as a fixed-length fact about what it said.
 *
 * `document` rows are updated in place on reindex, so a reader comparing
 * today's body against this can say whether the document changed since the
 * run read it. Storing the digest rather than a second copy of every fused
 * body keeps the journal from carrying the whole corpus once per run.
 */
function digestOf(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/**
 * The bodies of the documents the claims actually cite.
 *
 * Only the cited ones. A run fuses about eight documents and cites two or
 * three, and the uncited five carry a hash on the `retrieve` row already —
 * enough to say whether they changed, without copying text no claim rests on.
 *
 * Keyed by id and deduplicated, because two claims commonly cite one
 * document and the journal should hold its text once.
 *
 * A cited id that is not in the fused set cannot occur: the composer refuses
 * a citation naming a document it was not given. It is skipped rather than
 * asserted, because this is a write-before-act journal entry and a throw here
 * would lose the run over a record about it.
 */
function citedBodiesOf(
  claims: readonly { readonly docId: string }[],
  docs: readonly RetrievedDoc[],
): Record<string, string> {
  const byId = new Map(docs.map((doc) => [doc.docId, doc.body]));
  const cited: Record<string, string> = {};
  for (const claim of claims) {
    const body = byId.get(claim.docId);
    if (body !== undefined) cited[claim.docId] = body;
  }
  return cited;
}

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
  const progress: Progress = { stepsUsed: 0 };
  const meter = meterProvider(deps.provider);

  // Run creation through the existing ledger insert path. No outbox record:
  // receiving a ticket produces no external action, so rule 2 of section 4.2
  // does not operate here.
  const started = await fencedInsert(
    deps.pool,
    {
      runId,
      ticketId: input.ticketId,
      partition:
        input.partition
        ?? partitionOf(input.conversationId ?? input.ticketId, deps.partitionCount),
      ...(input.conversationId == null ? {} : { conversationId: input.conversationId }),
      // DEC-35: the turn this run answers, so a turn joins to the run that
      // answered it without going through the park journal. An automatic run
      // parks nothing, so that join reached no automatic run at all.
      ...(input.turnNumber === undefined ? {} : { turnNumber: input.turnNumber }),
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
    if (meter.cost() >= deps.limits.maxCostMicros) return 'limit_cost';
    if (progress.stepsUsed >= deps.limits.maxSteps) return 'limit_steps';
    if (Date.now() >= deps.limits.deadlineAt.getTime()) return 'limit_clock';
    return null;
  };

  const journalStart = async (stepId: string): Promise<void> => {
    await deps.pool.query(
      `INSERT INTO step_journal (run_id, step_id, status, prompt_ver, model_ver, cost_micros)
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
      `UPDATE step_journal SET status = $3, result = $4, cost_micros = $5
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
      costMicros: meter.cost(),
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
  let classification;
  try {
    classification = await classifyTicket(meter.provider, {
      taxonomy: deps.taxonomy,
      ticketText: input.ticketText,
      history: input.history ?? [],
      ...deps.pins,
    });
  } catch (error) {
    // The third fault path, and the one the metering fix left unpersisted:
    // the meter counted every truncated sample and nothing wrote the total to
    // the run, because this step had no catch. It also went round the retry
    // ceiling, which nine truncated samples reproduce on every pass.
    if (error instanceof UnreadableAnswerError) {
      progress.stepsUsed++;
      await journalFinish('classify', 'failed', {
        shape: error.shape,
        ...(error.costUnknown ? { costUnknown: true } : {}),
        error: error.message,
      });
      // The shape decides the reason. Samples that answered with labels this
      // taxonomy does not hold is a taxonomy or prompt fault, and sending an
      // operator to check the answer budget for it wastes their time.
      return stopEscalated(
        error.shape === 'no-label' ? 'classifier_no_label' : 'classifier_unreadable',
      );
    }
    throw error;
  }
  progress.stepsUsed++;
  await journalFinish('classify', 'done', {
    intentId: classification.intentId,
    agreement: classification.agreement,
    // An agreement depressed by samples nobody could read is not the same
    // number as one the model actually disagreed on, and this is the one path
    // where a customer is waiting. Recorded beside it, not instead of it.
    ...(classification.unreadableSamples > 0
      ? { unreadableSamples: classification.unreadableSamples }
      : {}),
    ...(classification.costUnknown ? { costUnknown: true } : {}),
  });
  const classified = await transitionOrStop('classified');
  if (classified !== null) return classified;

  // --- retrieve -----------------------------------------------------------

  const retrieveLimit = limitHit();
  if (retrieveLimit !== null) return stopEscalated(retrieveLimit);

  await journalStart('retrieve');
  const embedModelVer = deps.embedModelVer ?? deps.pins.modelVer;
  let embedded;
  try {
    embedded = await meter.provider.embed({
      input: [input.ticketText],
      ...deps.pins,
      modelVer: embedModelVer,
    });
  } catch (error) {
    // The fourth step that reads a model answer, and the last one with no
    // catch. A response shape the provider will reproduce is not transient,
    // so it ends the run here rather than going round the queue's ceiling.
    if (error instanceof UnreadableAnswerError) {
      progress.stepsUsed++;
      await journalFinish('retrieve', 'failed', {
        shape: error.shape,
        ...(error.costUnknown ? { costUnknown: true } : {}),
        error: error.message,
      });
      return stopEscalated('retriever_unreadable');
    }
    throw error;
  }
  const queryVector = embedded.vectors[0];
  if (queryVector === undefined) {
    progress.stepsUsed++;
    await journalFinish('retrieve', 'failed', {
      shape: 'no-vector',
      error: 'embedder returned no vector for the retrieval query',
    });
    return stopEscalated('retriever_unreadable');
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
    // What each fused document was when this run read it (DEC-23).
    //
    // `document` rows are updated in place on reindex, so today's title and
    // review date are not the ones the run retrieved. Only the id was a
    // historical fact. These are, and the hash says whether the body still
    // matches without storing a second copy of the corpus.
    //
    // No score and no rank: DEC-21 fuses ranks and keeps neither, and a
    // position recorded here would claim the fusion set the order.
    documents: docs.map((doc) => ({
      docId: doc.docId,
      title: doc.title,
      owner: doc.owner,
      reviewBy: doc.reviewBy,
      bodyHash: digestOf(doc.body),
    })),
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
  let composed;
  try {
    composed = await composeAnswer(
      { question: input.ticketText, docs, history: input.history ?? [] },
      { provider: meter.provider, ...deps.pins },
    );
  } catch (error) {
    // An abstain is a determination and escalates below with its own reason.
    // An unreadable answer is a fault, and it must not borrow that reason.
    if (error instanceof UnreadableAnswerError) {
      // The meter already counted the faulting call's spend (DEC-25). The
      // step still happened, so it still counts.
      progress.stepsUsed++;
      await journalFinish('compose', 'failed', {
        shape: error.shape,
        ...(error.costUnknown ? { costUnknown: true } : {}),
        error: error.message,
      });
      return stopEscalated('composer_unreadable');
    }
    throw error;
  }
  progress.stepsUsed++;
  await journalFinish('compose', composed.abstained ? 'abstained' : 'done', {
    abstained: composed.abstained,
    claimCount: composed.claims.length,
    // The drafted reply, sentence by sentence, as the composer partitioned it
    // (DEC-43). A `docId` is the document that sentence rests on; null is a
    // courtesy sentence, which cites nothing and is never counted.
    //
    // The whole reply and not the claims alone: the claims are no longer the
    // draft, so a row holding only them would describe a reply the customer
    // never reads. Stored once, here. `park.body` holds the joined text for
    // the approval to compare against, and nothing else copies it.
    //
    // Named `sentences` rather than `claims`, because a list holding courtesy
    // sentences is not a list of claims. `docs/operations.md` names this key
    // in the erasure statement, and `journal/query.ts` still reads a `claims`
    // row written before this.
    sentences: composed.sentences.map((sentence) => ({
      text: sentence.text,
      docId: sentence.docId,
    })),
    // The cited documents as they read at this moment, and only the cited
    // ones. Journalled here rather than at `retrieve`, because `retrieve`
    // runs first and nothing there knows which documents a claim will cite.
    //
    // The retrieve row stores a hash and this one stores text, and the two
    // are not in tension. A hash answers whether a document changed; it
    // cannot answer what the claim actually rested on once someone edits the
    // document. Evidence a person can read has to be the text, so the run
    // keeps the text for the documents its claims rest on and the cheaper
    // answer for the rest. `README.md` states what that means for retention.
    //
    // Bounded by the retrieval limit above, so a run stores at most that many
    // bodies however many claims it makes.
    citedBodies: citedBodiesOf(composed.claims, docs),
    staleDocumentIds: composed.staleDocuments.map((doc) => doc.docId),
    // What actually answered this run's model calls (issue #23).
    //
    // Read from the provider rather than derived from the pins: this module's
    // own import states that the provider and the model version are
    // independent options, so a stub answering under a real model's pin would
    // report the wrong thing. `scorerOf` in the gold report reads it the same
    // way, for the same reason.
    //
    // `pnpm run bands` compares a day against the thirty before it, and a
    // band across a provider change measures the provider and not the system.
    // Without this the reader had no way to tell, and every day of live
    // traffic recorded nothing while a seeded day recorded a name — which
    // made the report refuse a verdict on any ledger holding both.
    provider: deps.provider.kind ?? 'model',
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
  // The composer's own claim partition, not a re-split of the joined draft.
  // Every claim here already carries a citation the composer resolved to a
  // retrieved document (DEC-07), so the coverage denominator is fixed by the
  // composer rather than chosen by a second model call.
  let grounded;
  try {
    grounded = await checkGroundedness(
      {
        claims: composed.claims.map((claim) => claim.text),
        retrievedTexts: docs.map((doc) => doc.body),
      },
      { provider: meter.provider, versions: deps.pins },
    );
  } catch (error) {
    // A fault, not a verdict, and not transient: the judge runs at
    // temperature 0, so the retry ceiling would spend a full pipeline run per
    // scan and file an orphan run each time, then abandon. Finish the step and
    // escalate here, so the run reaches a terminal state, the spend reaches
    // the ledger, and an operator sees the reason (DEC-25, DEC-30).
    if (error instanceof UnreadableAnswerError) {
      progress.stepsUsed++;
      await journalFinish('gate', 'failed', {
        shape: error.shape,
        ...(error.costUnknown ? { costUnknown: true } : {}),
        error: error.message,
      });
      return stopEscalated('gate_unreadable');
    }
    throw error;
  }
  const intent = deps.taxonomy.intents.find((i) => i.id === classification.intentId);
  if (intent === undefined) {
    throw new Error(
      `classified intent ${classification.intentId} is absent from the taxonomy`,
    );
  }
  const gateThresholds = deps.thresholds ?? SEED_THRESHOLDS;
  const outcome = evaluatePolicyDetailed({
    riskTier: intent.risk_tier,
    // DEC-41: the gate reads the threshold fitted for this intent when the
    // artifact carried one. Without this the map is present and never read.
    intent: classification.intentId,
    agreement: classification.agreement,
    groundedness: grounded.groundedness,
    thresholds: gateThresholds,
    capabilities: deps.capabilities,
    action: {
      isWrite: true,
      isCustomerVisible: input.isCustomerVisible,
      // DEC-34: an irreversible action always gates, whatever the gates
      // read. Derived from the class, so a caller cannot mark a
      // compensation reversible.
      isIrreversible: input.actionClass === COMPENSATION_ACTION_CLASS,
    },
  });
  const decision = outcome.decision;
  progress.stepsUsed++;
  await journalFinish('gate', 'done', {
    groundedness: grounded.groundedness,
    // Which claim the judge did not support, beside the fraction rather than
    // instead of it. The fraction is what `evaluatePolicy` read, and a reader
    // renders that value rather than recounting it from these: two numbers
    // computed twice will disagree, and only one of them decided anything.
    //
    // Coverage detail, and coverage only. Agreement sits on the `classify`
    // row and nothing here touches it, so DEC-05 holds: the ledger still
    // never holds the two gates in one object.
    // The claim's position, not its text. The compose row already holds every
    // sentence of the draft, so storing the text here would put the drafted
    // reply in the ledger a second time — and two copies are two places an
    // erasure path has to reach, and two things that can drift.
    //
    // The position is into the cited sentences, in draft order, which is what
    // `composed.claims` is. A courtesy sentence never enters that list, so a
    // reply that opens with one does not shift a verdict onto the wrong
    // claim (DEC-43).
    //
    // The index is sound because `checkGroundedness` drops a blank claim and
    // the composer cannot emit one: `parseClaims` trims each line before its
    // pattern runs, so the captured text ends on a non-whitespace character.
    // `composer.test.ts` holds that shut, because an index into a list that
    // silently lost a member would attribute every later verdict to the
    // wrong claim.
    claimVerdicts: grounded.claims.map((claim, index) => ({
      claimIndex: index,
      supported: claim.supported,
    })),
    decision,
    // Which rule decided, not only what it decided. `gated` alone is
    // ambiguous between a rule that returns before the agreement gate is
    // read and the groundedness review band, which reaches that gate and
    // passes it. A reader that could not tell those apart would count a
    // customer reply as a gate failure, and the rate would then track
    // traffic mix instead of the classifier (DEC-05, DEC-12).
    reason: outcome.reason,
    // Section 6 documents a rebalance window where two consumers overlap, and
    // each resolves its thresholds once at startup. During a rolling restart
    // one consumer can run a fitted number and the other the seed, and
    // identical evidence then decides differently. Without this the journal
    // records the verdict and nothing that explains it (DEC-26 pins versions
    // for the same reason).
    thresholds: gateThresholds,
  });
  const gated = await transitionOrStop('gated');
  if (gated !== null) return gated;

  if (decision === 'escalate') {
    return stopEscalated('policy_escalated');
  }
  if (decision === 'gated') {
    await journalStart('park');

    if (!input.isCustomerVisible) {
      // DEC-34: a gated write with no customer draft parks in the ledger.
      // No adapter call: such a write has nothing to park in the helpdesk
      // (DEC-11), and approval queues a `performAction` record, not a
      // `sendDraft` one. Compensation is one case; a high-risk internal
      // write and one with mediocre coverage reach this branch too. The composed text is the rationale a
      // person reads when approving; it also keeps the edit-distance
      // measurement (section 4.10) available. The action payload goes
      // into the journal verbatim: approveRun copies it onto the outbox.
      progress.stepsUsed++;
      await journalFinish('park', 'done', {
        actionClass: input.actionClass,
        delivery: input.delivery,
        body: composed.draft,
        payload: input.actionPayload,
        // DEC-38: approval derives the outbox key from this record, so the
        // turn has to survive the wait. Without it, one request per turn
        // would collapse into one key and the later turn would be dropped.
        ...(input.turnNumber === undefined ? {} : { turnNumber: input.turnNumber }),
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
    //
    // `createDraft` reaches the customer's helpdesk before the ledger can
    // record what it created. An earlier run that died in that window left a
    // draft with no handle in the journal; parking again would show the
    // customer two. So the ledger states the intent first, and a run that
    // finds an unresolved one escalates for a person to reconcile.
    if (await priorParkUnresolved(deps.pool, input.ticketId, runId)) {
      return stopEscalated('park_unresolved');
    }
    // DEC-24: the park's key comes from the action and the ticket, never
    // from this run. Two runs of the same park derive the same key, so the
    // adapter recognises the repeat and returns the first draft.
    //
    // CAUTION for whoever adds rejection. Nothing in the key distinguishes a
    // retry from a fresh attempt after a person rejected the draft. V1 has
    // no reject path, and the consumer acks the ticket out of intake once
    // the run reaches 'awaiting_approval', so a second run on one ticket
    // does not occur. A reject path changes that: the new run would derive
    // this same key and the adapter would hand back the rejected draft. Add
    // something that separates the attempts and is still action semantics,
    // such as a digest of the composed body. Never the run id (DEC-24).
    const parkKey = deriveIdemKey({
      actionClass: `${input.actionClass}:park`,
      ticketId: input.ticketId,
      ...(input.turnNumber === undefined ? {} : { turnNumber: input.turnNumber }),
      // DEC-35: the conversation the turn belongs to. A turn number alone is
      // not unique — db/012 can put two conversations on one ticket.
      conversationId: input.conversationId ?? null,
      payload: input.actionPayload,
    });
    await journalFinish('park', 'parking', {
      actionClass: input.actionClass,
      delivery: input.delivery,
      parkKey,
    });

    // The 'parking' row above is the crash marker: it says a draft may exist
    // that nobody can name, and priorParkUnresolved escalates every later run
    // on this ticket while it stands. That is right for a crash and wrong for
    // a throw we can see, which proves the adapter did NOT get as far as
    // appending. Leaving the marker for one of those poisons the ticket
    // permanently: every future run escalates park_unresolved with no draft
    // anywhere to reconcile.
    let parked;
    try {
      parked = await parkGatedReply(deps.egress, {
        ticketExternalId: input.ticketId,
        body: composed.draft,
        disclosure: input.disclosure,
        provenance: replyProvenanceFor(deps.pins),
        idemKey: parkKey,
        expectedRecipient: input.customerAddress ?? null,
      });
    } catch (error) {
      await journalFinish('park', 'failed', {
        actionClass: input.actionClass,
        delivery: input.delivery,
        parkKey,
        error: errorMessage(error),
      });
      // A permanent refusal must not go round the retry loop. The queue's
      // attempt ceiling is sized for a transient fault, so a refused recipient
      // would otherwise spend a full pipeline run and file an orphan run row
      // on every scan until it hit that ceiling.
      if (error instanceof PermanentEgressError) {
        return stopEscalated('egress_refused');
      }
      throw error;
    }
    progress.stepsUsed++;
    await journalFinish('park', 'done', {
      draftExternalId: parked.draftExternalId,
      actionClass: input.actionClass,
      delivery: input.delivery,
      // DEC-38: the turn survives the wait, so approval derives the key this
      // turn's request deserves.
      ...(input.turnNumber === undefined ? {} : { turnNumber: input.turnNumber }),
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
    // DEC-38: two turns asking for the same thing are two requests.
    ...(input.turnNumber === undefined ? {} : { turnNumber: input.turnNumber }),
      // DEC-35: the conversation the turn belongs to. A turn number alone is
      // not unique — db/012 can put two conversations on one ticket.
      conversationId: input.conversationId ?? null,
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
