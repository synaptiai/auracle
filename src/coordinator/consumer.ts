// Partition consumer (section 4.3, DEC-27, DEC-28) — the runtime half of the
// partition design that no code owned before this module.
//
//   - DEC-27 and DEC-36: the queue is partitioned by hash(conversation_id) %
//     N, or by the ticket id when a run has no conversation, and one consumer
//     owns each partition. This module polls only its assigned partitions, so
//     two runs on one conversation cannot occur together. Two runs on one
//     ticket still can, when one of them carries no conversation and hashes
//     elsewhere; the ticket-keyed fencing epoch covers that case.
//   - DEC-28: every write carries a fencing epoch that only increases per
//     ticket. A pickup asks the ledger for the next one, and the ledger
//     allocates highest + 1 under the ticket row lock, in the insert's own
//     transaction (issue #113). The
//     rebalance procedure (claimPartition) bumps the fence of every ticket
//     whose run is in flight in a partition when ownership moves at
//     deployment, so an old owner still walking one has its writes refused
//     by the fenced ledger path (src/ledger/insert.ts).
//
//     The bump is scoped to runs in flight (issue #113). A run parked for a
//     person and a run that finished are held by no consumer, so no owner is
//     stale with respect to them: their fences stay, their approvals still
//     commit, and the relay still sends their records. `runStateClass` in
//     src/ledger/run-state.ts states which states are which.
//
// There is no lease: the partition gives exclusive access in normal
// operation, the fencing epoch gives safety during a rebalance overlap.
//
// Why the overlap cannot double-process. A fresh run asks the ledger for its
// epoch, and the ledger allocates it under the ticket row lock — highest + 1
// — in the same transaction as the insert (issue #113). Two creations on one
// ticket therefore never share an epoch, and a creation either lands above
// the fence the new owner raised or is refused by it. Equality is still
// accepted for callers that supply a value (a replay, a test), because
// refusing it would break the serialized-writer semantics pinned in
// src/ledger/concurrency.db.test.ts. The window still resolves to a single
// effective owner:
//   - if the new owner picks the still-queued ticket up first, its commit
//     raises the fence above the old run's epoch, and every later hop of the
//     old run — including its outbox insert — is refused mid-run;
//   - if the old run finishes first instead, it acks the ticket and the new
//     owner never polls it.
// Either way at most one run produces external work per ticket, and the
// relay checks the fence at send time for the records of runs still in
// flight (DEC-28: check at insert AND at send).
//
// Known limitation, kept by design: head-of-line delay inside a partition is
// NOT corrected in V1 (V2 open item 7). The poll reads oldest first, so one
// slow ticket delays the ones behind it; it shows up as latency on busy
// partitions.
import type { Pool } from 'pg';

import { coordinateTicket } from './coordinator.js';
import type {
  ConversationTurn,
  CoordinateInput,
  CoordinatorDeps,
} from './coordinator.js';
import { CUSTOMER_REPLY_ACTION_CLASS } from '../adapters/types.js';
import { errorMessage } from '../errors.js';
import type { ArrivalSignal } from './arrival-signal.js';
import { ackTicket, pollPartition } from './intake.js';
import { fencedTransition } from '../ledger/insert.js';
import { TURN_CLOSING_STATUSES, lockTurnAttempt, turnReplyRun } from '../ledger/conversation.js';
import { journalStep } from '../ledger/journal-write.js';
import { unsnoozeExpired } from '../outcomes/snooze.js';
import { embedPendingDocuments } from '../kb/embed-pending.js';
import { PARKED_RUN_STATES, TERMINAL_RUN_STATE_NAMES } from '../ledger/run-state.js';
import { logLine } from '../log/line.js';

/**
 * The rebalance procedure DEC-27 charges as the cost of partitions. At each
 * deployment ownership moves; the new owner calls this once per claimed
 * partition. One transaction bumps the fence of every ticket that holds a
 * run in flight in the partition, so any old owner still walking one fails
 * its next fenced write with stale_epoch. Returns the number of fences
 * bumped.
 *
 * Only an in-flight run is bumped (issue #113). A reply parked for a person
 * and a record whose run has finished are not in flight in any consumer, so
 * no owner is stale with respect to them: raising their fence would refuse
 * an approval a person still has to make, and would drop a record the relay
 * has not sent. `runStateClass` states which states those are.
 *
 * A ticket's fence exists only after its first fenced write, which always
 * also wrote a run row carrying the partition — hence the join through run.
 */
export async function claimPartition(pool: Pool, partition: number): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      // The condition is the predicate's own rule, inverted: everything the
      // module does not read as parked or terminal is in flight, so a state
      // from another release's vocabulary is bumped rather than skipped. The
      // three callers then answer the same way — a run whose state nobody
      // recognises is governed, not licensed.
      const bumped = await client.query(
        `UPDATE ticket_epoch te SET epoch = te.epoch + 1
         WHERE EXISTS (
           SELECT 1 FROM run r
            WHERE r.ticket_id = te.ticket_id
              AND r.partition = $1
              AND NOT (r.state = ANY($2))
         )`,
        [partition, [...PARKED_RUN_STATES, ...TERMINAL_RUN_STATE_NAMES]],
      );
      await client.query('COMMIT');
      return bumped.rowCount ?? 0;
    } catch (error) {
      // The rollback must not replace the diagnosis. When the connection is
      // what failed, this statement throws a generic transport error and it
      // is the one that reaches the operator, in place of the cause. It is
      // demoted rather than discarded: the pool destroys a client whose
      // transport failed, so the cost is diagnostics and nothing else.
      await client.query('ROLLBACK').catch((rollbackError: unknown) => {
        console.error(
          logLine({
            event: 'rollback_failed',
            at: new Date().toISOString(),
            error: errorMessage(rollbackError),
          }),
        );
      });
      throw error;
    }
  } finally {
    client.release();
  }
}

/** Action semantics applied to tickets this consumer processes. */
export interface ConsumerActionSpec {
  actionClass: string;
  actionPayload: Record<string, unknown>;
  delivery: 'at_least_once' | 'at_most_once';
  /** DEC-12: true for customer replies, which always gate. */
  isCustomerVisible: boolean;
  /** DEC-14: the adopter's disclosure text attached to every gated reply. */
  disclosure: string;
}

