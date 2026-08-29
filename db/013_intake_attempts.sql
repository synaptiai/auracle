-- A poison message leaves the queue — section 4.3, DEC-30.
--
-- `processQueuedTickets` isolates a per-ticket failure and leaves the message
-- queued, so the next scan retries it. That is right for a transient fault
-- and wrong for a permanent one: a message that always throws is retried on
-- every scan forever, spends a classifier sample budget each time, and leaves
-- one orphan run per attempt. The only signal is one identical log line per
-- interval, which is the shape an operator filters out.
--
-- The relay already refuses to livelock this way: a payload that matches no
-- known shape escalates instead of staying pending. The consumer had no
-- equivalent, so this column gives it one.
--
-- Forward-only, and safe to re-apply: the test suites re-apply every
-- migration between cases.

ALTER TABLE intake ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN intake.attempts IS 'Failed processing attempts. The consumer escalates the message past MAX_INTAKE_ATTEMPTS instead of retrying it forever.';
