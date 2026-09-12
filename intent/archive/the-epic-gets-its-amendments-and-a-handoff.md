# Intent: The epic gets its amendments and a handoff

## Problem

Epic #21 runs the system end to end so the evidence can close what evidence
can close. Three of its six children cannot start.

Two of them need a decision that does not exist. Issue #27 adds an operator
console that approves a parked draft, and DEC-11 rejects a new web queue by
name. Issue #26 fits a threshold for each intent, and DEC-13 rejects a
threshold the system learns for each intent. No code moves either row.

The third child, issue #25, corrects head-of-line delay. Its design document
leaves one question open: whether bounded intra-partition concurrency needs a
register note. Nothing answers it.

A fresh session that implements the epic also has no record of what the design
session established. It would re-derive the capability facts, the split rules
and the evidence gate, or it would get them wrong.

## Proposed outcome

Three proposals sit under `.creatumo/design/`. Two propose a register row, and
each proposes a new row rather than an edit. No decision row has ever
been rewritten. The third is a trace, and it concludes that the concurrency
correction needs no row.

`docs/internal/epic-v2-handoff.md` carries what a fresh session needs. That
includes the issue order and the amendments that gate it. It also includes
the session start and the baseline it must not move. It further includes the
facts the design session verified and the arguments that are already
settled.

The operator console's design canvas has its source in the repository. So the
canvas can change when the console does.

## Affected users and systems

Anyone who implements epic #21. The maintainer, who owns section 2 of the
register and must rule on two proposed rows.

## Constraints

No behaviour changes and no source file changes. The register is untouched:
a proposal is not a decision (DEC-18 keeps the canvas data synthetic).

## Decisions affected

None. Two documents propose DEC-40 and DEC-41, and neither is a decision until
a row enters the table in section 2.

## Open questions

The maintainer decides the wording of DEC-40 and DEC-41, and confirms the
concurrency trace.
