// The console is a fifth long-running process, and it is held to the four
// obligations the other four already meet (issue #27).
//
// This guard exists because a mutation pass removed each of them in turn and
// the whole suite stayed green. `console/src/main.ts` is the one module no
// test imports: it opens the pool, wires the surfaces and listens, and doing
// any of that in a unit test would mean a real socket and a real ledger. So
// the properties are asserted structurally, the way
// `src/ledger/clock-reachability.test.ts` asserts the clock seam over the
// four core entry points.
//
// A text scan proves the call is written, not that it works. Two of the four
// were checked by running the built console as well, and the decision
// journal records what came back: a busy port exits 1 naming CONSOLE_HOST
// and CONSOLE_PORT, and an unreachable DATABASE_URL exits 1 before it
// listens. This case is what stops either one from being deleted quietly.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const MAIN = readFileSync(new URL('./main.ts', import.meta.url).pathname, 'utf8');

describe('the console as a long-running process', () => {
  // An idle client that fails arrives as an event, outside every promise
  // chain, so the route's catch-all cannot see it and Node rethrows. The
  // offline jobs guard this and run for seconds; this runs for as long as an
  // operator keeps the page open.
  it('listens for a pool error, so a dropped connection is not a process death', () => {
    expect(MAIN).toMatch(/pool\.on\(\s*'error'/);
  });

  // Order again, and this one was a hang rather than a nuisance.
  //
  // `allowedHosts` refuses a `CONSOLE_ALLOWED_HOSTS` entry that can never
  // match a `Host`. It used to run after the probe, and the probe leaves an
  // idle client in the pool: an idle pg client keeps the event loop alive, so
  // the refusal printed and the process then ran forever. A supervisor saw a
  // live console serving nothing.
  it('reads and refuses its configuration before it opens the pool', () => {
    // The read-back adapter too (issue #102). A FreeScout adapter missing its
    // key refuses where it is built, and built after the pool that refusal
    // would hang the same way.
    expect(MAIN.indexOf('readBackFor(')).toBeGreaterThan(-1);
    // The development reviewer as well (DEC-45). It refuses a console that
    // cannot honour the variable — a compiled entry, or a bind off loopback —
    // and the same idle client would outlive that refusal.
    expect(MAIN.indexOf('developmentReviewer(')).toBeGreaterThan(-1);
    const config = Math.max(
      MAIN.indexOf('requirePort('),
      MAIN.indexOf('allowedHosts(host, port)'),
      MAIN.indexOf('readBackFor('),
      MAIN.indexOf('developmentReviewer('),
    );
    expect(config).toBeGreaterThan(-1);
    expect(config).toBeLessThan(MAIN.indexOf('new Pool('));
  });

  // A failed read-back reaches the page as a sentence with no fault in it, so
  // the fault must reach the log. `approvalFor` and `readBackFor` log it, and
  // their suites prove the lines; this holds the entry point to using them
  // with the console's own log, rather than wiring the adapter by hand.
  it('builds the approval and the read-back through the functions that log them', () => {
    expect(MAIN).toMatch(/readBackFor\(process\.env, selectReadBackAdapter, log\)/);
    expect(MAIN).toMatch(/approve: approvalFor\(\{ pool, approveRun, readBack, log \}\)/);
    expect(MAIN).not.toContain('approveFromConsole');
  });

  // DEC-46: the entry point reads the hold period from the environment. The
  // default and the refusals are `hold-lapse.test.ts`'s, behaviourally; what
  // only this file can check is that the wiring reads it at startup, before
  // the pool or any page exists.
  it('reads the hold period from the environment', () => {
    expect(MAIN).toMatch(/requireHoldLapse\(process\.env\['CONSOLE_HOLD_LAPSE_MS'\]\)/);
    // The read is part of the configuration block: it must precede the pool,
    // because a refusal has to land before a client keeps the loop alive.
    expect(MAIN.indexOf('requireHoldLapse(')).toBeLessThan(MAIN.indexOf('new Pool('));
  });

  // Two paths close the pool, and `pool.end()` rejects on the second call.
  // An unhandled rejection is fatal in Node, so it replaces the exit path it
  // was meant to take.
  it('closes the pool once, however many paths ask for it', () => {
    expect(MAIN).toContain('const endPool =');
    // One real call, inside the guard. Every other site goes through it.
    // Counted over `await pool.end();` rather than `pool.end()`, because the
    // comment above the guard names the method it is guarding.
    expect(MAIN.split('await pool.end();').length - 1).toBe(1);
  });

  // A pool connects lazily, so a wrong URL starts clean and fails one page at
  // a time while reporting itself healthy.
  it('probes the ledger before it listens', () => {
    expect(MAIN).toMatch(/probeLedger\s*\(/);
    // Before, not after. A probe that ran once the socket was open would let
    // the console report itself listening on a database it cannot reach.
    expect(MAIN.indexOf('probeLedger(')).toBeLessThan(MAIN.indexOf('server.listen('));
  });

  // DEC-45. The roster decides whether the development reviewer may serve,
  // and a console that listened without asking would look configured and
  // refuse every request. The question is asked after the probe, because it
  // is the ledger's to answer, and before the socket, so the operator reads
  // the refusal instead of a console that serves nobody.
  it('asks the roster about the development reviewer before it listens', () => {
    expect(MAIN.indexOf('activeReviewer(pool, development)')).toBeGreaterThan(-1);
    expect(MAIN.indexOf('activeReviewer(pool, development)'))
      .toBeLessThan(MAIN.indexOf('server.listen('));
  });

  // DEC-45, and the argument the dev-reviewer suite cannot see. Its cases
  // pass `identityHeader` themselves, so deleting the one `main.ts` passes
  // would restore the fail-open this branch closed — a console that serves
  // as the developer for every request a proxy did not name — while every
  // unit case stayed green.
  it('tells the development reviewer which header a proxy would use', () => {
    const call = /developmentReviewer\(\{([\s\S]*?)\}\)/.exec(MAIN);
    expect(call, 'main.ts calls developmentReviewer').not.toBeNull();
    expect(call![1]).toMatch(/identityHeader: identity/);
  });

  // `listen` reports a bind failure by event, after `main`'s promise has
  // resolved, so the top-level catch never sees it.
  it('handles a bind failure by name rather than by stack', () => {
    expect(MAIN).toMatch(/server\.on\(\s*'error'/);
    // Inside the handler, not anywhere in the file. `CONSOLE_PORT` also names
    // the header comment and three other lines, so a file-wide check held
    // whatever the handler said.
    const handler = MAIN.slice(MAIN.indexOf("server.on('error'"));
    expect(handler.slice(0, handler.indexOf('});'))).toContain('CONSOLE_PORT');
  });

  // An approval cut off mid-flight leaves the operator unable to tell whether
  // the reply went, and that is the state DEC-30 says a person must resolve.
  it('stops on a signal, and lets an in-flight approval finish', () => {
    expect(MAIN).toMatch(/process\.once\(\s*'SIGINT'/);
    expect(MAIN).toMatch(/process\.once\(\s*'SIGTERM'/);
    // `server.close` stops accepting and waits for what is in flight; ending
    // the pool first would fail that request instead of completing it. Read
    // inside the shutdown block, so the guard's own definition above cannot
    // satisfy the ordering by accident.
    const block = MAIN.slice(MAIN.indexOf('const shutdown ='));
    // The pool is ended only through `finish`, and `finish` is what `close`
    // calls. Asserting the two strings in order stopped describing the code
    // once `finish` was named above the call that takes it.
    expect(block).toMatch(/server\.close\(finish\)/);
    expect(block).toMatch(/const finish[\s\S]*?endPool\(\)/);
    expect(block.split('endPool()').length - 1).toBe(1);
  });

  // A keep-alive socket sitting idle holds `close` open on its own, and an
  // in-flight request holds it to Node's 300 s request timeout. The
  // supervisor's grace period expires first and sends SIGKILL, which is the
  // one signal that can cut an approval mid-flight (DEC-30).
  it('bounds the wait rather than holding the process open', () => {
    const block = MAIN.slice(MAIN.indexOf('const shutdown ='));
    expect(block).toMatch(/server\.closeIdleConnections\(\)/);
    expect(block).toMatch(/setTimeout\(finish, SHUTDOWN_GRACE_MS\)/);
    // Unreffed, or the timer is itself a reason the process stays alive.
    expect(block).toMatch(/\.unref\(\)/);
  });
});
