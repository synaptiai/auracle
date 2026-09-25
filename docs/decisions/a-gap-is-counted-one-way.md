# Both screens count a gap one way

## Problem

An unsupported claim names the document the system needed. A case whose
composer abstains names none, because no document can answer it. Both send
the case to a person. Nothing counts those cases, so nobody can see which gaps
cost the team the most.

In the ratified text of DEC-50, both screens count the cases a gap blocks the
same way. The gate's recorded reason cannot be that count. Every customer
reply gates on its own rule, whatever its claims say.

## Proposed outcome

One module in the core decides whether a gap blocks a case. The knowledge
screen and the case page both read through it, so the two cannot disagree.

A case is a turn, or a run with no turn. A run of it reaches a person when it
parks for approval or escalates. The attempt of record is the latest such run
that also drafts a reply or abstains. The highest attempt comes first, then
the latest start, then the run id. A run that does neither, such as the end of
a send-back, says nothing about the knowledge base. So it cannot hide an
earlier gap.

The gap blocks the case when that attempt's composer abstains, or when its
gate refuses a claim. A refusal counts only where the page draws one on the
draft. The module reads the rows through the parsers the run page uses. Both
read a claim's verdict through one function.

A person may rewrite a reply the gate refuses (DEC-48). The page then draws no
verdict, but the gap still counts, because a person has to write the answer.
The case page says that the refusal belongs to the draft.

The knowledge screen reads one snapshot, over the 14 days before now:

- the cases blocked by a gap
- the documents past their review date, counted today
- the documents a reviewer published from a case in the window
- the cases a supported claim on one of those answers, when no gap blocks them

Then it ranks the gaps by blocked cases, grouped by intent and product. It
lists the documents that need a person, each with its citations, its owner
and a change flag.

## Affected users and systems

Reviewers read the new knowledge screen and a line on the case page. The
console gains a read barrel entry and no write. The ledger gains no column.

## Constraints

- The console issues no statement of its own. The read lives in the core.
- The read is bounded and read-only, so a page cannot hold a connection.
- A case that never reaches a person counts on no card.

## Decisions affected

Affects: DEC-18, DEC-23, DEC-45, DEC-47, DEC-48, DEC-49, DEC-50

DEC-50 asks for one count of the cases a gap blocks. This change is that
count, and both screens read it. It writes no document yet.

DEC-48 lets a person rewrite a reply. This change counts the gap of a
rewritten reply, and its case page names the refusal as the draft's.

DEC-49 makes a new attempt its own run on the same turn. So the count takes a
turn once, from its latest attempt that reaches a person and drafts or
abstains. A re-run still in flight does not hide the case it came from. Nor
does a send-back that ends with no draft.

DEC-47 gives a run its product. The ranking groups by it, and a case with no
product is its own group.

DEC-45 puts every page behind an active reviewer. The knowledge screen and the
case page's gap line sit behind that gate, and a refused request reads neither.

DEC-23 sets the review date. A document is past review when the date is before
today. That is the exact complement of the date the retriever still reads.

DEC-18 keeps the repository synthetic. The new suites seed synthetic rows only.

## Open questions

None.
