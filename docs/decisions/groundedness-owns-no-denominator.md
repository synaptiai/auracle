# Intent: The coverage denominator is not a model's choice

## Problem

The groundedness gate asked a model to split the draft into claims. It then
divided supported claims by the number that call returned.

So the denominator was model-controlled. A split that returned one line
scored 1.0 and cleared both policy thresholds.

The composer had already produced the claims. It proved that each one cites
a retrieved span, then joined the texts and discarded the partition. The gate
derived a different partition from the joined text.

## Proposed outcome

The gate takes the composer's claims. It runs one judge call per claim and
divides by the number the composer produced.

The split call is gone. A full run costs one model call less.

## Affected users and systems

Every automatic run. The gate is the only defence against a confident error.

## Constraints

Each claim is still judged against the retrieved text as a whole, which is
what section 4.7 states. Only the source of the claim boundaries changes.

## Decisions affected

Affects: DEC-07, DEC-05

DEC-07 and DEC-05 are unchanged. The gate stays independent of agreement.
Section 4.7 described the split as a step of this component, so that
paragraph changes with the code.

## Open questions

Each claim carries the document it cites. Judging a claim against that
document alone would be stricter than judging it against the whole retrieved
set. Section 4.7 says the whole set, so this change does not do that.
