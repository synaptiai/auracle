/**
 * A case a reviewer puts aside, and its two ways back (DEC-48).
 *
 * Not every case can be answered now. The customer is away, a parcel is in
 * transit, or the answer waits on somebody else. Today the reviewer either
 * approves something early or leaves the case in the queue, where it looks
 * like work nobody is doing.
 *
 * A snooze is a state, not a hold. The run leaves the queue and comes back
 * when its period ends, and it ends `superseded` if the customer writes
 * first — the new turn's run takes the case, and the snoozed one records that
 * a newer turn replaced it. The DEC-46 reservation is untouched: who holds
 * the case is the team's business, and how long it waits is the customer's.
 *
 * What a snooze must not do is count as work. It writes no outbox record, it
 * records no approver, and it keeps `snoozed_until` after the return, so the
 * latency report can keep every run that was ever snoozed in a class of its
 * own. Without that column the wait would be counted as service time — the
 * one number an operator reads as how long the system takes.
 *
 * Three writers live here, and each names the transaction it belongs to:
 * `snoozeRun` opens its own, `unsnoozeExpired` returns the cases a consumer
 * owns to the approval queue on each scan, and `endSnoozedIn` runs inside
 * the transaction that records the customer's next message.
 */
import type { Pool, PoolClient } from 'pg';

import { UNATTRIBUTED, approverFrom } from '../approval/approver.js';
import { replyDigest } from '../approval/shown.js';
import { readSavedReply } from '../ledger/conversation.js';
import { fencedTransition } from '../ledger/insert.js';
import { journalStep } from '../ledger/journal-write.js';

/**
 * The shortest and longest period a reviewer may set.
 *
 * A minute is the floor because anything shorter is not a wait: the case
 * would be back in the queue before the reviewer finished reading the page.
 * Thirty days is the ceiling because a case nobody has touched in a month is
 * not waiting for anybody, and a run that sat snoozed for longer would be a
 * case the team has forgotten rather than one it put aside.
 */
export const MIN_SNOOZE_MS = 60_000;
export const MAX_SNOOZE_MS = 30 * 24 * 60 * 60_000;

/**
 * The journal option both writers here pass, and why.
 *
 * A snooze has ordinary repeats: the period ends, the case returns to the
 * queue, and the reviewer sets another period. The step's row is keyed on the
 * run and the step, so the second cycle writes the row the first one left —
 * the same rule the undo follows. The row then names the person and the
 * moment of the current snooze, and a run carries one such row at a time.
 */
const JOURNAL_REPLACES = { replace: true } as const;

/** What one snooze did, or why it did nothing. */
export type SnoozeOutcome =
  | { readonly outcome: 'snoozed' }
  | { readonly outcome: 'unknown_run' }
  /** The run is not waiting for a person, so there is nothing to put aside. */
  | { readonly outcome: 'not_awaiting_approval'; readonly state: string }
  /** DEC-46: the reply the caller was shown is not the reply the ledger holds. */
  | { readonly outcome: 'shown_changed' }
  /** A period below the floor, above the ceiling, or not whole milliseconds. */
  | { readonly outcome: 'period_out_of_range' }
  /**
   * The fence refused the write. No console caller reaches this: a run parked
   * in `awaiting_approval` is outside the fence's reach. It stays in the
   * union because the console maps every outcome by name.
   */
  | { readonly outcome: 'stale_epoch'; readonly highestAcceptedEpoch: bigint };

export interface SnoozeOptions {
  /** How long the case waits, in milliseconds. Bounded, and whole. */
  readonly periodMs: number;
  /** DEC-42, DEC-45: who set it, recorded in the run's journal. */
  readonly snoozedBy?: string;
  /** DEC-45: how the name was established. `header` is DEC-42's default. */
  readonly snoozedBySource?: 'roster' | 'header' | 'none';
  /**
   * DEC-46: the digest of the reply the page drew, when a page drew one.
   *
   * A snooze is an outcome on the case, so it carries the same guard the
   * approval, the save and the close carry: a reviewer who read one reply
   * does not put aside a case holding another.
   */
  readonly shown?: string;
  /**
   * DEC-44: whether the adapter's ledger holds the reply, so the saved text
   * is what a page drew. Read only where `shown` is supplied, and absent is
   * the draft path, as on the approval and the close.
   */
  readonly ledgerReply?: boolean;
}

