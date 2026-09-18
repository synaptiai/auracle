-- 018 — the reviewer roster and the approver's provenance (DEC-45).
--
-- DEC-45: "The console serves nothing to a request with no roster identity,
-- and a trusted proxy authenticates that identity. The ledger records where
-- each approver's name came from."
--
-- Two additions, one decision. `reviewer` is the roster a console request is
-- checked against. `run.approved_by_source` says how the name in
-- `run.approved_by` was established: DEC-42's single column could not tell a
-- claim a header carried from a name the console verified against the
-- roster, and DEC-45 exists because those are different facts.
--
-- Forward-only, and safe to re-apply: the test suites re-apply every
-- migration between cases.

CREATE TABLE IF NOT EXISTS reviewer (
  identity       text PRIMARY KEY,
  active         boolean NOT NULL DEFAULT true,
  added_at       timestamptz NOT NULL DEFAULT now(),
  deactivated_at timestamptz
);

COMMENT ON TABLE reviewer IS 'DEC-45: the roster a console request is checked against. One row per identity a trusted proxy authenticates.';
COMMENT ON COLUMN reviewer.identity IS 'DEC-45: the identity the proxy asserts, held exactly as the console compares it. One identity, one row.';
COMMENT ON COLUMN reviewer.active IS 'DEC-45: false once a maintainer deactivates this reviewer. A deactivated identity is refused exactly like an absent one.';
COMMENT ON COLUMN reviewer.deactivated_at IS 'When the reviewer was deactivated. Null while the reviewer is active.';

ALTER TABLE run ADD COLUMN IF NOT EXISTS approved_by_source text;

-- Rows written before this migration recorded a claim and nothing else, so
-- every existing name reads as one. 'unattributed' is the recorded absence
-- of a name, which reads as `none`.
UPDATE run SET approved_by_source = CASE
    WHEN approved_by = 'unattributed' THEN 'none'
    ELSE 'header'
  END
 WHERE approved_by IS NOT NULL AND approved_by_source IS NULL;

-- The name and its source travel together, and each says the same thing as
-- the other. A name beside a null source, or the reverse, is a row no reader
-- can classify. So is a name beside `none`, and `unattributed` beside
-- `roster` or `header`: `none` means nobody was named, and `unattributed` is
-- how that reads in the name column. Every writer this repository ships
-- satisfies the pairing, and `approveRun` writes it from one expression.
--
-- A null pair makes the last comparison null, and Postgres accepts a CHECK
-- it cannot decide. That is the intended reading here: no approval reached
-- the run, so there is no name and no source to agree about.
ALTER TABLE run DROP CONSTRAINT IF EXISTS approved_by_source_check;
ALTER TABLE run ADD CONSTRAINT approved_by_source_check CHECK (
  (approved_by IS NULL) = (approved_by_source IS NULL)
  AND (approved_by_source IS NULL OR approved_by_source IN ('roster', 'header', 'none'))
  -- Both directions in one comparison: `unattributed` is the name column's
  -- way of saying nobody was named, so it holds exactly when the source says
  -- `none`. `anna@example.test` beside `none`, and `unattributed` beside
  -- `roster`, are both refused here.
  AND (approved_by = 'unattributed') = (approved_by_source = 'none')
);

-- DEC-42's comment on the name said "never an authenticated identity". That
-- is true off the console and false on it, and the difference is what this
-- migration records beside the name.
COMMENT ON COLUMN run.approved_by IS 'DEC-42 with DEC-45: the approver''s name. A caller off the console supplies a claim; the console supplies an identity it checked against the roster. approved_by_source says which. `unattributed` means nobody was named; null means no approval reached the run.';

COMMENT ON COLUMN run.approved_by_source IS 'DEC-45: how the name in approved_by was established. roster — a console checked it against the roster; header — a caller passed a trusted proxy''s claim (DEC-42); none — nobody was named. Null exactly when approved_by is null.';
