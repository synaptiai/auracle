/**
 * Conversation-level ledger writes outside the enqueue path (DEC-35).
 *
 * A conversation is a ledger entity, so its state lives in `conversation` and
 * `turn` and never in a component. `src/coordinator/intake.ts` owns the
 * enqueue half: it opens a conversation, reserves a turn and records the
 * inbound message. This module owns what a later step adds to a turn that is
 * already recorded.
 */
import type { PersonProvenance } from '../adapters/types.js';
import type { Pool, PoolClient } from 'pg';

/**
 * A pool or one connection of a transaction. The readers below run on both:
 * the approval reads inside its transaction, and a surface reads through the
 * pool.
 */
export type ConversationDb = Pool | PoolClient;

/** The reply an approval dispatched for one turn (DEC-12, DEC-37). */
export interface ApprovedReply {
  conversationId: string;
  /** The inbound turn the reply answers, never a turn of its own. */
  turnNumber: number;
  /** The body the person approved, which is what the outbox carries. */
  bodyText: string;
}

/**
 * Record the approved reply on the turn it answers.
 *
 * Pass the `PoolClient` of the approval transaction, so the reply commits
 * with the state change or not at all (section 4.2 rule 1).
 *
 * The reply does not take a turn number of its own. `turn_number` is the
 * inbound sequence that `conversation.turn_counter` assigns, and DEC-38
 * derives the idempotency key from it. A reply that consumed a number would
 * move every later key and drop an in-flight request as superseded.
 *
 * A zero-row update is an error, not a normal case. The caller already
 * refuses to build a reply unless the run names a conversation and the park
 * names a turn, and the enqueue transaction wrote the `turn` row in the same
 * commit that created the conversation. So no rows updated means the ledger
 * disagrees with itself.
 *
 * The damage would otherwise appear one turn later and look like a model
 * fault: `conversationHistory` skips a null `approved_reply_text`, so the
 * composer for turn N+1 would see every customer message and nothing the
 * agent ever said. Throwing rolls the approval back, which is the right
 * outcome for a ledger this inconsistent.
 */
export async function recordApprovedReply(
  client: PoolClient,
  reply: ApprovedReply,
): Promise<void> {
  const updated = await client.query(
    `UPDATE turn SET approved_reply_text = $3
      WHERE conversation_id = $1 AND turn_number = $2`,
    [reply.conversationId, reply.turnNumber, reply.bodyText],
  );
  if (updated.rowCount === 0) {
    throw new Error(
      `no turn ${reply.turnNumber} in conversation ${reply.conversationId} to record a reply on; `
        + 'the approval is rolled back rather than losing the agent half of the history (DEC-37)',
    );
  }
}

/** The reply a reviewer saved for one turn, before any approval (DEC-44). */
export interface SavedReply {
  conversationId: string;
  turnNumber: number;
  /** The body the person saved. The disclosure rides beside it, unedited. */
  bodyText: string;
  /**
   * DEC-48: the provenance of a reply a person wrote from scratch.
   *
   * Absent means this write does not declare an author: it is an edit, and
   * the column keeps what it holds. When a person already took the reply
   * over, that write refreshes the moment instead — the text is theirs from
   * the first rewrite on, and the trailer says when they last wrote it.
   */
  provenance?: PersonProvenance;
}

/**
 * Record the reply a reviewer saved on the case screen (DEC-44).
 *
 * Pass the connection of the write's transaction, as the console's save and
 * the approval both do. One statement, so a pool would be safe too; the
 * transaction is what makes the guard in front of it hold.
 *
 * The row is only ever updated, never inserted: `turn` is written by the
 * enqueue transaction that opened the conversation, so a save on a turn that
 * does not exist is a ledger disagreement and throws. That is deliberately
 * the same rule `recordApprovedReply` applies one column over.
 *
 * Overwriting is the point. A reviewer edits, saves, reloads and edits again;
 * each save replaces the last, and the approved text is only decided when
 * somebody approves. The column holds what they last saved, which is what a
 * later reader shows them and what the approval sends.
 */
/**
 * The outbox statuses that close a turn to a new attempt (DEC-49).
 *
 * A record in any of these is a reply that has reached the customer, may have
 * reached them, or will. `sent` has. `fenced` may have: the relay had begun
 * the send when the fence moved (fact 14). `delivery_unknown` cannot be shown
 * not to have, and DEC-30 makes it terminal for that reason. `pending` is an
 * approved reply the relay has not drained yet — most plainly a console send
 * held for the DEC-51 window — and it will go out. A new attempt beside any of
 * them would put a second reply on one turn.
 *
 * Only `malformed` leaves the turn open: the relay escalated that record and
 * will never send it. A reviewer who wants a new attempt over a held send
 * undoes the approval first; the undo deletes the pending record.
 *
 * One list, read by the send-back, the consumer's scan and the approval, so
 * the rules that refuse a request, drop one and refuse a second reply cannot
 * drift apart.
 */
export const TURN_CLOSING_STATUSES = ['pending', 'sent', 'fenced', 'delivery_unknown'] as const;

