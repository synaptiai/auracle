# A take reserves the case

## Problem

The queue is uncapped, and four reviewers pull from it. Nothing records that a
reviewer is working a case, so two people can read the same one. The fencing
epoch stops the second write, but only after both have read the case. Nothing
records how long a case held a person either.

## Proposed outcome

A reviewer takes a case before working it. The take marks the case held by
that reviewer for a period. Every other reviewer sees who holds it, and how
long is left. A second reviewer may take it over after confirming. The earlier
holder learns of the move at their next action.

- The hold is advisory. It refuses no write, and the fencing epoch and the
  run's row lock stay the guards.
- A hold lapses on its own after a period without activity. The period is
  twenty minutes by default, and `CONSOLE_HOLD_LAPSE_MS` moves it.
- One case per person. Taking a second case, or being handed one, releases
  the first.
- A send ends the hold on the case it resolves, whoever holds it. An
  approval the ledger supersedes sends nothing at all. The case left the
  queue under another run's record, and the hold ends by its period.
- Every take, release, handover, send and lapse is recorded with its reviewer
  and its time.

## Affected users and systems

The reviewers who pull from the queue. The console's queue and case surfaces,
the two new ledger tables, and the approval path. The ledger's
`fencedTransition` seam gains one optional precondition.

## Constraints

- DEC-46: a console outcome applies only to the case as its reviewer was
  shown it. The take and the shown-text guard are two halves of that row, and
  this change ships both.
- DEC-28: the fencing epoch stays the guard on a write. The hold adds no
  guard, and it moves no fence.
- The console's writes stay named. `src/select-only.test.ts` holds the list,
  and `LEDGER_WRITES` in the read barrel declares which core functions write.
- Synthetic data only (DEC-18). Every reviewer identity in the tests is a
  synthetic one.

## Decisions affected

Affects: DEC-11, DEC-12, DEC-18, DEC-28, DEC-40, DEC-45, DEC-46, DEC-48

DEC-46 is the decision this change ships. It asks for a reservation, a lapse,
and a rule about the case a reviewer was shown.
The hold records who is working; the reply digest refuses a send of a reply
that changed under them.

DEC-28 governs the write this change reaches. The ledger's fenced transition
gains one optional precondition, checked under the row lock and before the
first write. The epoch still decides first, and a precondition that refuses
writes nothing.

DEC-12 and DEC-40 govern the approval this change touches. Sending still ends
the person's work on the case, and the console still holds no approval of its
own. The change adds a refusal and no new approval path.

DEC-11 says the draft parks in the helpdesk and nowhere else. It is unchanged.
An approval carries a digest of the reply and never its text.

DEC-45 says the console serves nothing to a request with no roster reviewer.
The hold rests on that identity and does not replace it. A handover names a
teammate, and the roster decides whether that name may review.

DEC-18 governs the data every test in this change uses. Each reviewer identity
is a synthetic one, and no fixture carries a real name.

DEC-48 gives a reviewer the outcome of closing a case with no reply, snoozing
it, or handing it over. This change ships none of those: it moves the
reservation, and the case keeps its state. The hold's control says who works
the case next, and DEC-48 will say what becomes of it.

## Open questions

The reservation records time per case. No screen totals it per reviewer, and
whether the team wants such a view is open.
