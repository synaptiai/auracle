/**
 * Policy engine (section 4.8). Obeys DEC-03, DEC-06, DEC-12, DEC-13, DEC-30,
 * DEC-34.
 *
 * A pure function. It calls no model and reads no state.
 *
 * Rule order below is authoritative and follows section 4.8 exactly:
 * autonomy decreases to agree with the guarantees the target system gives
 * (DEC-06), customer replies always need approval (DEC-12), a write that
 * cannot be reversed always gates (DEC-34, extending DEC-03), and one
 * global agreement threshold applies with person-set risk tiers (DEC-13).
 *
 * Two capability flags carry that first rule, not one. An adapter with no
 * idempotency key cannot make a retry safe, and an adapter with no read-back
 * cannot say whether its write landed: `resolveSendFailure` escalates such a
 * failure rather than retry blind (DEC-30). An automatic write needs both
 * guarantees, so both are read here.
 */

/** Cost of an error for an intent. A person sets it; the system does not learn it (DEC-13). */
export type RiskTier = 'low' | 'medium' | 'high';

/**
 * Capability declaration from section 4.1. Autonomy adapts to these (DEC-06).
 *
 * `supportsIdempotencyKey` and `supportsReadBack` are the two the engine
 * reads. Each is a separate guarantee about a write's outcome, and an
 * automatic write needs both: one makes a retry safe, the other makes the
 * result knowable. The remaining three describe what an adapter can carry,
 * not what it guarantees about a delivery, so no rule reads them.
 */
export interface AdapterCapabilities {
  supportsIdempotencyKey: boolean;
  supportsReadBack: boolean;
  supportsDraftState: boolean;
  supportsStructuredFields: boolean;
  supportsThreading: boolean;
}

/** Observable properties of the action class under evaluation. */
export interface ActionClass {
  isWrite: boolean;
  isCustomerVisible: boolean;
  /**
   * The write cannot be undone once delivered (a sent refund). DEC-34
   * extends DEC-03's reversible-write limit, so such an action never takes
   * the automatic path, whatever the gates read.
   */
  isIrreversible: boolean;
}

/**
 * The three numbers that govern the gates (section 4.5, section 4.7).
 *
 * They travel as data so a fitted value can reach the engine.
 *
 * DEC-13 binds below the labelled-case trigger: one global threshold. DEC-41
 * governs above it: a threshold for each intent that could be fitted. The
 * engine does not know which side of the trigger a deployment is on, and it
 * must not — the calibration job decides that and hands over a map. An empty
 * map is the DEC-13 path, expressed as data rather than as a special case.
 *
 * DEC-13's second rule is untouched and unconditional. A person sets the risk
 * tier and the system never learns one, so a high-risk intent still never
 * reaches the automatic path whatever its threshold says.
 *
 * DEC-05 keeps the two gates independent. The agreement value and the
 * coverage values live in one record for transport only. No rule reads both,
 * and nothing here combines them into a score. The map belongs to the
 * agreement gate alone and no coverage rule reads it.
 */
export interface GateThresholds {
  /** Section 4.5. Below this, escalate. */
  readonly agreement: number;
  /**
   * DEC-41: the threshold fitted for each intent that cleared the fit.
   *
   * Absent or empty below the trigger. An intent with no entry keeps the
   * global value, which is the fallback DEC-41 requires; the global value is
   * never copied in, so an entry always means a threshold that was fitted.
   */
  readonly perIntent?: Readonly<Record<string, number>>;
  /** Section 4.7. Below this, block. Do not send. */
  readonly groundednessBlock: number;
  /** Section 4.7. Below this, send to a person for review. */
  readonly groundednessReview: number;
}

export interface PolicyInput {
  riskTier: RiskTier;
  /**
   * DEC-41: the intent this run classified, so the gate can read the
   * threshold fitted for it. Optional, because a run may carry none and
   * because every caller predating DEC-41 supplies none; such a run takes
   * the global threshold.
   */
  intent?: string;
  /** Fraction of classifier samples that agree (section 4.5). */
  agreement: number;
  /** Fraction of claims the retrieved text supports (section 4.7). */
  groundedness: number;
  /**
   * The gate numbers this decision applies. Injected, never loaded here: the
   * engine stays a pure synchronous function that reads no state.
   */
  thresholds: GateThresholds;
  capabilities: AdapterCapabilities;
  action: ActionClass;
}

