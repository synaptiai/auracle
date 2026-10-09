// The case hold (DEC-46).
//
// DEC-46: "A console outcome on a reply the ledger holds applies only to the
// case as its reviewer was shown it." The hold is what a reviewer takes
// before working a case, and what tells the rest of the team who has it.
//
// It is advisory. It refuses no write, it moves no fence, and a reviewer who
// does not hold a case may still approve it — the epoch (DEC-28) and the run's
// row lock stay the guards. So every write here is a statement about who is
// working, never a condition another write depends on. The one place the
// console reads it as a condition is the take itself, where the answer is
// what the page shows.
//
// One case per person. Taking a case releases the taker's live hold on any
// other, which is what the criterion and the lock's purpose ask for: a
// reviewer reads one case at a time.
//
// The run's row lock is the serialization point. Two takes at one instant
// both read the run row `FOR UPDATE`; the second waits, then sees the first's
// hold, and answers `held_by_other`. Without that lock both see no holder.
//
// A lapse is not a job. `lapses_at` is stamped when the hold is taken, and
// any transaction here that finds it past clears the hold and records the
// lapse. A hold nobody looks at is cleared — and its lapse recorded — by the
// next take on any case, or by the next read of that case.
import type { Pool, PoolClient } from 'pg';

/** The run id is a `uuid` column, so a value of another shape cannot be one. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A live hold on one case. */
export interface Hold {
  readonly reviewer: string;
  readonly takenAt: Date;
  readonly lapsesAt: Date;
}

export type TakeOutcome =
  | { readonly outcome: 'taken' }
  /** Somebody else holds it. The holder is named, so the console can say who. */
  | { readonly outcome: 'held_by_other'; readonly holder: Hold }
  /** The case is not waiting for a person, and the answer names its state. */
  | { readonly outcome: 'not_waiting'; readonly state: string }
  | { readonly outcome: 'unknown_run' };

/** One line of a case's history. */
export interface HoldEvent {
  readonly kind: string;
  readonly reviewer: string;
  readonly at: Date;
  /**
   * Why, where the kind is not enough: `take_other` for a release the taker's
   * next case caused, `refresh` for a take by the holder. Null when the kind
   * says it.
   */
  readonly reason: string | null;
  readonly fromReviewer: string | null;
}

/**
 * Rolls the transaction back without replacing the fault that caused it.
 *
 * The connection is likeliest to be broken exactly when the statement that
 * failed already broke it, and the caller needs that error and not the
 * rollback's. `src/ledger/insert.ts` carries the same helper for the same
 * reason; this module follows it rather than letting a rollback fault decide
 * what an incident reader sees.
 */
async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // The original error is the one that matters.
  }
}

function holdFrom(row: { reviewer: string; taken_at: Date; lapses_at: Date }): Hold {
  return { reviewer: row.reviewer, takenAt: row.taken_at, lapsesAt: row.lapses_at };
}

/**
 * Clears every hold whose period has run out, and records each as a lapse.
 *
 * `lapses_at <= now()` and not `<`: a hold whose period ends at this instant
 * has ended. The comparison is the database's, because `now()` is the same
 * instant the transaction writes, and a JavaScript clock would be a second
 * opinion the row cannot be compared against.
 */
async function lapseExpired(client: PoolClient): Promise<void> {
  const lapsed = await client.query(
    `UPDATE case_hold SET released_at = now(), released_by = NULL, release_kind = 'lapse'
      WHERE released_at IS NULL AND lapses_at <= now()
      RETURNING run_id, reviewer`,
  );
  for (const row of lapsed.rows as Array<{ run_id: string; reviewer: string }>) {
    await client.query(
      `INSERT INTO case_hold_event (run_id, reviewer, kind, reason)
       VALUES ($1, $2, 'lapse', NULL)`,
      [row.run_id, row.reviewer],
    );
  }
}

/**
 * Records a hold's end in the history. The row keeps the current state; this
 * keeps what happened, which outlives the row's next take.
 */
async function record(
  client: PoolClient,
  event: {
    runId: string;
    reviewer: string;
    kind: 'take' | 'handover' | 'release' | 'send' | 'close' | 'send_back' | 'lapse';
    reason?: string;
    fromReviewer?: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO case_hold_event (run_id, reviewer, kind, reason, from_reviewer)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      event.runId,
      event.reviewer,
      event.kind,
      event.reason ?? null,
      event.fromReviewer ?? null,
    ],
  );
}

/**
 * Takes a case for one reviewer, or says why it cannot.
 *
 * `force` is the takeover: the reviewer confirmed that they are moving a live
 * hold, so the holder changes and the history records a handover. Without it,
 * a live hold is someone else's and the answer names them.
 */
