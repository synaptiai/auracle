# Intent: a traffic simulator writes a backdated history

## Problem

`bands.yaml` names four metrics over a 30-day window, and all four baselines
are null. They fill only from traffic. `pnpm run bands` has never had a full
baseline to read, and `pnpm run latency` has never had a loaded partition to
report on.

This repository has no traffic, and by DEC-18 it may never have real traffic.

## Proposed outcome

A seeder writes 45 backdated UTC days through the real ledger path, so both
readers answer for the first time. The bands report emits verdicts, and the
latency report shows a distribution that issue #25 can read.

The history is reproducible from its seed. A baseline built from a history
nobody can rebuild is a number nobody can check.

## Affected users and systems

`src/seed/` is new and holds three parts: a pure planner, a writer and the
command. `package.json` gains `seed-history`.

`src/bands/` gains a provider. A band across a provider change measures the
provider and not the system. So a window that cannot be proven unanimous
emits no verdict and names the shortfall.

The seeder is the one module in `src/` that supplies an explicit clock.
`src/ledger/clock-reachability.test.ts` names it as the single exception to the
rule that no shipped module may. The daemon closure keeps no exception at
all. So a daemon that ever imported the seeder still fails the guard.

## Constraints

Every parameter of the model comes from the system's shape, never from a
wanted verdict. Issue #25's evidence gate reads this history and decides
which correction head-of-line delay needs. So a history built to make one
rule fire would seed the check with the material meant to verify it.

The queue wait is never drawn. It is computed from the consumer's own loop.
The loop has the poll period. It has the batch that one consumer takes
across every partition it owns. It also has the serial walk of that batch.

Service time is drawn log-normal. A run makes nine classifier samples, an
embedding, a composition and a groundedness check. A twelve-call run
inherits their tail. Arrivals are Poisson, because support traffic clusters
and a cluster is what fills a batch.

No baseline is written into `bands.yaml`. That file is tracked and stays a
target definition.

The seeder writes into the ledger only. It creates no file, and `bands/` and
`latency/` are ignored, so `git status` is clean after a run.

The seeder is offline tooling. It writes, so unlike the two readers it is not
safe against a live database, and it says so.

## What the model got wrong, three times

The report found all three, not reasoning. They stay on the record, because
the corrected numbers only mean something beside them.

**The queue was walked in draw order.** The first model generated a day's arrivals in a random order and walked them in that order. So it charged a ticket for runs that had not arrived when it did. The report showed waits of 3.4 hours against seconds of work, uniform across every partition. That is because the error was uniform. That reads as rule R1, capacity, from a system
running at half a percent of it.

**One server per partition, and no poll tick.** The corrected walk then showed
a p50 wait of 0 ms everywhere. The model omitted two facts. `consumer-main.ts`
polls every `CONSUMER_INTERVAL_MS`, 5000 by default, so a message waits for
the next tick at any load.

And one consumer owns several partitions and walks their combined batch
serially. So a slow run on one partition delays a ticket on another. That
cross-partition wait is the delay V2 open item 7 names. A model with one
server per partition cannot produce it.

**A ledger of shapes the system cannot produce.** The planner marked every run
`resolved`, including 1112 customer replies that DEC-12 routes to a person. So the report's own "still to land" count read zero on every day. It also gave
415 abstained runs a gate row, which `coordinateTicket` never writes: it
escalates before the gate step starts. And it left a run carrying a
`delivery_unknown` record `resolved`, where DEC-30 makes an unknown delivery
terminal and escalating. Each of those distorts a metric the bands report
reads.

## The evidence, and the rule it does not show

Written by `pnpm run seed-history --end-day 2026-06-30`, 2397 runs over 45
days.

```
$ pnpm run latency
latency v8 over 2397 runs, whole ledger:
  partition 0: wait p50 2.5s p95 4.8s p99 11.7s max 2.3m over 646 runs
                 service p50 40.4s p95 3.0h p99 8.4h max 12.7h over 511 runs (135 unfinished)
  partition 1: wait p50 2.6s p95 4.8s p99 5.0s max 59.5s over 586 runs
                 service p50 32.2s p95 2.7h p99 6.5h max 15.0h over 478 runs (108 unfinished)
  partition 2: wait p50 2.5s p95 4.8s p99 12.5s max 51.8s over 567 runs
                 service p50 30.7s p95 2.5h p99 5.1h max 15.4h over 463 runs (104 unfinished)
  partition 3: wait p50 2.4s p95 4.7s p99 4.9s max 1.5m over 598 runs
                 service p50 47.6s p95 2.6h p99 5.7h max 6.9h over 485 runs (113 unfinished)
```

**No head-of-line rule fires, because the system does not queue.** An earlier
draft of this file read R3 off these columns. That reading was wrong, and the
numbers that disprove it are measured rather than argued:

| quantity | value |
|---|---|
| utilisation, two consumers over an 11 hour window | 1.37 per cent |
| mean wait | 2.78 seconds |
| the poll floor, half of `CONSUMER_INTERVAL_MS` | 2.50 seconds |
| share of the mean wait above that floor | 10 per cent |
| runs that waited longer than one poll period | 1.00 per cent |

