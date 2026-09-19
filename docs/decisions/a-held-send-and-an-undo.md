# A held send, and an undo that is true

## Problem

A reviewer who has read a group of clean cases confirms them one at a time.
The handoff specifies a batch. One control sends the group, and a reviewer
who confirms by mistake needs a way back.

A way back after the send cannot exist. The relay posts the reply, and the
customer has it. So the way back has to come before the send.

## Proposed outcome

A console send of a reply the ledger holds waits for a hold period. The relay
sends nothing before that moment, and an undo inside the window returns the
run to approval. DEC-51 is the row this change ships.

- The queue's clean group carries a checkbox per case and one confirm button.
  The button posts the picked cases to a confirmation screen.
- The confirmation screen draws every reply in full, with the digest of the
  text it drew. Confirming approves each case in turn.
- The approval stamps the moment the record may be sent, and the relay skips a
  held record. The success panel counts what was sent and offers the undo.
- The undo removes every effect of the approval, in one transaction. The
  record, the approver, the edit distance, the approved text and the finish
  time all go. The run returns to `awaiting_approval`.
- The undo refuses outside the window, and once the relay has sent. It refuses
  a case that holds no approval too. Each refusal has its own words.

## Affected users and systems

The reviewer confirms a group and keeps one way back. The operator sets the
period, and reads the window in the runbook. Nothing changes on the draft path,
or for an adopter whose console serves one case at a time. A reply on that
path gets no hold and no undo.

The change touches the approval, the relay, the console's queue and its new
batch routes, and one table.

## Constraints

- The hold is a timing and never action semantics, so the idempotency key
  never folds it in (DEC-24, DEC-49). A held send and an immediate send of one
  action derive one key.
- An undo that reports success guarantees that nothing was sent. The relay
  holds the run's row lock across its send. The undo reads the clock after it
  holds that lock (DEC-28).
- A held record the fence stops escalates rather than waits (DEC-30).
- The undo clears the approved text, because the customer received nothing
  (DEC-37). The approver goes with it (DEC-42, DEC-45).
- Every case carries its own digest (DEC-46). A case whose reply moved since
  the page was drawn refuses, and its neighbours send.
- The undo is journalled under the run, so the case page says who took the
  send back (DEC-04).
- The period has a bound of five minutes. The relay skips a held record, so a
  longer hold parks replies with nobody told.

## Decisions affected

Affects: DEC-04, DEC-24, DEC-28, DEC-30, DEC-37, DEC-40, DEC-42, DEC-44, DEC-45, DEC-46, DEC-47, DEC-49, DEC-51

DEC-51 is the row this change ships. A console send waits for a hold period,
and an undo inside it returns the run to approval. The row rejects an undo
after the send. It rejects a delay in the browser too, so the period is a
moment on the record. The page only counts it down.

DEC-24 and DEC-49 fix what the hold may not touch. The key comes from the
action semantics, so the moment a record may be sent is its own column. A
held send and an immediate send derive one key. A crash retry still finds the
copy it created.

DEC-28 governs the one write that moves a run back out of a terminal state.
The relay and the undo both take the run's row lock. A send in flight and an
undo cannot interleave. Whoever holds the lock first decides, and the other
finds the record gone or sent.

DEC-30 governs a held reply the fence stops. It returns to a person with the
reason, and it never waits for a moment that has passed.

DEC-37's column is cleared by the undo, because the customer received nothing.
The approver and its source go with it (DEC-42, DEC-45), and so does the edit
distance.

DEC-46's digest travels per case in the batch. A case whose reply moved since
the confirmation screen was drawn refuses as `shown_changed`, and its
neighbours still send.

DEC-04 puts every step in the journal before it acts. The undo writes one row
naming the reviewer, so the case page says who took the send back.

DEC-47 keeps the queue filters on every way back. The batch's routes carry
them on the action's query string. So a confirmation and its refusals return
a reviewer to the queue they had narrowed.

DEC-44 decides which sends are held, and only a reply the ledger holds is
held. A person can send a draft on the DEC-40 path by hand at any moment. So
no undo there could promise that nothing was sent. That path keeps its
behaviour exactly: the parked copy is what sends, and nothing is held.

## Open questions

An adopter may set the period to zero. Then every send is immediate, the panel
offers no undo, and the batch is a faster approval. The console says so rather
than drawing a button that cannot work.
