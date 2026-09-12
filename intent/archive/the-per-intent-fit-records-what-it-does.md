# Intent: the per-intent fit records what it does

## Problem

DEC-41 fits a threshold for each intent above the labelled-case trigger. The
shipped corpus clears that trigger, so the path runs. Nothing records what it
produces.

The repository ignores the calibration directory, so the job commits no
artifact. A reader cannot check any claim about the fit against one.

The roadmap carries such a claim. It says the per-intent path runs and its
thresholds gate the shipped gold report. Neither half holds. The path fits
nothing, and the shipped gold report records a seeded gate.

## Proposed outcome

A run through the real fitting code records what the per-intent fit produces
on the shipped corpus. It names the count fitted, the count refused and the
route that refused each one.

The record states what the run cannot show. It uses the offline stand-in. That
stand-in's accuracy is a property of the fixture text, and it measures no
classifier.

The roadmap states what is true.

## Affected users and systems

An adopter reading the roadmap to learn what the per-intent path does. A
maintainer choosing whether to reshape the corpus. No runtime behaviour
changes, and no daemon reads anything new.

## Constraints

The shipped corpus does not change (DEC-18). The fit consumes the fit half
only (DEC-31). Every refused intent keeps the global threshold (DEC-13). The
run spends nothing, because the stand-in reaches no network.

No published number moves. The change corrects a false sentence, and a
sentence is not a number.

## Decisions affected

None. This is an implementation detail. DEC-41, DEC-31, DEC-13 and DEC-18
constrain it and none of them changes.

## Open questions

Whether the precision route ever refuses an intent. The stand-in answers
every fit case correctly, so this run cannot say. Only a run against a real
model can, and that run costs money.
