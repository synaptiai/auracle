-- The close release kind, on the hold and on its history (DEC-48).
--
-- A reviewer may close a case with no reply. The case leaves the queue, so
-- the hold on it has to end, exactly as an approval's does (DEC-46): a hold
-- left behind would read as a lapse twenty minutes later rather than as the
-- close that ended the work on the case.
--
-- `send` is not that word. A close sends nothing, so recording one as a send
-- would put an event in the team's history that never happened. The kind is
-- its own name.
--
-- Two CHECKs held the vocabulary and both are replaced here. db/019 defined
-- them with the columns, which reaches a database that had not run it; a
-- database that ran db/019 keeps the table it made, because `CREATE TABLE IF
-- NOT EXISTS` is a no-op there. So the constraint is dropped by name and
-- written again, as db/020 does for the release kind.
--
-- `case_hold_event.kind` was written inline and unnamed, so Postgres named it
-- `case_hold_event_kind_check`. Dropping that name works for both shapes: a
-- database that ran db/019 has it, and a database that has not runs db/019
-- first, because the runner applies files in order.
--
-- Forward-only, and safe to re-apply: each constraint is dropped by name
-- before it is added.

ALTER TABLE case_hold DROP CONSTRAINT IF EXISTS case_hold_release_kind_check;

ALTER TABLE case_hold ADD CONSTRAINT case_hold_release_kind_check
  CHECK (release_kind IS NULL OR release_kind IN ('release', 'send', 'close', 'take_other', 'lapse'));

ALTER TABLE case_hold_event DROP CONSTRAINT IF EXISTS case_hold_event_kind_check;

ALTER TABLE case_hold_event ADD CONSTRAINT case_hold_event_kind_check
  CHECK (kind IN ('take', 'handover', 'release', 'send', 'close', 'lapse'));

COMMENT ON TABLE case_hold_event IS 'DEC-46: every take, handover, release, send, close and lapse, with its reviewer and time. Append-only, and the record a team reads for the time a case held a person.';

COMMENT ON COLUMN case_hold.release_kind IS 'Why the hold ended: release, send, close, take_other, or lapse.';
COMMENT ON COLUMN case_hold_event.kind IS 'take — a reviewer took a free case; handover — a takeover moved a live hold; release — the holder let it go; send — an approval ended it; close — a reviewer closed the case with no reply; lapse — the period ran out.';
COMMENT ON COLUMN case_hold.released_at IS 'When the hold ended: a release, a send, a close, another case taken, or a lapse. Null while the hold is live.';
