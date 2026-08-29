/**
 * Outbox relay (section 4.4). Obeys DEC-04, DEC-06, DEC-28, DEC-29, DEC-30.
 *
 * The relay is a separate process. It reads outbox records with the
 * `pending` status, re-checks the fencing epoch (DEC-28: check at insert
 * and at send), sends through the egress adapter with the record's
 * `idem_key`, and only then sets the status to `sent`. Send first. Set
 * the status second. Do not set the status first.
 *
 * The delivery rule comes from the record (`outbox.delivery`, DEC-29),
 * never from a global setting. Routing comes from the action semantics
 * (`outbox.action_class`): customer-reply records keep the draft path
 * (`sendDraft`, the approval bridge parked the draft first), every other
 * action class goes through `performAction`. A payload that matches no
 * known shape is a defect, not a transient failure: the record escalates
 * instead of livelocking in pending.
 *
 * When a send fails and the delivery state
 * is unknown, the relay must not retry: it sets the record to
 * `delivery_unknown` and escalates the run to the approval path (DEC-30).
 * When the adapter supports read-back, the relay reconciles instead of
 * escalating.
 */
import type { Pool } from 'pg';

// The relay routes by negation: only a customer reply takes the draft
// path, so it never names the other classes.
import { CUSTOMER_REPLY_ACTION_CLASS } from '../adapters/types.js';

import type {
  AdapterCapabilities,
  DeliveryState,
  EgressAdapter,
} from '../adapters/types.js';

/** The delivery rule an action class declares for one record (DEC-29). */
export type DeliveryRule = 'at_least_once' | 'at_most_once';

/**
 * What the relay does after a send attempt fails.
 *
 * - mark_sent    — read-back proved the delivery landed; reconcile, not escalate
 * - leave_pending — a retry is safe; the next scan picks the record up again
 * - escalate     — unknown state; set `delivery_unknown` and stop (DEC-30)
 */
export type FailureResolution =
  | { readonly action: 'mark_sent'; readonly reconciled: true }
  | { readonly action: 'leave_pending' }
  | { readonly action: 'escalate' };

/**
 * The failure-resolution decision matrix of section 4.4, as a pure
 * function so tests can pin every cell of it without a database.
 *
 * `readBack` is the observed delivery state, or null when the adapter
 * cannot read state back. An adapter that honors idempotency keys makes
 * every retry safe (the key dedupes), so its failures stay pending.
 *
 * Without idempotency support:
 *   unknown state          -> escalate, never blind-retry (DEC-30)
 *   read-back not_found    -> retry only when loss costs more than a
 *                             duplicate (at_least_once); at_most_once
 *                             forbids a second attempt, so it escalates
 *   read-back delivered    -> mark sent; reconcile, not escalate
 */
export function resolveSendFailure(
  capabilities: AdapterCapabilities,
  delivery: DeliveryRule,
  readBack: DeliveryState | null,
): FailureResolution {
  if (capabilities.supportsIdempotencyKey) {
    // A repeat call with the same key returns the first delivery, so a
    // retry can never duplicate — whatever the delivery rule says.
    if (readBack?.state === 'delivered') {
      return { action: 'mark_sent', reconciled: true };
    }
    return { action: 'leave_pending' };
  }

  if (readBack?.state === 'delivered') {
    return { action: 'mark_sent', reconciled: true };
  }

  const stateIsKnown = readBack !== null;
  if (!stateIsKnown) {
    // DEC-30: a blind retry can pay twice, a silent abandon can drop the
    // reply. Escalation selects neither failure for the operator.
    return { action: 'escalate' };
  }

  // not_found: nothing was delivered, so the state is known.
  return delivery === 'at_least_once'
    ? { action: 'leave_pending' }
    : { action: 'escalate' }; // at_most_once: no second attempt, ever.
}

/** The message of a thrown value, whatever its class. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One relayed record and what became of it. */
export interface RelayResult {
  readonly idemKey: string;
  /**
   * Why the send failed, when it did. The relay decides DEC-30 and used to
   * discard this: an operator facing a wall of `left_pending_retry` had no
   * line anywhere naming the cause, and could not tell a genuinely uncertain
   * delivery from a read-back that throws on every call.
   */
  readonly sendError?: string;
  /** Why the read-back failed, when one was attempted and threw. */
  readonly readBackError?: string;
  readonly outcome:
    | 'sent' // send succeeded
    | 'sent_reconciled' // send threw, read-back proved delivery (DEC-30)
    | 'delivery_unknown_escalated' // DEC-30: no retry, approval path
    | 'malformed_escalated' // payload matches no known shape; no send attempted
    | 'left_pending_retry' // safe to retry on a later scan
    | 'fenced'; // DEC-28: epoch stale at send time; never sent
}

/** One pending outbox row as a scan reads it from the ledger. */
export interface PendingOutboxRow {
  run_id: string;
  step_id: string;
  ticket_id: string;
  idem_key: string;
  epoch: string;
  delivery: string;
  action_class: string;
  payload: unknown;
}

