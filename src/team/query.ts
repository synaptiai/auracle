// What the team screen shows: how little reached a person, and how long a
// case held one (issue #112).
//
// Every figure comes from the ledger. The team's time on support is the hold
// history DEC-46 records: each take, handover, release, send and lapse, with
// its reviewer and time. A case is a turn, judged by its final attempt, as
// `pnpm run bands` counts one (DEC-49).
//
// The share of cases that reached a person is a live figure over the ledger's
// own day. It is not the published containment figure, which comes from the
// gold report; the screen names it beside its counts for that reason.
import type { Pool } from 'pg';

import { boundedRead, type BoundedQuery } from '../db/bounded-read.js';

/** How long the screen's read may run. */
export const TEAM_TIMEOUT_MS = 2_000;

/** The span the people and product rows cover, before `now`. */
export const TEAM_WEEK_DAYS = 7;

const DAY_MS = 86_400_000;

/**
 * How a case ended, by its final attempt (maintainer, 2026-09-26).
 *
 * - `auto`: resolved with no approver, no park and no earlier attempt.
 * - `person`: parked for approval, approved, closed, snoozed, rewritten, sent
 *   back, or on an attempt above one.
 * - `escalated`: the final run escalated.
 * - `in_progress`: the final run has not finished.
 * - `no_answer`: the final run was abandoned, or superseded by something
 *   other than a person's send-back.
 */
export type CaseClass = 'auto' | 'person' | 'escalated' | 'in_progress' | 'no_answer';

/** Cases counted by how they ended. */
export interface CaseCounts {
  readonly auto: number;
  readonly person: number;
  readonly escalated: number;
  readonly inProgress: number;
  readonly noAnswer: number;
}

export interface TeamWindow {
  /** ISO instants: `from` inclusive, `to` exclusive. */
  readonly from: string;
  readonly to: string;
}

export interface TeamPerson {
  readonly identity: string;
  /**
   * The products the roster lists the person as covering, in roster order,
   * for the queue's order. They grant nothing: every reviewer sees every case.
   */
  readonly products: readonly string[];
  /** Cases the person held in the week, each counted once. */
  readonly cases: number;
  /** Time the person held a case in the week. */
  readonly supportMs: number;
  /** Documents the person wrote in the console in the week. */
  readonly documents: number;
  /** The cases the person holds now. */
  readonly holding: readonly string[];
}

export interface TeamProduct extends CaseCounts {
  /** The product, or null for a channel that maps to none. */
  readonly product: string | null;
}

export interface OldestWaiting {
  readonly runId: string;
  readonly createdAt: string;
  readonly product: string | null;
  /** Who holds it now, or null when nobody does. */
  readonly heldBy: string | null;
}

/** Everything the team screen shows, from one snapshot of the ledger. */
export interface TeamReport {
  /** The UTC day that holds `now`, up to `now`. */
  readonly today: TeamWindow & CaseCounts;
  /** The `TEAM_WEEK_DAYS` before `now`. */
  readonly week: TeamWindow;
  /** Held time in the week, or null when no hold touches it. */
  readonly supportMs: number | null;
  /** Held time in the week before, or null when no hold touches it. */
  readonly previousSupportMs: number | null;
  /** How many people held a case in the week. */
  readonly supportPeople: number;
  /** Median first take to send, over cases sent in the week, or null. */
  readonly medianCaseMs: number | null;
  /** How many sends the median reads. */
  readonly sentCases: number;
  readonly oldestWaiting: OldestWaiting | null;
  /** Each active reviewer, by identity. */
  readonly people: readonly TeamPerson[];
  /** Each product that had a case in the week, by product. */
  readonly products: readonly TeamProduct[];
}

/**
 * The final attempt of each case whose final attempt started in the window,
 * with how it ended. The rule is the bands `day_run` rule: a turn counts
 * once, from its newest attempt, and a run with no turn is its own case.
 * Within one attempt it departs from that rule once: a run that its twin
 * superseded, such as a stranded walk handed back, never stands for the case.
 */
