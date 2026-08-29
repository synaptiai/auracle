-- Conversation history that survives the ack — docs/v1-architecture.md DEC-37.
--
-- DEC-37 puts conversation history into the classifier and composer prompts.
-- The mechanism shipped, and it carried nothing.
--
-- `conversationHistory` read each earlier turn's text from the queue row, by
-- joining `turn` to `intake` on (ticket_id, message_id). The consumer deletes
-- that row the moment a run completes, so every turn before the one being
-- processed had already been acked and contributed no row. The prompts saw an
-- empty history in every ordinary path, and a non-empty one only when an
-- earlier turn had failed and stayed queued.
--
-- The ledger held no other copy: `turn` records a message's identity and not
-- its text. It does now, so history no longer depends on the queue.
--
-- Retention: this stores customer message text in the ledger for the life of
-- the conversation. `intake` already held the same text, but only until the
-- ack. The adopter is the data controller (DEC-17, DEC-19), and this
-- repository ships no retention or purge job.
--
-- Forward-only, and safe to re-apply: the test suites re-apply every
-- migration between cases.

ALTER TABLE turn ADD COLUMN IF NOT EXISTS body_text text;

COMMENT ON COLUMN turn.body_text IS 'DEC-37: the inbound message text, kept for the prompts of later turns. Null on a turn recorded before db/010, and on one whose queue row was already acked when this migration ran.';

-- Recover the text of every turn whose queue row still exists. A turn acked
-- before this migration has no surviving copy; it stays null and contributes
-- nothing to history, exactly as it did before.
UPDATE turn t
   SET body_text = i.ticket_text
  FROM intake i
 WHERE i.ticket_id = t.ticket_id
   AND i.message_id = t.inbound_message_id
   AND t.body_text IS NULL;
