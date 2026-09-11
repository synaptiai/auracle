// Integration suite for approval-edit distance recording (section 4.10).
//
// Each test seeds a run through the real write path (fencedInsert,
// section 4.2), records an approval against it, and reads the recorded
// distance back from the ledger. The three cases pin the bands the daily
// sample depends on: unchanged, edited, fully rewritten.
import { randomUUID } from 'node:crypto';

import { truncateLedger } from '../test-support/schema.js';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { dbUrl } from '../db/config.js';
import { fencedInsert, type FencedRunInput } from '../ledger/insert.js';
import { recordApprovalEditDistance } from './measure.js';

const pool = new Pool({ connectionString: dbUrl(), max: 10 });

// src/test-support/db-global-setup.ts guarantees a reachable database before
// the workers fork: it starts a container, or probes an explicit
// DATABASE_URL and fails the run. A failure here is therefore a fault, and
// a suite that skipped itself instead would report success while proving
// nothing.
await pool.query('SELECT 1');


async function seedRun(): Promise<string> {
  const run: FencedRunInput = {
    runId: randomUUID(),
    ticketId: 'T-' + randomUUID().slice(0, 8),
    partition: 0,
    epoch: 1n,
    state: 'awaiting_approval',
    promptVer: 'p1',
    modelVer: 'm1',
    deadlineAt: new Date(Date.now() + 60_000),
  };
  const result = await fencedInsert(pool, run, null);
  expect(result).toEqual({ outcome: 'accepted' });
  return run.runId;
}

async function recordedDistance(runId: string): Promise<number | null> {
  const rows = await pool.query(
    'SELECT approval_edit_distance FROM run WHERE run_id = $1',
    [runId],
  );
  return rows.rows[0]!.approval_edit_distance as number | null;
}

describe('section 4.10 approval-edit distance recording', () => {
  beforeEach(async () => {
    await truncateLedger(pool);
  });

  afterEach(async () => {
    await truncateLedger(pool);
  });

  it('records exactly 0 when the person sent the draft unchanged', async () => {
    const runId = await seedRun();
    const body = 'Please reset your password from the login page.';

    const result = await recordApprovalEditDistance(pool, {
      runId,
      parkedBody: body,
      finalBody: body,
    });

    expect(result.approvalEditDistance).toBe(0);
    expect(await recordedDistance(runId)).toBe(0);
  });

  it('records a value strictly between 0 and 1 for an edited draft', async () => {
    const runId = await seedRun();

    const result = await recordApprovalEditDistance(pool, {
      runId,
      parkedBody: 'Please reset your password from the login page.',
      finalBody: 'Please reset your password from the login page within one hour.',
    });

    expect(result.approvalEditDistance).toBeGreaterThan(0);
    expect(result.approvalEditDistance).toBeLessThan(1);
    expect(await recordedDistance(runId)).toBe(result.approvalEditDistance);
  });

  it('records exactly 1 for a fully rewritten draft', async () => {
    const runId = await seedRun();

    const result = await recordApprovalEditDistance(pool, {
      runId,
      parkedBody: 'Your refund is on the way to your bank account today.',
      finalBody: 'We cannot help with billing questions at all here.',
    });

    expect(result.approvalEditDistance).toBe(1);
    expect(await recordedDistance(runId)).toBe(1);
  });

  it('leaves unapproved runs at null so they stay out of the daily sample', async () => {
    const runId = await seedRun();
    expect(await recordedDistance(runId)).toBeNull();
  });

  it('refuses an approval for a run the ledger does not hold', async () => {
    await expect(
      recordApprovalEditDistance(pool, {
        runId: randomUUID(),
        parkedBody: 'a draft',
        finalBody: 'a draft',
      }),
    ).rejects.toThrow(/holds no run/);
  });

  afterAll(async () => {
    await pool.end();
  });
});