/**
 * Whether the turn holds a record that closes it: a reply that reached the
 * customer, may have, or will (DEC-49).
 *
 * The turn is the conversation and the turn number together (DEC-35): a turn
 * number alone is not unique, and db/012 can put two conversations on one
 * ticket. A run with no turn number is not read. Its record answered some
 * message of the conversation, and nothing says which; reading it as every
 * turn's record closed every later turn for good.
 *
 * `replies` narrows it to the records of a customer reply, which name the
 * draft they send. The approval asks that question — a turn takes one reply,
 * and a compensation on the same turn is not a second one (DEC-34). The
 * send-back and the scan ask the wider one: any record that may have reached
 * the customer closes the turn to a new attempt.
 *
 * A caller reads this under the turn row's lock (`lockTurnAttempt`), so no
 * writer of the turn can add a record between the read and its own write.
 */
export async function turnIsClosed(
  client: ConversationDb,
  turn: { conversationId: string | null; turnNumber: number | null },
  options: { replies: boolean } = { replies: false },
): Promise<boolean> {
  if (turn.conversationId === null || turn.turnNumber === null) return false;
  const rows = await client.query(
    `SELECT 1
       FROM outbox o
       JOIN run r ON r.run_id = o.run_id
      WHERE r.conversation_id = $1
        AND r.turn_number = $2
        AND o.status = ANY ($3::text[])
        AND ($4::boolean = false OR o.payload ? 'draftExternalId')
      LIMIT 1`,
    [turn.conversationId, turn.turnNumber, [...TURN_CLOSING_STATUSES], options.replies],
  );
  return rows.rows.length > 0;
}

/**
 * The attempt a turn is on, read under the turn row's lock (DEC-49, db/033).
 *
 * Every decision about which attempt of a turn may act is ordered on this
 * lock: a send-back raises the attempt under it, and an approval, a save and
 * a rewrite read it under it before they write. So a reviewer cannot approve,
 * save or rewrite a reply on an attempt another reviewer has just sent back,
 * and two send-backs of one turn cannot both pass.
 *
 * Callers take it after their own run's row lock. That is the one order the
 * writers of a turn follow — run, then turn — and no writer takes a turn and
 * then a run, so no two of them can deadlock on it.
 *
 * Null when the turn row does not exist, which a caller reads as the first
 * attempt: a run with no turn has only ever had one.
 */
export async function lockTurnAttempt(
  client: ConversationDb,
  turn: { conversationId: string; turnNumber: number },
): Promise<number | null> {
  const rows = await client.query<{ attempt: number }>(
    `SELECT attempt FROM turn
      WHERE conversation_id = $1 AND turn_number = $2
      FOR UPDATE`,
    [turn.conversationId, turn.turnNumber],
  );
  const attempt = rows.rows[0]?.attempt;
  return attempt === undefined ? null : Number(attempt);
}

export async function recordSavedReply(
  client: ConversationDb,
  reply: SavedReply,
): Promise<void> {
  // The author travels with the text, in one statement (DEC-48). A write that
  // declares a person writes its provenance; a write that declares nobody
  // keeps the author the column holds and refreshes the moment, because an
  // edit of a person's reply is the person's reply, written later. The moment
  // is the same kind of value the park puts in its own provenance.
  const updated = await client.query(
    `UPDATE turn
        SET saved_reply_text = $3,
            saved_reply_provenance = CASE
              WHEN $4::jsonb IS NOT NULL THEN $4::jsonb
              WHEN saved_reply_provenance IS NOT NULL
                THEN jsonb_set(saved_reply_provenance, '{generatedAt}', to_jsonb($5::text))
              ELSE NULL
            END
      WHERE conversation_id = $1 AND turn_number = $2`,
    [
      reply.conversationId,
      reply.turnNumber,
      reply.bodyText,
      reply.provenance === undefined ? null : JSON.stringify(reply.provenance),
      new Date().toISOString(),
    ],
  );
  if (updated.rowCount === 0) {
    throw new Error(
      `no turn ${reply.turnNumber} in conversation ${reply.conversationId} to save a reply on; `
        + 'the save is rolled back rather than writing text no turn holds (DEC-44)',
    );
  }
}

/**
 * The reply a person saved for one turn, or null when nobody saved one
 * (DEC-44).
 *
 * Null is an answer and not a gap: it means the reply the approval sends is
 * the one the park journaled. A turn that cannot be named — a run with no
 * conversation, a park with no turn number — has nothing saved either, and
 * that is the same answer.
 *
 * An empty stored string reads as null. The writes refuse one, so a row that
 * holds one came from outside this code, and a reader that returned it would
 * offer a blank reply as a saved edit.
 */
export async function readSavedReply(
  db: ConversationDb,
  ref: { readonly conversationId: string | null; readonly turnNumber: number | null | undefined },
): Promise<string | null> {
  if (ref.conversationId === null || ref.turnNumber === null || ref.turnNumber === undefined) {
    return null;
  }
  const rows = await db.query(
    `SELECT saved_reply_text FROM turn
      WHERE conversation_id = $1 AND turn_number = $2`,
    [ref.conversationId, ref.turnNumber],
  );
  const value: unknown = rows.rows[0]?.saved_reply_text;
  return typeof value === 'string' && value.length > 0 ? value : null;
}