export async function takeHold(
  pool: Pool,
  take: {
    readonly runId: string;
    readonly reviewer: string;
    readonly lapseMs: number;
    readonly force?: boolean;
  },
): Promise<TakeOutcome> {
  if (!UUID.test(take.runId)) return { outcome: 'unknown_run' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      // The serialization point. Everything below reads state the run row
      // owns, under the lock the ledger's own transitions take.
      const run = await client.query(
        'SELECT state FROM run WHERE run_id = $1 FOR UPDATE',
        [take.runId],
      );
      if (run.rows.length === 0) {
        await client.query('ROLLBACK');
        return { outcome: 'unknown_run' };
      }
      const state = run.rows[0]!.state as string;
      if (state !== 'awaiting_approval') {
        await client.query('ROLLBACK');
        return { outcome: 'not_waiting', state };
      }

      // Every hold that ran out, before this take is judged. A lapsed hold is
      // nobody's, so a take on it succeeds without force and says so in the
      // history.
      await lapseExpired(client);

      const live = await client.query(
        `SELECT reviewer, taken_at, lapses_at FROM case_hold
          WHERE run_id = $1 AND released_at IS NULL`,
        [take.runId],
      );
      const held = live.rows[0] as
        | { reviewer: string; taken_at: Date; lapses_at: Date }
        | undefined;
      if (held !== undefined && held.reviewer !== take.reviewer && take.force !== true) {
        await client.query('ROLLBACK');
        return { outcome: 'held_by_other', holder: holdFrom(held) };
      }

      // One case per person: whatever else this reviewer holds is released,
      // and recorded — a hold that vanished with no event would read as a
      // case nobody ever worked.
      const others = await client.query(
        `UPDATE case_hold
            SET released_at = now(), released_by = $2, release_kind = 'take_other'
          WHERE reviewer = $1 AND released_at IS NULL AND run_id <> $3
          RETURNING run_id`,
        [take.reviewer, take.reviewer, take.runId],
      );
      for (const row of others.rows as Array<{ run_id: string }>) {
        await record(client, {
          runId: row.run_id,
          reviewer: take.reviewer,
          kind: 'release',
          reason: 'take_other',
        });
      }

      await client.query(
        `INSERT INTO case_hold (run_id, reviewer, taken_at, lapses_at, released_at, released_by, release_kind)
         VALUES ($1, $2, now(), now() + ($3::bigint * interval '1 millisecond'), NULL, NULL, NULL)
         ON CONFLICT (run_id) DO UPDATE
           SET reviewer = EXCLUDED.reviewer,
               taken_at = EXCLUDED.taken_at,
               lapses_at = EXCLUDED.lapses_at,
               released_at = NULL,
               released_by = NULL,
               release_kind = NULL`,
        [take.runId, take.reviewer, String(take.lapseMs)],
      );
      // Three shapes, and the history has to tell them apart. No hold is a
      // first take. Somebody else's hold is a takeover, and the team needs to
      // know whose hold moved. The taker's own hold is a refresh: the case
      // did not change hands, so a `handover` naming the same reviewer twice
      // would record an event that did not happen.
      const mine = held !== undefined && held.reviewer === take.reviewer;
      if (held !== undefined && !mine) {
        await record(client, {
          runId: take.runId,
          reviewer: take.reviewer,
          kind: 'handover',
          fromReviewer: held.reviewer,
        });
      } else {
        await record(client, {
          runId: take.runId,
          reviewer: take.reviewer,
          kind: 'take',
          ...(mine ? { reason: 'refresh' } : {}),
        });
      }

      await client.query('COMMIT');
      return { outcome: 'taken' };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    }
  } finally {
    client.release();
  }
}

export type ReleaseOutcome =
  | { readonly outcome: 'released' }
  /** Nobody holds it, so there is nothing to release. */
  | { readonly outcome: 'not_held' }
  /** Somebody else holds it, and a release is not how it moves. */
  | { readonly outcome: 'held_by_other'; readonly holder: Hold }
  | { readonly outcome: 'unknown_run' };

/**
 * Lets go of a case the reviewer holds.
 *
 * `kind` is why: a deliberate release, the send that ends the work on a
 * resolved case, the close that ends it on one finished with no reply, or
 * the send-back that ends it on one a reviewer rejected (DEC-48, DEC-49). On
 * a release, a reviewer who does not hold the case is told who does, because
 * that means somebody took it over while they were reading. Every other kind
 * ends the hold on the case it finishes whoever holds it — see
 * `releaseHoldIn`. None is a word another can borrow: a close sends nothing,
 * so a close recorded as a send would name an event that did not happen.
 */
