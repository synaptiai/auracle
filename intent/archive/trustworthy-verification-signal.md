# Intent: The verification signal cannot report success falsely

## Problem

Three commands reported success while proving nothing.

`npm test` exits 0 when `DATABASE_URL` is set but unreachable. Every database
suite skips itself and about 101 tests vanish. The CI job sets that variable
explicitly, so this is the path CI takes.

`python3 evals/run.py` starts the behaviour layer whenever an agent binary
sits on the path. That is always true inside an agent session. The command
then spawns one subprocess per case and stalls for up to 75 minutes.

The live-database guard blocked a read-only repository search. It also
allowed two remote targets: a trailing comment supplied the local exemption,
and `docker exec` exempted whatever command it wrapped.

## Proposed outcome

A green result means the checks ran.

The test setup probes an explicit `DATABASE_URL` before any worker forks. An
unreachable one fails the run and names the cause. An absent variable still
starts a throwaway container, which cannot lie.

The eval behaviour layer needs `EVAL_BEHAVIOUR=1`. The structural layer runs
alone in under a second and needs no model. The workflow job sets the
variable, so its coverage does not disappear.

The guard reads connection arguments rather than whole lines. A comment
grants no exemption. A container grants none when the command it wraps names
a remote host. A read-only text command passes.

## Affected users and systems

Anyone who runs the three commands, and the pull request workflows that run
them.

## Constraints

The guard must not weaken. Every one of its existing cases still passes.
Four new cases cover the two closed paths and the two false positives.

Documentation that described the old skip behaviour changes with the code, in
this commit.

## Decisions affected

None. The command contract in `AGENTS.md` is unchanged; this makes the
commands honour it. DEC-17 and DEC-19 keep the guard's purpose, and the guard
is stricter on remote targets than before.

## Open questions

`npm run db:migrate` still blocks, because the guard cannot see whether
`DATABASE_URL` points at a live database. The setup documentation names that
command. The resolution is a policy call for the maintainer.
