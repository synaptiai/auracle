-- The routing screen shows, for each product and intent, what the running
-- system last recorded at the gate (DEC-41, DEC-47). Neither the gate's journal
-- row nor the journal records the product, the intent or a time, so a read of
-- the journal visits every gate row ever written. On a ledger of a few weeks
-- that read ran past its two-second budget, and the screen then read nothing on
-- every load.
--
-- So the gate step keeps one row per product and intent here, written in the
-- fenced transition that moves the run to 'gated' (DEC-28). A consumer the
-- fence refused writes nothing. The read then costs one row for each product
-- and intent, whatever the history.
--
-- The backfill fills the table from the journal once. For each product and
-- intent it keeps the newest gate row whose shape the gate writes, and
-- counts the newer rows it could not read. It keys an intent as the
-- classifier wrote it, already trimmed and lower-cased in Node, which is the
-- key the gate writes: lowering it again here would differ from Node for
-- some letters and some whitespace. The reader merges any other spelling.
-- It reads only runs whose move to gated committed. The gate journals before
-- that move, so a run the fence refused left a gate row and no record.
-- Its shape test is stricter than the reader's: every fitted value must be
-- a threshold, not only this intent's. The lower bound sits well inside what
-- a double holds, since the reader parses the number as one.
--
-- The backfill reads the whole journal once, under the timeouts below. An
-- adopter whose ledger is too large for them runs the file by hand, in one
-- transaction. The file's own SET LOCAL lines would override a longer limit,
-- so they are left out:
--   BEGIN;
--   SET LOCAL lock_timeout = '5s';
--   SET LOCAL statement_timeout = '30min';
--   -- every statement of this file below its two SET LOCAL lines
--   INSERT INTO schema_version (version, filename) VALUES (37, '037_gate_latest.sql');
--   COMMIT;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '300s';

CREATE TABLE IF NOT EXISTS gate_latest (
  product        text,
  intent_id      text        NOT NULL,
  run_id         uuid        NOT NULL,
  run_created_at timestamptz NOT NULL,
  gate_at        timestamptz,
  reason         jsonb,
  thresholds     jsonb,
  unreadable     integer     NOT NULL DEFAULT 0 CHECK (unreadable >= 0),
  CONSTRAINT gate_latest_pair UNIQUE NULLS NOT DISTINCT (product, intent_id),
  CONSTRAINT gate_latest_record CHECK (gate_at IS NOT NULL OR (reason IS NULL AND thresholds IS NULL))
);

COMMENT ON TABLE gate_latest IS 'DEC-41, DEC-47: for each product and intent, the latest gate record, written by the gate step in its fenced transition to gated. The routing screen reads it.';
COMMENT ON COLUMN gate_latest.product IS 'The run''s product, or null for a channel that maps to none. One row per product and intent, null included.';
COMMENT ON COLUMN gate_latest.intent_id IS 'The classified intent. The gate keys it as the policy engine does; the backfill keeps the classifier''s own spelling, and the reader merges spellings.';
COMMENT ON COLUMN gate_latest.run_id IS 'The newest run of this product and intent whose gate row was considered. A later gate replaces the row only when its run is newer, by created_at and then run_id.';
COMMENT ON COLUMN gate_latest.run_created_at IS 'When that run started. The order a later gate is compared in.';
COMMENT ON COLUMN gate_latest.gate_at IS 'When the run of the latest readable gate row started. Null when no gate row of this product and intent could be read.';
COMMENT ON COLUMN gate_latest.reason IS 'The rule that decided that run, as its gate row records it.';
COMMENT ON COLUMN gate_latest.thresholds IS 'The thresholds in force for that run, as its gate row records them.';
COMMENT ON COLUMN gate_latest.unreadable IS 'Gate rows newer than the readable one whose shape the gate does not write, or all of them when none was readable. Only the backfill counts them: the gate writes a readable row.';

