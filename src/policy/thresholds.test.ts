// The gate numbers are data, not constants compiled into the engine. These
// cases pin the shape and the refusals; the resolver that loads them from a
// calibration artifact is tested in src/calibration/resolve.test.ts.
import { describe, expect, it } from 'vitest';

import { CLASSIFIER_K } from '../classifier/classifier.js';
import { SEED_THRESHOLDS, makeThresholds } from './policy.js';

describe('gate thresholds as data (DEC-05, DEC-13)', () => {
  it('carries the section 4.5 and 4.7 seeds', () => {
    // The seeds are the documented values. A drift here changes every gate
    // on a fresh checkout, so they are pinned literally rather than relatively.
    expect(SEED_THRESHOLDS).toEqual({
      agreement: 0.6,
      groundednessBlock: 0.7,
      groundednessReview: 0.8,
    });
  });

  it('accepts a set whose block equals its review', () => {
    // Degenerate but ordered: everything below blocks, everything above is
    // automatic, and no band sends anything to a person.
    const thresholds = makeThresholds({
      agreement: 0.5,
      groundednessBlock: 0.75,
      groundednessReview: 0.75,
    });
    expect(thresholds.groundednessBlock).toBe(0.75);
  });

  it('refuses a set whose block exceeds its review', () => {
    // An inverted pair makes the review band empty and the block band cover
    // values the register says a person should see. A fit can invert them, so
    // the refusal is an assertion and not a comment.
    expect(() =>
      makeThresholds({
        agreement: 0.6,
        groundednessBlock: 0.85,
        groundednessReview: 0.8,
      }),
    ).toThrow(/block 0\.85 exceeds review 0\.8/);
  });

  it.each([
    ['agreement', { agreement: 1.1, groundednessBlock: 0.7, groundednessReview: 0.8 }],
    ['groundednessBlock', { agreement: 0.6, groundednessBlock: -0.1, groundednessReview: 0.8 }],
    ['groundednessReview', { agreement: 0.6, groundednessBlock: 0.7, groundednessReview: 2 }],
  ])('refuses %s outside [0, 1]', (field, values) => {
    expect(() => makeThresholds(values)).toThrow(new RegExp(field));
  });

  it('refuses a value that is not a number', () => {
    expect(() =>
      makeThresholds({
        agreement: Number.NaN,
        groundednessBlock: 0.7,
        groundednessReview: 0.8,
      }),
    ).toThrow(/agreement/);
  });

  it('names no intent, so one global threshold governs every ticket (DEC-13)', () => {
    // DEC-13's rejected alternative is a threshold the system learns per
    // intent. The shape cannot express one.
    expect(Object.keys(SEED_THRESHOLDS).sort()).toEqual([
      'agreement',
      'groundednessBlock',
      'groundednessReview',
    ]);
  });
});

describe('a threshold of zero is not a gate (DEC-05)', () => {
  it.each(['agreement', 'groundednessBlock', 'groundednessReview'] as const)(
    'refuses %s at zero, which passes every ticket',
    (field) => {
      expect(() =>
        makeThresholds({ ...SEED_THRESHOLDS, [field]: 0 }),
      ).toThrow(new RegExp(`${field}.*\\(0, 1\\]`));
    },
  );

  it('accepts the lowest threshold the fitter can produce', () => {
    // The rule refuses zero, so it must not refuse a real fit. Agreement is
    // modalCount / CLASSIFIER_K and the modal count is at least one, so the
    // lowest value the classifier can report is 1/9. fitAgreementThreshold
    // chooses among observed values only, so its floor is the same.
    const floor = 1 / CLASSIFIER_K;

    expect(floor).toBeGreaterThan(0);
    expect(makeThresholds({ ...SEED_THRESHOLDS, agreement: floor }).agreement).toBe(floor);
  });

  it('freezes the set it returns, and the seeds', () => {
    // The record is shared by reference into every PolicyInput a process
    // builds, so one mutation would move the gate for all of them.
    // `readonly` is a compile-time claim that does not survive to runtime.
    expect(Object.isFrozen(SEED_THRESHOLDS)).toBe(true);
    expect(Object.isFrozen(makeThresholds({ ...SEED_THRESHOLDS }))).toBe(true);
  });
});
