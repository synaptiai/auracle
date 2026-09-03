/**
 * Read-only control-band queries (bands.yaml, docs/v1-architecture.md
 * sections 4.10 and 5).
 *
 * `bands.yaml` defines four metrics, a 30-day window and a daily sample, and
 * for as long as it stood nothing read it. Its own header said the baselines
 * "stay null until a full window of daily samples exists", and no daily
 * sample was ever taken, so they never could. The runbook told an operator in
 * Phase 2 to watch four bands and gave them no tool that computed one.
 *
 * A day is a UTC calendar day keyed on `run.created_at`. Neither
 * `step_journal` nor `outbox` carries a timestamp, so both reach a day by
 * joining through the run. `src/latency` keys its window on the same column,
 * so the two reports agree about what a day is.
 *
 * Every statement is a SELECT. The module never writes, so it is safe to run
 * against a live database without approval. It reads timestamps, counts and
 * two journal keys, and no customer text (DEC-18).
 */
import type { Pool } from 'pg';

import { POLICY_REASONS, passedAgreementGate, reachedAgreementGate } from '../policy/policy.js';
import type { DailySample } from './evaluate.js';
import type { MetricName } from './metrics.js';

/** Reasons whose run reached the agreement comparison, derived from the engine. */
const REACHED: readonly string[] = POLICY_REASONS.filter(reachedAgreementGate);
/** Reasons that stop a run before that comparison. */
const SHORT_CIRCUIT: readonly string[] = POLICY_REASONS.filter((r) => !reachedAgreementGate(r));
/** Reasons whose run reached that comparison and cleared it. */
const PASSED: readonly string[] = POLICY_REASONS.filter(passedAgreementGate);

/** One day of every metric, as the ledger answers for it. */
export interface DayRow {
  day: string;
  /** Runs the day held, across every metric. */
  runs: number;
  samples: Record<MetricName, DailySample>;
}

/**
 * One statement, four metrics.
 *
 * Four separate queries would each re-scan the same window of runs, and two
 * of them could disagree about which runs a day held if a run were written
 * between them. One pass over one window cannot.
 */
const SELECT_BY_DAY = `
  WITH day_run AS (
    SELECT run_id,
           to_char((created_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day,
           state,
           approval_edit_distance
      FROM run
     WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
  ),
  -- The compose step's own outcome. A run that stopped earlier has no row
  -- here, and is counted as not reached rather than as a run that did not
  -- abstain: it never had the chance to.
  composed AS (
    SELECT run_id,
           -- Guarded rather than cast bare. One journal row whose value is
           -- not castable would fail the whole statement and produce no
           -- report at all; this degrades that row to not reached instead.
           CASE WHEN jsonb_typeof(result->'abstained') = 'boolean'
                THEN (result->>'abstained')::boolean END AS abstained
      FROM step_journal
      -- Restricted to the window's runs. Without this the CTE scanned every
      -- journal row an adopter has ever written, however narrow the window,
      -- which is the cost that made "safe against a live database" true of
      -- writes and false of load.
     WHERE step_id = 'compose' AND result ? 'abstained'
       AND run_id IN (SELECT run_id FROM day_run)
  ),
  -- The gate step's reason, from a gate that produced a verdict.
  --
  -- The status test matters. The coordinator files a failed gate with a
  -- non-null result carrying a shape and an error and no reason, when the
  -- groundedness judge answers unreadably. Admitting those on a non-null
  -- result alone counted a live fault as unrecorded, so that count never
  -- drained and the runbook's advice to wait for the ledger to turn over was
  -- wrong. Such a run stopped before the policy engine ran, so it did not
  -- reach the agreement comparison. The compose CTE above excludes the
  -- identical failure shape by testing for its key; this tests the status,
  -- because a gate has no single key that a failed row must lack.
  gated AS (
    SELECT run_id, result->>'reason' AS reason
      FROM step_journal
     WHERE step_id = 'gate' AND status = 'done' AND result IS NOT NULL
       AND run_id IN (SELECT run_id FROM day_run)
  ),
  -- DEC-30 makes delivery_unknown terminal: the relay reads only pending, so
  -- a row never returns from it by itself. One row per run, because a run
  -- with two stuck records is still one run in trouble.
  unknown AS (
    SELECT DISTINCT run_id FROM outbox
     WHERE status = 'delivery_unknown'
       AND run_id IN (SELECT run_id FROM day_run)
  ),
  -- A record the relay has not resolved yet could still become
  -- delivery_unknown, so the day's count is not final while one exists.
  undelivered AS (
    SELECT DISTINCT run_id FROM outbox
     WHERE status = 'pending'
       AND run_id IN (SELECT run_id FROM day_run)
  )
  SELECT d.day,
         -- DISTINCT, so the count defends itself. Every joined CTE is one row
         -- per run today — two by a primary key, two by their own DISTINCT —
         -- but nothing here enforces that. A migration that relaxed the key
         -- would inflate this count, deflate every rate, and pass the gate
         -- cross-check below, because the gate counts would inflate with it.
         count(DISTINCT d.run_id)                                       AS runs,
         count(c.abstained)                                             AS abstain_count,
         count(*) FILTER (WHERE c.abstained)                            AS abstained,
         count(*) FILTER (WHERE g.reason = ANY($3::text[]))             AS gate_count,
         count(*) FILTER (WHERE g.reason = ANY($4::text[]))             AS gate_passed,
         -- A reason the engine still knows, on the short-circuit side.
         count(*) FILTER (WHERE g.reason = ANY($5::text[]))             AS gate_short_circuit,
         -- A reason the engine no longer knows: a row written under a name
         -- since renamed. It belongs with unrecorded rather than with the
         -- ordinary traffic that did not reach the gate, because the remedy
         -- differs — one is normal, the other is a ledger the reader cannot
         -- interpret.
         count(*) FILTER (WHERE g.reason IS NOT NULL
                            AND g.reason <> ALL($3::text[])
                            AND g.reason <> ALL($5::text[]))            AS gate_obsolete,
         -- Counted by the database rather than derived here. Subtracting it
         -- from the day made the artifact's partition check an identity: it
         -- compared a number against the sum it was built from, so a gap
         -- between the predicates was absorbed silently and reported as
         -- ordinary traffic.
         count(*) FILTER (WHERE g.run_id IS NULL)                       AS gate_never,
         count(*) FILTER (WHERE g.run_id IS NOT NULL
                            AND g.reason IS NULL)                       AS gate_unrecorded,
         count(d.approval_edit_distance)                                AS edit_count,
         avg(d.approval_edit_distance)                                  AS edit_mean,
         count(*) FILTER (WHERE u.run_id IS NOT NULL)                   AS delivery_unknown,
         -- How much of this day is still to land. Both counts overlap the
         -- exclusions above rather than partitioning with them.
         count(*) FILTER (WHERE d.state = 'awaiting_approval')          AS awaiting_approval,
         count(*) FILTER (WHERE p.run_id IS NOT NULL)                   AS undelivered
    FROM day_run d
    LEFT JOIN composed c ON c.run_id = d.run_id
    LEFT JOIN gated    g ON g.run_id = d.run_id
    LEFT JOIN unknown  u ON u.run_id = d.run_id
    LEFT JOIN undelivered p ON p.run_id = d.run_id
   GROUP BY d.day
   ORDER BY d.day`;

