# Intent: The guardrails cover what the documents claim

## Problem

The synthetic-fixture guard matched only paths holding `/fixtures/`.
`REVIEW.md` extends the rule to fixtures, evals and examples. The fixture
modules under `src/` and the eval cases were outside the guard. That is most
of the surface the rule names.

Widening it alone would have blocked every legitimate edit. The repository
uses reserved addresses such as `sam.smith@example.test`, and the email
pattern matched those too.

`REVIEW.md` said two rules have no CI surface. Five are not enforced on a
pull request. The table also mixed two different things. One job runs a
guard's own cases, and a job applies the rule to the change.

`.gitignore` declared `/gold-report/` a run artifact that is never committed.
`gold-report/v1.json` is tracked, and `README.md` quotes its numbers.

`.gitattributes` held two gitignore patterns, which do nothing there.

The scaffold prompts sat in the adopter-facing `docs/` directory.

## Proposed outcome

The guard covers fixtures, eval cases and the fixture modules under `src/`.
It accepts an address under a reserved domain, because such an address
reaches nobody. It blocks a reachable one.

Each guard has its own case file, and the workflow runs all three.

`REVIEW.md` separates the two columns and names all five gaps.

`.gitignore` states the exception for the published artifact.

## Affected users and systems

Anyone who edits a fixture. Anyone who reads the backstop table.

## Constraints

The rule does not weaken. The guard blocks every reachable address it
blocked before, and now blocks them in more places.

## Decisions affected

None. DEC-18 is unchanged. The guard now applies it where `REVIEW.md`
already said it applies.

## Open questions

Three rules still have no checker: the style rule, the intent-file rule and
the fixture-generator rule. The table records that.
