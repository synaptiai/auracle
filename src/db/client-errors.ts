// A connection to the ledger that fails (the ledger restarts, a failover, a
// terminated backend, a reset network) must not end the process.
//
// node-postgres reports that failure as an 'error' event, not as a thrown
// error, and Node ends a process on an 'error' event nobody hears. No
// try/catch sees it, because nothing was thrown. It can arrive two ways:
//
//   held   while a caller holds the client in a transaction. The pool does
//          not listen on a client it has handed out, so the client's own
//          'error' event is the one that would end the process.
//   idle   after the client is back in the pool. The usual path: a statement
//          that fails rejects, the caller releases the client as usual, and
//          the socket's end arrives a moment later. The pool hears it and
//          emits 'error' on itself, and that event would end the process.
//
// `boundedRead` listens on the client it holds. Every other caller goes
// through `pool.connect()` or `pool.query()` with no listener, so this puts
// one on each client the pool opens, and one on the pool. Neither throws, and
// neither changes what a caller sees: the statement that was running rejects
// with its own error, later statements on that client reject too, and the
// pool destroys the client, because a client that failed is not queryable.
// What the listeners remove is only the process exit.
//
// The statement's own rejection is the report of a failure under a caller.
// The log line comes on top of it, where the pool or the client still
// hears the event: always for a connection that fails with no statement
// running, and not when the pool destroys the client first. Its reason may
// be the client's ("Connection terminated unexpectedly") rather than the
// server's.
//
// The console, a consumer, the relay and both ingress processes run for as
// long as they stay up, so for them the exposure is their whole uptime.
import type { Pool, PoolClient } from 'pg';

import { logLine } from '../log/line.js';

/** The clients a caller holds right now. An idle failure is heard on the pool. */
const HELD: WeakSet<PoolClient> = new WeakSet();
/** The clients whose failure was already reported. A failed client is never reused. */
const REPORTED: WeakSet<PoolClient> = new WeakSet();
const GUARDED: WeakSet<Pool> = new WeakSet();

export interface LedgerClientError {
  readonly message: string;
  readonly code: string | null;
  /** A caller held the client when it failed. */
  readonly held: boolean;
}

/**
 * Listens for a failure on every client `pool` opens and on the pool itself,
 * so a connection that fails cannot end the process. `onError` hears a
 * failure at most once per client, whether a caller held it or the pool did.
 *
 * Idempotent per pool: a second call adds nothing.
 */
export function guardLedgerPool(pool: Pool, onError: (error: LedgerClientError) => void): Pool {
  if (GUARDED.has(pool)) return pool;
  GUARDED.add(pool);
  const report = (client: PoolClient | undefined, error: Error & { code?: string }, held: boolean): void => {
    // One client can emit twice, the server's message and then the client's
    // "terminated unexpectedly". It is reported once, with whichever came first.
    if (client !== undefined) {
      if (REPORTED.has(client)) return;
      REPORTED.add(client);
    }
    onError({ message: error.message, code: error.code ?? null, held });
  };
  pool.on('connect', (client: PoolClient) => {
    client.on('error', (error: Error & { code?: string }) => {
      // An idle client's failure reaches the pool's listener below.
      if (HELD.has(client)) report(client, error, true);
    });
  });
  pool.on('error', (error: Error & { code?: string }, client: PoolClient) => {
    report(client, error, false);
  });
  pool.on('acquire', (client: PoolClient) => {
    HELD.add(client);
  });
  pool.on('release', (_error: Error | undefined, client: PoolClient) => {
    HELD.delete(client);
  });
  return pool;
}

/**
 * The listener every process passes: one log line naming the process, the
 * failure, its code, and whether a caller held the connection.
 */
export function logLedgerPoolError(processName: string): (error: LedgerClientError) => void {
  return (error) => {
    console.error(logLine({
      event: 'db_client_failed',
      at: new Date().toISOString(),
      process: processName,
      held: error.held,
      error: error.message,
      code: error.code,
    }));
  };
}
