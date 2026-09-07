# Intent: The prompts read the conversation (DEC-37, DEC-38)

## Problem

Step 3 of four. The conversation existed in the ledger and reached the
coordinator, but no prompt read it.

So the classifier saw "It still does not work" with nothing to say what "it"
was. The composer answered a follow-up as though it opened the thread.

The idempotency key also had no turn. A customer who asks for a refund in
turn one and asks again in turn four has made two requests. Both derived one
key, so the second collided with the first and was dropped as a replay.

## Proposed outcome

The classifier and the composer receive earlier turns, oldest first, before
the current message.

The gates do not. Groundedness reads retrieved documents alone, so history
can never support a claim. The composer's parser accepts a claim only when it names a retrieved
document. An answer resting on history therefore abstains.

`renderHistory` bounds the prompt. It keeps the most recent turns within a
character budget, and both bounds are pinned like a prompt version (DEC-26).
An unbounded prompt would defeat the DEC-25 cost limit.

The key gains the turn. A retry of one turn still derives one key. A caller
with no conversation derives the V1 key unchanged.

Every derivation site gains it, not only the automatic path. The approval path
derives its key from the parked record. So an approved reply keys on the turn
that requested it. `c61b42a` completes that half; the two paths would otherwise
derive two keys for one request.

One message is one turn, even across a redelivery after the ack removed its
queue row. Without that, the same request would take a second turn number
and derive a second key.

## Affected users and systems

Every classified and composed turn. Every action a turn requests.

## Constraints

Every gold case is a first turn, so no committed case exercises a prompt
carrying history. The agreement and coverage thresholds were fitted without
it. Section 6 records that debt: re-fit both on multi-turn data before a
multi-turn deployment goes live.

## Decisions affected

Ratifies DEC-37 and DEC-38. DEC-24 holds: run identity stays out of the key.
DEC-05 holds: the two gates are unchanged and read no history.

## Open questions

None.