const CASES_SQL = `
  SELECT r.product,
         CASE
           WHEN r.state = 'escalated' THEN 'escalated'
           WHEN r.state IN ('received', 'classified', 'retrieved', 'composed', 'gated', 'executing')
             THEN 'in_progress'
           WHEN r.state = 'abandoned' THEN 'no_answer'
           WHEN r.state = 'superseded' AND r.sent_back_at IS NULL THEN 'no_answer'
           WHEN r.state IN ('awaiting_approval', 'closed', 'snoozed', 'superseded')
             OR r.approved_by IS NOT NULL
             OR r.attempt > 1
             OR EXISTS (SELECT 1 FROM step_journal j
                         WHERE j.run_id = r.run_id
                           AND ((j.step_id = 'park' AND j.status = 'done') OR j.step_id = 'rewrite'))
             THEN 'person'
           WHEN r.state = 'resolved' THEN 'auto'
           ELSE 'no_answer'
         END AS class
    FROM run r
   WHERE r.created_at >= $1::timestamptz AND r.created_at < $2::timestamptz
     AND (r.turn_number IS NULL
          OR NOT EXISTS (
               SELECT 1 FROM run later
                WHERE later.conversation_id = r.conversation_id
                  AND later.turn_number = r.turn_number
                  AND (later.attempt > r.attempt
                       OR (later.attempt = r.attempt
                           -- Within one attempt, a run superseded by its twin
                           -- (no send-back) never outranks the run that carries
                           -- the attempt on, whatever their times.
                           AND ((later.state <> 'superseded' OR later.sent_back_at IS NOT NULL)::int,
                                later.created_at, later.run_id)
                             > ((r.state <> 'superseded' OR r.sent_back_at IS NOT NULL)::int,
                                r.created_at, r.run_id)))))`;

/**
 * Each hold interval that touches the window, clipped to it.
 *
 * An interval starts at a take or a handover and ends at the next event on
 * the same run. A take by the holder is a refresh, so it ends one interval
 * and starts the next. No interval runs past its lapse, so a lapse noticed
 * late adds nothing. The hold records the lapse of its current take, so the
 * open interval ends there. An event does not record the lapse it ran under,
 * so a closed interval ends at most `lapseMs` after it started. Every
 * interval is clipped to the window, which ends at `now` at the latest.
 * Events of one transaction share a time, so the event id orders them.
 */
const INTERVALS_SQL = `
  WITH ordered AS (
    SELECT e.run_id, e.reviewer, e.kind, e.at,
           lead(e.at) OVER (PARTITION BY e.run_id ORDER BY e.event_id) AS next_at
      FROM case_hold_event e
     WHERE e.run_id IN (SELECT run_id FROM case_hold_event
                         WHERE at < $2::timestamptz
                           AND at >= $1::timestamptz - ($3::bigint * interval '1 millisecond'))
        -- An open hold ends at the lapse it recorded, which can be longer
        -- than the console's lapse now, so its take can be older still.
        OR e.run_id IN (SELECT run_id FROM case_hold
                         WHERE released_at IS NULL AND lapses_at > $1::timestamptz
                           AND taken_at < $2::timestamptz)
  ), spans AS (
    SELECT o.run_id, o.reviewer, o.at AS start_at,
           -- The last event of a run is the take of the hold still open, and
           -- the hold row holds the lapse that take set.
           CASE WHEN o.next_at IS NULL
                THEN COALESCE(h.lapses_at, o.at + ($3::bigint * interval '1 millisecond'))
                ELSE LEAST(o.next_at, o.at + ($3::bigint * interval '1 millisecond'))
           END AS end_at
      FROM ordered o
      LEFT JOIN case_hold h ON h.run_id = o.run_id AND o.next_at IS NULL
     WHERE o.kind IN ('take', 'handover')
  )
  SELECT s.run_id, s.reviewer,
         COALESCE(r.conversation_id || '#' || r.turn_number, r.run_id::text) AS case_key,
         GREATEST(s.start_at, $1::timestamptz) AS from_at,
         LEAST(s.end_at, $2::timestamptz) AS to_at
    FROM spans s
    JOIN run r ON r.run_id = s.run_id
   WHERE s.end_at > $1::timestamptz AND s.start_at < $2::timestamptz
     AND s.end_at > s.start_at`;

