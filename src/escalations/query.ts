/**
 * Read-only escalation queries for the operator CLI (decision D9-A).
 *
 * Answers "what needs a person right now and why" from the ledger alone:
 *   - runs parked in `escalated` or `awaiting_approval` state, joined with
 *     the `escalate` journal step (the coordinator's EscalationReason) and
 *     the `park` journal step (the gated draft, where present)
 *   - outbox records stuck in `delivery_unknown`, `malformed` or `not_sent`
 *     (DEC-30: no retry, the approval path), even when the run state read differs
 *
 * Every statement is a SELECT. The module never writes, so it is safe to
 * run against a live database without approval.
 */
import { CUSTOMER_REPLY_ACTION_CLASS } from '../adapters/types.js';
import { RUN_STATES } from '../coordinator/coordinator.js';
import type { TerminalRunState } from '../coordinator/coordinator.js';
import type { Pool, PoolClient } from 'pg';

import { agreementThresholdFromJournal, readGateThresholds } from '../journal/query.js';
import { RISK_TIERS } from '../domain/capabilities.js';
import type { RiskTier } from '../domain/capabilities.js';

/** One item that needs a person. */
export interface EscalationItem {
  readonly runId: string;
  readonly ticketId: string;
  readonly state: string;
  /** Coordinator reason from the `escalate` step; null when not journaled. */
  readonly reason: string | null;
  /**
   * What the reason does not say, from the same `escalate` row.
   *
   * `internal_fault` names a defect inside the coordinator rather than a step,
   * so the invariant message is the whole of what an operator has to go on
   * (issue #94). The runbook tells them to quote it into an issue, and it was
   * written to the ledger and projected by nothing — reachable only by
   * hand-written SQL, which this repository's own session hooks refuse against
   * a live database.
   *
   * Null for every other reason: no other escalate row writes the key.
   *
   * Untrimmed, unlike `reason`. `CoordinatorFaultError` requires the message
   * to interpolate only what this system named itself, and `pnpm run
   * escalations` is a command rather than an unauthenticated page. The console
   * never receives it: `toRow` and `toDetail` name the fields they carry, and
   * `views.test.ts` holds that shut.
   */
  readonly fault: string | null;
  /**
   * The policy rule that sent this run to a person, from the `gate` step.
   *
   * Distinct from `reason` above, and the distinction is the whole point. A
   * run awaiting approval has not escalated, so `reason` is null for every
   * one of them by construction — the approval queue printed "no reason
   * journalled" on all 161 waiting runs while the ledger held the answer.
   *
   * This is the answer: `customer_visible`, `high_risk`, `irreversible`,
   * `no_idempotency` or a threshold. It is the first thing a person working
   * the queue needs, because it says why the run is theirs.
   */
  readonly gateReason: string | null;
  /** The classified intent, or null when the run journalled none. */
  readonly intentId: string | null;
  /** Groundedness coverage the gate read, or null when it never gated. */
  readonly coverage: number | null;
  /**
   * Sample agreement the classifier measured, or null when it journalled no
   * number.
   *
   * Carried apart from coverage and never combined with it (DEC-05). The
   * queue sets apart a case whose two gates each cleared their own line, and
   * that needs each value beside its own threshold.
   */
  readonly agreement: number | null;
  /**
   * The agreement line the gate judged this run against: the per-intent value
   * when the gate held one for this intent, otherwise the global value. Null
   * when the gate row holds no threshold set it can read.
   */
  readonly agreementThreshold: number | null;
  /** The coverage review line from the same gate row, or null. */
  readonly coverageReviewThreshold: number | null;
  /**
   * The risk tier the gate judged the intent at (DEC-13), or null.
   *
   * Null for a gate row written before the gate recorded one, and for a value
   * outside the taxonomy's closed set.
   */
  readonly riskTier: RiskTier | null;
  /**
   * When the ledger opened the run.
   *
   * Every surface that orders by time now states the time. The runs list
   * said "newest first" and the approval queue said "the oldest is on it",
   * and neither showed a date — while `pnpm run latency` reports p99 service
   * times in hours, so age is exactly the quantity a person is triaging on.
   */
  readonly createdAt: Date | null;
  /**
   * DEC-48: when this run's snooze is due back, or null.
   *
   * Kept after the run returns to the queue, so a reader can tell a run that
   * was put aside from one that never was.
   */
  readonly snoozedUntil: Date | null;
  /**
   * DEC-49: when a reviewer sent this run back, or null.
   *
   * Read so a surface can tell a run a person rejected from one that reached
   * `superseded` another way — a run the customer's next message replaced, or
   * one that lost its outbox key. The state alone cannot: three writers land a
   * run there, and only one of them is a send-back.
   */
  readonly sentBackAt: Date | null;
  /**
   * DEC-49: whether the attempt this run is on was sent back — its turn is on
   * a later attempt. The approval, the save and the rewrite refuse such a
   * run, and a surface reads this to say so only where it is true.
   */
  readonly attemptRejected: boolean;
  /**
   * DEC-49: whether the turn already holds a reply that went out, may have,
   * or will. The approval refuses such a turn, and a surface reads this to
   * say so only where it is true.
   */
  readonly turnClosed: boolean;
  /**
   * DEC-48: whether a person wrote the reply this run holds.
   *
   * It says why `coverage` above is null on such a run: the gate judged the
   * draft, and the reply the customer receives is not the draft. A reader
   * that showed a blank without this would be reporting a missing verdict
   * where the ledger holds one about other text.
   */
  readonly replyRewritten: boolean;
  /** Outbox status when a record is stuck: `delivery_unknown`, `malformed` or `not_sent`. */
  readonly outboxStatus: string | null;
  /**
   * The prompt version the run was pinned to.
   *
   * Surfaced because this is the queue a person works from, and a seeded run
   * reaches it exactly like a produced one: a backdated history writes runs
   * in `escalated` and `awaiting_approval`, which are the two states this
   * report selects. Nothing else here distinguishes them, so an operator
   * pointed at a demo database would work a synthetic backlog as real
   * customer escalations. `pnpm run seed-history` pins `seed`.
   */
  readonly promptVer: string;
  /** Park-record fields; present only on the gated path. */
  readonly draftExternalId: string | null;
  /**
   * Whether the park journalled an action payload (DEC-34).
   *
   * A gated write with no customer draft parks in the ledger alone, and
   * `approveRun` relays that payload through `performAction`. Without this
   * the console could not tell such a run from one that parked nothing, so
   * it offered no approval at all — 51 of 161 waiting runs were a dead end
   * on a surface whose whole job is approving them.
   */
  readonly payloadRecorded: boolean;
  /**
   * The payload the approval will perform, when the park recorded one.
   *
   * DEC-40 lets a console approve because the approver reads what they are
   * approving. A ledger-only park has no drafted reply, so this is the whole
   * of what they are about to do.
   */
  readonly payload: Readonly<Record<string, unknown>> | null;
  readonly actionClass: string | null;
  readonly delivery: string | null;
  /**
   * Whether an approval recorded this run's approver (DEC-42).
   *
   * Every approval records one, `unattributed` included, and nothing else
   * writes the column. So a surface can tell an approved run from one that
   * never was, whatever the relay did with its send afterwards. The name is
   * not carried: this read feeds an unauthenticated page.
   */
  readonly approved: boolean;
  /**
   * DEC-47: the product of the channel this run's message arrived on, or
   * null when that channel mapped to no product. The queue groups and
   * narrows on it; a null is its own value there, not an absence to hide.
   */
  readonly product: string | null;
  readonly costMicros: number;
  readonly stepsUsed: number;
}

