// Pure threshold fitting for the calibration job (section 4.11, DEC-13, DEC-31).
//
// DEC-13: the system has ONE global agreement threshold. This module fits
// exactly that one number. It never produces per-intent thresholds.
//
// DEC-31: fitting consumes only samples from the fit half of the gold set.
// This module stays pure — it takes per-ticket samples and knows nothing
// about where they came from. The runner (run.ts) owns the fit-half-only
// discipline so the report half can never leak into a fit.
//
// Gate independence (DEC-05): these samples carry agreement only. No
// groundedness value enters the fit, and no blended score exists.

export interface AgreementSample {
  /** Fraction of the K classifier samples that picked the modal intent (section 4.5). */
  agreement: number;
  /** Whether the modal intent equals the gold intent for the ticket. */
  correct: boolean;
}

export interface FitInterval {
  confidence: number;
  lower: number;
  upper: number;
}

export interface ThresholdFit {
  /** The single global threshold (DEC-13). A ticket passes when agreement >= threshold. */
  threshold: number;
  /** Fraction of passed tickets classified correctly at the threshold. */
  precision: number;
  /** Fraction of all fit-half tickets that pass the threshold. */
  coverage: number;
  passed: number;
  total: number;
  interval: FitInterval;
}

/** Wilson interval level. Section 4.10 prices intervals near 95 percent. */
export const INTERVAL_CONFIDENCE = 0.95;

const Z_95 = 1.959963984540054;

/**
 * Fit the global agreement threshold on labeled samples.
 *
 * Selection rule: among candidate thresholds (the distinct observed agreement
 * values), take the lowest threshold whose precision reaches targetPrecision —
 * that is the maximum-coverage threshold that honors the precision floor.
 * Iterating candidates in ascending order and keeping strictly better coverage
 * makes that tie-break deterministic.
 *
 * Throws when no candidate reaches the floor: an unfittable gate must fail
 * loudly, not silently ship a weak threshold.
 */
export function fitAgreementThreshold(
  samples: readonly AgreementSample[],
  options: { targetPrecision: number },
): ThresholdFit {
  if (samples.length === 0) {
    throw new Error('calibration needs at least one agreement sample');
  }
  const { targetPrecision } = options;
  if (!(targetPrecision > 0 && targetPrecision <= 1)) {
    throw new Error(
      `targetPrecision must be in (0, 1], got ${targetPrecision}`,
    );
  }
  for (const [i, sample] of samples.entries()) {
    assertSample(sample, i);
  }

  const candidates = [...new Set(samples.map((s) => s.agreement))].sort(
    (a, b) => a - b,
  );

  let best: ThresholdFit | null = null;
  for (const threshold of candidates) {
    let passed = 0;
    let correctPassed = 0;
    for (const sample of samples) {
      if (sample.agreement >= threshold) {
        passed++;
        if (sample.correct) correctPassed++;
      }
    }
    const precision = correctPassed / passed;
    // The floor is a hard constraint, not part of an objective to blend.
    if (precision < targetPrecision) continue;
    const coverage = passed / samples.length;
    if (best === null || coverage > best.coverage) {
      best = {
        threshold,
        precision,
        coverage,
        passed,
        total: samples.length,
        interval: wilsonInterval(correctPassed, passed),
      };
    }
  }

  if (best === null) {
    throw new Error(
      `no agreement threshold reaches precision ${targetPrecision} on ${samples.length} fit samples; ` +
        'refusing to emit a weaker gate (DEC-13)',
    );
  }
  return best;
}

/**
 * Wilson score interval for a binomial proportion. Used over the normal
 * approximation because fit strata are small (section 4.10 warns the strata
 * stay too small to publish at 385 cases).
 */
export function wilsonInterval(successes: number, n: number): FitInterval {
  if (!(n > 0)) {
    throw new Error('Wilson interval needs at least one observation');
  }
  const z2 = Z_95 * Z_95;
  // Exact proportions keep exact bounds: floating-point drift must not push
  // an endpoint below a perfect precision of 1 (or above 0).
  if (successes === n) {
    return { confidence: INTERVAL_CONFIDENCE, lower: Math.max(0, (1 / (1 + z2 / n))), upper: 1 };
  }
  if (successes === 0) {
    return { confidence: INTERVAL_CONFIDENCE, lower: 0, upper: Math.min(1, (z2 / n) / (1 + z2 / n)) };
  }
  const p = successes / n;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half =
    (Z_95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return {
    confidence: INTERVAL_CONFIDENCE,
    lower: Math.max(0, center - half),
    upper: Math.min(1, center + half),
  };
}

function assertSample(sample: AgreementSample, index: number): void {
  if (typeof sample.agreement !== 'number' || !(sample.agreement >= 0 && sample.agreement <= 1)) {
    throw new Error(`sample ${index} has agreement outside [0, 1]`);
  }
  if (typeof sample.correct !== 'boolean') {
    throw new Error(`sample ${index} has no boolean correct flag`);
  }
}
