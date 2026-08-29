import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { dbUrl } from '../db/config.js';
import {
  fencedInsert,
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

// Schema source of truth: db/001_ledger.sql from the DDL card.
async function applySchema(): Promise<void> {
  await pool.query(readFileSync('db/001_ledger.sql', 'utf8'));
  await pool.query(readFileSync('db/005_run_timing.sql', 'utf8'));
}

function makeRun(epoch: bigint, state = 'queued'): FencedRunInput {
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

function makeOutbox(run: FencedRunInput, idemKey: string): FencedOutboxInput {
  return {
    stepId: 's1',
    idemKey,
    actionClass: 'reply',
    delivery: 'at_least_once',
    payload: { refundAmount: 50, currency: 'EUR' },
  };
}

describe('fencedInsert', () => {
  beforeEach(async () => {
    await applySchema();
    await pool.query(
      'TRUNCATE run, ticket_epoch, step_journal, outbox, conversation, turn',
    );
  });

  afterEach(async () => {
    await pool.query('TRUNCATE run, ticket_epoch, step_journal, outbox, conversation, turn');
  });

  it('commits the run state change and the outbox insert together', async () => {
    const run = makeRun(1n);
    const result = await fencedInsert(pool, run, makeOutbox(run, 'key-a'));

    expect(result).toEqual({ outcome: 'accepted' });
    const runRow = await pool.query(
      'SELECT state, epoch FROM run WHERE run_id = $1',
      [run.runId],
    );
    expect(runRow.rows).toHaveLength(1);
    expect(runRow.rows[0]!.state).toBe('queued');
    const outboxRow = await pool.query(
      'SELECT idem_key, epoch FROM outbox WHERE run_id = $1',
      [run.runId],
    );
    expect(outboxRow.rows).toHaveLength(1);
    expect(outboxRow.rows[0]!.idem_key).toBe('key-a');
    // Both sides of the pair are visible after commit, or neither would be.
    const epochRow = await pool.query(
      'SELECT epoch FROM ticket_epoch WHERE ticket_id = $1',
      [run.ticketId],
    );
    expect(BigInt(epochRow.rows[0]!.epoch as string)).toBe(1n);
  });

  it('refuses a stale process write and writes nothing', async () => {
    const seed = makeRun(5n);
    await fencedInsert(pool, seed, makeOutbox(seed, 'key-seed'));

    const stale = makeRun(4n);
    stale.ticketId = seed.ticketId;
    const result = await fencedInsert(pool, stale, makeOutbox(stale, 'key-stale'));

    expect(result).toEqual({ outcome: 'stale_epoch', highestAcceptedEpoch: 5n });
    const runRows = await pool.query('SELECT 1 FROM run WHERE run_id = $1', [
      stale.runId,
    ]);
    expect(runRows.rows).toHaveLength(0);
    const outboxRows = await pool.query(
      'SELECT 1 FROM outbox WHERE idem_key = $1',
      ['key-stale'],
    );
    expect(outboxRows.rows).toHaveLength(0);
    const epochRow = await pool.query(
      'SELECT epoch FROM ticket_epoch WHERE ticket_id = $1',
      [stale.ticketId],
    );
    expect(BigInt(epochRow.rows[0]!.epoch as string)).toBe(5n);
  });

  it('treats a zero-row insert as superseded, never queued', async () => {
    const winner = makeRun(2n);
    await fencedInsert(pool, winner, makeOutbox(winner, 'key-dup'));

    const loser = makeRun(3n);
    loser.ticketId = winner.ticketId;
    const result = await fencedInsert(pool, loser, makeOutbox(loser, 'key-dup'));

    expect(result).toEqual({ outcome: 'superseded' });
    const loserRow = await pool.query(
      'SELECT state FROM run WHERE run_id = $1',
      [loser.runId],
    );
    expect(loserRow.rows[0]!.state).toBe('superseded');
    // Liveness: the losing run must not sit in queued waiting for a relay.
    const queued = await pool.query(
      "SELECT 1 FROM run WHERE run_id = $1 AND state = 'queued'",
      [loser.runId],
    );
    expect(queued.rows).toHaveLength(0);
    const outboxCount = await pool.query(
      'SELECT count(*)::int AS n FROM outbox WHERE idem_key = $1',
      ['key-dup'],
    );
    expect(outboxCount.rows[0]!.n).toBe(1);
  });

  it('collides two concurrent runs on one key; the loser stops', async () => {
    const first = makeRun(10n);
    const second = makeRun(11n);
    second.ticketId = first.ticketId;
    const [a, b] = await Promise.all([
      fencedInsert(pool, first, makeOutbox(first, 'key-race')),
      fencedInsert(pool, second, makeOutbox(second, 'key-race')),
    ]);

    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(['accepted', 'superseded'].sort());
    const loser = a.outcome === 'accepted' ? second : first;
    const loserState = await pool.query(
      'SELECT state FROM run WHERE run_id = $1',
      [loser.runId],
    );
    expect(loserState.rows[0]!.state).not.toBe('queued');
    const outboxCount = await pool.query(
      'SELECT count(*)::int AS n FROM outbox',
    );
    expect(outboxCount.rows[0]!.n).toBe(1);
  });

  it('holds fencing across rebalance overlap: interleaved epochs in order', async () => {
    const ticketId = 'T-rebalance';
    const results: string[] = [];
    for (const epoch of [3n, 2n, 4n, 3n]) {
      const run = makeRun(epoch);
      run.ticketId = ticketId;
      const result = await fencedInsert(
        pool,
        run,
        makeOutbox(run, 'key-e' + epoch.toString()),
      );
      results.push(result.outcome);
    }
    // 3 accepted, 2 refused (below 3), 4 accepted, 3 refused (below 4).
    expect(results).toEqual(['accepted', 'stale_epoch', 'accepted', 'stale_epoch']);
    const epochRow = await pool.query(
      'SELECT epoch FROM ticket_epoch WHERE ticket_id = $1',
      [ticketId],
    );
    expect(BigInt(epochRow.rows[0]!.epoch as string)).toBe(4n);
  });

  afterAll(async () => {
    await pool.end();
  });
});
