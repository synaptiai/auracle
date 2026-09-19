// The agreement gate reads a per-intent threshold where one was fitted
// (issue #26, DEC-41).
//
// DEC-13 binds below the labelled-case trigger and DEC-41 governs above it.
// The engine does not know which side of the trigger it is on, and it must
// not: the calibration job decides that and hands the engine a map, empty or
// not. An empty map is the DEC-13 path, expressed as data.
//
// DEC-13's second rule is untouched. A person sets the risk tier, and nothing
// here learns one — a high-risk intent still never reaches the automatic path
// whatever its threshold says.
import { describe, expect, it } from 'vitest';

import { SEED_THRESHOLDS, evaluatePolicyDetailed, makeThresholds } from './policy.js';
import type { PolicyInput } from './policy.js';

const CAPABLE: PolicyInput['capabilities'] = {
  supportsIdempotencyKey: true,
  supportsReadBack: true,
  supportsDraftState: true,
  supportsStructuredFields: true,
  supportsThreading: true,
  supportsLedgerReply: false,
};

// Typed, not cast. An `as PolicyInput` cast on this fixture hid a wrong
// shape — the action flags live under `action`, not at the top level — and
// every case failed on a TypeError rather than on its own assertion.
function input(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    riskTier: 'low',
    agreement: 0.75,
    groundedness: 0.95,
    thresholds: SEED_THRESHOLDS,
    capabilities: CAPABLE,
    action: { isWrite: false, isCustomerVisible: false, isIrreversible: false },
    ...overrides,
  };
}

describe('the agreement gate with a per-intent threshold', () => {
  it('applies the global threshold when the map holds no entry', () => {
    const strict = { ...SEED_THRESHOLDS, agreement: 0.8, perIntent: {} };
    expect(evaluatePolicyDetailed(input({ intent: 'refund-request', thresholds: strict })).reason)
      .toBe('agreement');
    const lenient = { ...SEED_THRESHOLDS, agreement: 0.7, perIntent: {} };
    expect(evaluatePolicyDetailed(input({ intent: 'refund-request', thresholds: lenient })).reason)
      .not.toBe('agreement');
  });

  // The entry governs, and it governs in both directions: a stricter entry
  // escalates a ticket the global value would have passed, and a more lenient
  // one passes a ticket the global value would have escalated.
  it('applies a stricter per-intent threshold over the global one', () => {
    const thresholds = {
      ...SEED_THRESHOLDS,
      agreement: 0.7,
      perIntent: { 'refund-request': 0.8 },
    };
    expect(evaluatePolicyDetailed(input({ intent: 'refund-request', thresholds })).reason)
      .toBe('agreement');
  });

  it('applies a more lenient per-intent threshold over the global one', () => {
    const thresholds = {
      ...SEED_THRESHOLDS,
      agreement: 0.8,
      perIntent: { 'refund-request': 0.7 },
    };
    expect(evaluatePolicyDetailed(input({ intent: 'refund-request', thresholds })).reason)
      .not.toBe('agreement');
  });

  // An intent the fit refused keeps the global threshold. That is the
  // fallback DEC-41 requires, and it must not read another intent's entry.
  it('leaves an intent with no entry on the global threshold', () => {
    const thresholds = {
      ...SEED_THRESHOLDS,
      agreement: 0.8,
      perIntent: { 'refund-request': 0.7 },
    };
    expect(evaluatePolicyDetailed(input({ intent: 'chargeback-notice', thresholds })).reason)
      .toBe('agreement');
  });

  // A run with no intent cannot read a per-intent entry, and must not pick
  // an arbitrary one.
  it('applies the global threshold when the run names no intent', () => {
    const thresholds = {
      ...SEED_THRESHOLDS,
      agreement: 0.8,
      perIntent: { 'refund-request': 0.7 },
    };
    expect(evaluatePolicyDetailed(input({ thresholds })).reason).toBe('agreement');
  });

  // DEC-13's surviving rule. A per-intent threshold is about the gate, never
  // about the tier.
  it('never lets a per-intent threshold reach a high-risk intent', () => {
    const thresholds = {
      ...SEED_THRESHOLDS,
      agreement: 0.9,
      perIntent: { 'refund-request': 0.01 },
    };
    const verdict = evaluatePolicyDetailed(
      input({ riskTier: 'high', intent: 'refund-request', agreement: 1, thresholds }),
    );
    expect(verdict.decision).toBe('gated');
    expect(verdict.reason).toBe('high_risk');
  });

  // DEC-05. The map belongs to one gate and cannot reach the other.
  it('leaves the coverage gate untouched', () => {
    const thresholds = {
      ...SEED_THRESHOLDS,
      agreement: 0.1,
      perIntent: { 'refund-request': 0.1 },
    };
    const verdict = evaluatePolicyDetailed(
      input({ intent: 'refund-request', groundedness: 0.1, thresholds }),
    );
    expect(verdict.reason).toBe('groundedness_block');
  });
});

