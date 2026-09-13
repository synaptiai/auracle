---
title: "V2 Design: Automatic Feedback Clusters"
author: code
tags: [v2, design, evaluation, feedback]
created_at: 2026-09-04T00:00:00Z
updated_at: 2026-09-04T00:00:00Z
---

# V2 Design: Automatic Feedback Clusters

Design proposal for V2 open item 4 and section 6 of `docs/v1-architecture.md`.
Status: blocked on volume. The mechanism is specified here. No code lands with
this document. Nothing here is a decision until a row enters the register's
table in section 2. The document obeys Simplified Technical English.

## Verdict

This feature cannot ship from this repository today, and one gate blocks it.

**Volume.** Section 6 states the V1 position plainly. At test-bed volume,
automatic clusters of a few hundred tickets each month give noise. The interval
is wider than the signal.

No decision blocks this item. DEC-13 constrains thresholds and not clusters,
and no register row forbids automatic clustering. That makes item 4 different
from items 1 and 5, which each wait on a person as well as on data.

The repository ships synthetic fixtures only (DEC-18). A synthetic corpus can
be made any size, so a trigger fitted against it would fire on demand and prove
nothing. Real monthly feedback volume is the only thing that settles this.

## Why V1 answers this manually

A cluster is a claim that a group of tickets shares a cause. The claim needs
enough members to separate the group from chance.

Section 6 gives the V1 reading. A few hundred tickets a month spread across 25
intents leaves each group small. A small group produces a wide interval, and a
wide interval cannot support the claim the cluster makes.

A person reading the same tickets makes a weaker claim and states it as a
judgement. That is honest at low volume. An automatic cluster states a result,
and a result from thin data carries an authority the data does not earn.

## The trigger

The check is code, not guidance. A trigger left as guidance is a comment, and a
comment does not stop a job from running on thin data.

- Below the minimum monthly feedback count, the job produces no clusters. It
  reports the count it saw and the count it needs.
- At or above the count, the job produces clusters.
- The artifact records the minimum and the observed count either way. A reader
  can then tell which path ran without rerunning the job.

The minimum is a person's number, in the same way as the agreement threshold
(DEC-13). This document proposes no value. A value chosen against synthetic
volume would be a number that fires whenever the fixture generator says so.

## What the mechanism reuses

`src/jobs/taxonomy-induction.ts` already does the work this item needs, over a
different corpus. It embeds records, groups them, folds groups below a minimum
size into an `other` group, caps the named groups and asks a model to name each
surviving group.

Feedback clustering is that shape over feedback events rather than over history
tickets. A future implementation extends the existing job. It does not derive
the method again.

Two differences matter, and both are real.

- The induction job runs once at cold start. A feedback job runs on a schedule,
  so it needs the volume trigger above.
- The induction job proposes a taxonomy a person curates. A feedback job
  proposes a cluster a person reads. Neither output reaches the runtime path
  without a person.

## Traceability

| Concern | Decisions |
|---|---|
| Clusters are manual in V1 | section 6, open item 4 |
| The history carries no tags | DEC-02 |
| Clustering method and the named cap | section 4.11, DEC-10 |
| A person curates every model-proposed group | DEC-02, section 4.11 |
| Nothing real enters this repository | DEC-18 |
| The adopter owns their own traffic | DEC-17, DEC-19 |

## Rejected alternatives

- **Cluster at any volume.** The interval swamps the signal. Section 6 states
  this, and it is the reason V1 answers the item manually.
- **Use a judge model to select the clusters.** Section 4.10 states that a
  judge shares the failures of the system it tests. It is weakest where the
  evaluation matters most.
- **Fit the trigger on the synthetic corpus.** The generator sets that volume,
  so the trigger would measure the fixture and not the traffic.
- **Keep the manual loop and close the item.** The item asks for automatic
  clusters. Closing it on the V1 answer would record a decision nobody made.

## Open items

- The minimum monthly feedback count. An adopter sets it against their own
  volume.
- Whether a cluster carries an interval beside its size. A cluster with no
  interval invites the reading the volume gate exists to prevent.
- Who reads the clusters, and how often. The output is a queue for a person,
  and a queue with no reader is the pattern this repository keeps closing.
