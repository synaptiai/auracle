/**
 * A synthetic traffic history, planned before anything is written (issue #23).
 *
 * Pure. It opens no connection, reads no clock and calls no model, so the
 * same seed always yields the same history. That is the whole point: a band
 * built from a history nobody can reproduce is a number nobody can check.
 *
 * ## What this models, and why it is not tuned
 *
 * Issue #25's evidence gate reads `pnpm run latency` against this history and
 * decides which correction head-of-line delay needs. So a history built to
 * make one rule fire would seed the check with the material meant to verify
 * it, and the gate would be reading its own answer back.
 *
 * Every parameter below therefore comes from the system's shape, never from a
 * wanted verdict:
 *
 * - **Service time is heavy-tailed** because a run makes nine classifier
 *   samples at a temperature above zero (section 4.5), an embedding, a
 *   composition and a groundedness check. Model latency is long-tailed, and a
 *   run that makes twelve calls inherits that tail. Drawn log-normal.
 * - **Partition depth is uniform** because `partitionOf` hashes the
 *   conversation id (DEC-36) and a hash spreads evenly. Nothing here skews it.
 * - **Arrivals are bursty**, because support traffic is. Modelled as a Poisson
 *   process, which clusters: a uniform spread never fills a poll batch, and a
 *   full batch is where the delay lives.
 * - **Queue wait is not drawn at all.** It is computed from the consumer's
 *   real loop, and three facts of that loop shape it:
 *     1. Intake signals the consumer inside the enqueue transaction and the
 *        loop wakes on it (issue #25), so a message is visible the instant
 *        it is queued. `CONSUMER_INTERVAL_MS` remains as a ceiling for a
 *        lost signal. Set `wakeOnArrival: false` for the loop before that
 *        change, where a message waited for the next tick at any load.
 *     2. `pollPartition` takes every queued message across the partitions one
 *        consumer owns, and `scanBatchSize` defaults to the whole queue.
 *     3. `processQueuedTickets` awaits each `coordinateTicket` before the
 *        next, so the batch is walked serially.
 *   So a ticket waits for every ticket ahead of it in its consumer's batch —
 *   including tickets on a *different* partition that the same consumer
 *   owns. That cross-partition wait is the head-of-line delay V2 open item 7
 *   names, and modelling one server per partition would have hidden it
 *   entirely.
 *
 * Head-of-line delay is therefore a consequence of those facts, and whatever
 * the report shows about it is a finding rather than a setting.
 *
 * ## What the figures say
 *
 * At this load the system does not queue. Utilisation is 1.37 %, and one run
 * in a hundred waits longer than one poll period. None of the design
 * document's rules R1 to R4 fires.
 *
 * `wakeOnArrival: false` models the loop before the consumer woke on an
 * arrival. There the mean wait is 2.78 s against a poll floor of 2.50 s, so
 * ninety per cent of the wait is the sleep itself. Both regimes stay
 * expressible, because a wait figure that can only be stated one way is not
 * evidence for anything.
 *
 * `src/seed/plan.test.ts` pins every figure the register and the roadmap
 * quote.
 */
import { partitionOf, type EscalationReason } from '../coordinator/coordinator.js';
import { CUSTOMER_REPLY_ACTION_CLASS, COMPENSATION_ACTION_CLASS } from '../adapters/types.js';
import {
  SEED_THRESHOLDS,
  agreementThresholdFor,
  reachedAgreementGate,
  type ActionClass,
  type PolicyReason,
  type AdapterCapabilities,
  type PolicyDecision,
  type PolicyInput,
  type RiskTier,
} from '../policy/policy.js';
import { CLASSIFIER_K } from '../classifier/classifier.js';
import type { IndexedDoc } from '../retriever/types.js';

/** Deterministic PRNG, the same one `scripts/generate-fixtures.mjs` uses. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A v4-shaped identifier from the PRNG.
 *
 * `randomUUID` would make the history irreproducible, and a run id is a
 * primary key a second run must reproduce exactly for the ledger contents to
 * match. The version and variant nibbles are set so the value is a valid
 * UUID and Postgres accepts it in a `uuid` column.
 */
