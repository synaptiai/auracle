import type { Pool, PoolClient } from 'pg';

import {
  LedgerClockError,
  assertFinishClock,
  assertInsertClock,
  finishUnordered,
  type SeededFinishClock,
  type SeededInsertClock,
} from './clock.js';

// Re-exported so a caller of the fenced path imports the seam and the error
// from the same module as the write itself.
export {
  LedgerClockError,
  type SeededFinishClock,
  type SeededInsertClock,
} from './clock.js';

export interface FencedRunInput {
  runId: string;
  ticketId: string;
  /** DEC-36: hash(conversation_id) % N, or the ticket id when a run has none. */
  partition: number;
  /** DEC-28: fencing token. Must not decrease per ticket. */
  epoch: bigint;
  /** The state to commit when the insert succeeds (for example 'queued'). */
  state: string;
  /**
   * V2 open item 7: the arrival time from the intake row, copied onto the
   * run row so queue wait survives the ack. Absent for callers with no
   * queue (replay, tests); the column then stays null.
   */
  enqueuedAt?: Date;
  promptVer: string;
  modelVer: string;
  costMicros?: number;
  /** DEC-35: the conversation this run serves. Null on a V1-era run. */
  conversationId?: string;
  /**
   * DEC-35: the turn of the conversation this run answers.
   *
   * Absent on a V1-era run, on a replay run, and on any run the coordinator
   * received without one. The column takes null there, which is not turn one.
   */
  turnNumber?: number;
  stepsUsed?: number;
  deadlineAt: Date;
}

export interface FencedOutboxInput {
  stepId: string;
  idemKey: string;
  actionClass: string;
  delivery: 'at_least_once' | 'at_most_once';
  payload: unknown;
}

/**
 * V2 open item 7: states a run never leaves. The ledger stamps finished_at
 * when a write lands the run in one of these, in the same transaction.
 * Mirrors TerminalRunState in the coordinator; the ledger cannot import
 * upward, and these names are ledger data, not coordinator types.
 */
export const TERMINAL_RUN_STATES: ReadonlySet<string> = new Set([
  'resolved',
  'escalated',
  'superseded',
  'abandoned',
]);

/**
 * The three outcomes of the atomic fenced write (section 4.2):
 * - accepted    — run and outbox row committed together
 * - stale_epoch — DEC-28 refused the write before anything was touched
 * - superseded  — zero-row outbox insert; the run lands 'superseded', never 'queued'
 */
export type FencedInsertResult =
  | { outcome: 'accepted' }
  | { outcome: 'stale_epoch'; highestAcceptedEpoch: bigint }
  | { outcome: 'superseded' };

/**
 * Rolls the transaction back without replacing the fault that caused it.
 *
 * The connection is likeliest to be broken exactly when the statement that
 * failed already broke it, and the caller needs that error and not the
 * rollback's. This path now also carries `LedgerClockError`, which is the
 * one error here a caller matches on, so a masked rollback failure would
 * turn a caller bug into an unclassifiable connection error.
 */
async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // The original error is the one that matters.
  }
}

/**
 * The `run` insert, with or without the explicit `created_at` (issue #22).
 *
 * Exported so `clock-statement.test.ts` can pin the plain form: its column
 * list must keep omitting `created_at`, because that is what leaves the
 * column DEFAULT in charge of every production row.
 */
export function runInsertStatement(withClock: boolean, withFinish = false): string {
  const columns = [
    'run_id',
    'ticket_id',
    'partition',
    'epoch',
    'state',
    'prompt_ver',
    'model_ver',
    'cost_micros',
    'steps_used',
    'deadline_at',
    'enqueued_at',
    'conversation_id',
    // DEC-35: the turn this run answered. Fixed rather than optional, because
    // a run with no turn writes null here and a reader joins on the column
    // rather than assuming turn one.
    'turn_number',
  ];
  if (withClock) columns.push('created_at');
  if (withFinish) columns.push('finished_at');
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
  return `INSERT INTO run (${columns.join(', ')}) VALUES (${placeholders})`;
}

