/**
 * Read-only conversation queries (DEC-35, DEC-37).
 *
 * A conversation is one customer problem, and it may span several tickets
 * (DEC-35). `turn` holds each inbound message and the reply an approval
 * dispatched; `run` holds what the system did about it.
 *
 * This is not `conversationHistory` in `src/coordinator/consumer.ts`. That
 * reads the turns before the one being processed, to put context into a
 * prompt, and it skips an absent half because a prompt cannot use one. A
 * reader is the opposite case: an absent half is the fact, and it is reported
 * by name rather than skipped. The two would be one function only by making
 * the prompt carry sentences about missing rows.
 *
 * Every statement is a SELECT, and each read runs in one READ ONLY
 * transaction through `boundedRead`. The module never writes, and the
 * database refuses a write if one is ever added, so it is safe to run
 * against a live database. The console runs these reads on page loads, so
 * each statement runs under a timeout and each read under a client deadline.
 */
import type { Pool } from 'pg';

import { CUSTOMER_REPLY_ACTION_CLASS } from '../adapters/types.js';
import { boundedRead } from '../db/bounded-read.js';
import { OUTBOX_STATUSES, TERMINAL_RUN_STATES, type OutboxStatus } from '../ledger/insert.js';

/** The bound on each statement of a read, in milliseconds. */
export const CONVERSATION_TIMEOUT_MS = 2_000;

/** A run identity the ledger can be asked about. The columns are `uuid`. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Why a turn shows no message text.
 *
 * Not one absence but two, and they send a reader to different places.
 *
 * `not_retained`: a turn recorded before `db/010` has no copy of the message
 * anywhere, because the queue row it would have come from was already acked.
 *
 * `empty_message`: the customer sent nothing. `intake.ticket_text` is NOT
 * NULL with no non-empty check, and `turn.body_text` is copied from it, so an
 * empty body is stored rather than refused. A surface showing it as text
 * would draw a blank turn and say nothing about it.
 */
export type MessageAbsence = 'not_retained' | 'empty_message';

/**
 * Why a turn shows no agent reply.
 *
 * `turn.approved_reply_text` is written on the approval path alone
 * (DEC-37, db/011). Ten different facts land in that null:
 *
 *   - `handled_automatically`: a run resolved the turn with an internal write
 *     and no person saw it. DEC-12 makes every customer reply wait for a
 *     person, so an automatic run never sends one.
 *   - `approved_without_reply`: a person approved, and no reply text reached
 *     the turn. Ordinarily a DEC-34 internal write, which has no customer
 *     text. It is also what an approval before DEC-38 looks like, because
 *     `recordApprovedReply` needs a turn number the park did not carry — so
 *     this does not promise the customer received nothing.
 *   - `reply_awaiting_approval`: the run is parked and nobody has approved
 *     it, and its park names a draft in the helpdesk: a customer reply is
 *     drafted and waits (DEC-11, DEC-12). Nothing has been sent.
 *   - `action_awaiting_approval`: the run is parked and nobody has approved
 *     it, and its park is an internal write: it records a payload, and its
 *     action is not the customer reply's. It parks in the ledger alone, with
 *     no customer text (DEC-34), so no reply is drafted.
 *   - `awaiting_approval`: the run is parked and nobody has approved it, and
 *     its park names neither kind: no draft, and no internal write. A reply
 *     parked in the ledger alone under a profile that shows no customer, a
 *     crash marker, or no park at all. A page claims neither a draft nor an
 *     action the ledger does not name.
 *   - `in_flight`: the run has not finished. It may yet send one, and saying
 *     it sent nothing would report a determination the ledger does not hold.
 *   - `no_reply_sent`: the run reached a terminal state that sent nothing —
 *     escalated, abandoned or superseded.
 *   - `not_retained`: no run joins this turn at all, so nothing here can say
 *     what happened to it.
 *   - `closed_without_reply`: a person closed the case without answering it
 *     (DEC-48). Neither label beside it is true: the system did not handle
 *     this turn, and nobody approved an action on it.
 */
export type ReplyAbsence =
  | 'handled_automatically'
  | 'approved_without_reply'
  | 'reply_awaiting_approval'
  | 'action_awaiting_approval'
  | 'awaiting_approval'
  | 'put_aside'
  | 'in_flight'
  | 'no_reply_sent'
  | 'not_retained'
  | 'closed_without_reply';

