-- Conversation state — docs/v1-architecture.md DEC-35.
--
-- A conversation is one customer problem, which may span more than one ticket
-- thread. It is a ledger entity: no component holds conversation state of its
-- own, so a restart loses nothing (DEC-04).
--
-- Two conventions carry over from db/001_ledger.sql and db/004_intake.sql:
-- every table carries comments, and no table declares a foreign key. The
-- writers enforce the joins, not the schema.
--
-- Forward-only, and safe to re-apply: the test suites re-apply every
-- migration between cases.

CREATE TABLE IF NOT EXISTS conversation (
  conversation_id uuid        PRIMARY KEY,
  primary_ticket_id text      NOT NULL,
  turn_counter    integer     NOT NULL DEFAULT 1,
  opened_at       timestamptz NOT NULL DEFAULT now(),
  state           text        NOT NULL DEFAULT 'open'
    CHECK (state IN ('open', 'resolved', 'abandoned'))
);

COMMENT ON TABLE conversation IS 'DEC-35: one customer problem across threads. All conversation state lives here, never in components.';
COMMENT ON COLUMN conversation.primary_ticket_id IS 'The thread that carried turn one. Immutable once set.';
COMMENT ON COLUMN conversation.turn_counter IS 'Next turn number. The intake transaction increments it under the row lock, which serializes turn numbering.';
COMMENT ON COLUMN conversation.state IS 'open while the customer may still write; resolved or abandoned once no further turn is expected.';

CREATE TABLE IF NOT EXISTS turn (
  conversation_id    uuid        NOT NULL,
  turn_number        integer     NOT NULL,
  ticket_id          text        NOT NULL,
  inbound_message_id text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, turn_number)
);

COMMENT ON TABLE turn IS 'One inbound message of one conversation. conversation.turn_counter assigns the number.';
COMMENT ON COLUMN turn.ticket_id IS 'The thread this turn arrived on. One conversation may span several.';
COMMENT ON COLUMN turn.inbound_message_id IS 'Source message identity, when the adapter supplies one. Null when it cannot.';

ALTER TABLE run ADD COLUMN IF NOT EXISTS conversation_id uuid;

COMMENT ON COLUMN run.conversation_id IS 'DEC-35: set for every V2 turn. Null on a V1-era run, so every existing query stays valid.';

-- Ticket-level resolution: which conversation does this ticket join.
CREATE INDEX IF NOT EXISTS turn_ticket_idx ON turn (ticket_id);
-- Message-level resolution: which turn does a References id hit.
CREATE INDEX IF NOT EXISTS turn_message_idx ON turn (inbound_message_id);
-- Runs of one conversation join on the conversation id.
CREATE INDEX IF NOT EXISTS run_conversation_idx ON run (conversation_id);