export interface EscalationFilters {
  /** ISO timestamp or relative duration (e.g. `24h`, `7d`). See parseSince. */
  readonly since?: string;
  /** `escalated`, `awaiting_approval` or `delivery_unknown`. */
  readonly state?: string;
}

/**
 * The ledger states a run may sit in.
 *
 * The list is closed because `runSelectFor` interpolates it: a state set is
 * a fixed vocabulary, not user input, and Postgres cannot bind an IN list of
 * unknown length. Interpolating a checked member of a closed set is the same
 * discipline `LISTEN` uses for its channel name.
 */
export const TERMINAL_RUN_STATES = [
  'resolved',
  'escalated',
  'superseded',
  'abandoned',
  // DEC-48: a reviewer closed the case with no reply. A terminal state the
  // coordinator never walks a run to, and one a person reaches.
  'closed',
] as const satisfies readonly TerminalRunState[];

export const LEDGER_STATES = [
  ...RUN_STATES,
  // DEC-48: a run that left the walk without ending. It filters like any
  // other state, and the runs surface has to be able to ask for it.
  'snoozed',
  ...TERMINAL_RUN_STATES,
] as const;

/** The two states the escalation queue reports (section 4.3). */
export const RUN_STATES_ESCALATION = ['escalated', 'awaiting_approval'] as const;

