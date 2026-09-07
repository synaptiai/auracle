# Intent: one package manager, everywhere a user reads

## Problem

`c51b773` made pnpm the canonical package manager. It changed the documents
and the workflows. It did not change the source.

Seventeen source files still named npm. Three of them print the name to a
user at run time:

- `src/escalations/cli.ts` prints `usage: npm run escalations`.
- `src/kb/cli.ts` prints `usage: npm run load-docs`.
- `src/approval/cli.ts` prints `usage: npm run approve`.

Two more name it inside an error an operator reads while the database is
wrong. `src/kb/loader.ts` tells them to run `npm run db:migrate`.

`AGENTS.md` states that an `npm install` produces a tree that no workflow
validates. So the tools handed a user an instruction the repository disowns.

The taxonomy-induction job had a second problem. It is step 1 of phase 1, and
it was the only job with no script. A reader reached it as
`node dist/jobs/run-taxonomy-induction.js`, which needs a build first. It
matches no other entry in the table beside it.

The eval workflow had a third. `.github/workflows/agent-evals.yml` set
`EVAL_BEHAVIOUR` to 1 on every push and on a nightly schedule. That bypassed
the opt-in gate `8982a15` added.

The behaviour layer spends model calls. `run_behaviour_case` reads the
agent's stdout rather than the repository. So the synthetic-fixture case
passes when an agent writes the file. And it prints `Done.` The schedule
paid for a check that cannot fail correctly.

## Proposed outcome

No source file names npm, except where npm is the right tool. Installing the
Claude CLI globally stays an npm command.

`pnpm run induce` runs the induction job. The runbook names the script.

The behaviour evals run on an explicit dispatch and never on a schedule. The
job states why in place.

## Affected users and systems

An operator who reads a usage line or an error. A contributor who follows the
runbook. The repository's Actions bill.

No runtime behaviour changes. No ledger, coordinator, relay or policy code is
touched.

## Constraints

The guard cases in `.claude/hooks/test_live_db_approval.py` keep their npm
strings. They test the guard against the input it may still see.

`node-version` moves to 22, because `engines` requires it.

## Decisions affected

None. The package manager is an implementation detail, and the job already
existed. The workflow change restores the gate that `8982a15` documented.

## Open questions

The behaviour cases still read stdout. They stay off a schedule until they
assert against the tree instead.
