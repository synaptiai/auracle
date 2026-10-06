/**
 * The undo inside a held send (DEC-51).
 *
 * A batch confirm sends several replies at once, and a reviewer who confirms
 * by mistake needs a way back. An undo after the send is false — the customer
 * already has the reply — so the send waits for a hold period and this is the
 * way back inside it.
 *
 * What the undo reverses is everything the approval did: the run returns to
 * `awaiting_approval` with no finish time, and the approver, the edit
 * distance, the approved reply text and the outbox row are gone. The row's
 * removal matters as much as the rest: a kept row would hold the DEC-24 key,
 * so a second approval would insert nothing and land the run `superseded` —
 * every effect would remain, in a state nobody could act on.
 *
 * An undo that reports success guarantees that nothing was sent. So the
 * window is checked against the clock read after this transaction holds
 * every lock it takes, the run's and then the turn's, never at transaction
 * start: `now()` is fixed when the transaction begins, and an undo that
 * waited on a lock would recheck with the time it began waiting — and delete
 * a row whose hold ended while it waited. The relay takes the same lock across its send, so a send
 * in flight is serialized against this transaction, and the row it left
 * behind is `sent`, which refuses here.
 */
import type { Pool, PoolClient } from 'pg';

import { errorMessage } from '../errors.js';
import { lockTurnAttempt } from '../ledger/conversation.js';
import { journalStep } from '../ledger/journal-write.js';
import { logLine } from '../log/line.js';
import { approverFrom, type NameSource, sourceOf } from './approver.js';

/**
 * The step id the approval writes its outbox record under. The undo names it
 * so it reads and deletes the record the approval made, and no other row a
 * run may hold.
 */
const APPROVAL_STEP = 'approve';

/**
 * How long the undo waits, in all, for the rows other writers hold.
 *
 * One budget across the three locks it takes, the outbox row, the run and
 * the turn, and not one each: `lock_timeout` bounds each wait on its own, so
 * it is narrowed to what is left before each later lock.
 *
 * The relay holds them across a send, which is bounded by the adapter's
 * timeout — fifteen seconds for FreeScout and the mail adapter's own for
 * mail. This is shorter than either, because the console's answer to a
 * reviewer is worth more than the wait: a page that waited out a send would
 * answer about a reply the relay had already posted. Five seconds is long
 * enough for the relay's own writes, which are the writes that hold these
 * rows in practice.
 */
const LOCK_WAIT_MS = 5_000;

/**
 * Narrows this transaction's lock wait to what is left of the undo's budget.
 *
 * Never zero, because a `lock_timeout` of zero waits for ever. A budget that
 * is spent leaves one millisecond, so the next held lock refuses as busy.
 */
async function narrowWait(client: PoolClient, deadline: number): Promise<void> {
  const left = Math.max(1, Math.ceil(deadline - Date.now()));
  await client.query(`SET LOCAL lock_timeout = '${String(left)}ms'`);
}

/** What one undo did, or why it did nothing. */
export type UndoOutcome =
  | { readonly outcome: 'undone' }
  /** No such run. */
  | { readonly outcome: 'unknown_run' }
  /**
   * The run holds no approval to undo: it is not `resolved`, or its record
   * is gone or was never written. A run still waiting is the ordinary case.
   */
  | { readonly outcome: 'nothing_to_undo' }
  /** The hold period has passed, so the relay may send at any moment. */
  | { readonly outcome: 'window_passed' }
  /** The relay sent it. The customer has the reply, so there is no way back. */
  | { readonly outcome: 'already_sent' }
  /**
   * Something else held the case's row for longer than this console waits.
   * Nothing was undone, and nothing was changed: the reviewer may try again.
   */
  | { readonly outcome: 'busy' };

/**
 * What an approval's record still owes a reviewer: whether its send is held,
 * and for how much longer (DEC-51).
 *
 * A console reads it to draw the undo where a window exists, and to count the
 * window that is left rather than the period that was configured: a batch of
 * six takes seconds, and a page that promised twelve would promise time the
 * ledger no longer holds.
 */
export interface ApprovalHold {
  /** The run's approval record is pending and its moment is still ahead. */
  readonly held: boolean;
  /** Milliseconds until the record may be sent. Zero when it is not held. */
  readonly remainingMs: number;
  /**
   * The approval record's own status, or null for a run the ledger holds no
   * record for (DEC-51).
   *
   * A page reads it to say what became of the send: `pending` is a send still
   * to come, and only `sent` is one that happened.
   */
  readonly status: string | null;
}

/**
 * The hold an approval still has, as the ledger's own clock reads it.
 *
 * Null for a run the ledger does not hold. Not held is not null: a run whose
 * send went, or whose window passed, has an answer too.
 */
