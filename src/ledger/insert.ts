import type { Pool, PoolClient } from 'pg';

import { errorMessage } from '../errors.js';
import { logLine } from '../log/line.js';

import {
  LedgerClockError,
  assertFinishClock,
  assertInsertClock,
  finishUnordered,
  type SeededFinishClock,
  type SeededInsertClock,
} from './clock.js';
import { runStateClass } from './run-state.js';

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
  /**
   * DEC-28: fencing token. Must not decrease per ticket.
   *
   * `'next'` asks the ledger to allocate it — the ticket's highest accepted
   * epoch plus one, read under the row lock this transaction already holds
   * (issue #113). A caller that pre-reads the fence outside that lock hands
   * two creations the same epoch, and the second then raises no fence at
   * all. A supplied value keeps the refusal below, which is how an old
   * owner's write is turned away.
   */
  epoch: bigint | 'next';
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
  /**
   * DEC-49: which attempt of that turn this run is.
   *
   * Absent is the first attempt, which is what every caller that knows of no
   * send-back means, and what every run written before db/031 was. The
   * consumer's sent-back scan names the turn's next one.
   */
  attempt?: number;
  stepsUsed?: number;
  deadlineAt: Date;
  /**
   * DEC-47: the product of the channel this run's message arrived on, copied
   * from the intake row. Absent on a run with no channel — a replay, a
   * caller that files runs directly — which writes null, the same value a
   * message on an unmapped channel records.
   */
  product?: string | null;
}

export interface FencedOutboxInput {
  stepId: string;
  idemKey: string;
  actionClass: string;
  delivery: 'at_least_once' | 'at_most_once';
  payload: unknown;
  /**
   * DEC-44: the reply this record sends when the ledger holds it rather than
   * the helpdesk: `{bodyText, disclosure, provenance}`.
   *
   * Its own field and not part of `payload`, because `payload` is hashed into
   * the idempotency key and DEC-49 rejects a key that folds in the body: an
   * edited reply would then derive a second key and send twice.
   */
  reply?: unknown;
  /**
   * DEC-51: how long this record is held before it may be sent, in
   * milliseconds. Absent is no hold: the draft path, the command line, and
   * every record written before this column existed. The relay skips a
   * pending row whose `not_before` is in the future, and an undo inside that
   * window deletes the row.
   *
   * A duration and not a moment, because the moment is the ledger's. Both
   * readers compare against `clock_timestamp()`, and a caller's own clock
   * would move the window with its host's skew: a console a few seconds
   * behind the ledger would promise twelve seconds and hold none.
   *
   * Its own field and not part of `payload`, because the hold is a timing
   * rather than action semantics (DEC-24): a held send and an immediate send
   * of one action must derive one key.
   */
  holdMs?: number;
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
  // DEC-48: a reviewer closed the case with no reply. Nothing sends for it,
  // so the commit that lands it there stamps the finish and no outbox row
  // follows it.
  'closed',
]);

/**
 * Every status the relay writes on an outbox row, as the db/040 CHECK allows.
 * A reader narrows the column to these, so a status a later migration adds
 * fails where it is read rather than drawing as an unknown word.
 */
