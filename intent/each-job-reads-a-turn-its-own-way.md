# Intent: Each job reads a turn its own way (DEC-37, DEC-39)

## Problem

`ded8960` landed DEC-39 in the gold report alone. The replay never filtered.
The subject of that commit said "replay scores first turns only" and the
replay did not. The gap was invisible because no fixture carried a turn.

Three further gaps sat behind it.

`ReplayReport` reported `fit.tickets.length` as the fitted population. A half
that carried a later turn would report it as scored.

The calibration job classified a bare message. DEC-37 puts earlier turns in
the classifier prompt, so a threshold fitted on the bare message covers a
prompt the runtime never sends. Section 6 asks for a re-fit on multi-turn
data and the job had no way to do one.

The triage judge read a case the same way. A follow-up message names no topic
of its own, so every follow-up would fall into the uncertain group and fill
the review queue with cases a person cannot read either.

## Proposed outcome

The filter follows what a job scores, not what a job is called.

The replay and the gold report score a disposition. A disposition belongs to
the whole thread, so both score first turns only and both report the filtered
count.

The calibration job scores a prediction against the intent label of the case.
A later turn carries a valid label, so the job fits on every turn, sends the
history the runtime would send, and records the population as `scope`. The
value is derived from the half, so it cannot drift from the data.

The triage judge reads the same text the classifier reads.

`conversationHistories` builds the prompt history for a set of gold cases. It
returns the shape `conversationHistory` returns from the ledger, so an offline
job and the runtime send one shape.

## Affected users and systems

The replay, the calibration job, the gold report and the triage job.

## Constraints

DEC-39 binds a job that scores a disposition. It does not bind a job that
scores a label, and section 6 requires the agreement threshold to be re-fitted
on multi-turn data. Reading DEC-39 as a filter on every job would make that
requirement impossible to meet.

DEC-26 pins the prompt. Sending history changes the prompt for a later turn
only; a first turn's prompt is byte-identical to before.

## Decisions affected

Obeys DEC-37 and DEC-39. Obeys DEC-32: the replay still scores the observed
queue and never the intent label.

## Open questions

No calibration artifact reaches the policy engine yet. The `scope` field
records a population for a number that still gates nothing.
