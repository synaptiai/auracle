// A case that needs a statement to be waiting on a lock reads it from
// Postgres, rather than sleeping for a time it hopes is long enough.
import type { Pool } from 'pg';

/**
 * Resolves true once a client session waits on a lock: one that the session
 * `blockedBy` holds when it is given, or any lock in this database when it
 * is not. Resolves false when `withinMs` passes first.
 *
 * Each db suite owns its database, so "any lock in this database" counts no
 * other file's sessions.
 */
export async function lockWaitSeen(
  pool: Pool,
  options: { readonly blockedBy?: number; readonly withinMs?: number } = {},
): Promise<boolean> {
  const until = Date.now() + (options.withinMs ?? 10_000);
  const sql = options.blockedBy === undefined
    ? `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND backend_type = 'client backend'
          AND cardinality(pg_blocking_pids(pid)) > 0`
    : 'SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY (pg_blocking_pids(pid))';
  const params = options.blockedBy === undefined ? [] : [options.blockedBy];
  while (Date.now() < until) {
    const { rows } = await pool.query<{ n: number }>(sql, params);
    if ((rows[0]?.n ?? 0) > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}