/** One turn of a conversation, with what the ledger holds about it. */
export interface ConversationTurnRow {
  readonly turnNumber: number;
  /** The thread this turn arrived on. One conversation may span several. */
  readonly ticketId: string;
  readonly createdAt: Date;
  /**
   * The customer's message, or null with `messageAbsence` naming why.
   *
   * Never both null. A reader that showed a blank turn would be showing a
   * turn the system received and saying nothing about it.
   */
  readonly bodyText: string | null;
  readonly messageAbsence: MessageAbsence | null;
  /**
   * The reply an approval dispatched, or null with `replyAbsence` naming why.
   *
   * It belongs to the turn and not to `runId`: it is the text the last
   * approval committed on the turn. A repeat approval of the same reply
   * supersedes before it writes, so the text and the outbox row come from
   * the same approval unless the action changed between runs.
   */
  readonly replyText: string | null;
  readonly replyAbsence: ReplyAbsence | null;
  /**
   * The newest run of this turn, joined on `run.turn_number` (db/015).
   *
   * Null on a turn no run joins: a V1-era run recorded no turn, and a turn
   * whose run predates db/015 carries no number to join on.
   */
  readonly runId: string | null;
  readonly runState: string | null;
  /**
   * How many runs worked this turn.
   *
   * Usually one. More means the consumer retried — it files one orphan run
   * per failed attempt, and abandoning the message files another — or that a
   * reviewer sent the case back for a new attempt (DEC-49), which starts a
   * run of its own on the same turn. Zero means no run joins this turn at
   * all, which `runId` also says.
   *
   * Counted rather than shown as extra turns. A turn that took three runs to
   * abandon is one turn, and a reader that returned it three times would be
   * describing the retries as messages the customer sent.
   */
  readonly runAttempts: number;
  /**
   * What the relay recorded on the turn's outbox row, or null when no run of
   * the turn holds a row that counts. On a turn with reply text, only the
   * approval row that names the reply's draft counts.
   *
   * Read from the newest run that holds a row, which need not be `runId`: a
   * superseded retry holds none, and neither does a redelivered run still
   * waiting for a person. On a turn with reply text, only the approval row
   * that names the reply's draft counts, so another action on the turn cannot
   * speak for the reply.
   *
   * A resolved run commits its row and does not deliver it: the relay sets
   * `sent` after the adapter answers, and leaves `pending` while it retries.
   * So this, and not the run state, says whether a customer has the reply.
   */
  readonly outboxStatus: OutboxStatus | null;
}

/** One customer problem, and every turn of it. */
export interface ConversationThread {
  readonly conversationId: string;
  readonly primaryTicketId: string;
  readonly state: string;
  readonly openedAt: Date;
  /**
   * Whether the conversation names the participant its messages must come
   * from (db/012).
   *
   * The address itself is not returned. A reader needs to know that a
   * conversation is bound to somebody, not who — and DEC-12's approver
   * already sees the message this address sent.
   */
  readonly participantNamed: boolean;
  readonly turns: readonly ConversationTurnRow[];
}

const SELECT_THREAD = `
  SELECT c.conversation_id,
         c.primary_ticket_id,
         c.state,
         c.opened_at,
         c.customer_address IS NOT NULL AS participant_named
    FROM conversation c
   WHERE c.conversation_id = $1`;

/**
 * One row per turn, and the run that last worked it.
 *
 * The join is lateral and takes one row, because several runs share a turn.
 * `run_turn_idx` is not unique and nothing constrains the pair: the consumer
 * files one orphan run per failed attempt, and abandoning the message files
 * another. A plain join multiplied the turn by its attempts, so a console
 * would draw the customer's message three times with a different state on
 * each copy, in an order nothing fixed.
 *
 * The newest is the one that decided, so it is the one the turn shows.
 *
 * The outbox row is read across every run of the turn, newest run first. A
 * row is the effect a run committed (DEC-04). A retry of the same action
 * derives the same key, loses the insert and stops superseded with no row
 * (section 4.2, rule 2), so the row that says what became of the send can
 * belong to an earlier run. The run and the row are two facts, and a newer
 * run still waiting for a person must stay the run the turn shows.
 *
 * Earlier attempts are counted rather than dropped, because a turn that took
 * three runs to abandon is a different fact from one that took a single run.
 */
