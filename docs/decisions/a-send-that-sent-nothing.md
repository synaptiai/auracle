# A send that sent nothing

## Problem

The relay escalates every failed send of the mail adapter as `delivery_unknown`.
That adapter has no idempotency key and no read-back. So the DEC-30 matrix
cannot tell one failure from another.

The adapter reads the parked draft over IMAP before it opens SMTP. A dropped
connection during that read stops the send before anything leaves the system.
The run still escalates, and an operator reconciles a reply by hand that the
next scan can send.

## Proposed outcome

An adapter can report that an attempt sent nothing. It throws
`NothingSentError`, which says whether the fault is transient or permanent. A
retry can clear a transient fault. A permanent fault recurs on every scan, and
no attempt can ever reach the customer through it.

The relay reads that report before the DEC-30 matrix. A transient fault leaves
the record pending, and the result names the cause. A permanent fault sets the
record to `not_sent` and escalates the run. Any other failure goes through the
matrix as before.

The mail adapter reports a fault as transient when the server gives no answer
that refuses the read. A dropped connection, a timeout and a goodbye before the
login are examples. So are a throttle and a refusal with the try-later code
`UNAVAILABLE` or `INUSE`. Two faults are permanent: a draft with no To address, and a bad draft
id or key.

A refusal from the mail server proves nothing about an earlier attempt. That
covers a refused login, a refused mailbox or FETCH, and a draft or Drafts
mailbox that is gone. A person can send the draft from a mail client, and that
moves it out of Drafts. A relay can also stop between its send and its status
write. The record then stays pending, and the reply is out.

So each of these faults goes through the matrix, and escalates as `delivery_unknown`. A failure
of the SMTP step does the same.

When the ledger refuses an escalation, the record stays pending. The relay
process keeps the escalation it owes, and writes it on a later scan instead of
sending the record. The relay process alone keeps what it owes. A relay that restarts,
or a second relay process, can still send the record once more.

## Affected users and systems

- The relay, its daemon, and the mail adapter's send.
- The ledger. Migration 040 adds `not_sent` to the outbox status CHECK.
- The escalations reader and the console. Both read `not_sent` as they read
  `malformed`: the relay escalates the record, and the customer has no reply.
- Operators, who no longer reconcile a reply that never left.

## Constraints

- DEC-30: a send whose delivery state is unknown still escalates. Only a proof
  that no attempt reached the customer writes `not_sent`.
- DEC-29: the delivery rule still decides every failure the matrix reads.
- DEC-04: the record's status and the run's escalation commit in one
  transaction, as for every other escalation.
- No retry budget beyond what the relay already applies to a pending record.
  The relay applies none, so a transient fault retries on every scan.

## Decisions affected

Affects: DEC-04, DEC-06, DEC-24, DEC-29, DEC-30, DEC-49, DEC-51

DEC-30. The decision escalates an unknown delivery state, and this change keeps
that. A record that no attempt delivers has a known state, so DEC-30 does not
call for an escalation. A blind retry is the failure DEC-30 rejects. A retry
after a proof that the attempt sent nothing is not blind.

The change also closes a gap in DEC-30. A refused escalation leaves the record
pending, and a later scan writes the escalation instead of sending the record.

DEC-29. At most once forbids a second delivery. An attempt that sends nothing
delivers nothing, so a retry delivers once. The relay therefore leaves such a
record pending under either rule.

A read-back that finds nothing is different.
It is an observation of the target, and the target can lag behind a send. So
the matrix still escalates an at-most-once record on that answer.

DEC-06. The relay does not read the adapter's capabilities for this report. An
adapter with an idempotency key leaves a record pending under the matrix. A
permanent fault would then repeat on every scan, so it escalates.

DEC-24. The relay leaves a record pending after an uncertain send when the
adapter has an idempotency key. So a permanent report covers every attempt
under the key, not one call. An adapter with a key reports a permanent fault
only when no earlier call under that key delivered. The mail adapter has no
key, and every uncertain failure of its send escalates.

DEC-49. A `not_sent` record does not close its turn, as a `malformed` record
does not. The relay never sends it, so a later message can park a new attempt.
A send-back still refuses while a helpdesk copy that a person can send exists.
The mail adapter keeps its draft, so the send-back refuses there.

DEC-04. The `not_sent` escalation commits the record's status, the run's state
and the journalled cause in one transaction.

DEC-51. A scan drops what it owes for a record it no longer finds pending,
because another relay settled it. An undo never deletes such a record. An
undo acts only while the record's hold runs, and the relay sends only after
the hold ends.

The console heading and the escalations list are implementation details. They
read `not_sent` as they read `malformed`.

## Open questions

None.
