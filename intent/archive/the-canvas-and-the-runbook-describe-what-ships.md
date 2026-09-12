# Intent: the canvas and the runbook describe what ships

## Problem

The design canvas draws a console that does not exist, and the runbook
describes one that stopped existing.

The approvals artboard draws an editable reply with an edit-distance readout.
The console captures no reply text, so it measures no distance. The relay
sends the helpdesk copy rather than anything typed here. The run-detail
artboard draws a bm25 column, a vector column and a fusion score. DEC-21 fuses
ranks and keeps no score, so those are three numbers the ledger does not hold.

The runbook makes three claims the code does not support. The console ships no
JavaScript. It shows a dash where the gate values go. It records the parked
draft as present and never shows it. It also names five surfaces where seven exist.

The runbook states no retention position for the text the console now shows.
`db/010_turn_text.sql` warns that no purge job ships, and nothing says what an
adopter would run instead.

## Proposed outcome

The canvas draws the console that exists, including the two surfaces it gained.
The runbook describes it, and states what the ledger holds about a customer.

An adopter can read what is stored, where, and for how long. They can run the
statements that clear it, and those statements are the ones a test runs.

## Affected users and systems

The design canvas and its join. `docs/operations.md` section 7. No code path
changes.

## Constraints

DEC-19 states the compliance position in documentation and adds no machine
check. So the retention section is a statement and a set of statements to run,
not a job that ships.

DEC-21 fuses ranks and keeps no score. So no artboard may draw a score, and
none may draw a rank the ledger does not store.

DEC-11 keeps a draft in the helpdesk. The runbook has to say that clearing a
journalled draft does not reach the copy an adapter holds.

Simplified Technical English governs every word of this, rules 1 to 5.

## Decisions affected

None. DEC-19, DEC-21, DEC-40 and DEC-42 are cited and unchanged. The canvas and
the runbook are implementation details.

## Open questions

None. The retention period in the published statements is an example, and the
adopter owns the number.