/**
 * A count column, which Postgres returns as a string for bigint.
 *
 * The column names itself in the fault. Left unvalidated, an unparsable value
 * became NaN here and surfaced far away as an artifact validation failure
 * naming a JSON field rather than the column that produced it.
 */
function toCount(value: unknown, column: string): number {
  const parsed = Number(value ?? 0);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`bands: column ${column} is not a count: ${String(value)}`);
  }
  return parsed;
}

/** A rate, or null when nothing was measured. Never defaulted to zero. */
function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/**
 * Every day holding a run, from `from` inclusive to `to` exclusive.
 *
 * A day with no runs produces no row. That is the honest answer: such a day
 * has no sample, and inventing a zero for it would let a quiet weekend pull
 * a baseline down and manufacture an excursion on Monday.
 */
export async function readDays(pool: Pool, from: Date, to: Date): Promise<DayRow[]> {
  const { rows } = await pool.query(SELECT_BY_DAY, [
    from.toISOString(),
    to.toISOString(),
    REACHED,
    PASSED,
    SHORT_CIRCUIT,
  ]);

  return rows.map((row: Record<string, unknown>) => {
    const day = String(row['day']);
    const runs = toCount(row['runs'], 'runs');

    const abstainCount = toCount(row['abstain_count'], 'abstain_count');
    const gateCount = toCount(row['gate_count'], 'gate_count');
    const gateUnrecorded = toCount(row['gate_unrecorded'], 'gate_unrecorded');
    const gateShortCircuit = toCount(row['gate_short_circuit'], 'gate_short_circuit');
    const gateObsolete = toCount(row['gate_obsolete'], 'gate_obsolete');
    const editCount = toCount(row['edit_count'], 'edit_count');
    const editMean = row['edit_mean'];

    // The gate's four buckets, every one counted by the database.
    //
    // Each is an independent FILTER over the same rows, so their sum is a
    // second opinion on the day's run count rather than a restatement of it.
    // Derived by subtraction the check could not fail, and a gap between the
    // predicates disappeared into the remainder unnoticed.
    const neverGated = toCount(row['gate_never'], 'gate_never');
    const accounted =
      gateCount + gateUnrecorded + gateShortCircuit + gateObsolete + neverGated;
    if (accounted !== runs) {
      throw new Error(
        `bands: day ${day} accounts for ${accounted} runs across the gate buckets, `
          + `but the day held ${runs}; the gate predicates overlap or leave a gap`,
      );
    }

    return {
      day,
      runs,
      samples: {
        abstain_rate: {
          day,
          value: rate(toCount(row['abstained'], 'abstained'), abstainCount),
          count: abstainCount,
          notReached: runs - abstainCount,
          unrecorded: 0,
          pending: 0,
        },
        gate_pass_rate: {
          day,
          value: rate(toCount(row['gate_passed'], 'gate_passed'), gateCount),
          count: gateCount,
          // Runs stopped before the comparison, plus runs that never gated.
          notReached: gateShortCircuit + neverGated,
          // A reason the engine no longer knows joins the runs the journal
          // cannot answer for, not the ordinary traffic below the gate.
          unrecorded: gateUnrecorded + gateObsolete,
          pending: 0,
        },
        approval_edit_distance: {
          day,
          value: editMean === null || editMean === undefined ? null : Number(editMean),
          count: editCount,
          notReached: runs - editCount,
          unrecorded: 0,
          pending: toCount(row['awaiting_approval'], 'awaiting_approval'),
        },
        relay_delivery_unknown_count: {
          day,
          // A count, not a rate. Zero is a real answer here, and the only
          // good one: the runbook says any nonzero count needs eyes.
          value: runs === 0 ? null : toCount(row['delivery_unknown'], 'delivery_unknown'),
          count: runs,
          notReached: 0,
          unrecorded: 0,
          pending: toCount(row['undelivered'], 'undelivered'),
        },
      },
    };
  });
}
