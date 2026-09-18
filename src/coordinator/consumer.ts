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
import { errorMessage } from '../errors.js';
import type { ArrivalSignal } from './arrival-signal.js';
import { ackTicket, pollPartition } from './intake.js';
import { journalStep } from '../ledger/journal-write.js';
import { PARKED_RUN_STATES, TERMINAL_RUN_STATE_NAMES } from '../ledger/run-state.js';

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
          JSON.stringify({
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
                        conversation_id, turn_number, product)
       VALUES (gen_random_uuid(), $1, $2, $4, 'escalated',
               'intake', 'intake', now(), now(), $3, $5, $6)
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
        JSON.stringify({
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
          JSON.stringify({ event: 'ticket_failed', at: new Date().toISOString(), ...result }),
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
          JSON.stringify({
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
      JSON.stringify({
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
            JSON.stringify({
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