export type PolicyDecision = 'auto' | 'gated' | 'escalate';

/**
 * Seed value from section 4.5. Calibration refits it per DEC-13.
 * At k=9 and 0.6, precision is 0.985 with 74 percent of tickets passing.
 */
export const GATE_AGREEMENT = 0.6;

/**
 * Seed value from section 4.7. `pnpm run fit-groundedness` refits it (DEC-07).
 *
 * Framed as a seed, like GATE_AGREEMENT above. It read as the operative value
 * for as long as nothing could fit it, and a job now can: a process holding a
 * coverage artifact runs a different pair and says so at startup.
 */
export const GROUNDEDNESS_BLOCK = 0.7;

/** Seed value from section 4.7, refitted the same way. Below this, a person reviews. */
export const GROUNDEDNESS_REVIEW = 0.8;

/**
 * The documented seeds, used until a fitting run produces an artifact.
 *
 * A process that adopts these says so at startup. A seed that reads like a
 * fitted number is how the open loop stayed invisible: the job wrote an
 * artifact for months and no gate moved.
 */
export const SEED_THRESHOLDS: GateThresholds = Object.freeze(makeThresholds({
  agreement: GATE_AGREEMENT,
  groundednessBlock: GROUNDEDNESS_BLOCK,
  groundednessReview: GROUNDEDNESS_REVIEW,
}));

/**
 * Validate a threshold set, or throw.
 *
 * The order constraint is the one a fit can break. Below block the engine
 * escalates and below review it gates, so an inverted pair empties the review
 * band and escalates values the register sends to a person. A fitted pair is
 * two independent searches over one score, so nothing in the fit guarantees
 * the order — this is where it is guaranteed.
 */
/**
 * The one spelling of an intent id that the per-intent map is keyed on.
 *
 * The classifier only ever returns a normalised id: it builds its valid set
 * with the same rule and counts nothing outside it. So the gate looks up a
 * normalised key, and a map keyed on a raw taxonomy id would miss every
 * lookup the moment an adopter capitalises anything. Both sides call this,
 * which is the only way the two vocabularies cannot drift apart.
 */
export function normalizeIntentId(id: string): string {
  return id.trim().toLowerCase();
}

/**
 * Validates a per-intent map and returns a frozen copy with no prototype.
 *
 * `Object.create(null)` is the point, not tidiness. A plain object inherits
 * from `Object.prototype`, so an intent named `constructor` or `toString`
 * resolves off the prototype chain and the gate reads a function instead of
 * `undefined`; comparing agreement against it coerces to NaN, which is false,
 * and the gate then passes every ticket for that intent. Those are legal
 * lower-case slugs an adopter could put in a taxonomy.
 */
function freezeIntentMap(map: Readonly<Record<string, number>>): Readonly<Record<string, number>> {
  const safe = Object.create(null) as Record<string, number>;
  for (const [intent, threshold] of Object.entries(map)) {
    assertFraction(threshold, `perIntent.${intent}`);
    safe[normalizeIntentId(intent)] = threshold;
  }
  return Object.freeze(safe);
}

export function makeThresholds(values: GateThresholds): GateThresholds {
  assertFraction(values.agreement, 'agreement');
  assertFraction(values.groundednessBlock, 'groundednessBlock');
  assertFraction(values.groundednessReview, 'groundednessReview');
  if (values.groundednessBlock > values.groundednessReview) {
    throw new Error(
      `groundedness block ${values.groundednessBlock} exceeds review ${values.groundednessReview}; `
        + 'below block escalates and below review gates, so an inverted pair has no review band',
    );
  }
  // Every per-intent threshold is held to the same rule as the global one. A
  // zero passes every ticket for that intent, which is the gate switched off
  // for it, and nothing downstream would say so.
  const perIntent = values.perIntent === undefined
    ? undefined
    : freezeIntentMap(values.perIntent);

  // Frozen: the record is shared by reference into every PolicyInput a
  // process builds, so one mutation anywhere would move the gate for all of
  // them. `readonly` is a compile-time claim and does not survive to runtime.
  //
  // The three fields are listed rather than spread, so a caller cannot smuggle
  // a fourth in. That is why `perIntent` had to be named here: a version of
  // this change spread it in at the call site and it was dropped in silence,
  // leaving a wired feature that could never fire.
  return Object.freeze({
    agreement: values.agreement,
    groundednessBlock: values.groundednessBlock,
    groundednessReview: values.groundednessReview,
    ...(perIntent === undefined ? {} : { perIntent }),
  });
}

