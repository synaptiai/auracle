# Intent: Three runtime defects that no test covered

## Problem

The relay moved a run to `escalated` without stamping `finished_at`. That
state is terminal, and `db/005_run_timing.sql` says a terminal state carries
the stamp. Service time is `finished_at - created_at`, so every run the
relay escalated dropped out of the latency report. Those runs are the ones
the report most needs.

The coordinator recomputed the run's partition from its own
`PARTITION_COUNT`. Enqueue and consume read that variable independently.
`claimPartition` bumps a ticket's fence by joining through `run.partition`,
so a mismatch made the rebalance bump the wrong fences. The epoch then
stopped protecting the ticket, with no error.

No provider call carried a timeout. The clock limit is checked between
steps, so a request that never returned parked the run forever.

## Proposed outcome

The relay stamps `finished_at` in the same transaction as the state move.

The run records the partition the intake row was filed under. A caller with
no queue still falls back to the computed value.

Every provider request carries a deadline and reports a timeout as an error
the state machine can act on.

Each fix has a test that fails without it. That was checked by reverting
each fix and watching the test fail.

## Affected users and systems

Anyone reading the latency report. Any deployment whose partition counts
drift. Any run whose provider stalls.

## Constraints

DEC-25 keeps the clock limit. DEC-27 and DEC-28 keep the partition and the
fence. The relay keeps its send-first order.

## Decisions affected

None. All three obey DEC-25, DEC-28 and the timing contract in
`db/005_run_timing.sql`. Each is an implementation detail that failed to
honour a decision the register already holds.

## Open questions

None.
