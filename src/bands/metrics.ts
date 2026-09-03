/**
 * The control-band definitions (bands.yaml, docs/operations.md).
 *
 * Restated here rather than parsed. `bands.yaml` is the only YAML this
 * application would read, no parser is in the dependency tree, and no value
 * is ever read from that file: its baselines are null and stay null, because
 * a baseline is an adopter's production number and the file is tracked
 * (DEC-18). Only the definitions are needed, and those are
 * static.
 *
 * `bands.test.ts` pins these against the file, so a changed window fails the
 * build rather than silently changing a control band under an operator. This
 * is the pattern `src/latency/query.ts` uses for the ledger's terminal states.
 */

/** The four metrics bands.yaml defines, in the order it defines them. */
export type MetricName =
  | 'abstain_rate'
  | 'gate_pass_rate'
  | 'approval_edit_distance'
  | 'relay_delivery_unknown_count';

/** Which way is bad, as bands.yaml states it. */
export type Direction = 'high_is_bad' | 'low_is_bad';

export interface MetricDefinition {
  name: MetricName;
  direction: Direction;
}

/** The daily samples a baseline is built from. */
export const WINDOW_DAYS = 30;

/**
 * Calendar days the job reads to find those samples.
 *
 * Wider than the window, because a day with no runs produces no sample and a
 * day where nothing reached a step produces no value for it. Reading exactly
 * 30 calendar days demanded that all 30 carried a value, so one quiet day —
 * a weekend, an outage, a day whose every run was a customer reply — left 29
 * and suppressed the band for the next 30 reports. The approval-edit
 * distance, which section 4.10 calls the most useful early signal, would have
 * needed an approval on 30 consecutive days and would rarely have banded at
 * all.
 *
 * `bands.yaml` says `window_days: 30` beside `sample_interval: daily`, so the
 * baseline is 30 daily samples. This is how far back the job looks to find
 * them. A metric too sparse to yield 30 inside this reach still reports the
 * shortfall rather than a baseline built from less.
 */
export const LOOKBACK_DAYS = 60;

export const METRICS: readonly MetricDefinition[] = [
  { name: 'abstain_rate', direction: 'high_is_bad' },
  { name: 'gate_pass_rate', direction: 'low_is_bad' },
  { name: 'approval_edit_distance', direction: 'high_is_bad' },
  { name: 'relay_delivery_unknown_count', direction: 'high_is_bad' },
];