/**
 * The only write path to `run` + `outbox` for a run's first transition
 * (Ledger Implementation Design, "The atomic fenced write").
 *
 * One transaction does all of:
 *   1. read + lock the highest accepted epoch for the ticket
 *   2. refuse epochs lower than that (DEC-28)
 *   3. upsert ticket_epoch
 *   4. write the new run state
 *   5. insert the outbox record, when there is one
 *
 * Rule 1 (section 4.2): steps 4 and 5 commit together or not at all.
 * Rule 2 (section 4.2): an outbox insert of zero rows is a distinct result,
 * never an ignored success — the run moves to 'superseded' and stops.
 */
export async function fencedInsert(
  pool: Pool,
  run: FencedRunInput,
  outbox: FencedOutboxInput | null,
  /**
   * Issue #22: an explicit timing, for a seeder writing a backdated history
   * through this same path. Omitted by every daemon, which is asserted off
   * the import graph in `clock-reachability.test.ts`; the column DEFAULT
   * then records the wall clock as before.
   */
  clock?: SeededInsertClock,
): Promise<FencedInsertResult> {
  // Before BEGIN, so a refused triple leaves nothing behind: no epoch
  // upsert, no run row, no outbox row.
  if (clock !== undefined) {
    assertInsertClock(clock, run.enqueuedAt, TERMINAL_RUN_STATES.has(run.state));
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      // Serialize writers on this ticket so the epoch check and the upsert
      // cannot interleave between two concurrent runs.
      const current = await client.query(
        'SELECT epoch FROM ticket_epoch WHERE ticket_id = $1 FOR UPDATE',
        [run.ticketId],
      );
      const highest =
        current.rows.length > 0 ? BigInt(current.rows[0]!.epoch as string) : null;

      if (highest !== null && run.epoch < highest) {
        await client.query('ROLLBACK');
        return { outcome: 'stale_epoch', highestAcceptedEpoch: highest };
      }

      await client.query(
        `INSERT INTO ticket_epoch (ticket_id, epoch) VALUES ($1, $2)
         ON CONFLICT (ticket_id) DO UPDATE SET epoch = EXCLUDED.epoch`,
        [run.ticketId, run.epoch.toString()],
      );

      const values: unknown[] = [
        run.runId,
        run.ticketId,
        run.partition,
        run.epoch.toString(),
        run.state,
        run.promptVer,
        run.modelVer,
        run.costMicros ?? 0,
        run.stepsUsed ?? 0,
        run.deadlineAt.toISOString(),
        run.enqueuedAt ?? null,
        run.conversationId ?? null,
        run.turnNumber ?? null,
      ];
      if (clock !== undefined) values.push(clock.createdAt.toISOString());
      // A run inserted already terminal never transitions, so this insert is
      // the only chance to stamp its finish. Without this the clock's finish
      // was dropped in silence, the column stayed null, and the latency
      // reader labelled the row `unstamped` and dropped it from the service
      // distribution. A clockless insert keeps its old behaviour: the column
      // stays null, which is the honest answer when nobody said.
      // assertInsertClock refused a finish on a state that has not finished,
      // so this is exactly the terminal case.
      const stampsFinish = clock?.finishedAt !== undefined;
      if (stampsFinish) values.push(clock.finishedAt!.toISOString());
      await client.query(runInsertStatement(clock !== undefined, stampsFinish), values);

      if (outbox === null) {
      await client.query('COMMIT');
      return { outcome: 'accepted' };
    }

    const inserted = await client.query(
        `INSERT INTO outbox (
           run_id, step_id, idem_key, epoch, action_class, delivery, payload, status
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
         ON CONFLICT (idem_key) DO NOTHING`,
        [
          run.runId,
          outbox.stepId,
          outbox.idemKey,
          run.epoch.toString(),
          outbox.actionClass,
          outbox.delivery,
          JSON.stringify(outbox.payload),
        ],
      );

      // Section 4.2 rule 2: zero rows is a distinct result. A run that lost
      // the outbox insert must never reach 'queued' (liveness). It is also
      // terminal, so the timing column is stamped in the same commit.
      if ((inserted.rowCount ?? 0) === 0) {
        // 'superseded' is terminal, so this commit also stamps the finish.
        //
        // Three cases, and they are not one statement, because the third
        // must write null rather than a value. With no clock the behaviour
        // is the old one: now(). With a finish on the clock, that finish.
        //
        // With a clock and no finish the column stays null, and the latency
        // reader then labels the row `unstamped` and leaves it out of the
        // service distribution. The creation instant looked like the honest
        // answer — such a run never ran — but the reader does not agree:
        // `never_ran` is keyed on `prompt_ver` and `model_ver` both reading
        // 'intake', so a seeded row carrying any other pins would have read
        // as `measured` with a service time of exactly zero and entered the
        // percentiles. A seeded history in which some runs lose the outbox
        // race would then report a service p50 no run took. `unstamped`
        // says what is true: it finished, and its duration is unrecoverable.
        if (clock === undefined) {
          await client.query(
            "UPDATE run SET state = 'superseded', finished_at = now() WHERE run_id = $1",
            [run.runId],
          );
        } else {
          await client.query(
            "UPDATE run SET state = 'superseded', finished_at = $2::timestamptz"
              + ' WHERE run_id = $1',
            [run.runId, clock.finishedAt?.toISOString() ?? null],
          );
        }
        await client.query('COMMIT');
        return { outcome: 'superseded' };
      }

      await client.query('COMMIT');
      return { outcome: 'accepted' };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    }
  } finally {
    client.release();
  }
}

