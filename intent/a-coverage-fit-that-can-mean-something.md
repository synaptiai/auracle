# Intent: a coverage fit that can mean something

## Problem

The machinery that fits the two coverage thresholds has never produced a
number anyone should trust, and four separate faults stood between it and one.

The two gold halves drew every claim from one table of 56 sentences. Each
sentence carried 25 claims, so a judge that mis-read one moved both halves
alike. The report half could only repeat the fit half, never corroborate it.

The halves held 167 and 195 fully grounded drafts. Precision counts grounded
drafts above a threshold against all drafts above it, so the report half was
measurably the easier one and a published precision read high.

Both fitting searches read a point estimate and ignored the interval they
recorded. A point estimate carries no sample size, so a handful of samples that
agree read 1.000 and clear any floor. The first live run fitted the block
threshold on three drafts, and the artifact recorded its own interval as 0.4385
to 1 against a floor of 0.9.

The coverage precision floor of 0.985 had no reason. The only 0.985 in the
register belongs to the classifier simulation of paragraph 4.5, and DEC-05
keeps the two gates independent.

The coverage artifact had no reader. The runtime hardcoded both numbers to the
seeds, so the job wrote versioned files that nothing consumed.

## Proposed outcome

The two halves ask disjoint sentences, so a judge sensitive to one wording
moves one half and the disagreement is visible. They hold the same number of
fully grounded drafts, so neither is the easier one.

Each floor is read against the lower bound of a 95 percent interval, so a
threshold no sample supports is refused rather than published. Each floor has a
reason recorded beside it.

A fitted pair reaches the policy engine. Each gate reads its own artifact and
keeps its own seed when that artifact is absent.

The corpus is large enough that a fit can hold the floor it is given. Where it
cannot, the job refuses and says how many drafts the floor needs.

## Affected users and systems

An adopter fitting thresholds on their own labelled history. Both fitting jobs,
the gold report, the startup resolver every daemon calls, and the fixture
corpus. No runtime ingress path changes.

## Constraints

- DEC-05. The two gates stay independent. Two artifacts, read separately, and
  neither supplies a number to the other.
- DEC-07. The coverage thresholds keep their meaning and the cite-or-abstain
  rule is untouched.
- DEC-13. The agreement gate keeps one global threshold.
- DEC-18. Nothing real is committed. The fixtures stay synthetic and
  byte-identical to the generator, and a claim sentence is named by digest.
- DEC-26. The pinned model version stays pinned.
- DEC-30. Unchanged. The transport retry added here repeats a read that
  delivers nothing, not a delivery whose state is unknown.
- DEC-31. Fit and report stay disjoint, now in sentences as well as in cases
  and conversations.

## Decisions affected

None changes. DEC-31 names a gold set of 770 cases, and the corpus now holds
2124. The maintainer ruled the size an implementation detail of that decision,
whose substance is the split discipline: fit on one half, report from the
other, never one case for both. That discipline is untouched and better served.
The ruling and its reason are recorded in the register.

## What the fit produced

It held. Over 1056 drafts of the fit half, the block threshold is 0.75 with a
negative predictive value of 0.9503 across 362 drafts, lower bound 0.9228
against a floor of 0.9. The review threshold is 1.00 with a precision of
0.9980 across 505 drafts, lower bound 0.9889 against a floor of 0.985. Both
floors are read on the lower bound, so neither rests on a point estimate.

The open question above was answered the way the rule of three suggested it
might be: the top band does carry one error in 505. It is few enough. A review
threshold of 1.00 is the only candidate that held the floor, and the floor was
not lowered to find a friendlier one.

## What the reviews changed

Three passes ran before this shipped, and each found something the tests did
not. The sharpest was in the scoring loop: the sample joined the run before
the checkpoint was written, and the write sat inside the same try, so a failed
write fell through to the transport retry and the draft was scored again with
the first sample still in place. One draft contributed three samples to an
interval whose whole purpose is to carry its own sample size, and the run did
not fail.

Two others were the same shape as that one — a guard whose reach nobody had
tested. The report job never selected its half, so a pair fitted on a real
corpus would have been measured against the committed synthetic one. And the
grounded-share guard was a significance test standing in for an equivalence
test, which let a larger corpus carry a larger gap.

## Open questions

Whether a re-fit reproduces this pair. The judge runs at temperature zero, so
the verdicts should repeat, but attrition varies with the provider and the
thresholds are chosen from what survives. A pair that moves republishes the
register passage, the reference artifact and the report-half numbers together.
