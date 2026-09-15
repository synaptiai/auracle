# Each case has a page

## Problem

The queue draws one case in a pane beside the list. A reviewer reads the reply,
its claims, the gates and the button in a column 300px narrower than the page.
The pane does not say why the case reached a person in words, and it names no
customer. Nothing tells apart an accepted sentence from a refused one except
colour. A document the run still matches draws no flag, so a reader sees two
states where the ledger holds three.

An approval from the console records no approval-edit distance. It reads no
draft back, so it can never refuse because the parked draft is gone.

## Proposed outcome

Each case has a page at `/case/<run>`. The queue becomes a list, and each row
links to its case. A queue link that names a run opens that case in one
redirect. The approval returns to the case it approved, with the ledger's
answer above it.

The case has two columns that wrap below about 800px of case width. The main
column holds the customer's message, the reply sentence by sentence and the
documents the reply cites. The context column holds four cards:

1. Why this is yours. The policy rule the journal recorded and what it means.
   While the case waits, it also says what approving does and how the relay
   delivers it.
2. The two gates, as two rows. A gate with no value shows a dash and its reason
   as text.
3. This customer. The turn, when the conversation opened, its state and whether
   the ledger names a participant. A sentence names what the ledger does not
   hold.
4. How the run walked. The steps as a timeline, with no durations.

Each sentence carries a word: accepted, refused, not judged or courtesy. Each
cited document carries one of three flags: unchanged, changed since this run
read it, or not compared.

A bar at the foot of the window holds the approval. Its warning says whether
the act can be undone. A case that is not waiting opens, and offers nothing to
approve. Only an approval draws in the success colour, and only on a run that
has left the queue.

The console reads the draft back when `APPROVE_ADAPTER` names `imap-smtp` or
`freescout`. The approval then records the approval-edit distance against the
helpdesk copy, and refuses as `draft_missing` when that copy is gone. Unset or
`helpdesk` reads nothing back, and the case says the approval records no
distance.

A read that fails or does not answer within four seconds is its own outcome.
The case says the console could not read the draft back, and nothing commits.
The log names the fault. Four seconds sits inside the five-second shutdown
grace and leaves the rest of it for the approval's statements.

When the console gives up, the adapter closes the connection it holds. The
console builds the adapter at startup. A bad name or a missing variable stops
it before it serves a page.

A case page opens one run. The register's glossary names a case as the runs of
one ticket a reviewer takes. The reservation DEC-46 adds is what gathers those
runs; this page shows the run a reviewer approves.

## Affected users and systems

A reviewer, who opens a case from the queue. An operator, who sets
`APPROVE_ADAPTER` for the console. The approval CLI, which shares one adapter
map with the console through the `ledger-read` barrel. The queue, which reads
no journal. The run detail, which gains the verdict words and the third flag.

## Constraints

The console names no SQL. The case reads the run through the run detail's
read, and the customer through the conversation's read.

The console adds no ledger outcome. `approveRun` reads the draft before its
transaction opens, so a failed read commits nothing. The command line still
reports that fault as an error.

The case invents no customer detail. The ledger holds no name, plan, tenure
or history, and the case shows no address.

## Decisions affected

Affects: DEC-05, DEC-11, DEC-12, DEC-29, DEC-30, DEC-40, DEC-43, DEC-44

DEC-05 keeps agreement and coverage apart. The case draws them as two rows,
each against its own lines, and draws no value made of both.

DEC-11 keeps the draft in the helpdesk. The console still composes nothing. It
reads the helpdesk copy back and measures the edit a person made there.

DEC-12 puts a person on every customer reply. The case names the rule that sent
it to a person from the journal. On a ledger whose adapter cannot deduplicate a
send, that rule is `no_idempotency`, and the case says so.

DEC-29 declares a delivery rule for each action class. The case says in words
what the recorded rule means for the approved act.

DEC-30 escalates a delivery whose state is unknown. The case says an
at-most-once act escalates rather than repeating when nobody can confirm its
send. A read-back that fails is a fault the case names, never a missing draft.

DEC-40 lets the console approve, and an approver reads what they approve. The
case reads the run its path names and posts that run. The reply stands above the
bar that sends it.

DEC-43 labels each sentence a claim or a courtesy. The case names a courtesy
sentence in a word, beside the words for the judge's verdicts.

DEC-44 makes the reviewer console the primary place a person reviews a gated
action. A case with a page of its own is the unit a reviewer works.

## Open questions

None.
