# Intent: One conversation owns its message (DEC-24, DEC-35, DEC-38)

## Problem

`503da0e` folded the conversation into the idempotency key. It asserted that a
conversation id is stable across every retry of one turn. That assertion was
false on the path the commit was written to serve.

`resolveConversation` offered only the OLDEST conversation on a ticket. A
sender that the oldest refuses therefore matched nothing, and opened a new
conversation for every message. A redelivery did the same, so the conversation
id was minted per delivery attempt.

The key then varied per attempt. The outbox `UNIQUE(idem_key)` stopped
suppressing the repeat, and the external action ran once per redelivery. A
review reproduced this against a real database.

Two further faults came from the same root. History was lost, because each
message became turn 1 of a fresh conversation. Rows grew without bound, and the
turns of one ticket scattered across partitions.

A refused recipient is permanent, and it was routed through the queue's attempt
counter. Each occurrence spent fifty full pipeline runs and filed fifty run
rows before an operator saw anything.

## Proposed outcome

A message that already holds a turn resolves to the conversation that holds it.

Every conversation the message could belong to is offered, oldest first, and
the first one the sender may join wins. So a sender the oldest refuses reuses
the conversation it opened before, and a redelivery reuses it too.

The key is then stable across every retry of one turn, which is what DEC-24
requires and what `503da0e` claimed.

The egress refuses a recipient mismatch with a permanent error class, and the
coordinator escalates it on the first occurrence.

## Affected users and systems

Intake, the coordinator, the mail egress, and every conversation-bearing key.

## Constraints

DEC-24 forbids run identity in the key. This restores the property, rather than
adding one.

The membership check still refuses a sender the conversation does not know. It
now searches for a conversation that sender does know before opening one.

## Decisions affected

Affects: DEC-24, DEC-35, DEC-38

Obeys DEC-24, DEC-35 and DEC-38. Corrects an implementation detail of `db/012`
and of `503da0e`.

## Open questions

The self-lookup by message id is defence in depth. Reverting it alone fails no
test, because the candidate scan re-derives the same answer. The comment says
so rather than claiming the block is load bearing.
