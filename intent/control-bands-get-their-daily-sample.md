# Intent: The control bands get their daily sample

## Problem

`bands.yaml` defines four metrics, a 30-day window, a daily sample and three
graduated actions. No module under `src/` read that file. Its four baselines
are null. Its own header says they stay null until a full window of daily
samples exists. Nothing computed a daily sample, so they could never fill.

`run.approval_edit_distance` showed the same shape on one column. It had one
writer outside the tests. That writer's comment says the value lands on the run.
So a daily sample can be computed from ledger data alone. Nine offline job
directories held no reader for it.

The runbook told an operator in Phase 2 to watch the bands and wait. It named
no tool that computed one. Its own control-band section conceded the gap: each
metric was a target definition and not a live signal.

## Proposed outcome

An operator obtains all four metrics for one day from the ledger alone. Each
metric reports the runs behind its value. A value that could not be measured is
reported as unmeasured and never as zero.

A day is judged against the 30 days before it. The baseline never includes the
day it judges. A window too thin or too flat to carry a band says so, and
states no verdict.

The register and the runbook name the tool.

## Affected users and systems

An operator running Phase 2, who now has the signal the register calls the most
useful early one. The policy engine, which now reports which rule decided. The
run coordinator, which records that reason in the gate step.

No live traffic path changes behaviour. The reporting reads the ledger and
never writes to it.

## Constraints

- Every statement is a SELECT, and the connection opens read-only. The job is
  safe against a live database.
- The artifact stays with the adopter. It describes their own traffic. So the
  directory is ignored like `latency/` and `triage/`, and nothing real enters
  the repository (DEC-18).
- No baseline is written into `bands.yaml`. Those are an adopter's production
  numbers, and the file is in the repository (DEC-18).
- The two gates stay independent (DEC-05). A run that cleared agreement and
  then failed on groundedness passed the agreement gate.
- No exit criteria for Phase 2 are proposed. That is V2 open item 1.
- No band action is taken. The three-sigma action is a pull request, and the
  job states that one is warranted.
- Neither `step_journal` nor `outbox` gains a timestamp column. A read-only
  report must not change the ledger write path.

## Decisions affected

None. This is an implementation detail of the section 4.10 online measurement.
It is also part of step 3 of Phase 2 in section 5.

The policy engine now returns which rule decided, beside the verdict it already
returned. The rules and their order do not change. A test compares the two
functions across every combination of their inputs. DEC-03, DEC-05, DEC-06,
DEC-07, DEC-12, DEC-13 and DEC-34 each keep the effect they had.

## Open questions

None for this change.

The criteria to leave Phase 2 stay undecided. They are V2 open item 1, and the
register says they need a decision it does not make. This work gives that
decision its evidence. It does not make it.
