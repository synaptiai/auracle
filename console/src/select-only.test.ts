// Every write this console makes, proved structurally (issue #27, DEC-46).
//
// `bands` and `latency` are safe against a live database because every
// statement they issue is a SELECT. The console cannot inherit that claim: it
// writes the ledger — the approval, and the case holds. So it must state the
// claim itself, and this is where it is held to the list it names.
//
// The rule is structural rather than a matter of care at the call site,
// following `src/ledger/clock-reachability.test.ts`. The console names no SQL
// at all: it reads through the query modules the jobs use, and every write
// goes through a function of `auracle/ledger-read` that the core declares in
// `LEDGER_WRITES`. Anything that looks like a statement in this package is a
// second definition of a ledger read, which is the drift issue #27's non-goal
// names.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { LEDGER_WRITES } from 'auracle/ledger-read';

const PACKAGE_ROOT = new URL('../', import.meta.url).pathname;

/**
 * Every shipped file in the console package, tests excluded.
 *
 * Every file, not only `.ts`. A `.json`, a `.css` or an `.mjs` holding a
 * statement is exactly as much a second definition of a ledger read, and a
 * sweep that saw only TypeScript would have said the package was clean while
 * one sat beside it. `docs/operations.md` claims this refuses "any SQL
 * keyword in the package", and the sweep has to mean the package.
 */
function shippedModules(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) shippedModules(path, acc);
    else if (!/\.test\.ts$/.test(entry)) acc.push(path);
  }
  return acc;
}

/**
 * Removes comments and keeps everything else, string literals included.
 *
 * A scanner rather than two regular expressions, because the regular
 * expression version cut at the `//` inside `'http://console.invalid'` and
 * erased the rest of that line. A statement written after a URL on one line
 * would have been erased with it, and the sweep would have reported the
 * package clean. String contents are the one place the rule most needs to
 * look, because SQL travels as a string.
 *
 * The consequence is that HTML counts too. A `<select>` element in a surface
 * trips the SQL sweep below, and that is the sweep working rather than a
 * fault. Rename the offender or narrow the rule; do not stop reading strings.
 */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    const quote = source[i]!;
    if (quote === "'" || quote === '"' || quote === '`') {
      out += quote;
      i += 1;
      while (i < source.length) {
        const ch = source[i]!;
        out += ch;
        i += 1;
        if (ch === '\\') {
          if (i < source.length) {
            out += source[i]!;
            i += 1;
          }
          continue;
        }
        if (ch === quote) break;
      }
      continue;
    }
    out += quote;
    i += 1;
  }
  return out;
}

// From the package root, not from `src`. The docstring above and
// `docs/operations.md` both say "the package", and a sweep of `src` alone
// walked past `console/package.json` — where a `db:*` script would be exactly
// the second write path this rule exists to forbid.
const MODULES = shippedModules(PACKAGE_ROOT);

/** The barrel the console reaches the ledger through, and the only one. */
const READ_BARREL = 'auracle/ledger-read';

/**
 * The one module that may take a ledger write from the barrel.
 *
 * The console has no SQL of its own, so a write is a core function it holds.
 * `main.ts` is the entry point: it takes each write and injects it, which is
 * what lets a server be driven in a test with no ledger behind it. A second
 * module importing one would be a second write path inside one console, and
 * that is what the sweep below refuses.
 */
const WRITE_IMPORTERS = ['src/main.ts'];

/**
 * The one module that may invoke the approval.
 *
 * `approveRun` reaches the console through `ConsoleDeps` rather than by
 * import — `src/approve.ts` validates the form and calls what it was handed —
 * and `main.ts` passes it on rather than calling it. Stated as a property
 * call, because that is the shape the call actually takes.
 */
const APPROVAL_CALLERS = ['src/approve.ts'];

/**
 * The writes the entry point calls itself, rather than passing on.
 *
 * `approveRun` is the one it passes: the approval path has a module of its
 * own, and the holds are wired straight into the surfaces that use them.
 */
const CALLED_BY_THE_ENTRY_POINT = ['handoverHold', 'readHold', 'releaseHold', 'takeHold'];

/**
 * Every symbol this console takes from the barrel, and whether it writes.
 *
 * The list is the claim. The sweep below fails on a symbol the console takes
 * and does not name here, so a new dependency — and above all a new write —
 * cannot arrive unnamed; and it fails when one of these is called from a
 * module other than the one above.
 */
