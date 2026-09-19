-- The reply a reviewer saved before approving it — docs/v1-architecture.md DEC-44.
--
-- DEC-44 makes the console the place a person edits the reply. For an adapter
-- whose helpdesk cannot send the copy it parks, the ledger holds the text that
-- sends. This column is that text while it is still being written: a reviewer
-- saves it, reloads the case, edits again, and only then approves.
--
-- Beside `approved_reply_text` rather than replacing it, because the two
-- answer different questions. This one is what a person saved; that one is
-- what an approval sent (DEC-37). An approval of a saved reply writes both,
-- and the pair is what makes an edit distance measurable at all.
--
-- Null is an answer: no person saved an edit for this turn, so the approval
-- sends the body the park journaled. The change backfills nothing: a turn
-- written before this migration had no such edit to lose.
--
-- Forward-only. The runner applies each file once, in its own transaction.

ALTER TABLE turn ADD COLUMN IF NOT EXISTS saved_reply_text text;

COMMENT ON COLUMN turn.saved_reply_text IS 'DEC-44: the reply a reviewer saved on the case screen, before any approval sends it. Null means no person saved an edit for this turn, so the approval sends the parked body.';
