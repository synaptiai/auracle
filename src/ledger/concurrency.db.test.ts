// Integration suite for the concurrency rules of section 3.4
// ("A correct idempotency key is not a concurrency design"), proven end-to-end
// against Dockerized Postgres. Keys come from src/ledger/keys.ts (DEC-24) and
// every write goes through fencedInsert (section 4.2), so each test exercises
// the full path: derive key -> transactional fenced write -> ledger state.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { dbUrl } from '../db/config.js';
import { fencedInsert, type FencedOutboxInput, type FencedRunInput } from './insert.js';
import { deriveIdemKey } from './keys.js';

const pool = new Pool({ connectionString: dbUrl(), max: 10 });

let dbUp = true;
try {
  await pool.query('SELECT 1');
} catch {
  dbUp = false;
}

const dbDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../db');
const DDL = readFileSync(path.join(dbDir, '001_ledger.sql'), 'utf8');

interface RefundAction {
  amountCents: number;
}

// DEC-24: the key derives from action semantics only — class + ticket + payload.
function refundKey(ticketId: string, action: RefundAction): string {
  return deriveIdemKey({
    actionClass: 'refund',
    ticketId,
    payload: { amount_cents: action.amountCents, currency: 'EUR' },
  });
}

function makeRun(epoch: bigint, ticketId: string): FencedRunInput {
  return {
    runId: randomUUID(),
    ticketId,
    partition: 0, // DEC-27: one consumer owns this partition in these tests.
    epoch,
    state: 'queued',
    promptVer: 'p1',
    modelVer: 'm1',
    deadlineAt: new Date(Date.now() + 60_000),
  };
}

function refundOutbox(run: FencedRunInput, idemKey: string, action: RefundAction): FencedOutboxInput {
  return {
    stepId: 's1',
    idemKey,
    actionClass: 'refund',
    delivery: 'at_least_once',
    payload: { amount_cents: action.amountCents, currency: 'EUR' },
  };
}

async function outboxCount(idemKey: string): Promise<number> {
  const rows = await pool.query(
    'SELECT count(*)::int AS n FROM outbox WHERE idem_key = $1',
    [idemKey],
  );
  return rows.rows[0]!.n;
}

// DEC-28: seed the fencing row so SELECT ... FOR UPDATE serializes racing
// writers. Without an existing row there is nothing to lock, so every
// writer's fence check reads null and the checks interleave before any
// upsert commits.
async function seedEpoch(ticketId: string, epoch: bigint): Promise<void> {
  await pool.query(
    'INSERT INTO ticket_epoch (ticket_id, epoch) VALUES ($1, $2)',
    [ticketId, epoch.toString()],
  );
}

