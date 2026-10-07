// A read-only transaction that cannot hold a connection past its bound.
//
// The console runs some reads on every load of a page. Such a read should not
// wait on the ledger, so each one runs under two bounds: a statement timeout
// the server enforces on each statement, and a client deadline over the
// statements of the whole read.
import type { Pool, QueryConfig, QueryResultRow } from 'pg';

import { READER_ROLE } from './reader-role-name.js';

/** The longest delay a Node timer keeps; a longer one fires after 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * A statement that starts as a read. Inside a transaction block, no such
 * statement can end the transaction, and an extended query holds one
 * statement. A leading comment is refused as well, which is the safe way to
 * be wrong.
 */
const READ_STATEMENT = /^\s*(?:\(|(?:select|with|values|table)\b)/i;

/** The message node-pg gives a query that outlasted its `query_timeout`. */
const CLIENT_TIMEOUT = 'Query read timeout';

/**
 * Who the session is, and whether it is the role named by $1 and nothing
 * more (issue #153). `who` is the user the connection logged in as.
 *
 * It names the role rather than testing for rights, because a role with
 * none of the superuser's rights can still own the tables. It reads the
 * login user, because SET ROLE and SET SESSION AUTHORIZATION change
 * current_user and session_user. It refuses a role with any attribute
 * beyond a login: superuser, replication, RLS bypass, or the right to create
 * a database or a role. It refuses a role that holds any membership,
 * because a membership lets a read take that role with set_config('role').
 * And it refuses a role that owns an object here or on the server, because
 * an owner can write to what it owns outside a read.
 */
export const SESSION_CHECK = sessionCheck('$1');

/** SESSION_CHECK with the role in another parameter, for a statement that has others. */
function sessionCheck(role: '$1' | '$2'): string {
  return `SELECT a.usename AS who,
       (a.usename = ${role} AND session_user = ${role}
        AND NOT (r.rolsuper OR r.rolreplication OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole)
        AND NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid)
        AND NOT EXISTS (SELECT 1 FROM pg_shdepend o
                         WHERE o.refobjid = r.oid AND o.deptype = 'o'
                           AND o.classid <> 'pg_default_acl'::regclass
                           AND o.dbid IN (0, (SELECT oid FROM pg_database WHERE datname = current_database())))) AS reader
  FROM pg_stat_activity a
  LEFT JOIN pg_roles r ON r.rolname = session_user
 WHERE a.pid = pg_backend_pid()`;
}

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
 * end of the read — its COMMIT or ROLLBACK, and the discard of the session's
 * state after it — shares one more whole bound. So a read that finished, or
 * failed, just before the deadline still hands back a clean session, and the
 * read holds the connection twice the bound at most.
 *
 * The read may send only a statement that starts as a read: SELECT, WITH,
 * VALUES, TABLE or a parenthesis. Any other is refused before it is sent. A
 * read that sent `COMMIT` as a statement of its own ended the transaction,
 * and every statement after it ran outside READ ONLY and committed.
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
  // a statement issued after the deadline times out at once. The end of the
  // read shares one whole bound from the moment it starts, so a read that
  // ends near the deadline can still hand back a clean session.
  //
  // `queryMode` is the same kind of option. node-pg sends a statement with no
  // values as a simple query, and Postgres runs every statement a simple
  // query holds. So `SELECT 1; COMMIT; INSERT …` ended the READ ONLY
  // transaction, and the INSERT committed on its own. An extended query holds
  // exactly one statement, and the server refuses a second.
  let endBy: number | undefined;
  const bounded = (text: string, values?: unknown[], ending = false): QueryConfig => {
    if (ending) endBy ??= Date.now() + bound;
    const left = Math.max(1, (ending ? endBy! : deadline) - Date.now());
    const config: QueryConfig & { readonly query_timeout: number; readonly queryMode: 'extended' } = {
      text, query_timeout: left, queryMode: 'extended', ...(values === undefined ? {} : { values }),
    };
    return config;
  };
  // READ ONLY refuses a write to a table, and nothing that changes the
  // session. A setting made for the session, a prepared statement and a
  // LISTEN each outlive the read on the connection the pool hands out next.
  // A pool that is not the readers' role can also hold an advisory lock. So each read ends
  // by discarding the session's state. A connection whose state cannot be
  // discarded is destroyed rather than returned.
  const discard = async (): Promise<boolean> => {
    try {
      await client.query(bounded('DISCARD ALL', undefined, true));
      return true;
    } catch {
      return false;
    }
  };
  // Whether the read has started to end. The statement function outlives the
  // read: a chain that swallowed the read's failure, or a reference kept past
  // its return, sent a statement after the ROLLBACK or inside the next
  // caller's transaction, and a data-modifying WITH committed. So the flag is
  // set before the end's first await, and every statement after it is
  // refused.
  let ended = false;
  const query: BoundedQuery = async <R extends QueryResultRow>(text: string, values?: unknown[]) => {
    if (ended) throw new Error(`${name}: refuses a statement after its read ended`);
    if (!READ_STATEMENT.test(text)) {
      throw new Error(`${name}: refuses a statement that is not a read: ${text.trimStart().slice(0, 40)}`);
    }
    return (await client.query<R>(bounded(text, values))).rows;
  };
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
    //
    // The same statement asks who the session is (issue #153). READ ONLY
    // refuses a write to a table and nothing else: a superuser's read can
    // still end another session, write to the catalog or create a replication
    // slot. The readers connect as auracle_reader, a role with none of those
    // rights, and any other session is refused before the read runs. The
    // rules are SESSION_CHECK's.
    //
    // The search path names pg_temp last, so no temporary object a session
    // left behind stands in front of a table a reader names.
    const checked = await client.query<{ who: string | null; reader: boolean | null }>(bounded(
      `SELECT set_config('statement_timeout', $1, true),
              set_config('idle_in_transaction_session_timeout', $1, true),
              set_config('search_path', 'public, pg_temp', true),
              s.who, s.reader
         FROM (${sessionCheck('$2')}) s`,
      [String(Math.trunc(timeoutMs)), READER_ROLE],
    ));
    const session = checked.rows[0];
    if (session === undefined || session.reader !== true) {
      throw new Error(
        `${name}: refuses a session as '${session?.who ?? 'unknown'}', which can act beyond a read; `
          + `connect the readers with READER_DATABASE_URL, as ${READER_ROLE}`,
      );
    }
    result = await read(query);
    ended = true;
    committing = true;
    await client.query(bounded('COMMIT', undefined, true));
  } catch (error) {
    ended = true;
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
    release(!(await discard()));
    throw reasoned(error);
  }
  // The read succeeded, so its result stands whether or not the session's
  // state could be discarded. Only the connection's fate depends on that.
  release(!(await discard()));
  return result;
}