// The wiring, which is what the cases above could not see.
//
// Every case above constructs `thresholds.perIntent` and `input.intent` by
// hand, so all seven passed while no caller supplied either. The feature was
// a consumer with no producer: the calibration job never wrote the map, the
// resolver never read it, and all three policy call sites omitted the intent.
// Reverting that wiring was a no-op on the suite, because it had never been
// written.
//
// These cases walk the path instead of assuming it.
describe('the per-intent threshold as it actually reaches the gate', () => {
  it('survives makeThresholds, which rebuilds the record field by field', () => {
    const built = makeThresholds({
      agreement: 0.8,
      groundednessBlock: 0.7,
      groundednessReview: 0.8,
      perIntent: { 'refund-request': 0.7 },
    });
    // The first version of this change spread the map in at the call site and
    // it was dropped here in silence, leaving a wired feature that could
    // never fire.
    expect(built.perIntent).toEqual({ 'refund-request': 0.7 });
    expect(
      evaluatePolicyDetailed(input({ intent: 'refund-request', thresholds: built })).reason,
    ).not.toBe('agreement');
  });

  it('refuses a per-intent threshold that is not a fraction', () => {
    for (const bad of [0, -0.5, 1.5, Number.NaN]) {
      expect(() =>
        makeThresholds({
          agreement: 0.8,
          groundednessBlock: 0.7,
          groundednessReview: 0.8,
          perIntent: { 'refund-request': bad },
        }),
      ).toThrow(/perIntent\.refund-request/);
    }
  });

  // `constructor`, `toString` and `__proto__` are legal lower-case slugs an
  // adopter could put in a taxonomy. A bare property read resolves them off
  // Object.prototype, the gate compares agreement against a function, the
  // comparison coerces to NaN and reads false — and the gate then passes
  // every ticket for that intent.
  it('does not resolve an intent name off the prototype chain', () => {
    const built = makeThresholds({
      agreement: 0.9,
      groundednessBlock: 0.7,
      groundednessReview: 0.8,
      perIntent: { 'refund-request': 0.7 },
    });
    for (const slug of ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty']) {
      const verdict = evaluatePolicyDetailed(
        input({ intent: slug, agreement: 0.75, thresholds: built }),
      );
      // 0.75 is below the global 0.9, so the only correct answer is escalate.
      expect(verdict.reason, slug).toBe('agreement');
    }
  });
});

// The vocabulary the map is keyed on, which is the one the gate can look up.
//
// The classifier builds its valid set from normalised taxonomy ids and counts
// nothing outside it, so `classification.intentId` is always normalised. A
// map keyed on the raw taxonomy id agrees with that only while every id is
// already lower case — which is true of the shipped corpus and would stop
// being true for an adopter who capitalised one. The feature would then be
// present, wired, and silently inert: exactly the defect the first review
// found, one layer down.
describe('the intent vocabulary on both sides of the map', () => {
  it('matches a capitalised taxonomy id against a normalised lookup', () => {
    const built = makeThresholds({
      agreement: 0.9,
      groundednessBlock: 0.7,
      groundednessReview: 0.8,
      // As an adopter's taxonomy might spell it.
      perIntent: { 'Refund-Request': 0.5 },
    });
    // As the classifier always spells it.
    const verdict = evaluatePolicyDetailed(
      input({ intent: 'refund-request', agreement: 0.75, thresholds: built }),
    );
    // 0.75 clears the fitted 0.5 and would fail the global 0.9, so the only
    // way this passes is the map being read.
    expect(verdict.reason).not.toBe('agreement');
  });

  // The read side, which the two cases above cannot reach: `freezeIntentMap`
  // normalises on write, so a map built through `makeThresholds` is already
  // lower case and a raw lookup would find it anyway. What the read guard
  // buys is a caller that hands the gate an id the classifier would never
  // produce — a hand-built `PolicyInput`, or a future caller reading an
  // intent from somewhere other than the classifier.
  it('normalises the lookup too, not only the key', () => {
    const built = makeThresholds({
      agreement: 0.9,
      groundednessBlock: 0.7,
      groundednessReview: 0.8,
      perIntent: { 'refund-request': 0.5 },
    });
    const verdict = evaluatePolicyDetailed(
      input({ intent: 'Refund-Request', agreement: 0.75, thresholds: built }),
    );
    expect(verdict.reason).not.toBe('agreement');
  });

  it('matches a padded id, which is the other half of the same rule', () => {
    const built = makeThresholds({
      agreement: 0.9,
      groundednessBlock: 0.7,
      groundednessReview: 0.8,
      perIntent: { '  refund-request  ': 0.5 },
    });
    expect(
      evaluatePolicyDetailed(input({ intent: 'refund-request', agreement: 0.75, thresholds: built }))
        .reason,
    ).not.toBe('agreement');
  });
});
