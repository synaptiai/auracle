-- Who approved the reply — docs/v1-architecture.md DEC-42.
--
-- The ledger records that a person approved a customer reply (DEC-12). It
-- does not record which person. Reaching the console is the whole access
-- control, so an incident cannot separate the operator from anyone else who
-- reached the port.
--
-- The value is a claim, not an authentication. A caller supplies it, and
-- `approveRun` bounds what it will keep: too long, or carrying a control
-- character, names nobody. Only a trusted proxy may name an approver, because
-- anyone reaching a console can set a header and a forgeable audit trail is
-- worse than none. No caller names one yet, so every approval today records
-- 'unattributed'.
--
-- Written inside the approval transaction, so it commits with the state move
-- or not at all.
--
-- Retention: this stores an operator's own identifier for the life of the
-- row. The adopter is the data controller (DEC-17, DEC-19), and this
-- repository ships no retention or purge job.
--
-- Forward-only, and safe to re-apply: the test suites re-apply every
-- migration between cases.

ALTER TABLE run ADD COLUMN IF NOT EXISTS approved_by text;

COMMENT ON COLUMN run.approved_by IS 'DEC-42: the approver a caller named, or ''unattributed'' when none was named or the value was not one the approval would keep. Unverified by construction: it is what a header claimed, never an authenticated identity. Null means no approval wrote this row: a run no approval reached, a run approved before this migration, or an approval that lost the idempotency-key race and committed superseded.';

-- No backfill. A run approved before this migration has no recorded
-- approver, and null says exactly that. Filling it with 'unattributed' would
-- claim the approval ran under this rule, which it did not.
