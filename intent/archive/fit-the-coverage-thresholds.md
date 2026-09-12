# Intent: fit the coverage thresholds

## Problem

Two of the three gate numbers had never been measured. Paragraph 4.10 says the
thresholds are fitted on the fit half. That sentence was not true of the two
coverage numbers, and no job could make it true. Nothing said whether a
draft was really grounded.

The second gate is the only defence against a confident error. Its two numbers
decided the automatic path on the strength of a seed.

## Proposed outcome

A job fits both numbers on labelled data and records what it measured. Every
gold case carries its claims. Each names the document it is tested against and
whether that document really supports it.

The two numbers are fitted by different rules, because they answer different
questions. Above the review value a draft runs automatically, so such a draft
must be truly grounded: a precision floor. Below the block value the engine
escalates instead of showing a person. So such a draft must really be
ungrounded: a floor on negative predictive value.

## Affected users and systems

The offline jobs. Nothing in the runtime path changes.

## Constraints

DEC-05 keeps the gates independent. The job reads no agreement value, the
sample shape cannot carry one, and the artifact refuses to record one.

DEC-31 keeps the halves apart. The job reads the fit half alone.

DEC-18 keeps the corpus synthetic. The claims are invented, and the job says so
in its artifact.

## Decisions affected

None. DEC-05, DEC-07, DEC-18 and DEC-31 govern this work and none changes. The
two threshold values are implementation details of paragraph 4.7.

## Open questions

The job refuses when the measured classes do not separate. A refusal leaves the
seeds standing and section 6 keeps its caveat. That is the honest outcome and
not a failure.

A synthetic corpus cannot settle whether the judge protects a real thread. The
grades make the weakness visible rather than removing it.
