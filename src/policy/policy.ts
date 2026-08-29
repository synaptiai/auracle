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

export interface PolicyInput {
  riskTier: RiskTier;
  /** Fraction of classifier samples that agree (section 4.5). */
  agreement: number;
  /** Fraction of claims the retrieved text supports (section 4.7). */
  groundedness: number;
  capabilities: AdapterCapabilities;
  action: ActionClass;
}

export type PolicyDecision = 'auto' | 'gated' | 'escalate';

/**
 * Seed value from section 4.5. Calibration refits it per DEC-13.
 * At k=9 and 0.6, precision is 0.985 with 74 percent of tickets passing.
 */
export const GATE_AGREEMENT = 0.6;

/** Below this, block. Do not send (section 4.7). */
const GROUNDEDNESS_BLOCK = 0.7;

/** Below this, send to a person for review (section 4.7). */
const GROUNDEDNESS_REVIEW = 0.8;

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
  if (input.agreement < GATE_AGREEMENT) return 'escalate';
  // Gate 2: groundedness coverage (DEC-05, section 4.7 thresholds).
  if (input.groundedness < GROUNDEDNESS_BLOCK) return 'escalate';
  if (input.groundedness < GROUNDEDNESS_REVIEW) return 'gated';
  return 'auto';
}
