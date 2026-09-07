# Intent: conversation history survives the ack

## Problem

DEC-37 puts conversation history into the classifier and composer prompts.
The mechanism shipped in `bab5b3a` and it carried nothing.

`conversationHistory` read each earlier turn's text from the queue row. It
joined `turn` to `intake` on the ticket and the message. The consumer deletes
that row as soon as a run completes. So for turn N, every turn before it had
already been acked and contributed no row.

The prompts saw an empty history in every ordinary path. A non-empty one
appeared only when an earlier turn had failed and stayed queued. That is the
one case where the text is least useful.

The ledger held no other copy. `turn` recorded a message's identity and never
its text.

Section 6 of the register records the calibration debt as "no committed gold
case exercises a prompt with history". The deeper fact is that no runtime path
did either.

The suite could not see this. Its history case enqueued two turns and acked
neither, so the join still matched.

## Proposed outcome

`turn` carries `body_text`, written in the enqueue transaction that already
holds the conversation row lock. `conversationHistory` reads `turn` alone.

History no longer depends on the queue. So an earlier turn contributes its
text whether or not its run has finished.

A turn recorded before this migration holds no text. It is skipped rather than
rendered as a blank turn.

## Affected users and systems

The classifier and composer prompts of every turn after the first. A first
turn is unchanged: it has nothing before it.

The gates are unaffected. History is context, never evidence, and the
groundedness gate still reads retrieved documents alone (DEC-37).

## Constraints

Turn numbering does not move. `turn_number` stays the inbound sequence that
`conversation.turn_counter` assigns, because DEC-38 derives the idempotency
key from it. A key that moved would drop an in-flight approval as superseded,
which is the defect `c61b42a` fixed.

Retention: this keeps customer message text in the ledger for the life of the
conversation. `intake` held the same text, but only until the ack. The adopter
is the data controller (DEC-17, DEC-19), and this repository ships no
retention or purge job.

## Decisions affected

DEC-37. The change implements it. The decision already states that history
enters the prompts; nothing in its text changes.

## Open questions

The agent's reply is not recorded yet, so history is the customer's half of
the conversation. The reply follows in the next change.
