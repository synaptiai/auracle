import { describe, expect, it } from 'vitest';

import { evaluatePolicy, GATE_AGREEMENT } from './policy.js';
import type { AdapterCapabilities, PolicyInput } from './policy.js';

// An adapter that supports everything: any gate failure then comes from the
// evidence values, not from missing capabilities.
const FULL_CAPABILITIES: AdapterCapabilities = {
  supportsIdempotencyKey: true,
  supportsReadBack: true,
  supportsDraftState: true,
  supportsStructuredFields: true,
  supportsThreading: true,
};

function baseInput(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    riskTier: 'low',
    agreement: 0.9,
    groundedness: 0.95,
    capabilities: FULL_CAPABILITIES,
    action: { isWrite: false, isCustomerVisible: false, isIrreversible: false },
    ...overrides,
  };
}

describe('evaluatePolicy (section 4.8, DEC-03/06/12/13)', () => {
  it('returns auto when every rule passes', () => {
    expect(evaluatePolicy(baseInput())).toBe('auto');
  });

  it('returns auto for a reversible write on a fully capable adapter (DEC-03, DEC-12)', () => {
    const decision = evaluatePolicy(
      baseInput({ action: { isWrite: true, isCustomerVisible: false, isIrreversible: false } }),
    );
    expect(decision).toBe('auto');
  });

  describe('rule 1: no idempotency support plus a write gates (DEC-06)', () => {
    it('gates a write when supportsIdempotencyKey is false', () => {
      const decision = evaluatePolicy(
        baseInput({
          capabilities: { ...FULL_CAPABILITIES, supportsIdempotencyKey: false },
          action: { isWrite: true, isCustomerVisible: false, isIrreversible: false },
        }),
      );
      expect(decision).toBe('gated');
    });

    it('ignores the idempotency rule for read-only actions', () => {
      const decision = evaluatePolicy(
        baseInput({
          capabilities: { ...FULL_CAPABILITIES, supportsIdempotencyKey: false },
        }),
      );
      expect(decision).toBe('auto');
    });

    it('beats every later rule: high risk and failing evidence still gate', () => {
      const decision = evaluatePolicy(
        baseInput({
          riskTier: 'high',
          agreement: 0.1,
          groundedness: 0.1,
          capabilities: { ...FULL_CAPABILITIES, supportsIdempotencyKey: false },
          action: { isWrite: true, isCustomerVisible: true, isIrreversible: false },
        }),
      );
      expect(decision).toBe('gated');
    });
  });

  describe('rule 2: customer-visible actions always gate (DEC-12)', () => {
    it('gates a customer-visible reply with perfect evidence', () => {
      const decision = evaluatePolicy(
        baseInput({ action: { isWrite: false, isCustomerVisible: true, isIrreversible: false } }),
      );
      expect(decision).toBe('gated');
    });

    it('beats the later rules: low agreement and low groundedness still gate', () => {
      const decision = evaluatePolicy(
        baseInput({
          agreement: 0.1,
          groundedness: 0.1,
          action: { isWrite: false, isCustomerVisible: true, isIrreversible: false },
        }),
      );
      expect(decision).toBe('gated');
    });
  });

  describe('rule 3: an irreversible write always gates (DEC-03, V2)', () => {
    it('gates an irreversible write with perfect evidence', () => {
      const decision = evaluatePolicy(
        baseInput({
          action: { isWrite: true, isCustomerVisible: false, isIrreversible: true },
        }),
      );
      expect(decision).toBe('gated');
    });

    it('gates regardless of risk tier and both evidence gates', () => {
      const decision = evaluatePolicy(
        baseInput({
          riskTier: 'low',
          agreement: 1.0,
          groundedness: 1.0,
          action: { isWrite: true, isCustomerVisible: false, isIrreversible: true },
        }),
      );
      expect(decision).toBe('gated');
    });

    it('never escalates on the evidence gates: gating wins first', () => {
      const decision = evaluatePolicy(
        baseInput({
          agreement: 0.1,
          groundedness: 0.1,
          action: { isWrite: true, isCustomerVisible: false, isIrreversible: true },
        }),
      );
      expect(decision).toBe('gated');
    });

    it('does not gate a reversible write with the same evidence', () => {
      const decision = evaluatePolicy(
        baseInput({
          action: { isWrite: true, isCustomerVisible: false, isIrreversible: false },
        }),
      );
      expect(decision).toBe('auto');
    });
  });

  describe('rule 4: high risk tier gates (DEC-13)', () => {
    it('gates a high-risk intent with perfect evidence', () => {
      const decision = evaluatePolicy(baseInput({ riskTier: 'high' }));
      expect(decision).toBe('gated');
    });

    it('gates a high-risk intent regardless of full agreement and coverage', () => {
      const decision = evaluatePolicy(
        baseInput({
          riskTier: 'high',
          agreement: 1.0,
          groundedness: 1.0,
          action: { isWrite: true, isCustomerVisible: false, isIrreversible: false },
        }),
      );
      expect(decision).toBe('gated');
    });

    it('beats the evidence rules: low agreement still gates, not escalates', () => {
      const decision = evaluatePolicy(
        baseInput({ riskTier: 'high', agreement: 0.1, groundedness: 0.1 }),
      );
      expect(decision).toBe('gated');
    });

    it('lets medium and low risk tiers through to the evidence rules', () => {
      for (const riskTier of ['low', 'medium'] as const) {
        expect(evaluatePolicy(baseInput({ riskTier }))).toBe('auto');
      }
    });
  });

  describe('rule 5: agreement below GATE_AGREEMENT escalates (DEC-05, section 4.5)', () => {
    it('escalates when agreement is below the threshold', () => {
      const decision = evaluatePolicy(baseInput({ agreement: GATE_AGREEMENT - 0.01 }));
      expect(decision).toBe('escalate');
    });

    it('passes at exactly the threshold (strict less-than)', () => {
      const decision = evaluatePolicy(baseInput({ agreement: GATE_AGREEMENT }));
      expect(decision).toBe('auto');
    });
  });

  describe('rules 6 and 7: groundedness thresholds (DEC-05, section 4.7)', () => {
    it('escalates below 0.70 even with full agreement', () => {
      const decision = evaluatePolicy(baseInput({ groundedness: 0.69 }));
      expect(decision).toBe('escalate');
    });

    it('does not escalate at exactly 0.70; sends to review instead', () => {
      const decision = evaluatePolicy(baseInput({ groundedness: 0.7 }));
      expect(decision).toBe('gated');
    });

    it('gates between 0.70 and 0.80', () => {
      const decision = evaluatePolicy(baseInput({ groundedness: 0.75 }));
      expect(decision).toBe('gated');
    });

    it('returns auto at exactly 0.80', () => {
      const decision = evaluatePolicy(baseInput({ groundedness: 0.8 }));
      expect(decision).toBe('auto');
    });

    it('escalation on low groundedness beats the review gate below 0.80', () => {
      const escalate = evaluatePolicy(baseInput({ groundedness: 0.5 }));
      const gated = evaluatePolicy(baseInput({ groundedness: 0.75 }));
      expect(escalate).toBe('escalate');
      expect(gated).toBe('gated');
    });
  });

  describe('precedence order across all three outcomes', () => {
    it('capability gate beats risk tier and both evidence gates', () => {
      const decision = evaluatePolicy(
        baseInput({
          riskTier: 'high',
          agreement: 0.2,
          groundedness: 0.2,
          capabilities: { ...FULL_CAPABILITIES, supportsIdempotencyKey: false },
          action: { isWrite: true, isCustomerVisible: false, isIrreversible: false },
        }),
      );
      expect(decision).toBe('gated');
    });

    it('risk tier beats agreement escalation', () => {
      const decision = evaluatePolicy(
        baseInput({ riskTier: 'high', agreement: 0.2 }),
      );
      expect(decision).toBe('gated');
    });

    it('agreement escalation beats groundedness escalation', () => {
      // Both gates fail; the outcome is escalate either way, so assert via a
      // case where only ordering distinguishes them: agreement fails while
      // groundedness sits in the gated band. Escalate proves agreement runs first.
      const decision = evaluatePolicy(
        baseInput({ agreement: 0.3, groundedness: 0.75 }),
      );
      expect(decision).toBe('escalate');
    });
  });
});