export interface ConsumerOptions {
  /** DEC-27: the partitions this consumer owns. Must be disjoint across consumers. */
  readonly partitions: readonly number[];
  readonly intervalMs: number;
  readonly action: ConsumerActionSpec;
  readonly scanBatchSize?: number;
  /** Overrides MAX_INTAKE_ATTEMPTS. Tests set it low; operators may lower it. */
  readonly maxIntakeAttempts?: number;
  /**
   * Issue #25: an arrival signal, so the loop stops sleeping through a
   * message that landed just after a scan. Optional, and omitting it gives
   * the loop that shipped before: `intervalMs` alone.
   *
   * The signal is an optimisation and never an authority. The queued row is
   * the authority, and `intervalMs` still bounds the wait when a
   * notification is lost — so the worst a broken signal costs is the latency
   * the system had without it.
   */
  readonly signal?: ArrivalSignal;
}

export type ConsumerScanOutcome =
  | { ticketId: string; outcome: Awaited<ReturnType<typeof coordinateTicket>>['outcome'] }
  | { ticketId: string; outcome: 'error'; error: string }
  /** The message failed MAX_INTAKE_ATTEMPTS times and left the queue. */
  | { ticketId: string; outcome: 'abandoned'; error: string }
  /**
   * Another owner claimed the same message during a rebalance and filed the
   * abandonment. This scan did nothing. Reporting 'abandoned' here counted one
   * message as two, which is the same overstatement the single filed run
   * exists to prevent.
   */
  | { ticketId: string; outcome: 'not_claimed' };

/**
 * How long `stop()` waits for the arrival signal to release its connection
 * before it gives up and moves on to the drain.
 */
const SIGNAL_STOP_BUDGET_MS = 2000;

/**
 * Failed attempts a queued message gets before it leaves the queue.
 *
 * The counter is per message and never resets, so this must be high enough
 * that a shared outage does not empty the queue. Five consecutive scans is a
 * few minutes of a provider being down, and every queued message fails on
 * every one of those scans — so a low bound abandons the whole backlog for a
 * fault that had nothing to do with any single message.
 */
export const MAX_INTAKE_ATTEMPTS = 50;

/**
 * Failed attempts of one turn a consumer walks before it stops and escalates.
 *
 * The poll's ceiling is fifty because its messages wait in a queue and a
 * shared outage must not empty it. A re-attempt is not queued: a reviewer is
 * waiting for it, and each try costs a classifier sample, a retrieval and a
 * composition. Five consecutive walks of one turn failing is a fault that a
 * sixth will not clear, so the sixth is not run — the turn is escalated with
 * the failure named, and a person decides.
 */
export const MAX_ATTEMPT_FAILURES = 5;

/**
 * Requests one scan serves, so a backlog of turns cannot hold up the queue.
 *
 * A re-attempt is a whole walk with the provider in it. The poll's own batch
 * is what bounds the messages beside it, and without a bound here a busy day
 * of send-backs would put every queued message of the partition behind them.
 */
export const SEND_BACK_BATCH = 10;

/** Counts one failed attempt and returns the new total. */
async function recordAttempt(pool: Pool, ticketId: string, messageId: string): Promise<number> {
  const row = await pool.query<{ attempts: number }>(
    `UPDATE intake SET attempts = attempts + 1
      WHERE ticket_id = $1 AND message_id = $2
      RETURNING attempts`,
    [ticketId, messageId],
  );
  // No row means the message left the queue by another path; treat it as
  // handled rather than inventing an attempt count for a row that is gone.
  return row.rows[0]?.attempts ?? 0;
}

/**
 * Takes a message out of the queue and files an escalated run for it.
 *
 * The run is what an operator sees: `pnpm run escalations` lists it, and the
 * reason names the failure. Dropping the row alone would lose the message
 * silently, which is the failure this whole path exists to prevent.
 */
/**
 * Files the abandonment, and reports whether this caller was the one to file
 * it. Two owners can reach here for one message; only the owner that deletes
 * the intake row files, so only that owner may report an abandonment.
 */
async function abandonMessage(
  pool: Pool,
  attempts: number,
  polled: {
    ticketId: string;
    messageId: string;
    partition: number;
    conversationId: string | null;
    /** DEC-35: the turn this message was, when the intake row recorded one. */
    turnNumber: number | null;
    /** DEC-47: the product recorded at arrival, which this run inherits. */
    product: string | null;
    /**
     * DEC-49: the attempt the failing walks were at, read when the message was
     * polled. Not the turn's attempt now: a reviewer may have sent the case
     * back while the walk was failing, and an abandonment filed at the new
     * attempt would land it — the scan would then read the requested attempt
     * as served, and the note would reach no composer.
     */
    currentAttempt: number | null;
  },
  reason: string,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // DEC-28: this write carries an epoch, and it takes the ticket's current
    // fence rather than a literal zero. Zero is below every live fence, so
    // the ledger's own insert path would refuse it, and two owners racing
    // during a rebalance could each file an abandonment for one message.
    //
    // The fence is read FOR UPDATE and is not advanced. Advancing it would
    // fence out a run still in flight on this ticket, and abandoning an
    // intake row is not a claim on the ticket.
    // The row is materialised first. `FOR UPDATE` on a ticket that has no
    // fence row locks nothing, and a message abandoned before any pickup is
    // exactly the case with no row — so the lock that serialises two owners
    // would have been absent precisely when it was needed. Zero is the floor
    // the ledger already treats as "no epoch accepted yet", so creating it
    // refuses nothing that was previously accepted.
    await client.query(
      'INSERT INTO ticket_epoch (ticket_id, epoch) VALUES ($1, 0) ON CONFLICT DO NOTHING',
      [polled.ticketId],
    );
    const fence = await client.query<{ epoch: string }>(
      'SELECT epoch::text AS epoch FROM ticket_epoch WHERE ticket_id = $1 FOR UPDATE',
      [polled.ticketId],
    );
    const epoch = fence.rows[0]?.epoch ?? '0';
    // The intake row is the token. Two owners can poll one message during a
    // rebalance — the poll takes no claim — and both can reach the ceiling,
    // so serialising on the fence alone still let both file: they write at
    // equal epochs, which the ledger accepts, and `run` has no unique
    // constraint on (ticket_id, epoch). Whoever deletes the row files the
    // run; the loser deletes nothing and files nothing.
    //
    // Covered: two scans started together on one partition at a ceiling of
    // one, repeated, counting the runs filed for the message. With the
    // DELETE moved back after the inserts the count reaches two. An earlier
    // comment here claimed a test for this passed with the guard removed;
    // that was wrong, and it left the guard shipping with no cover.
    const claimed = await client.query(
      'DELETE FROM intake WHERE ticket_id = $1 AND message_id = $2',
      [polled.ticketId, polled.messageId],
    );
    if (claimed.rowCount === 0) {
      await client.query('COMMIT');
      return false;
    }
    const run = await client.query<{ run_id: string }>(
      `INSERT INTO run (run_id, ticket_id, partition, epoch, state,
                        prompt_ver, model_ver, deadline_at, finished_at,
                        conversation_id, turn_number, product, attempt)
       VALUES (gen_random_uuid(), $1, $2, $4, 'escalated',
               'intake', 'intake', now(), now(), $3, $5, $6,
               -- DEC-49: at the attempt the failing walks were at. A message
               -- with no turn is on the first attempt.
               $7)
       RETURNING run_id`,
      // DEC-35: the turn this abandoned message was. Without it the run that
      // records an abandoned turn is the one run a conversation surface
      // cannot join to its turn — which is the turn an operator most needs to
      // trace, because it is the one the system gave up on.
      //
      // DEC-47: the abandonment is a run like any other, and it is the run an
      // operator reads when a message went unanswered. The product comes from
      // the queue row this call is deleting, so this is the last moment it
      // can be recorded.
      [
        polled.ticketId,
        polled.partition,
        polled.conversationId,
        epoch,
        polled.turnNumber,
        polled.product,
        polled.currentAttempt ?? 1,
      ],
    );
    // The escalations view reads its reason from this step, so the operator
    // sees why the message was abandoned and not merely that it vanished.
    // Bound and checked rather than cast. The insert above is
    // `INSERT ... RETURNING run_id`, so it always yields a row and this
    // never throws; a cast would instead tell the shared helper's signature
    // that a `string | undefined` is a string, and silence the next caller
    // for whom that is false.
    const abandonedRunId: unknown = run.rows[0]?.run_id;
    if (typeof abandonedRunId !== 'string') {
      throw new Error(`the abandonment insert for ${polled.ticketId} returned no run id`);
    }
    await journalStep(client, {
      runId: abandonedRunId,
      stepId: 'escalate',
      status: 'done',
      result: { reason: `intake_abandoned after ${attempts} attempts: ${reason}` },
      // Not a model step: 'intake' names what wrote the row, because the
      // pins are NOT NULL and a run abandoned in the queue ran no model.
      promptVer: 'intake',
      modelVer: 'intake',
      costMicros: 0,
    });
    await client.query('COMMIT');
    return true;
  } catch (error) {
    // As above: a rollback that throws must not replace the cause, and is
    // reported rather than dropped.
    await client.query('ROLLBACK').catch((rollbackError: unknown) => {
      console.error(
        logLine({
          event: 'rollback_failed',
          at: new Date().toISOString(),
          error: errorMessage(rollbackError),
        }),
      );
    });
    throw error;
  } finally {
    client.release();
  }
}

