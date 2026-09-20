-- When a snooze ends (DEC-48).
--
-- A reviewer may put a case aside for a period, waiting for the customer or
-- for the clock. The run leaves the approval queue and comes back when the
-- period ends, or ends as `superseded` when the customer writes first.
--
-- The moment is a column and not a claim on the state, for two reasons. The
-- returner scans it: a run whose moment has passed is due back, and the scan
-- reads one column rather than a journal. And it stays after the return,
-- because the latency report keeps every run that was ever snoozed in a
-- class of its own, so the wait never counts as service time — a cleared
-- column would lose that the moment the run came back.
--
-- Nullable, and null is not the epoch: a run nobody snoozed has no moment.
--
-- Additive, and safe to re-apply.

ALTER TABLE run ADD COLUMN IF NOT EXISTS snoozed_until timestamptz;

COMMENT ON COLUMN run.snoozed_until IS 'DEC-48: when the run''s snooze ends. Set when a reviewer snoozes the case, and kept after the run returns to awaiting_approval, because it is the record that the run was ever snoozed. Null on a run nobody snoozed.';
