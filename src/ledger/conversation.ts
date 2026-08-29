/**
 * Conversation-level ledger writes outside the enqueue path (DEC-35).
 *
 * A conversation is a ledger entity, so its state lives in `conversation` and
 * `turn` and never in a component. `src/coordinator/intake.ts` owns the
 * enqueue half: it opens a conversation, reserves a turn and records the
 * inbound message. This module owns what a later step adds to a turn that is
 * already recorded.
 */
import type { PoolClient } from 'pg';

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
