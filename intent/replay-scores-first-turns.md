# Intent: Replay scores first turns only (DEC-39)

## Problem

Step 4 of four, and the last.

Replay scores a routing decision against an observable disposition (DEC-32).
A later turn's disposition reflects the whole conversation, not the decision
being scored. Scoring it would credit or blame the wrong choice.

The artifact also did not say which population it covered.
A reader could not tell whether two numbers were comparable.

## Proposed outcome

The gold report scores first turns only. A case records its turn when it has
one, and a case with no turn is a first turn.

Every committed fixture is a first turn.
The generator writes one subject and one body per case, and records no prior
turn. The filter therefore removes
nothing today, and the report half stays at 385 cases. The published numbers
are unchanged, which the regenerated artifact confirms.

The artifact carries `scope: 'first_turn'`. The validator refuses any other
value, the same guard shape as `split_used`.

Later turns are not lost. They move to the online metrics, which score a
conversation rather than one decision.

## Affected users and systems

Anyone who reads the published numbers.

## Constraints

Recount the strata only when multi-turn fixtures land.

## Decisions affected

Ratifies DEC-39, the last of the five. Section 1.2 no longer lists
conversation state as outside V1, and section 7 closes open item 3.

## Open questions

The online metrics for later turns are not built. This decision states where
those cases go; it does not build the destination.