const SELECT_TURNS = `
  SELECT t.turn_number,
         t.ticket_id,
         t.created_at,
         t.body_text,
         t.approved_reply_text,
         r.run_id,
         r.state AS run_state,
         r.approved_by,
         r.parked_kind,
         ob.status AS outbox_status,
         COALESCE(a.attempts, 0) AS attempts
    FROM turn t
    LEFT JOIN LATERAL (
           SELECT run.run_id, run.state, run.approved_by,
                  -- #123: what this run's park is. Only a finished park names
                  -- either kind: the crash marker records an intent, and a
                  -- refusal records an error. A draft is a non-empty string
                  -- handle in the helpdesk (DEC-11), as the approval requires. An internal write records a payload
                  -- and is not the customer reply's action (DEC-34). Anything
                  -- else names neither.
                  (SELECT CASE
                            WHEN jsonb_typeof(p.result -> 'draftExternalId') = 'string'
                             AND (p.result ->> 'draftExternalId') <> '' THEN 'draft'
                            WHEN jsonb_typeof(p.result -> 'payload') = 'object'
                             AND (p.result ->> 'actionClass') IS DISTINCT FROM $2 THEN 'action'
                          END
                     FROM step_journal p
                    WHERE p.run_id = run.run_id
                      AND p.step_id = 'park'
                      AND p.status = 'done')
                    AS parked_kind
             FROM run
            WHERE run.conversation_id = t.conversation_id
              AND run.turn_number = t.turn_number
            ORDER BY run.created_at DESC, run.run_id DESC
            LIMIT 1
         ) r ON true
    -- One row per run in practice: the approval writes step approve, the
    -- automatic path writes step execute, and a run takes one path. Ordered
    -- by step anyway, so a second row could never make the answer depend on
    -- a plan.
    --
    -- A turn with reply text reads only the reply's own row. The key comes
    -- from the action (DEC-24), so a later run that took another action holds
    -- a row with its own status, and that status says nothing about whether
    -- the customer has the reply. The approval records reply text only for a
    -- draft-backed park, in the transaction that writes a row whose payload
    -- names that draft. So the draft marks the reply's row, and a reply turn
    -- reads that row or none. The relay sends the draft only for the customer
    -- reply action; a profile that pairs a draft with another class is #124.
    LEFT JOIN LATERAL (
           SELECT o.status
             FROM run rr
             JOIN outbox o ON o.run_id = rr.run_id
            WHERE rr.conversation_id = t.conversation_id
              AND rr.turn_number = t.turn_number
              AND (t.approved_reply_text IS NULL
                   OR (o.step_id = 'approve' AND o.payload ? 'draftExternalId'))
            ORDER BY rr.created_at DESC, rr.run_id DESC, o.step_id
            LIMIT 1
         ) ob ON true
    LEFT JOIN LATERAL (
           SELECT count(*)::int AS attempts
             FROM run
            WHERE conversation_id = t.conversation_id
              AND turn_number = t.turn_number
         ) a ON true
   WHERE t.conversation_id = $1
   ORDER BY t.turn_number`;

/**
 * Why this turn shows no message, or null when it shows one.
 *
 * The empty string is a message the customer sent and not a message nobody
 * retained, so it gets its own name.
 */
function messageAbsenceFor(bodyText: string | null): MessageAbsence | null {
  if (bodyText === null) return 'not_retained';
  // Trimmed, because a message of spaces renders as a blank block and a blank
  // is the one thing this is here to prevent. `intake.ticket_text` is a
  // subject and a body joined by two newlines, so an empty body with an empty
  // subject stores whitespace rather than the empty string.
  if (bodyText.trim() === '') return 'empty_message';
  return null;
}

/**
 * Why this turn shows no reply, given the newest run of this turn.
 *
 * Read from the run's state rather than guessed. A turn with no run joined
 * cannot be explained at all, and says so.
 */
