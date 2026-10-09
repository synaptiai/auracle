// The per-intent agreement fit (DEC-41).
//
// DEC-13 and DEC-41 divide on one boundary, and the register states it since
// the amendment: below the labelled-case trigger one global threshold binds;
// at or above it the system fits a threshold for each intent that has enough
// cases to fit one. DEC-13's second rule is untouched here — a person sets
// the risk tier and this module never learns one.
//
// Section 3.3 derives the trigger. One global threshold needs 385 labelled
// cases for an interval of 5 per cent, a threshold for each of 25 intents
// needs about 2 400, and Zipf-distributed intent frequencies put the intent
// at rank 20 near 7 700. The roadmap rounds that to 8 000, and that rounded
// figure is the trigger, because it is the number the register and the
// roadmap both quote.
//
// The shipped corpus has carried that shape since it was regenerated. Its
// intents follow a Zipf curve at exponent 1, so a half gives rank 1 about
// 1074 cases and rank 25 about 43. Four intents clear the sample floor at the
// shipped target and 21 fall back, so the fixture exercises both routes.
//
// What the fixture cannot show is what a real classifier reaches. The offline
// stand-in answers every sample of one ticket alike, so agreement is one
// value and a fitted threshold has one place to sit. Read a fitted count as a
// statement about the sample floor, never about accuracy.
//
// The data floor is not re-implemented here. `fitAgreementThreshold` already
// refuses a threshold whose 95 per cent lower bound cannot hold the target,
// and it names the sample count that would: a perfect sample of n reaches
// n / (n + 3.8415), so the floor needs 35 samples at a target of 0.9. That
// refusal is a Wilson bound and a raw count check beside it would be both
// weaker and a second rule to keep in step. An intent it refuses keeps the
// global threshold, and the artifact names it, so a reader sees which
// intents were not fitted rather than inferring it from silence.
//
// A first draft did carry that duplicate check. Removing it changed no test,
// which is how the duplication was found.
//
// This module changes one gate. DEC-05 keeps the two independent, and
// coverage is not read or written here.
import { fitAgreementThreshold } from './calibrate.js';
import { normalizeIntentId } from '../policy/policy.js';

/** Section 3.3's arithmetic, rounded as the roadmap rounds it. */
export const TRIGGER_MIN_LABELLED = 8_000;

export interface IntentSample {
  intent: string;
  /** Fraction of the K classifier samples that picked the modal intent. */
  agreement: number;
  /** Whether the modal intent equals the case's label. */
  correct: boolean;
}

export interface PerIntentFit {
  /** Labelled cases in the corpus, which is what the trigger counts. */
  labelled_cases: number;
  /** Cases the fit consumed. Half the corpus, because DEC-31 splits it. */
  fit_cases: number;
  /** The trigger in force, recorded so a reader need not know it. */
  trigger_min_labelled: number;
  /** Whether the per-intent path ran at all. */
  triggered: boolean;
  /** Intent to threshold. Empty below the trigger. */
  per_intent: Record<string, number>;
  /**
   * Intents that kept the global threshold, and why they could not be
   * fitted. Named rather than omitted: an absence is not a finding.
   */
  below_floor: string[];
}

/**
 * Fits one threshold for each intent that clears the floor.
 *
 * `labelledCases` is the corpus, not the sample count. The trigger counts
 * labelled cases, which is what DEC-41 names and what section 3.3 derives —
 * "a corpus of approximately 7 700 tickets". The samples are the fit half
 * alone, because DEC-31 restricts the fit to it, so counting them would put
 * the trigger permanently out of reach at half its own bar. A first version
 * did exactly that, and every test passed because each hand-built a sample
 * array the calibration job cannot produce.
 *
 * No global threshold is written into the map. An intent that falls back
 * carries no entry, so a reader of the artifact can tell a fitted threshold
 * from an inherited one — writing the global value in would erase exactly
 * that distinction, and the fallback lives in the policy engine.
 */
export function fitPerIntent(
  samples: readonly IntentSample[],
  options: { targetPrecision: number; labelledCases: number },
): PerIntentFit {
  const base: PerIntentFit = {
    labelled_cases: options.labelledCases,
    fit_cases: samples.length,
    trigger_min_labelled: TRIGGER_MIN_LABELLED,
    triggered: options.labelledCases >= TRIGGER_MIN_LABELLED,
    per_intent: {},
    below_floor: [],
  };
  if (!base.triggered) return base;

  // Keyed on the normalised id, because that is the only spelling the gate
  // can look up: the classifier returns a normalised id and never anything
  // else. A map keyed on the raw taxonomy id would miss every lookup as soon
  // as an adopter capitalised one, and the feature would silently do nothing.
  const byIntent = new Map<string, IntentSample[]>();
  for (const sample of samples) {
    const key = normalizeIntentId(sample.intent);
    const group = byIntent.get(key) ?? [];
    group.push(sample);
    byIntent.set(key, group);
  }

  // Sorted, so the artifact's map and its `below_floor` list read the same
  // way on every run.
  for (const intent of [...byIntent.keys()].sort()) {
    const group = byIntent.get(intent)!;
    try {
      const fit = fitAgreementThreshold(group, { targetPrecision: options.targetPrecision });
      // A threshold of zero passes every ticket, which is the gate switched
      // off. `assertFraction` refuses one for the global threshold and this
      // path must refuse one too. It can arise honestly: agreement is
      // allowed to be zero, so an intent whose cases all sit at zero and are
      // all correct fits a threshold of zero.
      if (!(fit.threshold > 0) || fit.threshold > 1) {
        base.below_floor.push(intent);
        continue;
      }
      base.per_intent[intent] = fit.threshold;
    } catch {
      // No candidate reached the precision floor for this intent. It keeps
      // the global threshold rather than shipping a weak one.
      base.below_floor.push(intent);
    }
  }
  return base;
}