describe.skipIf(!dbUp)('section 3.4 concurrency rules', () => {
  beforeEach(async () => {
    await pool.query(DDL);
    await pool.query('TRUNCATE run, ticket_epoch, step_journal, outbox');
  });

  afterEach(async () => {
    await pool.query('TRUNCATE run, ticket_epoch, step_journal, outbox');
  });

  it('collides concurrent inserts of one semantic action; the loser lands superseded, never queued', async () => {
    // DEC-24 gives both runs the same key; DEC-27 puts them on one partition.
    // Section 4.2 rule 2: the zero-row loser must stop at 'superseded' so it
    // never waits for a relay result nobody will send (section 3.4).
    const ticket = 'T-' + randomUUID().slice(0, 8);
    const action: RefundAction = { amountCents: 5000 };
    const key = refundKey(ticket, action);
    await seedEpoch(ticket, 20n);

    // Equal epochs make the race deterministic: the fence serializes both
    // writers on the seeded row, so the first accepts and the second —
    // whatever its arrival order — collides on the shared key.
    const winnerInput = makeRun(20n, ticket);
    const loserInput = makeRun(20n, ticket);
    const [winner, loser] = await Promise.all([
      fencedInsert(pool, winnerInput, refundOutbox(winnerInput, key, action)),
      fencedInsert(pool, loserInput, refundOutbox(loserInput, key, action)),
    ]);

    expect([winner.outcome, loser.outcome].sort()).toEqual(
      ['accepted', 'superseded'].sort(),
    );

    // Liveness: exactly one run reaches queued and it holds the single outbox row.
    const states = await pool.query(
      "SELECT state, count(*)::int AS n FROM run WHERE ticket_id = $1 GROUP BY state",
      [ticket],
    );
    const byState = new Map(states.rows.map((r) => [r.state as string, r.n as number]));
    expect(byState.get('queued')).toBe(1);
    expect(byState.get('superseded')).toBe(1);
    const queuedWithoutWork = await pool.query(
      `SELECT 1 FROM run r
       LEFT JOIN outbox o ON o.run_id = r.run_id AND o.idem_key = $1
       WHERE r.ticket_id = $2 AND r.state = 'queued' AND o.run_id IS NULL`,
      [key, ticket],
    );
    expect(queuedWithoutWork.rows).toHaveLength(0);
    expect(await outboxCount(key)).toBe(1);

    // Equal epochs never raise the fence, so ticket_epoch stays at the seed.
    const epochRow = await pool.query(
      'SELECT epoch FROM ticket_epoch WHERE ticket_id = $1',
      [ticket],
    );
    expect(BigInt(epochRow.rows[0]!.epoch as string)).toBe(20n);
  });

  it('derives the same key for two runs of the same action regardless of run identity; the replay is superseded', async () => {
    // DEC-24 / section 3.4: run_id and timestamps are not key inputs, so a
    // second execution of the same action collides with the first at the
    // unique constraint even though it runs alone.
    const ticket = 'T-' + randomUUID().slice(0, 8);
    const action: RefundAction = { amountCents: 2500 };

    const first = makeRun(30n, ticket);
    const firstResult = await fencedInsert(
      pool,
      first,
      refundOutbox(first, refundKey(ticket, action), action),
    );
    expect(firstResult).toEqual({ outcome: 'accepted' });

    const replay = makeRun(31n, ticket);
    const replayResult = await fencedInsert(
      pool,
      replay,
      refundOutbox(replay, refundKey(ticket, action), action),
    );
    expect(replayResult).toEqual({ outcome: 'superseded' });
    const replayRow = await pool.query('SELECT state FROM run WHERE run_id = $1', [
      replay.runId,
    ]);
    expect(replayRow.rows[0]!.state).toBe('superseded');
    expect(await outboxCount(refundKey(ticket, action))).toBe(1);
  });

  it('accepts different payloads concurrently because their keys differ — the unique constraint does not operate', async () => {
    // Section 3.4: a refund of 50 and a refund of 100 give different keys
    // (DEC-24), so the outbox collision never fires and BOTH writes commit.
    // This is why the fencing gate (DEC-28), not the key, is the concurrency
    // design; the test pins the boundary the architecture relies on.
    const ticket = 'T-' + randomUUID().slice(0, 8);
    const small: RefundAction = { amountCents: 50 };
    const large: RefundAction = { amountCents: 100 };

    expect(refundKey(ticket, small)).not.toBe(refundKey(ticket, large));

    await seedEpoch(ticket, 40n);
    // Equal epochs keep the outcome order-independent: whoever commits first
    // raises the fence to 41, and the other writer passes the same check
    // after it on the serialized row.
    const runSmall = makeRun(41n, ticket);
    const runLarge = makeRun(41n, ticket);
    const [resSmall, resLarge] = await Promise.all([
      fencedInsert(pool, runSmall, refundOutbox(runSmall, refundKey(ticket, small), small)),
      fencedInsert(pool, runLarge, refundOutbox(runLarge, refundKey(ticket, large), large)),
    ]);
    expect(resSmall).toEqual({ outcome: 'accepted' });
    expect(resLarge).toEqual({ outcome: 'accepted' });
    expect(await outboxCount(refundKey(ticket, small))).toBe(1);
    expect(await outboxCount(refundKey(ticket, large))).toBe(1);
  });

  it('refuses writes with stale epochs and persists nothing for them', async () => {
    // DEC-28: a lease without a fencing token does not close section 3.4's
    // gap — the ledger itself refuses any write below the highest accepted
    // epoch, and the refusal leaves no trace.
    const ticket = 'T-' + randomUUID().slice(0, 8);
    const action: RefundAction = { amountCents: 750 };

    const current = makeRun(50n, ticket);
    expect(
      await fencedInsert(pool, current, refundOutbox(current, refundKey(ticket, action), action)),
    ).toEqual({ outcome: 'accepted' });

    const stale = makeRun(49n, ticket); // Expired-lease holder wakes up here.
    const staleResult = await fencedInsert(
      pool,
      stale,
      refundOutbox(stale, `stale:${stale.runId}`, action),
    );
    expect(staleResult).toEqual({ outcome: 'stale_epoch', highestAcceptedEpoch: 50n });
    expect(
      (await pool.query('SELECT 1 FROM run WHERE run_id = $1', [stale.runId])).rows,
    ).toHaveLength(0);
    expect(
      (await pool.query('SELECT 1 FROM outbox WHERE idem_key = $1', [`stale:${stale.runId}`]))
        .rows,
    ).toHaveLength(0);
    const epochRow = await pool.query(
      'SELECT epoch FROM ticket_epoch WHERE ticket_id = $1',
      [ticket],
    );
    expect(BigInt(epochRow.rows[0]!.epoch as string)).toBe(50n);
  });

  it('holds epoch ordering across simulated rebalance overlap with three racing lease holders', async () => {
    // DEC-28 under true concurrency: an expired holder (epoch 60), its
    // replacement (61) and a latecomer (59) all race on one ticket. Seeding
    // ticket_epoch makes FOR UPDATE serialize every arrival, so in every
    // interleaving of section 3.4:
    //   - ticket_epoch ends at the highest epoch (61), whatever the order
    //   - exactly one pending outbox row exists for the shared semantic action
    //     (a later-accepted writer loses ON CONFLICT DO NOTHING and stops)
    //   - no run sits in 'queued' without its outbox row (liveness)
    // A low epoch that commits first may hold the queued run until the relay
    // re-checks its fence at send time (outbox.epoch, DEC-28).
    const ticket = 'T-' + randomUUID().slice(0, 8);
    const action: RefundAction = { amountCents: 9900 };
    const key = refundKey(ticket, action);
    await seedEpoch(ticket, 58n);

    const expired = makeRun(60n, ticket);
    const replacement = makeRun(61n, ticket);
    const latecomer = makeRun(59n, ticket);
    const results = await Promise.all([
      fencedInsert(pool, expired, refundOutbox(expired, key, action)),
      fencedInsert(pool, replacement, refundOutbox(replacement, key, action)),
      fencedInsert(pool, latecomer, refundOutbox(latecomer, key, action)),
    ]);

    const epochRow = await pool.query(
      'SELECT epoch FROM ticket_epoch WHERE ticket_id = $1',
      [ticket],
    );
    expect(BigInt(epochRow.rows[0]!.epoch as string)).toBe(61n);
    expect(results.find((r) => r.outcome === 'accepted')).toBeDefined();

    const states = await pool.query(
      'SELECT state, count(*)::int AS n FROM run WHERE ticket_id = $1 GROUP BY state',
      [ticket],
    );
    const byState = new Map(states.rows.map((r) => [r.state as string, r.n as number]));
    const totalRuns =
      (byState.get('queued') ?? 0) +
      (byState.get('superseded') ?? 0) +
      results.filter((r) => r.outcome === 'stale_epoch').length;
    expect(totalRuns).toBe(3);

    expect(await outboxCount(key)).toBe(1);
    const queuedWithoutWork = await pool.query(
      `SELECT 1 FROM run r
       LEFT JOIN outbox o ON o.run_id = r.run_id AND o.idem_key = $1
       WHERE r.ticket_id = $2 AND r.state = 'queued' AND o.run_id IS NULL`,
      [key, ticket],
    );
    expect(queuedWithoutWork.rows).toHaveLength(0);

    // Every non-stale run stopped either queued-with-work or superseded:
    // no third terminal state exists (section 4.2 rule 2).
    const stuck = await pool.query(
      `SELECT 1 FROM run r
       LEFT JOIN outbox o ON o.run_id = r.run_id
       WHERE r.ticket_id = $1 AND r.state NOT IN ('queued', 'superseded')`,
      [ticket],
    );
    expect(stuck.rows).toHaveLength(0);
  });

  afterAll(async () => {
    await pool.end();
  });
});
