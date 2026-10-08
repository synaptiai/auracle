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
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const MAIN = readFileSync(new URL('./main.ts', import.meta.url).pathname, 'utf8');

describe('the console as a long-running process', () => {
  // An idle client that fails arrives as an event, outside every promise
  // chain, so the route's catch-all cannot see it and Node rethrows. The
  // offline jobs guard this and run for seconds; this runs for as long as an
  // operator keeps the page open.
  // The pool's listeners live in the core's guard, which listens on the pool
  // and on each client it opens (src/db/client-errors.ts); the core's parsed
  // guard test holds every shipped pool to it.
  it('listens for a pool error, so a dropped connection is not a process death', () => {
    expect(MAIN).toMatch(/guardLedgerPool\(new Pool\(consolePoolConfig\(connectionString\)\), logLedgerPoolError\('the console'\)\)/);
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
    expect(MAIN).toMatch(/approve: approvalFor\(\{/);
    expect(MAIN).toMatch(/\bpool, approveRun, readBack, log,/);
    // DEC-44: and the declaration the pages and the writes branch on comes
    // from the adapter the read-back chose, never from the environment a
    // second time.
    //
    // Counted, and not merely found. Seven sites read it — the approval, the
    // close, the snooze, the rewrite, the send-back and the publish, whose
    // guards compare the text a page drew, and the pages themselves — and the
    // failure this guards is any of them disagreeing: an editor offered to a
    // reviewer whose text the approval never sends, or a close refused
    // against a text the case never drew. `indexOf` and `toMatch` both pass
    // while one of the seven says something else.
    const declaration = /ledgerReply: readBack\?\.supportsLedgerReply \?\? false/g;
    expect([...MAIN.matchAll(declaration)]).toHaveLength(7);
    // DEC-50: and the case's re-run read, which draws a parked draft as a
    // copy a person could send exactly where the publish's verdict does.
    expect([...MAIN.matchAll(/readCaseReruns\(readers, runId, readBack\?\.supportsLedgerReply \?\? false\)/g)])
      .toHaveLength(1);
    expect(MAIN).not.toContain('approveFromConsole');
  });

  // DEC-46: the entry point reads the hold period from the environment. The
  // default and the refusals are `hold-lapse.test.ts`'s, behaviorally; what
  // only this file can check is that the wiring reads it at startup, before
  // the pool or any page exists.
  it('reads the hold period from the environment', () => {
    expect(MAIN).toMatch(/requireHoldLapse\(process\.env\['CONSOLE_HOLD_LAPSE_MS'\]\)/);
    // The read is part of the configuration block: it must precede the pool,
    // because a refusal has to land before a client keeps the loop alive.
    expect(MAIN.indexOf('requireHoldLapse(')).toBeLessThan(MAIN.indexOf('new Pool('));
  });

  // DEC-51: the period a batch's sends wait, and the same rule: read at
  // startup, before the pool, so a value the console refuses stops it before
  // it serves a page rather than on the first confirm.
  it('reads the send-hold period from the environment', () => {
    expect(MAIN).toMatch(/requireSendHold\(process\.env\['CONSOLE_SEND_HOLD_MS'\]\)/);
    expect(MAIN.indexOf('requireSendHold(')).toBeLessThan(MAIN.indexOf('new Pool('));
    // Counted, and not merely found, for the reason the declaration above is:
    // the one value has two readers — the approval that stamps the hold, and
    // the pages that promise it — and the failure this guards is the two
    // disagreeing. A page counting twelve seconds over an approval that holds
    // for sixty is a lie a `toMatch` would pass.
    expect([...MAIN.matchAll(/^\s*sendHoldMs,$/gm)]).toHaveLength(2);
  });

  // DEC-51: the read the case page counts the window with. Wired by hand in
  // `main.ts` alone — no unit suite imports it — so a deleted line would
  // leave every approved case drawn as one with no way back.
  it('wires the window a case counts to the ledger read', () => {
    expect(MAIN).toMatch(/readApprovalHold: async \(runId: string\) => readApprovalHold\(pool, runId\)/);
    expect(MAIN).toMatch(/undo: undoFor\(\{ pool, undoApproval \}\)/);
  });

  // Issue #153: the twelve readers read through `boundedRead`, which refuses
  // the writer's pool at the first read. Every call takes the readers' pool,
  // and the pool comes from READER_DATABASE_URL, probed before the console
  // listens.
  it('hands every reader the readers\' pool', () => {
    const readers = [
      'readConversation', 'turnAnsweredBy', 'conversationOfRun', 'readDocument', 'readQueueToday',
      'readRunJournal', 'readCaseGap', 'readKnowledge', 'readCaseReruns', 'readLatency',
      'readRouting', 'readTeam',
    ];
    // Read through the compiler, so an import under another name or a call
    // split over lines is still a call to the reader it names.
    const tree = ts.createSourceFile('main.ts', MAIN, ts.ScriptTarget.Latest, true);
    const localName = new Map<string, string>();
    for (const statement of tree.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      const bindings = statement.importClause?.namedBindings;
      if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
      for (const element of bindings.elements) {
        localName.set(element.name.text, (element.propertyName ?? element.name).text);
      }
    }
    const firstArguments = new Map<string, string[]>();
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const imported = localName.get(node.expression.text);
        if (imported !== undefined && readers.includes(imported)) {
          const first = node.arguments[0];
          const seen = firstArguments.get(imported) ?? [];
          seen.push(first !== undefined && ts.isIdentifier(first) ? first.text : (first?.getText(tree) ?? '(none)'));
          firstArguments.set(imported, seen);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
    for (const reader of readers) {
      const calls = firstArguments.get(reader) ?? [];
      expect(calls.length, reader).toBeGreaterThan(0);
      expect(calls.filter((first) => first !== 'readers'), reader).toEqual([]);
    }
    expect(MAIN).toMatch(/const readerConnectionString = requireReaderDbUrl\('the operator console'\);/);
    expect(MAIN).toMatch(/new Pool\(consolePoolConfig\(readerConnectionString\)\)/);
    expect(MAIN).toMatch(/await probeLedger\(readers, 'the operator console', 'READER_DATABASE_URL'\);/);
    expect(MAIN).toMatch(/await assertOneLedger\(pool, readers, 'the operator console'\);/);
    // Before the socket opens, as the writer's probe is.
    expect(MAIN.indexOf('assertOneLedger(pool, readers')).toBeLessThan(MAIN.indexOf('server.listen('));
  });

  // Two paths close the pools, and `pool.end()` rejects on the second call.
  // An unhandled rejection is fatal in Node, so it replaces the exit path it
  // was meant to take.
  it('closes the pools once, however many paths ask for it', () => {
    expect(MAIN).toContain('const endPool =');
    // One real call, inside the guard, over both pools: the writer's and the
    // readers' (issue #153). Every other site goes through it. Counted over
    // the statement rather than `pool.end()`, because the comment above the
    // guard names the method it is guarding.
    expect(MAIN).toContain("for (const [each, which] of [[pool, 'console'], [readers, 'readers']] as const) {");
    expect(MAIN.split('await each.end();').length - 1).toBe(1);
    expect(MAIN.split('await pool.end();').length - 1).toBe(0);
    expect(MAIN.split('await readers.end();').length - 1).toBe(0);
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
    // Inside the handler, not anywhere in the file. `CONSOLE_PORT` also names
    // the header comment and three other lines, so a file-wide check held
    // whatever the handler said.
    const handler = MAIN.slice(MAIN.indexOf('const refuse = '));
    expect(handler.slice(0, handler.indexOf('};'))).toContain('CONSOLE_PORT');
    // The handler answers the bind alone. The listen callback removes it, so
    // a later fault does not close the pool under a live server.
    expect(MAIN).toMatch(/server\.once\(\s*'error',\s*refuse\s*\)/);
    const listening = MAIN.slice(MAIN.indexOf('server.listen(port, host'));
    expect(listening.slice(0, listening.indexOf('});'))).toMatch(/server\.off\(\s*'error',\s*refuse\s*\)/);
  });

  // An approval cut off mid-flight leaves the operator unable to tell whether
  // the reply went, and that is the state DEC-30 says a person must resolve.
  it('stops on a signal, and lets an in-flight approval finish', () => {
    // `on`, not `once`: a second signal during the drain takes Node's default
    // action under `once`, and that ends the process mid-flight.
    expect(MAIN).toMatch(/process\.on\(\s*'SIGINT'/);
    expect(MAIN).toMatch(/process\.on\(\s*'SIGTERM'/);
    expect(MAIN).not.toMatch(/process\.once\(\s*'SIG(INT|TERM)'/);
    // `server.close` stops accepting and waits for what is in flight; ending
    // the pool first would fail that request instead of completing it. Read
    // inside the shutdown block, so the guard's own definition above cannot
    // satisfy the ordering by accident.
    const block = MAIN.slice(MAIN.indexOf('const shutdown ='));
    // The pool is ended only through `finish`, and `finish` is what `close`
    // calls. Asserting the two strings in order stopped describing the code
    // once `finish` was named above the call that takes it.
    expect(block).toMatch(/server\.close\(finish\)/);
    // The pool's end is bounded too, so an approval stuck behind a lock
    // cannot hold the process open. It runs once, inside `finish`.
    expect(block).toMatch(/const finish[\s\S]*?endWithin\(endPool, SHUTDOWN_GRACE_MS\)/);
    expect(block.split('endWithin(endPool').length - 1).toBe(1);
    expect(block).not.toMatch(/endPool\(\)/);
  });

  // An in-flight request holds `close` to Node's 300 s request timeout. The
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
