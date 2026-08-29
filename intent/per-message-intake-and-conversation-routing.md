# Intent: A follow-up message is queued, not discarded (DEC-36)

## Problem

The intake key was the ticket id. For mail that is the thread root. So a
genuinely new customer message on a thread that was still queued hit the
conflict target and was discarded. No error, no record, no reply.

Step 2 of four. Three changes ship together here.
They are the key, the partition key and the coordinator input model.
The key alone breaks the enqueue conflict target.
It also makes each ack delete every pending message of the ticket.

## Proposed outcome

The key is `(ticket_id, message_id)`. A repeat of one message deduplicates.
A new message enqueues.

The message identity comes from the source. Mail uses its Message-ID header,
the webhook its mandatory payload id. When the source names none, the
adapter's own delivery id stands in. Nothing is invented (DEC-24).

One transaction writes the conversation, the turn and the queue row. The
turn number is taken under the conversation row's lock, so concurrent
messages of one conversation serialize.

The queue row records its own conversation and turn. Deriving them at poll time meant joining on the message id.
That returned a message twice once an id repeated across turns.

The epoch row is created at 0 during that transaction. It used to appear lazily on the first fenced write.
Two first messages of one ticket then had nothing to serialize on.

The partition key is the conversation id.
Every turn of one conversation therefore reaches one consumer.
Its runs never race.

The ack deletes one message, not the ticket.

## Affected users and systems

Every inbound message. The consumer, the coordinator and the escalations
query.

## Constraints

`escalations/query.ts` compared a scalar subquery over intake. That throws
as soon as a ticket holds two queued messages. It now takes the earliest
arrival, which is what answers the question the filter asks. The design
document does not mention this site.

A partition is no longer a function of the ticket id.
The tests ask where a message landed rather than predicting it.

## Decisions affected

Ratifies DEC-36. History reaches the coordinator but no prompt reads it yet,
so it cites no decision until the next step.

## Open questions

Cross-thread linking works when the source carries a reply chain. The
webhook contract does not, so there the link comes from a person.
