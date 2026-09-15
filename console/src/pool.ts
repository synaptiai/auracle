// The console's connection pool (issue #101).
//
// Its own module, as `views.ts` is: `main.ts` runs `main()` when it is
// imported, so a setting defined there cannot be reached from a test.
import type { PoolConfig } from 'pg';

/**
 * How long a request waits for a pool connection before it fails.
 *
 * The queue is the landing page, and every load reads the ledger. With four
 * connections busy, a wait with no bound queued requests without end, and the
 * approval surface stopped answering. A request that cannot get a connection
 * in this time fails, and the page names the fault under a log tag.
 */
export const CONSOLE_POOL_CONNECT_TIMEOUT_MS = 3_000;

/** The pool the console reads the ledger through. */
export function consolePoolConfig(connectionString: string): PoolConfig {
  return { connectionString, max: 4, connectionTimeoutMillis: CONSOLE_POOL_CONNECT_TIMEOUT_MS };
}
