# Each turn says what became of it

## Problem

The conversation page draws each turn in a fixed 132px column beside the
text. A turn shows its number, its ticket and a link named after the run state.
It shows no time. Nothing says in words whether the system answered alone, a
person approved the reply, or a draft still waits.

Every reply sits under the heading "the system replied". The heading appears
over a draft nobody sent and over a sentence that says no reply went out. It
also appears over an approved reply the relay did not send. A resolved run
commits its outbox row, and nothing more.

## Proposed outcome

Each turn shows its number, the time its message arrived and one outcome chip.
The chip reads the facts the reply's absence reads, so the two cannot disagree:

- `auto-answered` for a resolved run that records no approver and holds no reply
  text. A run approved before `db/016` with no reply text reads the same way.
- `approved` for a turn with reply text, or an approval with no reply text.
- `waiting for you` when the newest run waits for a person.
- `in flight` for a run that is still running.
- The recorded run state for a run that stopped, such as `escalated`.
- `no run` for a turn no run joins.

The turn reader returns the status the relay recorded on the turn's outbox row.
Only `sent` draws a chip in the success colour. Any other status joins the chip,
as in `approved · pending` or `approved · fenced`.

A turn shows its newest run, and reads the newest outbox row of any of its runs.
On a turn with reply text, only the approval row that names the reply's draft
counts (DEC-24). A retry of the same action writes no row and stops
`superseded`. So the row can belong to an earlier run. A newest run that waits
for a person says `waiting for you`, because the approval queue lists it.

A settled run is a resolved or superseded run, or no run at all. On a turn with
reply text, a settled run reads as the row says. Any other run shows its state
beside the row, as in `approved · escalated · pending`. An escalation, or a row
that is neither sent nor pending, draws hot. A turn with no reply text shows a
stopped or running run the same way, as in `superseded · sent`.

The heading over reply text says what the customer has, and reads the row
alone. The heading over an absent reply reads the run:

- "the system replied" when a person approved text and the relay marked its row
  sent.
- "approved, send pending" while the row is pending.
- "approved, never sent" for a malformed row, which the relay refuses before
  any send.
- "approved, delivery not confirmed" for a fenced or unknown row.
- "a person approved this reply" when no outbox row exists to ask.
- "waiting for a person" over the absent reply of a parked run, whose absence
  uses the warning colour.
- "the reply" over any other absent reply. The sentence below it says what
  became of the run. A stopped run beside a row the relay did not refuse also
  names what became of that row's action. That action may not be a reply.

The customer's message and the reply read in the serif. An absent half reads in
the serif too, muted and italic, in place of the text. This page names an
approved reply that holds no text. The time and chip sit beside the text while
there is room. When the thread is narrower than about 490px, they move above it.

## Affected users and systems

A reviewer, who reads a conversation from a case or a run. The turn reader in
the core, which gains the newest outbox status of each turn's runs. The console
maps that status and the turn time, and names no SQL.

## Constraints

The console names no SQL. The new status and its closed set come through the
core reader and the `ledger-read` barrel. The reader issues SELECT statements
only.

An absence stays a sentence, never a blank. The reader gains no absence code.
The two message absences keep their wording. So do the six reply absences,
with two exceptions. The stopped-run absence names the row when the relay did
not refuse it. The waiting absence says the turn waits for a person, and never
that a reply is drafted.

## Decisions affected

Affects: DEC-04, DEC-12, DEC-24, DEC-28, DEC-30, DEC-34, DEC-35, DEC-42

DEC-04 commits the run state and the outbox row together. So a resolved run
proves the row exists, not that the relay sent it. The page reads the row's
status before it claims a delivery. A run that loses the insert to an earlier
row stops `superseded`. So the turn reads the row across all its runs.

DEC-12 sends every customer reply through a person. So a person approved every
turn with reply text, and the chip never calls one automatic.

DEC-24 derives the key from the action. So a turn can hold the reply's row and
a row for another action. Each row holds its own status. The approval
records reply text only in the transaction that writes a row naming the draft.
So a turn with reply text reads that row alone.

The relay sends that draft only for the customer reply action. A profile that
pairs a draft with another action is a startup defect (#124).

DEC-28 checks the fencing epoch again at each scan. A send can time out and
leave its row pending, and a later scan can then fence that row. The first send
may have reached the customer. So a fenced turn says nobody can confirm the
delivery, and never says the reply was not sent. Only a malformed row says so,
because the relay refuses that row before any send.

DEC-30 escalates a send whose delivery nobody can confirm. The approval writes
the reply text before the relay sends it. So a turn whose run escalated names
that state in a hot chip. Its heading says the reply was sent only when the row
is `sent`.

DEC-34 lets an internal write park in the ledger with no draft and no customer
text. So a parked turn says it waits for a person, and never that a reply is
drafted.

DEC-35 makes a conversation a ledger entity. The page reads the thread and its
turns from the ledger alone, and holds no state of its own.

DEC-42 records an approver on an approval. The chip calls a resolved run with no
recorded approver `auto-answered`. A run approved before `db/016` added the
column records none, so the chip cannot tell it apart.

## Open questions

None.
