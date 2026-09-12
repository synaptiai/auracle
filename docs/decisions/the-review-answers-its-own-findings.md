# Intent: The review answers its own findings

## Problem

A six-facet review of this branch found defects the branch itself created.

Conversation membership rested on evidence the sender writes. A message that
named a victim's Message-ID joined the victim's conversation, and `db/010`
then stored its text there. The later turns of the victim's own thread carried
that text into the prompt.

The history renderer marked who spoke and interpolated the body raw. A
customer could write a marker of their own and forge an agent turn. The gates
cannot catch that, because they read retrieved documents alone.

The turn lookup that makes DEC-38 safe had no test. Delete it and every test
still passed. A message redelivered after its ack took a second turn,
derived a second key, and served the customer twice.

Six more paths swallowed the error they handled. The webhook discarded every
intake failure. The duplicate-draft guard answered null when its search threw.
The ack ignored a zero-row delete. The relay recorded no cause for a send
it could not complete.

## Proposed outcome

A join is checked against the sender. A marker inside a body loses its
brackets. A message with no id of its own gets one derived from its content.
So a redelivery under a new delivery id is still one turn. Every swallowed
error is recorded, and the ones that mean an inconsistent ledger now throw.

A message that fails five times leaves the queue as an escalated run that
names the cause. It is not retried on every scan forever.

Each fix carries a test proved to fail without it.

## Affected users and systems

Intake, the coordinator, the relay, the webhook ingress, the mail egress and
the operator views.

## Constraints

DEC-26 pins the prompt. The renderer changes only a body that carries a forged
marker or exceeds the ceiling. The committed corpus renders byte for byte
as before, so no pin moves.

DEC-17 requires the data guarantee to be configurable and documented. It is
read from `AURACLE_ZDR_ONLY` now, and absence still means off, which DEC-17
requires.

An address is evidence, not proof. A null on either side allows the join, so
a source that names nobody is not locked out.

## Decisions affected

Affects: DEC-35, DEC-37, DEC-38, DEC-30

Obeys DEC-35, DEC-37 and DEC-38. Obeys DEC-30: no new path retries an unknown
delivery. Obeys section 4.2 rule 2, extended to the delete and the update that
were exempt from it.

## Open questions

The ledger stores customer message text and ships no purge job. `README.md`
now states that obligation. The job itself is not built.
