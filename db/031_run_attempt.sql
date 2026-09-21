-- A new attempt on a turn a reviewer sent back (DEC-49).
--
-- A reviewer may send a case back with a note. The request starts a new run
-- on the same turn, and the park key of every attempt of that turn must
-- differ — otherwise the adapter, which finds drafts by key, hands the new
-- attempt the draft the reviewer rejected.
--
-- So the attempt is a column, and every key of a turn folds it in. The
-- first run of a turn is attempt 1, which derives the key that turn always
-- derived; an attempt above 1 is a request a person made.
--
-- Three columns, because the attempt has three readers.
--
-- `attempt` is read by the key derivation of every writer on the attempt
-- (the park, the execute step, the approval) and by the day count, which
-- counts a turn once from its final attempt.
--
-- `sent_back_at` is the durable marker the consumer's scan picks up. A
-- console cannot walk the state machine: it writes the request, and the
-- consumer that owns the conversation's partition starts the next attempt.
-- The column also keeps a rejected attempt in a class of its own in the
-- latency report, apart from service time.
--
-- `send_back_note` is the instruction the new attempt's composer reads.
-- It is not a retrieved document and never counts as coverage (DEC-37).
--
-- `attempt` is NOT NULL with a default, so every run written before this
-- migration is attempt 1, which is what it was. Both columns are additive,
-- and safe to re-apply.

ALTER TABLE run ADD COLUMN IF NOT EXISTS attempt integer NOT NULL DEFAULT 1;
ALTER TABLE run ADD COLUMN IF NOT EXISTS sent_back_at timestamptz;
ALTER TABLE run ADD COLUMN IF NOT EXISTS send_back_note text;

COMMENT ON COLUMN run.attempt IS 'DEC-49: which attempt of its turn this run is. 1 for the first run of a turn and for every run written before the column existed; above 1 when a reviewer sent the case back. Folded into every key of the turn, so a new attempt never derives the rejected draft''s key.';
COMMENT ON COLUMN run.sent_back_at IS 'DEC-49: when a reviewer sent this attempt back. The consumer''s scan starts the next attempt from it, and the latency report keeps the attempt in a class of its own. Null on an attempt nobody rejected.';
COMMENT ON COLUMN run.send_back_note IS 'DEC-49: the reviewer''s note, read by the next attempt''s composer as an instruction. Never a retrieved document, so it never counts as coverage. Null on a run no reviewer sent back.';
