/**
 * Read-only latency queries (docs/v1-architecture.md section 6, V2 open item 7).
 *
 * `db/005_run_timing.sql` added three columns and stated the two quantities
 * they exist for. It said why: "Choosing a correction needs production
 * latency data from Phase 2. These columns make that data collectible from
 * the ledger alone." Four call sites wrote them and nothing read them, so
 * section 7 item 7 said "Nothing reads them yet" for as long as it stood.
 *
 * What this answers: section 6 concedes that partitions trade concurrent runs
 * on one ticket for head-of-line delay, and predicts it "will appear as
 * latency on busy partitions". An operator could not see that. This makes a
 * partition that is falling behind visible beside the ones that are not.
 *
 * Every statement is a SELECT, and the read runs in one READ ONLY transaction
 * through `boundedRead`. The module never writes, and the database refuses a
 * write if one is ever added, so it is safe to run against a live database
 * without approval (DEC-17, DEC-19).
 */
import type { Pool } from 'pg';

import { boundedRead } from '../db/bounded-read.js';

/**
 * The bound on the report's statement, in milliseconds: the bound the bands
 * job sets. The statement reads the whole ledger or a window of it, and an
 * offline report may take longer than a page may.
 */
export const LATENCY_TIMEOUT_MS = 60_000;

/**
 * States a run never leaves. Exported, and pinned against the ledger's own
 * list by a case in `latency.test.ts`.
 *
 * The service population keys on this rather than on a null finish time, so a
 * run that finished before `db/005` added the column reports as unstamped
 * rather than as forever unfinished. A state added to the ledger and missed
 * here would report those runs as permanently stalled, which is the failure
 * this reader exists to reveal — hence the case, rather than a comment.
 *
 * Restated rather than imported: this module must not name the ledger's
 * insert module, because the guard that proves the job issues no write scans
 * this file for the word, and a module path would read as one.
 */
export const TERMINAL_STATE_LIST: readonly string[] = [
  'abandoned',
  // DEC-48: a reviewer closed the case with no reply. The run is finished,
  // and its service time is real: the wait to close it was work on the case.
  'closed',
  'escalated',
  'resolved',
  'superseded',
];

/**
 * One duration distribution.
 *
 * Percentiles rather than an average, because head-of-line delay is a tail
 * phenomenon and an average is exactly where it hides: a partition whose
 * every hundredth ticket waits an hour has an unremarkable mean.
 */
export interface Distribution {
  /** Runs this distribution was computed over. The support behind the figures. */
  count: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
}

/** Queue wait, and the runs it could not be computed for. */
export interface WaitDistribution extends Distribution {
  /**
   * Runs with no arrival time, which therefore have no wait.
   *
   * Counted, never defaulted to zero. A run reaches this state when it had no
   * intake row, or when it predates the migration that added the column.
   * Reporting it as a wait of zero would invent the most flattering possible
   * number about the runs the ledger knows least about.
   */
  unmeasured: number;
  /**
   * Runs whose pickup precedes their arrival, so the wait comes out negative.
   *
   * The two timestamps are written by different processes. A clock that
   * disagrees, or a step from time synchronisation, reverses the pair. The
   * duration is then not small, it is not a duration at all.
   *
   * Counted under its own name rather than folded into `unmeasured`, because
   * the two send an operator to different places: `unmeasured` is a run with
   * no intake row, and this is hosts that disagree about the time.
   */
  unordered: number;
}

/** Service time, and the runs it could not be computed for. */
export interface ServiceDistribution extends Distribution {
  /**
   * Runs that have not reached a terminal state, which have no service time
   * yet. Counted separately so a reader can tell an idle partition from a
   * stalled one: both show few finished runs, and only one of them is fine.
   *
   * Keyed on the run's state, not on a null finish time. Keying it on the
   * timestamp counted every run that predates `db/005` as unfinished forever,
   * so an upgraded ledger reported every partition as permanently stalled —
   * and this count is the discriminator the runbook sends an operator to.
   */
  unfinished: number;
  /**
   * Terminal runs carrying no finish time, which is what `db/005` leaves
   * behind: "Existing rows keep null enqueued_at/finished_at". They are
   * finished, and their duration is unrecoverable. The count decays to zero
   * as an upgraded ledger turns over, and a reader can watch it do so.
   */
  unstamped: number;
  /** Terminal runs whose finish precedes their creation. See `unordered` above. */
  unordered: number;
  /**
   * Runs that reached a terminal state without ever executing.
   *
   * `abandonMessage` (src/coordinator/consumer.ts) files one when a message
   * exhausts the retry ceiling. It inserts the run already terminal, so its
   * creation and its finish are one transaction timestamp and its service
   * time is exactly zero. Such a run did not take no time; it never entered
   * service at all.
   *
   * The distinction is not academic. That path fires precisely when a
   * partition is failing, so counting the zeros would let a broken partition
   * manufacture the figures that make it look fastest.
   */
  neverRan: number;
  /**
   * Runs that were ever snoozed (DEC-48), so their duration is a wait and
   * never work.
   *
   * Read from the mark rather than the state: a run that was put aside, came
   * back and was answered is finished, and its service time would otherwise
   * be the hours it spent waiting for the customer. Its own name, so the wait
   * is visible rather than silently dropped.
   */
  snoozed: number;
  /**
   * Runs a reviewer rejected with a send-back (DEC-49), so their duration is
   * a person's reading time and never work.
   *
   * Read from `sent_back_at` rather than from the state, as the snooze class
   * is: a rejected attempt is terminal and stamped, so the state test above
   * would measure it and the number an operator reads as how long the system
   * takes would be how long a reviewer took to disagree.
   */
  rejected: number;
}

