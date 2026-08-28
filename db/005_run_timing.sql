-- Run timing (docs/v1-architecture.md section 6, V2 open item 7).
-- Head-of-line delay inside a partition is not corrected in V1. Choosing a
-- correction needs production latency data from Phase 2. These columns make
-- that data collectible from the ledger alone:
--
--   queue wait   = created_at - enqueued_at
--   service time = finished_at - created_at
--
-- intake.enqueued_at dies with the ack, so the arrival time is copied onto
-- the run row at pickup. created_at fills itself: the run row is created at
-- pickup and the column carries a DEFAULT. finished_at is stamped by the
-- fenced ledger path when a run enters a terminal state, in the same
-- transaction as the state change.
--
-- Plain SQL applied by src/ledger/migrate.ts, which records each version
-- in schema_version (V2 open item 6). IF NOT EXISTS keeps this file
-- idempotent. Existing rows keep null enqueued_at/finished_at; their
-- created_at reads as the migration time.

ALTER TABLE run ADD COLUMN IF NOT EXISTS enqueued_at timestamptz;
ALTER TABLE run ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE run ADD COLUMN IF NOT EXISTS finished_at timestamptz;

COMMENT ON COLUMN run.enqueued_at IS 'V2 open item 7: arrival time copied from intake at pickup. Queue wait = created_at - enqueued_at. Null when the caller had no intake row.';
COMMENT ON COLUMN run.created_at IS 'V2 open item 7: run row creation, which is queue pickup. Default now(), so every insert path records it.';
COMMENT ON COLUMN run.finished_at IS 'V2 open item 7: stamped when the run enters a terminal state (resolved, escalated, superseded, abandoned). Service time = finished_at - created_at.';
