-- A document written from a case, and the new attempt it asks for (DEC-50).
--
-- A reviewer writes the document a case needed, from inside the case. The row
-- names who wrote it, because a document with no author is one nobody can ask
-- about. The loader's rows have no author: a file in the knowledge base is
-- owned by its `owner` field, and nobody typed it into the console. So the
-- author is present exactly on a console row.
--
-- Publishing asks for a new attempt of the case that exposed the gap. The
-- attempt waits for the embedding, because retrieval ignores a document until
-- it has one, and an attempt started earlier would miss the document it was
-- started for. So the request is a row a consumer's scan reads, as a
-- send-back's is. It records the run the reviewer read and that run's
-- attempt, and it ends one of three ways:
--
--   started   the consumer raised the turn's attempt and the scan walks it
--   dropped   the case changed first, or could not be attempted again; the
--             reason says which
--   failed    the embedding failed, so the attempt never starts
--
-- One request per document, and every console document has one, even when no
-- attempt can follow: the reason is then recorded at once, so the case can
-- say why nothing starts. The turn is copied from the run, so the consumer's
-- scan finds a started request by its turn through an index.
--
-- Additive. Every document before this migration came from the loader or the
-- seeder, with no author, so the constraint holds on existing rows.

ALTER TABLE document ADD COLUMN IF NOT EXISTS written_by text;

ALTER TABLE document DROP CONSTRAINT IF EXISTS document_written_by_check;
ALTER TABLE document ADD CONSTRAINT document_written_by_check
  CHECK ((source = 'console') = (written_by IS NOT NULL));

COMMENT ON COLUMN document.written_by IS 'DEC-50: the reviewer who wrote this document in the console, from the identity the console accepted. Null on a loader row, and present on every console row.';

CREATE TABLE IF NOT EXISTS document_rerun (
  doc_id          text        PRIMARY KEY REFERENCES document (doc_id),
  run_id          uuid        NOT NULL REFERENCES run (run_id),
  conversation_id uuid,
  turn_number     integer,
  attempt         integer     NOT NULL,
  status          text        NOT NULL DEFAULT 'waiting',
  reason          text,
  requested_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  ended_at        timestamptz,
  started_attempt integer,
  -- DEC-46: the digest of the reply the reviewer read, on a parked case.
  shown           text,
  -- DEC-46: the digest of the reply saved on the turn when the reviewer
  -- published, or null when none was. A reply saved since drops the request.
  saved_digest    text,
  -- When a scan last read this request and left it waiting, or faulted on
  -- it. The scan reads the requests it read longest ago first, so a request
  -- that waits or faults cannot keep its place at the front.
  checked_at      timestamptz,
  -- Scans that faulted on this request. Each fault delays the next read.
  faults          integer     NOT NULL DEFAULT 0 CHECK (faults >= 0),
  -- After a fault, no scan reads the request before this time. The delay
  -- grows with the faults, to ten minutes at most.
  retry_after     timestamptz,
  CONSTRAINT document_rerun_status_check
    CHECK (status IN ('waiting', 'started', 'dropped', 'failed')),
  CONSTRAINT document_rerun_reason_check
    CHECK (reason IN ('approved', 'closed', 'snoozed', 'answered', 'another_attempt',
                      'newer_turn', 'reply_changed', 'ended', 'no_turn', 'copy_could_send')),
  -- Each outcome carries its own fields and no other's.
  CONSTRAINT document_rerun_outcome_check CHECK (
    CASE status
      WHEN 'waiting' THEN reason IS NULL AND ended_at IS NULL AND started_attempt IS NULL
      WHEN 'started' THEN reason IS NULL AND ended_at IS NOT NULL AND started_attempt IS NOT NULL
      WHEN 'dropped' THEN reason IS NOT NULL AND ended_at IS NOT NULL AND started_attempt IS NULL
      WHEN 'failed'  THEN reason IS NULL AND ended_at IS NOT NULL AND started_attempt IS NULL
    END)
);

COMMENT ON TABLE document_rerun IS 'DEC-50, DEC-49: the new attempt a published document asks for, of the case it was written from. The consumer starts it once the document is embedded, and drops it when the case changed first.';
COMMENT ON COLUMN document_rerun.run_id IS 'The run the reviewer read when they published: the attempt this request would replace.';
COMMENT ON COLUMN document_rerun.attempt IS 'That run''s attempt. The request starts only while the turn is still on it.';
COMMENT ON COLUMN document_rerun.reason IS 'Why a dropped request never started: approved, closed, snoozed, answered (a record closes the turn), another_attempt, newer_turn (the customer wrote again), reply_changed (a person saved or rewrote the reply since, DEC-46), ended, no_turn, copy_could_send (a helpdesk copy a person could send, DEC-49).';
COMMENT ON COLUMN document_rerun.started_attempt IS 'The attempt the turn was raised to. The consumer''s send-back scan walks it, reading this row as the request.';

-- The consumer scan reads the waiting requests on every pass.
CREATE INDEX IF NOT EXISTS document_rerun_waiting_idx
  ON document_rerun (requested_at) WHERE status = 'waiting';
-- The send-back scan finds a started request by its turn.
CREATE INDEX IF NOT EXISTS document_rerun_started_idx
  ON document_rerun (conversation_id, turn_number) WHERE status = 'started';
-- The case page reads the requests published from its run.
CREATE INDEX IF NOT EXISTS document_rerun_run_idx ON document_rerun (run_id);
