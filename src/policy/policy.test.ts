import { describe, expect, it } from 'vitest';

import {
  evaluatePolicy,
  evaluatePolicyDetailed,
  POLICY_REASONS,
  passedAgreementGate,
  reachedAgreementGate,
  readCoverageGate,
  GATE_AGREEMENT,
  SEED_THRESHOLDS,
  makeThresholds,
} from './policy.js';
import type { AdapterCapabilities, PolicyInput } from './policy.js';

// An adapter that supports everything: any gate failure then comes from the
// evidence values, not from missing capabilities.
const FULL_CAPABILITIES: AdapterCapabilities = {
  supportsIdempotencyKey: true,
  supportsReadBack: true,
  supportsDraftState: true,
  supportsStructuredFields: true,
  supportsThreading: true,
  supportsLedgerReply: false,
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
  });

  // Rule 2 of section 4.8, and the second capability rule DEC-06 asks for.
  //
  // The relay already refuses to guess: without read-back a failed send
  // leaves the delivery state unknown, and `resolveSendFailure` escalates
  // rather than retry blind (DEC-30). An automatic write on such an adapter
  // is therefore a write whose outcome nobody can establish. DEC-06 says
  // autonomy decreases to agree with the declared capability, so the engine
  // never routes that write to the automatic path in the first place.
  describe('rule 2: no read-back support plus a write gates (DEC-06, DEC-30)', () => {
    it('gates a write when supportsReadBack is false', () => {
      const decision = evaluatePolicy(
        baseInput({
          capabilities: { ...FULL_CAPABILITIES, supportsReadBack: false },
          action: { isWrite: true, isCustomerVisible: false, isIrreversible: false },
        }),
      );
      expect(decision).toBe('gated');
    });

    it('ignores the read-back rule for read-only actions', () => {
      const decision = evaluatePolicy(
        baseInput({ capabilities: { ...FULL_CAPABILITIES, supportsReadBack: false } }),
      );
      expect(decision).toBe('auto');
    });

    // Asserted on the reason, not the verdict. Every later rule here also
    // gates, so a verdict assertion would pass with this rule deleted and
    // would prove the precedence of nothing.
    it('beats every later rule: high risk and failing evidence still name it', () => {
      const outcome = evaluatePolicyDetailed(
        baseInput({
          riskTier: 'high',
          agreement: 0.1,
          groundedness: 0.1,
          capabilities: { ...FULL_CAPABILITIES, supportsReadBack: false },
          action: { isWrite: true, isCustomerVisible: true, isIrreversible: true },
        }),
      );
      expect(outcome.decision).toBe('gated');
      expect(outcome.reason).toBe('no_read_back');
    });

    // The idempotency rule runs first, so an adapter missing both flags is
    // named by the first one. Pinned because the journalled reason is what a
    // report groups on: a silent reorder would move runs between populations.
    it('names the idempotency rule first when both capabilities are missing', () => {
      const outcome = evaluatePolicyDetailed(
        baseInput({
          capabilities: {
            ...FULL_CAPABILITIES,
            supportsIdempotencyKey: false,
            supportsReadBack: false,
          },
          action: { isWrite: true, isCustomerVisible: false, isIrreversible: false },
        }),
      );
      expect(outcome.reason).toBe('no_idempotency');
    });
  });

  describe('rule 3: customer-visible actions always gate (DEC-12)', () => {
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

  describe('rule 4: an irreversible write always gates (DEC-03, V2)', () => {
    it('gates an irreversible write with perfect evidence', () => {
      const decision = evaluatePolicy(
        baseInput({
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

  describe('rule 5: high risk tier gates (DEC-13)', () => {
    it('gates a high-risk intent with perfect evidence', () => {
      const decision = evaluatePolicy(baseInput({ riskTier: 'high' }));
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

  describe('rule 6: agreement below GATE_AGREEMENT escalates (DEC-05, section 4.5)', () => {
    it('escalates when agreement is below the threshold', () => {
      const decision = evaluatePolicy(baseInput({ agreement: GATE_AGREEMENT - 0.01 }));
      expect(decision).toBe('escalate');
    });

    it('passes at exactly the threshold (strict less-than)', () => {
      const decision = evaluatePolicy(baseInput({ agreement: GATE_AGREEMENT }));
      expect(decision).toBe('auto');
    });
  });

  describe('rules 7 and 8: groundedness thresholds (DEC-05, section 4.7)', () => {
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
  });

  describe('precedence order across all three outcomes', () => {

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

// The reason a verdict carries, so the ledger records what explains it.
//
// `thresholds` was added to the gate step's journal entry for the same
// stated reason: without it "the journal records the verdict and nothing
// that explains it". The verdict alone is ambiguous in one direction that
// matters — a `gated` run may have been short-circuited before the agreement
// gate was ever read, or it may have reached that gate, passed it, and then
// landed in the groundedness review band. Nothing downstream could tell those
// apart, so a report on the agreement gate could not name its own population.
describe('the reason a decision carries (section 4.8)', () => {
  const cases: ReadonlyArray<readonly [string, Partial<PolicyInput>, string, string]> = [
    [
      'no idempotency support on a write (DEC-06)',
      {
        capabilities: { ...FULL_CAPABILITIES, supportsIdempotencyKey: false },
        action: { isWrite: true, isCustomerVisible: false, isIrreversible: false },
      },
      'gated',
      'no_idempotency',
    ],
    [
      'no read-back support on a write (DEC-06, DEC-30)',
      {
        capabilities: { ...FULL_CAPABILITIES, supportsReadBack: false },
        action: { isWrite: true, isCustomerVisible: false, isIrreversible: false },
      },
      'gated',
      'no_read_back',
    ],
    [
      'a customer reply (DEC-12)',
      { action: { isWrite: true, isCustomerVisible: true, isIrreversible: false } },
      'gated',
      'customer_visible',
    ],
    [
      'an irreversible write (DEC-34)',
      { action: { isWrite: true, isCustomerVisible: false, isIrreversible: true } },
      'gated',
      'irreversible',
    ],
    ['a high-risk intent (DEC-03, DEC-13)', { riskTier: 'high' }, 'gated', 'high_risk'],
    ['agreement below its threshold (DEC-05)', { agreement: 0.1 }, 'escalate', 'agreement'],
    [
      'groundedness below the block threshold (DEC-07)',
      { groundedness: 0.1 },
      'escalate',
      'groundedness_block',
    ],
    [
      'groundedness inside the review band (DEC-07)',
      { groundedness: (SEED_THRESHOLDS.groundednessBlock + SEED_THRESHOLDS.groundednessReview) / 2 },
      'gated',
      'groundedness_review',
    ],
    ['every rule passing', {}, 'auto', 'auto'],
  ];

  it.each(cases)('names %s', (_label, overrides, decision, reason) => {
    const outcome = evaluatePolicyDetailed(baseInput(overrides));
    expect(outcome.decision).toBe(decision);
    expect(outcome.reason).toBe(reason);
  });

  // An independent statement of the rule, written from section 4.8 and the
  // decisions rather than from the engine. The case below compares the engine
  // against THIS across every combination of its inputs.
  //
  // A first version compared `evaluatePolicyDetailed(x).decision` against
  // `evaluatePolicy(x)`. Since `evaluatePolicy` delegates, that was `x === x`
  // across 288 iterations: it would have passed with every rule inverted. An
  // equivalence test needs two implementations, and the second one has to
  // come from the specification.
  function referenceOutcome(input: PolicyInput): { decision: string; reason: string } {
    const { action, capabilities, riskTier, agreement, groundedness, thresholds } = input;
    if (action.isWrite && !capabilities.supportsIdempotencyKey) {
      return { decision: 'gated', reason: 'no_idempotency' };     // DEC-06
    }
    if (action.isWrite && !capabilities.supportsReadBack) {
      return { decision: 'gated', reason: 'no_read_back' };       // DEC-06, DEC-30
    }
    if (action.isCustomerVisible) {
      return { decision: 'gated', reason: 'customer_visible' };   // DEC-12
    }
    if (action.isWrite && action.isIrreversible) {
      return { decision: 'gated', reason: 'irreversible' };       // DEC-34
    }
    if (riskTier === 'high') {
      return { decision: 'gated', reason: 'high_risk' };          // DEC-03, DEC-13
    }
    if (agreement < thresholds.agreement) {
      return { decision: 'escalate', reason: 'agreement' };       // DEC-05 gate 1
    }
    if (groundedness < thresholds.groundednessBlock) {
      return { decision: 'escalate', reason: 'groundedness_block' }; // DEC-07
    }
    if (groundedness < thresholds.groundednessReview) {
      return { decision: 'gated', reason: 'groundedness_review' };   // DEC-07
    }
    return { decision: 'auto', reason: 'auto' };
  }

  it('matches an independent statement of the rule on every combination', () => {
    const tiers = ['low', 'medium', 'high'] as const;
    const flags = [false, true];
    let checked = 0;
    for (const riskTier of tiers)
      for (const isWrite of flags)
        for (const isCustomerVisible of flags)
          for (const isIrreversible of flags)
            for (const supportsIdempotencyKey of flags)
              for (const supportsReadBack of flags)
                for (const agreement of [0.1, 0.9])
                  for (const groundedness of [0.1, 0.75, 0.95]) {
                    const input = baseInput({
                      riskTier,
                      agreement,
                      groundedness,
                      capabilities: {
                        ...FULL_CAPABILITIES,
                        supportsIdempotencyKey,
                        supportsReadBack,
                      },
                      action: { isWrite, isCustomerVisible, isIrreversible },
                    });
                    const outcome = evaluatePolicyDetailed(input);
                    expect(outcome).toEqual(referenceOutcome(input));
                    // The delegating wrapper still has to agree with its own
                    // detailed form, which is cheap to assert alongside.
                    expect(evaluatePolicy(input)).toBe(outcome.decision);
                    checked += 1;
                  }
    expect(checked).toBe(3 * 2 * 2 * 2 * 2 * 2 * 2 * 3);
  });

  // The four short-circuit reasons return before agreement is compared, so a
  // report on the agreement gate must exclude them. The predicate lives here
  // rather than in the reader, for the same reason the precedence does.
  // Every reason is placed, so a reason added later cannot default to
  // "reached" and silently inflate the rate.
  it('places every reason on one side of the agreement gate', () => {
    for (const reason of POLICY_REASONS) {
      expect(typeof reachedAgreementGate(reason), `${reason} is unplaced`).toBe('boolean');
      expect(typeof passedAgreementGate(reason), `${reason} is unplaced`).toBe('boolean');
    }
    expect(POLICY_REASONS.length).toBe(9);
  });

  it('says which reasons reached the agreement gate', () => {
    expect(reachedAgreementGate('no_idempotency')).toBe(false);
    expect(reachedAgreementGate('no_read_back')).toBe(false);
    expect(reachedAgreementGate('customer_visible')).toBe(false);
    expect(reachedAgreementGate('irreversible')).toBe(false);
    expect(reachedAgreementGate('high_risk')).toBe(false);
    expect(reachedAgreementGate('agreement')).toBe(true);
    expect(reachedAgreementGate('groundedness_block')).toBe(true);
    expect(reachedAgreementGate('groundedness_review')).toBe(true);
    expect(reachedAgreementGate('auto')).toBe(true);
  });

  // A reason that reached the gate and is not 'agreement' passed it. Stated
  // as a case because the report's numerator depends on it: counting only
  // 'auto' as a pass would drop every run that cleared agreement and then
  // failed on groundedness, and the rate would track the wrong gate (DEC-05).
  it('distinguishes passing the agreement gate from passing every gate', () => {
    expect(passedAgreementGate('auto')).toBe(true);
    expect(passedAgreementGate('groundedness_block')).toBe(true);
    expect(passedAgreementGate('groundedness_review')).toBe(true);
    expect(passedAgreementGate('agreement')).toBe(false);
  });
});

// Which runs were judged on coverage at all.
//
// `journalFinish` records `groundedness` on every gate row whether or not the
// engine compared it, so a reader holding the number cannot tell a coverage
// that decided from one that was only measured. The console printed it beside
// every rule, and on a seeded queue that told a person six runs in ten had
// failed groundedness when none of them had been judged on it.
describe('whether a run\'s coverage was read (DEC-05, section 4.8)', () => {
  it('says no for every rule that stops before the comparison', () => {
    for (const reason of [
      'no_idempotency', 'no_read_back', 'customer_visible', 'irreversible', 'high_risk',
    ] as const) {
      expect(readCoverageGate(reason), reason).toBe(false);
    }
  });

  // Agreement is compared first, and a run it stops never reaches coverage.
  // This is the one reason that reaches the first gate and not the second.
  it('says no for a run the agreement gate stopped', () => {
    expect(reachedAgreementGate('agreement')).toBe(true);
    expect(readCoverageGate('agreement')).toBe(false);
  });

  it('says yes only where a threshold decided', () => {
    for (const reason of ['groundedness_block', 'groundedness_review', 'auto'] as const) {
      expect(readCoverageGate(reason), reason).toBe(true);
    }
  });

  // The table against the engine, not against itself.
  //
  // The cases above enumerate the same nine constants the record declares, so
  // they hold whatever the record says. This varies the one input the record
  // is about and asks the engine: a reason that does not read coverage must
  // return the same verdict at every coverage, and one that reads it must
  // not. If the engine's order changed, the record, its tests and the console
  // would agree and all be wrong.
  it('agrees with what the engine actually does when coverage moves', () => {
    const base = {
      agreement: 0.99,
      thresholds: SEED_THRESHOLDS,
      capabilities: FULL_CAPABILITIES,
    };
    const cases: readonly { name: string; input: Omit<PolicyInput, 'groundedness'> }[] = [
      {
        name: 'customer_visible',
        input: {
          ...base, riskTier: 'low',
          action: { isWrite: true, isCustomerVisible: true, isIrreversible: false },
        },
      },
      {
        name: 'high_risk',
        input: {
          ...base, riskTier: 'high',
          action: { isWrite: true, isCustomerVisible: false, isIrreversible: false },
        },
      },
      {
        name: 'irreversible',
        input: {
          ...base, riskTier: 'low',
          action: { isWrite: true, isCustomerVisible: false, isIrreversible: true },
        },
      },
      {
        name: 'no_idempotency',
        input: {
          ...base, riskTier: 'low',
          capabilities: { ...base.capabilities, supportsIdempotencyKey: false },
          action: { isWrite: true, isCustomerVisible: false, isIrreversible: false },
        },
      },
      {
        name: 'auto',
        input: {
          ...base, riskTier: 'low',
          action: { isWrite: true, isCustomerVisible: false, isIrreversible: false },
        },
      },
    ];

    for (const { name, input } of cases) {
      const verdicts = [0, 0.5, 0.75, 1].map(
        (groundedness) => evaluatePolicyDetailed({ ...input, groundedness }).reason,
      );
      const first = verdicts[0]!;
      const invariant = verdicts.every((reason) => reason === first);
      // The engine is the authority. Whether the verdict moved with coverage
      // is the fact; the record has to match it.
      expect(readCoverageGate(first), `${name}: engine said ${first}`).toBe(!invariant);
    }
  });

  // Coverage is read last, so no reason can reach it without reaching
  // agreement first. A table that broke this would describe an order the
  // engine does not run in.
  it('never reads coverage on a run that did not reach agreement', () => {
    for (const reason of POLICY_REASONS) {
      if (readCoverageGate(reason)) expect(reachedAgreementGate(reason), reason).toBe(true);
    }
  });
});