interface CaseRow {
  readonly product: string | null;
  readonly class: CaseClass;
}

interface IntervalRow {
  readonly run_id: string;
  readonly reviewer: string;
  readonly case_key: string;
  readonly from_at: Date;
  readonly to_at: Date;
}

/**
 * The team screen's figures, as of `now`.
 *
 * `lapseMs` is the hold's lapse, the one the console takes cases with. It
 * bounds each interval, because a lapse is recorded when it is noticed.
 *
 * One read-only transaction, so every figure describes one snapshot.
 * Read-only. Safe against a live database.
 */
export async function readTeam(
  pool: Pool,
  options: {
    readonly now?: Date;
    readonly lapseMs: number;
    readonly timeoutMs?: number;
    readonly clientTimeoutMs?: number;
  },
): Promise<TeamReport> {
  if (!Number.isSafeInteger(options.lapseMs) || options.lapseMs <= 0) {
    throw new RangeError(`lapseMs must be a positive whole number of milliseconds, not ${String(options.lapseMs)}`);
  }
  const now = options.now ?? new Date();
  const timeoutMs = options.timeoutMs ?? TEAM_TIMEOUT_MS;
  return boundedRead(pool, 'readTeam', timeoutMs, options.clientTimeoutMs ?? timeoutMs + 1_000, (query) =>
    teamIn(query, now, options.lapseMs));
}