/**
 * Put one case aside, or refuse and say why.
 *
 * The run moves to `snoozed` in one transaction, with the moment it is due
 * back and a journal row naming who set it. Nothing else changes: no outbox
 * record, no approver, no finish time, and the case hold stays where it is.
 */
export async function snoozeRun(
  pool: Pool,
  runId: string,
  options: SnoozeOptions,
): Promise<SnoozeOutcome> {
  if (
    !Number.isSafeInteger(options.periodMs)
    || options.periodMs < MIN_SNOOZE_MS
    || options.periodMs > MAX_SNOOZE_MS
  ) {
    return { outcome: 'period_out_of_range' };
  }

  const rows = await pool.query(
    'SELECT state, cost_micros, steps_used, conversation_id FROM run WHERE run_id = $1',
    [runId],
  );
  if (rows.rows.length === 0) return { outcome: 'unknown_run' };
  const row = rows.rows[0]!;
  const state = row.state as string;
  if (state !== 'awaiting_approval') {
    return { outcome: 'not_awaiting_approval', state };
  }
  const conversationId = row.conversation_id as string | null;

  const snoozedBy = approverFrom(options.snoozedBy);
  const snoozedBySource =
    snoozedBy === UNATTRIBUTED ? 'none' : (options.snoozedBySource ?? 'header');

  const shown = options.shown;
  const moved = await fencedTransition(pool, {
    runId,
    state: 'snoozed',
    costMicros: row.cost_micros as number,
    stepsUsed: row.steps_used as number,
    fromState: 'awaiting_approval',
    // DEC-46, on the rule the approval and the save apply: the reply the
    // caller showed, against the reply the ledger holds now, under the row
    // lock. DEC-44 decides which text that is — the saved reply where the
    // adapter's ledger holds it, the parked body everywhere else.
    ...(shown === undefined ? {} : {
      refuseIf: async (client: PoolClient): Promise<boolean> => {
        const held = await client.query(
          "SELECT result->>'body' AS body, result->>'turnNumber' AS turn"
            + " FROM step_journal WHERE run_id = $1 AND step_id = 'park'",
          [runId],
        );
        if (held.rows.length === 0) {
          throw new Error(`run ${runId} awaits approval but journals no park step`);
        }
        const body = held.rows[0]!.body as unknown;
        const turn = held.rows[0]!.turn as string | null;
        if (typeof body !== 'string') return true;
        const saved = options.ledgerReply === true
          ? await readSavedReply(client, {
            conversationId,
            turnNumber: turn === null ? null : Number(turn),
          })
          : null;
        return replyDigest(saved ?? body) !== shown;
      },
    }),
    afterWrite: async (client: PoolClient): Promise<void> => {
      // The moment, stamped by the ledger's clock in the transaction that
      // commits the state, and journalled beside it so the case reads when it
      // is due without recomputing it.
      const stamped = await client.query<{ until: Date }>(
        `UPDATE run
            SET snoozed_until = clock_timestamp() + ($2::bigint * interval '1 millisecond')
          WHERE run_id = $1
        RETURNING snoozed_until AS until`,
        [runId, String(options.periodMs)],
      );
      const until = stamped.rows[0]!.until;
      await journalStep(client, {
        runId,
        stepId: 'snooze',
        status: 'done',
        result: {
          until: until.toISOString(),
          periodMs: options.periodMs,
          reviewer: snoozedBy,
          reviewerSource: snoozedBySource,
        },
        promptVer: 'console',
        modelVer: 'console',
        costMicros: 0,
      }, JOURNAL_REPLACES);
    },
  });

  switch (moved.outcome) {
    case 'accepted':
      return { outcome: 'snoozed' };
    case 'wrong_state':
      return { outcome: 'not_awaiting_approval', state: moved.currentState };
    case 'refused':
      return { outcome: 'shown_changed' };
    case 'stale_epoch':
      return { outcome: 'stale_epoch', highestAcceptedEpoch: moved.highestAcceptedEpoch };
    case 'superseded':
      // No outbox record travels with a snooze, so no key can be lost.
      throw new Error(`run ${runId} reported a lost idempotency key on a snooze`);
    case 'unknown_run':
      throw new Error(`run vanished between read and transition: ${runId}`);
  }
}