/**
 * Guarded reads: no cast that a row can make raise, and a payload tested for
 * an object.
 *
 * `(x ->> 'k')::float8` raises `22P02` on a value that is not a number, and
 * that kills the whole statement rather than one row — the queue an operator
 * came to work goes blank. The `gate_unreadable` path already writes a gate
 * row with a different result shape, so this is a shape the ledger can hold.
 * The same failure once took the run detail down through a `::bytea` cast.
 *
 * A number is not enough either. A jsonb number is arbitrary precision, so
 * `1e400` passes the type test and a float cast raises out of range, as
 * `1e-400` does from the other side. So the statement casts no gate value.
 * It returns a number's text, and `finiteNumber` parses that text the way the
 * run journal parses the same row: as a JavaScript double, kept when it is
 * finite. The queue and the pane beside it read one number from one text, and
 * no row can make the statement raise. A value outside [0, 1] is carried as
 * the ledger holds it, and the queue's grouping refuses to count it. A value
 * too small for a double, such as `1e-400`, reads as zero on both surfaces:
 * it clears no line, because every line is above zero.
 *
 * `payload` is tested for an object rather than for presence. `approveRun`
 * refuses anything else, so a key-exists test would offer a button for a
 * park the approval path throws on — and it throws bare, where every other
 * refusal on that path returns an outcome the console can render.
 */
const RUN_SELECT_BODY = `
  SELECT r.run_id            AS run_id,
         r.ticket_id         AS ticket_id,
         r.state             AS state,
         r.prompt_ver        AS prompt_ver,
         r.cost_micros        AS cost_micros,
         r.steps_used        AS steps_used,
         r.created_at        AS created_at,
         -- DEC-48: when a snoozed case is due back. Null on a run nobody
         -- snoozed, which is not the epoch.
         r.snoozed_until      AS snoozed_until,
         -- DEC-49: the moment a reviewer sent this run back, beside the
         -- state, because the state alone does not say it.
         r.sent_back_at       AS sent_back_at,
         esc.result ->> 'reason'          AS reason,
         esc.result ->> 'fault'           AS fault,
         gate.result ->> 'reason'          AS gate_reason,
         -- DEC-48: whether a person wrote the reply this run would send.
         -- Read from the TURN, not from this run's journal: a turn is served
         -- by every run that answers it, and a sibling run would otherwise
         -- report a reply a person wrote as the model's.
         (saved.saved_reply_provenance IS NOT NULL) AS reply_rewritten,
         -- DEC-49: whether a reviewer sent back the attempt this run is on:
         -- its turn has moved to a later one (db/033).
         COALESCE(saved.attempt > r.attempt, false) AS attempt_rejected,
         -- DEC-49: whether this run is a reply on a turn that already holds
         -- a reply that went out, may have, or will: the approval refuses it.
         -- A reply is a park that names a draft, or one of the reply's class
         -- parked in the ledger alone, the way the approval reads it (#122).
         ((park.result ? 'draftExternalId'
           OR park.result ->> 'actionClass' = '${CUSTOMER_REPLY_ACTION_CLASS}')
          AND EXISTS (SELECT 1 FROM outbox co JOIN run cr ON cr.run_id = co.run_id
                       WHERE cr.conversation_id = r.conversation_id
                         AND cr.turn_number = r.turn_number
                         AND co.payload ? 'draftExternalId'
                         AND co.status IN ('pending', 'sent', 'fenced', 'delivery_unknown')))
           AS turn_closed,
         CASE WHEN jsonb_typeof(gate.result -> 'groundedness') = 'number'
              THEN gate.result ->> 'groundedness' END AS coverage,
         CASE WHEN jsonb_typeof(cls.result -> 'agreement') = 'number'
              THEN cls.result ->> 'agreement' END AS agreement,
         gate.result -> 'thresholds'       AS gate_thresholds,
         gate.result ->> 'riskTier'        AS risk_tier,
         cls.result ->> 'intentId'         AS intent_id,
         (jsonb_typeof(park.result -> 'payload') = 'object') AS payload_recorded,
         CASE WHEN jsonb_typeof(park.result -> 'payload') = 'object'
              THEN park.result -> 'payload' END AS payload,
         -- #123: a handle is a non-empty string on a finished park, as the
         -- conversation reader reads it. The approval refuses a park whose
         -- handle has another shape, so no surface offers it as a draft.
         CASE WHEN park.status = 'done'
               AND jsonb_typeof(park.result -> 'draftExternalId') = 'string'
               AND (park.result ->> 'draftExternalId') <> ''
              THEN park.result ->> 'draftExternalId' END AS draft_external_id,
         park.result ->> 'actionClass'     AS action_class,
         park.result ->> 'delivery'        AS delivery,
         (r.approved_by IS NOT NULL)       AS approved,
         r.product            AS product,
         o.status             AS outbox_status
    FROM run r
    LEFT JOIN step_journal esc
      ON esc.run_id = r.run_id AND esc.step_id = 'escalate'
    LEFT JOIN step_journal park
      ON park.run_id = r.run_id AND park.step_id = 'park'
    LEFT JOIN step_journal gate
      ON gate.run_id = r.run_id AND gate.step_id = 'gate'
    LEFT JOIN step_journal cls
      ON cls.run_id = r.run_id AND cls.step_id = 'classify'
    LEFT JOIN turn saved
      ON saved.conversation_id = r.conversation_id AND saved.turn_number = r.turn_number
    LEFT JOIN LATERAL (
      SELECT status FROM outbox
       WHERE run_id = r.run_id AND status IN ('delivery_unknown', 'malformed', 'not_sent')
       LIMIT 1
    ) o ON TRUE
`;