async function teamIn(query: BoundedQuery, now: Date, lapseMs: number): Promise<TeamReport> {
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const weekStart = new Date(now.getTime() - TEAM_WEEK_DAYS * DAY_MS);
  const previousStart = new Date(weekStart.getTime() - TEAM_WEEK_DAYS * DAY_MS);
  const at = now.toISOString();

  const today = countsOf(await query<CaseRow>(CASES_SQL, [dayStart.toISOString(), at]));
  const weekCases = await query<CaseRow>(CASES_SQL, [weekStart.toISOString(), at]);

  const intervals = await query<IntervalRow>(INTERVALS_SQL, [weekStart.toISOString(), at, String(lapseMs)]);
  const previous = await query<IntervalRow>(
    INTERVALS_SQL, [previousStart.toISOString(), weekStart.toISOString(), String(lapseMs)]);

  // From the first take of each case sent in the week to its last send. One
  // pass over the history of the runs sent in the week: the earliest take
  // before each send is a running minimum, not a lookup per send. A send
  // undone and sent again (DEC-51) is one case, measured to its last send.
  // An undo moves the run back to awaiting approval and leaves the send in
  // the history, so only a run still resolved counts as sent.
  const sent = await query<{ n: string; median_ms: string | null }>(
    `SELECT count(*) AS n,
            percentile_disc(0.5) WITHIN GROUP (ORDER BY ms) AS median_ms
       FROM (SELECT extract(epoch FROM (e.at - e.first_at)) * 1000 AS ms
               FROM (SELECT kind, at,
                            min(at) FILTER (WHERE kind IN ('take', 'handover'))
                              OVER (PARTITION BY run_id ORDER BY event_id
                                    ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS first_at,
                            count(*) FILTER (WHERE kind = 'send')
                              OVER (PARTITION BY run_id ORDER BY event_id
                                    ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING) AS sends_after
                       FROM case_hold_event
                      WHERE run_id IN (SELECT e2.run_id FROM case_hold_event e2
                                         JOIN run r ON r.run_id = e2.run_id AND r.state = 'resolved'
                                        WHERE e2.kind = 'send' AND e2.at >= $1::timestamptz
                                          AND e2.at < $2::timestamptz)) e
              WHERE e.kind = 'send' AND e.at >= $1::timestamptz AND e.at < $2::timestamptz
                AND e.first_at IS NOT NULL AND e.sends_after = 0) sends`,
    [weekStart.toISOString(), at],
  );

  const oldest = await query<{ run_id: string; created_at: Date; product: string | null; held_by: string | null }>(
    `SELECT r.run_id, r.created_at, r.product,
            (SELECT h.reviewer FROM case_hold h
              WHERE h.run_id = r.run_id AND h.released_at IS NULL AND h.lapses_at > $1::timestamptz) AS held_by
       FROM run r
      WHERE r.state = 'awaiting_approval'
      ORDER BY r.created_at, r.run_id
      LIMIT 1`,
    [at],
  );

  const roster = await query<{ identity: string; products: string[] }>(
    'SELECT identity, products FROM reviewer WHERE active ORDER BY identity',
  );
  const written = await query<{ written_by: string; n: string }>(
    `SELECT written_by, count(*) AS n FROM document
      WHERE source = 'console' AND created_at >= $1::timestamptz AND created_at < $2::timestamptz
      GROUP BY written_by`,
    [weekStart.toISOString(), at],
  );
  const holding = await query<{ reviewer: string; run_id: string }>(
    `SELECT reviewer, run_id FROM case_hold
      WHERE released_at IS NULL AND lapses_at > $1::timestamptz
      ORDER BY taken_at, run_id`,
    [at],
  );

  const documents = new Map(written.map((row) => [row.written_by, Number(row.n)]));
  const people = roster.map((row): TeamPerson => {
    const own = intervals.filter((span) => span.reviewer === row.identity);
    return {
      identity: row.identity,
      products: row.products,
      cases: new Set(own.map((span) => span.case_key)).size,
      supportMs: totalMs(own),
      documents: documents.get(row.identity) ?? 0,
      holding: holding.filter((hold) => hold.reviewer === row.identity).map((hold) => hold.run_id),
    };
  });

  const byProduct = new Map<string | null, CaseRow[]>();
  for (const row of weekCases) byProduct.set(row.product, [...(byProduct.get(row.product) ?? []), row]);
  const products = [...byProduct]
    .map(([product, rows]): TeamProduct => ({ product, ...countsOf(rows) }))
    .sort((a, b) => byProductName(a.product, b.product));

  const first = oldest[0];
  const median = sent[0]!;
  return {
    today: { from: dayStart.toISOString(), to: at, ...today },
    week: { from: weekStart.toISOString(), to: at },
    supportMs: intervals.length === 0 ? null : totalMs(intervals),
    previousSupportMs: previous.length === 0 ? null : totalMs(previous),
    supportPeople: new Set(intervals.map((span) => span.reviewer)).size,
    medianCaseMs: median.median_ms === null ? null : Math.round(Number(median.median_ms)),
    sentCases: Number(median.n),
    oldestWaiting: first === undefined ? null : {
      runId: first.run_id,
      createdAt: first.created_at.toISOString(),
      product: first.product,
      heldBy: first.held_by,
    },
    people,
    products,
  };
}

/** Products by name, with the cases of no product last. */
function byProductName(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

function countsOf(rows: readonly CaseRow[]): CaseCounts {
  const count = (kind: CaseClass): number => rows.filter((row) => row.class === kind).length;
  return {
    auto: count('auto'),
    person: count('person'),
    escalated: count('escalated'),
    inProgress: count('in_progress'),
    noAnswer: count('no_answer'),
  };
}

function totalMs(spans: readonly IntervalRow[]): number {
  return spans.reduce((sum, span) => sum + (span.to_at.getTime() - span.from_at.getTime()), 0);
}
