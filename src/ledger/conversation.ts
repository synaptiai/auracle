/**
 * Conversation-level ledger writes outside the enqueue path (DEC-35).
 *
 * A conversation is a ledger entity, so its state lives in `conversation` and
 * `turn` and never in a component. `src/coordinator/intake.ts` owns the
 * enqueue half: it opens a conversation, reserves a turn and records the
 * inbound message. This module owns what a later step adds to a turn that is
 * already recorded.
 */
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
export async function recordSavedReply(
  client: ConversationDb,
  reply: SavedReply,
): Promise<void> {
  const updated = await client.query(
    `UPDATE turn SET saved_reply_text = $3
      WHERE conversation_id = $1 AND turn_number = $2`,
    [reply.conversationId, reply.turnNumber, reply.bodyText],
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
