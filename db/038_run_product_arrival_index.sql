-- The routing screen names each product's last arrival (issue #112). It read
-- every run to find it, grouped by product, so the read grew with the whole
-- history. This index lets it step from one product to the next and read
-- each product's newest arrival with one probe. A run with no arrival time
-- recorded counts from its start, as the screen reads it.
--
-- The runs of no product get an index of their own. The planner will not
-- read the second column of the first index in order under `product IS
-- NULL`, so it read every such run, and a ledger that maps no product holds
-- nothing else.
--
-- The lock hazard is the one db/014 describes, on run: every writer to run
-- waits for the build. lock_timeout bounds the wait behind a long
-- transaction, and statement_timeout bounds the build, as in db/017. Either
-- failure rolls back, and writes resume.
--
-- An adopter with a large ledger should build this by hand instead:
--   CREATE INDEX CONCURRENTLY run_product_arrival_idx
--     ON run (product, (COALESCE(enqueued_at, created_at)));
--   CREATE INDEX CONCURRENTLY run_no_product_arrival_idx
--     ON run ((COALESCE(enqueued_at, created_at))) WHERE product IS NULL;
-- then check that both are valid, as db/README.md shows, and record the file:
--   INSERT INTO schema_version (version, filename) VALUES (38, '038_run_product_arrival_index.sql');
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE INDEX IF NOT EXISTS run_product_arrival_idx ON run (product, (COALESCE(enqueued_at, created_at)));
CREATE INDEX IF NOT EXISTS run_no_product_arrival_idx ON run ((COALESCE(enqueued_at, created_at)))
  WHERE product IS NULL;

COMMENT ON INDEX run_product_arrival_idx IS 'Each product''s newest arrival, one probe per product: the routing screen.';
COMMENT ON INDEX run_no_product_arrival_idx IS 'The newest arrival of the runs of no product, one probe: the routing screen.';
