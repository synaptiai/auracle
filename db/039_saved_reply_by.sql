-- Who saved the reply a turn holds, and where that name came from (DEC-44, DEC-45).
--
-- A reviewer saves an edited reply on the case screen, and the approval then
-- sends what the ledger holds. Every other console write records its
-- reviewer and the source of that name: the approval on the run row
-- (approved_by, approved_by_source), and each outcome in its journal row. A
-- saved reply recorded neither, so the ledger could not say whose words an
-- approval sent. Only a log line named the reviewer.
--
-- The pair sits on the turn, beside the text, for the reason
-- saved_reply_provenance does (030): a turn is served by every run that
-- answers it, so the run row cannot say who wrote the reply that stands.
-- Written in the same statement as the text, so a later save replaces both,
-- and a send-back that clears the text clears its saver with it.
--
-- A turn saved before this file has text and no saver. That reads as
-- unknown, which is what it is: no record of the name was kept.
--
-- The CHECK is migration 018's pairing for approved_by, word for word:
-- both null or both set, a source from the vocabulary, and `unattributed`
-- exactly when the source is `none`. One more clause refuses an empty name.
--
-- The CHECK does not tie the saver to the text. Adopters run the purge the
-- runbook gave before this file, which clears the text and not the saver, and
-- a CHECK that refused it would stop that statement erasing customer text.
-- A saver left beside no text is an operator's identifier, kept as
-- run.approved_by is. Every writer this repository ships sets or clears the
-- pair with the text.
--
-- Additive, and safe to re-apply.

ALTER TABLE turn ADD COLUMN IF NOT EXISTS saved_reply_by text;
ALTER TABLE turn ADD COLUMN IF NOT EXISTS saved_reply_by_source text;

ALTER TABLE turn DROP CONSTRAINT IF EXISTS saved_reply_by_source_check;
ALTER TABLE turn ADD CONSTRAINT saved_reply_by_source_check CHECK (
  (saved_reply_by IS NULL) = (saved_reply_by_source IS NULL)
  AND (saved_reply_by_source IS NULL OR saved_reply_by_source IN ('roster', 'header', 'none'))
  AND (saved_reply_by = 'unattributed') = (saved_reply_by_source = 'none')
  AND (saved_reply_by IS NULL OR saved_reply_by <> '')
);

COMMENT ON COLUMN turn.saved_reply_by IS 'DEC-44 with DEC-45: the reviewer who saved the reply in saved_reply_text. Written with the text, so it names the latest saver. `unattributed` means nobody was named; null means no saver was recorded.';

COMMENT ON COLUMN turn.saved_reply_by_source IS 'DEC-45: how the name in saved_reply_by was established. roster — the console checked it against the roster; header — a caller passed a trusted proxy''s claim; none — nobody was named. Null exactly when saved_reply_by is null.';
