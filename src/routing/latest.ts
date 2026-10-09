// The gate's latest record for each product and intent.
//
// The routing screen shows what the running system last did for each product
// and intent. The journal cannot answer that cheaply: a gate row records
// neither the product nor the intent, and the journal holds no time. So the
// gate keeps one row per product and intent in `gate_latest` (db/037), and
// the screen reads those rows alone.
//
// This is the one write path to that table. The gate step calls it inside
// the fenced transition to 'gated', so a consumer the fence refused writes
// nothing (DEC-28). The seeded history calls it inside the transaction that
// writes the run's journal.
import type { PoolClient } from 'pg';

import { errorMessage } from '../errors.js';
import type { JournalDb } from '../ledger/journal-write.js';
import { logLine } from '../log/line.js';
import { normalizeIntentId, type GateThresholds, type PolicyReason } from '../policy/policy.js';

/**
 * How long the gate waits for the record's row. Every gate of one product
 * and intent writes the same row, from every partition. A session that holds
 * it must not hold a customer's run at the gate.
 */
export const GATE_LATEST_LOCK_TIMEOUT = '500ms';

export interface GateLatestInput {
  readonly runId: string;
  /** The classified intent, keyed as the policy engine keys it. */
  readonly intentId: string;
  /** The rule that decided the run, as its gate row records it. */
  readonly reason: PolicyReason;
  /** The thresholds in force for the run, as its gate row records them. */
  readonly thresholds: GateThresholds;
}

/**
 * Records a run's gate as the latest for its product and intent, unless a
 * newer run already holds that place.
 *
 * Newer is by the run's start, then its id, the order the routing screen has
 * always read runs in. The same run replaces its own row, so a gate that runs
 * again after a crash records its last verdict. The product and the start are
 * read from the run row, so a caller cannot record them apart from the run.
 * A run the ledger does not hold records nothing.
 */
export async function recordGateLatest(db: JournalDb, input: GateLatestInput): Promise<void> {
  await db.query(
    `INSERT INTO gate_latest (product, intent_id, run_id, run_created_at, gate_at, reason, thresholds, unreadable)
     SELECT r.product, $2, r.run_id, r.created_at, r.created_at, to_jsonb($3::text), $4::jsonb, 0
       FROM run r
      WHERE r.run_id = $1
     ON CONFLICT ON CONSTRAINT gate_latest_pair DO UPDATE
        SET run_id = EXCLUDED.run_id,
            run_created_at = EXCLUDED.run_created_at,
            gate_at = EXCLUDED.gate_at,
            reason = EXCLUDED.reason,
            thresholds = EXCLUDED.thresholds,
            unreadable = 0
      WHERE (EXCLUDED.run_created_at, EXCLUDED.run_id) >= (gate_latest.run_created_at, gate_latest.run_id)`,
    [input.runId, normalizeIntentId(input.intentId), input.reason, JSON.stringify(input.thresholds)],
  );
}

/**
 * `recordGateLatest` for the gate step, inside its fenced transition.
 *
 * The record serves one screen, and the run it describes is a customer's.
 * So a write that cannot finish (a lock held past the timeout, a table not
 * yet migrated, a privilege) rolls back to its savepoint, logs
 * `gate_latest_skipped`, and lets the transition commit. The record then
 * catches up at the next gate of its product and intent. The lock timeout is
 * set inside the savepoint, and the transition commits straight after.
 */
export async function recordGateLatestOrSkip(client: PoolClient, input: GateLatestInput): Promise<void> {
  // The transaction's own limit, restored before the savepoint is released:
  // SET LOCAL outlives a RELEASE, and only ROLLBACK TO undoes it.
  const before = (await client.query<{ lock_timeout: string }>('SHOW lock_timeout')).rows[0]!.lock_timeout;
  await client.query('SAVEPOINT gate_latest');
  try {
    await client.query(`SET LOCAL lock_timeout = '${GATE_LATEST_LOCK_TIMEOUT}'`);
    await recordGateLatest(client, input);
    await client.query("SELECT set_config('lock_timeout', $1, true)", [before]);
    await client.query('RELEASE SAVEPOINT gate_latest');
  } catch (error) {
    // A rollback that fails too leaves the transaction unusable. The skip is
    // logged with both reasons, and the write's own failure stands.
    const rollbackError = await client.query('ROLLBACK TO SAVEPOINT gate_latest')
      .then(() => null, (fault: unknown) => fault);
    console.error(logLine({
      event: 'gate_latest_skipped',
      at: new Date().toISOString(),
      runId: input.runId,
      intentId: input.intentId,
      // The code tells a wait (55P03) from a fault that repeats at every gate.
      code: (error as { code?: unknown }).code ?? null,
      error: errorMessage(error),
      ...(rollbackError === null ? {} : { rollbackError: errorMessage(rollbackError) }),
    }));
    if (rollbackError !== null) throw error;
  }
}
