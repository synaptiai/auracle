-- The control-band report and the latency report both window on
-- run.created_at. db/005 added the column with no index, so every windowed
-- read scanned the whole run table and discarded most of it. Both jobs are
-- documented as safe to run against a live database, and a full scan of an
-- adopter's ledger evicts the working set that live traffic depends on.
--
-- This takes a ShareLock on run, measured rather than assumed: it conflicts
-- with the RowExclusiveLock every INSERT, UPDATE and DELETE takes, and the
-- migration runner wraps each file in one transaction, so the lock is held
-- for the whole build. Every writer to run blocks meanwhile -- the consumer,
-- the webhook, the imap poller and the relay all write it.
--
-- The sharper hazard is the queue rather than the build. A conflicting lock
-- request queues, and later writers queue behind the request, so a migration
-- waiting on one long transaction stalls every write to run even when the
-- build itself would be quick. lock_timeout bounds that wait: the migration
-- fails and rolls back rather than holding a production outage open, and the
-- runner records no schema_version row, so a retry is clean.
--
-- An adopter with a large ledger should build this by hand instead:
--   CREATE INDEX CONCURRENTLY run_created_at_idx ON run (created_at);
-- then insert the schema_version row for this file. CONCURRENTLY takes no
-- blocking lock, and it cannot run here because it cannot run inside a
-- transaction.
SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS run_created_at_idx ON run (created_at);

COMMENT ON INDEX run_created_at_idx IS 'Windowed reads by day: src/bands and src/latency.';
