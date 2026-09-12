# Intent: the corpus takes the Zipf shape, and the numbers follow it

## Problem

The register derives the per-intent trigger from Zipf-distributed intent
frequencies. The shipped corpus spread its 8200 cases evenly over 25 intents.
So the fixture contradicted the premise its own trigger rests on.

The per-intent path fitted nothing on that corpus. Every intent held 164 fit cases.
A perfect sample of 164 reaches 0.977, and the floor is 0.985.
The count refused all 25 before precision was ever read.

## Proposed outcome

The corpus carries a Zipf shape at exponent 1, and both halves carry it alike.
The per-intent path fits four intents and names the 21 it refuses. Every
number and claim that follows the corpus moves in the same change.

## Affected users and systems

An adopter reading the published rates. The calibration job, the groundedness
fit, the gold report and every document that quotes one of them.

## Constraints

- The total stays 8200 and the split stays even (DEC-31).
- The taxonomy keeps its 25 intents and no exponent rises above 1.
- The generator reproduces the corpus byte for byte.
- The fixtures stay synthetic (DEC-18).
- A fitted threshold must reach a gate that can read it. The policy engine
  returns `gated` for a high-risk intent before it compares agreement.
  So a threshold fitted on such an intent is never read (DEC-03, DEC-13).
- A figure the corpus no longer supports is withdrawn, not restated (DEC-31).

## Decisions affected

Affects: DEC-41, DEC-31, DEC-25, DEC-18

DEC-41 governs the per-intent fit, and this change alters none of its
behaviour. DEC-31 governs the split and the fit-report separation. DEC-25
governs the spend a run reports. DEC-18 keeps the corpus synthetic. No DEC
changes.

## Open questions

The report half is not measured at the new coverage pair. `pnpm run
report-groundedness` recovers that measurement, and it costs one model call
per claim. V2 item 5 stays open, because the stub still cannot show what a
model would reach.
