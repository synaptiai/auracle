# Intent: A crashed park cannot show the customer two drafts

## Problem

The coordinator called `createDraft` before the ledger recorded anything.
A crash between the adapter call and the journal write left a draft that no
ledger row named. The retry parked a second draft, so the customer saw two.

Several documents also described behaviour the code does not have.

`README.md` and `AGENTS.md` said groundedness below 0.70 blocks the reply.
The policy engine gates every customer reply first.
It returns that verdict before it reads either threshold.
So the thresholds only ever decide an automatic write.

Section 7 listed two open items that have shipped.
Section 4.1 promised one real helpdesk. The adapter is fixture-backed.
The published numbers carried no note that a stub produced them.

## Proposed outcome

The ledger states the park intent before the adapter call. A run that finds
an unresolved park on its ticket escalates with reason `park_unresolved`.
A person reconciles the draft that is already there.

Each document describes what the code does.

## Affected users and systems

Any customer whose reply is parked. Any reader of the four documents.

## Constraints

DEC-11 keeps the draft inside the target system. DEC-12 keeps approval for
every customer reply. The escalation reuses the existing limit path, so a
parked run keeps its partial work.

## Decisions affected

None. The park guard applies DEC-24 to a path that had no key. The document
changes record what the register and the code already agree on.

## Open questions

The port change that lets `createDraft` deduplicate is a separate step. The
helpdesk adapter keys a map. The mail adapter needs a header and a search.
