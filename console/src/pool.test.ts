// The console's connection pool (issue #101).
//
// The queue is the landing page, and every load reads the ledger. A wait for a
// connection with no bound queues requests without end once the pool is busy,
// so the approval surface stops answering. The bound turns that wait into a
// fault the page names.
import type { AddressInfo, Server, Socket } from 'node:net';
import { createServer } from 'node:net';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { CONSOLE_POOL_CONNECT_TIMEOUT_MS, consolePoolConfig } from './pool.js';

describe('the console pool', () => {
  it('bounds the wait for a connection, and keeps four connections', () => {
    const config = consolePoolConfig('postgres://synthetic@localhost:5433/ledger');
    expect(config.connectionString).toBe('postgres://synthetic@localhost:5433/ledger');
    expect(config.max).toBe(4);
    expect(config.connectionTimeoutMillis).toBe(CONSOLE_POOL_CONNECT_TIMEOUT_MS);
    expect(CONSOLE_POOL_CONNECT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(CONSOLE_POOL_CONNECT_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });

  // The bound, observed. A server that accepts a connection and never answers
  // stands in for a ledger that cannot take one more: the pool gives up at its
  // bound instead of waiting without end. No database is involved.
  it('fails a connection that never answers at its bound', async () => {
    const sockets: Socket[] = [];
    const silent: Server = createServer((socket) => { sockets.push(socket); });
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const { port } = silent.address() as AddressInfo;
    const pool = new Pool(consolePoolConfig(`postgres://synthetic@127.0.0.1:${port}/ledger`));
    try {
      const started = Date.now();
      await expect(pool.connect()).rejects.toThrow(/timeout/i);
      const waited = Date.now() - started;
      expect(waited).toBeGreaterThanOrEqual(CONSOLE_POOL_CONNECT_TIMEOUT_MS - 100);
      expect(waited).toBeLessThan(CONSOLE_POOL_CONNECT_TIMEOUT_MS + 2_000);
    } finally {
      await pool.end();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  }, 10_000);
});
