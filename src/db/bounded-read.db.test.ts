// A read-only transaction that cannot hold a connection past its bound.
//
// Each case asks what the pool holds afterwards: the same clean session, or a
// new one because the old one was destroyed. A pool of one makes the session
// the next query gets the one the read returned.
import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { dbUrl, readerDbUrl } from './config.js';
import { truncateLedger } from '../test-support/schema.js';
import { boundedRead } from './bounded-read.js';

// The readers' role: boundedRead refuses the writer's session.
const pool = new Pool({ connectionString: readerDbUrl(), max: 1 });
const writer = new Pool({ connectionString: dbUrl(), max: 1 });
await pool.query('SELECT 1');

afterAll(async () => {
  await pool.end();
  await writer.end();
});

/** The session the pool hands out next, and the bounds it carries. */
async function session(): Promise<{ pid: number; statement: string; idle: string; inTx: boolean }> {
  const { rows } = await pool.query<{ pid: number; statement: string; idle: string; in_tx: boolean }>(
    `SELECT pg_backend_pid() AS pid,
            current_setting('statement_timeout') AS statement,
            current_setting('idle_in_transaction_session_timeout') AS idle,
            now() <> statement_timestamp() AS in_tx`,
  );
  const row = rows[0]!;
  return { pid: row.pid, statement: row.statement, idle: row.idle, inTx: row.in_tx };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('a bounded read', () => {
  beforeEach(async () => {
    await truncateLedger(writer);
  });

  it('returns the session clean after a read that throws on its own', async () => {
    const before = await session();
    await expect(boundedRead(pool, 'test', 1_000, 2_000, async (query) => {
      await query('SELECT 1');
      throw new Error('the read gave up');
    })).rejects.toThrow('the read gave up');
    expect(await session()).toEqual({ pid: before.pid, statement: '0', idle: '0', inTx: false });
  });

  it('survives a server that ends the session while the read waits, and destroys it', async () => {
    // The idle bound ends the session while the read waits between two
    // statements. The server's FATAL reaches the client as an error event,
    // and with no listener on it Node would end this process.
    const before = await session();
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown): void => { uncaught.push(error); };
    process.on('uncaughtException', onUncaught);
    try {
      await expect(boundedRead(pool, 'test', 300, 1_300, async (query) => {
        await query('SELECT 1');
        await sleep(1_200);
        await query('SELECT 2');
      })).rejects.toMatchObject({
        message: 'test: terminating connection due to idle-in-transaction timeout',
        cause: { code: '25P03' },
      });
      // The server's error event reached the read's listener, not the process.
      await sleep(100);
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
    }
    const after = await session();
    expect(after.pid).not.toBe(before.pid);
  });

  it('returns the session clean after a statement outlasts the server bound', async () => {
    const before = await session();
    await expect(boundedRead(pool, 'test', 200, 1_200, (query) => query('SELECT pg_sleep(1)')))
      .rejects.toThrow(/statement timeout/);
    expect(await session()).toEqual({ pid: before.pid, statement: '0', idle: '0', inTx: false });
  });

  it('destroys the session when the client stops waiting', async () => {
    // The message is the one the helper matches on. A driver that reworded it
    // would fail here rather than send ROLLBACK down a busy connection.
    const before = await session();
    await expect(boundedRead(pool, 'test', 5_000, 200, (query) => query('SELECT pg_sleep(1)')))
      .rejects.toThrow(/^Query read timeout$/);
    expect((await session()).pid).not.toBe(before.pid);
  });

  it('gives the rollback and the commit a whole bound of their own', async () => {
    // The read ends after its deadline. The rollback, and the commit of a
    // read that finished, must still run to hand back a clean session. The
    // real driver runs every statement; the test only records the bound
    // each one was given.
    const given: [string, number][] = [];
    const record = (client: { query: (...args: unknown[]) => unknown }): void => {
      const query = client.query.bind(client);
      client.query = (config: unknown, ...rest: unknown[]) => {
        if (typeof config === 'object' && config !== null && 'text' in config) {
          const c = config as { text: string; query_timeout?: number };
          given.push([c.text, c.query_timeout ?? 0]);
        }
        return query(config, ...rest);
      };
    };
    pool.once('acquire', record as never);
    await expect(boundedRead(pool, 'test', 2_000, 400, async (query) => {
      await query('SELECT 1');
      await sleep(500);
      throw new Error('the read gave up late');
    })).rejects.toThrow('the read gave up late');
    expect(given.find(([text]) => text === 'ROLLBACK')?.[1]).toBe(400);
    pool.once('acquire', record as never);
    given.length = 0;
    await boundedRead(pool, 'test', 2_000, 400, async (query) => {
      await query('SELECT 1');
      await sleep(500);
    });
    expect(given.find(([text]) => text === 'COMMIT')?.[1]).toBe(400);
  });

  // A write that starts as a read, through a data-modifying WITH, passes the
  // statement check and reaches the server, which the transaction refuses.
  it('refuses a write, since the transaction is read only, and returns the session clean', async () => {
    const before = await session();
    await expect(boundedRead(pool, 'test', 1_000, 2_000, (query) => query(
      `WITH written AS (
         INSERT INTO document (doc_id, kind, title, body, owner, review_by, embedding_status)
         VALUES ('DOC-WRITE', 'document', 'A synthetic title', 'A synthetic body.', 'kb-team',
                 CURRENT_DATE + 30, 'pending')
         RETURNING doc_id)
       SELECT doc_id FROM written`,
    ))).rejects.toThrow(/read-only transaction/);
    expect(await session()).toEqual({ pid: before.pid, statement: '0', idle: '0', inTx: false });
    expect((await pool.query('SELECT count(*)::int AS n FROM document')).rows[0].n).toBe(0);
  });

  it('refuses a bound that is not a finite whole count of timer milliseconds, before taking a connection', async () => {
    const connect = vi.spyOn(pool, 'connect');
    try {
      for (const bad of [Number.NaN, 0, -1, 2_147_483_648, Number.POSITIVE_INFINITY]) {
        await expect(boundedRead(pool, 'test', bad, 1_000, async () => 1)).rejects.toThrow(/test: timeoutMs must be/);
        await expect(boundedRead(pool, 'test', 1_000, bad, async () => 1)).rejects.toThrow(/test: clientTimeoutMs must be/);
      }
      expect(connect).not.toHaveBeenCalled();
    } finally {
      connect.mockRestore();
    }
  });

  it("reports the server's reason, with its code, when the session ends between statements", async () => {
    const before = await session();
    const failure = boundedRead(pool, 'test', 2_000, 3_000, async (query) => {
      const pid = (await query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]!.pid;
      await writer.query('SELECT pg_terminate_backend($1)', [pid]);
      await sleep(100);
      await query('SELECT 1');
    });
    await expect(failure).rejects.toThrow(/^test: terminating connection due to administrator command$/);
    await expect(failure).rejects.toMatchObject({ cause: { code: '57P01' } });
    expect((await session()).pid).not.toBe(before.pid);
  });

  it("reports the statement's own failure when the session ends during it", async () => {
    // The client's own "connection terminated" error arrives after the
    // statement's, while the rollback waits. It is not the reason.
    const before = await session();
    const pid = before.pid;
    const failure = boundedRead(pool, 'test', 5_000, 6_000, (query) => query('SELECT pg_sleep(2)'));
    await sleep(300);
    await writer.query('SELECT pg_terminate_backend($1)', [pid]);
    await expect(failure).rejects.toThrow(/^terminating connection due to administrator command$/);
    await expect(failure).rejects.toMatchObject({ code: '57P01' });
    expect((await session()).pid).not.toBe(pid);
  });

  /** Makes the next session refuse the statement `refused`, and records what it was sent. */
  function refusing(refused: string): string[] {
    const sent: string[] = [];
    pool.once('acquire', ((client: { query: (...args: unknown[]) => unknown }) => {
      const query = client.query.bind(client);
      client.query = (config: unknown, ...rest: unknown[]) => {
        const text = typeof config === 'object' && config !== null && 'text' in config
          ? (config as { text: string }).text
          : String(config);
        sent.push(text);
        if (text === refused) return Promise.reject(new Error(`${refused} refused by the test`));
        return query(config, ...rest);
      };
    }) as never);
    return sent;
  }

  it('destroys a live session whose rollback fails, rather than return it in its transaction', async () => {
    const before = await session();
    const sent = refusing('ROLLBACK');
    await expect(boundedRead(pool, 'test', 2_000, 3_000, async (query) => {
      await query('SELECT 1');
      throw new Error('the read gave up');
    })).rejects.toThrow(/^the read gave up$/);
    expect(sent.at(-1)).toBe('ROLLBACK');
    expect((await session()).pid).not.toBe(before.pid);
  });

  it('destroys the session when its COMMIT fails, and sends no rollback after it', async () => {
    const before = await session();
    const sent = refusing('COMMIT');
    await expect(boundedRead(pool, 'test', 2_000, 3_000, async (query) => {
      await query('SELECT 1');
    })).rejects.toThrow(/^COMMIT refused by the test$/);
    expect(sent.at(-1)).toBe('COMMIT');
    expect(sent).not.toContain('ROLLBACK');
    expect((await session()).pid).not.toBe(before.pid);
  });

  it('bounds the whole read, not each statement alone', async () => {
    // Three statements of 400 ms each, under a server bound of a second and
    // a client bound of a second in all. Each statement alone fits.
    const before = await session();
    await expect(boundedRead(pool, 'test', 1_000, 1_000, async (query) => {
      for (let i = 0; i < 3; i++) await query('SELECT pg_sleep(0.4)');
    })).rejects.toThrow(/^Query read timeout$/);
    expect((await session()).pid).not.toBe(before.pid);
  });

  it('reads every statement from one snapshot', async () => {
    const count = 'SELECT count(*)::int AS n FROM document';
    const [first, second] = await boundedRead(pool, 'test', 2_000, 3_000, async (query) => {
      const a = (await query<{ n: number }>(count))[0]!.n;
      // Committed by another session between the two statements.
      await writer.query(
        `INSERT INTO document (doc_id, kind, title, body, owner, review_by, embedding_status)
         VALUES ('DOC-LATE', 'document', 'A synthetic title', 'A synthetic body.', 'kb-team',
                 CURRENT_DATE + 30, 'pending')`,
      );
      const b = (await query<{ n: number }>(count))[0]!.n;
      return [a, b];
    });
    expect([first, second]).toEqual([0, 0]);
    expect((await pool.query<{ n: number }>(count)).rows[0]!.n).toBe(1);
  });

  // A statement sent with no values went out as a simple query, and Postgres
  // runs every statement a simple query holds. A COMMIT among them ended the
  // READ ONLY transaction, and the write after it ran in a transaction of its
  // own. Every statement is sent as an extended query now, which holds one.
  it('refuses a chained write in a statement sent with no values', async () => {
    const chained = "SELECT 1; COMMIT; INSERT INTO document (doc_id, kind, title, body, owner, review_by, embedding_status) VALUES ('DOC-ESCAPE', 'document', 'A synthetic title', 'A synthetic body.', 'kb-team', CURRENT_DATE + 30, 'pending')";
    await expect(boundedRead(pool, 'test', 2_000, 3_000, async (query) => query(chained))).rejects.toThrow();
    await expect(boundedRead(pool, 'test', 2_000, 3_000, async (query) => query(chained, []))).rejects.toThrow();
    expect((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM document WHERE doc_id = 'DOC-ESCAPE'")).rows[0]!.n)
      .toBe(0);
  });

  // A read that sent COMMIT as a statement of its own ended the transaction,
  // and the INSERT after it committed outside READ ONLY. A statement that does
  // not start as a read is refused before it is sent.
  it.each([
    ['COMMIT'], ['ROLLBACK'], ['END'], ['ABORT'], ['/* a note */ COMMIT'], ['-- a note\nCOMMIT'],
    ["SET transaction_read_only = off"], ['BEGIN'],
  ])('refuses %j sent by the read, and writes nothing after it', async (ender) => {
    const insert = "INSERT INTO document (doc_id, kind, title, body, owner, review_by, embedding_status) VALUES ('DOC-AFTER', 'document', 'A synthetic title', 'A synthetic body.', 'kb-team', CURRENT_DATE + 30, 'pending')";
    await expect(boundedRead(pool, 'test', 2_000, 3_000, async (query) => {
      await query(ender);
      await query(insert);
    })).rejects.toThrow(/refuses a statement that is not a read/);
    await expect(boundedRead(pool, 'test', 2_000, 3_000, async (query) => query(insert)))
      .rejects.toThrow(/refuses a statement that is not a read/);
    expect((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM document WHERE doc_id = 'DOC-AFTER'")).rows[0]!.n)
      .toBe(0);
  });

  // The statement function outlived its read. A chain that swallowed the
  // read's failure sent a data-modifying WITH after the ROLLBACK, and a kept
  // reference sent one inside the next caller's transaction. Each committed.
  it('refuses a statement once its read has started to end', async () => {
    const write = (id: string): string => `WITH written AS (
       INSERT INTO document (doc_id, kind, title, body, owner, review_by, embedding_status)
       VALUES ('${id}', 'document', 'A synthetic title', 'A synthetic body.', 'kb-team', CURRENT_DATE + 30, 'pending')
       RETURNING doc_id) SELECT doc_id FROM written`;
    // The chain's outcome is taken as it settles, so its refusal is never an
    // unhandled rejection while the read is still failing.
    let late: Promise<string> | undefined;
    await expect(boundedRead(pool, 'test', 2_000, 3_000, async (query) => {
      late = query('SELECT 1').then(() => query('SELECT 1/0')).catch(() => undefined)
        .then(() => query(write('DOC-LATE-CHAIN')))
        .then(() => 'sent', (error: Error) => error.message);
      await query('SELECT 1/0');
    })).rejects.toThrow(/division by zero/);
    expect(await late).toMatch(/refuses a statement after its read ended/);

    let kept: ((text: string) => Promise<unknown>) | undefined;
    await boundedRead(pool, 'test', 2_000, 3_000, async (query) => {
      kept = query;
      await query('SELECT 1');
    });
    await expect(kept!(write('DOC-LATE-KEPT'))).rejects.toThrow(/refuses a statement after its read ended/);
    const { rows } = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM document WHERE doc_id IN ('DOC-LATE-CHAIN', 'DOC-LATE-KEPT')",
    );
    expect(rows[0]!.n).toBe(0);
  });

  it('sends each statement that starts as a read', async () => {
    const rows = await boundedRead(pool, 'test', 2_000, 3_000, async (query) => [
      ...(await query<{ n: number }>('  SELECT 1 AS n')),
      ...(await query<{ n: number }>('WITH a AS (SELECT 2 AS n) SELECT n FROM a')),
      ...(await query<{ n: number }>('(SELECT 3 AS n)')),
      ...(await query<{ n: number }>('VALUES (4)')).map((row) => ({ n: Number(Object.values(row)[0]) })),
    ]);
    expect(rows.map((row) => Number(row.n))).toEqual([1, 2, 3, 4]);
  });

  // READ ONLY refuses a write to a table, and nothing that changes the
  // session. A setting made for the session outlived the read on the
  // connection the pool handed out next. The role cannot take an advisory
  // lock, since the restate revokes the functions from PUBLIC.
  it('hands back a session with no setting and no lock the read made', async () => {
    const before = await session();
    await boundedRead(pool, 'test', 2_000, 3_000, async (query) => {
      await query("SELECT set_config('search_path', 'pg_catalog', false)");
    });
    await expect(boundedRead(pool, 'test', 2_000, 3_000, async (query) => {
      await query('SELECT pg_advisory_lock(146)');
    })).rejects.toMatchObject({ code: '42501' });
    const after = await pool.query<{ pid: number; path: string; locks: number }>(
      `SELECT pg_backend_pid() AS pid, current_setting('search_path') AS path,
              (SELECT count(*)::int FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()) AS locks`,
    );
    expect(after.rows[0]!.pid).toBe(before.pid);
    expect(after.rows[0]!.path).not.toBe('pg_catalog');
    expect(after.rows[0]!.locks).toBe(0);
  });
});