function replyAbsenceFor(
  runState: string | null,
  approvedBy: string | null,
  parkedKind: 'draft' | 'action' | null,
): ReplyAbsence {
  if (runState === null) return 'not_retained';
  // #123: the park row says what waits. A customer reply parks as a draft
  // (DEC-11); an internal write parks with its payload (DEC-34). A park that
  // names neither reads as neither.
  if (runState === 'awaiting_approval') {
    if (parkedKind === 'draft') return 'reply_awaiting_approval';
    return parkedKind === 'action' ? 'action_awaiting_approval' : 'awaiting_approval';
  }
  // DEC-48: a person put the case aside for a period. Read before the
  // in-flight test below, which would report a case a person deliberately
  // parked as work nobody has got to yet.
  if (runState === 'snoozed') return 'put_aside';
  // Tested against the ledger's own terminal set rather than by naming two
  // states. Six states are in flight, and every one of them fell through to
  // `no_reply_sent` — reporting a run that may yet answer as one that
  // terminally did not.
  if (!TERMINAL_RUN_STATES.has(runState)) return 'in_flight';
  // DEC-48: a person closed the case without answering it. Read before the
  // catch-all below, because a close sends nothing for a reason the other
  // terminal states do not share: a person decided the case needs no reply.
  if (runState === 'closed') return 'closed_without_reply';
  if (runState !== 'resolved') return 'no_reply_sent';
  // A resolved run that dispatched a reply wrote it to the turn, so one
  // reaching here answered without reply text. Whether a person was involved
  // is the difference between an automatic write and an approved one, and
  // DEC-42's column is what says which.
  return approvedBy === null ? 'handled_automatically' : 'approved_without_reply';
}

/** The park kind the statement read, narrowed; anything else names neither. */
function parkedKindOf(value: unknown): 'draft' | 'action' | null {
  return value === 'draft' || value === 'action' ? value : null;
}

/**
 * The relay's status on a row, narrowed to the set db/006 allows.
 *
 * Throws on any other value. The CHECK makes one unreachable until a migration
 * widens it, and a surface that drew an unknown status would guess what it
 * says about the customer.
 */
function outboxStatusOf(value: unknown): OutboxStatus | null {
  if (value === null || value === undefined) return null;
  const status = OUTBOX_STATUSES.find((known) => known === value);
  if (status === undefined) {
    throw new Error(`outbox status ${String(value)} is not one of ${OUTBOX_STATUSES.join(', ')}`);
  }
  return status;
}

/**
 * One conversation and its turns, or null when the ledger holds no such
 * conversation.
 *
 * Null rather than an empty thread: a conversation that exists and holds no
 * turn is a different fact from one that does not exist, and only the first
 * can happen.
 */
export async function readConversation(
  pool: Pool,
  conversationId: string,
  timeoutMs: number = CONVERSATION_TIMEOUT_MS,
  clientTimeoutMs: number = timeoutMs + 1_000,
): Promise<ConversationThread | null> {
  // Asked before the ledger is, because a malformed uuid is a client error
  // and the `uuid` column would answer it with a driver exception.
  if (!UUID.test(conversationId)) return null;

  // Both statements in one READ ONLY transaction, so the turns are the
  // turns of the thread the first statement read.
  const read = await boundedRead(pool, 'readConversation', timeoutMs, clientTimeoutMs, async (query) => {
    const head = await query<Record<string, unknown>>(SELECT_THREAD, [conversationId]);
    if (head[0] === undefined) return null;
    const turns = await query<Record<string, unknown>>(SELECT_TURNS, [conversationId, CUSTOMER_REPLY_ACTION_CLASS]);
    return { row: head[0], turns };
  });
  if (read === null) return null;
  const { row, turns } = read;
  return {
    conversationId,
    primaryTicketId: String(row['primary_ticket_id']),
    state: String(row['state']),
    openedAt: row['opened_at'] as Date,
    participantNamed: row['participant_named'] === true,
    turns: turns.map((turn) => {
      const bodyText = (turn['body_text'] as string | null) ?? null;
      const replyText = (turn['approved_reply_text'] as string | null) ?? null;
      const runState = (turn['run_state'] as string | null) ?? null;
      return {
        turnNumber: Number(turn['turn_number']),
        ticketId: String(turn['ticket_id']),
        createdAt: turn['created_at'] as Date,
        bodyText,
        messageAbsence: messageAbsenceFor(bodyText),
        replyText,
        replyAbsence:
          replyText === null
            ? replyAbsenceFor(
              runState,
              (turn['approved_by'] as string | null) ?? null,
              parkedKindOf(turn['parked_kind']),
            )
            : null,
        runId: (turn['run_id'] as string | null) ?? null,
        runState,
        runAttempts: Number(turn['attempts'] ?? 0),
        outboxStatus: outboxStatusOf(turn['outbox_status']),
      };
    }),
  };
}