export async function readApprovalHold(pool: Pool, runId: string): Promise<ApprovalHold | null> {
  const { rows } = await pool.query(
    `SELECT o.status,
            (o.not_before IS NOT NULL AND o.not_before > clock_timestamp()) AS held,
            COALESCE(EXTRACT(EPOCH FROM (o.not_before - clock_timestamp())) * 1000, 0) AS remaining
       FROM run r
       LEFT JOIN outbox o ON o.run_id = r.run_id AND o.step_id = $2
      WHERE r.run_id = $1`,
    [runId, APPROVAL_STEP],
  );
  const row = rows[0] as { status: string | null; held: boolean | null; remaining: string | null } | undefined;
  if (row === undefined) return null;
  const held = row.status === 'pending' && row.held === true;
  return {
    held,
    remainingMs: held ? Math.max(0, Math.floor(Number(row.remaining ?? 0))) : 0,
    status: row.status,
  };
}

export interface UndoOptions {
  /**
   * DEC-42, DEC-45: who undid it, recorded in the run's journal. The console
   * passes the identity its roster resolved.
   */
  readonly reviewer: string;
  /**
   * DEC-45: how `reviewer` was established, recorded beside it as every other
   * outcome records it. The console says `roster`. Absent reads as a caller's
   * claim, `header`, and a reviewer recorded as `unattributed` reads `none`.
   */
  readonly reviewerSource?: NameSource;
}

/**
 * Reverse one approval, or refuse and say why.
 *
 * One transaction, and the run's row lock from its first statement to its
 * last. Every read and write here is on the same connection for that reason.
 */
