/**
 * Policy engine (section 4.8). Obeys DEC-03, DEC-06, DEC-12, DEC-13, DEC-34.
 *
 * A pure function. It calls no model and reads no state.
 *
 * Rule order below is authoritative and follows section 4.8 exactly:
 * autonomy decreases to agree with the guarantees the target system gives
 * (DEC-06), customer replies always need approval (DEC-12), a write that
 * cannot be reversed always gates (DEC-34, extending DEC-03), and one
 * global agreement threshold applies with person-set risk tiers (DEC-13).
 */

/** Cost of an error for an intent. A person sets it; the system does not learn it (DEC-13). */
export type RiskTier = 'low' | 'medium' | 'high';

/** Capability declaration from section 4.1. Autonomy adapts to these (DEC-06). */
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
 * They travel as data so a fitted value can reach the engine. DEC-13 rules
 * out a threshold per intent, and this shape cannot express one: there is no
 * intent key, so one agreement value governs every ticket.
 *
 * DEC-05 keeps the two gates independent. The agreement value and the
 * coverage values live in one record for transport only. No rule reads both,
 * and nothing here combines them into a score.
 */
export interface GateThresholds {
  /** Section 4.5. Below this, escalate. */
  readonly agreement: number;
  /** Section 4.7. Below this, block. Do not send. */
  readonly groundednessBlock: number;
  /** Section 4.7. Below this, send to a person for review. */
  readonly groundednessReview: number;
}

export interface PolicyInput {
  riskTier: RiskTier;
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
  // Frozen: the record is shared by reference into every PolicyInput a
  // process builds, so one mutation anywhere would move the gate for all of
  // them. `readonly` is a compile-time claim and does not survive to runtime.
  return Object.freeze({
    agreement: values.agreement,
    groundednessBlock: values.groundednessBlock,
    groundednessReview: values.groundednessReview,
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

export function evaluatePolicy(input: PolicyInput): PolicyDecision {
  // DEC-06: no idempotency support means no automatic write, whatever the evidence.
  if (!input.capabilities.supportsIdempotencyKey && input.action.isWrite) return 'gated';
  // DEC-12: customer replies always need approval.
  if (input.action.isCustomerVisible) return 'gated';
  // DEC-34: an irreversible write never reaches the automatic path,
  // whatever the gates read — compensation of a sent refund gates like a
  // customer reply does.
  if (input.action.isWrite && input.action.isIrreversible) return 'gated';
  // DEC-03/DEC-13: a high-risk intent never reaches the automatic path,
  // regardless of the gate values.
  if (input.riskTier === 'high') return 'gated';
  // Gate 1: sample agreement (DEC-05).
  if (input.agreement < input.thresholds.agreement) return 'escalate';
  // Gate 2: groundedness coverage (DEC-05, section 4.7 thresholds).
  if (input.groundedness < input.thresholds.groundednessBlock) return 'escalate';
  if (input.groundedness < input.thresholds.groundednessReview) return 'gated';
  return 'auto';
}