/**
 * The run SELECT, restricted to the states asked for.
 *
 * One statement serves the escalation queue and the console's runs list. A
 * second copy would be two definitions of what a run row is, and the console
 * exists to display what the jobs produce rather than to redefine it — which
 * is why issue #27 forbids the console its own SQL.
 */
export function runSelectFor(states: readonly string[]): string {
  if (states.length === 0) {
    throw new Error('a run SELECT needs at least one state to select');
  }
  for (const state of states) {
    if (!(LEDGER_STATES as readonly string[]).includes(state)) {
      throw new Error(
        `'${state}' is not a ledger state; the list is interpolated, so it takes `
          + `only members of the closed set (${LEDGER_STATES.join(', ')})`,
      );
    }
  }
  const list = states.map((s) => `'${s}'`).join(', ');
  return `${RUN_SELECT_BODY}   WHERE r.state IN (${list})`;
}

const RUN_SELECT = runSelectFor(RUN_STATES_ESCALATION);

// DEC-30 says an unknown delivery always escalates the run in one
// transaction, so this normally finds nothing new. It stays so the CLI
// still surfaces a stuck record whose run row reads differently.
const OUTBOX_SELECT = `
  SELECT o.run_id            AS run_id,
         r.ticket_id         AS ticket_id,
         r.state             AS state,
         r.prompt_ver        AS prompt_ver,
         r.cost_micros        AS cost_micros,
         r.steps_used        AS steps_used,
         r.created_at        AS created_at,
         esc.result ->> 'reason'           AS reason,
         esc.result ->> 'fault'            AS fault,
         gate.result ->> 'reason'           AS gate_reason,
         -- DEC-48: whether a person wrote the reply this run would send.
         -- Read from the TURN, not from this run's journal: a turn is served
         -- by every run that answers it, and a sibling run would otherwise
         -- report a reply a person wrote as the model's.
         (saved.saved_reply_provenance IS NOT NULL) AS reply_rewritten,
         -- DEC-49: whether a reviewer sent back the attempt this run is on:
         -- its turn has moved to a later one (db/033).
         COALESCE(saved.attempt > r.attempt, false) AS attempt_rejected,
         -- DEC-49: whether this run is a reply on a turn that already holds
         -- a reply that went out, may have, or will: the approval refuses it.
         -- A reply is a park that names a draft, or one of the reply's class
         -- parked in the ledger alone, the way the approval reads it (#122).
         ((park.result ? 'draftExternalId'
           OR park.result ->> 'actionClass' = '${CUSTOMER_REPLY_ACTION_CLASS}')
          AND EXISTS (SELECT 1 FROM outbox co JOIN run cr ON cr.run_id = co.run_id
                       WHERE cr.conversation_id = r.conversation_id
                         AND cr.turn_number = r.turn_number
                         AND co.payload ? 'draftExternalId'
                         AND co.status IN ('pending', 'sent', 'fenced', 'delivery_unknown')))
           AS turn_closed,
         CASE WHEN jsonb_typeof(gate.result -> 'groundedness') = 'number'
              THEN gate.result ->> 'groundedness' END AS coverage,
         CASE WHEN jsonb_typeof(cls.result -> 'agreement') = 'number'
              THEN cls.result ->> 'agreement' END AS agreement,
         gate.result -> 'thresholds'       AS gate_thresholds,
         gate.result ->> 'riskTier'        AS risk_tier,
         cls.result ->> 'intentId'          AS intent_id,
         (jsonb_typeof(park.result -> 'payload') = 'object') AS payload_recorded,
         CASE WHEN jsonb_typeof(park.result -> 'payload') = 'object'
              THEN park.result -> 'payload' END AS payload,
         -- #123: a handle is a non-empty string on a finished park, as the
         -- conversation reader reads it. The approval refuses a park whose
         -- handle has another shape, so no surface offers it as a draft.
         CASE WHEN park.status = 'done'
               AND jsonb_typeof(park.result -> 'draftExternalId') = 'string'
               AND (park.result ->> 'draftExternalId') <> ''
              THEN park.result ->> 'draftExternalId' END AS draft_external_id,
         park.result ->> 'actionClass'     AS action_class,
         park.result ->> 'delivery'        AS delivery,
         (r.approved_by IS NOT NULL)       AS approved,
         r.product            AS product,
         r.snoozed_until      AS snoozed_until,
         r.sent_back_at       AS sent_back_at,
         o.status             AS outbox_status
    FROM outbox o
    JOIN run r ON r.run_id = o.run_id
    LEFT JOIN step_journal esc
      ON esc.run_id = r.run_id AND esc.step_id = 'escalate'
    LEFT JOIN step_journal park
      ON park.run_id = r.run_id AND park.step_id = 'park'
    LEFT JOIN step_journal gate
      ON gate.run_id = r.run_id AND gate.step_id = 'gate'
    LEFT JOIN step_journal cls
      ON cls.run_id = r.run_id AND cls.step_id = 'classify'
    LEFT JOIN turn saved
      ON saved.conversation_id = r.conversation_id AND saved.turn_number = r.turn_number
   WHERE o.status IN ('delivery_unknown', 'malformed', 'not_sent')`;