/**
 * A threshold must be a fraction, and it must be above zero.
 *
 * At zero the comparison never fails, so the gate passes every ticket. DEC-05
 * gives the system two gates and neither is optional, so a set that disables
 * one is refused rather than adopted. The fitter cannot reach zero either:
 * agreement is a count over CLASSIFIER_K samples and the modal count is at
 * least one, so its lowest candidate is 1/9.
 */
function assertFraction(value: number, field: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`threshold ${field} must be a number in (0, 1], got ${String(value)}`);
  }
}

/**
 * Which rule decided, named after the rule rather than after its outcome.
 *
 * The verdict alone is ambiguous in the one direction a report needs: a
 * `gated` run may have been stopped by a rule that returns before the
 * agreement gate is read, or it may have reached that gate, passed it, and
 * then landed in the groundedness review band. Nothing downstream could tell
 * those apart, so a report on the agreement gate could not state its own
 * population, and its rate would move with traffic mix instead of with
 * classifier health.
 */
export type PolicyReason =
  | 'no_idempotency'
  | 'no_read_back'
  | 'customer_visible'
  | 'irreversible'
  | 'high_risk'
  | 'agreement'
  | 'groundedness_block'
  | 'groundedness_review'
  | 'auto';

export interface PolicyOutcome {
  decision: PolicyDecision;
  reason: PolicyReason;
}

/**
 * Every reason, as a list.
 *
 * The record is typed by the union, so the compiler refuses this file when a
 * reason is added to `PolicyReason` and not here. A reader that built its own
 * list would silently miss the new one and drop those runs from its counts.
 */
const ALL_REASONS: Record<PolicyReason, true> = {
  no_idempotency: true,
  no_read_back: true,
  customer_visible: true,
  irreversible: true,
  high_risk: true,
  agreement: true,
  groundedness_block: true,
  groundedness_review: true,
  auto: true,
};

export const POLICY_REASONS: readonly PolicyReason[] = Object.keys(ALL_REASONS) as PolicyReason[];

/**
 * Which side of the agreement comparison each rule sits on.
 *
 * A record over the whole union, not a set of the four. A set answers "not
 * present" for a reason nobody listed, so `reachedAgreementGate` failed open:
 * add a fifth short-circuit rule and the build stays green while every run it
 * stops is counted as an agreement pass, inflating the rate. The record makes
 * the compiler refuse this file until the new reason is placed.
 */
const REACHES_AGREEMENT: Record<PolicyReason, boolean> = {
  no_idempotency: false,
  no_read_back: false,
  customer_visible: false,
  irreversible: false,
  high_risk: false,
  agreement: true,
  groundedness_block: true,
  groundedness_review: true,
  auto: true,
};

/**
 * Whether the run got as far as comparing agreement against its threshold.
 *
 * Exported so a reader never re-derives the precedence order. A second copy
 * of that order is free to drift from this one, which is the hazard of
 * re-applying a gate outside the engine.
 */
/**
 * The agreement threshold this ticket is judged against.
 *
 * Pure and total: it reads the map the caller supplied and never loads one.
 * The engine stays a synchronous function that reads no state (section 4.3).
 */
export function agreementThresholdFor(
  input: Pick<PolicyInput, 'intent' | 'thresholds'>,
): number {
  const map = input.thresholds.perIntent;
  if (input.intent === undefined || map === undefined) return input.thresholds.agreement;
  // `Object.hasOwn`, never a bare read. `makeThresholds` builds the map with
  // no prototype, and this is the second guard: a map that reached here by
  // another route cannot resolve `constructor` or `toString` off the chain.
  const key = normalizeIntentId(input.intent);
  if (!Object.hasOwn(map, key)) return input.thresholds.agreement;
  const fitted = map[key];
  // A non-finite or out-of-range value would compare false against any
  // agreement and pass every ticket. The global threshold is the safe answer.
  if (typeof fitted !== 'number' || !(fitted > 0) || fitted > 1) {
    return input.thresholds.agreement;
  }
  return fitted;
}

export function reachedAgreementGate(reason: PolicyReason): boolean {
  return REACHES_AGREEMENT[reason];
}

