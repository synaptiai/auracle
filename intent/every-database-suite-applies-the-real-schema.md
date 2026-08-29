# Intent: Every database suite applies the real schema

## Problem

Fifteen database suites named their migrations by hand. Each list was written
when the suite was, and none named `db/006`. So a new migration reached no
suite, and a constraint the migration added was never exercised by a test.

`4ab5c3a` fixed the code and shipped no intent file. `CONTRIBUTING.md` makes
no test-infrastructure exception, so the gap is the file, not the change.

## Proposed outcome

`src/test-support/schema.ts` walks `db/*.sql` in order and applies every one.
A suite calls it and names nothing. A migration added later reaches every
suite on the next run, with no list to update.

## Affected users and systems

Every database suite, and every migration added from now on.

## Constraints

The migrations stay forward-only and safe to re-apply, because the suites
re-apply them between cases.

## Decisions affected

None. This is an implementation detail of the test harness. It changes what
the suites cover, not what the system decides.

## Open questions

Each suite still names its own truncate list by hand, which is the same shape
of defect one level down. A list that falls behind a new table leaks rows
between cases instead of failing.
