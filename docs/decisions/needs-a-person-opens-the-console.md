# Needs a person opens the console

## Problem

The console opens on a list of runs, which an engineer audits. A reviewer
comes to clear the approval queue, and that queue is one flat list in arrival
order. Nothing sets an action nobody can undo apart from a routine reply. Nothing
sets apart a case whose two gates both read well. The console cannot say how
many messages arrived today, or how many of them reached a person.

## Proposed outcome

The console opens on the queue, named Needs a person, at `/`. The runs list
moves to `/runs`. `/approvals` redirects to `/`, and `/?state=` redirects to
`/runs`, each with its query kept. A bare `/` opens the queue.

The queue draws three groups, in the order a reviewer works them:

1. Irreversible or high risk. The rule `irreversible` or `high_risk` stopped
   the case, the gate recorded a high-risk intent, or the case parked a
   compensation.
2. Both gates clean. The agreement cleared its own line, and the coverage
   cleared the review line.
3. Everything else waiting.

The oldest case comes first in each group. The queue draws no group that holds
nothing. A filter that matches nothing says so in a sentence.

A row names a compensation when its rule does not, and a high-risk intent when
its rule does not. A row whose gate recorded no tier says so. A line under the
header links to the escalated runs, which wait for a person and have nothing
to approve.

A note under the clean group says that the console never blends the two gates. It
says that neither gate decided those cases, and that the row names the rule
that did.

The header states two counts for the UTC day. One is the messages that
arrived. The other is how many of those messages a run parked for a person.
Each counts once, on the day it arrived. A run that recorded no message counts
on the day it started, so the second count can exceed the first.

The header states no share of one count in the other. A fault reading the
counts names a log tag, and the queue still draws.

A queue row wraps at a narrow width. The ticket keeps room of its own, and the
age drops below it. Below 720px the list stacks above the case it draws.

## Affected users and systems

A reviewer, who lands on the queue. An engineer, whose runs list moves one
link down the rail. The gate step, which records the intent's risk tier on its
row. The core's escalation read, which returns each gate value beside its own
line, and the tier. A core read for the two counts, which the `ledger-read`
barrel publishes. A migration that indexes `turn` by its creation time.

## Constraints

The console names no SQL. Both reads are core modules.

The queue stays uncapped, so the grouping reads no journal per row. The gate
values come from the same statement as the row.

The landing page asks for the counts on every load. The console holds a
successful read for 30 seconds, and never past the end of the UTC day. The
console holds no failed read.

Each count compares an indexed column with a range. The statement has a
two-second timeout, and each query has a three-second bound on the client. A
request waits at most three seconds for a pool connection. The console gives up
on a count read after six seconds, and the header names the fault.

A live share of arrivals would sit beside the published containment. That
figure comes from the gold report, so the header states counts alone.

## Decisions affected

Affects: DEC-05, DEC-07, DEC-12, DEC-13, DEC-35, DEC-40, DEC-44

DEC-05 keeps agreement and coverage apart. Clean compares each gate with its
own line, and both must clear. No value on the queue combines the two. A row
names each value on its own.

A gate the ledger did not measure has cleared nothing, so its case is not
clean. A case whose rule is missing or unknown is not clean either. Its note
could not say what sent it to a person.

DEC-12 puts a person on every customer reply. Every case in the queue waits
for a person, whatever its group. A group orders the work and decides no case.
Neither gate sent a clean case to a person, and its note says so.

DEC-13 sets risk for each intent. A customer reply stops on its own rule
before the high-risk rule runs, so its rule never says high risk. The gate row
records the tier it judged the intent at, and a high tier puts the case
first. A row written before this change has no tier, so its rule alone places
it.

Delivery does not place a case in the first group. Every action sends at most
once unless `ACTION_DELIVERY` says otherwise, so that rule would put the whole
queue first.

DEC-07 sets the coverage review line. The clean group compares coverage with
the review line the gate recorded, and never with the block line.

DEC-35 makes each inbound message a turn. The header counts arrivals as turns,
and dates a case by the turn its run answered.

DEC-40 lets the console approve, and an approver reads what they approve. The
pane draws the run whose evidence the page read, which is the run the button
posts.

DEC-44 makes the reviewer console the primary place a person reviews a gated
action. So the page a reviewer works opens the console, and the runs list sits
under Admin.

## Open questions

None.
