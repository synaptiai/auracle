// Fitting the two coverage thresholds (section 4.7, section 4.10, DEC-05).
//
// The gates are independent, so this file never reads an agreement value.
// The two thresholds answer different questions and are fitted by different
// rules: `review` decides the automatic path, so a draft above it must be
// truly grounded at a precision floor; `block` decides not to show a person
// at all, so a draft below it must be truly ungrounded at its own floor.
import { describe, expect, it } from 'vitest';

import { fitCoverageThresholds } from './fit.js';
import type { CoverageSample } from './fit.js';

/** A draft with every claim supported by the judge and truly grounded. */
function clean(n: number): CoverageSample[] {
  return Array.from({ length: n }, () => ({ coverage: 1, grounded: true, grade: null }));
}

/** A draft the judge scored low and which truly carries an unsupported claim. */
function bad(n: number, coverage: number, grade = 'off_topic'): CoverageSample[] {
  return Array.from({ length: n }, () => ({ coverage, grounded: false, grade }));
}

/**
 * A judge that mostly separates and sometimes does not.
 *
 * A perfect judge is not the case this gate exists for, and fitting on one
 * collapses the two thresholds onto a single value: no draft is ambiguous, so
 * no draft would reach a person. These sets keep some ungrounded drafts high,
 * which is what makes a review band exist at all.
 */
function realistic(): CoverageSample[] {
  return [
    ...clean(40),
    ...bad(20, 0.4),
    ...bad(10, 0.6),
    // Ten the judge scored well despite an unsupported claim. These are what
    // the review band is for.
    ...bad(10, 0.9),
  ];
}

