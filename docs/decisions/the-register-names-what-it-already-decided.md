# The register names what it already decided

## Problem

The register says some things that its own decisions replace.

- Section 1 says the flow stops at one of two results. DEC-44 to DEC-51 add
  the operator console, where a reviewer also closes a case.
- Section 1.2 lists a threshold for each intent as outside V1. DEC-41 fits
  one above the labeled-case trigger.
- The state diagram labels `awaiting_approval` as customer replies alone. A
  parked internal write waits in that state too.
- DEC-36 replaces the partition key that DEC-27 names. The table of rows
  replaced in part does not record it.
- The headers of the relay and the policy engine leave out decisions that
  their code applies.
- The runbook's table of consumer settings leaves out the data guarantee that
  DEC-17 makes an adopter's choice.

## Proposed outcome

The register and the runbook state each of these as the decisions already
decide. No decision changes.

## Affected users and systems

A reader of the register and of the runbook. No code changes with this record,
and the runbook's other changes in the same pull request cite no decision.

## Constraints

A row of section 2 keeps its text. The table of rows replaced in part says
what a later row replaces. So DEC-27 keeps its words, and the table names
DEC-36 beside it.

## Decisions affected

Affects: DEC-05, DEC-06, DEC-07, DEC-13, DEC-17, DEC-27, DEC-34, DEC-35, DEC-36, DEC-37, DEC-38, DEC-39, DEC-40, DEC-41, DEC-44, DEC-45, DEC-46, DEC-47, DEC-48, DEC-49, DEC-50, DEC-51

DEC-27 and DEC-36: the table of rows replaced in part gains a row. DEC-36
replaces the partition key of DEC-27, and a run with no conversation keeps
the ticket id.

DEC-13 and DEC-41: section 1.2 says that one global threshold holds below the
labeled-case trigger. Above it, DEC-41 fits a threshold for each intent.

DEC-06, DEC-07 and DEC-34: the state diagram names every parked action under
`awaiting_approval`. Among them are an irreversible write and a write below
the review threshold. So is a write through an adapter that lacks a
capability.

DEC-05, DEC-34, DEC-41 and DEC-51: the policy and relay headers name them.
Their code applies them.

DEC-35 to DEC-40 and DEC-44 to DEC-51: section 1.1 names what they add.
That is conversations of more than one turn, and the operator console.

DEC-17: the runbook names `AURACLE_ZDR_ONLY` among the consumer's settings.
It asks the provider for zero data retention, and absence means off.

## Open questions

None.
