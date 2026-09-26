-- The console's queue header counts the turns that arrived on one UTC day
-- (src/escalations/today.ts), on every load of the page a reviewer opens.
-- db/008 indexed turn by ticket and by message, and not by time, so each load
-- scanned the whole table. A full scan of an adopter's ledger evicts the
-- working set that live traffic depends on.
--
-- The lock is the one db/014 measured for run: a ShareLock that blocks every
-- intake write to turn while the build runs. lock_timeout bounds the wait
-- behind a long transaction, so the migration fails and rolls back instead.
-- It does not bound the build itself, which holds the lock for as long as it
-- runs. statement_timeout does: a build too large for it fails and rolls back,
-- and intake writes resume, rather than intake stopping for the whole build.
--
-- An adopter with a large ledger should build this by hand instead:
--   CREATE INDEX CONCURRENTLY turn_created_at_idx ON turn (created_at);
-- then check that the index is valid, as db/README.md shows, and record
-- the file:
--   INSERT INTO schema_version (version, filename) VALUES (17, '017_turn_created_at.sql');
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE INDEX IF NOT EXISTS turn_created_at_idx ON turn (created_at);

COMMENT ON INDEX turn_created_at_idx IS 'Windowed reads by day: the console queue header in src/escalations/today.ts.';
