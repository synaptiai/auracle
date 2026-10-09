// The arrival signal, proved against a real Postgres.
//
// The signal is an optimisation and never an authority: the queue row is the
// authority. So the two properties that matter are both about agreement
// between the row and the notification. A signal must not fire without a
// row, and a row must not land without a signal.
//
// The second property is the one that costs a full poll interval when it
// breaks, and the first is the one that wakes every consumer for nothing.
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { ARRIVAL_CHANNEL, pgArrivalSignal } from './arrival-signal.js';
import { enqueueTicket } from './intake.js';
import { dbUrl } from '../db/config.js';
import { truncateLedger } from '../test-support/schema.js';

const pool = new Pool({ connectionString: dbUrl(), max: 4 });

await pool.query('SELECT 1');

const PARTITION_COUNT = 8;

afterAll(async () => {
  await pool.end();
});

/**
 * The sessions listening on the arrival channel in this file's database.
 *
 * `pg_listening_channels()` reads the calling session only, so this goes
 * through `pg_stat_activity`. A listener's session sits idle after its
 * LISTEN, and that statement is the last one it ran. Idle, because a session
 * still running its LISTEN has not registered yet, and a notification sent
 * then reaches nobody. The database, because other files run in parallel on
 * the same server.
 */
async function listeners(): Promise<number[]> {
  const { rows } = await pool.query<{ pid: number }>(
    `SELECT pid FROM pg_stat_activity
      WHERE datname = current_database() AND query = $1 AND state = 'idle'
        AND pid <> pg_backend_pid()`,
    [`LISTEN ${ARRIVAL_CHANNEL}`],
  );
  return rows.map((row) => row.pid);
}

/**
 * Waits until a session other than `old` listens, and `old` itself is gone.
 *
 * `pg_terminate_backend` returns once the signal is sent, not once the backend
 * has exited, so the terminated session can still be listed as listening. A
 * wait that took any listening session could return on it at once, the ticket
 * went out before the new listener existed, and the notification reached
 * nobody. The wait names the session it is waiting for.
 */
