/**
 * Band evaluation (bands.yaml, docs/operations.md "Control bands").
 *
 * A pure function. It reads no state, calls no model and touches no ledger,
 * so every rule below is decided by its arguments alone.
 *
 * The three actions come from bands.yaml: at one sigma log, at two diagnose
 * read-only, at three propose a change through a pull request. A day inside
 * one sigma crosses no line at all, so it is reported as in band.
 */
import type { MetricDefinition } from './metrics.js';
import { WINDOW_DAYS } from './metrics.js';

/** One day's value for one metric, with the population behind it. */
export interface DailySample {
  /** UTC calendar day, `YYYY-MM-DD`. Days order by this string. */
  day: string;
  /** The value, or null when the day measured nothing. Never defaulted to zero. */
  value: number | null;
  /** Runs the value was computed over. */
  count: number;
  /** Runs that never reached the step this metric measures. */
  notReached: number;
  /**
   * Runs whose journal cannot say whether they reached it.
   *
   * Its own name, not folded into `notReached`, because the two send an
   * operator to different places. A run that did not reach the step is
   * ordinary traffic. A run the journal cannot answer for is a run recorded
   * before the field existed, and the remedy is to wait for the ledger to
   * turn over. Only the gate metric can carry one today.
   */
  unrecorded: number;
  /**
   * Runs whose contribution to this metric may still arrive.
   *
   * Not part of the partition above. It overlaps the partition without adding
   * to it, and which part it overlaps differs by metric: a run nobody has
   * approved yet sits in `notReached`, while an undelivered run sits inside
   * `count`, because the delivery metric counts every run of the day. It answers a
   * different question: how much of this day is still to land.
   *
   * Two metrics settle late. The approval-edit distance is written when a
   * person approves a draft, and the delivery count when the relay gives up.
   * Both are filed under the day the run was picked up, because neither table
   * records when the later event happened. So a recent day is provisional,
   * and this count says by how much.
   */
  pending: number;
}

/** The action bands.yaml names for the line a day crossed. */
export type BandAction = 'in_band' | 'log' | 'diagnose' | 'propose_change';

export interface BandVerdict {
  /**
   * Distance from the baseline mean, in sigmas, signed.
   *
   * Signed rather than absolute, because the side is half the answer: the
   * same distance means a different thing above and below the mean.
   */
  sigmaDistance: number;
  action: BandAction;
  /**
   * Whether the excursion runs toward the direction bands.yaml calls bad.
   *
   * An excursion in the good direction is still reported. AGENTS.md states
   * the reason: "At zero, agreement is always 1.0 and the gate passes every
   * ticket." A gate pass rate far above its mean is the signature of that
   * defect, so a band that flagged only the bad direction would report the
   * classifier temperature bug as a healthy system.
   */
  towardBad: boolean;
}

export interface Baseline {
  mean: number;
  /** Population sigma: the window is the whole population, not a sample of one. */
  sigma: number;
  /** Days that carried a value. Always the full window when a baseline exists. */
  days: number;
}

/**
 * Why no band was emitted, as a value rather than a sentence.
 *
 * The delivery count is the case that forces this. Its healthy state is zero
 * every day, so its window never carries a spread and it can never earn a
 * sigma. The day it jumps is exactly the day DEC-30 exists for, and that
 * excursion reached a reader only as English prose. A code lets a consumer
 * act on `moved_from_flat` without parsing a sentence.
 */
export type ShortfallCode =
  | 'day_unmeasured'
  | 'day_not_a_number'
  | 'thin_window'
  | 'steady'
  | 'moved_from_flat';

export interface MetricEvaluation {
  metric: MetricDefinition['name'];
  direction: MetricDefinition['direction'];
  value: number | null;
  count: number;
  notReached: number;
  unrecorded: number;
  pending: number;
  baseline: Baseline | null;
  /** Null when no band could be evaluated; `shortfall` then says why. */
  band: BandVerdict | null;
  /** Null when a band was evaluated. Names what was missing otherwise. */
  shortfall: string | null;
  /** The same answer as a value, for a reader that is not a person. */
  shortfallCode: ShortfallCode | null;
}

/**
 * The most recent measured days before `day`, at most a window of them.
 *
 * Days with no value are dropped before the cut, not after it. Cutting first
 * demanded that every one of the last 30 calendar days carried a value, so a
 * single quiet day inside them left 29 and no band could form for the next 30
 * reports. Dropping first lets the job reach past a gap, which is why it
 * reads more calendar days than a window holds.
 *
 * A dropped day is never treated as a zero. A quiet day is an absence of
 * evidence, and averaging over it would invent the most flattering number
 * about the day the ledger knows least about.
 */
function trailingWindow(day: string, prior: readonly DailySample[]): MeasuredSample[] {
  return prior
    // `Number.isFinite`, not a null check. A non-finite sample survived the
    // null filter, made the mean and the sigma NaN, and `NaN <= frozen` is
    // false — so the frozen branch was skipped and the ladder fell through to
    // its last arm. One poisoned row in the window produced propose_change
    // from an unknown value, which is the fail-severe defect the guard on
    // today's value exists to close. A dropped day becomes a thin window,
    // which is the honest answer.
    .filter((sample): sample is MeasuredSample =>
      sample.day < day && Number.isFinite(sample.value))
    .slice()
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
    .slice(-WINDOW_DAYS);
}