export function seededUuid(rng: () => number): string {
  const hex: string[] = [];
  for (let i = 0; i < 32; i += 1) hex.push(Math.floor(rng() * 16).toString(16));
  hex[12] = '4';
  hex[16] = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/** Milliseconds in one day. */
const DAY_MS = 86_400_000;

/**
 * A log-normal draw, by the Box-Muller transform.
 *
 * Log-normal because a duration cannot be negative and a run's total is a
 * product of several call latencies rather than a sum of them. `sigma`
 * controls the tail: at 0.9 roughly one run in a hundred takes five times the
 * median, which is the shape a twelve-call run has.
 */
export function logNormal(rng: () => number, medianMs: number, sigma: number): number {
  const u1 = Math.max(rng(), Number.EPSILON);
  const u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.round(medianMs * Math.exp(sigma * z));
}

/**
 * The same draw as `logNormal`, kept as a fraction in [0, 1].
 *
 * It consumes the same two values from `rng`, in the same order, so a
 * caller that swaps one for the other leaves every later draw in the stream
 * untouched. `plan.test.ts` pins that, because a version of this function
 * that folded the two draws into one would reshuffle the whole history and
 * move every figure the register quotes.
 *
 * Separate from `logNormal` rather than a flag on it: that one rounds to a
 * whole millisecond, and rounding a fraction of a document leaves only 0
 * and 1.
 */
export function logNormalUnit(rng: () => number, median: number, sigma: number): number {
  const u1 = Math.max(rng(), Number.EPSILON);
  const u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  // Clamped at both ends because the column's contract is [0, 1] inclusive
  // (db/003). A complete rewrite really does score 1, so the upper clamp is
  // a legal value and not a discarded draw.
  return Math.min(1, Math.max(0, median * Math.exp(sigma * z)));
}

/**
 * The curated taxonomy, as `fixtures/taxonomy.json` holds it.
 *
 * Copied rather than loaded, because this planner reads no file: a history
 * that changed when somebody edited a fixture would not be reproducible from
 * its seed alone. `plan.test.ts` loads the real taxonomy and asserts this
 * table matches it entry for entry, so the copy cannot drift.
 *
 * The risk tier matters to the policy engine, not just to a reader. DEC-13
 * keeps a high-risk intent off the automatic path whatever the gates read,
 * so an `auto` run carrying `refund-request` would be a row the engine
 * cannot produce.
 */
export interface SeedIntent {
  readonly id: string;
  readonly riskTier: RiskTier;
}

export const SEED_INTENTS: readonly SeedIntent[] = [
  { id: 'refund-request', riskTier: 'high' },
  { id: 'billing-dispute', riskTier: 'high' },
  { id: 'cancel-subscription', riskTier: 'high' },
  { id: 'data-deletion-request', riskTier: 'high' },
  { id: 'chargeback-notice', riskTier: 'high' },
  { id: 'payment-failure', riskTier: 'medium' },
  { id: 'plan-change-question', riskTier: 'medium' },
  { id: 'invoice-copy-request', riskTier: 'medium' },
  { id: 'account-recovery', riskTier: 'medium' },
  { id: 'login-trouble', riskTier: 'medium' },
  { id: 'sync-error-report', riskTier: 'medium' },
  { id: 'export-broken', riskTier: 'medium' },
  { id: 'integration-failure', riskTier: 'medium' },
  { id: 'feature-request', riskTier: 'low' },
  { id: 'how-to-question', riskTier: 'low' },
  { id: 'pricing-question', riskTier: 'low' },
  { id: 'documentation-gap', riskTier: 'low' },
  { id: 'feedback-positive', riskTier: 'low' },
  { id: 'bug-minor-report', riskTier: 'low' },
  { id: 'onboarding-help', riskTier: 'low' },
  { id: 'notification-settings-help', riskTier: 'low' },
  { id: 'mobile-app-question', riskTier: 'low' },
  { id: 'api-usage-question', riskTier: 'low' },
  { id: 'status-inquiry', riskTier: 'low' },
  { id: 'other', riskTier: 'medium' },
];

/**
 * The knowledge base a seeded run retrieves from.
 *
 * Small and fixed, because its job is to give the `docIds` in a retrieve row
 * something to join to. Without it a reader holding a seeded history sees
 * five identifiers per run and can resolve none of them, which is the same
 * defect as a gate reason with no numbers beside it.
 *
 * Every review date is in the future. That is not decoration: the
 * coordinator calls `hybridSearch` with no `includeStale`, so its SQL
 * filters on `review_by >= CURRENT_DATE` and a stale document can never
 * reach a run this seeder models (DEC-23).
 *
 * DEC-18: every field is invented. The owners are team handles, and no body
 * carries a person, an address or an account.
 */
export const SEED_DOCUMENTS: readonly IndexedDoc[] = [
  {
    docId: 'SYN-DOC-01',
    kind: 'document',
    title: 'Refund eligibility windows',
    body: 'A subscription charge is refundable in full inside fourteen days of the charge date. '
      + 'After that window the account keeps access until the end of the paid period. '
      + 'A refund on a disputed charge waits for the dispute to close.',
    owner: 'billing-team',
    reviewBy: '2027-03-31',
  },
  {
    docId: 'SYN-DOC-02',
    kind: 'document',
    title: 'Failed payment retry schedule',
    body: 'A declined card is retried three times over ten days. '
      + 'The account stays active through the retry window and moves to read only after it. '
      + 'A new card cancels the remaining retries and settles the balance at once.',
    owner: 'billing-team',
    reviewBy: '2027-05-14',
  },
  {
    docId: 'SYN-DOC-03',
    kind: 'document',
    title: 'Changing a plan mid cycle',
    body: 'An upgrade takes effect at once and bills the difference for the remaining days. '
      + 'A downgrade takes effect at the next renewal and never issues a credit. '
      + 'Seat counts follow the same rule.',
    owner: 'billing-team',
    reviewBy: '2027-04-30',
  },
  {
    docId: 'SYN-DOC-04',
    kind: 'document',
    title: 'Invoice copies and billing contacts',
    body: 'Every invoice stays available under the billing section of the workspace settings. '
      + 'A workspace owner can add a billing contact who receives each invoice. '
      + 'Historic invoices are never edited; a correction is issued as a credit note.',
    owner: 'billing-team',
    reviewBy: '2027-06-30',
  },
  {
    docId: 'SYN-DOC-05',
    kind: 'document',
    title: 'Cancelling a subscription',
    body: 'Cancellation stops the next renewal and keeps access until the paid period ends. '
      + 'A cancelled workspace is retained for thirty days and then deleted. '
      + 'Reactivation inside those thirty days restores the workspace unchanged.',
    owner: 'billing-team',
    reviewBy: '2027-02-28',
  },
  {
    docId: 'SYN-DOC-06',
    kind: 'document',
    title: 'Account recovery without a second factor',
    body: 'A locked account is recovered by a workspace administrator from the members page. '
      + 'When no administrator remains, recovery needs proof of domain ownership. '
      + 'Support never disables the second factor on request alone.',
    owner: 'accounts-team',
    reviewBy: '2027-01-31',
  },
  {
    docId: 'SYN-DOC-07',
    kind: 'document',
    title: 'Sign in loops and stale sessions',
    body: 'A sign in loop is almost always a stale session cookie for the workspace domain. '
      + 'Clearing site data for that domain resolves it. '
      + 'A loop that survives a cleared session points at a misconfigured identity provider.',
    owner: 'accounts-team',
    reviewBy: '2027-07-31',
  },
  {
    docId: 'SYN-DOC-08',
    kind: 'canonical_resolution',
    title: 'Data deletion request handling',
    body: 'A deletion request is confirmed by the requester and then queued for thirty days. '
      + 'The queue is reversible until it runs. '
      + 'After it runs the workspace and its backups are unrecoverable.',
    owner: 'compliance-desk',
    reviewBy: '2027-03-15',
  },
  {
    docId: 'SYN-DOC-09',
    kind: 'document',
    title: 'Export jobs that finish empty',
    body: 'An export covers the rows a viewer can already see. '
      + 'An empty export usually means the filter excluded every row. '
      + 'An export above one million rows is split into parts and delivered as an archive.',
    owner: 'platform-team',
    reviewBy: '2027-08-31',
  },
  {
    docId: 'SYN-DOC-10',
    kind: 'document',
    title: 'Synchronisation error codes',
    body: 'A sync error names the connector and the stage that failed. '
      + 'Codes in the four hundreds are configuration faults and need a reconnected credential. '
      + 'Codes in the five hundreds are retried automatically for six hours.',
    owner: 'platform-team',
    reviewBy: '2027-09-30',
  },
  {
    docId: 'SYN-DOC-11',
    kind: 'document',
    title: 'Rate limits on the public interface',
    body: 'A workspace may make six hundred requests a minute across every token it holds. '
      + 'A rejected request returns the remaining budget and the reset instant. '
      + 'Bulk work belongs on the batch endpoints, which carry a separate budget.',
    owner: 'platform-team',
    reviewBy: '2027-10-31',
  },
  {
    docId: 'SYN-DOC-12',
    kind: 'document',
    title: 'Integration credentials and rotation',
    body: 'A connector credential is rotated without downtime by adding the new one first. '
      + 'The old credential stays valid for one hour after the swap. '
      + 'A revoked credential stops every job that used it immediately.',
    owner: 'platform-team',
    reviewBy: '2027-11-30',
  },
  {
    docId: 'SYN-DOC-13',
    kind: 'document',
    title: 'Notification settings and digests',
    body: 'Each member controls their own notification settings for every workspace they join. '
      + 'A digest collects notifications for the period the member chose. '
      + 'A workspace administrator can set a default but never overrides a member choice.',
    owner: 'support-enablement',
    reviewBy: '2027-05-31',
  },
  {
    docId: 'SYN-DOC-14',
    kind: 'document',
    title: 'Mobile application offline behaviour',
    body: 'The mobile application keeps the last thirty days of activity for offline reading. '
      + 'An edit made offline is queued and applied when the device reconnects. '
      + 'A conflicting edit keeps both versions and asks the member to choose.',
    owner: 'support-enablement',
    reviewBy: '2027-06-15',
  },
  {
    docId: 'SYN-DOC-15',
    kind: 'canonical_resolution',
    title: 'Status page and incident updates',
    body: 'Every incident is published on the status page before support answers about it. '
      + 'An update follows at least every thirty minutes while the incident is open. '
      + 'A resolved incident keeps its timeline for one year.',
    owner: 'support-enablement',
    reviewBy: '2027-04-15',
  },
  {
    docId: 'SYN-DOC-16',
    kind: 'document',
    title: 'Onboarding a new workspace',
    body: 'A new workspace starts with one owner who invites the first members. '
      + 'The setup checklist covers the domain, the identity provider and the billing contact. '
      + 'A workspace with no verified domain cannot enable automatic joining.',
    owner: 'support-enablement',
    reviewBy: '2027-12-31',
  },
];

/** The classifier's own output, which the `classify` step journals. */
export interface PlannedClassification {
  intentId: string;
  /** DEC-13: a person sets it. The policy engine reads it, so it is carried, not inferred. */
  riskTier: RiskTier;
  /** A count of agreeing samples over CLASSIFIER_K, never a free real number. */
  agreement: number;
}

/**
 * The world the policy engine judged, kept so a reader can re-run the engine.
 *
 * Null for a run whose composer abstained: `coordinateTicket` escalates
 * before the gate step starts, so such a run reaches no engine at all.
 */
export interface PlannedGate {
  groundedness: number;
  decision: PolicyDecision;
  capabilities: AdapterCapabilities;
  action: ActionClass;
}

/**
 * The `park` record a gated run journals, in the shape approval reads back.
 *
 * Two shapes, exactly as the coordinator writes them: a customer reply parks
 * a draft in the helpdesk and records its handle (DEC-11), and every other
 * gated write parks in the ledger alone and records the payload approval
 * copies onto the outbox (DEC-34).
 */
export interface PlannedPark {
  readonly draftExternalId?: string;
  actionClass: string;
  delivery: 'at_least_once' | 'at_most_once';
  body: string;
  readonly payload?: Record<string, unknown>;
  turnNumber: number;
}

/** One planned run, with every value the writer needs. */
export interface PlannedRun {
  runId: string;
  ticketId: string;
  conversationId: string;
  partition: number;
  /** When the message arrived. */
  enqueuedAt: Date;
  /** When the consumer picked it up: arrival plus everything ahead of it. */
  createdAt: Date;
  /**
   * The work itself, which is what occupies the consumer.
   *
   * Distinct from `finishedAt - createdAt`. A run parked for approval holds
   * no consumer while it waits, so the serial walk releases the consumer
   * after this and not after the person answers.
   */
  serviceMs: number;
  /**
   * When it reached a terminal state, or null when it has not reached one.
   *
   * Null for `awaiting_approval`: that run is waiting for a person and has
   * not finished, so the ledger stores no finish and the latency reader
   * counts it under `unfinished`. The clock seam refuses a finish for a
   * non-terminal state, which is how this was found.
   */
  finishedAt: Date | null;
  state: string;
  /** The compose step's outcome. */
  abstained: boolean;
  /**
   * The gate step's reason, or null for a run that never gated.
   *
   * Null when the composer abstained: `coordinateTicket` journals the
   * abstain and escalates before the gate step starts, so such a run has no
   * gate row at all. Writing one produced a shape the system cannot make,
   * and it drove the bands report's `gate_never` count to zero on every day
   * where a real ledger with a 17 per cent abstain rate shows at least that.
   */
  reason: PolicyReason | null;
  /**
   * Why this run escalated, or null for a run that did not.
   *
   * A second vocabulary, and not the gate's. `reason` above is a
   * `PolicyReason` and names which policy rule decided; this names why the
   * run stopped, and the coordinator's `EscalationReason` is a disjoint set
   * of words. `src/escalations/query.ts` reads only this one, off the
   * `escalate` step, and both `pnpm run escalations` and the operator
   * console's runs list are served by that statement. So a seeded escalation
   * with no such row reported a null reason to a person working the queue,
   * and the console's Reason column was an em dash for every one of them.
   *
   * `relay_delivery_unknown` is outside `EscalationReason` on purpose. That
   * escalation comes from the relay rather than the coordinator, and
   * `parkEscalated` composes its reason as `relay_${status}` when it has no
   * send failure to quote (DEC-30).
   */
  escalation: EscalationReason | 'relay_delivery_unknown' | null;
  /** What answered this run's model calls. */
  provider: string;
  /**
   * The person's edit to the parked draft, normalized to [0, 1].
   *
   * Set only when a person approved a draft. The scale is the column's
   * contract (db/003) and what `approvalEditDistance` returns: a token-level
   * Levenshtein distance over the length of the longer text. It was drawn
   * around a median of 24 and rounded to a whole number, which is a token
   * count and not a fraction — so `pnpm run bands` reported a mean edit
   * distance near 24 against a metric whose worst possible value is 1, and
   * the band could never be compared with a measurement from a live
   * approval.
   */
  editDistance: number | null;
  /** Outbox rows to attach, by status. */
  outbox: readonly string[];
  /** The `classify` step's result. Present for every run: every run classifies. */
  classification: PlannedClassification;
  /** The documents the `retrieve` step returned, best first. */
  docIds: readonly string[];
  /** The claims, their citations and their verdicts (DEC-07, DEC-05). */
  claims: readonly PlannedClaim[];
  /** How many cited claims the composer produced. Zero for an abstain. */
  claimCount: number;
  /** The gate step's inputs and verdict, or null for a run that never gated. */
  gate: PlannedGate | null;
  /** The park step's record, or null for a run the policy engine did not gate. */
  park: PlannedPark | null;
  /** The action under evaluation, which decides the delivery rule (DEC-29). */
  actionClass: string;
  delivery: 'at_least_once' | 'at_most_once';
  /** What an adapter would be asked to perform. Non-empty for every action class. */
  actionPayload: Record<string, unknown>;
}

/**
 * The engine input a run's own journal describes.
 *
 * Exported so a test drives `evaluatePolicyDetailed` with it rather than
 * restating the rule. A seeded reason that disagreed with the numbers beside
 * it would be visible on any console that renders both, and nothing else in
 * this planner would catch it.
 *
 * Null for a run that never gated, which is what an abstain produces.
 */
export function policyInputFor(run: PlannedRun): PolicyInput | null {
  if (run.gate === null) return null;
  return {
    riskTier: run.classification.riskTier,
    intent: run.classification.intentId,
    agreement: run.classification.agreement,
    groundedness: run.gate.groundedness,
    thresholds: SEED_THRESHOLDS,
    capabilities: run.gate.capabilities,
    action: run.gate.action,
  };
}

export interface PlanOptions {
  seed: number;
  /** UTC calendar days to write, oldest first. */
  days: number;
  /** The last day of the history, `YYYY-MM-DD`. */
  endDay: string;
  /** Consumer partitions, as CONSUMER_PARTITIONS would name them. */
  partitions: number;
  /**
   * Consumer processes. Each owns `partitions / consumers` of them and walks
   * their combined queue in one serial batch, which is what
   * `pollPartition` plus `processQueuedTickets` do.
   */
  consumers?: number;
  /** Mean tickets a day. Poisson, so the realised count varies. */
  arrivalsPerDay?: number;
  /** The consumer's poll period, CONSUMER_INTERVAL_MS. */
  pollIntervalMs?: number;
  /**
   * Whether the consumer wakes on arrival (issue #25). True models the loop
   * that ships: intake signals on enqueue and the consumer scans at once,
   * with the poll period left as a ceiling. False models the loop before it,
   * where a message was invisible until the next tick.
   *
   * Both regimes stay expressible on purpose. The wait figures this planner
   * produces are the evidence for what the poll floor costs, and evidence
   * that can only be stated one way is not evidence.
   */
  wakeOnArrival?: boolean;
  /** What answered the bulk history's model calls. */
  provider: string;
}

/**
 * The reasons a healthy day produces, with the weight each carries.
 *
 * Taken from `PolicyReason`, so `bands` recognises every one of them. A
 * reason it no longer knows lands in `gate_obsolete`, which would report the
 * seeded history as a ledger the reader cannot interpret.
 *
 * `customer_visible` dominates because DEC-12 sends every customer reply to a
 * person, and that is most of this system's traffic.
 */
const HEALTHY_REASONS: readonly (readonly [PolicyReason, number])[] = [
  ['customer_visible', 0.46],
  ['auto', 0.24],
  ['groundedness_review', 0.10],
  ['agreement', 0.08],
  ['high_risk', 0.06],
  ['groundedness_block', 0.03],
  ['irreversible', 0.02],
  ['no_idempotency', 0.01],
];

/**
 * The degraded day: the classifier disagrees with itself more often.
 *
 * Only `agreement` and `auto` move, and they move against each other, so the
 * day's degradation is one metric falling rather than a reshaped ledger.
 * `gate_pass_rate` is the metric bands.yaml calls low_is_bad, and agreement
 * is the reason that fails it (section 4.5).
 */
const DEGRADED_REASONS: readonly (readonly [PolicyReason, number])[] = [
  ['customer_visible', 0.46],
  ['auto', 0.04],
  ['groundedness_review', 0.10],
  ['agreement', 0.28],
  ['high_risk', 0.06],
  ['groundedness_block', 0.03],
  ['irreversible', 0.02],
  ['no_idempotency', 0.01],
];

/**
 * The state a run ends in, given the reason its gate produced.
 *
 * Read off `evaluatePolicyDetailed` and the coordinator's own branches, not
 * chosen. `auto` is the only reason that proceeds, and it ends `resolved`.
 * Every `gated` reason parks at `awaiting_approval` — DEC-34 for a write
 * with no draft, DEC-12 for a customer reply — and reaches `resolved` only
 * when a person approves it. `agreement` and `groundedness_block` are
 * `escalate`, which ends `escalated`.
 *
 * The first version marked every run `resolved`, including 1112 customer
 * replies that DEC-12 routes to a person. The bands report's own
 * "still to land" count was then zero on every day of the history.
 */
const ESCALATING_REASONS: ReadonlySet<string> = new Set(['agreement', 'groundedness_block']);

export function stateFor(reason: string, approved: boolean): string {
  if (reason === 'auto') return 'resolved';
  if (ESCALATING_REASONS.has(reason)) return 'escalated';
  return approved ? 'resolved' : 'awaiting_approval';
}

function weighted<T extends string>(rng: () => number, table: readonly (readonly [T, number])[]): T {
  let roll = rng();
  for (const [value, weight] of table) {
    roll -= weight;
    if (roll <= 0) return value;
  }
  return table[table.length - 1]![0];
}

/** A UTC day string, `n` days before `endDay`. */
export function dayBefore(endDay: string, n: number): string {
  return new Date(Date.parse(`${endDay}T00:00:00.000Z`) - n * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Plans the whole history.
 *
 * The degraded day sits four days before the end, so a reader has a full
 * thirty measured days behind it and several ordinary days after it.
 */
/**
 * A Poisson draw by Knuth's method.
 *
 * Arrivals to a support desk are Poisson, and Poisson clusters: the gap
 * between two arrivals is exponential, so several land close together far
 * more often than a uniform spread allows. A batch fills from a cluster.
 */
export function poisson(rng: () => number, mean: number): number {
  const limit = Math.exp(-mean);
  let k = 0;
  let p = 1;
  do {
    k += 1;
    p *= rng();
  } while (p > limit);
  return k - 1;
}

/** An exponential gap, which is what makes the arrival process Poisson. */
function exponentialGap(rng: () => number, meanMs: number): number {
  return -Math.log(Math.max(rng(), Number.EPSILON)) * meanMs;
}

/**
 * A day's own seed, mixed from the run seed and the day string.
 *
 * One stream for the whole history made every window that shared a seed start
 * with the same identifiers, so seeding one extra day after a long history
 * regenerated the first day's run ids and the ledger refused them on the
 * primary key. Per-day seeding keeps both properties that matter: one seed and
 * one day always give the same runs, and two different days never collide.
 */
function seedForDay(seed: number, day: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < day.length; i += 1) {
    hash ^= day.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash ^ seed) >>> 0;
}

/**
 * An adapter that declares everything, which is what the shipped ones do.
 *
 * `no_idempotency` is the one reason that needs a gap, and it is made by
 * withdrawing a single flag from this record rather than by writing a second
 * one. Two hand-written capability sets can disagree about a flag nobody is
 * looking at, and the engine reads two of them (DEC-06).
 */
const FULL_CAPABILITIES: AdapterCapabilities = Object.freeze({
  supportsIdempotencyKey: true,
  supportsReadBack: true,
  supportsDraftState: true,
  supportsStructuredFields: true,
  supportsThreading: true,
});

/**
 * The reasons `evaluatePolicyDetailed` returns before it reads the risk tier.
 *
 * A run stopped by one of these may carry any intent, including a high-risk
 * one. That is not a licence, it is the traffic: DEC-12 sends every customer
 * reply to a person, and a refund reply is a customer reply first. Excluding
 * the high tier here would have written a history in which no refund is ever
 * answered, which is a claim about this system that is simply false.
 */
const BEFORE_RISK_CHECK: ReadonlySet<PolicyReason> = new Set<PolicyReason>([
  'no_idempotency',
  'no_read_back',
  'customer_visible',
  'irreversible',
]);

/**
 * The internal write classes the helpdesk adapter implements.
 *
 * Both are real: `performAction` names `close_ticket`, `route_ticket` and
 * `compensate`, and refuses anything else. A class it cannot perform would
 * put a row in the outbox that the relay can never dispatch.
 */
const INTERNAL_ACTION_CLASSES: readonly string[] = ['route_ticket', 'close_ticket'];

/** Queues a routed ticket can land in. Synthetic names, DEC-18. */
const SEED_QUEUES: readonly string[] = ['SYN-QUEUE-BILLING', 'SYN-QUEUE-ACCOUNTS', 'SYN-QUEUE-PLATFORM'];

/**
 * Claim counts a composition can produce.
 *
 * Groundedness is `supported / claims.length`, so it is a ratio of two small
 * whole numbers and not a free real number. A coverage drawn without a claim
 * count behind it is a value no composition could have produced, and the
 * journal records both side by side.
 */
const CLAIM_COUNTS: readonly number[] = [3, 4, 5, 6, 7, 8, 9, 10];

/**
 * A coverage value inside [lo, hi), together with the claim count that gives it.
 *
 * The band comes from the gate reason the planner already drew, so the number
 * and the reason cannot disagree. The comparison here is the same division
 * and the same operator the engine applies, so no rounding can put a value on
 * the wrong side of a threshold.
 *
 * Some bands admit nothing at some counts — nothing between 0.7 and 0.8 is a
 * ratio over 3, 5 or 6 — so the search walks the candidates. It draws twice
 * whatever it finds, because a search that consumed a draw per attempt would
 * make the rest of the history depend on which band this run landed in.
 */
function coverageIn(
  rng: () => number,
  lo: number,
  hi: number,
): { claimCount: number; groundedness: number } {
  const start = Math.floor(rng() * CLAIM_COUNTS.length);
  const pick = rng();
  for (let step = 0; step < CLAIM_COUNTS.length; step += 1) {
    const claimCount = CLAIM_COUNTS[(start + step) % CLAIM_COUNTS.length]!;
    const admissible: number[] = [];
    for (let supported = 0; supported <= claimCount; supported += 1) {
      const coverage = supported / claimCount;
      if (coverage >= lo && coverage < hi) admissible.push(coverage);
    }
    if (admissible.length === 0) continue;
    return { claimCount, groundedness: admissible[Math.floor(pick * admissible.length)]! };
  }
  throw new Error(
    `no claim count in [${CLAIM_COUNTS.join(', ')}] gives a coverage in [${lo}, ${hi})`,
  );
}

/** The band the gate reason implies, as the engine's own comparisons define it. */
function coverageBandFor(reason: PolicyReason): { lo: number; hi: number } {
  if (reason === 'groundedness_block') return { lo: 0, hi: SEED_THRESHOLDS.groundednessBlock };
  if (reason === 'groundedness_review') {
    return { lo: SEED_THRESHOLDS.groundednessBlock, hi: SEED_THRESHOLDS.groundednessReview };
  }
  if (reason === 'auto') return { lo: SEED_THRESHOLDS.groundednessReview, hi: Infinity };
  // Every other reason returns before gate 2 is read, so coverage decided
  // nothing for this run and the whole range is truthful. A low number beside
  // `customer_visible` is not a contradiction: DEC-12 returned first, and
  // `reachedAgreementGate` is how a reader tells those runs apart.
  return { lo: 0, hi: Infinity };
}

/** The draft a person sees, or the rationale they approve. DEC-18: invented throughout. */
function draftFor(intentId: string, ticketId: string, docIds: readonly string[]): string {
  return `Thank you for writing about your ${intentId.replace(/-/g, ' ')}. `
    + `The published guidance for this case is ${docIds.join(', ')}. `
    + `Ticket ${ticketId} stays open until you confirm this resolved it.`;
}

/** One claim of a seeded draft, and the document it cites (DEC-07). */
export interface PlannedClaim {
  text: string;
  docId: string;
  /**
   * What the groundedness judge said about it.
   *
   * Derived from the run's own coverage rather than drawn, because the
   * fraction is `supported / claimCount` and a verdict list that disagreed
   * with it would put two numbers in the ledger where one decided.
   */
  supported: boolean;
}

/**
 * The claims a seeded draft makes, and which of them the judge supported.
 *
 * The composer refuses an uncited line (DEC-07), so every claim names a
 * document the run retrieved. The supported count is fixed by the coverage
 * the run already drew: a reader that recounted these must reach the fraction
 * the gate row records.
 *
 * The unsupported ones come last. Nothing in the system depends on that, and
 * it makes the seeded corpus readable when a person opens one run.
 */
function claimsFor(
  intentId: string,
  docIds: readonly string[],
  claimCount: number,
  groundedness: number,
): PlannedClaim[] {
  const supportedCount = Math.round(groundedness * claimCount);
  const subject = intentId.replace(/-/g, ' ');
  return Array.from({ length: claimCount }, (_, i) => ({
    text: `Point ${i + 1} about your ${subject}, as the published guidance states it.`,
    // Round-robin over what the run retrieved, so two claims commonly cite
    // one document — which is the shape the journal has to hold.
    docId: docIds[i % docIds.length]!,
    supported: i < supportedCount,
  }));
}

/** Everything a run's journal records beyond its timing, its state and its provider. */
export interface RunDetail {
  classification: PlannedClassification;
  docIds: string[];
  claimCount: number;
  /** The claims, their citations and their verdicts (DEC-07, DEC-05). */
  claims: PlannedClaim[];
  gate: PlannedGate | null;
  park: PlannedPark | null;
  actionClass: string;
  delivery: 'at_least_once' | 'at_most_once';
  actionPayload: Record<string, unknown>;
}

/**
 * The steps one run journals, derived from the outcome it already drew.
 *
 * Derived rather than drawn independently, and that is the whole point.
 * A run whose gate reason is `agreement` must carry an agreement below the
 * threshold that produced it, or a console renders the reason beside a number
 * that contradicts it and nothing in the ledger says which one is wrong.
 * `plan.test.ts` runs `evaluatePolicyDetailed` over every run to prove the
 * derivation and the engine still agree.
 *
 * `reason` is null for a run whose composer abstained. Such a run reaches no
 * engine at all: the coordinator journals the abstain and escalates before
 * the gate step starts, so it carries no gate row, no park row and no claims.
 */
function planDetail(
  rng: () => number,
  reason: PolicyReason | null,
  ticketId: string,
): RunDetail {
  // The intent, from the pool the reason allows. `high_risk` needs the high
  // tier by definition; a reason that got past the risk check needs anything
  // but it; a reason that returned before it takes the whole taxonomy.
  const pool = reason === 'high_risk'
    ? SEED_INTENTS.filter((intent) => intent.riskTier === 'high')
    : reason !== null && !BEFORE_RISK_CHECK.has(reason)
      ? SEED_INTENTS.filter((intent) => intent.riskTier !== 'high')
      : SEED_INTENTS;
  const intent = pool[Math.floor(rng() * pool.length)]!;

  // Agreement is a count of agreeing samples over CLASSIFIER_K, so the only
  // values the classifier can report are k/9. A uniform real in [0, 1] would
  // be a number the classifier cannot produce.
  const threshold = agreementThresholdFor({ intent: intent.id, thresholds: SEED_THRESHOLDS });
  const counts: number[] = [];
  for (let k = 1; k <= CLASSIFIER_K; k += 1) {
    const agreement = k / CLASSIFIER_K;
    if (reason === 'agreement') {
      if (agreement < threshold) counts.push(agreement);
    } else if (reason !== null && reachedAgreementGate(reason)) {
      if (agreement >= threshold) counts.push(agreement);
    } else {
      // The comparison never happened, so no value is excluded. Seeding those
      // runs across the whole range is what makes `reachedAgreementGate`
      // visible in the ledger rather than only in the engine.
      counts.push(agreement);
    }
  }
  const agreement = counts[Math.floor(rng() * counts.length)]!;

  // Five is the coordinator's own retrieval limit. Fewer is ordinary: the
  // lexical channel returns nothing for a query with no matching term.
  const docCount = 3 + Math.floor(rng() * 3);
  const remaining = SEED_DOCUMENTS.map((doc) => doc.docId);
  const docIds: string[] = [];
  for (let i = 0; i < docCount; i += 1) {
    docIds.push(remaining.splice(Math.floor(rng() * remaining.length), 1)[0]!);
  }

  // The action, and with it the delivery rule DEC-29 binds to the class.
  const actionClass = reason === 'customer_visible'
    ? CUSTOMER_REPLY_ACTION_CLASS
    : reason === 'irreversible'
      ? COMPENSATION_ACTION_CLASS
      : INTERNAL_ACTION_CLASSES[Math.floor(rng() * INTERNAL_ACTION_CLASSES.length)]!;
  const queue = SEED_QUEUES[Math.floor(rng() * SEED_QUEUES.length)]!;
  // Each class carries the field its adapter demands. `route_ticket` rejects
  // a payload with no queue and `compensate` one with no reason, so a payload
  // shaped for the wrong class is a record the relay can never dispatch.
  const actionPayload: Record<string, unknown> =
    actionClass === CUSTOMER_REPLY_ACTION_CLASS
      ? { intent: intent.id }
      : actionClass === COMPENSATION_ACTION_CLASS
        ? { reason: 'synthetic compensation of a seeded irreversible write' }
        : actionClass === 'route_ticket'
          ? { queue }
          : { resolution: 'synthetic' };
  const delivery = actionClass === COMPENSATION_ACTION_CLASS ? 'at_most_once' : 'at_least_once';

  const classification: PlannedClassification = {
    intentId: intent.id,
    riskTier: intent.riskTier,
    agreement,
  };

  if (reason === null) {
    // An abstain composes no claims, so it has nothing for the groundedness
    // gate to read. `checkGroundedness` refuses an empty claim list outright.
    return {
      classification,
      docIds,
      claimCount: 0,
      // Empty, never a claim with no verdict. An abstain composes nothing,
      // and `checkGroundedness` refuses an empty claim list outright, so
      // there is no gate row for these verdicts to disagree with.
      claims: [],
      gate: null,
      park: null,
      actionClass,
      delivery,
      actionPayload,
    };
  }

  const band = coverageBandFor(reason);
  const { claimCount, groundedness } = coverageIn(rng, band.lo, band.hi);
  const decision: PolicyDecision = reason === 'auto'
    ? 'auto'
    : ESCALATING_REASONS.has(reason)
      ? 'escalate'
      : 'gated';
  const gate: PlannedGate = {
    groundedness,
    decision,
    capabilities: reason === 'no_idempotency'
      ? { ...FULL_CAPABILITIES, supportsIdempotencyKey: false }
      : FULL_CAPABILITIES,
    action: {
      // The coordinator hard-codes it: every action it evaluates is a write.
      isWrite: true,
      isCustomerVisible: actionClass === CUSTOMER_REPLY_ACTION_CLASS,
      // Derived from the class, exactly as the coordinator derives it, so a
      // run cannot claim a reversible compensation.
      isIrreversible: actionClass === COMPENSATION_ACTION_CLASS,
    },
  };

  const body = draftFor(intent.id, ticketId, docIds);
  const park: PlannedPark | null = decision !== 'gated'
    ? null
    : actionClass === CUSTOMER_REPLY_ACTION_CLASS
      // DEC-11: the draft lives in the helpdesk and the journal records its
      // handle. Derived from the ticket rather than drawn, so it needs no
      // place in the stream and a reader can match the two by eye.
      ? {
        draftExternalId: `SYN-DRAFT-${ticketId.slice(2)}`,
        actionClass,
        delivery,
        body,
        turnNumber: 1,
      }
      // DEC-34: a gated write with no customer draft parks in the ledger
      // alone, and approval relays the journaled payload through
      // `performAction`. A record with neither a handle nor a payload is one
      // `approveRun` refuses.
      : { actionClass, delivery, body, payload: actionPayload, turnNumber: 1 };

  const claims = claimsFor(intent.id, docIds, claimCount, groundedness);
  return {
    classification, docIds, claimCount, claims, gate, park, actionClass, delivery, actionPayload,
  };
}

/** A planned run before its journal detail is drawn. */
type PlannedRunCore = Omit<PlannedRun, keyof RunDetail>;

export function planHistory(options: PlanOptions): PlannedRun[] {
  const degradedDay = dayBefore(options.endDay, 4);
  const consumers = options.consumers ?? 2;
  const meanArrivals = options.arrivalsPerDay ?? 54;
  const pollMs = options.pollIntervalMs ?? 5_000;
  const wakeOnArrival = options.wakeOnArrival ?? true;
  const planned: PlannedRun[] = [];

  // Which consumer owns which partition. CONSUMER_PARTITIONS names a set per
  // process, and the sets are contiguous in every example the runbook gives.
  const ownerOf = (partition: number): number =>
    Math.floor(partition / Math.ceil(options.partitions / consumers));

  for (let d = options.days - 1; d >= 0; d -= 1) {
    const day = dayBefore(options.endDay, d);
    const rng = mulberry32(seedForDay(options.seed, day));
    const degraded = day === degradedDay;
    const dayStartMs = Date.parse(`${day}T07:00:00.000Z`);
    const windowMs = 11 * 3_600_000;

    // Poisson arrivals: the count varies, and the gaps are exponential, so
    // the day carries clusters rather than an even spread.
    const arrivals = poisson(rng, meanArrivals);
    const gapMs = windowMs / Math.max(arrivals, 1);

    const drawn = [];
    let cursor = dayStartMs;
    for (let i = 0; i < arrivals; i += 1) {
      cursor += exponentialGap(rng, gapMs);
      const conversationId = seededUuid(rng);
      const ticketId = `T-${seededUuid(rng).slice(0, 8)}`;
      drawn.push({
        conversationId,
        ticketId,
        partition: partitionOf(conversationId, options.partitions),
        arrivedMs: Math.round(cursor),
        // Twelve model calls, so the total inherits their tail.
        serviceMs: logNormal(rng, 14_000, 0.9),
        reason: weighted(rng, degraded ? DEGRADED_REASONS : HEALTHY_REASONS),
        abstained: rng() < 0.17,
        approvalRoll: rng(),
        // A normalized token-level Levenshtein distance, which is what the
        // column stores (db/003) and what `approvalEditDistance` returns.
        // The median says most drafts survive nearly intact; the sigma keeps
        // the long right tail, because a person who rewrites a draft rewrites
        // most of it. `logNormalUnit` takes the same two draws `logNormal`
        // took, so the rest of the history is unmoved by the correction.
        editRaw: logNormalUnit(rng, 0.06, 1.1),
        unknownRoll: rng(),
        runId: seededUuid(rng),
      });
    }

    // The day's runs, before the steps each one journals are drawn.
    const dayRuns: PlannedRunCore[] = [];

    // The consumer loop, as consumer-main.ts and processQueuedTickets run it.
    //
    // Each consumer is one server. It wakes on its poll tick, takes every
    // message queued across the partitions it owns, and walks that batch
    // serially. So a ticket waits for the tick, then for everything ahead of
    // it in the batch — including tickets on a different partition the same
    // consumer owns, which is the head-of-line delay item 7 names.
    const freeAt = new Map<number, number>();
    const byConsumer = new Map<number, typeof drawn>();
    for (const a of drawn) {
      const owner = ownerOf(a.partition);
      const list = byConsumer.get(owner) ?? [];
      list.push(a);
      byConsumer.set(owner, list);
    }

    for (const [owner, queue] of byConsumer) {
      // Served in the order the queue filled.
      queue.sort((x, y) => x.arrivedMs - y.arrivedMs);
      for (const a of queue) {
        // When the consumer learns the message exists. With the arrival
        // signal that is the instant it was queued, because intake notifies
        // inside the same transaction. Without it, the next poll tick: a
        // message was invisible until the consumer looked, whatever the load.
        const visibleMs = wakeOnArrival
          ? a.arrivedMs
          : dayStartMs + Math.ceil((a.arrivedMs - dayStartMs) / pollMs) * pollMs;
        const free = freeAt.get(owner) ?? 0;
        const startedMs = Math.max(visibleMs, free);
        freeAt.set(owner, startedMs + a.serviceMs);

        // An abstain escalates before the gate step starts, so such a run
        // carries no gate row and no approval. DEC-07: it is a correct
        // output, not an error, and it keeps its partial work.
        const reason = a.abstained ? null : a.reason;
        // A person approves a parked run (DEC-12 for a customer reply, DEC-34
        // for a write with no draft), and the distance is what they changed.
        // Most drafts survive nearly intact.
        const approved =
          reason !== null
            && !ESCALATING_REASONS.has(reason)
            && reason !== 'auto'
            && a.approvalRoll < 0.62;
        // DEC-30 makes an unknown delivery terminal AND escalating, so a run
        // carrying one cannot also be resolved. Only an automatic write
        // reaches the relay at all.
        const unknownDelivery = reason === 'auto' && a.unknownRoll < 0.02;
        const state = a.abstained
          ? 'escalated'
          : unknownDelivery
            ? 'escalated'
            : stateFor(reason ?? 'auto', approved);

        // Why the run stopped, read off what it did rather than drawn.
        //
        // Three paths reach `escalated` here and each one names itself. The
        // composer's abstain is a determination, not a fault, and
        // `stopEscalated` journals it as such (DEC-07). A policy escalation
        // is the engine's `escalate` verdict, which is the whole of
        // ESCALATING_REASONS. An unknown delivery is the relay's, and it is
        // the one that does not come from the coordinator at all.
        //
        // Drawing this would have let a run that abstained report a policy
        // escalation. The console renders the state and the reason side by
        // side, so the contradiction would be on screen with nothing to say
        // which half was wrong. It also needs no draw at all, so the history
        // above it is untouched.
        const escalation: PlannedRun['escalation'] = a.abstained
          ? 'composer_abstained'
          : unknownDelivery
            ? 'relay_delivery_unknown'
            : state === 'escalated'
              ? 'policy_escalated'
              : null;

        // db/005 defines service time as finished_at - created_at, so an
        // approved run's service time includes the wait for the person. That
        // is the truth about this system: DEC-12 puts a person on every
        // customer reply, and the ledger measures the run, not the model
        // calls inside it. Drawn log-normal around three quarters of an hour.
        const approvalMs = approved ? logNormal(rng, 2_700_000, 1.0) : 0;
        const finishedAt =
          state === 'awaiting_approval'
            ? null
            : new Date(startedMs + a.serviceMs + approvalMs);
        dayRuns.push({
          runId: a.runId,
          ticketId: a.ticketId,
          conversationId: a.conversationId,
          partition: a.partition,
          enqueuedAt: new Date(a.arrivedMs),
          createdAt: new Date(startedMs),
          serviceMs: a.serviceMs,
          finishedAt,
          state,
          abstained: a.abstained,
          reason,
          escalation,
          provider: options.provider,
          editDistance: approved ? a.editRaw : null,
          outbox: unknownDelivery ? ['delivery_unknown'] : [],
        });
      }
    }

    // The steps each run journals, drawn only once every draw the day already
    // made has been made.
    //
    // The position is load-bearing. `pnpm run bands` reads three journal
    // fields — the compose step's `abstained` and `provider`, and the gate
    // step's `reason` — and publishes them as a control band, while
    // `docs/v1-architecture.md` quotes a mean service time off the finish
    // stamps the loop above draws. A draw inserted anywhere earlier shifts
    // every value after it in the stream, so adding detail to a run would
    // have moved the published numbers that describe it. Appended, it moves
    // nothing above it, and `plan.test.ts` pins that against the planner as
    // it stood before this detail existed.
    for (const run of dayRuns) {
      planned.push({ ...run, ...planDetail(rng, run.abstained ? null : run.reason, run.ticketId) });
    }
  }
  return planned;
}
