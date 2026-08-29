// Fitting the two coverage thresholds (section 4.7, section 4.10, DEC-05).
//
// The gates are independent. Nothing here reads an agreement value, and the
// sample shape cannot carry one, so a blended score is unrepresentable.
//
// The two numbers answer different questions and are fitted by different
// rules. Above `review` a draft takes the automatic path, so what matters is
// that such a draft is truly grounded: a precision floor, the same rule the
// agreement job uses. Below `block` the engine escalates instead of showing
// a person, so what matters is that such a draft really is ungrounded: a
// negative predictive value floor. Applying one rule twice would fit `block`
// against a question it does not ask.
//
// The job refuses more readily than it emits. A threshold fitted on classes
// that do not separate is a number any candidate would satisfy, and shipping
// one would replace an honest caveat with false authority.

import { wilsonInterval } from '../calibration/calibrate.js';
import type { FitInterval } from '../calibration/calibrate.js';

/** One scored draft: what the judge measured, and what was true. */
export interface CoverageSample {
  /** Supported claims over total claims, as the gate measures it. */
  readonly coverage: number;
  /** True when every claim in the draft is really supported. */
  readonly grounded: boolean;
  /** Difficulty of the unsupported claim, or null on a grounded draft. */
  readonly grade: string | null;
}

export interface ReviewFit {
  threshold: number;
  /** Fraction of drafts at or above the threshold that are truly grounded. */
  precision: number;
  /** Fraction of all drafts at or above the threshold. */
  coverage: number;
  passed: number;
  total: number;
  interval: FitInterval;
}

export interface BlockFit {
  threshold: number;
  /** Fraction of drafts below the threshold that are truly ungrounded. */
  npv: number;
  /** Fraction of all drafts below the threshold. */
  share: number;
  blocked: number;
  total: number;
  interval: FitInterval;
}

/** Measured coverage per difficulty grade, so a fit that holds only on the easy one is visible. */
export interface GradeSummary {
  grade: string;
  drafts: number;
  meanCoverage: number;
}

export interface CoverageFit {
  review: ReviewFit;
  block: BlockFit;
  byGrade: GradeSummary[];
}

export interface CoverageFitOptions {
  /** Floor on P(grounded | coverage >= review). */
  targetPrecision: number;
  /** Floor on P(not grounded | coverage < block). */
  targetNpv: number;
}

export function fitCoverageThresholds(
  samples: readonly CoverageSample[],
  options: CoverageFitOptions,
): CoverageFit {
  assertOptions(options);
  for (const [i, sample] of samples.entries()) assertSample(sample, i);

  const grounded = samples.filter((s) => s.grounded).length;
  if (grounded === 0 || grounded === samples.length) {
    throw new Error(
      'coverage fitting needs both classes: at least one grounded draft and one ungrounded draft',
    );
  }

  const candidates = [...new Set(samples.map((s) => s.coverage))].sort((a, b) => a - b);

  const review = fitReview(samples, candidates, options.targetPrecision);
  if (review === null) {
    throw new Error(
      `measured coverage does not separate a grounded draft from an ungrounded one: `
        + `${describeOverlap(samples)}. No threshold reaches precision ${options.targetPrecision}, `
        + 'so any value would pass and the fit would measure nothing',
    );
  }

  const block = fitBlock(samples, candidates, options.targetNpv);
  if (block === null) {
    throw new Error(
      `no coverage threshold reaches a negative predictive value of ${options.targetNpv}; `
        + 'nothing can be escalated without escalating a grounded draft',
    );
  }

  // Section 4.7 defines two thresholds and three outcomes: escalate, send to
  // a person, run automatically. A pair that does not separate collapses the
  // middle one, so nothing ever reaches a person, and the fit is not an
  // instance of the design it claims to fit.
  //
  // Equal is refused as firmly as inverted, and it is the far commoner
  // failure: both searches take the lowest qualifying candidate, so data that
  // separates cleanly drives them to the same value. That is not noise. It
  // means no draft in the sample was ambiguous, and a gate fitted on such a
  // sample would have no band to put a person in.
  if (block.threshold === review.threshold) {
    throw new Error(
      `fitted block and review are both ${review.threshold}, so no draft would reach a person; `
        + 'the sample holds no draft the judge scored ambiguously, and section 4.7 needs '
        + 'three outcomes. Widen the corpus or keep the seeds',
    );
  }
  if (block.threshold > review.threshold) {
    throw new Error(
      `fitted block ${block.threshold} exceeds review ${review.threshold}; `
        + 'the two are searched independently, so nothing in the fit orders them, '
        + 'and an inverted pair leaves no review band',
    );
  }

  return { review, block, byGrade: summariseGrades(samples) };
}

