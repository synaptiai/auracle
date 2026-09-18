-- The release kinds `case_hold` allows, as a constraint of its own (DEC-46).
--
-- db/019 defined the column and the CHECK together, which reaches a database
-- that has not run it. A database that ran db/019 before this constraint was
-- written keeps the table it made — `CREATE TABLE IF NOT EXISTS` is a no-op
-- there — so the vocabulary is added to it here. The runbook states the rule:
-- never edit a file any database has already applied.
--
-- Forward-only, and safe to re-apply: the constraint is dropped by name
-- first, so this file installs it whether or not it is already there.
--
-- The four values are the ones db/019's comment names: release, send,
-- take_other and lapse.

ALTER TABLE case_hold DROP CONSTRAINT IF EXISTS case_hold_release_kind_check;

ALTER TABLE case_hold ADD CONSTRAINT case_hold_release_kind_check
  CHECK (release_kind IS NULL OR release_kind IN ('release', 'send', 'take_other', 'lapse'));
