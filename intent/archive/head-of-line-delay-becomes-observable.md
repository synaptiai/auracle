# Intent: head-of-line delay becomes observable

## Problem

`db/005_run_timing.sql` added three columns to the run row. It stated the two
quantities they exist for: a queue wait and a service time. Its header said
why. "Choosing a correction needs production latency data from Phase 2. These
columns make that data collectible from the ledger alone."

Four call sites wrote them. Nothing read them. Section 7 item 7 said so in as
many words: "Nothing reads them yet."

The consequence was not that a column sat idle. Section 6 concedes that
partitions trade concurrent runs on one ticket for head-of-line delay. It
predicts it "will appear as latency on busy partitions". An operator had no
way to see that. The runbook mentioned latency once, in the deadline
escalation row. There it told them to check a latency the system did not
expose.

This is the third instance of one pattern here. A fitted agreement threshold
was written to an artifact no production code loaded. A fitted coverage pair
was written the same way and adopted by nothing. Both loops were closed. This
was the last one the register still admitted to.

## Proposed outcome

`pnpm run latency` reads the ledger and reports queue wait and service time
per partition, and writes `latency/v<n>.json`.

Every statement is a SELECT, so the job is safe against a live database. A
test greps the module for any verb that could change the ledger. A claim
that a module cannot damage production has to be enforced rather than
stated.

## Affected users and systems

An operator investigating a slow queue. They gain a command that tells a
partition falling behind from a provider that is slow.

The ledger, read only. The `run` table's three timing columns gain their first
reader. The write path does not change.

A new offline job under `src/latency/`, and a new ignored artifact directory.
No daemon changes, and no live traffic passes through any of this.

## Constraints

- Every statement is a SELECT. The job must stay safe against a live ledger.
- No correction is chosen. Open item 7 asks for the data a correction needs.
- No published number moves, and the committed fixtures stay byte-identical (DEC-18).
- The partition key and the fencing epoch are untouched (DEC-27, DEC-28, DEC-36).
- The report never reads case text. It reads timestamps and a partition number.
- The artifact stays on the adopter's machine (DEC-17, DEC-19).
- A quantity that could not be measured is reported as unmeasured, never as zero.

## Reasons behind the shape

**The aggregation runs in the database.** A ledger holds one row per run and
an adopter's is large. Pulling every timestamp to the client to sort it is the
shape a first draft naturally takes. It is also the one that breaks at
scale.

**`percentile_disc`, not `percentile_cont`.**

Interpolation is the monitoring convention because a histogram has already
discarded its observations. This reads a ledger that still holds every one, so
each figure is a duration a real run took. Falsifying this showed the cost
concretely. Under `percentile_cont` the p50 of ten runs at one through ten
minutes is 5.5 minutes. No run recorded that value. An interpolated p99 is the
wrong thing to hand an operator asking how bad it got.

**Percentiles, never an average.** Head-of-line delay is a tail phenomenon and
an average is where it hides. A partition whose every hundredth ticket waits
an hour has an unremarkable mean.

**A run with no arrival time is unmeasured, not zero.** Counting it as zero
would invent the most flattering possible number about the runs the ledger
knows least about. It is counted separately instead.

**An unfinished run is excluded and counted.** An idle partition and a stalled
one both show few finished runs. That count is what separates them.

**Each exclusion carries its own count.** One label per remedy. A run with no
intake row and two hosts that disagree about the time are different problems.
One count covering both sends an operator to neither. So the report names
five: `unmeasured`, `unordered`, `unfinished`, `unstamped` and `never_ran`.

**The service population keys on the run's state, not on a null finish
time.** `db/005` leaves existing rows with a null finish. Keying on the timestamp reported every run older than the migration as unfinished forever. An upgraded ledger then showed every partition permanently stalled. That count is the one the runbook sends an operator to read.

**A run that never entered service is excluded from service time.**
`abandonMessage` files a run already terminal, so its creation and its finish are one timestamp. Its service time is exactly zero. It did not take no time; it never ran. The path fires when a partition is failing. Counting those zeros would let a broken partition manufacture the figures that make it
look fastest.

**The artifact is ignored, like `triage/`.** A latency report describes the
adopter's own traffic and they are the data controller (DEC-17, DEC-19). The
gold report is tracked because the README quotes its numbers. Nothing quotes
these.

## Decisions affected

None changes. Open item 7 asks for the data a correction needs, and this
collects it. Choosing a correction is still open, and this job deliberately
does not choose one. The artifact records `role: observation` and the
validator refuses any other value. So the file cannot be read as a decision
nobody made.

- DEC-17, DEC-19. The adopter is the data controller. The report never leaves
  their machine and the job reads no case text.
- DEC-27, DEC-36. Partition ownership and the partition key are untouched.
  This measures their cost; it does not change it.
- DEC-28. The fencing epoch is untouched.

## Open questions

Which correction the data should motivate. That is item 7 itself. It stays
open until an adopter has run this against real traffic for long enough.
Only then does the tail mean something.
