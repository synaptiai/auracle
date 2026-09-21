-- The send-back release kind, on the hold and on its history (DEC-49).
--
-- A reviewer may send a case back for a new attempt. The run leaves the
-- approval queue and never returns: a later attempt is a new run, which a
-- reviewer takes on its own. So the reservation on the run this ends has no
-- meaning left, exactly as it has none on a case a reviewer closed.
--
-- The kind is its own and not the close's. The holds history is what a team
-- reads for the time a case held a person, and recording `close` on a case
-- that was sent back would put an event in it that never happened. db/027
-- added the close kind for that reason; this adds the send-back's.
--
-- Two CHECK constraints, because the column and its history both carry the
-- name. The constraint name is written out here, so a database that named
-- them differently fails loudly rather than keeping a stale set.
--
-- Additive, and safe to re-apply.

ALTER TABLE case_hold DROP CONSTRAINT IF EXISTS case_hold_release_kind_check;
ALTER TABLE case_hold ADD CONSTRAINT case_hold_release_kind_check
  CHECK (release_kind IS NULL OR release_kind IN ('release', 'send', 'close', 'send_back', 'take_other', 'lapse'));

ALTER TABLE case_hold_event DROP CONSTRAINT IF EXISTS case_hold_event_kind_check;
ALTER TABLE case_hold_event ADD CONSTRAINT case_hold_event_kind_check
  CHECK (kind IN ('take', 'handover', 'release', 'send', 'close', 'send_back', 'lapse'));

COMMENT ON COLUMN case_hold.release_kind IS 'Why the hold ended: release, send, close, send_back, take_other, or lapse.';
COMMENT ON COLUMN case_hold_event.kind IS 'take — a reviewer took a free case; handover — a takeover moved a live hold; release — the holder let it go; send — an approval ended it; close — a reviewer closed the case with no reply; send_back — a reviewer sent the case back for a new attempt; lapse — the period ran out.';
