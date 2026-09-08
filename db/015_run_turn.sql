-- A run names the turn it answered — docs/v1-architecture.md DEC-35, DEC-38.
--
-- `run` carries a conversation id since db/008. It carries no turn number, so
-- a turn joins to the run that answered it only through the `park` journal's
-- own `turnNumber`. An automatic run parks nothing, so its turn joins to
-- nothing at all, and a conversation surface reading the ledger would show a
-- turn the system answered with no sign that it did.
--
-- DEC-38 already derives the idempotency key from the turn plus the
-- conversation. The value is present at every run this applies to; it was
-- simply not stored where a reader could ask for it. This changes no key.
--
-- Forward-only, and safe to re-apply: the test suites re-apply every
-- migration between cases.

ALTER TABLE run ADD COLUMN IF NOT EXISTS turn_number integer;

COMMENT ON COLUMN run.turn_number IS 'DEC-35: the turn of the conversation this run answered. Null on a run with no turn, which is a V1-era run, a replay run and any run the coordinator received without one. A null here is not a turn one, and a reader joins on it rather than assuming it.';

-- Turn-level resolution: which run answered this turn.
CREATE INDEX IF NOT EXISTS run_turn_idx ON run (conversation_id, turn_number);