export async function releaseHold(
  pool: Pool,
  release: {
    readonly runId: string;
    readonly reviewer: string;
    readonly kind: 'release' | 'send' | 'close' | 'send_back';
  },
): Promise<ReleaseOutcome> {
  if (!UUID.test(release.runId)) return { outcome: 'unknown_run' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      const outcome = await releaseHoldIn(client, release);
      await client.query('COMMIT');
      return outcome;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    }
  } finally {
    client.release();
  }
}

/**
 * The release, in the caller's transaction.
 *
 * An approval ends the hold on the case it resolves in the transaction that
 * records the send: released outside it, a hold would outlive an approval
 * that rolled back. That transaction holds the run row, so this reads the
 * case row under it rather than starting one of its own.
 *
 * A send ends the hold whoever holds it (maintainer's ruling, 2026-09-18).
 * The case has left the queue, so a hold on it claims somebody is still
 * working it, and the history would read as a lapse twenty minutes later
 * rather than the send that ended it. A close ends it the same way (DEC-48):
 * the case leaves the queue with no reply, and the holder's work on it is
 * over. The two keep their own names, because the history is what a team
 * reads for the time a case held a person. A deliberate release stays the
 * holder's own: a reviewer who does not hold the case is told who does,
 * because that means somebody took it over while they were reading.
 */
export async function releaseHoldIn(
  client: PoolClient,
  release: {
    readonly runId: string;
    readonly reviewer: string;
    readonly kind: 'release' | 'send' | 'close' | 'send_back';
  },
): Promise<ReleaseOutcome> {
  if (!UUID.test(release.runId)) return { outcome: 'unknown_run' };
  // No ROLLBACK here: the caller owns the transaction, and an approval that
  // did not hold this case still commits. The case's own row is read under
  // the caller's lock, which is the run row.
  // `lapses_at > now()`, so the liveness comparison is the database's, as it
  // is in `lapseExpired` and `readHolds`. A hold past its period is nobody's
  // and this releases nothing — and `lapseExpired` records the lapse it
  // found, which is the one write this call may still make.
  const live = await client.query(
    `SELECT reviewer, taken_at, lapses_at FROM case_hold
      WHERE run_id = $1 AND released_at IS NULL AND lapses_at > now() FOR UPDATE`,
    [release.runId],
  );
  const held = live.rows[0] as
    | { reviewer: string; taken_at: Date; lapses_at: Date }
    | undefined;
  if (held === undefined) {
    await lapseExpired(client);
    return { outcome: 'not_held' };
  }
  if (release.kind === 'release' && held.reviewer !== release.reviewer) {
    return { outcome: 'held_by_other', holder: holdFrom(held) };
  }
  await client.query(
    `UPDATE case_hold SET released_at = now(), released_by = $2, release_kind = $3
      WHERE run_id = $1`,
    [release.runId, release.reviewer, release.kind],
  );
  await record(client, {
    runId: release.runId,
    reviewer: release.reviewer,
    kind: release.kind,
  });
  return { outcome: 'released' };
}

export type HandoverOutcome =
  | { readonly outcome: 'handed_over' }
  /** The reviewer named is not on the active roster. */
  | { readonly outcome: 'not_a_reviewer' }
  /** The holder named themselves: there is nobody to move it to. */
  | { readonly outcome: 'already_yours' }
  /** The reviewer asking does not hold the case. */
  | { readonly outcome: 'not_yours' }
  | { readonly outcome: 'not_held' }
  | { readonly outcome: 'unknown_run' };

/**
 * Moves a case the reviewer holds to a teammate it names (DEC-46).
 *
 * The teammate has to be on the active roster: a case handed to somebody the
 * console will refuse at their next request is a case nobody holds. The
 * movement is recorded as a handover, with whose hold moved.
 */
