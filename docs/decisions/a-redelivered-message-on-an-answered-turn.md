# A redelivered message on an answered turn

## Problem

A message source delivers at least once. So a message the system already
answered can arrive again, and intake files it on the same turn. The consumer
then walks it to a second park.

Some helpdesks take no idempotency key. There the second park makes a second
draft, with a handle of its own. The approval already refuses a second reply
on the turn, and the consumer's scan ends the run. But the draft stays in the
helpdesk, where an agent could send it by hand. The ledger also recorded no
reason for the run it ended.

## Proposed outcome

A reply park reads the turn before it parks. It parks nothing when the turn
already holds a customer reply. It also parks nothing when another run of the
same attempt already waits with the turn's reply. The run stops superseded, and its journal
names that run. A redelivered message is the same request as the one it
repeats, so the run that parked first owns it.

The park reads both answers in one statement. An approval that commits during
that read is then seen either as a waiting run or as its record.

When the consumer's scan ends a waiting run, it records the reason too. Either
another run answers the turn, or a reviewer sends the attempt back. The run
page shows the reason.

The scan reads the answer under the turn's lock. The undo takes that lock
before it removes a record. So a recorded answer is true when it commits. A
scan that finds the answer already undone leaves the run waiting. A later undo
can still remove the answer, so the run page words each reason in the past
tense.

The undo reads the clock after it holds that lock. So an undo that waits past
the end of its hold refuses, and removes nothing.

Two walks of one message on one ticket can overlap, after a rebalance or a
crash retry. The older walk parks a draft and then stops stale. The newer walk
finds that draft and gives the turn back to the older run. That run then waits
for a person. The newer run stops superseded and names the older run. No second
draft exists, and the run that waits made its own draft.

The park records its intent in a fenced write before it calls the helpdesk. A
stale walk stops there, before it can make a draft. A marker the ledger
accepted stays until the park records its outcome. A newer walk that finds
that marker escalates, and a person reconciles the draft.

A walk with no turn gives no turn back, because it names no request to match.

## Affected users and systems

The park step, the consumer's scan, the approval, the undo, the journal reader
and the console's run page. The reviewer who opens a superseded run reads why it
stopped.

## Constraints

Every customer reply waits for a person (DEC-12). The idempotency key comes
from the action semantics, so the fix adds no key (DEC-24). A redelivered
message keeps its turn (DEC-38). A turn takes one reply (DEC-49). A
compensation on the same turn is not a second reply (DEC-34). The new suite
uses synthetic data only (DEC-18).

## Decisions affected

Affects: DEC-12, DEC-18, DEC-24, DEC-25, DEC-28, DEC-34, DEC-38, DEC-44, DEC-48, DEC-49, DEC-51

DEC-12 is kept. No reply reaches a customer without a person. A redelivered
message no longer puts a second draft in the helpdesk either.

DEC-18 is kept. The suite that walks the redelivery holds synthetic tickets and
text alone.

DEC-24 is unchanged. The park reads the turn's records and derives no key.
An overlapping walk is the same request, so the run that parked the draft
answers it. The approval derives the key that park earned.

DEC-25 is kept. A run that stops by handing its turn back records its own cost
and step count. The run that waits again counts its park as a step.

DEC-28 is unchanged. The ledger fences each ticket. When a newer walk of a
ticket runs, the ledger refuses the next state move of the older walk. The
newer walk holds the fence, so it moves the older run to wait. It does this on
that ticket alone, and only for an older run below its own epoch.

DEC-34 is kept. A waiting reply is a park that names a draft, or one of the
reply's action class. A compensation is neither, so it still parks on an
answered turn. The park, the approval and the scan read a waiting reply that
one way.

A record that names a draft answers a turn. A record of the reply's class with
no draft never reaches the customer. The relay refuses it as malformed.

DEC-44 is kept. A reply held in the ledger alone keeps its hold and its undo.
The undo now waits for the turn's lock, inside one budget for all its locks.

DEC-48 is kept. Intake ends a snoozed run when the customer writes again. The
hand-back judges both runs before it takes the fence. So it never holds a
snoozed run while it waits on intake.

DEC-38 is unchanged. A redelivered message still keeps its turn, and that is
what lets the park find the reply.

DEC-51 is kept. An undo that reports success still guarantees that the relay
sent nothing. It reads the clock after the last lock it waits on.

DEC-49 gains a record. A run stops when another run answers its turn. It also
stops when another run already waits with the reply, or when a reviewer sends
its attempt back. Its journal says which.

## Open questions

A turn can still hold two waiting runs. Runs parked before this change can do
so. So can two tickets of one conversation, which the epoch does not fence
against each other. The approval's check and the scan keep the customer to one reply.
On a helpdesk that takes no idempotency key, the second draft stays until a
person deletes it. No adapter here can delete a draft.

A newer walk can escalate on the marker of an older walk that then makes its
draft. A later redelivery gives the turn back to the older run. The queue then
holds the escalation and the waiting run for one draft. A person closes the
escalation.

A reply parked in the ledger alone, under a profile that shows no customer,
owns its turn once it waits. Its approval ends as an escalation, because the
relay refuses such a record. A person then handles the case.
