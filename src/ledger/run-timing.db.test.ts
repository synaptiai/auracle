// Run timing columns (V2 open item 7) — db/005_run_timing.sql.
//
// Proves the three columns a latency correction would read:
//   queue wait   = created_at - enqueued_at
//   service time = finished_at - created_at
//
//   - enqueued_at is copied from the caller (the intake row) at insert and
//     stays null for callers with no queue
//   - created_at fills itself on every insert (DEFAULT now())
//   - finished_at is stamped only when a run enters a terminal state, in
//     the same transaction as the state change — including the superseded
//     path of section 4.2 rule 2
//
// Synthetic data only (DEC-18).
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { dbUrl } from '../db/config.js';
import {
  fencedInsert,
  fencedTransition,
  type FencedOutboxInput,
  type FencedRunInput,
} from './insert.js';

const pool = new Pool({ connectionString: dbUrl() });

// src/test-support/global-setup.ts guarantees a reachable database before
// the workers fork: it starts a container, or probes an explicit
// DATABASE_URL and fails the run. A failure here is therefore a fault, and
// a suite that skipped itself instead would report success while proving
// nothing.
await pool.query('SELECT 1');

async function applySchema(): Promise<void> {
  await pool.query(readFileSync('db/001_ledger.sql', 'utf8'));
  await pool.query(readFileSync('db/005_run_timing.sql', 'utf8'));
}

function makeRun(epoch: bigint, state = 'received'): FencedRunInput {
  return {
    runId: randomUUID(),
    ticketId: 'T-' + randomUUID().slice(0, 8),
    partition: 0,
    epoch,
    state,
    promptVer: 'p1',
    modelVer: 'm1',
    deadlineAt: new Date(Date.now() + 60_000),
  };
}

function makeOutbox(idemKey: string): FencedOutboxInput {
  return {
    stepId: 's1',
    idemKey,
    actionClass: 'reply',
    delivery: 'at_least_once',
    payload: { refundAmount: 50, currency: 'EUR' },
  };
}

interface TimingRow {
  enqueued_at: Date | null;
  created_at: Date | null;
  finished_at: Date | null;
}

async function timingRow(runId: string): Promise<TimingRow> {
  const rows = await pool.query(
    'SELECT enqueued_at, created_at, finished_at FROM run WHERE run_id = $1',
    [runId],
  );
  return rows.rows[0] as unknown as TimingRow;
}

describe('run timing columns (V2 open item 7)', () => {
  beforeEach(async () => {
    await applySchema();
    await pool.query('TRUNCATE run, ticket_epoch, step_journal, outbox, conversation, turn');
  });

  afterEach(async () => {
    await pool.query('TRUNCATE run, ticket_epoch, step_journal, outbox, conversation, turn');
  });

  it('copies the arrival time, records pickup, and stamps only terminal finishes', async () => {
    const run = makeRun(1n);
    const enqueuedAt = new Date(Date.now() - 5_000);
    run.enqueuedAt = enqueuedAt;
    await fencedInsert(pool, run, null);

    // Non-terminal hop: pickup exists, no finish yet.
    await fencedTransition(pool, {
      runId: run.runId,
      state: 'classified',
      costMicros: 1,
      stepsUsed: 1,
    });
    let row = await timingRow(run.runId);
    expect(row.enqueued_at).toEqual(enqueuedAt);
    expect(row.created_at).toBeInstanceOf(Date);
    expect(row.finished_at).toBeNull();

    // Terminal hop stamps the finish in the same transaction.
    await fencedTransition(pool, {
      runId: run.runId,
      state: 'resolved',
      costMicros: 2,
      stepsUsed: 2,
    });
    row = await timingRow(run.runId);
    expect(row.finished_at).toBeInstanceOf(Date);
    expect(row.finished_at!.getTime()).toBeGreaterThanOrEqual(
      row.created_at!.getTime(),
    );
  });

  it('leaves enqueued_at null for callers with no queue', async () => {
    const run = makeRun(1n);
    await fencedInsert(pool, run, null);
    const row = await timingRow(run.runId);
    expect(row.enqueued_at).toBeNull();
    expect(row.created_at).toBeInstanceOf(Date);
  });

  it('stamps finished_at when the outbox conflict lands the run superseded', async () => {
    const winner = makeRun(2n);
    await fencedInsert(pool, winner, makeOutbox('key-dup'));

    const loser = makeRun(3n);
    loser.ticketId = winner.ticketId;
    const result = await fencedInsert(pool, loser, makeOutbox('key-dup'));
    expect(result).toEqual({ outcome: 'superseded' });

    const loserRow = await timingRow(loser.runId);
    expect(loserRow.finished_at).toBeInstanceOf(Date);
    // The winner is still mid-flight: no finish stamped on it.
    const winnerRow = await timingRow(winner.runId);
    expect(winnerRow.finished_at).toBeNull();
  });

  afterAll(async () => {
    await pool.end();
  });
});
