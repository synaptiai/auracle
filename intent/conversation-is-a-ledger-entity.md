# Intent: A conversation is a ledger entity (DEC-35)

## Problem

A customer problem can outlive one ticket thread. The system had no place to
record that. Nothing joined the runs of one problem, and nothing knew which
inbound message continued which conversation.

This is step 1 of four. It lands the entities and the adapter evidence.
Nothing reads them yet, which is what makes it shippable alone.

## Proposed outcome

`db/008_conversation.sql` adds two tables and one column.

`conversation` holds one customer problem. `turn_counter` names the next
turn. The intake transaction increments it under the row lock, so concurrent
messages of one conversation serialize. `state` is a closed set.

`turn` holds one inbound message. It records the thread that carried it, so
one conversation may span several threads.

`run.conversation_id` is null on a V1-era run, so every existing query stays
valid. No table declares a foreign key, matching `db/001_ledger.sql` and
`db/004_intake.sql`: the writers enforce the joins.

`NormalizedEvent` gains two fields. `linkage` carries what the adapter knows
about the conversation a message joins. It is evidence, never a conclusion,
because only the ledger knows which turns exist. `sourceId` carries the
adapter's own delivery id.

Mail offers the reply chain, thread root first. The webhook offers nothing,
because its contract has no reply chain and it declares `supportsThreading`
false. Autonomy matches capability (DEC-06).

## Affected users and systems

Adopters who migrate. Both ingress adapters.

## Constraints

Null linkage means no evidence beyond the ticket. It does not mean a new
conversation: the ticket id still groups a thread.

The fencing epoch stays per ticket (DEC-28). Conversation-level fencing would
be its own decision.

## Decisions affected

Ratifies DEC-35, which the design document proposed as its DEC-34. The
register assigns the number, so the document's numbers shift by one.

## Open questions

Cross-thread linking needs message-level evidence. The webhook path cannot
detect it, so there the link comes from a person.
