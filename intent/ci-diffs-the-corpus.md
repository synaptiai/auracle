# Intent: CI diffs the corpus against its generator

## Problem

`AGENTS.md` states that the committed fixtures match the generator byte for
byte. Nothing checked it. A contributor could edit a fixture by hand, or change
the generator and forget to regenerate, and no job would notice.

`REVIEW.md` recorded the gap honestly. The gap stayed open anyway.

The header of `.github/workflows/tests.yml` also named the wrong DDL. It
promised that the suites apply `db/001-005`. Each suite now applies every file
under `db/` through `src/test-support/schema.ts`, and `db/` holds nine files.

## Proposed outcome

`.github/workflows/tests.yml` runs the generator and then diffs `fixtures/`. A drifted corpus
fails the pull request.

The workflow header names the mechanism that runs today.

`REVIEW.md` and `AGENTS.md` record the new coverage.

## Affected users and systems

A contributor who edits a fixture or the generator. The pull request now fails
unless the two agree.

No runtime component changes.

## Constraints

The diff is the part that can fail. Running the generator and reading its output
proves nothing, because the generator writes at module scope (DEC-18).

The job already installs Node, so the step needs no new setup.

## Decisions affected

DEC-18. The change adds enforcement for a rule the register already states. It
changes no decision text.

## Open questions

The intent-file rule still has no checker. Deciding whether a commit changes
behaviour needs a reader, so `REVIEW.md` keeps recording that gap.

---

## Superseded facts, recorded 2026-09-04

`db/` held nine files when this was written. It holds fourteen now. The point
the sentence makes is unchanged: the suites apply the real schema.
