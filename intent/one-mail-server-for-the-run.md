# Intent: One mail server, and no suite that skips itself

## Problem

Each mail suite started its own GreenMail container at module scope. Two
container starts per run, and each one a cold JVM.

Each suite also guarded itself with `describe.skipIf(!greenmail)`. A start
failure produced a green run. That is the failure mode the database probe
already removed.

The container was allowed 300 seconds to start. The first delivery was
allowed 15. `GenericContainer` reports readiness when a port is open.
The JVM binds its ports long before it can serve a mailbox. So the suite
spent its delivery budget on a server that was not ready.

The hooks apply DDL and truncate tables under the 10 second default.

## Proposed outcome

The global setup starts one GreenMail server per run and waits until it
answers IMAP. It provides the host and the mapped ports through the typed
context, beside the database URI.

An unavailable server fails the run. No suite guards itself.

Each mail suite owns its own mailboxes. One server serves both suites now.
A shared address let one suite's delivered mail count as the other's unseen
mail. That happened, and this is the fix.

The delivery budget is 60 seconds and the hook budget is 60 seconds.

## Affected users and systems

Anyone who runs the tests.

## Constraints

`AURACLE_TEST_MAIL_REUSE=1` keeps the server warm between local runs, the
same way the database flag does. Reuse stays off on CI.

## Decisions affected

None. This is an implementation detail of the test harness.

## Open questions

None.
