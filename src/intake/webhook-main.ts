// Webhook ingress daemon entrypoint (D3-A). Run via `npm run webhook`
// (executes the built dist/intake/webhook-main.js).
//
// Serves the webhook driver and wires every accepted delivery into the
// intake queue through src/intake/adapter.ts — the drivers stay pure; this
// is where database details enter.
//
// Configuration:
// - WEBHOOK_PORT     listen port (default: 8080)
// - PARTITION_COUNT  DEC-27 partition count used at enqueue time
//                    (default: 8, must match the consumers)
// - DATABASE_URL     ledger connection (see src/db/config.ts)
//
// All values may live in a ./.env file: this entrypoint loads it at startup
// when present. An explicit shell env always wins over .env.
//
// Response semantics stay with the driver: 400 for a bad payload, 413 over
// MAX_BODY_BYTES, and 500 when the intake insert fails so an at-least-once
// source redelivers.
import { Pool } from 'pg';

import { dbUrl } from '../db/config.js';
import { createWebhookServer } from '../ingress/webhook-server.js';
import { loadDotEnv } from '../config/env.js';
import { intakeEnqueuer } from './adapter.js';

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got '${raw ?? ''}'`);
  }
  return value;
}

async function main(): Promise<void> {
  loadDotEnv();
  const port = intFromEnv('WEBHOOK_PORT', 8080);
  const partitionCount = intFromEnv('PARTITION_COUNT', 8);

  const pool = new Pool({ connectionString: dbUrl(), max: 1 });
  const server = createWebhookServer({ onEvent: intakeEnqueuer(pool, partitionCount) });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => resolve());
  });
  console.log(
    JSON.stringify({
      event: 'listening',
      at: new Date().toISOString(),
      port,
      partitionCount,
    }),
  );

  await new Promise<void>((resolve) => {
    let stopping = false;
    const shutdown = (): void => {
      if (stopping) return;
      stopping = true;
      // Stop accepting connections first, then release the pool.
      void new Promise<void>((closeResolve) => server.close(() => closeResolve())).then(
        async () => {
          await pool.end();
          resolve();
        },
      );
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