WITH gates AS (
  SELECT r.product, cls.result ->> 'intentId' AS intent_id, r.run_id, r.created_at,
         gate.result -> 'reason' AS reason, gate.result -> 'thresholds' AS thresholds,
         COALESCE(
           jsonb_typeof(gate.result -> 'reason') = 'string'
           AND gate.result ->> 'reason' IN ('no_idempotency', 'no_read_back', 'customer_visible', 'irreversible',
                                            'high_risk', 'agreement', 'groundedness_block',
                                            'groundedness_review', 'auto')
           AND jsonb_typeof(gate.result -> 'thresholds') = 'object'
           AND CASE WHEN jsonb_typeof(gate.result -> 'thresholds' -> 'agreement') = 'number'
                    THEN (gate.result -> 'thresholds' -> 'agreement')::numeric >= 1e-300
                         AND (gate.result -> 'thresholds' -> 'agreement')::numeric <= 1
                    ELSE false END
           AND (jsonb_typeof(gate.result -> 'thresholds' -> 'perIntent') IS NULL
                OR jsonb_typeof(gate.result -> 'thresholds' -> 'perIntent') = 'null'
                OR (jsonb_typeof(gate.result -> 'thresholds' -> 'perIntent') = 'object'
                    AND NOT EXISTS (
                      SELECT 1 FROM jsonb_each(gate.result -> 'thresholds' -> 'perIntent') f
                       WHERE NOT CASE WHEN jsonb_typeof(f.value) = 'number'
                                      THEN f.value::numeric >= 1e-300 AND f.value::numeric <= 1
                                      ELSE false END))),
           false) AS readable
    FROM step_journal gate
    JOIN run r ON r.run_id = gate.run_id
    JOIN step_journal cls ON cls.run_id = gate.run_id AND cls.step_id = 'classify' AND cls.status = 'done'
   WHERE gate.step_id = 'gate' AND gate.status = 'done'
     AND cls.result ->> 'intentId' IS NOT NULL
     AND r.state NOT IN ('received', 'classified', 'retrieved', 'composed')
), ranked AS (
  SELECT g.*,
         row_number() OVER newest AS nth,
         -- A sum, not count(*) FILTER: Postgres 16 fails to plan the filtered
         -- count under a filter on its result.
         COALESCE(sum(g.readable::int) OVER (newest ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)
           AS readable_before
    FROM gates g
  WINDOW newest AS (PARTITION BY g.product, g.intent_id ORDER BY g.created_at DESC, g.run_id DESC)
), considered AS (
  -- Each pair's rows up to and including its first readable one.
  SELECT * FROM ranked WHERE readable_before = 0
)
INSERT INTO gate_latest (product, intent_id, run_id, run_created_at, gate_at, reason, thresholds, unreadable)
SELECT newest.product, newest.intent_id, newest.run_id, newest.created_at,
       found.created_at, found.reason, found.thresholds,
       (SELECT count(*) FROM considered c
         WHERE c.product IS NOT DISTINCT FROM newest.product AND c.intent_id = newest.intent_id
           AND NOT c.readable)
  FROM considered newest
  LEFT JOIN considered found
    ON found.product IS NOT DISTINCT FROM newest.product AND found.intent_id = newest.intent_id AND found.readable
 WHERE newest.nth = 1
-- A row a gate already wrote, or a hand run that stopped halfway left, stays
-- unless this record's run is newer. The gate's own rule in
-- src/routing/latest.ts also lets the same run replace its row; here the
-- same run never does, since a gate that wrote it read that run itself.
ON CONFLICT ON CONSTRAINT gate_latest_pair DO UPDATE
   SET run_id = EXCLUDED.run_id,
       run_created_at = EXCLUDED.run_created_at,
       gate_at = EXCLUDED.gate_at,
       reason = EXCLUDED.reason,
       thresholds = EXCLUDED.thresholds,
       unreadable = EXCLUDED.unreadable
 WHERE (EXCLUDED.run_created_at, EXCLUDED.run_id) > (gate_latest.run_created_at, gate_latest.run_id);