/**
 * The turns of one conversation before the turn being processed.
 *
 * Text comes from the turn itself (DEC-37). It used to come from the queue
 * row, which the ack deletes, so every earlier turn contributed nothing and
 * the prompts saw an empty history in every ordinary path.
 *
 * One turn yields the customer's message and, when a person approved one,
 * the reply that answered it. Either may be absent: a turn recorded before
 * db/010 holds no message text, and a turn that produced no customer reply
 * holds none either. An absent half is skipped rather than rendered blank.
 *
 * History is best-effort context, never evidence, and the groundedness gate
 * never reads it.
 */
export async function conversationHistory(
  pool: Pool,
  conversationId: string | null,
  turnNumber: number | null,
): Promise<readonly ConversationTurn[]> {
  if (conversationId === null || turnNumber === null) return [];
  const rows = await pool.query<{
    turn_number: number;
    body_text: string | null;
    approved_reply_text: string | null;
  }>(
    `SELECT turn_number, body_text, approved_reply_text
       FROM turn
      WHERE conversation_id = $1
        AND turn_number < $2
      ORDER BY turn_number`,
    [conversationId, turnNumber],
  );

  const history: ConversationTurn[] = [];
  for (const row of rows.rows) {
    // The customer speaks first within a turn, and the reply answers it.
    if (row.body_text !== null) {
      history.push({
        turnNumber: row.turn_number,
        author: 'customer',
        bodyText: row.body_text,
      });
    }
    if (row.approved_reply_text !== null) {
      history.push({
        turnNumber: row.turn_number,
        author: 'agent',
        bodyText: row.approved_reply_text,
      });
    }
  }
  return history;
}

/** The states a run can be in once its walk has ended: parked or terminal. */
const LANDED_STATES: readonly string[] = [...PARKED_RUN_STATES, ...TERMINAL_RUN_STATE_NAMES];

/** One turn a reviewer sent back, as the scan reads it. */
interface SentBackTurn {
  ticketId: string;
  partition: number;
  conversationId: string;
  turnNumber: number;
  /** The attempt the turn is on: the one the send-back asked for (db/033). */
  attempt: number;
  /** The run that was sent back, which the log names. */
  sentBackRunId: string;
  note: string | null;
  product: string | null;
  bodyText: string | null;
  customerAddress: string | null;
}

/**
 * Files the run an operator reads when a turn's requested attempt will not
 * be walked: its attempts kept dying, its question is gone, or its reply
 * already went out.
 *
 * A fresh run, at the ticket's current fence, in the shape `abandonMessage`
 * uses: the row is written under the fence's row lock, so no later run on the
 * ticket can refuse it, and the journal row names what happened. It lands at
 * the turn's attempt, so it is the landed run that ends the request — the
 * scan does not read the turn again. The dead attempts are left where they
 * are, with their own spend and step counts.
 *
 * Returns the run id an operator reads, or null when another owner already
 * landed the attempt.
 */
