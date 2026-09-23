/**
 * Relay daemon entrypoint (section 4.4). The relay is a different process:
 * run via `pnpm run relay` (executes the built dist/relay/main.js).
 *
 * Configuration:
 * - RELAY_ADAPTER     egress adapter name (default: helpdesk; known values:
 *                     helpdesk, imap-smtp, freescout)
 * - RELAY_INTERVAL_MS milliseconds between scans (default: 5000)
 * - DATABASE_URL      ledger connection (see src/db/config.ts)
 *
 * All values may live in a ./.env file: this entrypoint loads it at startup
 * when present. An explicit shell env always wins over .env.
 *
 * The delivery rule is never configured here. Every record carries its own
 * rule in `outbox.delivery` and the relay reads it per record (DEC-29).
 */
import { Pool } from 'pg';

import { FreeScoutEgressAdapter, freeScoutConfigFromEnv } from '../adapters/freescout.js';
import { HelpdeskAdapter } from '../adapters/helpdesk.js';
import { SmtpEgressAdapter, imapSmtpConfigFromEnv } from '../adapters/imap-smtp.js';
import { knownEntry } from '../adapters/performs.js';
import type { EgressAdapter } from '../adapters/types.js';
import { loadDotEnv, positiveIntEnv } from '../config/env.js';
import { requireDbUrl } from '../db/config.js';
import { startRelayDaemon } from './daemon.js';
import { runEntry } from '../cli/entry.js';

const EGRESS_ADAPTERS: Readonly<Record<string, () => EgressAdapter>> = {
  helpdesk: () => new HelpdeskAdapter(),
  'imap-smtp': () => new SmtpEgressAdapter(imapSmtpConfigFromEnv()),
  freescout: () => new FreeScoutEgressAdapter(freeScoutConfigFromEnv()),
};

async function main(): Promise<void> {
  loadDotEnv();
  // An own entry only: `RELAY_ADAPTER=constructor` is an unknown name, not a
  // function every object inherits.
  const adapter = knownEntry(EGRESS_ADAPTERS, process.env['RELAY_ADAPTER'] ?? 'helpdesk', 'RELAY_ADAPTER')();
  const intervalMs = positiveIntEnv('RELAY_INTERVAL_MS', 5000);
  const pool = new Pool({ connectionString: requireDbUrl('the relay'), max: 1 });

  const daemon = startRelayDaemon({ pool, adapter, intervalMs });

  // SIGTERM/SIGINT: stop scanning, let the in-flight record finish, close
  // the ledger pool, exit. A second signal is ignored while draining.
  await new Promise<void>((resolve) => {
    let stopping = false;
    const shutdown = (): void => {
      if (stopping) return;
      stopping = true;
      void daemon.stop().then(async () => {
        await pool.end();
        resolve();
      });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}

void runEntry(main);
