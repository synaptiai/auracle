# A coordinator fault escalates

## Problem

Four checks inside `coordinateTicket` assert an invariant this system owns.
Each threw a plain `Error`, and each escaped the run. The run kept whatever
state it last reached and journalled nothing.

`src/escalations/query.ts` reads its reason from a journalled `escalate`
step. These runs write none, so `pnpm run escalations` shows nothing. The
consumer records `{ outcome: 'error' }` in its own log and leaves the message
queued.

The message then meets `MAX_INTAKE_ATTEMPTS = 50`. Every attempt spends a
classifier budget and files one orphan run. The defect clears on none of
them.

`park` had a second shape of the same problem. It journalled its start, then
checked for an unresolved prior park. A refusal left a `park` row at status
`'started'` with a null result forever.

## Proposed outcome

A defect inside the coordinator reaches the place every other failure does. It
writes an `escalate` journal row with the reason `internal_fault`, and the run
ends at `escalated`.

One of the four checks cannot reach that state, and the runbook says so. The
check that refuses a transition to a missing run row escalates through that
same row. The escalate row is written; nothing moves. The alternative is a
promise this system cannot keep.

The escalate row carries the fault message beside the reason. `EscalationItem`
projects it and `pnpm run escalations` prints it, so an operator files an issue
with the message. The console does not receive it. `toRow` and `toDetail` name
the fields they carry. That is the boundary which trims `reason`.

A step that refuses before it acts leaves no half-written row behind.

## Affected users and systems

Operators working `pnpm run escalations` and the console's runs surface. Both
read the same `escalate` row through `src/escalations/query.ts`.

The consumer. A ticket that met a defect now acks out of the queue instead of
retrying 50 times.

## Constraints

DEC-04 holds. Every step still journals before it acts. The reordered checks
in `park` and `gate` each issue one read and change nothing. The row still
precedes the first thing those steps do to the world. A read is not one of
those things.

DEC-25 holds. A limit escalates and is never an error; this reason is the
opposite case, and it takes the same exit.

Section 4.3 task 3 holds: each step writes to the journal before it acts.
`stopEscalated` stays the single writer of the escalate row, so every reason
reaches the reader in one shape.

A fault is caught by class and not by catching every error. A dropped
connection or a provider timeout may clear on a retry. The consumer's retry
and abandonment floor stays theirs.

## Decisions affected

Affects: DEC-04, DEC-25

DEC-25 states that reaching a limit escalates the run and is never an error.
It fixes the exit a run takes when it cannot finish its work. This change
adds one more cause to that exit and changes neither the limits nor what
reaching one does. `internal_fault` is declared beside the DEC-25 reasons in
`EscalationReason` and explained in the same runbook table.

DEC-04 puts every step in the journal before it acts. Two steps journalled
before a check that only refuses, and each left a row that nothing finished.
This change moves both checks above the row. Neither check writes anything, so
the ordering DEC-04 fixes is unchanged. A refusal now leaves no row at all.

## Open questions

An error that is neither a named fault nor transient still escapes the run. A
`TypeError` is the realistic case. It meets the consumer's retry ceiling and
is abandoned there, which records the ticket but names no reason. Widening the
catch would turn a dropped connection into a permanent escalation, so the
boundary stays where the class is.