export const OUTBOX_STATUSES = ['pending', 'sent', 'fenced', 'delivery_unknown', 'malformed', 'not_sent'] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

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
async function rollbackQuietly(client: PoolClient): Promise<unknown | null> {
  try {
    await client.query('ROLLBACK');
    return null;
  } catch (rollbackError: unknown) {
    // The original error is the one the caller throws, and it is not
    // replaced here. The rollback's own error is returned, because a
    // connection whose rollback failed has a transaction state nobody read,
    // and the caller destroys it rather than returning it to the pool.
    console.error(
      logLine({
        event: 'rollback_failed',
        at: new Date().toISOString(),
        error: errorMessage(rollbackError),
      }),
    );
    return rollbackError;
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
    // DEC-49: which attempt of that turn. Fixed for the same reason: the
    // column is NOT NULL, so the statement always supplies it, and the
    // default in db/031 is a fallback for writers outside this path rather
    // than the value a reader may assume.
    'attempt',
    // DEC-47: the product of the channel the message arrived on. Fixed for
    // the same reason: a run with no product writes null, and every reader
    // of the column — the console's filter, the retrieval scope — has to see
    // that null rather than a column that is sometimes absent from the
    // statement.
    'product',
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
  // Tracked here rather than by the client, which exposes no such state: a
  // release with an error destroys the connection, and releasing twice throws.
  let rollbackError: unknown | null = null;
  try {
    await client.query('BEGIN');
    try {
      // The fence row is materialised first, because `FOR UPDATE` locks no
      // row that is not there. A ticket whose first write is this one has no
      // fence yet, so two concurrent creations would each read no row, each
      // allocate 1, and one of them would raise no fence at all. Zero is the
      // floor the ledger already treats as "no epoch accepted yet", so
      // creating it refuses nothing that was previously accepted. The same
      // two steps open the abandonment path (src/coordinator/consumer.ts) and
      // the enqueue (src/coordinator/intake.ts).
      await client.query(
        'INSERT INTO ticket_epoch (ticket_id, epoch) VALUES ($1, 0) ON CONFLICT DO NOTHING',
        [run.ticketId],
      );
      // Serialize writers on this ticket so the epoch check and the upsert
      // cannot interleave between two concurrent runs.
      const current = await client.query(
        'SELECT epoch FROM ticket_epoch WHERE ticket_id = $1 FOR UPDATE',
        [run.ticketId],
      );
      const highest =
        current.rows.length > 0 ? BigInt(current.rows[0]!.epoch as string) : null;

      // Issue #113: an allocation happens here, under the row lock taken
      // above, so two creations on one ticket cannot take the same epoch.
      // The null arm is unreachable, because this transaction materialised
      // the row above; it stays so the arithmetic needs no assertion.
      // A supplied epoch is subject to the refusal below, which is how an
      // old owner — one whose value was read before the fence moved — is
      // turned away. An allocated one is above the fence by construction.
      const epoch = run.epoch === 'next' ? (highest ?? 0n) + 1n : run.epoch;

      if (highest !== null && epoch < highest) {
        await client.query('ROLLBACK');
        return { outcome: 'stale_epoch', highestAcceptedEpoch: highest };
      }

      await client.query(
        `INSERT INTO ticket_epoch (ticket_id, epoch) VALUES ($1, $2)
         ON CONFLICT (ticket_id) DO UPDATE SET epoch = EXCLUDED.epoch`,
        [run.ticketId, epoch.toString()],
      );

      const values: unknown[] = [
        run.runId,
        run.ticketId,
        run.partition,
        epoch.toString(),
        run.state,
        run.promptVer,
        run.modelVer,
        run.costMicros ?? 0,
        run.stepsUsed ?? 0,
        run.deadlineAt.toISOString(),
        run.enqueuedAt ?? null,
        run.conversationId ?? null,
        run.turnNumber ?? null,
        // DEC-49: the first attempt when the caller names none, which is what
        // every run written before the column existed was.
        run.attempt ?? 1,
        run.product ?? null,
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
           run_id, step_id, idem_key, epoch, action_class, delivery, payload, reply,
           not_before, status
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                   CASE WHEN $9::bigint IS NULL THEN NULL
                        ELSE clock_timestamp() + ($9::bigint * interval '1 millisecond') END,
                   'pending')
         ON CONFLICT (idem_key) DO NOTHING`,
        [
          run.runId,
          outbox.stepId,
          outbox.idemKey,
          epoch.toString(),
          outbox.actionClass,
          outbox.delivery,
          JSON.stringify(outbox.payload),
          outbox.reply === undefined ? null : JSON.stringify(outbox.reply),
          outbox.holdMs ?? null,
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
      rollbackError = await rollbackQuietly(client);
      throw error;
    }
  } finally {
    // A connection whose rollback failed is a connection whose transaction
    // state nobody read. It is destroyed rather than returned to the pool,
    // where the next request would inherit an aborted transaction.
    if (rollbackError === null) client.release();
    else client.release(rollbackError as Error);
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
   * Optional precondition on a value the row itself cannot express, and the
   * last thing checked before anything is written. Returning true refuses the
   * transition: nothing is written, and the caller is handed
   * `{ outcome: 'refused' }`.
   *
   * It is asked inside the transaction, under the row lock, and it is handed
   * the state the row holds — so a caller can compare what it showed a person
   * with what the ledger holds now. DEC-46's shown-text guard is this: the
   * reply a reviewer read, against the reply an approval would send. A
   * comparison made before this transaction has a window between the check
   * and the write, and a comparison made after it has already written.
   */
  refuseIf?: (client: PoolClient, currentState: string) => Promise<boolean>;
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
  | { outcome: 'wrong_state'; currentState: string }
  /**
   * The caller's own precondition refused the write (DEC-46's shown-text
   * guard). The ledger decides nothing here: it reports what the caller
   * answered, and the caller words the refusal.
   */
  | { outcome: 'refused' };

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
  // Tracked here rather than by the client, which exposes no such state: a
  // release with an error destroys the connection, and releasing twice throws.
  let rollbackError: unknown | null = null;
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

      // Issue #113: the fence governs a run a consumer is still walking. A
      // run parked for a person is in no consumer's hands — the walk ended at
      // the park, and the next writer is a person or the clock (DEC-48's
      // returner) — so a fence another run raised says nothing about it. Refusing here stranded the reply: it
      // stayed `awaiting_approval`, every approval bounced, and nothing moved
      // it on. What guards this write instead is the row lock above, the
      // `fromState` it requires, and the DEC-24 key the record carries.
      //
      // Every other state keeps the comparison, including a run that finished
      // and any state this module does not know: `runStateClass` reads those
      // as in flight, so an unknown state is governed rather than licensed.
      //
      // The escape is tied to the write it admits: the caller must require
      // the parked state (`fromState`), and the run must be in it. A caller
      // that names no precondition gets the comparison, so a sweep or a
      // replay inherits the guard. A later reject path that names the parked
      // state inherits the escape, for the reason an approval does: a
      // person's write is not an old owner's write.
      const parkedEscape =
        runStateClass(currentState) === 'parked' && t.fromState === currentState;

      // The fence row is read only where its value can decide something, and
      // a parked write reads nothing. Skipping the read also skips its row
      // lock, and the lock is the reason the read is conditional: a customer's
      // message takes the fence first and then the snoozed runs of that
      // conversation (`endSnoozedIn`, DEC-48), so a parked write that reached
      // for the fence after its own run row closed a cycle with intake and
      // Postgres aborted one of the two. Nothing is compared here, so nothing
      // is lost: `highest` stays null, and the check below cannot fire.
      let highest: bigint | null = null;
      if (!parkedEscape) {
        const current = await client.query(
          'SELECT epoch FROM ticket_epoch WHERE ticket_id = $1 FOR UPDATE',
          [ticketId],
        );
        highest = current.rows.length > 0 ? BigInt(current.rows[0]!.epoch as string) : null;
      }

      if (highest !== null && runEpoch < highest) {
        await client.query('ROLLBACK');
        return { outcome: 'stale_epoch', highestAcceptedEpoch: highest };
      }

      // The caller's own precondition, last and before the first write. The
      // ledger's own checks have already decided whether this caller may
      // write at all; this decides whether the write is about the thing the
      // caller showed a person.
      if (t.refuseIf !== undefined && (await t.refuseIf(client, currentState))) {
        await client.query('ROLLBACK');
        return { outcome: 'refused' };
      }

      // V2 open item 7: a terminal state never changes again, so its commit
      // also stamps the finish time. One transaction, one truth. DEC-51 is
      // the one exception, and it is not this write: an undo inside a held
      // send moves a resolved run back to `awaiting_approval` and clears the
      // finish, in `src/approval/undo.ts`, where the hold is read.
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
             run_id, step_id, idem_key, epoch, action_class, delivery, payload, reply,
             not_before, status
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                     CASE WHEN $9::bigint IS NULL THEN NULL
                          ELSE clock_timestamp() + ($9::bigint * interval '1 millisecond') END,
                     'pending')
           ON CONFLICT (idem_key) DO NOTHING`,
          [
            t.runId,
            t.outbox.stepId,
            t.outbox.idemKey,
            runEpoch.toString(),
            t.outbox.actionClass,
            t.outbox.delivery,
            JSON.stringify(t.outbox.payload),
            t.outbox.reply === undefined ? null : JSON.stringify(t.outbox.reply),
            t.outbox.holdMs ?? null,
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
      rollbackError = await rollbackQuietly(client);
      throw error;
    }
  } finally {
    // A connection whose rollback failed is a connection whose transaction
    // state nobody read. It is destroyed rather than returned to the pool,
    // where the next request would inherit an aborted transaction.
    if (rollbackError === null) client.release();
    else client.release(rollbackError as Error);
  }
}

export interface ResumeStrandedInput {
  /** The walk that found the stranded park. It stops `superseded`. */
  runId: string;
  /** The run whose park holds the draft. It waits for a person again. */
  strandedRunId: string;
  /** The stopping run's totals (DEC-25 bookkeeping), as absolute values. */
  costMicros: number;
  stepsUsed: number;
  /** The stopping run's own record, committed with the two state moves. */
  afterWrite: (client: PoolClient) => Promise<void>;
}

export type ResumeStrandedResult =
  | { outcome: 'resumed' }
  /** The walking run's own lease went stale. Nothing was written. */
  | { outcome: 'stale_epoch'; highestAcceptedEpoch: bigint }
  /**
   * The other run is not stranded: it is on another ticket, it left flight,
   * or its epoch is not below the walking run's. Nothing was written, and the
   * walk parks as it would have.
   */
  | { outcome: 'not_stranded' }
  | { outcome: 'unknown_run' }
  /** The walking run is not in flight, so it is not walking. */
  | { outcome: 'wrong_state'; currentState: string };

/**
 * Hands a turn's draft back to the run that parked it, and stops the walk
 * that found it (#122).
 *
 * Two walks of one message on one ticket can overlap, after a rebalance or a
 * crash retry. The older walk parks a draft in the helpdesk, and then the
 * fence refuses its state move, so its run stays in flight and never waits.
 * The newer walk is the same request (DEC-24), and it holds the fence. So it
 * moves the older run to `awaiting_approval`, where a person approves the
 * draft that run parked, and stops. Every reader then sees one run whose own
 * steps made its own draft.
 *
 * The older run keeps its epoch. A parked run's next writer is a person, and
 * every parked write passes the fence by naming the parked state
 * (`fencedTransition`). Its own walk, if it is still running, stays refused.
 *
 * The locks follow `fencedTransition`'s order: runs first, then the fence.
 * The two runs are locked in id order, so two of these never wait on each
 * other. Intake takes the other order, the fence and then a conversation's
 * snoozed runs (`endSnoozedIn`, DEC-48). So both runs are judged before the
 * fence is taken, and this write waits on the fence only while it holds two
 * runs in flight, which intake never locks.
 */
export async function resumeStrandedRun(
  pool: Pool,
  t: ResumeStrandedInput,
): Promise<ResumeStrandedResult> {
  const client = await pool.connect();
  let rollbackError: unknown | null = null;
  try {
    await client.query('BEGIN');
    try {
      const locked = await client.query<{
        run_id: string; ticket_id: string; epoch: string; state: string;
      }>(
        'SELECT run_id, ticket_id, epoch, state FROM run'
          + ' WHERE run_id = ANY ($1::uuid[]) ORDER BY run_id FOR UPDATE',
        [[t.runId, t.strandedRunId]],
      );
      const walking = locked.rows.find((row) => row.run_id === t.runId);
      const stranded = locked.rows.find((row) => row.run_id === t.strandedRunId);
      if (walking === undefined || stranded === undefined) {
        await client.query('ROLLBACK');
        return { outcome: 'unknown_run' };
      }
      if (runStateClass(walking.state) !== 'in_flight') {
        await client.query('ROLLBACK');
        return { outcome: 'wrong_state', currentState: walking.state };
      }
      const walkingEpoch = BigInt(walking.epoch);
      // Stranded means its own walk can never move it again: another ticket's
      // fence says nothing about it, and a run at this epoch or above may
      // still be walking. Its done park row has no writer left: on a live
      // path, only a run's own park step writes its park row.
      if (
        stranded.ticket_id !== walking.ticket_id
        || runStateClass(stranded.state) !== 'in_flight'
        || BigInt(stranded.epoch) >= walkingEpoch
      ) {
        await client.query('ROLLBACK');
        return { outcome: 'not_stranded' };
      }
      const fence = await client.query(
        'SELECT epoch FROM ticket_epoch WHERE ticket_id = $1 FOR UPDATE',
        [walking.ticket_id],
      );
      const highest = fence.rows.length > 0 ? BigInt(fence.rows[0]!.epoch as string) : null;
      if (highest !== null && walkingEpoch < highest) {
        await client.query('ROLLBACK');
        return { outcome: 'stale_epoch', highestAcceptedEpoch: highest };
      }
      // Its park step finished after its last accepted write, which is the
      // state move the fence refused, so the row's step count is one short.
      await client.query(
        "UPDATE run SET state = 'awaiting_approval', steps_used = steps_used + 1 WHERE run_id = $1",
        [t.strandedRunId],
      );
      await client.query(
        "UPDATE run SET state = 'superseded', cost_micros = $2, steps_used = $3,"
          + ' finished_at = now() WHERE run_id = $1',
        [t.runId, t.costMicros, t.stepsUsed],
      );
      await t.afterWrite(client);
      await client.query('COMMIT');
      return { outcome: 'resumed' };
    } catch (error) {
      rollbackError = await rollbackQuietly(client);
      throw error;
    }
  } finally {
    if (rollbackError === null) client.release();
    else client.release(rollbackError as Error);
  }
}
