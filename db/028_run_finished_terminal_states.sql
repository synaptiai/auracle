-- What `run.finished_at` means, with the states DEC-48 added (DEC-48).
--
-- db/005 wrote the comment and named the four terminal states it knew. A
-- reviewer may now close a case with no reply, so the column is stamped for a
-- fifth. The comment is what a reader asks the database, and a list that
-- stops at four answers with a state the ledger no longer holds apart.
--
-- The file is not edited. The runbook's rule is that a file any database has
-- already applied is never edited, and db/005 is one of them. So the comment
-- is issued again here, which is idempotent and changes no data.
--
-- Forward-only, and safe to re-apply.

COMMENT ON COLUMN run.finished_at IS 'V2 open item 7: stamped when the run enters a terminal state (resolved, escalated, superseded, abandoned, closed). Service time = finished_at - created_at.';
