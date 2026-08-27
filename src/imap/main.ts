/**
 * IMAP ingress daemon entrypoint (section 4.1). A different process: run
 * via `npm run imap` (executes the built dist/imap/main.js).
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
 *
 * All values may live in a ./.env file: this entrypoint loads it at startup
 * when present. An explicit shell env always wins over .env.
 */
import { Pool } from 'pg';

import { loadDotEnv } from '../config/env.js';
import { dbUrl } from '../db/config.js';
import { intakeEnqueuer } from '../intake/adapter.js';
import { startImapDaemon } from './daemon.js';
import { ImapMailboxFetcher, imapFlowFactory } from './fetcher.js';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required`);
  }
  return value;
}

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got '${raw}'`);
  }
  return value;
}

async function main(): Promise<void> {
  loadDotEnv();
  const config = {
    host: requiredEnv('IMAP_HOST'),
    port: positiveIntFromEnv('IMAP_PORT', 993),
    user: requiredEnv('IMAP_USER'),
    pass: requiredEnv('IMAP_PASS'),
    secure: process.env['IMAP_SECURE'] !== 'false',
  };
  const intervalMs = positiveIntFromEnv('IMAP_INTERVAL_MS', 60_000);
  const partitionCount = positiveIntFromEnv('PARTITION_COUNT', 8);

  const pool = new Pool({ connectionString: dbUrl(), max: 1 });
  const fetcher = new ImapMailboxFetcher(config, imapFlowFactory(config));

  const daemon = startImapDaemon({
    fetcher,
    onEvent: intakeEnqueuer(pool, partitionCount),
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

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
