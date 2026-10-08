# The erasure path clears outbox reply text

## Problem

The runbook publishes the statements an adopter runs to clear customer text by
age. On main, some places that hold such text have no statement. `outbox.reply`
holds the reply text the relay sends from a record, when the ledger holds it.
The `send_back` journal row holds the title of a document a reviewer writes
from a case.

The conversation statement on main clears nothing. It filters on a state that
no code ever sets, so every conversation keeps its participant. An adopter who
runs every published statement keeps all of this, and believes the erasure is
complete.

## Proposed outcome

The runbook table names `outbox.reply`, `intake.ticket_text` and the document
titles that `retrieve` rows copy. A new statement clears `outbox.reply` past
the retention period, on every record the relay is done with. It leaves a
pending record alone. The journal statement also removes `documentTitle`.

The conversation statement reads the age of the conversation, its last turn and
its last run. It never reads the conversation's state, which no code moves out
of `open`. It keeps a participant while any turn or queued message still holds
text. It also keeps one while the conversation has open work, as the consumer
reads it. That is a parked run or a turn due another attempt. It is also a
document request that waits or whose attempt has not landed.

A conversation with none of these clears, even after a run that stops mid-walk.
The runbook states the cost that remains.

Whoever names a message id or the ticket of a cleared conversation joins it.
The first sender with an address claims it.

The runbook gives a block that removes one document written from a case. It
clears the copies of its title and body that the journal keeps, in one
transaction. It refuses an id that names no such document. It also refuses
while the document's re-run request is started and its attempt has not landed.
It locks the request after it clears the journal and before it deletes. So a
consumer that starts the request during the journal pass cannot pass the check.

Once it holds the lock, the block clears the journal again for the runs of the
request's own turn. An attempt of that turn can write a copy while the first
pass runs. Those runs are few, so the lock stays short.

The runbook names the replies that quote the document. It also names the copies
outside the ledger: the helpdesk, the logs, exported files, the model provider
and database backups. It says what clears or governs each.

While the block clears the journal, the console tells a repeat post that the
document is published. The block then removes it. Once the block holds the
lock, a repeat post waits and then refuses. The console then draws no form to
write it back. The wait has the five-second bound of every publish.

A repeat during the journal pass can also ask an ended request again. If the
consumer starts that request before the block takes its lock, the block refuses
until that attempt lands.

The block prints the time it commits, from the database clock. So the runbook
says how to note the case, and how to list every document the case's
conversation publishes. It says how to wait until no run created before that
time still walks. It also says how to find a copy that such a run writes after
the removal.

The retention suite runs the five age statements and the removal block from the
runbook, against a seeded ledger. It fails when a statement loses a filter or a
field it must clear. It also fails when the block loses a statement or any of
its checks.

## Affected users and systems

An adopter who runs the published erasure statements. The relay, whose pending
records keep their reply until it sends them. No code path reads the reply of a
record the relay is done with. A sender who writes to a conversation whose
participant the purge has cleared. A reviewer who repeats a post while a person
removes its document. Once the block holds the lock, the console tells that
reviewer that a person removed it.

## Constraints

- DEC-17 makes the data position the adopter's to choose, and the ledger
  stores customer message text. The statements stay examples an adopter runs,
  not a job this repository ships.
- DEC-19 requires the documentation to state the compliance position. The
  runbook table is where it names each place the ledger keeps customer text.
- DEC-35 keeps conversation state in the ledger. Intake fills an empty
  participant from the next sender and never overwrites a recorded one.
- DEC-44 lets the ledger hold the reply text the relay sends from a record. A
  pending record still owes that reply, so the purge never touches one.
- DEC-50 lets a reviewer write a document from a case. Such a document
  answers later cases, so no age statement removes it.

## Decisions affected

Affects: DEC-17, DEC-19, DEC-35, DEC-44, DEC-50

DEC-17 holds: this repository ships no retention job, and the adopter owns the
period. The change gives the adopter the statements that clear what the ledger
holds. DEC-19 holds: the position the documentation states now matches the
ledger, field by field.

DEC-35 holds: the purge clears a participant and leaves the conversation.
Intake's rule for an empty participant is unchanged. The runbook states what
that rule means after a purge. The statement waits until the conversation holds
no text and no open work.

DEC-44 holds: a pending record keeps the reply the relay still owes. DEC-50
holds: a document written from a case stays until a person removes it. The
removal clears each copy of its title and body in the journal.

None of the five decisions changes.

## Open questions

None.
