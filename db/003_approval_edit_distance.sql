-- Approval-edit distance (docs/v1-architecture.md section 4.10).
-- Phase 2 online measure: how much a person changed a parked draft before
-- sending it. The approval entrypoint records the value on the run row, so
-- a daily sample can be computed from ledger data alone.
--
-- Plain SQL applied by src/ledger/apply.ts. No migration framework
-- (V2 open item 7). IF NOT EXISTS keeps this file idempotent.

ALTER TABLE run ADD COLUMN IF NOT EXISTS approval_edit_distance double precision;

COMMENT ON COLUMN run.approval_edit_distance IS 'Section 4.10: how much a person changed the parked draft before sending it. Normalized token level Levenshtein distance in [0, 1]. Null until approval.';
