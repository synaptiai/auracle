# Intent: Live-database guard skips inert heredoc bodies

## Problem

The live-database guard reads the whole Bash command string. A commit
message that names `db:migrate` or `psql` in prose matches the pattern.
The guard then blocks the commit, so a documentation change cannot land.
The observable symptom: `git commit -F -` with a heredoc message exits
with "BLOCKED: this command may touch a live database".

A second fault sits in the same scan. The local-target exemption also
reads the heredoc body. A body that contains the word `localhost` exempts
a command that targets a live host.

## Proposed outcome

The guard strips a heredoc body before it matches either pattern.
A body stays in scope when the line that opens it runs an interpreter,
because `bash <<EOF ... psql ... EOF` does execute the body.
Prose that names a database command no longer blocks a commit.
A command aimed at a live database still blocks.

## Affected users and systems

Anyone who commits through Claude Code in this repository.
The guard is `.claude/hooks/live_db_approval.py`. No runtime code changes.

## Constraints

The guard exists for DEC-17 and DEC-19: the adopter is the data controller,
and a live-database command needs a person. The change narrows false
positives only. It removes no block on a real command.
`.claude/hooks/test_live_db_approval.py` holds 12 cases and runs in
`.github/workflows/guardrails.yml`.

## Decisions affected

None. DEC-17 and DEC-19 keep their meaning. The pattern is an
implementation detail of the guard.

## Open questions

The interpreter list is a fixed set of names. A shell invoked under a name
outside that list would have its body skipped. No case for that exists today.