type MeasuredSample = DailySample & { value: number };

/**
 * Evaluate one metric for one day against the days before it.
 *
 * The baseline never contains the day under test. A point inside its own
 * baseline drags the mean toward itself, so a genuinely bad day reads less
 * bad the worse it gets — which is the opposite of what a control band is for.
 */
export function evaluateMetric(
  definition: MetricDefinition,
  today: DailySample,
  prior: readonly DailySample[],
): MetricEvaluation {
  const base: Omit<MetricEvaluation, 'baseline' | 'band' | 'shortfall' | 'shortfallCode'> = {
    metric: definition.name,
    direction: definition.direction,
    value: today.value,
    count: today.count,
    notReached: today.notReached,
    unrecorded: today.unrecorded,
    pending: today.pending,
  };

  // A day with no value is not a day at zero. Checked first, because a band
  // needs a point and this day has none whatever the history holds.
  if (today.value === null) {
    return {
      ...base, baseline: null, band: null,
      shortfall: 'the day measured nothing', shortfallCode: 'day_unmeasured',
    };
  }
  // A value that is not a number is not a large one. Left to fall through,
  // every comparison below was false and the ladder ended at its last arm —
  // so a NaN reported `propose_change`, whose consequence is a pull request.
  // Unknown must never default to the severest answer.
  if (!Number.isFinite(today.value)) {
    return {
      ...base,
      // Reported as no value, and the runs behind it moved to `unrecorded`.
      //
      // Carrying the NaN forward made the artifact validator refuse the whole
      // file, so one poisoned column cost the day's entire report and this
      // code could never appear in a written artifact at all. Zeroing the
      // count alone would have traded that for a different refusal, because
      // the three counts must still account for the day's runs. The runs are
      // not unmeasured — the ledger holds something for them that no
      // arithmetic can use, which is what `unrecorded` means.
      value: null,
      count: 0,
      unrecorded: today.unrecorded + today.count,
      baseline: null,
      band: null,
      shortfall: 'the day measured a value that is not a number',
      shortfallCode: 'day_not_a_number',
    };
  }

  const measured = trailingWindow(today.day, prior);
  if (measured.length < WINDOW_DAYS) {
    return {
      ...base,
      baseline: null,
      band: null,
      shortfall: `no baseline: ${measured.length} of ${WINDOW_DAYS} days`,
      shortfallCode: 'thin_window',
    };
  }

  const mean = measured.reduce((sum, s) => sum + s.value, 0) / measured.length;
  const variance =
    measured.reduce((sum, s) => sum + (s.value - mean) ** 2, 0) / measured.length;
  const sigma = Math.sqrt(variance);
  const baseline: Baseline = { mean, sigma, days: measured.length };

  // A sigma of zero makes every distance infinite. Reported as a shortfall
  // rather than as a pass: a metric frozen at one value for a whole window is
  // a fault to look at, not a system in control.
  //
  // Compared against a floor, never against zero. Thirty identical values do
  // not sum to an exact mean, so the residuals are float noise rather than
  // zero and the sigma comes out near 1e-17. Testing `sigma === 0` therefore
  // missed the frozen metric entirely and divided by that noise, which put a
  // steady system three sigmas out and asked an operator for a pull request.
  // The floor scales with the mean, because these four metrics range from a
  // rate inside [0, 1] to an unbounded count.
  const frozen = Math.max(Math.abs(mean), 1) * Number.EPSILON * 8;
  if (sigma <= frozen) {
    // No spread means no sigma scale, so no band either way. But the two
    // reasons a window can be flat send an operator to different places, so
    // they get different words.
    //
    // A metric steady at its own value is often health rather than fault:
    // `relay_delivery_unknown_count` sits at zero every day a system works,
    // and the runbook's rule for it is "any nonzero count needs eyes" rather
    // than a sigma. Reporting that as a fault every day would train an
    // operator to ignore the line.
    //
    // A metric that never moved for a whole window and moved today is the
    // opposite: the step is real, and no sigma exists to measure it against.
    const moved = Math.abs(today.value - mean) > frozen;
    return {
      ...base,
      baseline,
      band: null,
      shortfall: moved
        ? `no spread over ${WINDOW_DAYS} days, and today moved to ${today.value}`
        : `steady at ${today.value} over ${WINDOW_DAYS} days`,
      shortfallCode: moved ? 'moved_from_flat' : 'steady',
    };
  }

  const sigmaDistance = (today.value - mean) / sigma;
  const magnitude = Math.abs(sigmaDistance);
  const action: BandAction =
    magnitude < 1 ? 'in_band' : magnitude < 2 ? 'log' : magnitude < 3 ? 'diagnose' : 'propose_change';
  const towardBad =
    definition.direction === 'high_is_bad' ? sigmaDistance > 0 : sigmaDistance < 0;

  return {
    ...base, baseline,
    band: { sigmaDistance, action, towardBad },
    shortfall: null, shortfallCode: null,
  };
}
