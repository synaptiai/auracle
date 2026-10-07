// Webhook ingress daemon entrypoint (D3-A). Run via `pnpm run webhook`
// (executes the built dist/intake/webhook-main.js).
//
// Serves the webhook driver and wires every accepted delivery into the
// intake queue through src/intake/adapter.ts — the drivers stay pure; this
// is where database details enter.
//
// Configuration:
// - WEBHOOK_PORT     listen port (default: 8080)
// - WEBHOOK_HOST     the interface to bind (default: 127.0.0.1). With no
//                    WEBHOOK_SECRET the webhook accepts every request, so it
//                    reaches past this machine only when an operator says so.
// - PARTITION_COUNT  DEC-27 partition count used at enqueue time
//                    (default: 8, must match the consumers)
// - DATABASE_URL     ledger connection (see src/db/config.ts)
// - PRODUCTS_FILE    the channel map the product is read from
//                    (default: products.json)
//
// All values may live in a ./.env file: this entrypoint loads it at startup
// when present. An explicit shell env always wins over .env.
//
// Response semantics stay with the driver: 400 for a bad payload, 413 over
// MAX_BODY_BYTES, and 500 when the intake insert fails so an at-least-once
// source redelivers.
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';

import { requireDbUrl } from '../db/config.js';
import { createWebhookServer } from '../ingress/webhook-server.js';
import { hostEnv, loadDotEnv, positiveIntEnv } from '../config/env.js';
import { productCatalogueFromEnv } from '../config/products.js';
import { intakeEnqueuer } from './adapter.js';
import { runEntry } from '../cli/entry.js';
import { SHUTDOWN_GRACE_MS, endWithin } from '../cli/shutdown.js';
import { logLine } from '../log/line.js';
import { guardLedgerPool, logLedgerPoolError } from '../db/client-errors.js';

async function main(): Promise<void> {
  loadDotEnv();
  const port = positiveIntEnv('WEBHOOK_PORT', 8080);
  const host = hostEnv('WEBHOOK_HOST', '127.0.0.1');
  const partitionCount = positiveIntEnv('PARTITION_COUNT', 8);

  // Read once, before the listener opens. DEC-47 needs the channel map for
  // every delivery, and a map read per delivery would answer the first one
  // and then fail the ones an operator is editing. A catalogue that cannot
  // be read refuses this process rather than enqueuing a ticket whose
  // product nothing can resolve.
  const catalogue = productCatalogueFromEnv();

  const pool = guardLedgerPool(new Pool({ connectionString: requireDbUrl('the webhook ingress'), max: 1 }), logLedgerPoolError('the webhook ingress'));
  const server = createWebhookServer({
    onEvent: intakeEnqueuer(pool, partitionCount, catalogue),
    // Absent means the driver runs open and says so at startup.
    secret: process.env['WEBHOOK_SECRET'],
  });

  // listen() reports a bind failure with an error that names no variable,
  // so the refusal names the two that chose the address.
  await new Promise<void>((resolve, reject) => {
    const refuse = (error: Error): void => {
      reject(new Error(
        `WEBHOOK_HOST '${host}' with WEBHOOK_PORT ${port} cannot be bound: ${error.message}`,
      ));
    };
    server.once('error', refuse);
    server.listen(port, host, () => {
      server.off('error', refuse);
      resolve();
    });
  });
  // A fault after startup, such as running out of file descriptors, is
  // logged rather than lost. Without a listener Node throws it as uncaught.
  server.on('error', (error: Error & { code?: string }) => {
    console.error(logLine({
      event: 'webhook_server_error',
      at: new Date().toISOString(),
      error: error.message,
      code: error.code ?? null,
    }));
  });
  console.log(
    logLine({
      event: 'listening',
      at: new Date().toISOString(),
      // The address the server bound, not the one asked for.
      host: (server.address() as AddressInfo).address,
      port,
      partitionCount,
    }),
  );

  await new Promise<void>((resolve) => {
    let stopping = false;
    const shutdown = (): void => {
      if (stopping) return;
      stopping = true;
      // Stop accepting connections first, then release the pool. A failure
      // to close is logged and exits 1, so no promise is left unsettled.
      const closing = new Promise<void>((closeResolve) => server.close(() => closeResolve()));
      // A request still arriving holds close() to Node's 300 s request
      // timeout. So the webhook cuts every connection after a bounded wait.
      // The intake insert is one transaction, and the source sends a cut
      // request again.
      server.closeIdleConnections();
      const cutoff = setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS);
      cutoff.unref();
      void closing
        .then(async () => {
          // An insert stuck behind a lock keeps its client, and pool.end()
          // waits for it. The end gets the same bounded wait. After it, that
          // client's socket would keep the process alive, so the webhook
          // exits on its own. The insert is one transaction, so nothing half
          // written stays behind.
          if (await endWithin(() => pool.end(), SHUTDOWN_GRACE_MS) === 'timeout') {
            console.error(logLine({
              event: 'webhook_pool_end_timeout',
              at: new Date().toISOString(),
              waitedMs: SHUTDOWN_GRACE_MS,
            }));
            process.exit(1);
          }
        })
        .catch((error: unknown) => {
          console.error(logLine({
            event: 'webhook_shutdown_failed',
            at: new Date().toISOString(),
            error: error instanceof Error ? error.message : String(error),
          }));
          process.exitCode = 1;
        })
        .finally(() => resolve());
    };
    // `on`, not `once`. A second signal while the first drains would
    // otherwise take Node's default action and end the process at once.
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}

void runEntry(main);
