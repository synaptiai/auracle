-- Ledger schema v1 — docs/v1-architecture.md section 4.2.
-- Plain SQL applied by src/ledger/apply.ts. No migration framework (V2 open item 7).
-- Every statement uses IF NOT EXISTS, so re-applying this file against an
-- applied ledger is a no-op.

CREATE TABLE IF NOT EXISTS run (
  run_id       uuid        PRIMARY KEY,
  ticket_id    text        NOT NULL,
  partition    integer     NOT NULL,
  epoch        bigint      NOT NULL,
  state        text        NOT NULL,
  prompt_ver   text        NOT NULL,
  model_ver    text        NOT NULL,
  cost_cents   integer     NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),
  steps_used   integer     NOT NULL DEFAULT 0 CHECK (steps_used >= 0),
  deadline_at  timestamptz NOT NULL
);

COMMENT ON TABLE run IS 'One row per run. The ledger holds all state; no component keeps state outside the ledger (DEC-04).';
COMMENT ON COLUMN run.partition IS 'DEC-27: hash(ticket_id) % N. One consumer owns each partition, so two runs on one ticket cannot occur together.';
COMMENT ON COLUMN run.epoch IS 'DEC-28: fencing token. The ledger refuses each write whose epoch is lower than the highest accepted epoch.';
COMMENT ON COLUMN run.prompt_ver IS 'DEC-26: pinned prompt version for this run.';
COMMENT ON COLUMN run.model_ver IS 'DEC-26: pinned model version for this run.';

CREATE TABLE IF NOT EXISTS ticket_epoch (
  ticket_id  text   PRIMARY KEY,
  epoch      bigint NOT NULL
);

COMMENT ON TABLE ticket_epoch IS 'The highest epoch that was accepted per ticket (DEC-28). The ledger does the refusal and the write in one operation.';
COMMENT ON COLUMN ticket_epoch.epoch IS 'DEC-28: highest fencing epoch accepted for this ticket; writes below it are refused.';

CREATE TABLE IF NOT EXISTS step_journal (
  run_id      uuid,
  step_id     text,
  status      text,
  result      jsonb,
  prompt_ver  text,
  model_ver   text,
  cost_cents  integer,
  PRIMARY KEY (run_id, step_id)
);

COMMENT ON TABLE step_journal IS 'Write-before-act journal: each step is journaled before it acts (section 4.2, DEC-04).';
COMMENT ON COLUMN step_journal.prompt_ver IS 'DEC-26: pinned prompt version used for this step.';
COMMENT ON COLUMN step_journal.model_ver IS 'DEC-26: pinned model version used for this step.';

CREATE TABLE IF NOT EXISTS outbox (
  run_id       uuid,
  step_id      text,
  idem_key     text   NOT NULL,
  epoch        bigint NOT NULL,
  action_class text   NOT NULL,
  delivery     text   NOT NULL CHECK (delivery IN ('at_least_once', 'at_most_once')),
  payload      jsonb  NOT NULL,
  status       text   NOT NULL DEFAULT 'pending',
  PRIMARY KEY (run_id, step_id),
  UNIQUE (idem_key)
);

COMMENT ON TABLE outbox IS 'Transactional outbox: committed in the same transaction as the run state change (DEC-04). An insert of zero rows is a distinct result, not a success.';
COMMENT ON COLUMN outbox.idem_key IS 'DEC-24: semantic idempotency key derived from action semantics, never from run identity or timestamps. UNIQUE enforces this at the schema level.';
COMMENT ON COLUMN outbox.epoch IS 'DEC-28: fencing epoch checked again at send time by the relay.';
COMMENT ON COLUMN outbox.action_class IS 'DEC-29: selects the delivery rule for this action.';
COMMENT ON COLUMN outbox.delivery IS 'DEC-29: delivery rule declared by the action class: ''at_least_once'' or ''at_most_once''.';
COMMENT ON COLUMN outbox.status IS 'Relay scan state; the relay reads records with status ''pending''.';

-- Partition reads: the coordinator reads the next ticket from its partition.
CREATE INDEX IF NOT EXISTS run_partition_state_idx ON run (partition, state);

-- Outbox pending-status scans: the relay reads records with status 'pending'.
CREATE INDEX IF NOT EXISTS outbox_status_idx ON outbox (status);
