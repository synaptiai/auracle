# Intent: the agent's half of the conversation

## Problem

`db/010` gave a turn the customer's message, so history stopped being empty.
It was still half a conversation. The prompts of turn N saw what the customer
wrote and never what the system answered.

A threshold fitted on that prompt is fitted on a conversation that reads as a
monologue, which is not the conversation the runtime holds.

`conversationHistory` said so in place: "Agent turns enter when the reply path
records them." No path recorded them.

## Proposed outcome

`turn` carries `approved_reply_text`. The approval writes it inside the
transaction that moves the run, so the reply commits with the state change or
not at all.

History returns both halves of a turn, the customer's message first and the
reply that answered it second, both under that turn's number.

## Affected users and systems

The classifier and composer prompts of every turn after the first.

The gates are unaffected. History is context, never evidence (DEC-37).

## Constraints

A reply takes no turn number of its own. `turn_number` stays the inbound
sequence, because DEC-38 derives the idempotency key from it.

A ledger-only park writes nothing. DEC-34 compensation is an internal write
with no customer-visible text, and recording one would show a customer's own
history an action they never saw.

A V1-era run has no conversation and a park from before DEC-38 carries no
turn. Both skip the write rather than fail the approval.

The text is what the approval dispatched, which is not proof of delivery. The
relay sends afterwards, and a failure escalates the run (DEC-30). The column
comment says so.

`renderHistory` counts turns and not entries. A turn now yields two entries,
so slicing the array would have halved `HISTORY_MAX_TURNS` from six turns to
three. That bound is pinned as part of the prompt contract (DEC-26).

## Decisions affected

DEC-37. The change implements it. DEC-12 supplies the trigger, because every
customer reply passes through approval.

## Open questions

A delivery that fails does not retract the recorded reply. Retracting it needs
the relay to resolve a turn, and no column joins a run to one yet.