export interface FencedTransitionInput {
  runId: string;
  /** The next state to commit when the write succeeds. */
  state: string;
  /** Accumulated run totals (DEC-25 bookkeeping); written as absolute values. */
  costMicros: number;
  stepsUsed: number;
  /**
   * Optional outbox record committed in the same transaction (section 4.2
   * rule 1). Absent for transitions that produce no external action.
   */
  outbox?: FencedOutboxInput;
  /**
   * Optional precondition: the transition proceeds only when the run
   * currently sits in this state. Checked under the row lock, inside the
   * transaction, so two concurrent callers cannot both pass it.
   */
  fromState?: string;
  /**
   * Optional extra writes committed in this same transaction, on the
   * accepted path only. A throw rolls the whole transition back. This is
   * how the approve entrypoint records the approval-edit distance with the
   * state move it belongs to (section 4.10).
   */
  afterWrite?: (client: PoolClient) => Promise<void>;
}

export type FencedTransitionResult =
  | { outcome: 'accepted' }
  | { outcome: 'stale_epoch'; highestAcceptedEpoch: bigint }
  | { outcome: 'superseded' }
  | { outcome: 'unknown_run' }
  | { outcome: 'wrong_state'; currentState: string };

/**
 * Moves an existing run forward under the same rules as `fencedInsert`:
 * the epoch is checked against ticket_epoch inside the transaction, and an
 * outbox insert of zero rows lands the run 'superseded' instead of the
 * requested state (section 4.2 rule 2, liveness).
 */
