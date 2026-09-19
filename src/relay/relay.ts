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
import type { Pool, PoolClient } from 'pg';

// The relay routes by negation: only a customer reply takes the draft
// path, so it never names the other classes.
import { CUSTOMER_REPLY_ACTION_CLASS } from '../adapters/types.js';
import type { LedgerReply } from '../adapters/types.js';

import type {
  AdapterCapabilities,
  DeliveryState,
  EgressAdapter,
} from '../adapters/types.js';
import { errorMessage } from '../errors.js';
import { journalStep } from '../ledger/journal-write.js';
import { runStateClass } from '../ledger/run-state.js';

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
  return errorMessage(error);
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
    | 'fenced' // DEC-28 at send time, for a run that has not finished
    // DEC-51: nothing was sent, and nothing is wrong. The record is held, or
    // a person undid the approval while this scan walked up to it.
    | 'held'
    | 'undone'
    // Another scan settled the record between this scan's read and the lock.
    | 'already_settled';
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
  /**
   * DEC-44: the reply this record sends, when the ledger holds it rather
   * than the helpdesk. Null on the DEC-40 draft path, where the parked copy
   * is what sends.
   */
  reply: unknown;
  /**
   * DEC-51: the moment this record may be sent. Null is no hold. The scan
   * does not select a row whose `not_before` is in the future, and the send
   * re-reads it under the run's lock, so the boundary is checked twice.
   */
  not_before: Date | null;
}

/**
 * Every record currently awaiting relay, in stable idem-key order so
 * repeated passes meet them in the same sequence.
 */
