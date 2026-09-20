-- The reply a person wrote, and who wrote it (DEC-48).
--
-- A reviewer may rewrite a case's reply from scratch. The text lands in
-- `saved_reply_text`, beside the model's own path, so the author has to
-- travel with it. The run row cannot say who wrote the reply the customer
-- receives: a turn is served by every run that answers it, and a retry after
-- a crash or a send-back starts another one. A provenance read from the
-- approving run's own journal would name the model for a reply a person
-- wrote, which is the claim this column exists to make true.
--
-- Null means the reply the park journaled, which is the model's. An object
-- means a person's: `{generatedBy, generatedAt}`, the shape the outbox reply
-- carries and the trailer prints. Written in the same statement as the text,
-- so neither can move without the other.
--
-- Additive, and safe to re-apply.

ALTER TABLE turn ADD COLUMN IF NOT EXISTS saved_reply_provenance jsonb;

COMMENT ON COLUMN turn.saved_reply_provenance IS 'DEC-48: the provenance of a reply a person wrote from scratch, or null when the reply is the one the park journaled. Written with saved_reply_text, and refreshed by a later save so the moment names the latest edit.';