/**
 * A gate value from the text of a jsonb number: the double JavaScript reads
 * from it, or null when that is not finite.
 *
 * The run journal receives the same row through `JSON.parse` and keeps a
 * finite number. Parsing the same text here gives the same double, so a queue
 * row and the pane beside it never disagree about one value.
 */
function finiteNumber(text: unknown): number | null {
  if (typeof text !== 'string') return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function toItem(row: Record<string, unknown>): EscalationItem {
  const intentId = (row['intent_id'] as string | null) ?? null;
  // The same guard the run journal reads through: a threshold set that is
  // not a set of fractions names no line at all.
  const thresholds = readGateThresholds(row['gate_thresholds']);
  const agreement = row['agreement'];
  return {
    runId: row['run_id'] as string,
    ticketId: row['ticket_id'] as string,
    state: row['state'] as string,
    reason: (row['reason'] as string | null) ?? null,
    fault: (row['fault'] as string | null) ?? null,
    gateReason: (row['gate_reason'] as string | null) ?? null,
    intentId,
    // Null, never zero. A run that never gated has no coverage, and zero is
    // a real reading meaning the judge supported nothing.
    coverage: finiteNumber(row['coverage']),
    // Null, never zero, as for coverage above. A number outside [0, 1] is
    // carried as recorded, as the run journal carries it; a reader that
    // compares it with a line checks the range itself.
    agreement: finiteNumber(agreement),
    agreementThreshold: agreementThresholdFromJournal(intentId, thresholds),
    coverageReviewThreshold: thresholds?.groundednessReview ?? null,
    riskTier: (RISK_TIERS as readonly unknown[]).includes(row['risk_tier'])
      ? row['risk_tier'] as RiskTier
      : null,
    createdAt: row['created_at'] instanceof Date ? row['created_at'] : null,
    snoozedUntil: row['snoozed_until'] instanceof Date ? row['snoozed_until'] : null,
    sentBackAt: row['sent_back_at'] instanceof Date ? row['sent_back_at'] : null,
    attemptRejected: row['attempt_rejected'] === true,
    turnClosed: row['turn_closed'] === true,
    // DEC-48. True only for a row the SELECT says carries a rewrite: a reader
    // that defaulted it to false would report a person's reply as the
    // model's wherever the column was missing.
    replyRewritten: row['reply_rewritten'] === true,
    promptVer: String(row['prompt_ver'] ?? ''),
    outboxStatus: (row['outbox_status'] as string | null) ?? null,
    draftExternalId: (row['draft_external_id'] as string | null) ?? null,
    payloadRecorded: row['payload_recorded'] === true,
    // The driver parses jsonb into a value. An object or nothing: the column
    // is guarded to objects, and anything else is a malformed row.
    payload:
      typeof row['payload'] === 'object' && row['payload'] !== null
        && !Array.isArray(row['payload'])
        ? (row['payload'] as Record<string, unknown>)
        : null,
    actionClass: (row['action_class'] as string | null) ?? null,
    delivery: (row['delivery'] as string | null) ?? null,
    // DEC-47: the product of the channel this run's message arrived on. Null
    // is a run whose channel mapped to no product, which every surface
    // states in words rather than drawing a blank.
    product: (row['product'] as string | null) ?? null,
    approved: row['approved'] === true,
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
/**
 * Every run in the given states, for the console's runs surface (issue #27).
 *
 * Shares `runSelectFor` with the escalation queue, so a run row means one
 * thing. The console owns no SQL: this is the module it reads through, beside
 * `bands` and `latency`.
 */
export async function listRuns(
  pool: Pool | PoolClient,
  states: readonly string[],
  limit = 200,
): Promise<EscalationItem[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error(`a runs page takes 1 to 1000 rows, got ${limit}`);
  }
  const rows = await pool.query(
    `${runSelectFor(states)} ORDER BY r.created_at DESC NULLS LAST LIMIT $1`,
    [limit],
  );
  return (rows.rows as unknown as Record<string, unknown>[]).map(toItem);
}

/**
 * One run by id, or null (issue #27).
 *
 * Exact rather than a scan. The console's first version read the newest
 * thousand runs and searched them, so a run outside that window answered
 * "no such run" — a wrong answer rather than a limit, and four joins and a
 * thousand rows marshalled for one page.
 *
 * The id is bound, never interpolated. Only the state list is interpolated,
 * and `runSelectFor` takes members of a closed set.
 */
export async function readRun(
  pool: Pool | PoolClient,
  runId: string,
  states: readonly string[] = LEDGER_STATES,
): Promise<EscalationItem | null> {
  const rows = await pool.query(`${runSelectFor(states)} AND r.run_id = $1`, [runId]);
  const row = (rows.rows as unknown as Record<string, unknown>[])[0];
  return row === undefined ? null : toItem(row);
}

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
    // db/040 adds 'not_sent' on the same terms.
    items =
      wanted === 'delivery_unknown'
        ? items.filter(
            (item) =>
              item.outboxStatus === 'delivery_unknown'
              || item.outboxStatus === 'malformed'
              || item.outboxStatus === 'not_sent',
          )
        : items.filter((item) => item.state === wanted);
  }
  return items.sort((a, b) => (a.ticketId < b.ticketId ? -1 : a.ticketId > b.ticketId ? 1 : 0));
}
