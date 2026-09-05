// The arrival signal, proved against a real Postgres (issue #25).
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

import { ARRIVAL_CHANNEL, pgArrivalSignal, reason } from './arrival-signal.js';
import { enqueueTicket } from './intake.js';
import { dbUrl } from '../db/config.js';
import { applyLedgerSchema } from '../test-support/schema.js';

const pool = new Pool({ connectionString: dbUrl(), max: 4 });

await pool.query('SELECT 1');

const PARTITION_COUNT = 8;

afterAll(async () => {
  await pool.end();
});

/**
 * Waits until a backend is listening on the arrival channel again.
 *
 * `pg_listening_channels()` reads the calling session only, so the check goes
 * through `pg_stat_activity`: the listener's session sits idle after its
 * LISTEN, and that statement is the last one it ran.
 */
async function awaitListener(): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE query = $1 AND pid <> pg_backend_pid()`,
      [`LISTEN ${ARRIVAL_CHANNEL}`],
    );
    if ((rows[0]?.n ?? 0) > 0) return;
    if (Date.now() >= deadline) throw new Error('the listener did not come back in 20 s');
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
    await applyLedgerSchema(pool);
    await pool.query('TRUNCATE run, ticket_epoch, step_journal, outbox, intake, conversation, turn');
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
  // The redelivery case below does not reach this behaviour. `enqueueTicket`
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
      await pool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE query LIKE 'LISTEN %' AND pid <> pg_backend_pid()`,
      );
      // Wait for the condition, never for a duration. The backoff is 1000
      // to 2000 ms plus a dial, an authentication and a LISTEN, so a fixed
      // sleep here is the margin pattern this branch already rejected twice.
      // A notification delivered before the listener is back reaches nobody
      // and nothing retries it, so the case would fail on working code.
      await awaitListener();
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

// The reason a failure gives, which is the only thing an operator has when
// the signal degrades to the poll.
//
// A refused connection is the likeliest failure here and it hides its cause
// twice: `AggregateError` carries an empty `message`, and `String()` gives
// the bare class name. A helper that read only those two logged the event and
// withheld `ECONNREFUSED`, which is the whole content of the report.
describe('the reason a failure reports', () => {
  it('reaches the cause inside an AggregateError', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), {
      code: 'ECONNREFUSED',
    });
    const aggregate = new AggregateError([refused]);
    expect(aggregate.message).toBe('');
    expect(String(aggregate)).not.toContain('ECONNREFUSED');
    expect(reason(aggregate)).toContain('ECONNREFUSED');
  });

  it('joins every cause when there is more than one', () => {
    const both = new AggregateError([new Error('ipv6 refused'), new Error('ipv4 refused')]);
    expect(reason(both)).toBe('ipv6 refused; ipv4 refused');
  });

  it('still reads a plain error and an unknown value', () => {
    expect(reason(new Error('plain'))).toBe('plain');
    expect(reason('a string')).toBe('a string');
  });
});