export async function pendingRows(pool: Pool): Promise<PendingOutboxRow[]> {
  const rows = await pool.query(
    `SELECT o.run_id, o.step_id, r.ticket_id, o.idem_key, o.epoch,
            o.delivery, o.action_class, o.payload, o.reply, o.not_before
     FROM outbox o JOIN run r ON r.run_id = o.run_id
     WHERE o.status = 'pending'
       AND (o.not_before IS NULL OR o.not_before <= clock_timestamp())
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
  | { readonly kind: 'ledger'; readonly reply: LedgerReply }
  | { readonly kind: 'action'; readonly payload: Record<string, unknown> };

/**
 * The reply the ledger holds, as the adapter takes it (DEC-44).
 *
 * Shape-checked here rather than trusted. The column is jsonb, and a record
 * whose reply cannot be read is a record that cannot be sent: throwing here
 * escalates it as malformed, which is the outcome for a payload nothing can
 * deliver. Nothing was sent, so there is no delivery state to reconcile.
 *
 * `draftExternalId` comes from the payload and not from the reply. It is the
 * handle that addresses the ticket, and it is what the park recorded; a
 * reply that named its own handle could point the send at another thread.
 */
function ledgerReplyFrom(value: unknown, draftExternalId: string): LedgerReply {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PayloadShapeError(
      'outbox reply is missing for an adapter that sends the reply the ledger holds (DEC-44)',
    );
  }
  const record = value as Record<string, unknown>;
  const bodyText = record['bodyText'];
  const disclosure = record['disclosure'];
  const provenance = record['provenance'];
  if (typeof bodyText !== 'string' || bodyText.length === 0) {
    throw new PayloadShapeError('outbox reply carries no bodyText');
  }
  if (typeof disclosure !== 'string' || disclosure.length === 0) {
    throw new PayloadShapeError('outbox reply carries no disclosure (DEC-14)');
  }
  if (typeof provenance !== 'object' || provenance === null || Array.isArray(provenance)) {
    throw new PayloadShapeError('outbox reply carries no provenance (DEC-33)');
  }
  const trail = provenance as Record<string, unknown>;
  const read = (field: string): string => {
    const held = trail[field];
    if (typeof held !== 'string' || held.length === 0) {
      throw new PayloadShapeError(`outbox reply provenance carries no ${field}`);
    }
    return held;
  };
  return {
    draftExternalId,
    bodyText,
    disclosure,
    provenance: {
      generatedBy: read('generatedBy'),
      modelId: read('modelId'),
      promptVer: read('promptVer'),
      generatedAt: read('generatedAt'),
    },
  };
}

function dispatchFor(row: PendingOutboxRow, ledgerHoldsReply: boolean): Dispatch {
  const payload = row.payload;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new PayloadShapeError(
      `outbox payload must be a JSON object, got ${payload === null ? 'null' : typeof payload}`,
    );
  }
  const record = payload as Record<string, unknown>;
  if (row.action_class === CUSTOMER_REPLY_ACTION_CLASS) {
    const draftExternalId = draftExternalIdFrom(record);
    // DEC-44: where the target cannot send the copy it parks, the approval
    // recorded the reply and this record carries it. The handle still
    // addresses the ticket; it names the copy that was parked, never a body
    // to read at send time.
    if (ledgerHoldsReply) {
      return { kind: 'ledger', reply: ledgerReplyFrom(row.reply, draftExternalId) };
    }
    // And the mirror: a record that carries a reply, handed to an adapter
    // that cannot send one. The two processes answer this from their own
    // environments, so the relay and the console can disagree — and sending
    // the parked copy would discard the text a person approved, in silence,
    // while the ledger recorded that text as what went out. Nothing can
    // deliver this record, so it escalates for a person to read.
    if (row.reply !== null && row.reply !== undefined) {
      throw new PayloadShapeError(
        'this record carries the reply the ledger holds, and this adapter cannot send it '
          + '(DEC-44): set the adapter\'s capability in the relay as the console has it, or '
          + 'reconcile the record by hand',
      );
    }
    return { kind: 'draft', draftExternalId };
  }
  // The ledger owns the ticket identity; a stale or missing field in the
  // stored payload cannot redirect the write.
  return {
    kind: 'action',
    payload: { ...record, ticketExternalId: row.ticket_id },
  };
}

/**
 * What the send-time fence check needs about one record: the ticket's fence
 * and the state of the run that wrote the record.
 *
 * `runState` is the empty string when the ledger holds no run row for the
 * record, and `fence` is null with it. Nothing in `db/` declares a foreign
 * key from `outbox.run_id`, so the ledger would accept such a row — but the
 * scan's own query inner-joins `run` (`pendingRows`), so the relay never
 * reads one. A hand-built row is sent, exactly as before this change:
 * `fence === null` refuses nothing. The empty state still reads as in flight
 * for every row the scan does return, which is the fail-closed reading where
 * a state this code does not know is governed rather than licensed.
 */
interface FenceReading {
  readonly fence: bigint | null;
  readonly runState: string;
}

async function fenceFor(pool: Pool, runId: string): Promise<FenceReading> {
  const current = await pool.query(
    `SELECT te.epoch, r.state FROM run r
     LEFT JOIN ticket_epoch te ON te.ticket_id = r.ticket_id
     WHERE r.run_id = $1`,
    [runId],
  );
  const row = current.rows[0];
  if (row === undefined) {
    return { fence: null, runState: '' };
  }
  const epoch = row['epoch'] as string | null;
  return {
    fence: epoch === null ? null : BigInt(epoch),
    runState: row['state'] as string,
  };
}

/**
 * Whether the row read under the lock is the row this scan read.
 *
 * Identity, action semantics and content: the fields that decide what would
 * be sent. The undo deletes a record, so a re-approval can insert a new one
 * at the same key, and a payload compared only by key would be sent as if it
 * were the row the scan selected.
 */
function sameRecord(scanned: PendingOutboxRow, locked: {
  idem_key: string; epoch: string; action_class: string; delivery: string;
  payload: unknown; reply: unknown;
}): boolean {
  return locked.idem_key === scanned.idem_key
    && locked.epoch === scanned.epoch
    && locked.action_class === scanned.action_class
    && locked.delivery === scanned.delivery
    && JSON.stringify(locked.payload ?? null) === JSON.stringify(scanned.payload ?? null)
    && JSON.stringify(locked.reply ?? null) === JSON.stringify(scanned.reply ?? null);
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
  //
  // Issue #113: the check sends a record whose run has finished, whatever the
  // fence says. Such a record is settled by its DEC-24 key and its DEC-29
  // delivery rule, and refusing it dropped an approved reply the relay had
  // never sent — nothing escalated, and the run read `resolved` as if the
  // customer had been answered. Every other run keeps the refusal: an
  // in-flight run because the fence moved under it, and a parked one because
  // nothing approved its record (DEC-12) — which is unreachable in this
  // codebase, since a park inserts none, and refused all the same.
  //
  // A refusal escalates the run in the same transaction, because a person has
  // to see a record that will never send. The escalation is also the recovery
  // path, and not a hand-off to a re-run: the refused row keeps its key, so a
  // later attempt at the same action collides with it and lands `superseded`.
  // Nothing carries that action twice, and nothing else carries it at all.
  const { fence, runState } = await fenceFor(pool, row.run_id);
  if (fence !== null && BigInt(row.epoch) < fence && runStateClass(runState) !== 'terminal') {
    await parkEscalated(
      pool,
      row,
      'fenced',
      `fenced_stale_epoch: the ticket fence (${fence.toString()}) rose above`
        + ` this record's epoch (${row.epoch}) while its run was in flight`,
    );
    return { idemKey, outcome: 'fenced' };
  }

  // Route by action semantics before any adapter call. A payload that
  // matches no known shape is a defect, not a transient failure: nothing
  // was sent, so there is no delivery state to reconcile — the record
  // escalates instead of livelocking in pending.
  let dispatch: Dispatch;
  try {
    dispatch = dispatchFor(row, adapter.capabilities.supportsLedgerReply);
  } catch (error) {
    if (!(error instanceof PayloadShapeError)) throw error;
    await parkEscalated(pool, row, 'malformed', `malformed_payload: ${errorText(error)}`);
    return { idemKey, outcome: 'malformed_escalated' };
  }

  // Three deliveries, chosen by what the record routes to. DEC-44 adds the
  // middle one: on an adapter whose helpdesk cannot send the copy it parks,
  // the approved reply travels on the record and this is what sends it.
  const deliver =
    dispatch.kind === 'draft'
      ? (): Promise<{ readonly externalId: string }> =>
          adapter.sendDraft(dispatch.draftExternalId, idemKey)
      : dispatch.kind === 'ledger'
        ? (): Promise<{ readonly externalId: string }> =>
            adapter.sendLedgerReply(dispatch.reply, idemKey)
        : (): Promise<{ readonly externalId: string }> =>
            adapter.performAction(row.action_class, dispatch.payload, idemKey);

  let resolution: FailureResolution;
  let sendFailure: string | null = null;
  let readBackFailure: string | null = null;
  // Whether an adapter call was reached (DEC-51, DEC-30). Declared out here
  // because the catch below reads it, and a `let` inside the try block is not
  // in scope in the catch that block pairs with. Every fault before the call
  // — the pool handing out no connection, BEGIN, a `FOR UPDATE` read, the
  // status check, the record comparison — is a fault of this process, and
  // DEC-30's matrix must not be asked about a delivery that was never
  // attempted: for an adapter with no idempotency key and no read-back it
  // answers `escalate`, so the record would leave the pending scan and a
  // person would reconcile a reply the ledger can still send.
  let attempted = false;
  try {
    // DEC-51: the send runs under the record's row lock and the run's, and the
    // record is read again inside them. An undo takes the same locks, so the
    // two cannot interleave: whoever holds them first decides, and the other
    // finds the record gone (the undo deleted it) or settled. The scan
    // already excludes a record whose moment is ahead; the re-read refuses one
    // whose moment is still ahead when the locks are finally taken.
    //
    // The locks are held across the send. That is the cost of an undo that can
    // promise nothing was sent, and it is bounded by the adapter's own
    // timeouts: fifteen seconds for FreeScout, and for the mail adapter the
    // ones it now sets from its configuration.
    let settled: 'held' | 'undone' | 'already_settled' | null = null;
    const client = await pool.connect();
    let rollbackError: unknown = null;
    try {
      await client.query('BEGIN');
      // The outbox row first, then the run. `parkEscalated` takes the outbox
      // row first too, and so does the undo: one order for every writer that
      // touches both, or two of them deadlock.
      const record = await client.query<{
        status: string;
        held: boolean;
        idem_key: string;
        epoch: string;
        action_class: string;
        delivery: string;
        payload: unknown;
        reply: unknown;
      }>(
        `SELECT status, idem_key, epoch, action_class, delivery, payload, reply,
                (not_before IS NOT NULL AND not_before > clock_timestamp()) AS held
           FROM outbox WHERE run_id = $1 AND step_id = $2 FOR UPDATE`,
        [row.run_id, row.step_id],
      );
      const held = record.rows[0];
      if (held === undefined) {
        await client.query('COMMIT');
        settled = 'undone';
      } else {
        // No row for a run that is gone, and no lock either. Such a record
        // still sends: nothing holds it, and no undo can name a run the
        // ledger does not hold.
        await client.query('SELECT run_id FROM run WHERE run_id = $1 FOR UPDATE', [row.run_id]);
        if (held.status !== 'pending') {
          // Another scan sent it, or refused it, between this scan's read and
          // these locks. Sending again would deliver a second copy.
          await client.query('COMMIT');
          settled = 'already_settled';
        } else if (held.held) {
          await client.query('COMMIT');
          settled = 'held';
        } else if (!sameRecord(row, held)) {
          // The row under the lock is not the row this scan read. The undo
          // deletes a record, so a re-approval can insert a new one at the
          // same key: sending this scan's copy would deliver text that
          // approval never carried.
          await client.query('COMMIT');
          settled = 'already_settled';
        } else {
          attempted = true;
          await deliver();
          // Send first. Only now, with the send resolved, set the status
          // second, in the same transaction that held both locks.
          await client.query(
            "UPDATE outbox SET status = 'sent' WHERE run_id = $1 AND step_id = $2 AND status = 'pending'",
            [row.run_id, row.step_id],
          );
          await client.query('COMMIT');
        }
      }
    } catch (error) {
      await client.query('ROLLBACK').catch((failed: unknown) => {
        rollbackError = failed;
        console.error(
          JSON.stringify({
            event: 'rollback_failed',
            at: new Date().toISOString(),
            error: errorText(failed),
          }),
        );
      });
      throw error;
    } finally {
      destroyIfRollbackFailed(client, rollbackError);
    }
    if (settled !== null) return { idemKey, outcome: settled };
    return { idemKey, outcome: 'sent' };
  } catch (sendError) {
    // Nothing was attempted, so there is no delivery to reconcile. The throw
    // goes to the daemon, which logs this record and leaves it pending: the
    // next scan sends it.
    if (!attempted) throw sendError;
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
 * `status` states what went wrong on the record, and the run stops in a state
 * an operator reads. Terminal for the relay — a later scan finds nothing.
 *
 * Three cases reach it, and the reason names which: a send whose delivery
 * state is unknown (DEC-30), a payload matching no known shape, and — since
 * issue #113 — a record the fence refuses while its run is still in flight.
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
  
  let rolledBack: unknown = null;
const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // The record's own write is the token for this whole move. Two scans can
    // hold the same row as pending — two relay processes, or a rolling
    // restart — and the fence this decision rests on was read before this
    // transaction opened. So a scan that finds nothing to mark must not move
    // the run: the other scan either sent the record (the run stays as it
    // was, and an escalation would report a reply that went out) or refused
    // it and escalated the run itself.
    const marked = await client.query(
      "UPDATE outbox SET status = $3 WHERE run_id = $1 AND step_id = $2 AND status = 'pending'",
      [row.run_id, row.step_id, status],
    );
    if ((marked.rowCount ?? 0) === 0) {
      await client.query('COMMIT');
      return;
    }
    await client.query(
      "UPDATE run SET state = 'escalated', finished_at = now() WHERE run_id = $1",
      [row.run_id],
    );
    // The escalations view reads its reason from a journaled escalate step.
    // Without this row every relay escalation listed with reason null, which
    // reads the same as any other escalation and names no cause.
    await journalStep(
      client,
      {
        runId: row.run_id,
        // step_id is exactly 'escalate': that is the id the escalations view
        // joins on.
        stepId: 'escalate',
        status: 'done',
        result: { reason: reason ?? `relay_${status}` },
        // Not a model step: 'relay' names what wrote the row.
        promptVer: 'relay',
        modelVer: 'relay',
        costMicros: 0,
      },
      // One per run, so a repeat keeps the first reason rather than raising
      // a duplicate key inside this transaction.
      { ifAbsent: true },
    );
    await client.query('COMMIT');
  } catch (error) {
    // As elsewhere in this codebase: a rollback that throws must not replace
    // the cause, and is reported rather than dropped. The caller logs the
    // cause, and the record stays pending for the next scan either way.
    await client.query('ROLLBACK').catch((rollbackError: unknown) => {
      rolledBack = rollbackError;
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
    // Every path, including the one that commits: a client released only in
    // the catch is one the successful path never gives back, and a pool of
    // those hangs on the next `connect()`.
    destroyIfRollbackFailed(client, rolledBack);
  }
}

/**
 * Give the connection back, or destroy it.
 *
 * A connection whose rollback failed is a connection whose transaction state
 * nobody read: pg destroys one released with an error rather than returning
 * it to the pool, where the next borrower would inherit an aborted
 * transaction — and, worse, the row locks this one still holds.
 */
function destroyIfRollbackFailed(client: PoolClient, rollbackError: unknown): void {
  if (rollbackError === null) client.release();
  else client.release(rollbackError as Error);
}
