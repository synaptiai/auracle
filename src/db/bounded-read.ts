// A read-only transaction that cannot hold a connection past its bound.
//
// The console runs some reads on every load of a page. Such a read should not
// wait on the ledger, so each one runs under two bounds: a statement timeout
// the server enforces on each statement, and a client deadline over the
// statements of the whole read.
import type { Pool, QueryConfig, QueryResultRow } from 'pg';

/** The longest delay a Node timer keeps; a longer one fires after 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

/** The message node-pg gives a query that outlasted its `query_timeout`. */
const CLIENT_TIMEOUT = 'Query read timeout';

/** One statement inside the read, under the client bound. */
export type BoundedQuery = <R extends QueryResultRow>(
  text: string,
  values?: unknown[],
) => Promise<R[]>;

/**
 * Runs `read` in one READ ONLY transaction, and returns what it returns.
 *
 * Every statement `read` issues sees one snapshot, because the transaction
 * holds it at REPEATABLE READ. The statement timeout is local to the
 * transaction, so it cannot outlive the read. It bounds each statement.
 *
 * `clientTimeoutMs` bounds the statements of the read, however many it
 * issues. A connection that died answers no statement timeout, because the
 * server cannot reach the client, so the client keeps this deadline itself.
 * A statement that outlasts it fails, and its connection is destroyed rather
 * than returned, so neither a dead socket nor a long read keeps a pool slot.
 * Time `read` spends between statements is the server's idle bound's. The
 * COMMIT or the ROLLBACK that ends the read gets one more whole bound, so a
 * read that finished, or failed, just before the deadline still hands back a
 * clean session, and the read holds the connection twice the bound at most.
 * Nothing here bounds the wait for a connection from the pool. That bound is
 * the pool's own.
 *
 * `name` is the caller, and it opens each refusal of a bound.
 */
export async function boundedRead<T>(
  pool: Pool,
  name: string,
  timeoutMs: number,
  clientTimeoutMs: number,
  read: (query: BoundedQuery) => Promise<T>,
): Promise<T> {
  // A bound outside what both ends honour bounds nothing, or everything.
  // Postgres reads a `statement_timeout` of 0 as no limit and refuses NaN.
  // node-pg drops a `query_timeout` of NaN or 0. Node's timers turn anything
  // above 2147483647 ms, Infinity included, into one millisecond. Refused
  // before a connection is taken.
  for (const [label, value] of [['timeoutMs', timeoutMs], ['clientTimeoutMs', clientTimeoutMs]] as const) {
    if (!Number.isFinite(value) || value < 1 || value > MAX_TIMER_MS) {
      throw new Error(`${name}: ${label} must be between 1 and ${MAX_TIMER_MS} milliseconds, got ${value}`);
    }
  }
  const client = await pool.connect();
  // The pool listens for a client's errors only while the client is idle.
  // A server that ends the session during the read, the idle bound below
  // included, emits `error` on the client, and with no listener Node throws
  // it and the process exits. So the read listens while it holds the client,
  // and a client that errored is destroyed rather than returned.
  //
  // The first such error is kept. The query that fails next reports only that
  // the client is not queryable, and the server's own reason, such as the
  // idle bound, is the one an operator needs in the log.
  let broken = false;
  let cause: Error | undefined;
  const onError = (error: Error): void => {
    broken = true;
    cause ??= error;
  };
  client.on('error', onError);
  const release = (destroy: boolean): void => {
    client.off('error', onError);
    client.release(destroy || broken);
  };
  const bound = Math.trunc(clientTimeoutMs);
  const deadline = Date.now() + bound;
  // `query_timeout` is an option node-pg reads on each query, and its type
  // declarations leave it off `QueryConfig`, so it is added here. Each
  // statement gets what is left of the read's deadline, and at least 1 ms, so
  // a statement issued after the deadline times out at once. The COMMIT and
  // the ROLLBACK get the whole bound, so a read that ends near the deadline
  // can still hand back a clean session.
  const bounded = (text: string, values?: unknown[], whole = false): QueryConfig => {
    const left = whole ? bound : Math.max(1, deadline - Date.now());
    const config: QueryConfig & { readonly query_timeout: number } = {
      text, query_timeout: left, ...(values === undefined ? {} : { values }),
    };
    return config;
  };
  const query: BoundedQuery = async <R extends QueryResultRow>(text: string, values?: unknown[]) =>
    (await client.query<R>(bounded(text, values))).rows;
  // The server's reason, when the client errored before the query did. Read
  // from `early`, the error held when the failure reached the catch: one the
  // client emits later, while a rollback waits, is a consequence of the
  // statement's own failure and not its reason. The server's error is the
  // cause, so its code stays on the chain.
  let early: Error | undefined;
  const reasoned = (error: unknown): unknown =>
    early !== undefined && error !== early
      ? new Error(`${name}: ${early.message}`, { cause: early })
      : error;
  let result: T;
  // Whether the COMMIT went out. A COMMIT that fails leaves no transaction to
  // roll back, and a rollback would hold the connection for a third bound.
  let committing = false;
  try {
    // REPEATABLE READ, so the statements share one snapshot. At the default
    // level each statement takes its own, and a read of several could count
    // a row in one statement and list it differently in the next.
    await client.query(bounded('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));
    // The idle bound covers the time `read` spends between statements, which
    // no statement timeout does. Both are local to this transaction.
    await client.query(bounded(
      `SELECT set_config('statement_timeout', $1, true),
              set_config('idle_in_transaction_session_timeout', $1, true)`,
      [String(Math.trunc(timeoutMs))],
    ));
    result = await read(query);
    committing = true;
    await client.query(bounded('COMMIT', undefined, true));
  } catch (error) {
    early = cause;
    // The client gave up waiting. The connection may be dead or still busy,
    // and either way it is not one to hand back. A COMMIT that failed is the
    // same: the session's state is not one to guess at.
    if ((error instanceof Error && error.message === CLIENT_TIMEOUT) || committing) {
      release(true);
      throw reasoned(error);
    }
    // The statement failed, so the transaction is aborted. A rollback that
    // fails as well leaves a connection in an unknown state, and it is
    // destroyed rather than returned.
    try {
      await client.query(bounded('ROLLBACK', undefined, true));
    } catch {
      release(true);
      throw reasoned(error);
    }
    release(false);
    throw reasoned(error);
  }
  release(false);
  return result;
}
