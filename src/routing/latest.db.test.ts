// The gate's latest record per product and intent (issue #112).
//
// The gate step writes one row per product and intent, and the routing screen
// reads only those rows. A later gate replaces the row only when its run is
// newer; the same run gated again replaces its own row. Every expected value
// below follows from that rule and from the run each case writes.
import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { enqueueTicket } from '../coordinator/intake.js';
import { dbUrl } from '../db/config.js';
import { fencedInsert } from '../ledger/insert.js';
import { truncateLedger } from '../test-support/schema.js';
import { recordGateLatest, recordGateLatestOrSkip } from './latest.js';

const pool = new Pool({ connectionString: dbUrl() });
await pool.query('SELECT 1');

const SEED = { agreement: 0.6, groundednessBlock: 0.7, groundednessReview: 0.8 };
const at = (minute: number): Date => new Date(Date.UTC(2026, 8, 14, 12, minute));
let epoch = 1n;

async function runOf(product: string | null, createdAt: Date, runId = randomUUID()): Promise<string> {
  const ticketId = 'T-' + randomUUID().slice(0, 8);
  const turn = await enqueueTicket(pool, { ticketId, messageId: randomUUID(), ticketText: 'a synthetic question' }, 4);
  epoch += 1n;
  expect(await fencedInsert(pool, {
    runId, ticketId, partition: 0, epoch, state: 'gated', promptVer: 'p1', modelVer: 'm1',
    conversationId: turn.conversationId, turnNumber: turn.turnNumber, deadlineAt: new Date(Date.now() + 60_000),
  }, null)).toEqual({ outcome: 'accepted' });
  await pool.query('UPDATE run SET product = $2, created_at = $3 WHERE run_id = $1', [runId, product, createdAt]);
  return runId;
}

async function rows() {
  return (await pool.query<{
    product: string | null; intent_id: string; run_id: string; gate_at: Date | null; reason: unknown; unreadable: number;
  }>('SELECT product, intent_id, run_id, gate_at, reason, unreadable FROM gate_latest ORDER BY product NULLS LAST, intent_id')).rows;
}

describe('the gate\'s latest record', () => {
  beforeEach(async () => {
    await truncateLedger(pool);
  });
  afterAll(async () => {
    await pool.end();
  });

  it('keeps the newest run of each product and intent', async () => {
    const newer = await runOf('aurora', at(5));
    const older = await runOf('aurora', at(1));
    await recordGateLatest(pool, { runId: newer, intentId: 'billing_refund', reason: 'high_risk', thresholds: SEED });
    // An older run gated later does not replace a newer one.
    await recordGateLatest(pool, { runId: older, intentId: 'billing_refund', reason: 'auto', thresholds: SEED });
    expect(await rows()).toEqual([
      { product: 'aurora', intent_id: 'billing_refund', run_id: newer, gate_at: at(5), reason: 'high_risk', unreadable: 0 },
    ]);
  });

  it('keys the intent as the policy engine does, and keeps products apart, no product included', async () => {
    const aurora = await runOf('aurora', at(1));
    const none = await runOf(null, at(2));
    const noneLater = await runOf(null, at(3));
    await recordGateLatest(pool, { runId: aurora, intentId: ' Billing_Refund ', reason: 'auto', thresholds: SEED });
    await recordGateLatest(pool, { runId: none, intentId: 'billing_refund', reason: 'auto', thresholds: SEED });
    // Null is one product here: the later run replaces the earlier one.
    await recordGateLatest(pool, { runId: noneLater, intentId: 'billing_refund', reason: 'agreement', thresholds: SEED });
    expect((await rows()).map((row) => [row.product, row.intent_id, row.run_id, row.reason])).toEqual([
      ['aurora', 'billing_refund', aurora, 'auto'],
      [null, 'billing_refund', noneLater, 'agreement'],
    ]);
  });

  it('lets the same run gated again replace its own record', async () => {
    const runId = await runOf('aurora', at(1));
    await recordGateLatest(pool, { runId, intentId: 'billing_refund', reason: 'agreement', thresholds: SEED });
    await recordGateLatest(pool, { runId, intentId: 'billing_refund', reason: 'auto', thresholds: SEED });
    expect((await rows()).map((row) => row.reason)).toEqual(['auto']);
  });

  it('breaks a tie on the start time by the run id, as the reader orders runs', async () => {
    const low = await runOf('aurora', at(1), '00000000-0000-4000-8000-000000000001');
    const high = await runOf('aurora', at(1), '00000000-0000-4000-8000-000000000002');
    await recordGateLatest(pool, { runId: high, intentId: 'billing_refund', reason: 'auto', thresholds: SEED });
    await recordGateLatest(pool, { runId: low, intentId: 'billing_refund', reason: 'agreement', thresholds: SEED });
    expect((await rows()).map((row) => row.run_id)).toEqual([high]);
  });

  it('clears a backfilled count of unreadable rows when a newer run is gated', async () => {
    const old = await runOf('aurora', at(1));
    await pool.query(
      `INSERT INTO gate_latest (product, intent_id, run_id, run_created_at, gate_at, reason, thresholds, unreadable)
       VALUES ('aurora', 'billing_refund', $1, $2, NULL, NULL, NULL, 3)`,
      [old, at(1)],
    );
    const fresh = await runOf('aurora', at(2));
    await recordGateLatest(pool, { runId: fresh, intentId: 'billing_refund', reason: 'auto', thresholds: SEED });
    expect(await rows()).toEqual([
      { product: 'aurora', intent_id: 'billing_refund', run_id: fresh, gate_at: at(2), reason: 'auto', unreadable: 0 },
    ]);
  });

  it('leaves the transaction\'s own lock timeout as it found it', async () => {
    const runId = await runOf('aurora', at(1));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '7s'");
      await recordGateLatestOrSkip(client, { runId, intentId: 'billing_refund', reason: 'auto', thresholds: SEED });
      expect((await client.query('SHOW lock_timeout')).rows[0]).toEqual({ lock_timeout: '7s' });
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    expect((await rows()).map((row) => row.run_id)).toEqual([runId]);
  });

  it('keeps the write\'s own failure when the rollback to its savepoint fails too', async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => { logged.push(String(line)); });
    const broken = {
      query: async (sql: string) => {
        if (sql.startsWith('INSERT INTO gate_latest')) throw new Error('terminating connection due to administrator command');
        if (sql.startsWith('ROLLBACK TO SAVEPOINT')) throw new Error('Connection terminated unexpectedly');
        if (sql.startsWith('SHOW lock_timeout')) return { rows: [{ lock_timeout: '0' }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
    } as unknown as PoolClient;
    try {
      const failed = await recordGateLatestOrSkip(broken, {
        runId: randomUUID(), intentId: 'billing_refund', reason: 'auto', thresholds: SEED,
      }).then(() => null, (error: unknown) => error as Error);
      // The transaction is unusable, so the failure stands, and it is the write's.
      expect(failed?.message).toBe('terminating connection due to administrator command');
      const line = logged.map((entry) => JSON.parse(entry) as Record<string, unknown>)
        .find((entry) => entry['event'] === 'gate_latest_skipped');
      expect(line).toMatchObject({
        error: 'terminating connection due to administrator command',
        rollbackError: 'Connection terminated unexpectedly',
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('writes nothing for a run the ledger does not hold', async () => {
    await recordGateLatest(pool, { runId: randomUUID(), intentId: 'billing_refund', reason: 'auto', thresholds: SEED });
    expect(await rows()).toEqual([]);
  });
});
