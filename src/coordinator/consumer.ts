// Partition consumer (section 4.3, DEC-27, DEC-28) — the runtime half of the
// partition design that no code owned before this module.
//
//   - DEC-27: the queue is partitioned by hash(ticket_id) % N and one
//     consumer owns each partition. This module polls only its assigned
//     partitions, so two runs on one ticket cannot occur together in normal
//     operation.
//   - DEC-28: every write carries a fencing epoch that only increases per
//     ticket. Each pickup reads ticket_epoch and uses highest + 1. The
//     rebalance procedure (claimPartition) bumps every fence in a partition
//     when ownership moves at deployment, so an old owner's writes — whose
//     runs carry pre-bump epochs — are refused by the fenced ledger path
//     (src/ledger/insert.ts).
//
// There is no lease: the partition gives exclusive access in normal
// operation, the fencing epoch gives safety during a rebalance overlap.
//
// Why the overlap cannot double-process. A fresh run plans its epoch from a
// pre-bump fence read (nextEpoch), so during a rebalance its INSERT can land
// at an epoch EQUAL to the bumped fence: the ledger guard is strict
// (`run.epoch < highest`, see src/ledger/insert.ts), because refusing
// equality would break the serialized-writer semantics pinned in
// src/ledger/concurrency.db.test.ts. The window still resolves to a single
// effective owner:
//   - if the new owner picks the still-queued ticket up first, its commit
//     raises the fence above the old run's epoch, and every later hop of the
//     old run — including its outbox insert — is refused mid-run;
//   - if the old run finishes first instead, it acks the ticket and the new
//     owner never polls it.
// Either way at most one run produces external work per ticket, and the
// relay re-checks the fence at send time ('fenced'), so even an outbox row
// from a since-refused run can never be sent (DEC-28: check at insert AND at
// send).
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
import { ackTicket, pollPartition } from './intake.js';

/**
 * The next fencing epoch for a ticket (DEC-28): one above the highest epoch
 * the ledger ever accepted for it, so this run's writes can never be refused
 * as stale by its own predecessor. Strictly increasing per ticket.
 */
export async function nextEpoch(pool: Pool, ticketId: string): Promise<bigint> {
  const rows = await pool.query(
    'SELECT epoch::text AS epoch FROM ticket_epoch WHERE ticket_id = $1',
    [ticketId],
  );
  const highest = rows.rows[0]?.['epoch'];
  return highest === undefined ? 1n : BigInt(highest as string) + 1n;
}

/**
 * The rebalance procedure DEC-27 charges as the cost of partitions. At each
 * deployment ownership moves; the new owner calls this once per claimed
 * partition. One transaction bumps every per-ticket fence in the partition,
 * so any old owner still mid-run fails its next fenced write with
 * stale_epoch. Returns the number of fences bumped.
 *
 * A ticket's fence exists only after its first fenced write, which always
 * also wrote a run row carrying the partition — hence the join through run.
 */
export async function claimPartition(pool: Pool, partition: number): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      const bumped = await client.query(
        `UPDATE ticket_epoch te SET epoch = te.epoch + 1
         WHERE EXISTS (
           SELECT 1 FROM run r WHERE r.ticket_id = te.ticket_id AND r.partition = $1
         )`,
        [partition],
      );
      await client.query('COMMIT');
      return bumped.rowCount ?? 0;
    } catch (error) {
      await client.query('ROLLBACK');
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
}

export type ConsumerScanOutcome =
  | { ticketId: string; outcome: Awaited<ReturnType<typeof coordinateTicket>>['outcome'] }
  | { ticketId: string; outcome: 'error'; error: string }
  /** The message failed MAX_INTAKE_ATTEMPTS times and left the queue. */
  | { ticketId: string; outcome: 'abandoned'; error: string };

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
async function abandonMessage(
  pool: Pool,
  attempts: number,
  polled: {
    ticketId: string;
    messageId: string;
    partition: number;
    conversationId: string | null;
  },
  reason: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const run = await client.query<{ run_id: string }>(
      `INSERT INTO run (run_id, ticket_id, partition, epoch, state,
                        prompt_ver, model_ver, deadline_at, finished_at, conversation_id)
       VALUES (gen_random_uuid(), $1, $2, 0, 'escalated',
               'intake', 'intake', now(), now(), $3)
       RETURNING run_id`,
      [polled.ticketId, polled.partition, polled.conversationId],
    );
    // The escalations view reads its reason from this step, so the operator
    // sees why the message was abandoned and not merely that it vanished.
    await client.query(
      `INSERT INTO step_journal (run_id, step_id, status, result, prompt_ver, model_ver, cost_micros)
       VALUES ($1, 'escalate', 'done', $2::jsonb, 'intake', 'intake', 0)`,
      [
        run.rows[0]?.run_id,
        JSON.stringify({ reason: `intake_abandoned after ${attempts} attempts: ${reason}` }),
      ],
    );
    await client.query('DELETE FROM intake WHERE ticket_id = $1 AND message_id = $2', [
      polled.ticketId,
      polled.messageId,
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
        epoch: await nextEpoch(deps.pool, polled.ticketId),
        // Open item 7: the arrival time rides from intake to the run row,
        // so queue wait survives the ack that follows.
        enqueuedAt: polled.enqueuedAt,
        // DEC-28: the run records the partition the message was filed under,
        // never one recomputed from this process's PARTITION_COUNT.
        partition: polled.partition,
        // DEC-35: the conversation, its participant, and the turns before this.
        conversationId: polled.conversationId,
        customerAddress: polled.customerAddress,
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
        await abandonMessage(deps.pool, attempts, polled, errorMessage(error));
        results.push({
          ticketId: polled.ticketId,
          outcome: 'abandoned',
          error: errorMessage(error),
        });
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
  /** Stops the loop and waits for the in-flight scan to drain. */
  stop(): Promise<void>;
}

/**
 * Long-lived consumer loop over its partitions. Scans never overlap; a
 * scan-level failure ends only that pass and the next interval retries.
 *
 * Claiming is split by role: the entrypoint (consumer-main.ts) calls
 * claimPartition once at startup, treating each process start as a
 * deployment — so every restart does bump the fences in its partitions,
 * which is safe because bumps are monotonic and only pre-restart epochs go
 * stale. The loop itself never re-claims mid-process.
 */
export function startConsumer(
  deps: CoordinatorDeps,
  options: ConsumerOptions,
): ConsumerHandle {
  let stopped = false;
  let scanning = false;
  let drained: (() => void) | null = null;
  let wakeTimer: (() => void) | null = null;

  async function scanOnce(): Promise<void> {
    for (const result of await processQueuedTickets(deps, options)) {
      if (result.outcome === 'error') {
        console.error(
          JSON.stringify({ event: 'ticket_failed', at: new Date().toISOString(), ...result }),
        );
      }
    }
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      scanning = true;
      try {
        await scanOnce();
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
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          wakeTimer = null;
          resolve();
        }, options.intervalMs);
        wakeTimer = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }

  void loop();

  return {
    stop(): Promise<void> {
      stopped = true;
      wakeTimer?.();
      if (!scanning) return Promise.resolve();
      return new Promise<void>((resolve) => {
        drained = resolve;
      });
    },
  };
}
