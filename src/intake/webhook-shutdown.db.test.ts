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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { SHUTDOWN_GRACE_MS } from '../cli/shutdown.js';
import { dbUrl } from '../db/config.js';
import { WEBHOOK_MINIMAL_PAYLOAD } from '../ingress/fixtures.js';
import { truncateLedger } from '../test-support/schema.js';
import { REPO_ROOT, freePort, startFromSource } from '../test-support/source-process.js';

const SCRATCH = mkdtempSync(path.join(tmpdir(), 'auracle-webhook-shutdown-'));
const pool = new Pool({ connectionString: dbUrl(), max: 2 });

afterAll(async () => {
  await pool.end();
  rmSync(SCRATCH, { recursive: true, force: true });
});

describe('the webhook shutdown with a stuck insert', () => {
  it('exits 1 and says so when its pool cannot end in time', async () => {
    await truncateLedger(pool);
    // The port was free when the probe closed, and another process can take
    // it before the child binds. A start that fails on exactly that tries a
    // fresh port.
    let started: Awaited<ReturnType<typeof startListening>> | undefined;
    for (let attempt = 1; started === undefined; attempt += 1) {
      const port = await freePort();
      const run = startListening(port);
      const failed = await run.listening.then(() => null, (error: unknown) => error);
      if (failed === null) started = run;
      else if (!run.stderr().includes('EADDRINUSE') || attempt === 5) throw failed;
    }
    const { child, closed, stderr, port } = started;
    const killer = setTimeout(() => child.kill('SIGKILL'), 40_000);
    const holder = await pool.connect();
    try {
      // The lock the delivery's insert waits behind, held for the whole case.
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE intake IN ACCESS EXCLUSIVE MODE');
      const delivery = fetch(`http://127.0.0.1:${port}/webhooks/support`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(WEBHOOK_MINIMAL_PAYLOAD),
      }).catch(() => undefined);
      // The insert has reached the lock and waits there.
      await waitForALockWait();
      const asked = Date.now();
      child.kill('SIGTERM');
      const ended = await closed;
      // Two bounded waits: the connections, then the pool.
      expect(Date.now() - asked).toBeLessThan(2 * SHUTDOWN_GRACE_MS + 3_000);
      expect(ended, stderr()).toEqual({ code: 1, signal: null });
      expect(stderr()).toContain('"event":"webhook_pool_end_timeout"');
      await delivery;
    } finally {
      clearTimeout(killer);
      child.kill('SIGKILL');
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  }, 60_000);
});

/** Starts the webhook from source on `port`, and settles once it listens. */
function startListening(port: number) {
  const run = startFromSource('src/intake/webhook-main.ts', {
    cwd: SCRATCH,
    env: {
      ...process.env,
      DATABASE_URL: dbUrl(),
      WEBHOOK_PORT: String(port),
      PRODUCTS_FILE: `${REPO_ROOT}products.json`,
    },
  });
  const listening = new Promise<void>((resolve, reject) => {
    const poll = setInterval(() => {
      if (!run.stdout().includes('"listening"')) return;
      clearInterval(poll);
      resolve();
    }, 50);
    void run.closed.then(() => {
      clearInterval(poll);
      reject(new Error(`the webhook exited before listening: ${run.stderr()}`));
    });
  });
  return { ...run, port, listening };
}

/** Resolves once a session on this file's database waits on a lock. */
async function waitForALockWait(): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const waiting = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if ((waiting.rows[0]?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('the delivery never waited on the intake lock');
}