R3 reads "depth is uniform but a few long runs cause **most** of the wait".
Ninety per cent of the wait is the poll interval. So the second half of that
sentence is false by an order of magnitude. R1 needs waits that are high and
uniform; these are uniform and are one poll period. R2 needs a partition
holding most of the wait while others sit idle. Depth ranges from 567 to 646
runs, a ratio of 1.14.

The honest reading is that a system at 1.4 per cent utilisation has no
head-of-line delay to correct. `src/seed/plan.test.ts` pins all three numbers,
so a claim about them cannot outrun the evidence again.

**The fifth acceptance criterion is not met.** It asks for a partition with
materially higher queue-wait percentiles. Partition 0's 99th percentile is
11.7 seconds. Partition 3's percentile is 4.9 seconds. That looks like a
factor of two.

But that percentile is set by about six draws out of 646. And which
partition carries it changes with the seed. That is noise around the poll
floor and not a property of the history. So this file records the criterion
as unmet.

## What the report does show

The service distribution, which nobody had seen before. A median of 30 to 48
seconds and a 95th percentile of two and a half to three hours. This is on
a ledger whose model calls take about fourteen seconds.

The gap is the person. `db/005` defines service time as `finished_at -
created_at`. DEC-12 puts a person on every customer reply, and a parked run
finishes when they answer. So this system's latency is human latency, and the
model calls inside it are a rounding error against that.

That is the finding V2 open item 7 should weigh. Consumer concurrency corrects
the walk between pickup and parking. This history says that walk is not
where the time goes.

The `unfinished` counts are runs still parked at `awaiting_approval`. Counted
under their own name, never folded into a duration.

## The provider guard, end to end

A day seeded under a second provider, judged against a baseline of the first:

```
$ pnpm run bands --day 2026-07-01
bands v9 for 2026-07-01 over 51 runs:
  abstain_rate                    0.137 over 51 runs
                               the window spans more than one provider: model and stub
  gate_pass_rate                  0.900 over 20 runs (31 not reached)
                               the window spans more than one provider: model and stub
  approval_edit_distance         56.462 over 13 runs (38 not reached)
                               the window spans more than one provider: model and stub
  relay_delivery_unknown_count        0 over 51 runs
                               the window spans more than one provider: model and stub
```

Every metric measures a value and none emits a verdict. The day is described
and it is not judged. That is the honest answer when the comparison would
measure the provider.

## Decisions affected

None as an amendment. Three are obeyed where an earlier draft broke them.
That is worth naming rather than leaving as a silent correction.

DEC-24, with DEC-38 naming the rejected alternative: the outbox idempotency
key comes from the action's semantics. The first version built it as
`seed-<runId>`, which is the run identity those rows forbid by name. The
`outbox.idem_key` column comment in `db/001` states that identity verbatim.
It calls `deriveIdemKey` now.

Section 4.2 rule 1: the state change and the outbox insert commit together.
The first version wrote the outbox row afterwards on a bare connection, in a
different transaction. It goes through `fencedInsert` now.

DEC-30: an unknown delivery is terminal and escalating, so a run carrying one
is `escalated` and never `resolved`. The relay also writes `pending` first and
marks the record afterwards. So the seeder takes the same two steps rather
than writing a state the relay never produces.

The seeder otherwise adds tooling and changes no decision. It uses the write
path DEC-28 and section 4.2 already govern, and it obeys DEC-18 by generating
every ticket.

The bands change adds neither a gate nor a score. So DEC-05 keeps its meaning
and section 4.5's sampling rule is untouched. The register describes the
control bands as a maintenance loop and names no provider rule. So refusing a
verdict across a provider change is a reader's honesty rather than a new
decision.

## What the service percentile means

The latency report's service column is `finished_at - created_at`, which for
an approved run includes the wait for the person. `src/approval/approve.ts`
resolves the same run row, so a real ledger measures it the same way.

A reader computing utilisation from that column reads three quarters of an
hour. The consumer was busy for fourteen seconds. Those are different
quantities and they differ by two orders of magnitude. Issue #25 reads this
report. So the distinction is stated here rather than left to be inferred.
Consumer occupancy is the work, and the service percentile is the run.

## One thing found next door

`FakeProvider` declared no `kind`, and `src/models/provider.ts` says an absent
kind means `model`. So the test harness answered under the name of a real
provider for every reader of that field. That is the false claim the field
exists to prevent. `src/goldreport/goldreport.test.ts` asserted
`scored_by: 'model'` for a report the fake produced, and said in a comment
that a real provider had answered.

It is fixed here because this issue's own provider marker reads the same
field. Shipping a reader on top of a harness that lies about it would
carry the lie into a new place.

No published number moves. `gold-report/v7.json` already reads
`scored_by: 'stub'`, because the job that wrote it used a provider that
declares itself. Only the suite was wrong about what it had run.

## Open questions

Whether a seeded row should declare itself in the ledger, as a gold half
declares its provenance. Nothing marks one today. So a database that has taken
a seeded history must never be the source of a published number. That needs a
column, so it needs a decision.