export interface PartitionLatency {
  partition: number;
  /**
   * Runs this partition carried in the window.
   *
   * Not the same number as `wait.count` or `service.count`, which each count
   * the runs one distribution could measure. A reader that showed either
   * beside the partition would report a partition that ran 240 runs as having
   * run the 200 whose arrival time was stamped.
   */
  runs: number;
  wait: WaitDistribution;
  service: ServiceDistribution;
}

export interface LatencyReport {
  /** Runs the window covered, across every partition. */
  runs: number;
  /** One row per partition that holds a run, lowest partition first. */
  partitions: PartitionLatency[];
}

export interface LatencyWindow {
  /** Only runs picked up at or after this instant. Absent means every run. */
  since?: Date;
}

/**
 * The aggregation runs in the database, not here.
 *
 * A ledger holds one row per run and an adopter's is large. Pulling every
 * timestamp to the client to sort it is the failure this design has to avoid,
 * and it is the shape a first draft naturally takes.
 *
 * `percentile_disc`, not `percentile_cont`. Interpolation is the monitoring
 * convention because a histogram has already discarded the observations. This
 * reads a ledger that still holds every one, so each figure below is a
 * duration some run actually took. An interpolated p99 is a number nobody
 * experienced, which is the wrong thing to hand an operator asking how bad it
 * got.
 *
 * Milliseconds throughout, because the ledger's other durations are
 * milliseconds and a report that mixed units would be misread once.
 */
