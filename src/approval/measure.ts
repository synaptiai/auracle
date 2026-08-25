/**
 * Approval-edit distance recording (section 4.10, Phase 2 online
 * measurement).
 *
 * This is the capture half of the measurement. The approve entrypoint
 * (`approve.ts`) owns the approval transaction; this module records only
 * the measurement, so the two compose without sharing a write path:
 *
 *   const parked = ...; // draft body exactly as parked
 *   const final = ...;  // final text the person sent
 *   await recordApprovalEditDistance(pool, { runId, parkedBody: parked, finalBody: final });
 *
 * The value lands in `run.approval_edit_distance` (db/
 * 003_approval_edit_distance.sql), so a daily sample can be computed from
 * ledger data alone. It stays null until approval, which keeps unapproved
 * runs out of the sample.
 */
import type { Pool, PoolClient } from 'pg';

import { approvalEditDistance } from './edit_distance.js';

export interface ApprovalEditMeasurement {
  /** The run whose gated reply the person approved. */
  runId: string;
  /** The draft body exactly as the approval bridge parked it. */
  parkedBody: string;
  /** The final text the person sent. */
  finalBody: string;
}

/**
 * Any handle that can run one query: a `Pool` for standalone recording, or
 * the `PoolClient` of an open transaction when the caller needs the
 * measurement to commit atomically with its own writes (the approve
 * entrypoint does exactly that).
 */
export type Queryable = Pick<Pool, 'query'> | PoolClient;

/**
 * Measure one approval and record it on the run (section 4.10).
 *
 * Pass a `PoolClient` with an open transaction to make this write commit or
 * roll back together with the caller's other writes.
 *
 * Throws when the ledger holds no such run: an approval without a run is
 * a caller bug, not a measurable event.
 */
export async function recordApprovalEditDistance(
  pool: Queryable,
  input: ApprovalEditMeasurement,
): Promise<{ readonly approvalEditDistance: number }> {
  const distance = approvalEditDistance(input.parkedBody, input.finalBody);
  const updated = await pool.query(
    'UPDATE run SET approval_edit_distance = $2 WHERE run_id = $1',
    [input.runId, distance],
  );
  if ((updated.rowCount ?? 0) === 0) {
    throw new Error(`approval refused: the ledger holds no run '${input.runId}'`);
  }
  return { approvalEditDistance: distance };
}
