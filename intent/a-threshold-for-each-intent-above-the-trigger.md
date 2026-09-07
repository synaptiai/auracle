# Intent: A threshold for each intent above the trigger

## Problem

DEC-41 fits a threshold for each intent above a labelled-case trigger. Nothing
implemented it, and two things blocked it.

DEC-13 rejected a per-intent threshold by name. Each row's mandate was the
other's rejected alternative, and no prose said which governed when. So the
policy engine had no register basis for either path.

The corpus could not fire the trigger. Section 3.3 puts the requirement near
7 700 labelled cases, and the shipped corpus held 2124.

## Proposed outcome

The corpus holds 8200 cases and every case names what labelled it. The
calibration job fits a threshold for each intent that can be fitted. It
records the trigger, the counts and the labeller's measured accuracy. The
policy engine reads the fitted threshold where one exists.

An intent that cannot be fitted keeps the global threshold, and the artifact
names it. Absence is not a finding, so a reader can see which intents were
not fitted rather than inferring it.

## Affected users and systems

An operator reads a threshold that states what labelled its cases. An adopter
regenerating the corpus gets 8200 cases and a fixture set about four times
larger.

Every published figure measured on the corpus moves. Containment falls from
0.805 to 0.7970. Action match is withdrawn rather than restated. It
needs a classifier run and the corpus it was measured on no longer exists.

## Constraints

- DEC-41 governs above the trigger. DEC-13 governs below it, and its second
  rule is untouched: a person sets the risk tier at every corpus size.
- DEC-31 governs the split and not the size. Both halves grow together, and
  the fit still consumes the fit half alone.
- DEC-05 keeps the two gates independent. The per-intent map belongs to the
  agreement gate. `goldreport/run.ts` holds a type-level guard that stops
  compiling when a new threshold field is classified as neither gate.
- DEC-18. The corpus is synthetic and a deterministic stand-in labels it. CI
  regenerates the corpus and diffs it, so no live call can sit in the
  generator.
- A model label never enters `method: "human-review"`.

## Decisions affected

DEC-41 and DEC-13. DEC-41 is obeyed and unchanged. DEC-13 was amended first,
with the maintainer's approval, so that it binds below the trigger rather than
absolutely. The amendment is its own commit and its own review.

## Open questions

The shipped corpus is uniformly stratified, so it has no rank-20 intent and no
thin tail. The data-floor fallback is proved by unit cases and not by the
fixture. Whether the generator should draw a Zipf distribution instead is open.
The maintainer chose to state the uniformity rather than reshape the
corpus a third time.

No producer ships for the labeller's `model` kind. An adopter labelling their
own history writes one. Whether this repository should ship a model labeller
is open.
