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
import { Pool, type PoolClient } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { SHUTDOWN_GRACE_MS } from '../cli/shutdown.js';
import { dbUrl } from '../db/config.js';
import { WEBHOOK_MINIMAL_PAYLOAD } from '../ingress/fixtures.js';
import { lockWaitSeen } from '../test-support/lock-wait.js';
import { truncateLedger } from '../test-support/schema.js';
import { REPO_ROOT, startFromSource, startOnFreePort } from '../test-support/source-process.js';

const SCRATCH = mkdtempSync(path.join(tmpdir(), 'auracle-webhook-shutdown-'));
const pool = new Pool({ connectionString: dbUrl(), max: 2 });

afterAll(async () => {
  await pool.end();
  rmSync(SCRATCH, { recursive: true, force: true });
});

describe('the webhook shutdown with a stuck insert', () => {
  it('exits 1 and says so when its pool cannot end in time', async () => {
    await truncateLedger(pool);
    const started = await startOnFreePort(startListening);
    await started.listening;
    const { child, closed, stderr, port } = started;
    const killer = setTimeout(() => child.kill('SIGKILL'), 40_000);
    let holder: PoolClient | undefined;
    try {
      holder = await pool.connect();
      // The lock the delivery's insert waits behind, held for the whole case.
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE intake IN ACCESS EXCLUSIVE MODE');
      // What the delivery came to, so a refused or failed request names its
      // cause rather than reading as a lock wait that never began.
      let delivered = 'still waiting';
      const delivery = fetch(`http://127.0.0.1:${port}/webhooks/support`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(WEBHOOK_MINIMAL_PAYLOAD),
      }).then(
        (response) => { delivered = `answered ${response.status}`; },
        (error: unknown) => { delivered = `failed: ${error instanceof Error ? error.message : String(error)}`; },
      );
      // The insert has reached the lock the holder takes, and waits there.
      const holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      expect(await lockWaitSeen(pool, { blockedBy: holderPid }), `the delivery waits on the intake lock; it ${delivered}`)
        .toBe(true);
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
      // A connection whose rollback failed goes back to the pool as broken.
      const rollback = await holder?.query('ROLLBACK').then(() => undefined, (error: unknown) => error);
      holder?.release(rollback instanceof Error ? rollback : undefined);
    }
  }, 60_000);
});

/** Starts the webhook from source on `port`, and settles once it listens. */
function startListening(port: number) {
  const run = startFromSource('src/intake/webhook-main.ts', {
    cwd: SCRATCH,
    // The case's own bound, so a child that never listens and never exits
    // ends with the case rather than outliving it.
    deadlineMs: 50_000,
    env: {
      ...process.env,
      DATABASE_URL: dbUrl(),
      WEBHOOK_PORT: String(port),
      PRODUCTS_FILE: `${REPO_ROOT}products.json`,
    },
  });
  const listening = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      clearInterval(poll);
      run.child.kill('SIGKILL');
      reject(new Error(`no listening line within 20s: ${run.stderr()}`));
    }, 20_000);
    const poll = setInterval(() => {
      if (!run.stdout().includes('"listening"')) return;
      clearInterval(poll);
      clearTimeout(timer);
      resolve();
    }, 50);
    void run.closed.then(() => {
      clearInterval(poll);
      clearTimeout(timer);
      reject(new Error(`the webhook exited before listening: ${run.stderr()}`));
    });
  });
  return { ...run, port, listening };
}

