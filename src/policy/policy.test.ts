import { describe, expect, it } from 'vitest';

import { evaluatePolicy, GATE_AGREEMENT, SEED_THRESHOLDS, makeThresholds } from './policy.js';
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
    thresholds: SEED_THRESHOLDS,
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

// The whole point of closing the calibration loop: a fitted number governs
// the gate. Every case here fails if evaluatePolicy reads a module constant
// instead of the record it was handed.
describe('the injected thresholds govern the gates (DEC-05, DEC-13)', () => {
  it('escalates evidence the seed would have passed when the fit is stricter', () => {
    // 0.72 clears the 0.6 seed and fails a fitted 0.78.
    const input = baseInput({ agreement: 0.72 });

    expect(evaluatePolicy(input)).toBe('auto');
    expect(
      evaluatePolicy({
        ...input,
        thresholds: makeThresholds({ ...SEED_THRESHOLDS, agreement: 0.78 }),
      }),
    ).toBe('escalate');
  });

  it('passes evidence the seed would have escalated when the fit is looser', () => {
    const input = baseInput({ agreement: 0.55 });

    expect(evaluatePolicy(input)).toBe('escalate');
    expect(
      evaluatePolicy({
        ...input,
        thresholds: makeThresholds({ ...SEED_THRESHOLDS, agreement: 0.5 }),
      }),
    ).toBe('auto');
  });

  it('moves the groundedness block band with the injected value', () => {
    const input = baseInput({ groundedness: 0.72 });

    // 0.72 sits in the seed's review band, so it gates.
    expect(evaluatePolicy(input)).toBe('gated');
    // Raise block above it and the same evidence escalates.
    expect(
      evaluatePolicy({
        ...input,
        thresholds: makeThresholds({
          ...SEED_THRESHOLDS,
          groundednessBlock: 0.75,
          groundednessReview: 0.85,
        }),
      }),
    ).toBe('escalate');
  });

  it('moves the groundedness review band with the injected value', () => {
    const input = baseInput({ groundedness: 0.85 });

    // Above the 0.80 seed review, so it runs automatically.
    expect(evaluatePolicy(input)).toBe('auto');
    // Raise review above it and the same evidence goes to a person.
    expect(
      evaluatePolicy({
        ...input,
        thresholds: makeThresholds({ ...SEED_THRESHOLDS, groundednessReview: 0.9 }),
      }),
    ).toBe('gated');
  });

  it('leaves the gates independent: a stricter coverage pair moves no agreement verdict', () => {
    // DEC-05. Agreement below the threshold escalates on gate 1, and the
    // coverage numbers cannot rescue or worsen that verdict.
    const failing = baseInput({ agreement: 0.4, groundedness: 1 });

    for (const groundednessReview of [0.5, 0.8, 1]) {
      const decision = evaluatePolicy({
        ...failing,
        thresholds: makeThresholds({
          agreement: 0.6,
          groundednessBlock: 0.5,
          groundednessReview,
        }),
      });
      expect(decision).toBe('escalate');
    }
  });

  it('still applies the DEC-12 and DEC-34 rules before it reads a threshold', () => {
    // The thresholds decide the automatic path only. A customer reply is
    // gated before either gate is read, whatever the fit says.
    // The loosest set the validator accepts: a threshold of zero is refused,
    // because a gate that passes everything is not a gate.
    const permissive = makeThresholds({
      agreement: Number.MIN_VALUE,
      groundednessBlock: Number.MIN_VALUE,
      groundednessReview: Number.MIN_VALUE,
    });
    const reply = baseInput({
      agreement: 1,
      groundedness: 1,
      thresholds: permissive,
      action: { isWrite: false, isCustomerVisible: true, isIrreversible: false },
    });

    expect(evaluatePolicy(reply)).toBe('gated');
  });
});
