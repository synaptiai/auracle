-- Intake table — the minimal queue-source seam for the partition consumer
-- (section 4.3, DEC-27). The architecture doc says "read the next ticket from
-- its partition" without naming a source; this table is that source and is an
-- implementation detail, not a decision.
-- Plain SQL applied by src/ledger/migrate.ts, which records each version in schema_version (V2 open item 6).
-- Every statement uses IF NOT EXISTS, so re-applying against an applied ledger
-- is a no-op.

CREATE TABLE IF NOT EXISTS intake (
  ticket_id   text        PRIMARY KEY,
  partition   integer     NOT NULL,
  ticket_text text        NOT NULL,
  enqueued_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE intake IS 'Queue-source seam for the coordinator consumer (section 4.3). One consumer polls each partition (DEC-27); the fencing epoch covers rebalance overlap (DEC-28).';
COMMENT ON COLUMN intake.partition IS 'DEC-36: hash(conversation_id) % N, and the ticket id when a run has no conversation. Precomputed at enqueue so a consumer can poll its partitions with an index scan.';
COMMENT ON COLUMN intake.ticket_text IS 'The ticket body handed to coordinateTicket as ticketText.';
COMMENT ON COLUMN intake.enqueued_at IS 'Arrival order within a partition. The poll reads oldest first; head-of-line delay inside a partition is not corrected in V1 (V2 open item 7).';

-- Consumer scans: read the next tickets from owned partitions, oldest first.
CREATE INDEX IF NOT EXISTS intake_partition_idx ON intake (partition, enqueued_at);
