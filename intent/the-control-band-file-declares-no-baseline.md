# Intent: the control-band file declares no baseline

## Problem

`bands.yaml` carried a baseline mean and a baseline sigma for each of four
metrics. All eight values were null.

Nothing read them. No code parses the file, and the control-band job computes
its baseline from the ledger's own daily samples.

The file's header promised the fields fill when a full window exists. That
promise could never be kept. A baseline is an adopter's production number,
and this repository ships synthetic fixtures only.

So the file held a second definition of a baseline that the running system
never consults.

## Proposed outcome

The file declares one definition of a baseline, which is the job's. It names
the ledger as the source, so a reader who looks there finds the answer.

The runbook and the roadmap agree with the file.

## Affected users and systems

An operator reading `bands.yaml` to learn where a band comes from. No runtime
behaviour changes, and the job reads the same ledger it read before.

## Constraints

The window, the four metrics and their directions do not change. The
structural case pins them, and it now pins each metric's source too.

A baseline stays with the adopter (DEC-18). The runbook states that position
(DEC-19).

## Decisions affected

None. This is an implementation detail. DEC-18 and DEC-19 constrain it and
neither changes.

## Open questions

None.
