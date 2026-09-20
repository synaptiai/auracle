# A snooze that comes back

## Problem

Not every case can be answered now. The customer is away, a parcel is in
transit, or the answer waits on somebody else. The reviewer has two choices
today. Approve something early, or leave the case in the queue, where it looks
like work nobody is doing.

DEC-48 gives those cases a state of their own. `snoozed` is not terminal. The
run leaves the queue for a period the reviewer sets, and comes back.

Two things must follow from that, and neither is free. A snoozed run must
never count as work. Otherwise the wait becomes service time in the latency
report. That is the one number an operator reads as how long the system takes.
And a snooze must not wait forever: something has to end the wait.

## Proposed outcome

A reviewer puts a waiting case aside for a period, in minutes. The run leaves
the queue, records when it is due back, and returns by itself.

- The case page carries the snooze under the approval, with the period in the
  form. The bounds are a minute and thirty days, and the ledger answers a
  period outside them.
- The run lands `snoozed`, with the moment it is due in `run.snoozed_until`.
  Nothing sends: no outbox record, no approver, no finish time.
- The consumer returns the due cases of its own partitions on every scan. The
  case is in the approval queue again within one interval.
- The customer's next message ends that run as `superseded`, in the
  transaction that records the message. The new turn's run takes the case.
- The control bands count a snoozed case as still to land, beside the cases
  waiting for a person.
- The latency report keeps every run that was ever snoozed in a class of its
  own. Its duration is never the distribution's.

## Affected users and systems

The reviewer puts a case aside and sees, on the case, when it comes back. The
customer sees nothing: a snooze reaches nobody. The operator's numbers move in
the two ways the design table states, and in no others.

The DEC-46 reservation is untouched. Who holds a case is the team's business,
and how long it waits is the customer's.

The change touches the run's vocabulary and one column. It also touches one
write, the consumer's scan, two reports, and two console pages. The
conversation page names a case a person put aside, rather than calling it work
in progress.

## Constraints

- The moment is a column and not a claim on the state. The returner scans it,
  and it stays after the return. The latency class reads it as the record that
  the run was ever snoozed. A cleared column would lose that at the return.
- A parked run is outside the fence (DEC-28), and `snoozed` joins the parked
  states. The walk ended, and the next writer is a person or the clock. The
  return names the state it requires, which is the condition the escape asks.
  A parked write reads no fence, so it takes no fence lock. That keeps the
  return out of a cycle with intake. Intake takes the fence first and the
  conversation's runs second.
- The customer's message ends that run inside intake's transaction, under the
  conversation row's lock. The new turn and the end of the old run commit
  together. The case cannot be both superseded and returned.
- The chain stops, in both orders. A run the message supersedes never returns,
  because the return requires the state `snoozed`. A run the clock already
  returned is superseded too. It still answered the older turn, and the moment
  in `snoozed_until` marks it. A case nobody put aside is untouched, so an
  ordinary parked run stays a person's to answer.
- A case is put aside again as often as its period ends. The journal row is
  the step's own. The second cycle rewrites it, so the pair names the latest
  person and moment.
- The bounds are a minute and thirty days. Below a minute is not a wait, and
  above a month is a case the team has forgotten.

## Decisions affected

Affects: DEC-04, DEC-12, DEC-24, DEC-28, DEC-35, DEC-42, DEC-44, DEC-45, DEC-46, DEC-48

DEC-48 is the row this change ships. A reviewer may snooze a case. Each job
counts it for what it is: pending in `bands`, and its own class in `latency`.

DEC-04 puts the records in the journal. Setting a snooze writes one row naming
the reviewer and the moment. The return writes its own row. A run brought back
by the clock is a fact its timeline has to carry. The end a customer's message
causes writes no row, exactly as the key-loss supersede writes none. The state
is the record.

DEC-24 is stated rather than changed. A snooze carries no outbox record, so
there is no semantic action to key.

DEC-28 is stated too: a snoozed run is parked, and the fence does not reach it.

DEC-35 decides that the customer's message ends the snooze. A conversation
owns its turns, so the run that answered an older turn is the one a newer turn
replaces.

DEC-45 governs the name, and DEC-42 the claim it is. The reviewer who set the
snooze is recorded with what the name proves, beside the moment on the journal
row.

DEC-12 says a customer reply waits for a person. A snooze is not a reply: it
sends nothing, and the run waits for the customer. What it shares with a
parked run is that the walk has ended.

DEC-44 decides which text a page drew, and so which text the guard compares.
A snooze compares the saved reply where the adapter's ledger holds it. The
approval, the save and the close compare the same text.

DEC-46 governs the reservation. A snooze does not move it, and it does not
end it. Who holds the case is the team's business. How long it waits is the
customer's.

## Open questions

The console offers minutes. An adopter who wants the period in days, or from
a fixed list, changes one form. The ledger takes milliseconds and states its
own bounds.

A snooze that ends while the console is the only process running stays
`snoozed` until a consumer next scans. The console could return it on read.
That would be a read that writes, which this repository keeps out of its query
modules. The case is due rather than urgent.
