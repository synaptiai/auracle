-- The attempt a turn is on (DEC-49).
--
-- A reviewer may send a case back, and the turn is then attempted again. Three
-- writers need to agree on which attempt that is: the queue, which files a run
-- for a message redelivered after its ack; the consumer's scan, which starts
-- the attempt a reviewer asked for; and the send-back, which asks for it.
--
-- Reading the answer off the runs did not work. The highest attempt a run
-- carries is the attempt that ran, not the attempt that was asked for, so
-- between a send-back and the scan the queue read the rejected attempt's
-- number and filed a run under its key. The adapter then handed that run the
-- draft the reviewer rejected.
--
-- So the turn holds the answer. Only a send-back raises it, and it does so
-- under the turn row's lock, which the approval, the save and the rewrite of
-- that turn also take: a reviewer cannot approve, save or rewrite a reply on
-- an attempt another reviewer has already sent back.
--
-- Every turn before this migration is on attempt 1, which is what it was.
-- Additive, and safe to re-apply.

ALTER TABLE turn ADD COLUMN IF NOT EXISTS attempt integer NOT NULL DEFAULT 1;

COMMENT ON COLUMN turn.attempt IS 'DEC-49: the attempt this turn is on. 1 until a reviewer sends the case back; raised by one for each send-back, under the turn row lock. Every run of the turn is created at this attempt, so a redelivered message never derives a rejected attempt''s keys.';
