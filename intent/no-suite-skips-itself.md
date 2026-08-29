# Intent: No database suite can skip itself

## Problem

Seventeen suites probed Postgres at import time and set a local `dbUp` flag.
A failure turned into `describe.skipIf`, so the suite vanished and the run
still exited 0. That hid about 101 tests, which is close to a quarter of the
suite.

One run during this work showed the hazard. Two files skipped under load and
the summary reported skips rather than failures.

`src/db/smoke.db.test.ts` was worse. It returned early on a failed connect,
so it passed having asserted nothing.

## Proposed outcome

The global setup already guarantees a reachable database. It starts a
container, or it probes an explicit `DATABASE_URL` and fails the run.

So a suite no longer guards itself. A database that the setup accepted and
that later fails is a fault, and the suite fails.

The smoke test asserts on every path.

Two end-to-end suites still skip without GreenMail. That server is a real
optional dependency, unlike the database.

## Affected users and systems

Anyone who reads a green test result, and the pull request workflow.

## Constraints

The change removes no assertion. All 446 tests still run and pass.

## Decisions affected

None. This is an implementation detail of the test harness.

## Open questions

None.
