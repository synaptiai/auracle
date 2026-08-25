/**
 * Approval completion entrypoint (section 4.2). Obeys DEC-11, DEC-12,
 * DEC-24, DEC-28, DEC-29.
 *
 * An operator, or the adopter's helpdesk webhook, calls this after a person
 * approves a parked draft in the helpdesk UI (DEC-11: this project adds no
 * queue interface of its own).
 *
 * One transaction does all of:
 *   1. refuse the move unless the run sits in `awaiting_approval` (DEC-12)
 *   2. re-check the fencing epoch against ticket_epoch (DEC-28)
 *   3. commit the run's next state
 *   4. insert the relayable outbox record
 *   5. when a final body was captured, record the approval-edit distance
 *      (section 4.10) so the metric commits with the state move
 *
 * The outbox record carries payload `{ draftExternalId }`, the semantic
 * idempotency key (DEC-24) and the delivery rule the action class declared
 * (DEC-29). An insert of zero rows is a distinct result (section 4.2 rule 2):
 * the run lands 'superseded', never resolved with a phantom record.
 */
import type { Pool } from 'pg';

import { fencedTransition } from '../ledger/insert.js';
import { deriveIdemKey } from '../ledger/keys.js';
import { recordApprovalEditDistance } from './measure.js';

export type ApproveOutcome =
  | { readonly outcome: 'approved'; readonly idemKey: string }
  | { readonly outcome: 'unknown_run' }
  | { readonly outcome: 'not_awaiting_approval'; readonly state: string }
  /** Section 4.2 rule 2: another semantic action already holds the key. */
  | { readonly outcome: 'superseded' }
  | { readonly outcome: 'stale_epoch'; readonly highestAcceptedEpoch: bigint };

/** Optional inputs for one approval. */
export interface ApproveOptions {
  /**
   * The final text the person sent, when it differs from or completes the
   * parked draft. Passing it records the approval-edit distance
   * (section 4.10) inside the approval transaction.
   */
  readonly finalBody?: string;
}

/** What the coordinator's `park` step recorded in the journal. */
interface ParkRecord {
  draftExternalId: string;
  actionClass: string;
  delivery: 'at_least_once' | 'at_most_once';
  /** The draft body exactly as the approval bridge parked it (section 4.10). */
  body: string;
}

function parkRecordFrom(journalResult: unknown): ParkRecord {
  if (typeof journalResult !== 'object' || journalResult === null) {
    throw new Error('park journal step carries no result object');
  }
  const r = journalResult as Record<string, unknown>;
  const draftExternalId = r['draftExternalId'];
  const actionClass = r['actionClass'];
  const delivery = r['delivery'];
  const body = r['body'];
  if (
    typeof draftExternalId !== 'string'
    || draftExternalId.length === 0
    || typeof actionClass !== 'string'
    || actionClass.length === 0
    || typeof body !== 'string'
    || body.length === 0
    || (delivery !== 'at_least_once' && delivery !== 'at_most_once')
  ) {
    throw new Error('park journal result is malformed for approval');
  }
  return { draftExternalId, actionClass, delivery, body };
}

/**
 * Approve one parked customer reply and queue it for the relay.
 *
 * With `options.finalBody`, the same transaction also records the
 * approval-edit distance (section 4.10) between the parked draft and that
 * final text: a crash can never lose one side of the pair. Omit it when no
 * body was captured; the distance then stays null on the run.
 *
 * The run moves to `resolved`: the person's work here is done, exactly as
 * the automatic path resolves once its outbox record commits. If the send
 * later fails into an unknown state, the relay escalates the run (DEC-30).
 */
export async function approveRun(
  pool: Pool,
  runId: string,
  options?: ApproveOptions,
): Promise<ApproveOutcome> {
  const rows = await pool.query(
    'SELECT ticket_id, state, cost_cents, steps_used FROM run WHERE run_id = $1',
    [runId],
  );
  if (rows.rows.length === 0) {
    return { outcome: 'unknown_run' };
  }
  const row = rows.rows[0]!;
  const state = row.state as string;
  if (state !== 'awaiting_approval') {
    return { outcome: 'not_awaiting_approval', state };
  }

  const parked = await pool.query(
    "SELECT result FROM step_journal WHERE run_id = $1 AND step_id = 'park'",
    [runId],
  );
  if (parked.rows.length === 0) {
    throw new Error(`run ${runId} awaits approval but journals no park step`);
  }
  const park = parkRecordFrom(parked.rows[0]!.result);

  const idemKey = deriveIdemKey({
    actionClass: park.actionClass,
    ticketId: row.ticket_id as string,
    payload: { draftExternalId: park.draftExternalId },
  });

  const finalBody = options?.finalBody;
  const moved = await fencedTransition(pool, {
    runId,
    state: 'resolved',
    costCents: row.cost_cents as number,
    stepsUsed: row.steps_used as number,
    fromState: 'awaiting_approval',
    outbox: {
      stepId: 'approve',
      idemKey,
      actionClass: park.actionClass,
      delivery: park.delivery,
      payload: { draftExternalId: park.draftExternalId },
    },
    ...(finalBody === undefined
      ? {}
      : {
          // Section 4.2 rule 1 applied to the measurement: the edit
          // distance commits with the approval, or not at all.
          afterWrite: async (client) => {
            await recordApprovalEditDistance(client, {
              runId,
              parkedBody: park.body,
              finalBody,
            });
          },
        }),
  });

  switch (moved.outcome) {
    case 'accepted':
      return { outcome: 'approved', idemKey };
    case 'wrong_state':
      // Lost a race with another approve call; it re-checked under the lock.
      return { outcome: 'not_awaiting_approval', state: moved.currentState };
    case 'superseded':
      return { outcome: 'superseded' };
    case 'stale_epoch':
      return { outcome: 'stale_epoch', highestAcceptedEpoch: moved.highestAcceptedEpoch };
    case 'unknown_run':
      // The row existed above; runs are never deleted.
      throw new Error(`run vanished between read and transition: ${runId}`);
  }
}
