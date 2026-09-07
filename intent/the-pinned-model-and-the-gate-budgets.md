# Intent: the pinned model and the gate budgets

## Problem

The pinned default chat model was retired. The provider's catalogue does not
list it. So an operator following the documented default start met a
catalogue error at the first model call. Nothing in the repository noticed. No
test named the pin, and the runbook stated it in prose beside a literal in
source.

The replacement reasons before it answers. The provider bills that reasoning
against the answer budget. Three calls allowed 32 answer tokens. Measured
against the live provider, every one of them exhausted the budget on reasoning
and returned an empty answer.

An empty answer was not a failure. The verdict reader scored anything it could
not parse as an unsupported claim. So a truncated call became a coverage
verdict. Coverage fell to zero and every draft was blocked. The gate reported
a confident fraction while it measured nothing.

The naming call in the induction job shared the defect. An empty answer became
a candidate intent with a blank label and a fallback id.

Five statements still described the queue as partitioned by a hash of the
ticket id. The register also claimed a latency report reads the timing
columns. No such report exists.

## Proposed outcome

A truncated answer is refused where it is detectable, at the model boundary.
It carries the cost of the call it refused. The run that met it ends,
records its spend and escalates with a reason of its own.

An operator who follows the documented default start reaches a working model.
The runbook, the README and the contributor guide name the model that serves
them. One test binds the runbook's value to the code's.

The coverage gate measures what it claims to measure. An unreadable answer
raises, and never becomes a verdict. An unknown outcome escalates, as it does
for an unknown delivery.

The reader takes a verdict that opens a line. So a model that reasons aloud
still resolves and prose about a verdict does not. The line may carry the
markup a model reaches for. Two verdicts are unreadable rather than the first
one found.

Every statement about the partition key names the conversation id, and the
ticket id only as the fallback. The register claims no reader that does not
exist.

## Affected users and systems

An operator starting the consumer on the defaults. The coverage gate, the
taxonomy induction job and every process that reads the default pin. No
ingress path and no ledger write changes.

## Constraints

- DEC-05. The two gates stay independent. Nothing here reads an agreement
  value.
- DEC-07. The coverage thresholds keep their meaning. The 0.70 and 0.80 values
  do not change, and they stay seeds.
- DEC-18. Nothing real enters the repository. The committed fixtures stay
  byte-identical and the measurement runs on the synthetic corpus.
- DEC-25. Cost limits keep working. The new model reports its cost.
- DEC-26. Versions stay pinned. The default is a value, not a floating alias.
- DEC-30. An unknown outcome escalates. It is never guessed.
- DEC-36. The partition key is the conversation id, and the ticket id when a
  run has no conversation.

## Decisions affected

None. Every change is an implementation detail or a correction of a false
statement. The decisions above constrain the work and none of them changes.

## Open questions

None outstanding. The judge was measured against the real model on a sample of
the committed gold set. The figures are reported in the pull request
beside the values the seeds assume. The measurement is not a fit.
