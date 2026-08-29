-- Model cost in micro-dollars — docs/v1-architecture.md DEC-25, section 4.3.
--
-- The ledger recorded cost as integer cents. A model call costs a fraction of
-- a cent, so `Math.round(usd * 100)` returned 0 for almost every real call.
-- The stored cost was 0, and the DEC-25 cost limit compared a sum of zeros
-- against its ceiling, so the limit could not fire on spend.
--
-- One micro-dollar is one millionth of a US dollar, so a call costing
-- 0.000841 USD now records 841 instead of 0. Integer arithmetic throughout:
-- the values are summed and compared against a limit, and JSON carries no
-- decimal type, so a scaled integer stays exact end to end.
--
-- The column stays `integer`. Its range reaches 2 147 USD for one run, and
-- DEC-25 caps a run far below that, so the width is ample. `bigint` would
-- read back as a string in node-postgres, and the ledger cannot switch that
-- parser globally because the fencing epoch depends on the string form.
--
-- Forward-only. Guarded so that re-applying the file is a no-op, which the
-- test suites rely on when they re-apply the schema between cases.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'run' AND column_name = 'cost_cents'
  ) THEN
    ALTER TABLE run RENAME COLUMN cost_cents TO cost_micros;
    -- 1 cent is 10 000 micro-dollars.
    UPDATE run SET cost_micros = cost_micros * 10000;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'step_journal' AND column_name = 'cost_cents'
  ) THEN
    ALTER TABLE step_journal RENAME COLUMN cost_cents TO cost_micros;
    UPDATE step_journal SET cost_micros = cost_micros * 10000;
  END IF;
END $$;

-- run carried this check; step_journal never did.
ALTER TABLE run DROP CONSTRAINT IF EXISTS run_cost_cents_check;
ALTER TABLE run DROP CONSTRAINT IF EXISTS run_cost_micros_check;
ALTER TABLE run ADD CONSTRAINT run_cost_micros_check CHECK (cost_micros >= 0);

ALTER TABLE step_journal DROP CONSTRAINT IF EXISTS step_journal_cost_micros_check;
ALTER TABLE step_journal ADD CONSTRAINT step_journal_cost_micros_check CHECK (cost_micros >= 0);

COMMENT ON COLUMN run.cost_micros IS 'DEC-25: total model cost for the run, in micro-dollars (millionths of a US dollar). Integer, so the sum stays exact.';
COMMENT ON COLUMN step_journal.cost_micros IS 'DEC-25: cost accumulated when this step was recorded, in micro-dollars.';
