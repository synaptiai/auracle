-- Ledger constraints the v1 schema left implicit — docs/v1-architecture.md
-- sections 4.2 and 4.3. No decision changes here; each statement enforces a
-- rule the code already relies on.
--
-- Forward-only, applied by src/ledger/migrate.ts, which records the version
-- in schema_version. Every statement is idempotent, so re-applying is a
-- no-op.

-- 1. claimPartition (src/coordinator/consumer.ts) bumps a ticket's fence with
--    a correlated subquery over run (ticket_id, partition). The only run
--    index is (partition, state), which cannot serve that lookup, so the
--    DEC-28 rebalance degraded to one scan per ticket as the ledger grew.
CREATE INDEX IF NOT EXISTS run_ticket_idx ON run (ticket_id);

-- 2. The escalations query reads run by state (src/escalations/query.ts).
CREATE INDEX IF NOT EXISTS run_state_idx ON run (state);

-- 3. DEC-26 pins a prompt version and a model version on every step. The run
--    table enforces this; step_journal did not, so a step could record no
--    pin and the ledger could not say which prompt produced it.
--
--    `result` stays nullable on purpose. A step is journaled before it acts
--    (section 4.2), so between the start and the outcome there is genuinely
--    no result to record.
UPDATE step_journal SET status = 'unknown' WHERE status IS NULL;
UPDATE step_journal SET prompt_ver = 'unrecorded' WHERE prompt_ver IS NULL;
UPDATE step_journal SET model_ver = 'unrecorded' WHERE model_ver IS NULL;

ALTER TABLE step_journal ALTER COLUMN status SET NOT NULL;
ALTER TABLE step_journal ALTER COLUMN prompt_ver SET NOT NULL;
ALTER TABLE step_journal ALTER COLUMN model_ver SET NOT NULL;

-- The cost column is named by whichever migration has run. 007 renames it to
-- cost_micros, and re-applying this file after that must stay a no-op.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'step_journal' AND column_name = 'cost_cents'
  ) THEN
    UPDATE step_journal SET cost_cents = 0 WHERE cost_cents IS NULL;
    ALTER TABLE step_journal ALTER COLUMN cost_cents SET NOT NULL;
  ELSE
    UPDATE step_journal SET cost_micros = 0 WHERE cost_micros IS NULL;
    ALTER TABLE step_journal ALTER COLUMN cost_micros SET NOT NULL;
  END IF;
END $$;

COMMENT ON COLUMN step_journal.result IS 'Outcome of the step. Null between the write-before-act journal entry and the outcome (section 4.2).';

-- 4. outbox.delivery has a CHECK; status did not, though the code writes a
--    closed set. A value outside it is invisible to the relay scan, which
--    reads status 'pending', and to the escalations query, which reads
--    'delivery_unknown'. The record would strand with nobody looking at it.
ALTER TABLE outbox DROP CONSTRAINT IF EXISTS outbox_status_check;
ALTER TABLE outbox ADD CONSTRAINT outbox_status_check
  CHECK (status IN ('pending', 'sent', 'fenced', 'delivery_unknown', 'malformed'));

COMMENT ON COLUMN outbox.status IS 'Relay scan state, one of pending, sent, fenced, delivery_unknown, malformed. The relay reads pending; the escalations query reads delivery_unknown.';
