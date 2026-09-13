// What a run is, and what one may be told to do (section 4.3).
//
// The state machine's vocabulary, with no behaviour beside it. The step
// modules under `steps/` read these types and `coordinator.ts` sequences
// them, so neither has to import the other to agree on what a run is
// (issue #75). `coordinator.ts` re-exports every name here, because callers
// outside this directory address the coordinator and not its parts.
import type { EgressAdapter } from '../adapters/types.js';
import type { ConversationTurn } from '../domain/conversation-turn.js';
import type { ModelProvider, PinnedVersions } from '../models/provider.js';
import type { AdapterCapabilities, GateThresholds, RiskTier } from '../policy/policy.js';
import type { Pool } from 'pg';

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
  | 'retriever_unreadable'
  /**
   * An invariant inside the coordinator did not hold (issue #94).
   *
   * A defect in this system, not a model answer and not a limit. The
   * escalate row carries the fault message beside the reason, because the
   * reason alone names no step and no value.
   */
  | 'internal_fault';

export type CoordinateOutcome =
  | { runId: string; outcome: 'resolved' }
  | { runId: string; outcome: 'awaiting_approval'; draftExternalId: string | null }
  | { runId: string; outcome: 'escalated'; reason: EscalationReason }
  | { runId: string; outcome: 'superseded' }
  | { runId: string; outcome: 'stale_epoch'; highestAcceptedEpoch: bigint };
