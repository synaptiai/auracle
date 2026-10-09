// Which ledger the console says it is bound to.
//
// Its own module rather than a function in `main.ts`, because `main.ts` runs
// its `main()` on import: no test can load that file without opening a pool
// and a socket, which is why `lifecycle.test.ts` scans it as text instead. A
// function that decides what does and does not reach a page needs a case that
// runs it, not a case that reads it.
/**
 * The ledger's host and database, in words an operator can check.
 *
 * The rail shows it because this console approves customer replies, and an
 * operator pointed at a demo database would work a synthetic backlog as real
 * escalations — `src/escalations/query.ts` carries the same warning about
 * seeded runs reaching the queue exactly like produced ones.
 *
 * The credentials never reach the page. `DATABASE_URL` carries a password,
 * this console draws every page for a reviewer, and those two facts together
 * are how a connection string ends up on a screen someone else is reading.
 */
export function ledgerName(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
    const where = url.port === '' ? url.hostname : `${url.hostname}:${url.port}`;
    if (where === '') return 'the configured ledger';
    return database === '' ? where : `${where}/${database}`;
  } catch {
    // A string `pg` accepts but `URL` does not — a key-value DSN, for one.
    // Naming the shape beats printing it, because printing it is how the
    // password reaches the page.
    return 'the configured ledger';
  }
}
