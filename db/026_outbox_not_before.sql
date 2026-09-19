-- The moment a held outbox record may be sent — DEC-51.
--
-- A batch confirm sends several replies at once, and a reviewer who confirms
-- by mistake needs a way back. An undo after the send is false: the customer
-- already has the reply. So a console send of a reply the ledger holds waits
-- for a hold period, and this column is that period: the relay sends nothing
-- before the moment it names.
--
-- Its own column, and not a field of `payload`. The payload is hashed into
-- the idempotency key, and the hold is a timing rather than action semantics
-- (DEC-24): a held send and an immediate send of one action derive one key.
--
-- Null is no hold at all, which is every record on the DEC-40 draft path, and
-- every record the command line writes. A reply on that path can be sent from
-- the helpdesk by hand at any moment, so no undo could promise that nothing
-- was sent (DEC-51).
--
-- Forward-only. The runner applies each file once, in its own transaction.

ALTER TABLE outbox ADD COLUMN IF NOT EXISTS not_before timestamptz;

COMMENT ON COLUMN outbox.not_before IS 'DEC-51: the moment this record may be sent. The relay skips a pending row whose not_before is in the future, and an undo inside that window deletes the row. Null is no hold: the draft path, the command line, and every record written before this column existed. Kept out of `payload` so the key never folds in a timing (DEC-24).';
