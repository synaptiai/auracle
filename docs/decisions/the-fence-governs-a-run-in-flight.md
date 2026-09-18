# The fence governs a run in flight

## Problem

A consumer start raises the fencing epoch of every ticket with a run in the
partitions it claims.
That fence also covered work no consumer holds.
A parked reply carries the epoch of the run that parked it.
An approved record waiting for the relay carries it too.
The raise refused both.

Three symptoms followed.
An approval of a parked reply returned `stale_epoch` after any deploy.
The reply waited, and nobody could move it.

The relay marked an unsent record `fenced` and stopped.
The run stayed `resolved`, as if the customer had been answered.

A later run on the same ticket raised the fence the same way.
A customer follow-up then stranded the reply parked for the earlier turn.

## Proposed outcome

The fence governs a run that is still in flight, in a state a consumer
drives.
Those states are received, classified, retrieved, composed, gated and
executing.
Work that has left a consumer's hands keeps its epoch, and its own guards
settle it.

- A consumer start raises the fence only for tickets holding an in-flight run.
- An approval commits whatever the ticket's fence says.
  A person's write is not an old owner's write.
- The relay sends a record whose run has finished, whatever the fence says,
  and refuses every other record.
  An in-flight run's record stays unsent.
  The refused row keeps the key a re-run would collide with.
  A parked run's goes because nothing approved it.
  A refusal moves that run to `escalated` with a journalled reason.
- A run's epoch is allocated under the ticket row lock.
  Two creations on one ticket then never share one.

The guarantee DEC-28 states is unchanged.
An old owner still walking a run fails its next fenced write.
That holds at every hop and in every in-flight state.

## Affected users and systems

This change touches the operators who approve replies, in the console and in
the helpdesk.
It touches the relay, the consumer fleet, and the `ticket_epoch`, `run` and
`outbox` rows.
No table, no column and no key changes.

## Constraints

- DEC-28: every write carries a fencing epoch.
  That epoch only increases per ticket, and the ledger checks it at insert
  and at send.
  This change narrows which writes that check governs.
  It removes neither check.
- DEC-24: the idempotency key decides which record carries an action.
  The key makes a re-run single-shot, and it never was the fence's job.
- DEC-12: a customer reply waits for a person.
  A wait nobody can end contradicts the decision that created it.
- The outbox keeps the five statuses db/006 allows.
  No status is added.

## Decisions affected

Affects: DEC-12, DEC-24, DEC-27, DEC-28, DEC-29, DEC-30

DEC-27 charges the rebalance procedure as the cost of partitions.
This change keeps the procedure and narrows the population it moves: the
tickets whose runs are in flight.
A parked reply and a finished run pay nothing.

DEC-29 gives each action its delivery rule, and the relay reads that rule
from the record.
It reads it exactly as before.
This change decides only which records the relay sends.

DEC-30 escalates a send whose delivery state is unknown.
The refusal this change adds uses the same path: the record stops, and the
run escalates with its cause.

DEC-28 states the check and the monotonic epoch.
This change states what the check governs: a run a consumer is still
driving.
A run parked for a person and a run that has finished are outside it.
No owner can be stale with respect to work it does not hold.
The check at insert and the check at send both remain.
A refused record now names its cause where an operator reads it.

DEC-24 is why a finished run's record can still be sent after the fence
moves.
The semantic key proves which record carries the action.
A re-run of the same action loses the insert.
The fence never decided that; the key does.

DEC-12 is why a parked reply must stay approvable.
A deploy is not a decision about a person's queue.
Refusing the approval left the reply with no path forward.

## Open questions

None.
The relay's refusal writes the fence and the record's epoch into its journal
reason.
The escalations report reads that reason, unless the run already carried one.
A run keeps the first reason it escalated with, which is what an operator
needs to see.