export async function fencedTransition(
  pool: Pool,
  t: FencedTransitionInput,
  /**
   * Issue #22: the finish instant a seeder gives a terminal transition. It
   * is checked against the row's stored `created_at`, read under the same
   * row lock, so the caller cannot disagree with the row. Ignored on a
   * non-terminal state, which stamps no finish at all.
   */
  clock?: SeededFinishClock,
): Promise<FencedTransitionResult> {
  // The shape only, before BEGIN. The order comparison runs in the database,
  // because the reference is a stored microsecond value that a JS Date
  // truncates.
  //
  // A transition that asks for a non-terminal state and carries no outbox
  // record can never stamp a finish, whatever happens, so a clock there is
  // a caller bug and is refused. The same request carrying an outbox record
  // is not: a zero-row insert lands it 'superseded' (section 4.2 rule 2),
  // which is terminal, and that branch does stamp the finish. The insert
  // side refuses the matching case for the same reason.
  if (clock !== undefined) {
    assertFinishClock(clock);
    if (!TERMINAL_RUN_STATES.has(t.state) && t.outbox === undefined) {
      throw new LedgerClockError(
        'explicit clock supplies finished_at for a non-terminal transition that'
          + ' carries no outbox record; nothing would store it',
      );
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      // The comparison is a column of the row read, not a comparison in
      // JavaScript. Postgres holds `created_at` to the microsecond and
      // node-postgres truncates it to the millisecond, so a JS check was
      // permissive by up to 999 microseconds and accepted a finish the
      // database then read as earlier than the creation.
      const row = await client.query(
        'SELECT ticket_id, epoch, state, created_at,'
          + ' ($2::timestamptz IS NOT NULL AND $2::timestamptz < created_at)'
          + ' AS finish_unordered'
          + ' FROM run WHERE run_id = $1 FOR UPDATE',
        [t.runId, clock === undefined ? null : clock.finishedAt.toISOString()],
      );
      if (row.rows.length === 0) {
        await client.query('ROLLBACK');
        return { outcome: 'unknown_run' };
      }
      const ticketId = row.rows[0]!.ticket_id as string;
      const runEpoch = BigInt(row.rows[0]!.epoch as string);
      const currentState = row.rows[0]!.state as string;
      const createdAt = row.rows[0]!.created_at as Date;
      const finishUnorderedFlag = row.rows[0]!.finish_unordered as boolean | null;

      // Before the outbox insert, and whatever state was requested. Checking
      // it later, or only for a terminal target, made a caller's bad clock
      // decide the outcome of a race: the losing run threw instead of
      // reaching `superseded` and stopping (section 4.2, liveness), and only
      // when a race happened at all.
      if (clock !== undefined && finishUnorderedFlag === true) {
        throw finishUnordered(clock.finishedAt, createdAt);
      }

      if (t.fromState !== undefined && currentState !== t.fromState) {
        await client.query('ROLLBACK');
        return { outcome: 'wrong_state', currentState };
      }

      const current = await client.query(
        'SELECT epoch FROM ticket_epoch WHERE ticket_id = $1 FOR UPDATE',
        [ticketId],
      );
      const highest =
        current.rows.length > 0 ? BigInt(current.rows[0]!.epoch as string) : null;

      if (highest !== null && runEpoch < highest) {
        await client.query('ROLLBACK');
        return { outcome: 'stale_epoch', highestAcceptedEpoch: highest };
      }

      // V2 open item 7: a terminal state never changes again, so its commit
      // also stamps the finish time. One transaction, one truth.
      if (TERMINAL_RUN_STATES.has(t.state)) {
        await client.query(
          'UPDATE run SET state = $2, cost_micros = $3, steps_used = $4,'
            + ' finished_at = COALESCE($5::timestamptz, now()) WHERE run_id = $1',
          [
            t.runId,
            t.state,
            t.costMicros,
            t.stepsUsed,
            clock === undefined ? null : clock.finishedAt.toISOString(),
          ],
        );
      } else {
        await client.query(
          'UPDATE run SET state = $2, cost_micros = $3, steps_used = $4 WHERE run_id = $1',
          [t.runId, t.state, t.costMicros, t.stepsUsed],
        );
      }

      if (t.outbox !== undefined) {
        const inserted = await client.query(
          `INSERT INTO outbox (
             run_id, step_id, idem_key, epoch, action_class, delivery, payload, status
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
           ON CONFLICT (idem_key) DO NOTHING`,
          [
            t.runId,
            t.outbox.stepId,
            t.outbox.idemKey,
            runEpoch.toString(),
            t.outbox.actionClass,
            t.outbox.delivery,
            JSON.stringify(t.outbox.payload),
          ],
        );
        if ((inserted.rowCount ?? 0) === 0) {
          // Terminal, so the same commit stamps the finish. The clock was
          // already checked against this row above.
          await client.query(
            "UPDATE run SET state = 'superseded',"
              + ' finished_at = COALESCE($2::timestamptz, now()) WHERE run_id = $1',
            [t.runId, clock === undefined ? null : clock.finishedAt.toISOString()],
          );
          await client.query('COMMIT');
          return { outcome: 'superseded' };
        }
      }

      // Extra writes the caller wants in this same commit (section 4.2
      // rule 1). A throw here rolls the whole transition back.
      if (t.afterWrite !== undefined) {
        await t.afterWrite(client);
      }

      await client.query('COMMIT');
      return { outcome: 'accepted' };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    }
  } finally {
    client.release();
  }
}
