/**
 * IMAP ingress daemon entrypoint (section 4.1). A different process: run
 * via `pnpm run imap` (executes the built dist/imap/main.js).
 *
 * Configuration:
 * - IMAP_HOST         mailbox host (required)
 * - IMAP_PORT         IMAP port (default: 993)
 * - IMAP_USER         login user (required)
 * - IMAP_PASS         login password (required)
 * - IMAP_SECURE       'true' for implicit TLS, 'false' for STARTTLS/plain
 *                     (default: true)
 * - IMAP_INTERVAL_MS  milliseconds between polls (default: 60000)
 * - PARTITION_COUNT   DEC-27 intake partition count (default: 8)
 * - DATABASE_URL      ledger connection (see src/db/config.ts)
 * - PRODUCTS_FILE     the channel map the product is read from
 *                     (default: products.json)
 *
 * All values may live in a ./.env file: this entrypoint loads it at startup
 * when present. An explicit shell env always wins over .env.
 */
import { Pool } from 'pg';

import { loadDotEnv, positiveIntEnv, requiredEnv } from '../config/env.js';
import { productCatalogueFromEnv } from '../config/products.js';
import { requireDbUrl } from '../db/config.js';
import { intakeEnqueuer } from '../intake/adapter.js';
import { startImapDaemon } from './daemon.js';
import { ImapMailboxFetcher, imapFlowFactory } from './fetcher.js';
import { runEntry } from '../cli/entry.js';
import { guardLedgerPool, logLedgerPoolError } from '../db/client-errors.js';

async function main(): Promise<void> {
  loadDotEnv();
  const config = {
    host: requiredEnv('IMAP_HOST'),
    port: positiveIntEnv('IMAP_PORT', 993),
    user: requiredEnv('IMAP_USER'),
    pass: requiredEnv('IMAP_PASS'),
    secure: process.env['IMAP_SECURE'] !== 'false',
  };
  const intervalMs = positiveIntEnv('IMAP_INTERVAL_MS', 60_000);
  const partitionCount = positiveIntEnv('PARTITION_COUNT', 8);

  // Read once, before the first poll (DEC-47). A catalogue that cannot be
  // read refuses this process rather than enqueuing a ticket whose product
  // nothing can resolve.
  const catalogue = productCatalogueFromEnv();

  const pool = guardLedgerPool(new Pool({ connectionString: requireDbUrl('the IMAP ingress'), max: 1 }), logLedgerPoolError('the IMAP ingress'));
  const fetcher = new ImapMailboxFetcher(config, imapFlowFactory(config));

  const daemon = startImapDaemon({
    fetcher,
    onEvent: intakeEnqueuer(pool, partitionCount, catalogue),
    intervalMs,
  });

  await new Promise<void>((resolve) => {
    let stopping = false;
    const shutdown = (): void => {
      if (stopping) return;
      stopping = true;
      void daemon.stop().then(async () => {
        fetcher.stop();
        await pool.end();
        resolve();
      });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}

void runEntry(main);
