-- The reply an outbox record sends, when the ledger holds it — DEC-44.
--
-- On the DEC-40 draft path the record names a handle and the helpdesk holds
-- the text. On DEC-44's path there is no copy the helpdesk can send, so the
-- record itself carries what to send: the approved body, the adopter's
-- disclosure (DEC-14) and the provenance (DEC-33).
--
-- Its own column, and not a field of `payload`. The payload is hashed into
-- the idempotency key, and DEC-49 rejects a key that folds in a digest of
-- the body by name: two approvals of one turn must derive one key whatever
-- text a person edited. A field here would have changed the key with the
-- edit, so the edit would have taken a second key and sent twice.
--
-- Nullable: a record on the draft path carries no reply, because the draft
-- is what sends. Null is that answer, not a gap.
--
-- Forward-only. The runner applies each file once, in its own transaction.

ALTER TABLE outbox ADD COLUMN IF NOT EXISTS reply jsonb;

COMMENT ON COLUMN outbox.reply IS 'DEC-44: the reply this record sends when the ledger holds it rather than the helpdesk: {bodyText, disclosure, provenance}. Null on the draft path, where the parked copy is what sends. Kept out of `payload` so the idempotency key never folds in the text (DEC-49).';