/**
 * Every record currently awaiting relay, in stable idem-key order so
 * repeated passes meet them in the same sequence.
 */
export async function pendingRows(pool: Pool): Promise<PendingOutboxRow[]> {
  const rows = await pool.query(
    `SELECT o.run_id, o.step_id, r.ticket_id, o.idem_key, o.epoch,
            o.delivery, o.action_class, o.payload
     FROM outbox o JOIN run r ON r.run_id = o.run_id
     WHERE o.status = 'pending'
     ORDER BY o.idem_key`,
  );
  return rows.rows as PendingOutboxRow[];
}

export async function relayPending(pool: Pool, adapter: EgressAdapter): Promise<RelayResult[]> {
  const results: RelayResult[] = [];
  for (const row of await pendingRows(pool)) {
    results.push(await relayOne(pool, adapter, row));
  }
  return results;
}

function assertDeliveryRule(value: string): DeliveryRule {
  if (value === 'at_least_once' || value === 'at_most_once') {
    return value;
  }
  throw new Error(`outbox.delivery holds an unknown rule: ${value}`);
}

/**
 * The relay sends the draft this payload references. The approval bridge
 * parks the draft and records its external id in the payload before the
 * record becomes relayable.
 */
function draftExternalIdFrom(payload: Record<string, unknown>): string {
  const candidate = payload['draftExternalId'];
  if (typeof candidate === 'string' && candidate.length > 0) {
    return candidate;
  }
  throw new PayloadShapeError('outbox payload carries no draftExternalId');
}

/**
 * Thrown when an outbox payload matches no known shape for its action
 * class. A shape defect never heals on retry, so the relay escalates
 * instead of leaving the record pending forever.
 */
class PayloadShapeError extends Error {}

/**
 * What one record routes to, resolved from its action semantics before any
 * adapter call. A customer reply sends the draft the approval bridge
 * parked; every other action class is an automatic internal write that the
 * target ticket comes with (`run.ticket_id`, ledger truth).
 */
type Dispatch =
  | { readonly kind: 'draft'; readonly draftExternalId: string }
  | { readonly kind: 'action'; readonly payload: Record<string, unknown> };

function dispatchFor(row: PendingOutboxRow): Dispatch {
  const payload = row.payload;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new PayloadShapeError(
      `outbox payload must be a JSON object, got ${payload === null ? 'null' : typeof payload}`,
    );
  }
  const record = payload as Record<string, unknown>;
  if (row.action_class === CUSTOMER_REPLY_ACTION_CLASS) {
    return { kind: 'draft', draftExternalId: draftExternalIdFrom(record) };
  }
  // The ledger owns the ticket identity; a stale or missing field in the
  // stored payload cannot redirect the write.
  return {
    kind: 'action',
    payload: { ...record, ticketExternalId: row.ticket_id },
  };
}

async function highestAcceptedEpoch(pool: Pool, runId: string): Promise<bigint | null> {
  const current = await pool.query(
    `SELECT te.epoch FROM ticket_epoch te
     JOIN run r ON r.ticket_id = te.ticket_id
     WHERE r.run_id = $1`,
    [runId],
  );
  if (current.rows.length === 0) {
    return null;
  }
  return BigInt(current.rows[0]!.epoch as string);
}

/**
 * Relay one record to its terminal or retry outcome. This is the unit the
 * daemon isolates errors around: a throw here (malformed payload, ledger
 * error) fails that record only, never the scan around it. The delivery
 * rule is read from this row alone (`row.delivery`, DEC-29) — never from
 * configuration.
 */
