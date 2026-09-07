# Intent: A gold set with conversations (DEC-35, DEC-39)

## Problem

Section 6 said the thresholds "were fitted" without conversation history. Two
statements in that sentence were wrong. No fitting run had happened at all,
and the corpus could not carry history even if one had.

`turn_number` was optional, never written and never checked. No case carried a
`conversation_id`. All 770 cases were first turns, so DEC-37 had no fixture
that exercised it and DEC-39 removed nothing.

The cause was structural. The generator held one subject and one body per
intent, so a conversation had no shape to take.

## Proposed outcome

A case is one turn. Turns of one thread share a `conversation_id`, number
from 1. They also repeat the intent, the queue and the disposition of the
thread. The turn that another turn follows carries the reply that answered
it. The last turn carries none, because the reply to it is what a run would
produce.

That mirrors the ledger, where `turn.approved_reply_text` also hangs off the
turn it answered. It takes no turn number of its own.

Both halves still hold 385 cases, and a half is filled with whole threads. A
thread that straddled the split would leak DEC-31, so the loader refuses one.

A follow-up message names no topic. It is classifiable only from the turns
before it, which is what DEC-37 puts in the prompt. Of 107 later turns in the
fit half, 66 are unclassifiable without their history.

## Affected users and systems

Every consumer of the gold set, and the published numbers.

## Constraints

DEC-18: every value stays invented.

DEC-31: 770 cases, 385 per half. The count is unchanged; what changed is that
a case is now a turn.

DEC-39 and DEC-31 together shrink the scored population. The report half holds
385 cases and 287 of them open a thread. The published numbers cover those
287, and the README states the count beside each rate.

The offline stub matches phrases first-match-wins over the whole prompt, and
history now sits in that prompt. Every agent reply names its own intent and
avoids the topic words of the intents above it in that table.

## Decisions affected

Obeys DEC-35, DEC-38, DEC-39, DEC-18 and DEC-31. Corrects section 6, which
claimed a fit that never ran.

One text rule, in one place. `goldCaseText` composes a case exactly as the
intake adapter composes `ticket.ticketText`. The ledger stores that in
`turn.body_text` and reads it back as history. The replay used a single
newline and the history builder dropped the subject. Both now call that
function, so an offline prompt and a runtime prompt cannot diverge.

## Open questions

An invented reply names the topic of its own thread. So a synthetic
follow-up is easier to label than a real one. A follow-up body also comes
from five fixed strings. Section 6 records both caveats. The real corpus
exporter still folds a thread into one record and models no turns.

The induction job reads every turn, which DEC-02 wants: a follow-up is
history. Later turns raise the distinct text count from 114 to 220 across
the 770 cases. So they add variety rather than duplication. The clustering
itself is untested against them, because the job needs a model.