const CALLED: Readonly<Record<string, 'read' | 'write'>> = {
  activeReviewer: 'read',
  approveRun: 'write',
  conversationOfRun: 'read',
  handoverHold: 'write',
  LEDGER_STATES: 'read',
  listEscalations: 'read',
  listRuns: 'read',
  probeLedger: 'read',
  // DEC-47: the product catalogue, read once at startup for the labels the
  // queue draws. A file read, and no statement.
  productCatalogueFromEnv: 'read',
  readConversation: 'read',
  readDays: 'read',
  readDocument: 'read',
  readHold: 'write',
  readHolds: 'read',
  readLatency: 'read',
  readQueueToday: 'read',
  readRun: 'read',
  readRunJournal: 'read',
  releaseHold: 'write',
  replyDigest: 'read',
  requireDbUrl: 'read',
  // DEC-47: the products the reviewer covers, for the queue's own order. A
  // read of the roster: the console can order by a preference, and cannot
  // set one.
  reviewerProducts: 'read',
  selectReadBackAdapter: 'read',
  takeHold: 'write',
  turnAnsweredBy: 'read',
};

/** One shipped module, as the parser sees it. */
interface Parsed {
  readonly file: string;
  /** Names taken from the barrel by a value import, and used. */
  readonly referenced: ReadonlySet<string>;
  /** Of those, the ones this module calls directly. */
  readonly called: ReadonlySet<string>;
  /** Any barrel call made through another object: `deps.approveRun(…)`. */
  readonly calledThrough: ReadonlySet<string>;
}

/**
 * What one module takes from the barrel, and how it uses it.
 *
 * Parsed rather than matched. An import this sweep cannot see is a write it
 * cannot report, and the spellings that defeat a scan are ordinary: a
 * multi-line import, a rename, a type-only import that is not a call at all.
 */
function parse(file: string): Parsed {
  const tree = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
  const imported = new Set<string>();
  // `import * as ledger from …` reaches every export of the barrel through
  // one alias, so the names it uses are only visible at the call: `ledger
  // .takeHold(…)`. A sweep that read named imports alone left that spelling
  // as a second write path the guard could not see.
  const namespaces = new Set<string>();
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== READ_BARREL) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
      continue;
    }
    if (!ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) imported.add(element.name.text);
  }
  const referenced = new Set<string>();
  const called = new Set<string>();
  const calledThrough = new Set<string>();
  const visit = (node: ts.Node): void => {
    // The import statement itself is not a use: its specifiers are the names
    // as written, and counting them would make every type-only import look
    // like a value the console holds.
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    // A type is not a call, and a type-only import is erased before the
    // console runs. Skipping the whole type subtree is what tells the two
    // apart: `hold: Hold | null` is a type, while `readHold(runId)` is a call
    // whatever it is bound to.
    if (ts.isTypeNode(node)) return;
    if (ts.isIdentifier(node) && imported.has(node.text)) referenced.add(node.text);
    // A member of a namespace import is a name this module takes from the
    // barrel, whatever it is called.
    if (
      ts.isPropertyAccessExpression(node)
      && ts.isIdentifier(node.expression)
      && namespaces.has(node.expression.text)
    ) {
      referenced.add(node.name.text);
      const parent = node.parent;
      if (ts.isCallExpression(parent) && parent.expression === node) called.add(node.name.text);
    }
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && imported.has(node.expression.text)
    ) {
      called.add(node.expression.text);
    }
    // The injected shape: `deps.approveRun(…)`, or a call through any other
    // object. The name is not an identifier here, so it needs its own rule.
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && Object.hasOwn(CALLED, node.expression.name.text)
    ) {
      calledThrough.add(node.expression.name.text);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(tree, visit);
  return { file, referenced, called, calledThrough };
}

const PARSED = MODULES.map((file) => parse(file));
const rel = (file: string): string => relative(PACKAGE_ROOT, file).split('\\').join('/');

