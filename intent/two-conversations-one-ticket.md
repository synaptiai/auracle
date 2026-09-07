# Intent: Two conversations on one ticket (DEC-35, DEC-38)

## Problem

`db/012` refuses a conversation join by a different sender. So one ticket can
now carry two conversations, and the first turn of each is turn 1.

The idempotency key folded in the ticket and the turn, never the conversation.
Two senders on one ticket therefore derived one key. The outbox
`UNIQUE(idem_key)` rejected the second insert, the run landed `superseded`, and
no reply was sent. Nothing named the cause.

This needs no attacker. A copied colleague replying to all keeps the thread
root. So the ticket id is the same and the sender is not.

The addressing path disagreed with the membership check for the same reason.
A message that names another thread's root gets a new conversation, and keeps
that root as its ticket id. The mail egress resolves the recipient from the
ticket id. So it addressed the reply to the person who wrote the original.

Three further defects came from the same fix commit. A null sender always
passed the membership check. `fromAddress` is null whenever the From header
is missing, so a sender opted out by omitting it. The park guard threw on a
transient IMAP error and left the journal row in `parking`. That escalates
every later run on that ticket forever. The attempt ceiling counted consecutive
scans, so one provider outage abandoned every queued message.

## Proposed outcome

A turn is identified by its conversation and its number, so the key carries
both. A caller with no turn derives the V1 key unchanged, which the pinned
literals prove.

The egress checks the recipient it resolved against the participant the ledger
recorded. A mismatch refuses the park.

The conversation decides membership, not the message. A conversation with no
recorded participant accepts anybody. One that has a participant refuses an
unnamed sender.

A park that fails visibly marks the journal row `failed`, so the ticket is not
poisoned. Only a crash leaves `parking`, which is what that marker is for.

The attempt ceiling is high by default and injectable, so a shared outage does
not empty the queue.

## Affected users and systems

Every conversation-bearing run, the mail egress, intake and the consumer.

## Constraints

DEC-24 forbids run identity in the key. A conversation id is stable across
every retry of one turn, so it is conversation identity and the rule holds.

DEC-12 still puts a person in front of every customer reply. The recipient
check is not a substitute for that; it removes a draft the approver had no
baseline to judge.

## Decisions affected

Obeys DEC-24, DEC-35 and DEC-38. Corrects an implementation detail of `db/012`.

## Open questions

The recipient check compares one address. A conversation that legitimately
spans two addresses of one customer is refused, and opens a second
conversation instead.