/** The message a run answered, and why it is absent when it is. */
export interface AnsweredTurn {
  readonly conversationId: string;
  readonly turnNumber: number;
  /** The customer's message, or null with `absence` naming why. */
  readonly bodyText: string | null;
  readonly absence: MessageAbsence | null;
  /**
   * DEC-37: the reply an approval dispatched for this turn, or null when no
   * approval reached it.
   *
   * Read beside the saved reply because the two answer different questions
   * once a run has left the queue: this is what the customer was sent, and
   * that is what a reviewer was working on.
   */
  readonly approvedReplyText: string | null;
  /**
   * DEC-44: the reply a reviewer saved for this turn, or null when nobody
   * saved one.
   *
   * Read here rather than by a second statement, because this one already
   * holds the turn row. It is the text the ledger would send on an adapter
   * whose helpdesk cannot send its parked copy, so a surface that draws a
   * case has to have it.
   */
  readonly savedReplyText: string | null;
}

/**
 * The turn one run answered, or null when it answered none.
 *
 * One statement for one run, because the approval queue draws one selection
 * and the queue itself is uncapped. Reading a turn per waiting run would be a
 * statement for every row of a list that has been 476 long.
 *
 * Null covers three cases a surface reads the same way: a V1-era run with no
 * conversation, a run recorded before `db/015` and so carrying no turn to join
 * on, and a run whose turn row is gone. None of them is a message that was
 * empty, which `absence` reports instead.
 */
export async function turnAnsweredBy(
  pool: Pool,
  runId: string,
  timeoutMs: number = CONVERSATION_TIMEOUT_MS,
  clientTimeoutMs: number = timeoutMs + 1_000,
): Promise<AnsweredTurn | null> {
  if (!UUID.test(runId)) return null;
  const rows = await boundedRead(pool, 'turnAnsweredBy', timeoutMs, clientTimeoutMs, (query) => query(
    `SELECT t.conversation_id, t.turn_number, t.body_text, t.saved_reply_text,
            t.approved_reply_text
       FROM run r
       JOIN turn t
         ON t.conversation_id = r.conversation_id
        AND t.turn_number = r.turn_number
      WHERE r.run_id = $1`,
    [runId],
  ));
  const row = rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  const bodyText = (row['body_text'] as string | null) ?? null;
  const saved = (row['saved_reply_text'] as string | null) ?? null;
  const approved = (row['approved_reply_text'] as string | null) ?? null;
  return {
    conversationId: String(row['conversation_id']),
    turnNumber: Number(row['turn_number']),
    bodyText,
    absence: messageAbsenceFor(bodyText),
    approvedReplyText: approved === null || approved.length === 0 ? null : approved,
    // The same rule the reader in src/ledger/conversation.ts applies: an
    // empty stored string reads as no save, never as a blank reply.
    savedReplyText: saved === null || saved.length === 0 ? null : saved,
  };
}

/**
 * The conversation a run belongs to, or null when it belongs to none.
 *
 * A V1-era run has no conversation (db/008), so null here is ordinary.
 */
export async function conversationOfRun(
  pool: Pool,
  runId: string,
  timeoutMs: number = CONVERSATION_TIMEOUT_MS,
  clientTimeoutMs: number = timeoutMs + 1_000,
): Promise<string | null> {
  if (!UUID.test(runId)) return null;
  const rows = await boundedRead(pool, 'conversationOfRun', timeoutMs, clientTimeoutMs, (query) => query(
    'SELECT conversation_id FROM run WHERE run_id = $1',
    [runId],
  ));
  const row = rows[0] as Record<string, unknown> | undefined;
  return (row?.['conversation_id'] as string | null) ?? null;
}