/**
 * The lowest threshold whose precision reaches the floor.
 *
 * Lowest, because that is the one that lets the most drafts through while
 * honouring the floor. Ascending order with a strictly-better test makes the
 * tie-break deterministic, matching fitAgreementThreshold.
 */
function fitReview(
  samples: readonly CoverageSample[],
  candidates: readonly number[],
  targetPrecision: number,
): ReviewFit | null {
  let best: ReviewFit | null = null;
  for (const threshold of candidates) {
    const passed = samples.filter((s) => s.coverage >= threshold);
    if (passed.length === 0) continue;
    const correct = passed.filter((s) => s.grounded).length;
    const precision = correct / passed.length;
    if (precision < targetPrecision) continue;
    const coverage = passed.length / samples.length;
    if (best === null || coverage > best.coverage) {
      best = {
        threshold,
        precision,
        coverage,
        passed: passed.length,
        total: samples.length,
        interval: wilsonInterval(correct, passed.length),
      };
    }
  }
  return best;
}

/**
 * The lowest threshold whose negative predictive value reaches the floor.
 *
 * Lowest, not highest. A draft under block is escalated by this gate, so it
 * never reaches a person as a draft to approve. A person still handles the
 * escalation. The thresholds decide the automatic path only, so a customer
 * reply reaches a person whatever its coverage (DEC-12); the review band is
 * what puts an INTERNAL draft in front of one, and maximising the blocked
 * band leaves fewer of those. Taking the highest also drove block onto review
 * whenever every ungrounded draft sat below review, and an equal pair leaves
 * no review band at all.
 *
 * The floor keeps a grounded draft out of the escalated band. A candidate
 * with nothing below it is skipped: an empty band has no value to measure,
 * and reading it as perfect would fit a block that blocks nothing while
 * claiming a perfect score.
 */
function fitBlock(
  samples: readonly CoverageSample[],
  candidates: readonly number[],
  targetNpv: number,
): BlockFit | null {
  let best: BlockFit | null = null;
  for (const threshold of candidates) {
    const below = samples.filter((s) => s.coverage < threshold);
    if (below.length === 0) continue;
    const ungrounded = below.filter((s) => !s.grounded).length;
    const npv = ungrounded / below.length;
    if (npv < targetNpv) continue;
    if (best === null || threshold < best.threshold) {
      best = {
        threshold,
        npv,
        share: below.length / samples.length,
        blocked: below.length,
        total: samples.length,
        interval: wilsonInterval(ungrounded, below.length),
      };
    }
  }
  return best;
}

/** Names the coverage values that both classes share, so a refusal is diagnosable. */
function describeOverlap(samples: readonly CoverageSample[]): string {
  const groundedAt = new Set(samples.filter((s) => s.grounded).map((s) => s.coverage));
  const ungroundedAt = new Set(samples.filter((s) => !s.grounded).map((s) => s.coverage));
  const shared = [...groundedAt].filter((c) => ungroundedAt.has(c)).sort((a, b) => a - b);
  if (shared.length === 0) {
    return 'the two classes share no coverage value, yet no threshold holds the floor';
  }
  return `both classes appear at coverage ${shared.join(', ')}`;
}

function summariseGrades(samples: readonly CoverageSample[]): GradeSummary[] {
  const byGrade = new Map<string, number[]>();
  for (const sample of samples) {
    if (sample.grade === null) continue;
    byGrade.set(sample.grade, [...(byGrade.get(sample.grade) ?? []), sample.coverage]);
  }
  return [...byGrade.entries()]
    .map(([grade, values]) => ({
      grade,
      drafts: values.length,
      meanCoverage: values.reduce((a, b) => a + b, 0) / values.length,
    }))
    .sort((a, b) => a.grade.localeCompare(b.grade));
}

function assertOptions(options: CoverageFitOptions): void {
  for (const field of ['targetPrecision', 'targetNpv'] as const) {
    const value = options[field];
    if (!(typeof value === 'number' && value > 0 && value <= 1)) {
      throw new Error(`${field} must be in (0, 1], got ${String(value)}`);
    }
  }
}

function assertSample(sample: CoverageSample, index: number): void {
  if (typeof sample.coverage !== 'number' || !(sample.coverage >= 0 && sample.coverage <= 1)) {
    throw new Error(`sample ${index} has coverage outside [0, 1]`);
  }
  if (typeof sample.grounded !== 'boolean') {
    throw new Error(`sample ${index} has no boolean grounded flag`);
  }
  if (sample.grounded && sample.grade !== null) {
    throw new Error(`sample ${index} is grounded and names a difficulty grade`);
  }
  if (!sample.grounded && typeof sample.grade !== 'string') {
    throw new Error(`sample ${index} is ungrounded and names no difficulty grade`);
  }
}
