---
title: "Amendment proposal: a threshold for each intent, and what its labels are"
author: code
tags: [v2, design, amendment, dec-13, dec-31, calibration]
created_at: 2026-09-04T00:00:00Z
updated_at: 2026-09-04T00:00:00Z
---

# Amendment proposal: a threshold for each intent, and what its labels are

Status: **ratified as DEC-41 on 2026-09-04.** The row is in section 2 of
`../../docs/v1-architecture.md`, and the register carries the wording that
governs. This document records the reasoning that produced it.

The row as ratified reads: above the labelled-case trigger the system fits a
threshold for each intent, each case records what labelled it, and the
artifact records the count and the accuracy of each kind. Its rejected
alternatives are one global threshold above the trigger, and per-intent
thresholds with no record of what labelled the cases.

The mechanism has not shipped. Issue #26 builds it, and open item 5 closes
then.

## Verdict

V2 open item 5 cannot close in code alone. DEC-13 selects one global
threshold, and it rejects a threshold the system learns for each intent. The
policy engine enforces that choice. So a register row must come first.

The proposal adds DEC-41. It does not rewrite DEC-13. It follows the
DEC-27 and DEC-36 precedent, where a later row supersedes an earlier one.

## What blocks the item today

Two things block it, and both must clear.

**DEC-13 binds.** The rejected column names the learned per-intent threshold
directly. No code change moves that.

**The trigger cannot fire.** Section 3.3 gives the arithmetic. One global
threshold needs 385 labelled cases. A threshold for each of 25 intents needs
roughly 2400. Intent frequencies follow a Zipf distribution, so the intent at
rank 20 needs roughly 7700. The item rounds that to 8000. The shipped corpus
holds 2124 cases.

## What the labels are, and what they may claim

The maintainer ruled that a model may produce the labels that fire this
trigger. That ruling needs one guard, or the artifact claims something false.

Section 5 calls the labelling the largest single cost in the plan, and it
says each published number has no value when a person labels carelessly.
`gold-report/v7.json` records `method` as `human-review`. A model label
written into that field would make the field mean two different things.

So the proposal records provenance rather than hiding it. Each case carries
the name of what labelled it. The artifact records the count of each kind,
and it records the measured accuracy of the model labeller.

The accuracy is measurable here and nowhere else.
`../../scripts/generate-fixtures.mjs` assigns each synthetic case its true
intent, so the generator holds ground truth. The labeller runs against that
truth, and the artifact states how often it agreed. A per-intent threshold
then rests on a number that says how much to trust it.

## Where the cases sit

DEC-31 splits one gold set in two. The register states at section 3.3 that
DEC-31 governs the split and not the size, and that the maintainer ruled the
size an implementation detail of it. The set already grew from 770 cases to
2124.

So the corpus grows again, and both halves grow together. The fit half and
the report half keep the same stratification and the same provenance mix. An
asymmetric pair would give the two halves different meanings, and DEC-31 does
not contemplate that.

Published numbers move. The change set states which ones moved and why.

## The proposed row

| ID | Decision | Rejected alternatives |
|----|----------|----------------------|
| DEC-41 | Above the labelled-case trigger the system fits a threshold for each intent. Each case records what labelled it, and the artifact records the count and the accuracy of each kind | One global threshold above the trigger; per-intent thresholds with no record of what labelled the cases |

## What the code must then do

`../../src/policy/policy.ts` compares agreement against one threshold today.
It gains a per-intent lookup with the global value as its fallback.

The calibration job already knows the shape. The design document
`v2-per-intent-agreement-thresholds.md` specifies it: below the trigger the
job fits the global threshold and records an empty per-intent map, and at or
above it the job fits a threshold for each intent above the data floor. The
artifact records `trigger_min_labelled` and `labelled_cases` either way.

That document carries a dated note. Three facts it rests on moved after it
was written, and the note says which.

## Traceability

| Concern | Decisions |
|---|---|
| One global threshold today | DEC-13, section 3.3 |
| A person sets the risk tier | DEC-13 |
| The gold set splits in two | DEC-31 |
| The size is an implementation detail of the split | section 3.3 |
| The history carries no tags | DEC-02 |
| Synthetic fixtures only | DEC-18 |
| The two gates stay independent | DEC-05 |

## Rejected alternatives

- **Write model labels into the `human-review` field.** Nothing downstream
  could then tell the two apart. README's published numbers would rest on a
  field that no longer says what it means.
- **Fit on model labels and report from the human half.** No published
  number moves, which is the attraction. The two halves would then carry
  different provenance, and DEC-31 describes no such pair.
- **Use the generator's truth as the labels.** The labels and the cases would
  come from one generator, so the thresholds would measure the generator.
- **Leave item 5 alone.** Honest, and it moves nothing. The mechanism stays
  unproved and one of four open items gets no movement.

## Open items

The maintainer decides the wording of DEC-41 and the trigger value. The item
still needs labelled data at production scale before an adopter uses it.
