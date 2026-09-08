// The console's single write, proved structurally (issue #27).
//
// `bands` and `latency` are safe against a live database because every
// statement they issue is a SELECT. The console cannot inherit that claim: it
// has one write, the approval. So it must state the claim itself, and this is
// where it is held to exactly one.
//
// The rule is structural rather than a matter of care at the call site,
// following `src/ledger/clock-reachability.test.ts`. The console names no SQL
// at all: it reads through the query modules the jobs use, and its one write
// goes through `approveRun`. Anything that looks like a statement in this
// package is a second definition of a ledger read, which is the drift issue
// #27's non-goal names.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

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

  // And the write is one function, called from one place. Two callers of
  // `approveRun` would be two approval paths inside one console.
  //
  // Naming it is not calling it, and the difference is the whole design:
  // `main.ts` imports `approveRun` to hand it to `approveFromConsole`, which
  // is what lets a test drive the delegation without a ledger. So the rule is
  // stated over call sites, and the injector is asserted to be an injector.
  it('calls approveRun from exactly one module', () => {
    const callers = MODULES.filter((file) =>
      /\bapproveRun\s*\(/.test(stripComments(readFileSync(file, 'utf8'))),
    ).map((file) => relative(PACKAGE_ROOT, file));
    expect(callers).toEqual(['src/approve.ts']);
  });

  it('lets the entry point pass approveRun on, and never call it', () => {
    const main = stripComments(
      readFileSync(join(PACKAGE_ROOT, 'src/main.ts'), 'utf8'),
    );
    // It names it, because it injects it.
    expect(main).toMatch(/\bapproveRun\b/);
    // And never invokes it: the call belongs to `approve.ts` alone.
    expect(main).not.toMatch(/\bapproveRun\s*\(/);
  });
});
