# Intent: a fitted threshold reaches the gates

## Problem

The calibration job fitted the agreement threshold and wrote a validated
artifact. Nothing loaded that artifact. `loadCalibrationArtifact` had no
caller outside its own tests, so every gate ran on the seeds of section 4.5
and section 4.7. A calibration run could succeed and change nothing.

An operator could not tell the two states apart. A seeded gate and a fitted
gate behaved alike and logged alike. The gold report recorded the value it
used and never its origin, so one published number covered both cases.

## Proposed outcome

The three gate numbers travel as data. The policy engine reads the record it
receives and stays a pure synchronous function. A process resolves its numbers
once at startup, and it logs which it adopted. A missing artifact yields the
seeds and a `gate_thresholds_seeded` line. A fit yields the fitted number and a
`gate_thresholds_fitted` line naming the version. The gold report records the
same provenance beside its gate value.

The loader reads the artifact under the name the directory gave it. It never
rebuilds that name from the version it parsed. A rebuilt name opens a
different file, or none, and the failure then reaches the operator as a bare
error code at startup.

The scan has one posture. An earlier pass made it lenient when it minted the
next version, on the argument that the calibration job is the way out of a
refused directory. The argument is false. The job writes a new version and the
loader refuses the same stray file as before. The message names the file to
remove.

Two names for one version is a fault. A case-sensitive filesystem holds both
spellings, and nothing downstream records which file a gate read, so the
listing order would decide it.

## Affected users and systems

The consumer daemon, the replay job and the gold report. An operator reads one
log line to learn which numbers a process runs on.

A file the loader cannot read stops the process that reads it. That is the
intent: a gate running on a seed, while an operator believes a fit is
deployed, is the failure this work exists to remove.

## Constraints

DEC-05 keeps the gates independent. The resolver moves the agreement number
alone, because only that number has a job that fits it. Nothing blends the two
gates into one score.

DEC-13 keeps one global threshold. The shape carries no intent key, so it
cannot express a threshold for each intent.

DEC-31 keeps the halves apart. An artifact that declares any split other than
the fit half never loads.

## Decisions affected

None. DEC-05, DEC-13 and DEC-31 govern this work and none of them changes.
The transport of a threshold is an implementation detail.

## Open questions

The two coverage numbers have no fitting job yet. That is the next issue. The
gold report refuses a moved coverage value today, because the artifact records
none. That job must record the pair beside the agreement value.

The synthetic corpus cannot show a fitted gate. The offline stub answers every
sample of one ticket alike, so agreement is 1.0 and no threshold below 1.0
changes a decision. Section 6 states this.

None. The gold report and the triage job scanned versions loosely for a
while, and a review showed the cost: a capitalised name made the gold report
mint version 1 over a directory that already held version 5, and publish the
new file while the old one sat unread. All three jobs now share one scan, and each checks its directory before its
own loop. A pass that moved the check for one job while its documentation
claimed three is the failure this replaces.