async function awaitNewListener(old: number): Promise<number> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const found = await listeners();
    const gone = (await pool.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [old])).rowCount === 0;
    const fresh = found.find((pid) => pid !== old);
    if (gone && fresh !== undefined) return fresh;
    if (Date.now() >= deadline) {
      // Two causes with two owners: a backend the server never let go, or
      // a reconnect that never listened again. The message says which.
      throw new Error(
        `no new listener came back in 20 s: the terminated session ${old} `
          + `${gone ? 'is gone' : 'is still listed'}, listening now ${JSON.stringify(found)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Collects notifications until `expected` arrive or the budget expires. */
async function collect(
  expected: number,
  budgetMs: number,
  act: () => Promise<void>,
): Promise<number[]> {
  const seen: number[] = [];
  let settle: (() => void) | null = null;
  const signal = pgArrivalSignal(dbUrl());
  await signal.start((partition) => {
    seen.push(partition);
    if (seen.length >= expected) settle?.();
  });
  try {
    const done = new Promise<void>((resolve) => {
      settle = resolve;
      setTimeout(resolve, budgetMs);
    });
    await act();
    await done;
  } finally {
    await signal.stop();
  }
  return seen;
}

describe('the arrival signal', () => {
  beforeEach(async () => {
    await truncateLedger(pool);
  });

  it('names the channel once, so the emitter and the listener cannot drift', () => {
    expect(ARRIVAL_CHANNEL).toBe('ticket_arrived');
  });

  it('fires with the queued row, carrying the partition the row was filed under', async () => {
    const ticketId = randomUUID();
    let filed = -1;
    const seen = await collect(1, 4000, async () => {
      const result = await enqueueTicket(
        pool,
        { ticketId, messageId: randomUUID(), ticketText: 'a synthetic ticket' },
        PARTITION_COUNT,
      );
      filed = result.partition;
    });
    expect(seen).toEqual([filed]);
  });

  // Postgres holds a notification until the transaction that queued it
  // commits, and discards it if that transaction aborts. The emitter's
  // placement inside the enqueue transaction rests on exactly that, so it is
  // asserted directly rather than assumed.
  //
  // The redelivery case below does not reach this behavior. `enqueueTicket`
  // returns before the emit on that path, so what it proves is control flow:
  // no notification is ever queued. Both facts matter and neither implies
  // the other — moving the emit above the duplicate check would keep that
  // case green and change what protects the system.
  it('discards a notification whose transaction rolls back', async () => {
    const client = await pool.connect();
    try {
      const seen = await collect(1, 1500, async () => {
        await client.query('BEGIN');
        await client.query('SELECT pg_notify($1, $2)', [ARRIVAL_CHANNEL, '3']);
        await client.query('ROLLBACK');
      });
      expect(seen).toEqual([]);
    } finally {
      client.release();
    }
  });

  // And the same emit does arrive when its transaction commits, so the case
  // above is a property of the rollback and not of a signal that never works
  // inside a transaction at all.
  it('delivers a notification whose transaction commits', async () => {
    const client = await pool.connect();
    try {
      const seen = await collect(1, 4000, async () => {
        await client.query('BEGIN');
        await client.query('SELECT pg_notify($1, $2)', [ARRIVAL_CHANNEL, '3']);
        await client.query('COMMIT');
      });
      expect(seen).toEqual([3]);
    } finally {
      client.release();
    }
  });

  // The redelivery path returns before the emit. An at-least-once source
  // that redelivers one message must wake nobody, whichever mechanism
  // supplies that.
  it('does not fire when a redelivery queues no new row', async () => {
    const ticket = {
      ticketId: randomUUID(),
      messageId: randomUUID(),
      ticketText: 'a synthetic ticket',
    };
    await enqueueTicket(pool, ticket, PARTITION_COUNT);

    // The same message again. enqueueTicket rolls back and reports enqueued
    // false; nothing new is queued, so nothing may be signalled.
    const seen = await collect(1, 1500, async () => {
      const again = await enqueueTicket(pool, ticket, PARTITION_COUNT);
      expect(again.enqueued).toBe(false);
    });
    expect(seen).toEqual([]);
  });

  // A payload the listener cannot read must never throw inside the
  // notification handler: an unhandled rejection there kills the daemon,
  // and the poll ceiling is meant to carry a broken signal, not die with it.
  it('ignores a payload that is not a partition number', async () => {
    const seen = await collect(1, 1500, async () => {
      await pool.query('SELECT pg_notify($1, $2)', [ARRIVAL_CHANNEL, 'not-a-number']);
    });
    expect(seen).toEqual([]);
  });

  // The half of that guard a `Number()` parse used to let through. An empty
  // payload gives `Number('') === 0`, an integer, so a bare `NOTIFY
  // ticket_arrived` woke partition 0 specifically. `'0x10'` and `'1e3'`
  // passed the same way.
  it('ignores an empty payload and other shapes the emitter never sends', async () => {
    const seen = await collect(1, 1500, async () => {
      for (const payload of ['', ' ', '0x10', '1e3', '-1', '2.5']) {
        await pool.query('SELECT pg_notify($1, $2)', [ARRIVAL_CHANNEL, payload]);
      }
    });
    expect(seen).toEqual([]);
  });

  // The listener owns the connection, and losing it must cost latency and
  // nothing else. An unhandled 'error' event on a pg Client is fatal to the
  // process, so this is the case that would have caught an 'error' handler
  // attached after connect() instead of before it.
  it('survives its connection being terminated, and listens again', async () => {
    const seen: number[] = [];
    const signal = pgArrivalSignal(dbUrl());
    await signal.start((partition) => seen.push(partition));
    try {
      // The signal's own session, and only it: a terminate by query text
      // reached every listener on the server.
      const [old, ...others] = await listeners();
      expect(old).toBeDefined();
      expect(others).toEqual([]);
      await pool.query('SELECT pg_terminate_backend($1)', [old]);
      // Wait for the condition, never for a duration. The backoff is 1000
      // to 2000 ms plus a dial, an authentication and a LISTEN, so a fixed
      // sleep here is the margin pattern this branch already rejected twice.
      // A notification delivered before the listener is back reaches nobody
      // and nothing retries it, so the case would fail on working code.
      await awaitNewListener(old!);
      await enqueueTicket(
        pool,
        { ticketId: randomUUID(), messageId: randomUUID(), ticketText: 'a synthetic ticket' },
        PARTITION_COUNT,
      );
      const deadline = Date.now() + 3000;
      while (seen.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(seen).toHaveLength(1);
    } finally {
      await signal.stop();
    }
  });
});

