# A case closed with no reply

## Problem

Some cases end without an answer. They are duplicates, they are spam, or
somebody settled them on the telephone. The console offers one outcome,
approve. Such a case either sends a reply nobody wants, or sits in the queue.

DEC-48 gives those cases a state of their own. `closed` is terminal, and
nothing sends for it. The run records who closed it and why. A console that
reused `resolved` would report a reply that never went out.

## Proposed outcome

A reviewer closes a waiting case from its page, with a reason. The run lands
`closed`. The hold on the case ends, and the conversation says the case was
closed with no reply.

- The case page carries a close control under the approval. That control is a
  reason field and one button. The reason is required and bounded.
- The close records the reviewer and the reason, in a `close` row of the run's
  journal. That row also holds what the name proves.
- The hold ends with the case, under a release kind of its own.
- The conversation view gains a seventh absence, `closed_without_reply`.
- The control bands count the case as not reached. `latency` counts it as
  finished work.

## Affected users and systems

The reviewer finishes a case in one more way, and the customer receives
nothing. The team reads who closed a case and why. It reads that on the case
and in its conversation.

The operator's numbers move only as the design table states. The case counts
as not reached, and its service time is real.

The change touches the run's state vocabulary. It also touches the console's
case page and one route, the conversation reader, and two hold constraints.

## Constraints

- The reason is required and bounded. Both rules live in the close function
  and not in the form, so every caller gets them.
- The close never sends. It writes no outbox record, no reply text and no edit
  distance (DEC-04, DEC-24).
- DEC-46 governs the guard. The caller carries the digest of the reply the page
  drew. The close refuses when the ledger's reply has moved.
- The reviewer's name is recorded with its source (DEC-42, DEC-45). An
  approval's name is recorded the same way.
- The hold ends under a kind of its own. `send` would record an event that did
  not happen. A lapse would record the close as nobody's work (DEC-46).

## Decisions affected

Affects: DEC-04, DEC-24, DEC-28, DEC-37, DEC-42, DEC-44, DEC-45, DEC-46, DEC-47, DEC-48

DEC-48 is the row this change ships. A reviewer may close a case with no
reply, and the run records who and why. The row's table settles what the jobs
count. `closed` counts as not reached in `bands`, and as finished in
`latency`.

DEC-46 governs the guard and the hold. A close is a console outcome on a case
whose reply may have moved. So the digest travels with it, and the ledger's
reply is compared under the run's row lock. The hold ends in the same
transaction, under its own kind. The case has left the queue.

DEC-42 and DEC-45 govern the name. The close records the reviewer and what the
name proves, on the journal row that holds the reason.

DEC-37 already says what a turn shows when no reply was sent. This adds a
seventh such fact beside the six it holds, and the state that produces it.

DEC-44 decides which text a page draws and which text the guard compares. The
close compares the saved reply when a person saved one, exactly as the
approval and the save do.

DEC-47 keeps the queue filters on the way back. The close form carries them on
the action's query string, as every other control on the case does.

DEC-04 puts the record in the journal. The close is a step a person took. It
writes one row, complete, with `console` as its pin.

DEC-24 keeps the close out of every key. It carries no outbox record, so there
is no semantic action to key.

DEC-28 is stated rather than changed. The close is a person's write from a
parked run. The fence does not reach it, exactly as it does not reach an
approval.

## Open questions

A close records one reason and not a category. An adopter who wants to count
why cases close, rather than read each one, needs a closed vocabulary of
reasons. Nothing here blocks that. The reason is one field, and a later change
can constrain it.