export async function relayOne(
  pool: Pool,
  adapter: EgressAdapter,
  row: PendingOutboxRow,
): Promise<RelayResult> {
  const idemKey = row.idem_key;

  // DEC-28, second check: the fence at insert time does not cover a lease
  // that expired between insert and send. A fenced record can never become
  // valid again (epochs never decrease), so it leaves the pending scan.
  const highest = await highestAcceptedEpoch(pool, row.run_id);
  if (highest !== null && BigInt(row.epoch) < highest) {
    await pool.query(
      "UPDATE outbox SET status = 'fenced' WHERE run_id = $1 AND step_id = $2 AND status = 'pending'",
      [row.run_id, row.step_id],
    );
    return { idemKey, outcome: 'fenced' };
  }

  // Route by action semantics before any adapter call. A payload that
  // matches no known shape is a defect, not a transient failure: nothing
  // was sent, so there is no delivery state to reconcile — the record
  // escalates instead of livelocking in pending.
  let dispatch: Dispatch;
  try {
    dispatch = dispatchFor(row);
  } catch (error) {
    if (!(error instanceof PayloadShapeError)) throw error;
    await parkEscalated(pool, row, 'malformed', `malformed_payload: ${errorText(error)}`);
    return { idemKey, outcome: 'malformed_escalated' };
  }

  const deliver =
    dispatch.kind === 'draft'
      ? (): Promise<{ readonly externalId: string }> =>
          adapter.sendDraft(dispatch.draftExternalId, idemKey)
      : (): Promise<{ readonly externalId: string }> =>
          adapter.performAction(row.action_class, dispatch.payload, idemKey);

  let resolution: FailureResolution;
  let sendFailure: string | null = null;
  let readBackFailure: string | null = null;
  try {
    await deliver();
    // Send first. Only now, with the send resolved, set the status second.
    await pool.query(
      "UPDATE outbox SET status = 'sent' WHERE run_id = $1 AND step_id = $2 AND status = 'pending'",
      [row.run_id, row.step_id],
    );
    return { idemKey, outcome: 'sent' };
  } catch (sendError) {
    // The throw leaves the delivery state unknown unless the adapter can
    // read it back (DEC-30). A read-back that itself throws leaves the
    // state unknown too: pass null so the matrix escalates instead of
    // letting the error turn a failed send into a blind retry.
    //
    // Both causes are recorded. The relay is the component whose failures
    // decide DEC-30, and it used to discard them: rotated SMTP credentials
    // produced an endless stream of left_pending_retry with no line anywhere
    // naming the authentication failure, and a readBack that throws on every
    // call manufactures delivery_unknown escalations that look exactly like
    // genuine ones.
    sendFailure = errorText(sendError);
    let readBack: DeliveryState | null = null;
    if (adapter.capabilities.supportsReadBack) {
      try {
        readBack = await adapter.readBack({ idemKey });
      } catch (readBackError) {
        readBack = null;
        readBackFailure = errorText(readBackError);
      }
    }
    // Read the rule before it can throw over the top of the send failure:
    // assertDeliveryRule only ever runs on this path, so an unknown value
    // would replace the error that actually matters.
    let rule;
    try {
      rule = assertDeliveryRule(row.delivery);
    } catch (ruleError) {
      throw new Error(
        `${errorText(ruleError)} (the send had already failed with: ${sendFailure})`,
      );
    }
    resolution = resolveSendFailure(adapter.capabilities, rule, readBack);
  }

  // Carried on every non-'sent' outcome below, so the daemon can log a cause.
  const causes = {
    ...(sendFailure === null ? {} : { sendError: sendFailure }),
    ...(readBackFailure === null ? {} : { readBackError: readBackFailure }),
  };

  switch (resolution.action) {
    case 'mark_sent': {
      await pool.query(
        "UPDATE outbox SET status = 'sent' WHERE run_id = $1 AND step_id = $2 AND status = 'pending'",
        [row.run_id, row.step_id],
      );
      return { idemKey, ...causes, outcome: 'sent_reconciled' };
    }
    case 'leave_pending':
      return { idemKey, ...causes, outcome: 'left_pending_retry' };
    case 'escalate': {
      // One transaction: the record states the uncertainty
      // (`delivery_unknown`) and the run moves to the approval path.
      // No approval-queue table exists yet; the escalated run plus this
      // status is the hand-off signal until that card lands.
      await parkEscalated(
        pool,
        row,
        'delivery_unknown',
        sendFailure === null ? undefined : `delivery_unknown: ${sendFailure}`,
      );
      return { idemKey, ...causes, outcome: 'delivery_unknown_escalated' };
    }
  }
}

/**
 * Park one unrelayable record and its run in one transaction (DEC-04):
 * `status` states what went wrong on the record, the run moves to the
 * approval path. Terminal for the relay — a later scan finds nothing.
 *
 * `escalated` is a terminal state, so the move stamps `finished_at` exactly
 * as the ledger path does (db/005_run_timing.sql). Without the stamp the
 * service-time measurement silently omits every run the relay escalated,
 * which is the population the measurement most needs.
 */
async function parkEscalated(
  pool: Pool,
  row: PendingOutboxRow,
  status: string,
  reason?: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "UPDATE outbox SET status = $3 WHERE run_id = $1 AND step_id = $2 AND status = 'pending'",
      [row.run_id, row.step_id, status],
    );
    await client.query(
      "UPDATE run SET state = 'escalated', finished_at = now() WHERE run_id = $1",
      [row.run_id],
    );
    // The escalations view reads its reason from a journaled escalate step.
    // Without this row every relay escalation listed with reason null, which
    // reads the same as any other escalation and names no cause.
    await client.query(
      // step_id is exactly 'escalate': that is the id the escalations view
      // joins on. One per run, so a repeat keeps the first reason.
      `INSERT INTO step_journal (run_id, step_id, status, result, prompt_ver, model_ver, cost_micros)
       VALUES ($1, $2, 'done', $3::jsonb, 'relay', 'relay', 0)
       ON CONFLICT (run_id, step_id) DO NOTHING`,
      [
        row.run_id,
        'escalate',
        JSON.stringify({ reason: reason ?? `relay_${status}` }),
      ],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