export async function handoverHold(
  pool: Pool,
  move: {
    readonly runId: string;
    readonly from: string;
    readonly to: string;
    readonly lapseMs: number;
    readonly isReviewer: (identity: string) => Promise<boolean>;
  },
): Promise<HandoverOutcome> {
  if (!UUID.test(move.runId)) return { outcome: 'unknown_run' };
  if (!(await move.isReviewer(move.to))) return { outcome: 'not_a_reviewer' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      // The comparison is the database's, as it is everywhere else here.
      const live = await client.query(
        `SELECT reviewer FROM case_hold
          WHERE run_id = $1 AND released_at IS NULL AND lapses_at > now() FOR UPDATE`,
        [move.runId],
      );
      const held = live.rows[0] as { reviewer: string } | undefined;
      if (held === undefined) {
        // Nothing live to move, and the period of whatever was here has run
        // out. `lapseExpired` clears it and records the lapse, and this
        // COMMIT keeps that record: a rollback would discard the one write
        // this call made, and leave the lapse for a later reader to find.
        await lapseExpired(client);
        await client.query('COMMIT');
        return { outcome: 'not_held' };
      }
      if (held.reviewer !== move.from) {
        await client.query('ROLLBACK');
        return { outcome: 'not_yours' };
      }
      // The holder naming themselves. A handover moves the case to a
      // teammate, so this is nobody's move — and recorded, it would be a
      // `handover` naming one person twice, an event that did not happen.
      // The field carries free text, and the rail prints the reviewer's own
      // identity, so a holder can type it.
      if (move.to === move.from) {
        await client.query('ROLLBACK');
        return { outcome: 'already_yours' };
      }
      // One case per person, on this path too: a handover puts the case on
      // the teammate, so whatever else they held is released — the same
      // bookkeeping a take does. Without it a reviewer could be handed a
      // second case and the queue would show them working both.
      //
      // The sweep runs first and the release skips a hold past its period, so
      // a lapsed hold of theirs is recorded as the lapse it is rather than as
      // a release this handover caused. `takeHold` orders the same two the
      // same way.
      await lapseExpired(client);
      const others = await client.query(
        `UPDATE case_hold
            SET released_at = now(), released_by = $2, release_kind = 'take_other'
          WHERE reviewer = $2 AND released_at IS NULL AND lapses_at > now() AND run_id <> $1
          RETURNING run_id`,
        [move.runId, move.to],
      );
      for (const row of others.rows as Array<{ run_id: string }>) {
        await record(client, {
          runId: row.run_id,
          reviewer: move.to,
          kind: 'release',
          reason: 'take_other',
        });
      }

      await client.query(
        `UPDATE case_hold
            SET reviewer = $2,
                taken_at = now(),
                lapses_at = now() + ($3::bigint * interval '1 millisecond')
          WHERE run_id = $1`,
        [move.runId, move.to, String(move.lapseMs)],
      );
      await record(client, {
        runId: move.runId,
        reviewer: move.to,
        kind: 'handover',
        fromReviewer: move.from,
      });
      await client.query('COMMIT');
      return { outcome: 'handed_over' };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    }
  } finally {
    client.release();
  }
}

/**
 * The live hold on one case, or null.
 *
 * It clears every hold whose period has run out, which makes it a read that
 * writes: the spec's answer for a lapse nobody acted on. The queue does not
 * use it — `readHolds` is a pure read and leaves the lapse for this call.
 */
export async function readHold(pool: Pool, runId: string): Promise<Hold | null> {
  if (!UUID.test(runId)) return null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      await lapseExpired(client);
      const live = await client.query(
        `SELECT reviewer, taken_at, lapses_at FROM case_hold
          WHERE run_id = $1 AND released_at IS NULL`,
        [runId],
      );
      await client.query('COMMIT');
      const row = live.rows[0] as
        | { reviewer: string; taken_at: Date; lapses_at: Date }
        | undefined;
      return row === undefined ? null : holdFrom(row);
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    }
  } finally {
    client.release();
  }
}

/**
 * The live holds on a list of cases, in one statement.
 *
 * The queue draws hundreds of rows, so a read per row is hundreds of
 * statements behind one page. A lapsed hold is simply not in the map, and is
 * left for `readHold` or the next take to record.
 */
export async function readHolds(
  pool: Pool,
  runIds: readonly string[],
): Promise<Map<string, Hold>> {
  const wanted = runIds.filter((runId) => UUID.test(runId));
  const holds = new Map<string, Hold>();
  if (wanted.length === 0) return holds;
  const rows = await pool.query(
    `SELECT run_id, reviewer, taken_at, lapses_at FROM case_hold
      WHERE run_id = ANY($1::uuid[]) AND released_at IS NULL AND lapses_at > now()`,
    [wanted],
  );
  for (const row of rows.rows as Array<{
    run_id: string; reviewer: string; taken_at: Date; lapses_at: Date;
  }>) {
    holds.set(row.run_id, holdFrom(row));
  }
  return holds;
}

/** Every event on one case, oldest first: the history a case shows. */
export async function holdHistory(pool: Pool, runId: string): Promise<HoldEvent[]> {
  if (!UUID.test(runId)) return [];
  const rows = await pool.query(
    `SELECT kind, reviewer, at, reason, from_reviewer FROM case_hold_event
      WHERE run_id = $1 ORDER BY event_id`,
    [runId],
  );
  return (rows.rows as Array<{
    kind: string; reviewer: string; at: Date; reason: string | null;
    from_reviewer: string | null;
  }>).map((row) => ({
    kind: row.kind,
    reviewer: row.reviewer,
    at: row.at,
    reason: row.reason,
    fromReviewer: row.from_reviewer,
  }));
}
