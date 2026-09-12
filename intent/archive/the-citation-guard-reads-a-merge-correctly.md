# Intent: the citation guard reads a merge correctly

## Problem

The pull request failed on its first run. The guard blocked the synthetic
merge commit that GitHub builds for every pull request.

`c51b773` fixed a real gap: `git show --name-only` prints no file list for a
merge. So a merge that edited the register was never checked. That fix used
`-m --first-parent`, which overcorrected. A merge then reports every change on
the branch as its own. GitHub's merge commit carries a generated message,
`Merge <sha> into <sha>`, which can never cite a decision. So every pull
request that touches the register failed, whatever its commits said.

Measured on the real merge commit: `-m --first-parent` reports 145 files.

The guard's own case file had no range-mode case at all. The merge handling
was free to regress, and it did.

## Proposed outcome

`changed_files` uses `--cc`, which reports what a merge changed against every
parent. That is the evil merge and nothing else.

A clean merge lists no file and passes. A merge that edited the register on
its own still lists it and is still checked. An ordinary commit is unaffected.

Measured on the same merge commit: `--cc` reports 0 files.

Four range-mode cases now cover both directions, including an evil merge built
in a scratch repository.

## Affected users and systems

Every pull request. The guard runs on each one through
`.github/workflows/guardrails.yml`.

No runtime component changes.

## Constraints

The original finding must survive. A merge that edits the register on its own
belongs to no other commit. So the merge itself carries the citation.

The rule must still bite on the commit that made the change. A branch that
edits the register without a citation still fails, whether or not it merges
cleanly.

## Decisions affected

None. The guard enforces section 2 of the register and this corrects how it
reads history. No decision text changes.

## Open questions

None. Both directions have a case, and reverting the fix fails the first one.
