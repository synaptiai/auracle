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

A heredoc body leaves the scan only when the line that opens it hands the
body to a data consumer, for example `git commit -F -` or `cat >`.
Every other opener keeps its body, because it may execute it.
Prose that names a database command no longer blocks a commit.
A command aimed at a live database still blocks.

The two tests read different text. The database-command test reads the body
that an interpreter would run. The local-target test reads no body at all.
A body may therefore incriminate a command. It may never exempt one.

## Affected users and systems

Anyone who commits through Claude Code in this repository.
The guard is `.claude/hooks/live_db_approval.py`. No runtime code changes.

## Constraints

The guard exists for DEC-17 and DEC-19: the adopter is the data controller,
and a live-database command needs a person. The change narrows false
positives only. It removes no block on a real command.
`.claude/hooks/test_live_db_approval.py` holds 24 cases and runs in
`.github/workflows/guardrails.yml`.

## Decisions affected

None. DEC-17 and DEC-19 keep their meaning. The pattern is an
implementation detail of the guard.

## Open questions

None. An earlier draft skipped a body unless the opening line named a known
interpreter, so an unlisted shell kept its body out of the scan. The rule now
inverts: a body leaves the scan only when the opening line hands it to a known
data consumer. An unknown command keeps its body, so the fixed lists no longer
decide the safe case.