async function fileSendBackEnd(
  pool: Pool,
  turn: SentBackTurn,
  reason: string,
  options: { removeHeld: boolean } = { removeHeld: true },
): Promise<string | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // The fence row is materialised first: `FOR UPDATE` locks no row that is
    // not there. Zero is the floor the ledger already treats as "no epoch
    // accepted yet".
    await client.query(
      'INSERT INTO ticket_epoch (ticket_id, epoch) VALUES ($1, 0) ON CONFLICT DO NOTHING',
      [turn.ticketId],
    );
    const fence = await client.query<{ epoch: string }>(
      'SELECT epoch::text AS epoch FROM ticket_epoch WHERE ticket_id = $1 FOR UPDATE',
      [turn.ticketId],
    );
    const epoch = fence.rows[0]?.epoch ?? '0';
    // The request read again before anything is filed. Two owners can both
    // reach here during a rebalance overlap. The fence's row lock above is
    // what serialises them — both take it for one ticket — and the first to
    // commit lands the attempt, so the second finds it landed and files
    // nothing. The turn's lock is taken as well, after the fence's (the order
    // intake follows), so that no writer of the turn can change it between
    // the read and the insert.
    await client.query(
      'SELECT attempt FROM turn WHERE conversation_id = $1 AND turn_number = $2 FOR UPDATE',
      [turn.conversationId, turn.turnNumber],
    );
    const landed = await client.query(
      `SELECT 1 FROM run
        WHERE conversation_id = $1 AND turn_number = $2 AND attempt >= $3
          AND state = ANY ($4::text[])
        LIMIT 1`,
      [turn.conversationId, turn.turnNumber, turn.attempt, LANDED_STATES],
    );
    if (landed.rows.length > 0) {
      await client.query('COMMIT');
      return null;
    }
    const run = await client.query<{ run_id: string }>(
      `INSERT INTO run (run_id, ticket_id, partition, epoch, state,
                        prompt_ver, model_ver, deadline_at, finished_at,
                        conversation_id, turn_number, attempt, product)
       VALUES (gen_random_uuid(), $1, $2, $3, 'escalated',
               'intake', 'intake', now(), now(), $4, $5, $6, $7)
       RETURNING run_id`,
      [
        turn.ticketId, turn.partition, epoch, turn.conversationId,
        turn.turnNumber, turn.attempt, turn.product,
      ],
    );
    const filed: unknown = run.rows[0]?.run_id;
    if (typeof filed !== 'string') {
      throw new Error(`the send-back escalation for ${turn.ticketId} returned no run id`);
    }
    // The queue holds this turn's messages while its attempt is due, and the
    // run filed above lands the attempt — which is what releases them. A
    // message released here would walk the attempt this function exists to
    // stop: a turn whose reply went out, a turn with no question, or a turn
    // whose attempts keep dying. So they leave the queue with it. Each is a
    // redelivery of the message the turn already records, and the escalation
    // is the answer an operator reads for it.
    //
    // Scoped to this turn and nothing wider: another turn of the conversation
    // is another message the customer sent. The count is journalled, and the
    // text is not: it is the customer's, and the turn holds it — which is why
    // a turn with no text keeps its held messages (`removeHeld: false`).
    const removed = options.removeHeld
      ? await client.query(
        'DELETE FROM intake WHERE conversation_id = $1 AND turn_number = $2',
        [turn.conversationId, turn.turnNumber],
      )
      : { rowCount: 0 };
    await journalStep(client, {
      runId: filed,
      stepId: 'escalate',
      status: 'done',
      result: { reason, heldMessagesRemoved: removed.rowCount ?? 0 },
      promptVer: 'intake',
      modelVer: 'intake',
      costMicros: 0,
    });
    await client.query('COMMIT');
    return filed;
  } catch (error) {
    await client.query('ROLLBACK').catch((rollbackError: unknown) => {
      console.error(
        logLine({
          event: 'rollback_failed',
          at: new Date().toISOString(),
          error: errorMessage(rollbackError),
        }),
      );
    });
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Ends the waiting runs that can never be approved (DEC-49): those of an
 * attempt a reviewer rejected, and a reply on a turn that already holds one.
 *
 * Two runs of one turn can wait at one attempt: a message redelivered after
 * its ack joins the attempt its turn is on. A reviewer who sends one of them
 * back rejects the attempt, and the other still waits with the same reply.
 * The approval, the save and the rewrite already refuse it, because the turn
 * is on a later attempt; this takes it out of the queue as well.
 *
 * The send-back does not do this itself. It holds its own run's lock and then
 * the turn's, and ending a sibling would take a third lock another writer may
 * hold in the opposite order. Here each run is moved in a transaction of its
 * own, under its own lock alone, and a run a person already moved is skipped
 * by the state it requires.
 *
 * Returns the runs it ended.
 */
async function endRejectedAttempts(
  pool: Pool,
  partitions: readonly number[],
): Promise<string[]> {
  const stale = await pool.query<{
    run_id: string; state: string; cost_micros: number; steps_used: number;
    prompt_ver: string; model_ver: string; rejected: boolean;
    conversation_id: string; turn_number: number;
  }>(
    `SELECT r.run_id, r.state, r.cost_micros, r.steps_used, r.prompt_ver, r.model_ver,
            r.conversation_id, r.turn_number, r.attempt < t.attempt AS rejected
       FROM run r
       JOIN turn t
         ON t.conversation_id = r.conversation_id AND t.turn_number = r.turn_number
      WHERE r.partition = ANY ($1::int[])
        AND r.state IN ('awaiting_approval', 'snoozed')
        AND (r.attempt < t.attempt
             -- A waiting reply on a turn that already holds a reply: the
             -- approval refuses it, so it can never go out. Twin runs of one
             -- attempt reach this when the other is approved first.
             -- A reply is a park that names a draft, or the reply's action
             -- class parked in the ledger alone: the park step's own test.
             OR (EXISTS (SELECT 1 FROM step_journal park
                          WHERE park.run_id = r.run_id AND park.step_id = 'park'
                            AND (park.result ? 'draftExternalId'
                                 OR park.result->>'actionClass' = $3))
                 AND EXISTS (SELECT 1 FROM outbox o JOIN run other ON other.run_id = o.run_id
                              WHERE other.conversation_id = r.conversation_id
                                AND other.turn_number = r.turn_number
                                AND o.payload ? 'draftExternalId'
                                AND o.status = ANY ($2::text[]))))`,
    [partitions, [...TURN_CLOSING_STATUSES], CUSTOMER_REPLY_ACTION_CLASS],
  );
  const ended: string[] = [];
  for (const row of stale.rows) {
    let moved;
    try {
      moved = await fencedTransition(pool, {
        runId: row.run_id,
        state: 'superseded',
        costMicros: row.cost_micros,
        stepsUsed: row.steps_used,
        fromState: row.state,
        // Why, on the run's own record, so a reviewer who opens it reads the
        // reason rather than a bare state (#122). A turn answered by another
        // run names that run, read in this commit.
        afterWrite: async (client) => {
          // The runs were chosen before this commit. An undo inside a held
          // send can delete the record that closed the turn in between, and
          // the turn is open again: the run is not ended, and no reason that
          // this commit disproves is written. The turn's lock, after this
          // run's (run, then turn), orders the read against an undo, which
          // takes the same lock before it deletes a record.
          const turn = { conversationId: row.conversation_id, turnNumber: row.turn_number };
          const answeredBy = row.rejected
            ? null
            : await lockTurnAttempt(client, turn).then(() => turnReplyRun(client, turn));
          if (!row.rejected && answeredBy === null) throw new TurnReopened();
          await journalStep(client, {
            runId: row.run_id,
            stepId: 'supersede',
            status: 'done',
            result: row.rejected
              ? { reason: 'attempt_rejected' }
              : { reason: 'turn_answered', answeredBy },
            promptVer: row.prompt_ver,
            modelVer: row.model_ver,
            costMicros: row.cost_micros,
          });
        },
      });
    } catch (error) {
      // One run's fault is that run's alone. The runs before it are already
      // committed, each in its own transaction, and the runs after it are
      // owed their pass, so the fault is logged and the scan goes on.
      console.error(
        logLine({
          event: error instanceof TurnReopened ? 'answered_run_kept' : 'waiting_run_end_failed',
          at: new Date().toISOString(),
          runId: row.run_id,
          reason: row.rejected ? 'attempt_rejected' : 'turn_answered',
          ...(error instanceof TurnReopened ? {} : { error: errorMessage(error) }),
        }),
      );
      continue;
    }
    if (moved.outcome === 'accepted') ended.push(row.run_id);
  }
  return ended;
}

/** A turn the scan chose as answered, open again by the time it commits. */
class TurnReopened extends Error {
  constructor() {
    super('the turn is open again');
  }
}

/**
 * Starts the attempt a reviewer's send-back asked for (DEC-49).
 *
 * The console cannot walk the state machine, so `sendBackRun` ends the
 * rejected run, records the note and raises the turn's attempt. This is the
 * other half: the consumer that owns the conversation's partition starts the
 * attempt the turn is now on. The shape is `unsnoozeExpired`'s — a scan over
 * this consumer's own partitions, on every pass.
 *
 * What makes a turn due, and what clears it. The turn is on an attempt above
 * the first, and no run at that attempt has landed. The attempt is
 * `turn.attempt` (db/033), which only a send-back raises, so every writer
 * reads one number and nothing here counts runs to decide it. A run of that
 * attempt that lands — parked for a person, or ended — clears the request,
 * and a crash between the read and the landing leaves it due for the next
 * scan.
 *
 * The queue holds a message whose turn is due (`pollPartition`), so the run
 * that takes the attempt is the one started here, and it reads the note.
 *
 * An attempt whose walk throws leaves a run in an active state with nobody
 * walking it. The request stays due, and the next scan retries the same
 * attempt — a crash retry stays in its attempt, so its keys are the keys the
 * dead one derived (DEC-49). `MAX_ATTEMPT_FAILURES` bounds the retries. At the
 * bound the turn is escalated with the failure named, and it stops there.
 *
 * Two more ways a request ends without a walk. A turn whose text is gone has
 * no question to answer, and the note is not one (DEC-37). And a turn with a
 * record that closes it is answered already. The send-back refuses such a
 * turn, and every approval of a rejected attempt is refused, so the console
 * cannot write one after the request; this is the guard for a record another
 * path writes — a run of the conversation with no turn, a seed, a replay. A
 * new attempt there would put a second reply on the wire. Both are escalated,
 * so the case reaches a person who sees why, and the turn's held messages
 * leave the queue with the escalation rather than walking the attempt it
 * stopped.
 *
 * The re-attempt walks the machine from the top, with the note. It is not a
 * replay: it classifies, retrieves and composes again, because the request
 * exists because the answer was wrong. Its keys carry the new attempt, so the
 * adapter does not hand it the draft the reviewer rejected.
 */
export async function startSentBackAttempts(
  deps: CoordinatorDeps,
  options: ConsumerOptions,
): Promise<string[]> {
  if (options.partitions.length === 0) return [];

  // The rejected attempts' siblings leave the queue first. A fault here is
  // logged and the scan goes on: the approval already refuses those runs, so
  // leaving one a pass longer costs a row in the queue and nothing else.
  try {
    const ended = await endRejectedAttempts(deps.pool, options.partitions);
    if (ended.length > 0) {
      console.error(
        logLine({
          event: 'rejected_attempts_ended',
          at: new Date().toISOString(),
          count: ended.length,
        }),
      );
    }
  } catch (error) {
    console.error(
      logLine({
        event: 'rejected_attempts_end_failed',
        at: new Date().toISOString(),
        error: errorMessage(error),
      }),
    );
  }

  // Read outside any transaction: each attempt below takes its own locks, and
  // holding one here would hold it across every turn in the list.
  const due = await deps.pool.query<{
    ticket_id: string;
    partition: number;
    conversation_id: string;
    turn_number: number;
    attempt: number;
    sent_back_run_id: string;
    note: string | null;
    product: string | null;
    body_text: string | null;
    customer_address: string | null;
    reached: boolean;
  }>(
    `SELECT sb.ticket_id, sb.partition, t.conversation_id, t.turn_number, t.attempt,
            sb.run_id AS sent_back_run_id, sb.send_back_note AS note, sb.product,
            -- The customer's words: the turn's, or a held redelivery's when
            -- the turn holds none (a turn recorded before db/010). Either way
            -- the attempt the reviewer asked for walks with the question and
            -- the note together.
            COALESCE(NULLIF(btrim(t.body_text), ''), (
              SELECT held.ticket_text FROM intake held
               WHERE held.conversation_id = t.conversation_id
                 AND held.turn_number = t.turn_number
                 AND btrim(held.ticket_text) <> ''
               ORDER BY held.enqueued_at LIMIT 1)) AS body_text,
            c.customer_address,
            EXISTS (
              SELECT 1 FROM outbox o JOIN run r ON r.run_id = o.run_id
               WHERE r.conversation_id = t.conversation_id
                 AND r.turn_number = t.turn_number
                 AND o.status = ANY ($4::text[])) AS reached
       FROM turn t
       JOIN LATERAL (
              SELECT run_id, ticket_id, partition, send_back_note, product
                FROM run
               WHERE conversation_id = t.conversation_id
                 AND turn_number = t.turn_number
                 AND sent_back_at IS NOT NULL
               ORDER BY attempt DESC, sent_back_at DESC
               LIMIT 1
            ) sb ON true
       LEFT JOIN conversation c ON c.conversation_id = t.conversation_id
      WHERE t.attempt > 1
        AND sb.partition = ANY ($1::int[])
        AND NOT EXISTS (
              SELECT 1 FROM run landed
               WHERE landed.conversation_id = t.conversation_id
                 AND landed.turn_number = t.turn_number
                 AND landed.attempt >= t.attempt
                 AND landed.state = ANY ($2::text[]))
      -- Bounded per scan, so a backlog of turns cannot hold up the queue the
      -- scan also polls.
      ORDER BY t.turn_number, t.conversation_id
      LIMIT $3`,
    [
      options.partitions,
      LANDED_STATES,
      options.scanBatchSize ?? SEND_BACK_BATCH,
      [...TURN_CLOSING_STATUSES],
    ],
  );

  const started: string[] = [];
  for (const row of due.rows) {
    const turn: SentBackTurn = {
      ticketId: row.ticket_id,
      partition: row.partition,
      conversationId: row.conversation_id,
      turnNumber: row.turn_number,
      attempt: Number(row.attempt),
      sentBackRunId: row.sent_back_run_id,
      note: row.note,
      product: row.product,
      bodyText: row.body_text,
      customerAddress: row.customer_address,
    };

    // Per turn, and never out of this function. The scan runs beside the
    // queue, and a turn that threw here would otherwise stop every other turn
    // of these partitions from being looked at. The failure is logged, the
    // request stands, and the next scan retries it.
    try {
      const ended = await endWithoutAWalk(deps, turn, row.reached);
      if (ended !== null) {
        console.error(
          logLine({
            event: 'send_back_ended',
            at: new Date().toISOString(),
            runId: turn.sentBackRunId,
            escalatedRunId: ended.runId,
            reason: ended.reason,
          }),
        );
        continue;
      }

      // DEC-49: the attempt the turn is on, and the note that asked for it.
      const outcome = await coordinateTicket(deps, {
        ticketId: turn.ticketId,
        ticketText: turn.bodyText ?? '',
        // DEC-28: the ledger allocates the fence under the ticket's row lock,
        // in the insert this walks into.
        epoch: 'next',
        partition: turn.partition,
        conversationId: turn.conversationId,
        customerAddress: turn.customerAddress,
        turnNumber: turn.turnNumber,
        // DEC-47: the product the run recorded at arrival, so the new attempt
        // retrieves the documents of the same product.
        ...(turn.product === null ? {} : { product: turn.product }),
        attempt: turn.attempt,
        ...(turn.note === null ? {} : { note: turn.note }),
        // The turns before this one, exactly as the first attempt read them.
        history: await conversationHistory(deps.pool, turn.conversationId, turn.turnNumber),
        ...options.action,
      });
      if (outcome.outcome !== 'stale_epoch') started.push(outcome.runId);
    } catch (error) {
      console.error(
        logLine({
          event: 'send_back_attempt_failed',
          at: new Date().toISOString(),
          runId: turn.sentBackRunId,
          error: errorMessage(error),
        }),
      );
    }
  }
  return started;
}

/**
 * Ends a request that must not be walked, or answers null.
 *
 * Three reasons, checked in the order an operator would want them named: a
 * record that closes the turn, a turn with no question, and an attempt that
 * has died `MAX_ATTEMPT_FAILURES` times. The run id is null when another owner
 * landed the attempt first, which ends the request just the same.
 */
async function endWithoutAWalk(
  deps: CoordinatorDeps,
  turn: SentBackTurn,
  reached: boolean,
): Promise<{ runId: string | null; reason: string } | null> {
  if (reached) {
    const reason = `send_back_dropped on turn ${String(turn.turnNumber)}:`
      + ' a reply on this turn may already have reached the customer';
    return { runId: await fileSendBackEnd(deps.pool, turn, reason), reason };
  }
  if (turn.bodyText === null || turn.bodyText.trim().length === 0) {
    const reason = `send_back_no_question on turn ${String(turn.turnNumber)}:`
      + ' the turn holds no question';
    // No held message has text either — the scan reads a held redelivery's
    // words when the turn holds none. The held messages stay queued: they are
    // the only copy the queue has, and removing them would lose them.
    return {
      runId: await fileSendBackEnd(deps.pool, turn, reason, { removeHeld: false }),
      reason,
    };
  }
  // An attempt still in flight when this scan reads it died on its way
  // through the walk: nothing else walks a turn that is due, because the
  // queue holds its messages. Within a scan it is unambiguous, since scans
  // never overlap.
  const dead = await deps.pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM run
      WHERE conversation_id = $1 AND turn_number = $2 AND attempt = $3
        AND NOT (state = ANY ($4::text[]))`,
    [turn.conversationId, turn.turnNumber, turn.attempt, LANDED_STATES],
  );
  const failures = Number(dead.rows[0]?.n ?? 0);
  if (failures >= MAX_ATTEMPT_FAILURES) {
    const reason = `send_back_failed after ${String(failures)} attempts of turn`
      + ` ${String(turn.turnNumber)}`;
    return { runId: await fileSendBackEnd(deps.pool, turn, reason), reason };
  }
  return null;
}

/**
 * Runs one scan over the consumer's partitions: poll, then drive
 * coordinateTicket per ticket with a fresh fencing epoch. A ticket that
 * reaches any completed outcome is acked out of the queue. A ticket refused
 * as stale_epoch — another owner took the partition during a rebalance —
 * stays queued, so the new owner redoes the refused work on its next scan;
 * acking it here would drop the ticket with nobody to pick it up. A ticket
 * whose processing throws also stays queued; the rest of the scan continues.
 */
export async function processQueuedTickets(
  deps: CoordinatorDeps,
  options: ConsumerOptions,
): Promise<ConsumerScanOutcome[]> {
  // DEC-48: a snoozed case whose period has ended goes back to the approval
  // queue on every scan, so the console offers it again within one interval. The partitions are this consumer's own, and a snoozed run
  // shares its conversation's partition, so the case returned here is one
  // this consumer owns. A case the customer already superseded is not
  // `snoozed` any more, and the return skips it.
  //
  // A fault here is the clock's, not the poll's, and the poll is this
  // function's job: the case stays due and is returned on the next scan,
  // while a scan that threw would leave every queued message of these
  // partitions untouched. The abandonment path below guards itself for the
  // same reason.
  let returned: string[] = [];
  try {
    returned = await unsnoozeExpired(deps.pool, options.partitions);
  } catch (error) {
    console.error(
      logLine({
        event: 'snoozes_return_failed',
        at: new Date().toISOString(),
        error: errorMessage(error),
      }),
    );
  }
  if (returned.length > 0) {
    console.error(
      logLine({
        event: 'snoozes_returned',
        at: new Date().toISOString(),
        count: returned.length,
      }),
    );
  }

  const results: ConsumerScanOutcome[] = [];
  const batch =
    options.scanBatchSize ??
    Number.MAX_SAFE_INTEGER;
  for (const polled of await pollPartition(deps.pool, options.partitions, batch)) {
    try {
      const input: CoordinateInput = {
        ticketId: polled.ticketId,
        ticketText: polled.ticketText,
        // The ledger allocates this one, under the ticket row lock it takes
        // for the insert (issue #113). A value read here could go stale in
        // the window before that lock.
        epoch: 'next',
        // Open item 7: the arrival time rides from intake to the run row,
        // so queue wait survives the ack that follows.
        enqueuedAt: polled.enqueuedAt,
        // DEC-28: the run records the partition the message was filed under,
        // never one recomputed from this process's PARTITION_COUNT.
        partition: polled.partition,
        // DEC-35: the conversation, its participant, and the turns before this.
        conversationId: polled.conversationId,
        customerAddress: polled.customerAddress,
        // DEC-47: the product recorded at arrival, onto the run row.
        product: polled.product,
        // DEC-38: the turn joins the idempotency key.
        ...(polled.turnNumber === null ? {} : { turnNumber: polled.turnNumber }),
        // DEC-49: and the attempt the ledger is on. A redelivered message is
        // a retry of that attempt, never a new first attempt: the keys of a
        // turn a reviewer sent back belong to the attempt they were asked
        // for, and attempt 1's key is the rejected draft's.
        ...(polled.currentAttempt === null || polled.currentAttempt === 1
          ? {}
          : { attempt: polled.currentAttempt }),
        history: await conversationHistory(
          deps.pool,
          polled.conversationId,
          polled.turnNumber,
        ),
        ...options.action,
      };
      const outcome = await coordinateTicket(deps, input);
      if (outcome.outcome !== 'stale_epoch') {
        // Keyed on the message: a ticket may hold several queued messages,
        // and acking the ticket would drop the ones not yet processed.
        await ackTicket(deps.pool, polled.ticketId, polled.messageId);
      }
      results.push({ ticketId: polled.ticketId, outcome: outcome.outcome });
    } catch (error) {
      // Per-ticket isolation: the scan keeps going. But a message that always
      // throws must not be retried forever — that spends a classifier budget
      // every scan and files one orphan run per attempt, while the queue
      // depth looks like an ordinary backlog. The relay already escalates a
      // record it can never send; this gives the consumer the same floor.
      const attempts = await recordAttempt(deps.pool, polled.ticketId, polled.messageId);
      const ceiling = options.maxIntakeAttempts ?? MAX_INTAKE_ATTEMPTS;
      if (attempts >= ceiling) {
        // The abandonment gets its own guard. It throws from inside this
        // catch, so the same catch cannot see it, and a database fault here
        // aborted the whole polled batch — the opposite of the isolation this
        // block promises. Every other message in the batch is unrelated to
        // this one's failure and must still be attempted.
        let filed: boolean;
        try {
          filed = await abandonMessage(deps.pool, attempts, polled, errorMessage(error));
        } catch (abandonError) {
          // The message stays queued and meets the ceiling again next scan,
          // so this path retries without bound. The ceiling stops bounding it
          // deliberately: the ledger is the thing that failed, and a message
          // dropped because the ledger blinked leaves no record anywhere.
          results.push({
            ticketId: polled.ticketId,
            outcome: 'error',
            error: `abandonment failed: ${errorMessage(abandonError)}`,
          });
          continue;
        }
        results.push(
          filed
            ? { ticketId: polled.ticketId, outcome: 'abandoned', error: errorMessage(error) }
            : { ticketId: polled.ticketId, outcome: 'not_claimed' },
        );
        continue;
      }
      results.push({
        ticketId: polled.ticketId,
        outcome: 'error',
        error: errorMessage(error),
      });
    }
  }
  // DEC-49: and the attempts a reviewer asked for. Served AFTER the poll, so
  // a queued customer message is never behind them: a re-attempt is a whole
  // walk with the provider in it, and the queue is the work this consumer
  // exists for. Its own guard, because a fault in it is not a fault in the
  // poll: the request stands and is served by the next scan, while a scan
  // that threw would leave every queued message of these partitions
  // untouched.
  let started: string[] = [];
  try {
    started = await startSentBackAttempts(deps, options);
  } catch (error) {
    console.error(
      logLine({
        event: 'send_back_scan_failed',
        at: new Date().toISOString(),
        error: errorMessage(error),
      }),
    );
  }
  if (started.length > 0) {
    console.error(
      logLine({
        event: 'send_back_attempts_started',
        at: new Date().toISOString(),
        count: started.length,
      }),
    );
  }

  // DEC-50: and the documents a reviewer wrote, which wait for a vector. Last,
  // for the reason the attempts come after the poll: the queue is the work
  // this consumer exists for. With the model the retrieval step embeds a
  // query with, so both vectors come from one model. Its own guard: a
  // document that is not embedded now is claimed again by a later scan.
  try {
    const embedded = await embedPendingDocuments(
      deps.pool,
      deps.provider,
      deps.embedModelVer ?? deps.pins.modelVer,
    );
    if (embedded.embedded.length > 0) {
      console.error(
        logLine({ event: 'documents_embedded', at: new Date().toISOString(), docIds: embedded.embedded }),
      );
    }
    // A failure carries its reason, so an operator reads why from the log.
    for (const [event, failures] of [
      ['documents_embedding_retrying', embedded.retrying],
      ['documents_embedding_deferred', embedded.deferred],
      ['documents_embedding_failed', embedded.failed],
      ['documents_embedding_lost', embedded.lost],
      ['documents_embedding_unrecorded', embedded.unrecorded],
    ] as const) {
      if (failures.length > 0) {
        console.error(logLine({ event, at: new Date().toISOString(), failures }));
      }
    }
    // DEC-25: what the scan's calls cost, which no run carries. Its own
    // event, because a refused, deferred or probing call embeds nothing and
    // is still paid for.
    // A call answered with no cost it could read says so, rather than
    // reading as free.
    if (embedded.costMicros > 0 || embedded.costUnknown) {
      console.error(
        logLine({
          event: 'document_embedding_cost',
          at: new Date().toISOString(),
          costMicros: embedded.costMicros,
          costUnknown: embedded.costUnknown,
        }),
      );
    }
  } catch (error) {
    console.error(
      logLine({
        event: 'document_embedding_scan_failed',
        at: new Date().toISOString(),
        error: errorMessage(error),
      }),
    );
  }

  return results;
}

export interface ConsumerHandle {
  /**
   * Stops the loop, releases the arrival signal, and waits for the in-flight
   * scan to drain. It resolves only once nothing this handle started still
   * holds a connection, because the caller ends the pool next.
   */
  stop(): Promise<void>;
}

/**
 * Long-lived consumer loop over its partitions. Scans never overlap; a
 * scan-level failure ends only that pass and the next interval retries.
 *
 * Claiming is split by role: the entrypoint (consumer-main.ts) calls
 * claimPartition once at startup, treating each process start as a
 * deployment — so every restart raises the fence of the tickets holding an
 * in-flight run in its partitions, which is safe because bumps are monotonic
 * and only pre-restart epochs go stale. A reply parked for a person and a run
 * that finished keep theirs (issue #113), so a restart strands neither. The
 * loop itself never re-claims mid-process.
 */
export function startConsumer(
  deps: CoordinatorDeps,
  options: ConsumerOptions,
): ConsumerHandle {
  let stopped = false;
  let scanning = false;
  let drained: (() => void) | null = null;
  let wakeTimer: (() => void) | null = null;
  // The shortest gap between two scans that a signal alone can drive. It
  // bounds what an unprivileged NOTIFY can cost, and it never delays a scan
  // that follows one which found work.
  const SIGNAL_FLOOR_MS = 50;
  // Set by an arrival that this consumer has not yet scanned for. Cleared at
  // the top of each scan, because a scan covers every row queued before it.
  let pending = false;
  // Issue #25: only this consumer's own partitions. Every consumer in a
  // deployment hears every arrival, so without the filter one busy partition
  // wakes the whole fleet for work none of them owns.
  const owned = new Set(options.partitions);

  /**
   * Runs one scan and reports whether it made progress — a message that left
   * the queue, not merely a row the poll returned.
   *
   * The distinction decides whether the next signal-driven rescan skips its
   * floor, so a count of results is the wrong proxy. A message that throws
   * stays queued, and the abandonment path can throw without bound when the
   * ledger itself is failing. Counting rows there would report progress on
   * every scan, skip the floor on every iteration, and spin hardest against
   * a database that is already in trouble.
   */
  async function scanOnce(): Promise<boolean> {
    const results = await processQueuedTickets(deps, options);
    let drained = 0;
    for (const result of results) {
      if (result.outcome === 'error') {
        console.error(
          logLine({ event: 'ticket_failed', at: new Date().toISOString(), ...result }),
        );
        continue;
      }
      // 'stale_epoch' leaves the message queued for the new owner. Every
      // other outcome acked it or filed its abandonment.
      if (result.outcome !== 'stale_epoch') drained += 1;
    }
    return drained > 0;
  }

  /**
   * An arrival, from the signal. It records the arrival rather than starting
   * a scan, because a scan is already serialized by the loop and two
   * overlapping scans would break the ownership argument in this module's
   * header.
   */
  function onArrival(partition: number): void {
    if (!owned.has(partition)) return;
    pending = true;
    // Ends an interval sleep early. Null while a scan runs, and then the
    // flag alone carries the arrival to the end of the scan.
    wakeTimer?.();
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      // Cleared before the poll, never after. An arrival that lands between
      // here and the poll is read by this very scan; one that lands after
      // the poll sets the flag again and gets the next.
      pending = false;
      scanning = true;
      let foundWork = false;
      try {
        foundWork = await scanOnce();
      } catch (error) {
        console.error(
          logLine({
            event: 'scan_failed',
            at: new Date().toISOString(),
            error: errorMessage(error),
          }),
        );
      } finally {
        scanning = false;
        drained?.();
        drained = null;
      }
      if (stopped) break;
      // A message that arrived during the scan is queued and was not polled,
      // and the scan that just ran drained a message — so the queue is
      // moving and the next scan starts at once. Sleeping here would cost that message a
      // full interval, which is the delay this signal exists to remove.
      if (pending && foundWork) continue;

      // Otherwise a floor applies. In Postgres a NOTIFY needs no grant, so
      // any role that can open a session on the ledger — including a
      // read-only reporting role — can send one. Without a floor, a stream
      // of notifications for rows that do not exist would hold the loop in a
      // tight poll for as long as it lasted. The floor is two orders of
      // magnitude below the interval, so a real arrival still loses nothing.
      //
      // It is an absolute deadline rather than a delay, so repeated arrivals
      // cannot push the next scan further out. Resetting a relative timer on
      // each arrival would starve the scan under exactly the traffic that
      // most needs it.
      const floorAt = Date.now() + SIGNAL_FLOOR_MS;
      await new Promise<void>((resolve) => {
        const finish = (): void => {
          wakeTimer = null;
          resolve();
        };
        let timer = setTimeout(finish, pending ? SIGNAL_FLOOR_MS : options.intervalMs);
        wakeTimer = () => {
          clearTimeout(timer);
          if (stopped) {
            finish();
            return;
          }
          timer = setTimeout(finish, Math.max(0, floorAt - Date.now()));
        };
      });
    }
  }

  // Failing to listen is not fatal: the interval still bounds the wait, and
  // a daemon that refused to start over a lost optimisation would trade a
  // few seconds of latency for an outage.
  void options.signal?.start(onArrival).catch((error: unknown) => {
    console.error(
      logLine({
        event: 'arrival_signal_unavailable',
        at: new Date().toISOString(),
        error: errorMessage(error),
      }),
    );
  });

  void loop();

  return {
    async stop(): Promise<void> {
      stopped = true;
      wakeTimer?.();
      // Started here, so released here, and awaited: the daemon calls
      // pool.end() as soon as this resolves, and a listener still closing
      // would leave its connection open past shutdown. Stopping twice is
      // safe, so a caller that owns the signal may also stop it.
      //
      // Bounded, because it runs ahead of the drain. `client.end()` carries
      // no timeout of its own, so a half-open socket here would hold up the
      // in-flight scan this handle exists to wait for.
      //
      // The budget is not free, and saying otherwise would contradict
      // arrival-signal.ts: a connected client that is never released holds
      // the Node event loop open, so a daemon whose listener wins this race
      // exits on its supervisor's SIGKILL rather than on its own. That is
      // still the better trade — a shutdown that never returns is worse than
      // one that ends hard — but it is a fault, so it is logged as one.
      if (options.signal !== undefined) {
        let released = false;
        await Promise.race([
          options.signal.stop().then(() => {
            released = true;
          }),
          new Promise<void>((resolve) => {
            setTimeout(resolve, SIGNAL_STOP_BUDGET_MS).unref?.();
          }),
        ]);
        if (!released) {
          console.error(
            logLine({
              event: 'arrival_signal_stop_timeout',
              at: new Date().toISOString(),
              budgetMs: SIGNAL_STOP_BUDGET_MS,
            }),
          );
        }
      }
      if (scanning) {
        await new Promise<void>((resolve) => {
          drained = resolve;
        });
      }
    },
  };
}
