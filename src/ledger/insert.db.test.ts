import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { dbUrl } from '../db/config.js';
import {
  fencedInsert,
  fencedTransition,
  type FencedOutboxInput,
  type FencedRunInput,
} from './insert.js';
import { truncateLedger } from '../test-support/schema.js';

const pool = new Pool({ connectionString: dbUrl() });

// src/test-support/db-global-setup.ts guarantees a reachable database before
// the workers fork: it starts a container, or probes an explicit
// DATABASE_URL and fails the run. A failure here is therefore a fault, and
// a suite that skipped itself instead would report success while proving
// nothing.
await pool.query('SELECT 1');


function makeRun(epoch: bigint | 'next', state = 'queued'): FencedRunInput {
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
    await truncateLedger(pool);
  });

  afterEach(async () => {
    await truncateLedger(pool);
  });

  // DEC-44: the record carries the reply it must send. DEC-49 keeps it out of
  // the idempotency key, so it is stored beside the payload and the payload a
  // caller passed is stored untouched.
  it('carries the reply the ledger holds, outside the payload (DEC-44)', async () => {
    const run = makeRun(1n);
    const reply = {
      bodyText: 'Your refund is on its way.',
      disclosure: 'Sent by Auracle.',
      provenance: {
        generatedBy: 'model',
        modelId: 'm1',
        promptVer: 'p1',
        generatedAt: '2026-09-19T00:00:00Z',
      },
    };
    const result = await fencedInsert(pool, run, {
      ...makeOutbox(run, 'key-reply'),
      reply,
    });
    expect(result).toEqual({ outcome: 'accepted' });

    const row = await pool.query<{ reply: unknown; payload: Record<string, unknown> }>(
      "SELECT reply, payload FROM outbox WHERE run_id = $1 AND step_id = 's1'",
      [run.runId],
    );
    expect(row.rows[0]?.reply).toEqual(reply);
    // The payload is the semantic action, exactly as the caller passed it.
    expect(row.rows[0]?.payload).toEqual({ refundAmount: 50, currency: 'EUR' });
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

  // Issue #113: the epoch is allocated under the ticket row lock, inside the
  // insert's own transaction. A creation that read the fence first — outside
  // that lock — hands two creations the same epoch, and the second then
  // raises no fence at all.
  // DEC-47: the product of the channel the run's message arrived on. Absent
  // on the input means the run records none, which is what a caller with no
  // channel — a replay, a test — honestly has.
  it('records the product it was given, and none when given none', async () => {
    const withProduct = makeRun('next');
    await fencedInsert(pool, { ...withProduct, product: 'aurora' }, null);
    const without = makeRun('next');
    await fencedInsert(pool, without, null);

    const rows = await pool.query<{ run_id: string; product: string | null }>(
      'SELECT run_id::text AS run_id, product FROM run WHERE run_id = ANY($1)',
      [[withProduct.runId, without.runId]],
    );
    const byId = new Map(rows.rows.map((row) => [row.run_id, row.product]));
    expect(byId.get(withProduct.runId)).toBe('aurora');
    expect(byId.get(without.runId)).toBeNull();
  });

  it('allocates the next epoch under the ticket lock, and never twice', async () => {
    const first = makeRun('next');
    const second = makeRun('next');
    second.ticketId = first.ticketId;
    await pool.query('INSERT INTO ticket_epoch (ticket_id, epoch) VALUES ($1, 20)', [
      first.ticketId,
    ]);

    // The plausible wrong version plans the epoch from a pool-level read,
    // taken before the transaction that guards it. This wrapper counts one, so
    // that version fails here whatever the interleaving. Any other wrong
    // version is caught by the epochs below when the two calls interleave, and
    // the interleaving is left to `Promise.all` here: the forced one is the
    // case below, which is where a missing lock shows.
    let readsOutsideTheLock = 0;
    const watched = {
      connect: pool.connect.bind(pool),
      query: async (text: string, values?: unknown[]) => {
        if (typeof text === 'string' && text.includes('FROM ticket_epoch')) {
          readsOutsideTheLock += 1;
        }
        return pool.query(text, values as never);
      },
    } as unknown as Pool;

    const [a, b] = await Promise.all([
      fencedInsert(watched, first, makeOutbox(first, 'key-next-a')),
      fencedInsert(watched, second, makeOutbox(second, 'key-next-b')),
    ]);

    expect([a.outcome, b.outcome]).toEqual(['accepted', 'accepted']);
    const rows = await pool.query(
      'SELECT epoch::text AS epoch FROM run WHERE ticket_id = $1 ORDER BY epoch',
      [first.ticketId],
    );
    expect(rows.rows.map((row) => row['epoch'])).toEqual(['21', '22']);
    const fence = await pool.query(
      'SELECT epoch::text AS epoch FROM ticket_epoch WHERE ticket_id = $1',
      [first.ticketId],
    );
    expect(fence.rows[0]!['epoch']).toBe('22');
    expect(readsOutsideTheLock).toBe(0);
  });

  // The security review's finding (SEC-1): `FOR UPDATE` locks no row that is
  // not there, so a ticket whose first write is this one had no lock at all.
  // Two creations would each read no fence, each allocate 1, and one of them
  // would raise nothing. The insert materialises the row before it locks.
  //
  // The interleaving is forced, because `Promise.all` alone is a coin flip:
  // the first creation is held at its fence read while the second runs. A
  // version that reads before it locks lets the second read first and land at
  // the same epoch; this one holds the row, so the second waits and takes the
  // next. The hold is bounded — waiting for the second would deadlock against
  // the fixed code, which is holding the row the second needs.
  //
  // The window is this case's one timing assumption, and it cuts one way: a
  // second read landing after the hold would let the unfixed version pass. The
  // fixed version does not depend on it — its second creation blocks on the
  // row lock and cannot read early, however long the hold runs.
  it('allocates 1 and 2 for two concurrent first creations on one ticket', async () => {
    const first = makeRun('next');
    const second = makeRun('next');
    second.ticketId = first.ticketId;

    // Its own pool, so the wrapped clients never return to the shared one.
    const held = new Pool({ connectionString: dbUrl(), max: 4 });
    try {
      let reads = 0;
      const heldPool = {
        query: pool.query.bind(pool),
        connect: async (): Promise<unknown> => {
          const client = await held.connect();
          const real = client.query.bind(client);
          (client as { query: unknown }).query = async (text: unknown, values?: unknown[]) => {
            // The hold is after the read, so the first creation has already
            // taken its fence value when the second one reads its own. Before
            // it, the second would simply read the newer value and both would
            // still land apart — a coin flip, not a discriminating check.
            const result = await real(text as string, values as never);
            if (typeof text === 'string' && text.includes('FROM ticket_epoch')) {
              reads += 1;
              if (reads === 1) {
                await new Promise((resolve) => setTimeout(resolve, 300));
              }
              // Restored at the read, so a client that goes back to the pool
              // is not left wrapped.
              delete (client as { query?: unknown }).query;
            }
            return result;
          };
          return client;
        },
      } as unknown as Pool;

      const [a, b] = await Promise.all([
        fencedInsert(heldPool, first, makeOutbox(first, 'key-first-a')),
        fencedInsert(heldPool, second, makeOutbox(second, 'key-first-b')),
      ]);

      expect([a.outcome, b.outcome]).toEqual(['accepted', 'accepted']);
    } finally {
      await held.end();
    }

    const rows = await pool.query(
      'SELECT epoch::text AS epoch FROM run WHERE ticket_id = $1 ORDER BY epoch',
      [first.ticketId],
    );
    expect(rows.rows.map((row) => row['epoch'])).toEqual(['1', '2']);
    const fence = await pool.query(
      'SELECT epoch::text AS epoch FROM ticket_epoch WHERE ticket_id = $1',
      [first.ticketId],
    );
    expect(fence.rows[0]!['epoch']).toBe('2');
  });

  it("starts a ticket's first allocated epoch at 1, and creates its fence", async () => {
    const run = makeRun('next');
    expect((await fencedInsert(pool, run, null)).outcome).toBe('accepted');
    const row = await pool.query(
      'SELECT epoch::text AS epoch FROM run WHERE run_id = $1',
      [run.runId],
    );
    expect(row.rows[0]!['epoch']).toBe('1');
    const fence = await pool.query(
      'SELECT epoch::text AS epoch FROM ticket_epoch WHERE ticket_id = $1',
      [run.ticketId],
    );
    expect(fence.rows[0]!['epoch']).toBe('1');
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
});

describe('fencedTransition and the runs the fence still governs', () => {
  beforeEach(async () => {
    await truncateLedger(pool);
  });

  afterEach(async () => {
    await truncateLedger(pool);
  });

  /** Creates a run in `state` at epoch 1, then raises the ticket's fence. */
  async function runBehindARaisedFence(state: string): Promise<string> {
    const run = makeRun(1n, state);
    expect((await fencedInsert(pool, run, null)).outcome).toBe('accepted');
    await pool.query('UPDATE ticket_epoch SET epoch = 50 WHERE ticket_id = $1', [
      run.ticketId,
    ]);
    return run.runId;
  }

  // Issue #113: a parked run waits for a person, and no consumer holds it.
  // The fence a later run raised says nothing about it, so the approval must
  // still commit. Before this, the write was refused and the reply stayed
  // parked with every approval bouncing.
  it('accepts a parked run when the fence moved on (DEC-28)', async () => {
    const runId = await runBehindARaisedFence('awaiting_approval');
    const moved = await fencedTransition(pool, {
      runId,
      state: 'resolved',
      costMicros: 0,
      stepsUsed: 1,
      fromState: 'awaiting_approval',
    });
    expect(moved).toEqual({ outcome: 'accepted' });
  });

  // The escape decides the lock as well as the comparison. A parked write
  // reads no fence, so it takes none, and that is what keeps it out of a
  // cycle: a customer's message takes the fence row first and then the
  // snoozed runs of that conversation (DEC-48), so a parked write that
  // reached for the fence after its own run row would deadlock with it.
  it('does not wait for the fence row a parked write never reads (DEC-28)', async () => {
    const run = makeRun(1n, 'awaiting_approval');
    expect((await fencedInsert(pool, run, null)).outcome).toBe('accepted');

    const holder = await pool.connect();
    let moved: ReturnType<typeof fencedTransition> | null = null;
    try {
      await holder.query('BEGIN');
      // Intake's first lock, held until the transaction ends.
      await holder.query('SELECT epoch FROM ticket_epoch WHERE ticket_id = $1 FOR UPDATE', [
        run.ticketId,
      ]);

      moved = fencedTransition(pool, {
        runId: run.runId,
        state: 'resolved',
        costMicros: 0,
        stepsUsed: 1,
        fromState: 'awaiting_approval',
      });
      const raced = await Promise.race([
        moved,
        new Promise<'waited'>((resolve) => setTimeout(() => resolve('waited'), 5_000)),
      ]);
      // Released before the assertion, so a write that waited leaves no
      // blocked query behind.
      await holder.query('COMMIT');
      expect(raced).toEqual({ outcome: 'accepted' });
    } finally {
      if (moved !== null) await moved.catch(() => null);
      holder.release();
    }
  });

  // The escape belongs to the write that requires the parked state (the
  // security review's SEC-3). A caller that names no precondition keeps the
  // comparison, so a sweep or a reject path added later inherits the guard
  // rather than the escape.
  it('refuses a parked run whose write names no precondition (DEC-28)', async () => {
    const runId = await runBehindARaisedFence('awaiting_approval');
    const moved = await fencedTransition(pool, {
      runId,
      state: 'resolved',
      costMicros: 0,
      stepsUsed: 1,
    });
    expect(moved).toEqual({ outcome: 'stale_epoch', highestAcceptedEpoch: 50n });
  });

  // DEC-46's shown-text guard: a caller's own precondition on values the row
  // cannot express. It is asked under the same lock, with the state the row
  // holds, and a true answer refuses the transition without writing anything.
  it('refuses a write its own precondition refuses, and changes nothing', async () => {
    const run = makeRun(1n, 'awaiting_approval');
    await fencedInsert(pool, run, null);

    const asked: string[] = [];
    const moved = await fencedTransition(pool, {
      runId: run.runId,
      state: 'resolved',
      costMicros: 0,
      stepsUsed: 1,
      fromState: 'awaiting_approval',
      outbox: makeOutbox(run, 'key-refused'),
      refuseIf: async (_client, currentState) => {
        asked.push(currentState);
        return true;
      },
    });

    expect(moved).toEqual({ outcome: 'refused' });
    // It is asked about the state under the lock, so a precondition can
    // compare what the caller showed a person with what the row holds.
    expect(asked).toEqual(['awaiting_approval']);
    // And the refusal wrote nothing: the run is where it was, and the outbox
    // holds no record. An implementation that wrote and then rolled back
    // would satisfy this too — what these assertions hold is that nothing
    // committed, and the placement in `fencedTransition` is what makes the
    // write not happen rather than unhappen.
    const row = await pool.query('SELECT state FROM run WHERE run_id = $1', [run.runId]);
    expect(row.rows[0]!.state).toBe('awaiting_approval');
    const outbox = await pool.query('SELECT 1 FROM outbox WHERE run_id = $1', [run.runId]);
    expect(outbox.rows).toHaveLength(0);
  });

  // The other answer: a precondition that is satisfied lets the same write
  // through, so the hook refuses nothing by itself.
  it('accepts a write whose precondition is satisfied', async () => {
    const run = makeRun(1n, 'awaiting_approval');
    await fencedInsert(pool, run, null);

    const asked: string[] = [];
    const moved = await fencedTransition(pool, {
      runId: run.runId,
      state: 'resolved',
      costMicros: 0,
      stepsUsed: 1,
      fromState: 'awaiting_approval',
      outbox: makeOutbox(run, 'key-accepted'),
      refuseIf: async (_client, currentState) => {
        asked.push(currentState);
        return false;
      },
    });

    expect(moved).toEqual({ outcome: 'accepted' });
    expect(asked).toEqual(['awaiting_approval']);
    const row = await pool.query('SELECT state FROM run WHERE run_id = $1', [run.runId]);
    expect(row.rows[0]!.state).toBe('resolved');
  });

  // The boundary of the escape, at its other end: a run that has finished is
  // not parked either, so the fence still governs it. No production caller
  // moves a terminal run today, which is why this is the fail-closed half of
  // the pair rather than a behaviour any path relies on.
  it('refuses a finished run at the raised fence (DEC-28)', async () => {
    const runId = await runBehindARaisedFence('resolved');
    const moved = await fencedTransition(pool, {
      runId,
      state: 'escalated',
      costMicros: 0,
      stepsUsed: 1,
      fromState: 'resolved',
    });
    expect(moved).toEqual({ outcome: 'stale_epoch', highestAcceptedEpoch: 50n });
  });

  // The other half of the same fence: a run a consumer is still walking is
  // exactly what DEC-28 refuses, and the exemption above must not reach it.
  it('refuses a run in flight at the same raised fence (DEC-28)', async () => {
    const runId = await runBehindARaisedFence('executing');
    const moved = await fencedTransition(pool, {
      runId,
      state: 'resolved',
      costMicros: 0,
      stepsUsed: 1,
      fromState: 'executing',
    });
    expect(moved).toEqual({ outcome: 'stale_epoch', highestAcceptedEpoch: 50n });
    const row = await pool.query('SELECT state FROM run WHERE run_id = $1', [runId]);
    expect(row.rows[0]!.state).toBe('executing');
  });
});

// File scope, not inside a describe: a sibling describe's afterAll runs
// before the next describe's tests, so ending the pool there would break
// every suite after it in this file.
afterAll(async () => {
  await pool.end();
});
