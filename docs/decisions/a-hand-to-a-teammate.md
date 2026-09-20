# A hand to a teammate

## Problem

A reviewer who takes a case sometimes cannot finish it. They read it, and it
belongs to somebody else. Or they have to leave.

DEC-48 keeps the hand-over as an outcome of its own. Its table states what
each job makes of it. The run state, the outbox and both published reports
stay unchanged.

The behaviour shipped with the case hold (DEC-46). Nothing held its row in
DEC-48's table to a case. The hold module proves that the reservation moves.
It proves that the history names whose hold moved.

Two things stayed unproved. Nothing proved that the customer sees nothing.
Nothing proved that the two published reports read the same before and after.
That is what their "unchanged" cells claim.

## Proposed outcome

No behaviour changes. This change states the row, and proves it.

- One case, read before and after a hand-over. Its state, finish time,
  approver, edit distance, cost, steps and epoch. Every outbox record and
  every turn's text. All of it is identical.
- The control bands for the window, and the latency report for every
  partition, read identical before and after. A state or a timing that moved
  would show in both.
- The reports are the second opinion, and not the guard. They see part of the
  outbox and none of the turn. The case above compares every outbox record and
  every turn's text, where a write of any status shows.
- The console's own case. The route delegates, and the page names the
  teammate. The case still waits for a person, with its approval offered.

## Affected users and systems

The team sees the case change hands. Nobody else sees anything. No reply is
sent, no action is performed, and no published number moves.

The recipient is resolved against the roster. So a case cannot be handed to
somebody the console would refuse at their next request.

The change touches two test files and this record.

## Constraints

- The hold is advisory, and it refuses no write (DEC-46). The movement is a
  statement about who is working. So it cannot be a condition another write
  depends on. The reviewer's own hold is the one it moves: a reviewer who
  does not hold the case is refused.
- The recipient has to be on the active roster. The holds module reads no
  roster of its own, so the check is injected. The console's gate resolves
  every identity against the ledger's roster (DEC-45).
- One case per person holds on this path as on every other. The recipient's
  other cases are released, because a person reads one case at a time.
- A move refreshes the period, so the case does not lapse while its new
  holder reads it.

## Decisions affected

Affects: DEC-45, DEC-46, DEC-48

DEC-48 is the row this change verifies. A hand-over leaves the run state, the
outbox and both reports unchanged, and the customer sees nothing.

DEC-46 governs the reservation itself. The hold is advisory, and the history
records whose hold moved. On this path the reservation's own row is the
serialization point, read `FOR UPDATE`. The run row's lock belongs to the
take.

DEC-45 governs who may receive it. A case handed to an identity the roster
does not hold is a case nobody holds.

## Open questions

A hand-over notifies nobody. The recipient learns of the case at their next
visit to the queue. An adopter who wants the team told needs a notification
path this repository does not ship. That is a decision about the adopter's own
channels rather than about the ledger.
