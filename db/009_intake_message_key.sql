-- Per-message intake dedupe — docs/v1-architecture.md DEC-35, DEC-36.
--
-- intake was keyed on ticket_id alone. A ticket id is the thread root, so a
-- genuinely new customer message on a thread that was still queued hit the
-- conflict target and was discarded with no error. The customer's follow-up
-- vanished.
--
-- The key becomes (ticket_id, message_id): a repeat of one message
-- deduplicates, a new message enqueues.
--
-- This file deploys with the code that reads it, never alone. Applied by
-- itself it breaks the enqueue conflict target, and it makes each ack delete
-- every pending message of the ticket.
--
-- Forward-only, and safe to re-apply: the test suites re-apply every
-- migration between cases.

ALTER TABLE intake ADD COLUMN IF NOT EXISTS message_id text;

-- Pending rows predate the column. The ticket id is a distinct dedupe
-- identity for each of them, because the old key made it unique.
UPDATE intake SET message_id = ticket_id WHERE message_id IS NULL;

ALTER TABLE intake ALTER COLUMN message_id SET NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'intake_pkey'
       AND conrelid = 'intake'::regclass
       AND array_length(conkey, 1) = 1
  ) THEN
    ALTER TABLE intake DROP CONSTRAINT intake_pkey;
    ALTER TABLE intake ADD PRIMARY KEY (ticket_id, message_id);
  END IF;
END $$;

-- The queue row records the turn it belongs to, rather than the poll
-- re-deriving it. A message id may repeat across turns of one conversation --
-- a redelivery the ack already removed, then the same id again -- and a join
-- on (ticket_id, message_id) would then match two turns and return the
-- queued message twice.
ALTER TABLE intake ADD COLUMN IF NOT EXISTS conversation_id uuid;
ALTER TABLE intake ADD COLUMN IF NOT EXISTS turn_number integer;

COMMENT ON COLUMN intake.conversation_id IS 'DEC-35: the conversation this queued message belongs to. Null on a row enqueued before db/008.';
COMMENT ON COLUMN intake.turn_number IS 'The turn this queued message is. Null on a row enqueued before db/008.';

COMMENT ON COLUMN intake.message_id IS 'Per-message key half with ticket_id: a repeat message deduplicates, a new message enqueues. Falls back to the adapter delivery id when the source names no message.';
