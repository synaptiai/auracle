# Intent: the ledger records what each claim cited

## Problem

The composer resolves every claim to a retrieved document and refuses an
uncited line (DEC-07). The groundedness judge returns a supported verdict for
each claim. Neither survives the write. The `compose` row journals a claim
count, and the `gate` row journals one coverage fraction.

So an operator can read that 3 of 4 claims were supported. Nobody can read
which claim was the fourth, or which document supports any of the others.

Two smaller absences sit beside it. A run carries a conversation id and no
turn number. So a turn joins to the run that answered it only
through the park journal. An automatic run never writes one. And the ledger records that a
person approved a reply, never which person.

## Proposed outcome

The ledger holds what each claim cited and whether the judge supported it. It
holds what the cited document said when the run read it. It holds which turn a
run answered, and who approved the reply.

A reader can then name the unsupported claim and open the document behind
every supported one.

## Affected users and systems

The coordinator's write path, at the `retrieve`, `compose` and `gate` steps.
The approval bridge. Two migrations on `run`. The seeder, so every new reader
has rows to read.

No reader and no surface changes here. Those are issues #50 and #51.

## Constraints

DEC-05 keeps the two gates independent. The per-claim verdicts are coverage
detail and sit on the `gate` row beside the fraction. Agreement stays on the
`classify` row. Nothing joins them, and no function takes both and returns a
number.

A reader must render the journalled coverage fraction and never recount it
from the verdicts. Two numbers computed twice will disagree. The gate's own
value is the one the policy engine read.

DEC-21 keeps ranks out of the fusion and scores out of everything. The
document snapshot carries a title, an owner, a review date and a body hash. It
carries no score and no rank.

DEC-07 requires the composer to cite or abstain. This records the citation
that decision already requires to exist.

DEC-18 governs the repository, not the ledger. The seeded corpus stays
synthetic.

`retrieve` runs before `compose`, so nothing at retrieve time knows which
documents a claim will cite. The snapshot splits across the two rows rather
than deferring the write-before-act order.

## Decisions affected

Affects: DEC-42, DEC-05, DEC-07, DEC-21, DEC-23, DEC-35, DEC-38

DEC-42, ratified by this change. The ledger records an approver and names the
value unverified.

DEC-05, DEC-07, DEC-21, DEC-23, DEC-35 and DEC-38 are cited and unchanged.
The claim mapping, the document snapshot, `run.turn_number` and the seeder
change are implementation details.

## Open questions

Retention. This stores model-written claim text and cited document bodies for the life of
the row. The customer text `db/010` stores sits beside them. No purge job ships, per DEC-19. The runbook states what is stored and
gives the statements an adopter runs to remove it, in issue #52.