describe('the console against a live database', () => {
  it('has modules to check, so the rules below are not vacuous', () => {
    expect(MODULES.length).toBeGreaterThan(2);
  });

  // The sweep reads what it strips, so the stripper is held to it. A cut at
  // the `//` of a URL erases the rest of that line, and a statement sitting
  // there goes unread.
  it('keeps a statement written after a URL on the same line', () => {
    const line = `const u = 'http://console.invalid'; const q = 'SELECT 1';`;
    expect(stripComments(line)).toContain('SELECT 1');
  });

  it('still removes a comment, of either kind', () => {
    expect(stripComments('const a = 1; // SELECT 1\n')).not.toContain('SELECT');
    expect(stripComments('const a = /* SELECT 1 */ 1;')).not.toContain('SELECT');
  });

  // Every statement-shaped keyword, not only the writing ones. A SELECT here
  // would be a second definition of a ledger read.
  it('names no SQL statement of its own, of any kind', () => {
    const offenders: string[] = [];
    for (const file of MODULES) {
      const source = stripComments(readFileSync(file, 'utf8'));
      for (const keyword of [
        'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'TRUNCATE',
        'DROP', 'ALTER', 'CREATE', 'COMMIT', 'ROLLBACK',
      ]) {
        // Case-insensitive: lowercase `select` is the same statement, and a
        // case-sensitive sweep would have passed it.
        // Not after a dot. `createHash(...).update(...)` is a method call and
        // not a statement, and a scan that could not tell them apart would
        // force this package to avoid a standard library rather than avoid
        // writing to a ledger.
        if (new RegExp(`(?<![.\\w])${keyword}\\b`, 'i').test(source)) {
          offenders.push(`${relative(PACKAGE_ROOT, file)} names ${keyword}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  // `pool.query` is how a statement reaches the ledger. The console never
  // calls it: reads go through the query modules and the one write goes
  // through `approveRun`.
  it('never calls pool.query, so it cannot issue a statement at all', () => {
    const offenders: string[] = [];
    for (const file of MODULES) {
      const source = stripComments(readFileSync(file, 'utf8'));
      // Both spellings. `pool['query'](…)` reaches the ledger exactly as
      // `pool.query(…)` does, and a dot-only pattern would miss it.
      for (const pattern of [/\.query\s*\(/g, /\[\s*['"`]query['"`]\s*\]/g]) {
        for (const match of source.matchAll(pattern)) {
          offenders.push(`${relative(PACKAGE_ROOT, file)} reaches query at ${match.index}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  // DEC-46, criterion 11. Every write is named above, and the sweep is what
  // makes the naming a check rather than a habit: a symbol this console takes
  // from the barrel and does not name fails here, so a new write cannot reach
  // the ledger unnamed.
  it('names every symbol it takes from the read barrel', () => {
    const unnamed = PARSED.flatMap(({ file, referenced }) =>
      [...referenced].filter((name) => !Object.hasOwn(CALLED, name)).map((name) => `${rel(file)} takes ${name}`),
    );
    expect(unnamed).toEqual([]);
    // The floor: a sweep that parsed nothing would pass the line above.
    const named = new Set(PARSED.flatMap((module) => [...module.referenced]));
    expect(named.size).toBeGreaterThanOrEqual(15);
  });

  // Every write the core declares is a write here too. A guard that called
  // one of them a read would pass its own completeness rule while reporting
  // that a console which writes the ledger does not.
  it('calls every write the barrel declares a write', () => {
    const missed = Object.keys(LEDGER_WRITES)
      .filter((name) => CALLED[name] !== 'write')
      .map((name) => `${name} is declared a write by ${READ_BARREL}, and not named one here`);
    expect(missed).toEqual([]);
    // And nothing named a write is a read at the barrel, so the two statements
    // are one statement.
    const mismatched = Object.keys(CALLED)
      .filter((name) => CALLED[name] === 'write')
      .filter((name) => !Object.hasOwn(LEDGER_WRITES, name));
    expect(mismatched).toEqual([]);
  });

  // Every write is taken from the barrel in one module, and it is the entry
  // point. A second importer would hold the ledger in a second place.
  it('takes no ledger write from the barrel outside the entry point', () => {
    const writes = Object.keys(CALLED).filter((name) => CALLED[name] === 'write');
    const offenders = PARSED.flatMap((module) =>
      writes
        .filter((name) => module.referenced.has(name))
        .filter(() => !WRITE_IMPORTERS.includes(rel(module.file)))
        .map((name) => `${rel(module.file)} takes ${name}`),
    );
    expect(offenders).toEqual([]);
    // And the entry point does take them, so the rule above cannot pass
    // because the guard stopped seeing imports.
    const main = PARSED.find((module) => rel(module.file) === 'src/main.ts')!;
    expect(writes.filter((write) => main.referenced.has(write)).sort())
      .toEqual([...writes].sort());
    // The floor, again: an empty write list would pass every line above.
    expect(writes.length).toBeGreaterThanOrEqual(4);
  });

  it('calls the writes the entry point takes, except the one it passes on', () => {
    const main = PARSED.find((module) => rel(module.file) === 'src/main.ts')!;
    expect(CALLED_BY_THE_ENTRY_POINT.filter((name) => main.called.has(name)).sort())
      .toEqual([...CALLED_BY_THE_ENTRY_POINT].sort());
    // Naming a write is not calling it, and the difference is the whole
    // design: `main.ts` imports `approveRun` to hand it to
    // `approveFromConsole`, which is what lets a test drive the delegation
    // without a ledger. So the injector is asserted to be an injector.
    expect(main.referenced.has('approveRun')).toBe(true);
    expect(main.called.has('approveRun')).toBe(false);
  });

  // And the approval is invoked in one module: `approve.ts` calls what it was
  // handed. Two callers would be two approval paths inside one console.
  it('invokes the approval from exactly one module', () => {
    const callers = PARSED
      .filter((module) => module.calledThrough.has('approveRun') || module.called.has('approveRun'))
      .map((module) => rel(module.file))
      .sort();
    expect(callers).toEqual([...APPROVAL_CALLERS].sort());
  });
});
