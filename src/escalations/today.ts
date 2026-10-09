// What reached a person today, against what arrived.
//
// The queue header states both counts. Two counts and no ratio: the published
// containment figure comes from the gold report, and a live share beside it
// would read as the same number.
import type { Pool } from 'pg';

import { boundedRead } from '../db/bounded-read.js';

/**
 * How long the count may run. It is a header over the work, and a reviewer's
 * page should not wait on it.
 */
export const QUEUE_TODAY_TIMEOUT_MS = 2_000;

/** One UTC day's arrivals and the cases among them that reached a person. */
export interface QueueToday {
  /** The UTC calendar day counted, as `YYYY-MM-DD`. */
  readonly day: string;
  /** Inbound messages that arrived that day: one turn each (DEC-35). */
  readonly arrived: number;
  /**
   * The messages that arrived that day whose run parked for a person, counted
   * once each. A later retry does not move a message to another day, and a
   * run approved since still counts, because it did reach the queue.
   *
   * A run that recorded no message has no arrival to date it by. Its own
   * start day places it, and it counts once as a run.
   *
   * A finished park is what counts. The park journals before the run moves to
   * waiting, and the fence can refuse that move. Such a run is rare, and it
   * counts although nobody saw it.
   */
  readonly reachedQueue: number;
}

/**
 * Today's counts, for the UTC day that holds `now`.
 *
 * The day is the UTC calendar day, as `pnpm run bands` and `pnpm run latency`
 * read it. Arrivals are turns, because the intake row is deleted once a run
 * picks it up. A case reached the queue when a run of its turn journalled a
 * finished park step. Dating it by the turn keeps a message on one day: a
 * message that arrives at 23:58 and parks at 00:02 belongs to the day it
 * arrived. A run that recorded no message is not among the arrivals, so on a
 * ledger that holds one the second count can exceed the first.
 *
 * Each column is compared with a half-open range rather than cast to a date,
 * so the read uses the index on it. The console runs this on every load of
 * its landing page, so the statement runs under its own timeout. A statement
 * that cannot finish raises rather than holding its connection, and the
 * timeout ends with the transaction, so the connection returns clean.
 *
 * The statements also run under a client-side deadline, `clientTimeoutMs`, a
 * second past the server's bound, so a dead connection cannot keep a pool
 * slot. The wait for a connection from the pool is the pool's own bound, and
 * the console sets one. `boundedRead` enforces both bounds.
 */
export async function readQueueToday(
  pool: Pool,
  now: Date = new Date(),
  timeoutMs: number = QUEUE_TODAY_TIMEOUT_MS,
  clientTimeoutMs: number = timeoutMs + 1_000,
): Promise<QueueToday> {
  const rows = await boundedRead(pool, 'readQueueToday', timeoutMs, clientTimeoutMs, (query) =>
    query<{ day: string; arrived: string; reached: string }>(
      `WITH day AS (
           SELECT d,
                  d::timestamp AT TIME ZONE 'UTC' AS lo,
                  (d + 1)::timestamp AT TIME ZONE 'UTC' AS hi
             FROM (SELECT ($1::timestamptz AT TIME ZONE 'UTC')::date AS d) picked
         )
         SELECT to_char(day.d, 'YYYY-MM-DD') AS day,
                (SELECT count(*) FROM turn t
                  WHERE t.created_at >= day.lo AND t.created_at < day.hi) AS arrived,
                (SELECT count(*) FROM turn t
                  WHERE t.created_at >= day.lo AND t.created_at < day.hi
                    AND EXISTS (
                      SELECT 1 FROM run r
                        JOIN step_journal park
                          ON park.run_id = r.run_id AND park.step_id = 'park' AND park.status = 'done'
                       WHERE r.conversation_id = t.conversation_id
                         AND r.turn_number = t.turn_number))
                + (SELECT count(*) FROM run r
                    WHERE (r.conversation_id IS NULL OR r.turn_number IS NULL)
                      AND r.created_at >= day.lo AND r.created_at < day.hi
                      AND EXISTS (
                        SELECT 1 FROM step_journal park
                         WHERE park.run_id = r.run_id AND park.step_id = 'park'
                           AND park.status = 'done')) AS reached
           FROM day`,
      [now.toISOString()],
    ));
  const row = rows[0]!;
  return { day: row.day, arrived: Number(row.arrived), reachedQueue: Number(row.reached) };
}