/**
 * Whether the run's coverage was compared against a threshold.
 *
 * The same hazard as `REACHES_AGREEMENT`, one gate later. `journalFinish`
 * records `groundedness` on every gate row whether or not the engine read it,
 * so a reader with the number in hand cannot tell a coverage that decided
 * from one that was merely measured.
 *
 * Coverage is read last. Every reason that stops before the agreement
 * comparison stops before this one too, and a run stopped by agreement never
 * reaches it either. So this is `false` wherever `REACHES_AGREEMENT` is,
 * plus `agreement`.
 *
 * Recorded rather than derived, and exhaustive over `PolicyReason`, so a new
 * reason makes the compiler refuse this file. A surface that showed a
 * coverage the engine never read told a person that six runs in ten had
 * failed groundedness when none of them had been judged on it.
 */
const READS_COVERAGE: Record<PolicyReason, boolean> = {
  no_idempotency: false,
  no_read_back: false,
  customer_visible: false,
  irreversible: false,
  high_risk: false,
  agreement: false,
  groundedness_block: true,
  groundedness_review: true,
  auto: true,
};

export function readCoverageGate(reason: PolicyReason): boolean {
  return READS_COVERAGE[reason];
}

/**
 * Whether the agreement gate passed, for a run that reached it.
 *
 * Not the same question as whether every gate passed. The gates are
 * independent (DEC-05), so a run that cleared agreement and then failed on
 * groundedness passed this one. Counting only `auto` would fold the second
 * gate into the first and the rate would track the wrong one.
 */
export function passedAgreementGate(reason: PolicyReason): boolean {
  return reachedAgreementGate(reason) && reason !== 'agreement';
}

/**
 * The whole rule, stated once. `evaluatePolicy` returns this verdict.
 *
 * Pure and synchronous: it calls no model and reads no state, so the same
 * inputs always give the same answer (section 4.8).
 */
export function evaluatePolicyDetailed(input: PolicyInput): PolicyOutcome {
  // DEC-06: no idempotency support means no automatic write, whatever the evidence.
  if (!input.capabilities.supportsIdempotencyKey && input.action.isWrite) {
    return { decision: 'gated', reason: 'no_idempotency' };
  }
  // DEC-06 and DEC-30: no read-back means the delivery state of an automatic
  // write can never be established. The relay escalates such a failure
  // instead of retrying, so the write does not belong on the automatic path.
  // Second, and not first, because an adapter missing both flags is named by
  // the guarantee that already governs every existing adapter.
  if (!input.capabilities.supportsReadBack && input.action.isWrite) {
    return { decision: 'gated', reason: 'no_read_back' };
  }
  // DEC-12: customer replies always need approval.
  if (input.action.isCustomerVisible) return { decision: 'gated', reason: 'customer_visible' };
  // DEC-34: an irreversible write never reaches the automatic path,
  // whatever the gates read — compensation of a sent refund gates like a
  // customer reply does.
  if (input.action.isWrite && input.action.isIrreversible) {
    return { decision: 'gated', reason: 'irreversible' };
  }
  // DEC-03/DEC-13: a high-risk intent never reaches the automatic path,
  // regardless of the gate values.
  if (input.riskTier === 'high') return { decision: 'gated', reason: 'high_risk' };
  // Gate 1: sample agreement (DEC-05).
  //
  // The intent's own threshold when the fit produced one, the global value
  // otherwise (DEC-41, and DEC-13 below the trigger). A run that names no
  // intent takes the global value: there is no entry to read, and picking
  // one would apply another intent's gate to this ticket.
  if (input.agreement < agreementThresholdFor(input)) {
    return { decision: 'escalate', reason: 'agreement' };
  }
  // Gate 2: groundedness coverage (DEC-05, section 4.7 thresholds).
  if (input.groundedness < input.thresholds.groundednessBlock) {
    return { decision: 'escalate', reason: 'groundedness_block' };
  }
  if (input.groundedness < input.thresholds.groundednessReview) {
    return { decision: 'gated', reason: 'groundedness_review' };
  }
  return { decision: 'auto', reason: 'auto' };
}

/**
 * The verdict alone.
 *
 * Delegates rather than restating the rule, so the two can never disagree.
 * Every existing caller that needs only the verdict keeps this signature.
 */
export function evaluatePolicy(input: PolicyInput): PolicyDecision {
  return evaluatePolicyDetailed(input).decision;
}