export async function undoApproval(
  pool: Pool,
  runId: string,
  options: UndoOptions,
): Promise<UndoOutcome> {
  // The same chokepoint every other writer of a reviewer's name passes through
  // (DEC-42, DEC-45): trimmed, bounded and readable, or `unattributed`.
  const reviewer = approverFrom(options.reviewer);
  const client = await pool.connect();
  // Tracked here rather than by the client: a connection released with an
  // error is destroyed by pg, and releasing it twice throws.
  let released = false;
  try {
    await client.query('BEGIN');
    // The relay holds these rows across a network send. A send is bounded by
    // the adapter's own timeouts, and this bound is the console's own: an
    // undo that waited without one would hold a pool connection and a
    // reviewer's page until the send gave up.
    await client.query(`SET LOCAL lock_timeout = '${LOCK_WAIT_MS}ms'`);
    const deadline = Date.now() + LOCK_WAIT_MS;

    // The approval's own record, and the row the relay and this undo both
    // serialize on. Taken before the run's row, because `parkEscalated`
    // takes the outbox row first: one order for every writer that touches
    // both, or two of them can deadlock.
    const row = await client.query(
      `SELECT status, not_before, reply -> 'bodyText' AS body_text FROM outbox
        WHERE run_id = $1 AND step_id = $2 FOR UPDATE`,
      [runId, APPROVAL_STEP],
    );
    const record = row.rows[0] as {
      status: string;
      not_before: Date | null;
      body_text: string | null;
    } | undefined;
    if (record === undefined) {
      // No approval's record: either the run never had one, or its record
      // was already removed. Both read the same way to a reviewer.
      const run = await client.query('SELECT state FROM run WHERE run_id = $1', [runId]);
      await client.query('ROLLBACK');
      return run.rows.length === 0 ? { outcome: 'unknown_run' } : { outcome: 'nothing_to_undo' };
    }
    await narrowWait(client, deadline);
    const run = await client.query(
      'SELECT state FROM run WHERE run_id = $1 FOR UPDATE',
      [runId],
    );
    if (run.rows.length === 0) {
      await client.query('ROLLBACK');
      return { outcome: 'unknown_run' };
    }
    // Only an approval is undone, and only while the case is resolved. A run
    // a later turn superseded, or one that was closed, is not this window.
    if ((run.rows[0]!.state as string) !== 'resolved') {
      await client.query('ROLLBACK');
      return { outcome: 'nothing_to_undo' };
    }
    if (record.status !== 'pending') {
      // Sent, fenced, malformed, not sent or unknown: something already acted
      // on it.
      await client.query('ROLLBACK');
      return { outcome: 'already_sent' };
    }
    if (record.not_before === null) {
      // No hold was ever taken, so there is no window to be inside.
      await client.query('ROLLBACK');
      return { outcome: 'window_passed' };
    }

    const conversation = await client.query(
      'SELECT conversation_id, turn_number FROM run WHERE run_id = $1',
      [runId],
    );
    const conversationId = conversation.rows[0]?.conversation_id as string | null;
    const turnNumber = conversation.rows[0]?.turn_number as number | null;
    // The turn's lock, after the run's (run, then turn), before the record
    // goes. The consumer's scan reads the turn's reply under the same lock
    // when it ends a waiting run as answered, so it can never record a reply
    // this undo is removing (#122).
    if (conversationId !== null && turnNumber !== null) {
      await narrowWait(client, deadline);
      await lockTurnAttempt(client, { conversationId, turnNumber });
    }

    // The clock after the last lock. Reading it at transaction start, or
    // before a lock this undo then waited on, would let it delete a row
    // whose hold ended while it waited.
    const clock = await client.query<{ now: Date }>('SELECT clock_timestamp() AS now');
    if (clock.rows[0]!.now.getTime() >= record.not_before.getTime()) {
      await client.query('ROLLBACK');
      return { outcome: 'window_passed' };
    }

    // Everything the approval wrote, gone, in one commit with the state move.
    // Only where this approval is what wrote it. More than one run can serve
    // one turn: a retry after a crash, or a send-back. A second run's undo
    // that cleared the column unconditionally would erase the record of a
    // reply the customer already received — DEC-37's record of what the agent
    // said, and the agent half of the next turn's prompt with it.
    if (conversationId !== null && turnNumber !== null && record.body_text !== null) {
      await client.query(
        'UPDATE turn SET approved_reply_text = NULL'
          + ' WHERE conversation_id = $1 AND turn_number = $2 AND approved_reply_text = $3',
        [conversationId, turnNumber, record.body_text],
      );
    }
    // The approval's record alone. A run may hold other rows — the walk
    // writes one for a parked action — and deleting one of those would free
    // a key that a delivered action still holds.
    await client.query(
      'DELETE FROM outbox WHERE run_id = $1 AND step_id = $2',
      [runId, APPROVAL_STEP],
    );
    await client.query(
      'UPDATE run SET state = $2, finished_at = NULL, approved_by = NULL,'
        + ' approved_by_source = NULL, approval_edit_distance = NULL'
        + ' WHERE run_id = $1',
      [runId, 'awaiting_approval'],
    );
    // The case page draws its timeline from the journal, and an undo is a
    // person's decision about text that was about to reach a customer. The
    // row names who, and the step is the ledger's own word for it.
    //
    // Replaced rather than inserted: a reviewer may confirm, undo, confirm
    // again and undo again, and the row has to name the latest person. An
    // insert would raise on the step's primary key and roll the whole undo
    // back, which is the one way this function could refuse a send it can
    // still take back.
    await journalStep(client, {
      runId,
      stepId: 'undo',
      status: 'done',
      result: { reviewer, reviewerSource: sourceOf(reviewer, options.reviewerSource) },
      promptVer: 'console',
      modelVer: 'console',
      costMicros: 0,
    }, { replace: true });
    await client.query('COMMIT');
    return { outcome: 'undone' };
  } catch (error) {
    // A row another writer held past this console's patience is an answer,
    // not a fault: nothing was undone, and the reviewer may try again. The
    // 55P03 code is Postgres's own lock_not_available.
    if ((error as { code?: string }).code === '55P03') {
      // The same treatment as the general arm below: a rollback that fails
      // is reported, and its connection is destroyed rather than returned
      // with its transaction state unread. The answer is `busy` either way —
      // nothing was undone — but the connection must not carry that failure
      // back into the pool.
      let rolledBack = true;
      await client.query('ROLLBACK').catch((rollbackError: unknown) => {
        rolledBack = false;
        console.error(
          logLine({
            event: 'rollback_failed',
            at: new Date().toISOString(),
            runId,
            error: errorMessage(rollbackError),
          }),
        );
      });
      released = true;
      if (rolledBack) client.release();
      else client.release(error as Error);
      return { outcome: 'busy' };
    }
    let rolledBack = true;
    await client.query('ROLLBACK').catch((rollbackError: unknown) => {
      rolledBack = false;
      console.error(
        logLine({
          event: 'rollback_failed',
          at: new Date().toISOString(),
          runId,
          error: errorMessage(rollbackError),
        }),
      );
    });
    // A connection whose rollback failed is a connection whose transaction
    // state nobody read. It is destroyed rather than returned to the pool,
    // where the next request would inherit an aborted transaction.
    if (!rolledBack) {
      // A connection whose rollback failed is a connection whose transaction
      // state nobody read. It is destroyed rather than returned to the pool,
      // where the next request would inherit an aborted transaction.
      released = true;
      client.release(error as Error);
    }
    throw error;
  } finally {
    if (!released) client.release();
  }
}
