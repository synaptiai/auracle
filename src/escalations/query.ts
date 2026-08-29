/**
 * Read-only escalation queries for the operator CLI (decision D9-A).
 *
 * Answers "what needs a person right now and why" from the ledger alone:
 *   - runs parked in `escalated` or `awaiting_approval` state, joined with
 *     the `escalate` journal step (the coordinator's EscalationReason) and
 *     the `park` journal step (the gated draft, where present)
 *   - outbox records stuck in `delivery_unknown` or `malformed` (DEC-30: no retry, the
 *     approval path), even when the run state read differs
 *
 * Every statement is a SELECT. The module never writes, so it is safe to
 * run against a live database without approval.
 */
import type { Pool, PoolClient } from 'pg';

/** One item that needs a person. */
export interface EscalationItem {
  readonly runId: string;
  readonly ticketId: string;
  readonly state: string;
  /** Coordinator reason from the `escalate` step; null when not journaled. */
  readonly reason: string | null;
  /** Outbox status when a record is stuck: `delivery_unknown` or `malformed`. */
  readonly outboxStatus: string | null;
  /** Park-record fields; present only on the gated path. */
  readonly draftExternalId: string | null;
  readonly actionClass: string | null;
  readonly delivery: string | null;
  readonly costMicros: number;
  readonly stepsUsed: number;
}

export interface EscalationFilters {
  /** ISO timestamp or relative duration (e.g. `24h`, `7d`). See parseSince. */
  readonly since?: string;
  /** `escalated`, `awaiting_approval` or `delivery_unknown`. */
  readonly state?: string;
}

const RUN_SELECT = `
  SELECT r.run_id            AS run_id,
         r.ticket_id         AS ticket_id,
         r.state             AS state,
         r.cost_micros        AS cost_micros,
         r.steps_used        AS steps_used,
         esc.result ->> 'reason'          AS reason,
         park.result ->> 'draftExternalId' AS draft_external_id,
         park.result ->> 'actionClass'     AS action_class,
         park.result ->> 'delivery'        AS delivery,
         o.status             AS outbox_status
    FROM run r
    LEFT JOIN step_journal esc
      ON esc.run_id = r.run_id AND esc.step_id = 'escalate'
    LEFT JOIN step_journal park
      ON park.run_id = r.run_id AND park.step_id = 'park'
    LEFT JOIN LATERAL (
      SELECT status FROM outbox
       WHERE run_id = r.run_id AND status IN ('delivery_unknown', 'malformed')
       LIMIT 1
    ) o ON TRUE
   WHERE r.state IN ('escalated', 'awaiting_approval')`;

// DEC-30 says an unknown delivery always escalates the run in one
// transaction, so this normally finds nothing new. It stays so the CLI
// still surfaces a stuck record whose run row reads differently.
const OUTBOX_SELECT = `
  SELECT o.run_id            AS run_id,
         r.ticket_id         AS ticket_id,
         r.state             AS state,
         r.cost_micros        AS cost_micros,
         r.steps_used        AS steps_used,
         esc.result ->> 'reason'           AS reason,
         park.result ->> 'draftExternalId' AS draft_external_id,
         park.result ->> 'actionClass'     AS action_class,
         park.result ->> 'delivery'        AS delivery,
         o.status             AS outbox_status
    FROM outbox o
    JOIN run r ON r.run_id = o.run_id
    LEFT JOIN step_journal esc
      ON esc.run_id = r.run_id AND esc.step_id = 'escalate'
    LEFT JOIN step_journal park
      ON park.run_id = r.run_id AND park.step_id = 'park'
   WHERE o.status IN ('delivery_unknown', 'malformed')`;

function toItem(row: Record<string, unknown>): EscalationItem {
  return {
    runId: row['run_id'] as string,
    ticketId: row['ticket_id'] as string,
    state: row['state'] as string,
    reason: (row['reason'] as string | null) ?? null,
    outboxStatus: (row['outbox_status'] as string | null) ?? null,
    draftExternalId: (row['draft_external_id'] as string | null) ?? null,
    actionClass: (row['action_class'] as string | null) ?? null,
    delivery: (row['delivery'] as string | null) ?? null,
    costMicros: row['cost_micros'] as number,
    stepsUsed: row['steps_used'] as number,
  };
}

/**
 * Parse a `--since` value into an absolute cutoff Date. Accepts an ISO 8601
 * timestamp or a relative duration like `45m`, `24h` or `7d`. Throws on
 * anything else — the CLI must never silently drop items.
 */
export function parseSince(value: string): Date {
  const match = /^(\d+)([mhd])$/.exec(value);
  if (match !== null) {
    const amount = Number(match[1]);
    const unitMs = { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as 'm' | 'h' | 'd'];
    return new Date(Date.now() - amount * unitMs);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(
      `--since must be an ISO timestamp or a duration like 24h, got: ${value}`,
    );
  }
  return parsed;
}

/**
 * List everything that needs a person. Read-only: two SELECTs merged by
 * run id, newest ticket arrival first when the intake row is known.
 */
export async function listEscalations(
  pool: Pool | PoolClient,
  filters?: EscalationFilters,
): Promise<EscalationItem[]> {
  const params: unknown[] = [];
  let where = '';
  if (filters?.since !== undefined) {
    const cutoff = parseSince(filters.since);
    // Arrival time of the ticket is the only clock the ledger keeps for a
    // run (intake.enqueued_at). Items with no intake row are kept: a
    // missing proxy timestamp must not hide an escalation.
    //
    // MIN, because a ticket may hold several queued messages since the key
    // became (ticket_id, message_id). A bare scalar subquery threw as soon
    // as a second message arrived, and the earliest arrival is the one that
    // answers "has this ticket been waiting since the cutoff".
    params.push(cutoff.toISOString());
    where += `
       AND (NOT EXISTS (SELECT 1 FROM intake WHERE intake.ticket_id = r.ticket_id)
            OR (SELECT MIN(enqueued_at) FROM intake WHERE intake.ticket_id = r.ticket_id) >= $1::timestamptz)`;
  }

  const runs = await pool.query(RUN_SELECT + where + ' ORDER BY r.ticket_id', params);
  const stuck = await pool.query(OUTBOX_SELECT + ' ORDER BY o.run_id', []);

  const byRun = new Map<string, EscalationItem>();
  for (const row of runs.rows as unknown as Record<string, unknown>[]) {
    const item = toItem(row);
    byRun.set(item.runId, item);
  }
  for (const row of stuck.rows as unknown as Record<string, unknown>[]) {
    const item = toItem(row);
    const existing = byRun.get(item.runId);
    if (existing === undefined) {
      byRun.set(item.runId, item);
    } else if (existing.outboxStatus === null) {
      byRun.set(item.runId, { ...existing, outboxStatus: item.outboxStatus });
    }
  }

  let items = [...byRun.values()];
  if (filters?.state !== undefined) {
    const wanted = filters.state;
    // 'delivery_unknown' names the stuck-outbox view, not one status value.
    // db/006 added 'malformed' and parkEscalated writes it, but nothing read
    // it: such a run showed up with a null outbox status, indistinguishable
    // from any other escalation, and this filter excluded it outright.
    items =
      wanted === 'delivery_unknown'
        ? items.filter(
            (item) =>
              item.outboxStatus === 'delivery_unknown' || item.outboxStatus === 'malformed',
          )
        : items.filter((item) => item.state === wanted);
  }
  return items.sort((a, b) => (a.ticketId < b.ticketId ? -1 : a.ticketId > b.ticketId ? 1 : 0));
}
