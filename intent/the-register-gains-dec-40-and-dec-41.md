# Intent: The register gains DEC-40 and DEC-41

## Problem

Two children of epic #21 cannot start. Issue #27 adds an operator console that
approves a parked draft, and DEC-11 rejects a new web queue by name. Issue #26
fits a threshold for each intent, and DEC-13 rejects a threshold the system
learns for each intent.

PR #28 landed a proposal for each. A proposal is not a decision. A document
becomes a decision only when a row enters the table in section 2.

## Proposed outcome

Section 2 carries DEC-40 and DEC-41.

DEC-40 keeps the parking rule and permits a second approval path. A draft
still parks in the helpdesk and nowhere else, so DEC-11's purpose survives.
DEC-40 rejects a console that parks its own drafts, and a console that is the
only approval path.

DEC-41 permits a threshold for each intent above the labelled-case trigger. It
requires each case to record what labelled it, and it requires the artifact to
record the count and the accuracy of each kind. Without that record a model
label and a person label would be one thing, and section 5 rests on the
difference.

Neither row rewrites the row it supersedes. DEC-11 and DEC-13 keep their text,
as DEC-27 kept its text when DEC-36 replaced the partition key.

Six statements go stale, and this change corrects all six: section 4.9 of the
register, two source comments, two paragraphs of `docs/v2-roadmap.md`, and the
handoff. Three statements that stay true are left alone, because DEC-40 keeps
the rule they state.

## Affected users and systems

Anyone who reads the register. Issues #26 and #27, which this unblocks. No
runtime component changes.

## Constraints

No behaviour changes. The two source edits are comments. No published number
moves, and the committed fixtures stay byte-identical (DEC-18).

Neither open item closes here. Item 5 closes when the mechanism ships.

## Decisions affected

Adds DEC-40 and DEC-41. Supersedes part of DEC-11 and part of DEC-13, and
rewrites neither. DEC-12 and DEC-14 keep every effect they had, so a customer
reply still needs approval and a non-empty disclosure. DEC-05 keeps the two
gates independent.

## Open questions

None.
