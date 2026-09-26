-- The team screen reads the hold history by time and by run (DEC-46).
-- db/019 gave case_hold_event a primary key on event_id and nothing else, so
-- each windowed read scanned the whole table. The history is append-only and
-- grows with every take, so the screen's two-second budget ran out on a
-- ledger of a few tens of thousands of events.
--
-- The lock hazard is the one db/014 describes: this takes a ShareLock on
-- case_hold_event for the build, and every take, release and send waits for
-- it. lock_timeout bounds the wait behind a long transaction. As in db/017,
-- statement_timeout bounds the build itself: a build too large for it fails
-- and rolls back, and hold writes resume.
--
-- An adopter with a large ledger should build these by hand instead:
--   CREATE INDEX CONCURRENTLY case_hold_event_run_idx ON case_hold_event (run_id, event_id);
--   CREATE INDEX CONCURRENTLY case_hold_event_at_idx ON case_hold_event (at);
-- then check that both are valid, as db/README.md shows, and record the file:
--   INSERT INTO schema_version (version, filename) VALUES (36, '036_case_hold_event_indexes.sql');
-- CONCURRENTLY cannot run inside the transaction the migration runner opens.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE INDEX IF NOT EXISTS case_hold_event_run_idx ON case_hold_event (run_id, event_id);
CREATE INDEX IF NOT EXISTS case_hold_event_at_idx ON case_hold_event (at);

COMMENT ON INDEX case_hold_event_run_idx IS 'One run''s hold history in order: the team screen.';
COMMENT ON INDEX case_hold_event_at_idx IS 'The hold history by time: the team screen''s windows.';
