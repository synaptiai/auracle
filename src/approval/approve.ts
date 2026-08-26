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
 * The outbox record carries payload `{ draftExternalId }` for a parked
 * draft, or the journaled action payload for a ledger-only park (V2
 * compensation), plus the semantic idempotency key (DEC-24) and the
 * delivery rule the action class declared (DEC-29). An insert of zero rows
 * is a distinct result (section 4.2 rule 2):
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
  /** Present when the park created a helpdesk draft (customer replies). */
  readonly draftExternalId?: string;
  actionClass: string;
  delivery: 'at_least_once' | 'at_most_once';
  /** The parked body exactly as the approval bridge recorded it (section 4.10). */
  body: string;
  /**
   * V2: present when the park carried no adapter call (compensation). The
   * payload approveRun copies onto the outbox record verbatim.
   */
  readonly payload?: Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parkRecordFrom(journalResult: unknown): ParkRecord {
  if (!isPlainObject(journalResult)) {
    throw new Error('park journal step carries no result object');
  }
  const r = journalResult;
  const draftExternalId = r['draftExternalId'];
  const actionClass = r['actionClass'];
  const delivery = r['delivery'];
  const body = r['body'];
  const payload = r['payload'];
  if (
    (draftExternalId !== undefined && (typeof draftExternalId !== 'string' || draftExternalId.length === 0))
    || typeof actionClass !== 'string'
    || actionClass.length === 0
    || typeof body !== 'string'
    || body.length === 0
    || (delivery !== 'at_least_once' && delivery !== 'at_most_once')
    || (payload !== undefined && !isPlainObject(payload))
  ) {
    throw new Error('park journal result is malformed for approval');
  }
  return {
    ...(draftExternalId === undefined ? {} : { draftExternalId }),
    actionClass,
    delivery,
    body,
    ...(payload === undefined ? {} : { payload }),
  };
}

/**
 * Thrown for a ledger-only park that journaled no payload. The record can
 * never relay, so approval refuses instead of inserting a phantom outbox
 * row.
 */
function throwMalformedPark(actionClass: string): never {
  throw new Error(
    `park journal result for action class '${actionClass}' carries neither a draft handle nor an action payload`,
  );
}

/**
 * Approve one parked action and queue it for the relay: a customer reply
 * parked as a helpdesk draft (DEC-11), or a V2 compensation of an
 * irreversible action parked in the ledger alone.
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

  // Draft-backed parks relay `sendDraft` against the parked handle;
  // ledger-only parks (V2 compensation) relay their journaled action
  // payload through `performAction`. Either way the idempotency key comes
  // from the action semantics (DEC-24), never from this run's identity.
  const outboxPayload: Record<string, unknown> =
    park.draftExternalId !== undefined
      ? { draftExternalId: park.draftExternalId }
      : park.payload ?? throwMalformedPark(park.actionClass);

  const idemKey = deriveIdemKey({
    actionClass: park.actionClass,
    ticketId: row.ticket_id as string,
    payload: outboxPayload,
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
      payload: outboxPayload,
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
