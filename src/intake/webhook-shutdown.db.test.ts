// A webhook whose insert is stuck behind a lock still stops within its bounds.
//
// pg's `pool.end()` waits for every checked-out client. An insert blocked by
// a lock never brings its client back, so without a bound the webhook stays
// alive on that client's socket, and a second signal does nothing. Only a
// SIGKILL would end it, and that is the state a bounded shutdown exists to
// avoid.
//
// The case starts the real entry point against this file's own database,
// holds a lock on `intake`, sends one delivery, and asks the webhook to stop.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { SHUTDOWN_GRACE_MS } from '../cli/shutdown.js';
import { dbUrl } from '../db/config.js';
import { WEBHOOK_MINIMAL_PAYLOAD } from '../ingress/fixtures.js';
import { truncateLedger } from '../test-support/schema.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TSX_LOADER = pathToFileURL(`${REPO_ROOT}node_modules/tsx/dist/loader.mjs`).href;
const SCRATCH = mkdtempSync(path.join(tmpdir(), 'auracle-webhook-shutdown-'));
const pool = new Pool({ connectionString: dbUrl(), max: 2 });

afterAll(async () => {
  await pool.end();
  rmSync(SCRATCH, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

describe('the webhook shutdown with a stuck insert', () => {
  it('exits 1 and says so when its pool cannot end in time', async () => {
    await truncateLedger(pool);
    const port = await freePort();
    const child = spawn(
      process.execPath,
      ['--import', TSX_LOADER, `${REPO_ROOT}src/intake/webhook-main.ts`],
      {
        cwd: SCRATCH,
        env: {
          ...process.env,
          DATABASE_URL: dbUrl(),
          WEBHOOK_PORT: String(port),
          PRODUCTS_FILE: `${REPO_ROOT}products.json`,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString(); });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    const killer = setTimeout(() => child.kill('SIGKILL'), 40_000);
    const holder = await pool.connect();
    try {
      await new Promise<void>((resolve, reject) => {
        const poll = setInterval(() => {
          if (!out.includes('"listening"')) return;
          clearInterval(poll);
          resolve();
        }, 50);
        void closed.then(() => {
          clearInterval(poll);
          reject(new Error(`the webhook exited before listening: ${err}`));
        });
      });
      // The lock the delivery's insert waits behind, held for the whole case.
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE intake IN ACCESS EXCLUSIVE MODE');
      const delivery = fetch(`http://127.0.0.1:${port}/webhooks/support`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(WEBHOOK_MINIMAL_PAYLOAD),
      }).catch(() => undefined);
      // Long enough for the insert to reach the lock and wait there.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const asked = Date.now();
      child.kill('SIGTERM');
      const ended = await closed;
      // Two bounded waits: the connections, then the pool.
      expect(Date.now() - asked).toBeLessThan(2 * SHUTDOWN_GRACE_MS + 3_000);
      expect(ended, err).toEqual({ code: 1, signal: null });
      expect(err).toContain('"event":"webhook_pool_end_timeout"');
      await delivery;
    } finally {
      clearTimeout(killer);
      child.kill('SIGKILL');
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  }, 60_000);
});
