# Intent: Constraints the code relies on, and tests that check what they claim

## Problem

Three rules lived only in the code.

`claimPartition` looks a ticket up in `run` by ticket and partition. The only
index was on partition and state, so the DEC-28 rebalance scanned once per
ticket.

DEC-26 pins a prompt version and a model version on every step. The `run`
table enforced this. `step_journal` did not.

`outbox.delivery` had a check. `status` did not, though the code writes a
closed set. A value outside it is invisible to the relay scan and to the
escalations query, so the record strands unseen.

Three tests also claimed more than they checked.

The triage case overrode a subject but not a body. So both cases resolved to
the same intent, nothing was selected, and the provenance loop never ran.

Three assertions read like step order. The helper sorts by step id, which is
alphabetical, so they could not detect a reordered pipeline.

No test drove the cost limit. Every caller passed the same inert ceiling.

The style checker in the skill omitted `"$@"`, so it read no files and always
exited 0.

## Proposed outcome

`db/006_ledger_constraints.sql` adds the index and the two constraints.
`result` stays nullable, because a step is journaled before it acts.

Each test checks what its name says. The order assertions compare sets and
say why. The cost limit has a case that fails without the check.

The style checker reads its arguments.

## Affected users and systems

Any adopter who migrates. Anyone who trusts a green test result.

## Constraints

The migration is forward-only and idempotent. It backfills before it tightens
a column.

## Decisions affected

None. Each constraint enforces a rule DEC-26, DEC-28 or section 4.2 already
states.

## Open questions

None.