const SELECT_BY_PARTITION = `
  SELECT partition,
         count(*)                                                  AS runs,
         count(wait_ms)                                            AS wait_count,
         count(*) FILTER (WHERE wait_state = 'unmeasured')          AS wait_unmeasured,
         count(*) FILTER (WHERE wait_state = 'unordered')           AS wait_unordered,
         percentile_disc(0.50) WITHIN GROUP (ORDER BY wait_ms)      AS wait_p50,
         percentile_disc(0.95) WITHIN GROUP (ORDER BY wait_ms)      AS wait_p95,
         percentile_disc(0.99) WITHIN GROUP (ORDER BY wait_ms)      AS wait_p99,
         max(wait_ms)                                              AS wait_max,
         count(service_ms)                                         AS service_count,
         count(*) FILTER (WHERE service_state = 'unfinished')       AS service_unfinished,
         count(*) FILTER (WHERE service_state = 'unstamped')        AS service_unstamped,
         count(*) FILTER (WHERE service_state = 'unordered')        AS service_unordered,
         count(*) FILTER (WHERE service_state = 'never_ran')        AS service_never_ran,
         count(*) FILTER (WHERE service_state = 'snoozed')          AS service_snoozed,
         count(*) FILTER (WHERE service_state = 'rejected')         AS service_rejected,
         percentile_disc(0.50) WITHIN GROUP (ORDER BY service_ms)   AS service_p50,
         percentile_disc(0.95) WITHIN GROUP (ORDER BY service_ms)   AS service_p95,
         percentile_disc(0.99) WITHIN GROUP (ORDER BY service_ms)   AS service_p99,
         max(service_ms)                                           AS service_max
    FROM (
      -- The duration is derived from the label, so the two cannot disagree.
      -- Written as two independent expressions they agreed only because
      -- the state and prompt_ver columns are NOT NULL in db/001: a nullable one
      -- would have made one say measured while the other returned null, and
      -- the artifact's totals would then fail to add up on real data.
      SELECT partition,
             wait_state,
             service_state,
             CASE WHEN wait_state = 'measured'
                  THEN EXTRACT(EPOCH FROM (created_at - enqueued_at)) * 1000 END AS wait_ms,
             CASE WHEN service_state = 'measured'
                  THEN EXTRACT(EPOCH FROM (finished_at - created_at)) * 1000 END AS service_ms
        FROM (
          SELECT partition, created_at, enqueued_at, finished_at,
                 -- db/005: queue wait = created_at - enqueued_at. Each arm
                 -- names one cause, so the runbook lists one remedy per count.
                 CASE WHEN enqueued_at IS NULL      THEN 'unmeasured'
                      WHEN created_at < enqueued_at THEN 'unordered'
                      ELSE 'measured' END                          AS wait_state,
                 -- db/005: service time = finished_at - created_at. Keyed on
                 -- the run's state: keying on a null finish reported every run
                 -- older than the migration as unfinished forever.
                 -- DEC-48: a run that was ever snoozed is not work the
                 -- system did. Its duration would be the wait itself, so it
                 -- is kept out of the distribution and counted under its own
                 -- name. Read first, because a snoozed run is not terminal
                 -- either: the state test below would label it unfinished.
                 -- DEC-49: read before the snooze, because a case that was
                 -- put aside and then sent back ended because a person
                 -- rejected it. Both columns stay on the row, and one class
                 -- has to win; the rejection is what ended the attempt.
                 CASE WHEN sent_back_at IS NOT NULL THEN 'rejected'
                      WHEN snoozed_until IS NOT NULL THEN 'snoozed'
                      WHEN state <> ALL($2::text[])  THEN 'unfinished'
                      -- Both columns, because abandonMessage writes both and
                      -- a deployment is free to set PROMPT_VER. Matching on
                      -- one alone let PROMPT_VER=intake label every real run
                      -- as never_ran, emptying the service distribution and
                      -- spiking the count the runbook reads as a partition
                      -- that is failing. The consumer also refuses the value.
                      WHEN prompt_ver = 'intake'
                       AND model_ver = 'intake'      THEN 'never_ran'
                      WHEN finished_at IS NULL       THEN 'unstamped'
                      WHEN finished_at < created_at  THEN 'unordered'
                      ELSE 'measured' END                          AS service_state
            FROM run
           WHERE ($1::timestamptz IS NULL OR created_at >= $1::timestamptz)
        ) AS labelled
    ) AS timed
   GROUP BY partition
   ORDER BY partition`;

/** A count column, which Postgres returns as a string for bigint. */
function toCount(value: unknown): number {
  return Number(value ?? 0);
}

/** A duration column, which is null when nothing in the group was measured. */
function toMs(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return Math.round(Number(value));
}

/**
 * Queue wait and service time per partition, over the whole ledger or a window.
 *
 * Read-only, in the database as well as in its source. Safe against a live
 * database.
 */
export async function readLatency(
  pool: Pool,
  window: LatencyWindow = {},
  timeoutMs: number = LATENCY_TIMEOUT_MS,
  clientTimeoutMs: number = timeoutMs + 1_000,
): Promise<LatencyReport> {
  const rows = await boundedRead(pool, 'readLatency', timeoutMs, clientTimeoutMs, (query) =>
    query<Record<string, unknown>>(SELECT_BY_PARTITION, [window.since ?? null, TERMINAL_STATE_LIST]));

  const partitions: PartitionLatency[] = rows.map((row) => ({
    partition: Number(row['partition']),
    runs: toCount(row['runs']),
    wait: {
      count: toCount(row['wait_count']),
      unmeasured: toCount(row['wait_unmeasured']),
      unordered: toCount(row['wait_unordered']),
      p50Ms: toMs(row['wait_p50']),
      p95Ms: toMs(row['wait_p95']),
      p99Ms: toMs(row['wait_p99']),
      maxMs: toMs(row['wait_max']),
    },
    service: {
      count: toCount(row['service_count']),
      unfinished: toCount(row['service_unfinished']),
      unstamped: toCount(row['service_unstamped']),
      unordered: toCount(row['service_unordered']),
      neverRan: toCount(row['service_never_ran']),
      snoozed: toCount(row['service_snoozed']),
      rejected: toCount(row['service_rejected']),
      p50Ms: toMs(row['service_p50']),
      p95Ms: toMs(row['service_p95']),
      p99Ms: toMs(row['service_p99']),
      maxMs: toMs(row['service_max']),
    },
  }));

  // The database already counted the rows per partition. Reading its own
  // count keeps one source for the total, rather than a second sum here that
  // has to be kept in step with every exclusion the query learns to make.
  return {
    runs: rows.reduce((n: number, row: Record<string, unknown>) => n + toCount(row['runs']), 0),
    partitions,
  };
}