describe('fitCoverageThresholds (DEC-05, section 4.7)', () => {
  it('fits review as the lowest coverage holding the precision floor', () => {
    const fit = fitCoverageThresholds(realistic(), {
      targetPrecision: 0.985,
      targetNpv: 0.9,
    });

    // Only 1.0 is pure: ten ungrounded drafts sit at 0.9.
    expect(fit.review.threshold).toBe(1);
    expect(fit.review.precision).toBe(1);
  });

  it('takes the lowest block holding its floor, so a review band survives', () => {
    // Everything under block is escalated without a person seeing it. Taking
    // the highest qualifying value would push block onto review and leave
    // nobody to review anything.
    const fit = fitCoverageThresholds(realistic(), {
      targetPrecision: 0.985,
      targetNpv: 0.9,
    });

    expect(fit.block.npv).toBeGreaterThanOrEqual(0.9);
    expect(fit.block.threshold).toBeLessThan(fit.review.threshold);
    // The band is not empty: the 0.9 drafts fall inside it.
    expect(fit.block.threshold).toBeLessThanOrEqual(0.9);
  });

  it('rejects a block whose band holds a grounded draft', () => {
    // The floor is the whole reason block is fitted by a different rule from
    // review, and deleting it used to leave every case green.
    // One grounded draft sits at the very bottom, at 0.05. A block at 0.1
    // would escalate it and nothing else, so the floor must reject that
    // candidate; the next one up holds because ten ungrounded drafts join the
    // band. Without the floor, block would take 0.1 and escalate a good draft.
    const shared = [
      { coverage: 0.05, grounded: true, grade: null },
      ...Array.from({ length: 10 }, () => ({ coverage: 0.1, grounded: false, grade: 'absent' })),
      ...bad(5, 0.9),
      ...clean(30),
    ];

    const fit = fitCoverageThresholds(shared, { targetPrecision: 0.985, targetNpv: 0.9 });

    expect(fit.block.threshold).toBe(0.9);
    expect(fit.block.blocked).toBe(11);
    expect(fit.block.npv).toBeGreaterThanOrEqual(0.9);
    expect(fit.block.threshold).toBeLessThan(fit.review.threshold);
  });

  it('refuses when no band can hold the floor', () => {
    // Every candidate's band mixes the classes, so nothing can be escalated
    // without escalating a grounded draft.
    const mixed = [
      ...Array.from({ length: 10 }, () => ({ coverage: 0.3, grounded: true, grade: null })),
      ...Array.from({ length: 10 }, () => ({ coverage: 0.3, grounded: false, grade: 'absent' })),
      ...clean(20),
    ];

    expect(() => fitCoverageThresholds(mixed, { targetPrecision: 0.985, targetNpv: 0.9 })).toThrow(
      /negative predictive value/,
    );
  });

  it('refuses a fit that leaves no band for a person', () => {
    // A judge that separates perfectly gives both searches the same answer.
    // That is not noise; it means no draft was ambiguous, and section 4.7
    // needs three outcomes.
    expect(() =>
      fitCoverageThresholds([...clean(20), ...bad(20, 0.5)], {
        targetPrecision: 0.985,
        targetNpv: 0.9,
      }),
    ).toThrow(/no draft would reach a person/);
  });

  it('refuses a fit whose block exceeds its review', () => {
    // Two independent searches over one score do not guarantee the order, and
    // an inverted pair leaves no review band at all.
    expect(() =>
      fitCoverageThresholds([...clean(5), ...bad(5, 0.99)], {
        targetPrecision: 0.5,
        targetNpv: 0.99,
      }),
    ).toThrow(/block .* exceeds review|cannot order/);
  });

  it('refuses to fit when the two classes do not separate', () => {
    // Every draft scores 0.8 whether or not it is grounded. A threshold here
    // measures nothing, and emitting one would replace an honest caveat with
    // a number carrying more authority than its evidence.
    const overlapping: CoverageSample[] = [
      ...Array.from({ length: 20 }, () => ({ coverage: 0.8, grounded: true, grade: null })),
      ...Array.from({ length: 20 }, () => ({ coverage: 0.8, grounded: false, grade: 'absent' })),
    ];

    expect(() => fitCoverageThresholds(overlapping, { targetPrecision: 0.985, targetNpv: 0.9 })).toThrow(
      /does not separate/,
    );
  });

  it('names the overlap it measured when it refuses', () => {
    const overlapping: CoverageSample[] = [
      ...Array.from({ length: 20 }, () => ({ coverage: 0.8, grounded: true, grade: null })),
      ...Array.from({ length: 20 }, () => ({ coverage: 0.8, grounded: false, grade: 'absent' })),
    ];

    expect(() => fitCoverageThresholds(overlapping, { targetPrecision: 0.985, targetNpv: 0.9 })).toThrow(
      /0\.8/,
    );
  });

  it('reports measured coverage for each grade of negative', () => {
    // A fit that holds only on the easy grade is a fit that measured nothing
    // about the hard one. The per-grade figures make that visible.
    const fit = fitCoverageThresholds(
      [...clean(30), ...bad(10, 0.1, 'off_topic'), ...bad(10, 0.5, 'absent'), ...bad(10, 0.8, 'unstated_detail')],
      { targetPrecision: 0.985, targetNpv: 0.9 },
    );

    // Grades in a stable order, with their own counts. The mean is compared
    // with a tolerance: summing ten 0.1 values gives 0.09999999999999999, and
    // an exact match here would pin a floating-point artefact rather than the
    // behaviour. The job reports the raw mean, as the other artifacts do.
    expect(fit.byGrade.map((g) => [g.grade, g.drafts])).toEqual([
      ['absent', 10],
      ['off_topic', 10],
      ['unstated_detail', 10],
    ]);
    expect(fit.byGrade.map((g) => g.meanCoverage)).toEqual([
      expect.closeTo(0.5, 10),
      expect.closeTo(0.1, 10),
      expect.closeTo(0.8, 10),
    ]);
  });

  it('refuses a sample set with no grounded draft', () => {
    expect(() =>
      fitCoverageThresholds(bad(10, 0.2), { targetPrecision: 0.985, targetNpv: 0.9 }),
    ).toThrow(/both classes/);
  });

  it('refuses a sample set with no ungrounded draft', () => {
    expect(() =>
      fitCoverageThresholds(clean(10), { targetPrecision: 0.985, targetNpv: 0.9 }),
    ).toThrow(/both classes/);
  });

  it('reads no agreement value, so the gates stay independent (DEC-05)', () => {
    // The sample shape cannot carry one. A blended fit is unrepresentable.
    const sample: CoverageSample = { coverage: 1, grounded: true, grade: null };

    expect(Object.keys(sample).sort()).toEqual(['coverage', 'grade', 'grounded']);
  });
});