/**
 * Returns every due case of the given partitions to the approval queue.
 *
 * A consumer calls this on each scan, over its own partitions: a snoozed
 * run's partition is its conversation's, so the consumer that owns the
 * conversation is the one that returns it. The run lands back in
 * `awaiting_approval`, which is the queue a reviewer reads and not the intake
 * rows this consumer polls, so the case is offered again within one interval.
 * The write names the state it requires, so a case a person or the customer
 * already moved is skipped rather than fought over — and the period makes the
 * move due, not urgent.
 *
 * The moment is kept, because the latency report reads it as the record that
 * the run was ever snoozed.
 */
export async function unsnoozeExpired(
  pool: Pool,
  partitions: readonly number[],
): Promise<string[]> {
  if (partitions.length === 0) return [];
  // Read outside any transaction: the transition below takes its own row
  // lock, and holding one here would hold it across every case in the list.
  const due = await pool.query<{ run_id: string }>(
    `SELECT run_id FROM run
      WHERE state = 'snoozed' AND snoozed_until <= clock_timestamp()
        AND partition = ANY ($1::int[])
      ORDER BY snoozed_until`,
    [partitions],
  );

  const returned: string[] = [];
  for (const { run_id: runId } of due.rows) {
    const run = await pool.query(
      'SELECT cost_micros, steps_used FROM run WHERE run_id = $1',
      [runId],
    );
    const row = run.rows[0];
    if (row === undefined) continue;
    const moved = await fencedTransition(pool, {
      runId,
      state: 'awaiting_approval',
      costMicros: row.cost_micros as number,
      stepsUsed: row.steps_used as number,
      fromState: 'snoozed',
      afterWrite: async (client: PoolClient): Promise<void> => {
        await journalStep(client, {
          runId,
          stepId: 'unsnooze',
          status: 'done',
          result: { why: 'period_ended' },
          promptVer: 'console',
          modelVer: 'console',
          costMicros: 0,
        }, JOURNAL_REPLACES);
      },
    });
    if (moved.outcome === 'accepted') returned.push(runId);
  }
  return returned;
}

/**
 * Ends a snoozed run because the customer wrote again.
 *
 * Called inside the transaction that records the new message, under the
 * conversation row's lock, so the new turn and the end of the old run commit
 * together. The shape is `releaseHoldIn`'s: the caller owns the transaction.
 *
 * `superseded` is what happened, and it is the same end a run reaches when a
 * newer action takes its key. The state is the whole record — there is no
 * journal row, exactly as there is none on the key-loss path — and `superseded`
 * is terminal, so the finish is stamped in the same commit.
 *
 * The two ways off a snooze race, and the clock usually wins: the period
 * ends, the case comes back, and the customer writes after it. That order is
 * covered, because the run is the one that answered the older turn either
 * way — a returned run still carries `snoozed_until`, so this ends it too and
 * the new turn's run takes the case. A run nobody put aside carries no such
 * moment and is left where it is, which is what an ordinary parked case
 * expects.
 */
export async function endSnoozedIn(
  client: PoolClient,
  conversationId: string,
): Promise<string[]> {
  // A run that was put aside and has already returned is ended here too. The
  // clock is the ordinary winner: the period ends, the case is handed back,
  // and only then does the customer write. Leaving that run alone would keep
  // a draft answering a turn the customer has moved past in the approval
  // queue, beside the new turn's run. `snoozed_until` is what marks it: only
  // a run that was ever snoozed carries one, so a run waiting for a person
  // that nobody put aside is untouched.
  const ended = await client.query<{ run_id: string }>(
    `UPDATE run
        SET state = 'superseded', finished_at = COALESCE(finished_at, now())
      WHERE conversation_id = $1
        AND (state = 'snoozed'
             OR (state = 'awaiting_approval' AND snoozed_until IS NOT NULL))
    RETURNING run_id`,
    [conversationId],
  );
  return ended.rows.map((row) => row.run_id);
}
