# Migrations

Every file here is one migration. `src/ledger/migrate.ts` applies them, and
`pnpm run db:migrate` is how an adopter runs them.

## What the runner guarantees

The runner reads `schema_version` and applies only the files it has not
applied. Each file runs in one transaction with its own `schema_version`
insert. So a failure leaves no half-applied file and no false record.
The runner refuses a file whose version is below the highest recorded version.
Applying it out of order could break a later one.

## Rules for a new file

1. Name it `NNN_short_title.sql`, with `NNN` above every existing number.
2. Write it to run once. The runner never re-applies a file it has recorded.
3. Keep it in one transaction. The runner opens one for you.
4. Do not clear `schema_version`. It is how the runner knows what ran.

Rule 2 is the one that changed. Suites used to re-apply the schema between
cases. So every migration also had to be safe to re-apply, and each file
carried `IF NOT EXISTS` for that reason.

Tests now clone an already migrated template. Nothing re-applies a file, so
the rule the runner states is the only rule. Existing `IF NOT EXISTS` clauses
are harmless and stay.

## The CONCURRENTLY caveat

An index build takes a lock that queues every write to the table behind it.
On a large ledger that stalls production even when the build is quick.
So `db/014_run_created_at_index.sql` sets `lock_timeout`. It fails rather than
hold an outage open.

A lock timeout bounds only the wait for the lock. So
`db/017_turn_created_at.sql` also sets `statement_timeout`. A build too large
for it rolls back, and writes resume.

`CREATE INDEX CONCURRENTLY` takes no blocking lock, and it **cannot run
inside a transaction**. The runner wraps every file in one, so it cannot run
here. An adopter with a large table builds the index by hand:

```sql
CREATE INDEX CONCURRENTLY run_created_at_idx ON run (created_at);
```

and then inserts the `schema_version` row for that file, so the runner skips
it. A migration that needs `CONCURRENTLY` belongs in that procedure and not in
this directory.

## How tests use these files

`src/test-support/db-global-setup.ts` creates one template database per run.
It migrates that template through the real `migrate()` path.
`db-url.setup.ts` then clones it into a database of each test file's own.
So the database suites run in parallel and no two files share rows.

Every name carries a run id, and teardown drops only the names that carry
this run's. Two runs against one server therefore leave each other alone.
A run never touches a database it did not create.

The run's teardown also asserts the isolation it depends on.
It fails when one database served two files.
A shared database is a flake that passes most of the time.

A suite clears its tables with `truncateLedger` from
`src/test-support/schema.ts`. That helper reads the table list from
`information_schema`, not from a list someone wrote down.
A table added here is cleared by every suite from the moment it exists.
No test needs an edit.
