// A connection that fails while a caller holds it must not end the process.
//
// Each case holds a real client in a transaction, has a second session end
// that client's backend, and asks what happened: the caller's own statement
// rejects, no uncaught error reaches the process, and the next checkout gets
// a fresh session.
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { dbUrl } from './config.js';
import { guardLedgerPool } from './client-errors.js';
import type { LedgerClientError } from './client-errors.js';

const killer = new Pool({ connectionString: dbUrl(), max: 1 });
const pools: Pool[] = [];

afterAll(async () => {
  await Promise.all(pools.map((pool) => pool.end()));
  await killer.end();
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs `body` with an uncaught-error listener, and answers what it caught. */
async function catchingUncaught(body: () => Promise<void>): Promise<unknown[]> {
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown): void => { uncaught.push(error); };
  process.on('uncaughtException', onUncaught);
  try {
    await body();
    await sleep(100);
  } finally {
    process.off('uncaughtException', onUncaught);
  }
  return uncaught;
}

describe('a ledger connection that fails', () => {
  it('rejects the caller that held it, reaches no uncaught handler, and leaves the pool usable', async () => {
    const heard: LedgerClientError[] = [];
    const pool = guardLedgerPool(new Pool({ connectionString: dbUrl(), max: 1 }), (error) => heard.push(error));
    pools.push(pool);
    const uncaught = await catchingUncaught(async () => {
      const client = await pool.connect();
      let broken: Error | undefined;
      try {
        await client.query('BEGIN');
        const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
        await killer.query('SELECT pg_terminate_backend($1)', [pid]);
        await sleep(200);
        await expect(client.query('SELECT 1')).rejects.toThrow();
        broken = new Error('the test ended the session');
      } finally {
        client.release(broken);
      }
    });
    expect(uncaught).toEqual([]);
    expect(heard).toEqual([expect.objectContaining({ code: '57P01', held: true })]);
    // The next checkout is a new, working session.
    expect((await pool.query<{ one: number }>('SELECT 1 AS one')).rows[0]!.one).toBe(1);
  });

  // The usual path: the statement rejects, the caller releases the client as
  // it always does, and the socket ends once the client is idle again.
  it('survives a statement ended mid-flight whose client the caller released as usual', async () => {
    const heard: LedgerClientError[] = [];
    const pool = guardLedgerPool(new Pool({ connectionString: dbUrl(), max: 1 }), (error) => heard.push(error));
    pools.push(pool);
    const uncaught = await catchingUncaught(async () => {
      const client = await pool.connect();
      const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      // Its rejection is captured at once: it can arrive while this test
      // still awaits the kill, and a rejection nothing handles yet is a
      // failure of its own.
      const sleeping = client.query('SELECT pg_sleep(5)').then(() => null, (error: unknown) => error);
      await sleep(200);
      await killer.query('SELECT pg_terminate_backend($1)', [pid]);
      expect(await sleeping).toBeInstanceOf(Error);
      client.release();
      await sleep(300);
    });
    expect(uncaught).toEqual([]);
    expect(heard).toEqual([expect.objectContaining({ held: false })]);
    expect((await pool.query<{ one: number }>('SELECT 1 AS one')).rows[0]!.one).toBe(1);
  });

  it('survives an idle client whose session ends, and hears it once', async () => {
    const heard: LedgerClientError[] = [];
    const pool = guardLedgerPool(new Pool({ connectionString: dbUrl(), max: 1 }), (error) => heard.push(error));
    pools.push(pool);
    const uncaught = await catchingUncaught(async () => {
      const pid = (await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      await killer.query('SELECT pg_terminate_backend($1)', [pid]);
      await sleep(200);
    });
    expect(uncaught).toEqual([]);
    expect(heard).toEqual([expect.objectContaining({ held: false })]);
  });

  it('adds its listeners once however often a pool is guarded', () => {
    const pool = new Pool({ connectionString: dbUrl(), max: 1 });
    pools.push(pool);
    guardLedgerPool(pool, () => undefined);
    guardLedgerPool(pool, () => undefined);
    expect(pool.listenerCount('connect')).toBe(1);
    expect(pool.listenerCount('error')).toBe(1);
  });
});
