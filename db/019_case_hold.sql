-- The case hold — docs/v1-architecture.md DEC-46.
--
-- DEC-46: "A console outcome on a reply the ledger holds applies only to the
-- case as its reviewer was shown it." A reviewer takes a case before working
-- it. The take marks that case held by one reviewer for a period, and every
-- other reviewer sees who holds it and how long is left.
--
-- The hold is advisory: it refuses no write. The fencing epoch (DEC-28) and
-- the run's row lock stay the guards on writes, and a reviewer who does not
-- hold a case may still approve it. What the hold decides is who the console
-- says is working the case, and how long the case held a person.
--
-- Two tables, and the split is the point. `case_hold` holds the live state:
-- one row per run, so "who holds this case" is one lookup, and one row cannot
-- double-hold. `case_hold_event` is append-only: it is the history a team
-- reads when it asks how long a case held a person, and it survives every
-- later take on the same case.
--
-- Two conventions carry over from db/001_ledger.sql and db/008_conversation.sql:
-- every table carries comments, and no table declares a foreign key. The
-- writers enforce the joins, not the schema.
--
-- Forward-only, and safe to re-apply: the test suites re-apply every
-- migration between cases.

CREATE TABLE IF NOT EXISTS case_hold (
  run_id       uuid        PRIMARY KEY,
  reviewer     text        NOT NULL,
  taken_at     timestamptz NOT NULL DEFAULT now(),
  lapses_at    timestamptz NOT NULL,
  released_at  timestamptz,
  released_by  text,
  release_kind text CHECK (release_kind IS NULL OR release_kind IN
    ('release', 'send', 'take_other', 'lapse'))
);

COMMENT ON TABLE case_hold IS 'DEC-46: the reviewer a case is held by, one row per run. Advisory: it refuses no write. A lapsed row is cleared by the next read or action that notices it.';
COMMENT ON COLUMN case_hold.run_id IS 'DEC-46: the run this hold is on. One row per run, so a case cannot be held twice.';
COMMENT ON COLUMN case_hold.reviewer IS 'The reviewer holding the case, as the roster spells the identity.';
COMMENT ON COLUMN case_hold.taken_at IS 'When the hold was taken. "How long has this been held" reads from here.';
COMMENT ON COLUMN case_hold.lapses_at IS 'When the hold stops counting. A read or an action at or after this instant records the lapse.';
COMMENT ON COLUMN case_hold.released_at IS 'When the hold ended: a release, a send, another case taken, or a lapse. Null while the hold is live.';
COMMENT ON COLUMN case_hold.released_by IS 'DEC-46: who ended the hold. Null on a lapse, which nobody does.';
COMMENT ON COLUMN case_hold.release_kind IS 'Why the hold ended: release, send, take_other, or lapse.';

CREATE TABLE IF NOT EXISTS case_hold_event (
  event_id      bigserial   PRIMARY KEY,
  run_id        uuid        NOT NULL,
  reviewer      text        NOT NULL,
  kind          text        NOT NULL CHECK (kind IN ('take', 'handover', 'release', 'send', 'lapse')),
  reason        text,
  at            timestamptz NOT NULL DEFAULT now(),
  from_reviewer text
);

COMMENT ON TABLE case_hold_event IS 'DEC-46: every take, handover, release, send and lapse, with its reviewer and time. Append-only, and the record a team reads for the time a case held a person.';
COMMENT ON COLUMN case_hold_event.run_id IS 'The run the event belongs to. No foreign key, as everywhere in this schema.';
COMMENT ON COLUMN case_hold_event.reviewer IS 'The reviewer this event is about: the one who took, released or sent it.';
COMMENT ON COLUMN case_hold_event.kind IS 'take — a reviewer took a free case; handover — a takeover moved a live hold; release — the holder let it go; send — an approval ended it; lapse — the period ran out.';
COMMENT ON COLUMN case_hold_event.reason IS 'Why, where the kind is not enough: take_other for a release the taker''s next case caused, refresh for a take by the holder. Null when the kind says it.';
COMMENT ON COLUMN case_hold_event.at IS 'When it happened, to the microsecond the database keeps.';
COMMENT ON COLUMN case_hold_event.from_reviewer IS 'On a handover or a takeover, whose hold moved. Null on a first take.';

CREATE INDEX IF NOT EXISTS case_hold_lapses_idx ON case_hold (lapses_at);
