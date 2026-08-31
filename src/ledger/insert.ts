import type { Pool, PoolClient } from 'pg';

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
const TERMINAL_RUN_STATES: ReadonlySet<string> = new Set([
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
): Promise<FencedInsertResult> {
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

      await client.query(
        `INSERT INTO run (
           run_id, ticket_id, partition, epoch, state,
           prompt_ver, model_ver, cost_micros, steps_used, deadline_at,
           enqueued_at, conversation_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
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
        ],
      );

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
        await client.query(
          "UPDATE run SET state = 'superseded', finished_at = now() WHERE run_id = $1",
          [run.runId],
        );
        await client.query('COMMIT');
        return { outcome: 'superseded' };
      }

      await client.query('COMMIT');
      return { outcome: 'accepted' };
    } catch (error) {
      await client.query('ROLLBACK');
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
): Promise<FencedTransitionResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      const row = await client.query(
        'SELECT ticket_id, epoch, state FROM run WHERE run_id = $1 FOR UPDATE',
        [t.runId],
      );
      if (row.rows.length === 0) {
        await client.query('ROLLBACK');
        return { outcome: 'unknown_run' };
      }
      const ticketId = row.rows[0]!.ticket_id as string;
      const runEpoch = BigInt(row.rows[0]!.epoch as string);
      const currentState = row.rows[0]!.state as string;

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
          'UPDATE run SET state = $2, cost_micros = $3, steps_used = $4, finished_at = now() WHERE run_id = $1',
          [t.runId, t.state, t.costMicros, t.stepsUsed],
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
          await client.query(
            "UPDATE run SET state = 'superseded', finished_at = now() WHERE run_id = $1",
            [t.runId],
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
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    client.release();
  }
}
