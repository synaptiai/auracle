// The listener must never take a client from a daemon's pool.
//
// Every daemon builds its pool with `max: 1`. A `LISTEN` connection is held
// for the process lifetime, so a listener that asked that pool for a client
// would hold the daemon's only one and the process would wedge with every
// health signal green. `src/coordinator/intake.ts` already documents that
// exact failure for a different call.
//
// The property is therefore structural and not a matter of care at the call
// site: `pgArrivalSignal` accepts a connection string, and the module that
// implements it never names `Pool`. A reader can check both, and so can this.
//
// The second rule is stated over the argument rather than over its name. A
// guard that refused an argument spelled `pool` would pass `p`, and the
// hazard is not the spelling. So the argument must be a call to one of the
// two functions that produce a connection string.
//
// Three ways past the first version of this guard were demonstrated, and all
// three are closed below. It built its scan from the literal name, so
// `import { pgArrivalSignal as listenArrivals }` was invisible. It asserted
// an empty offender list, so deleting every call site passed it. And it
// matched `\bPool\b`, which does not match `PoolClient` — a signature
// taking a daemon's only client, which is the hazard itself.
//
// `src/ledger/clock-reachability.test.ts` had already closed the first two
// for the clock seam. This carries its anti-vacuity floor.
//
// The guard reads the source with the TypeScript compiler. It used to strip
// strings and comments with patterns, and a string holding an apostrophe and
// a quoted field made the pattern swallow the call site it looks for.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;

/** The module that implements the signal. Held to the no-pool rule. */
const SIGNAL_MODULE = 'src/coordinator/arrival-signal.ts';

/** The two functions that produce a connection string. */
const URL_SOURCES = ['requireDbUrl', 'dbUrl'];

/** The call site the daemon must keep, so the guard cannot pass vacuously. */
const REQUIRED_CALLER = 'src/coordinator/consumer-main.ts';

/** Every `.ts` under `src/`, tests excluded. */
function shippedModules(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) shippedModules(path, acc);
    else if (/\.ts$/.test(entry) && !/\.test\.ts$/.test(entry)) acc.push(path);
  }
  return acc;
}

function parse(file: string, text = readFileSync(file, 'utf8')): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
}

/** Every node in `source`, depth first. */
function nodes(source: ts.SourceFile): ts.Node[] {
  const all: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    all.push(node);
    node.forEachChild(visit);
  };
  visit(source);
  return all;
}

/**
 * Every local name bound to `name`, including an alias.
 *
 * `import { pgArrivalSignal as listenArrivals }` used to defeat the scan
 * completely: the search built its pattern from the literal name, so a call
 * written `listenArrivals(pool)` was invisible and the guard reported no
 * offender. An alias is a rename, not an escape. So is a destructure of a
 * dynamic import, `const { pgArrivalSignal: listen } = await import(...)`.
 */
function localNames(source: ts.SourceFile, name: string): Set<string> {
  const names = new Set<string>([name]);
  for (const node of nodes(source)) {
    if (ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === name) {
      names.add(node.name.text);
    }
    if (ts.isBindingElement(node) && ts.isIdentifier(node.name)
      && (node.propertyName ?? node.name).getText() === name) {
      names.add(node.name.text);
    }
  }
  return names;
}

/**
 * Every call to the listener in `source`, with its first argument. A call
 * through a namespace or any object, `sig.pgArrivalSignal(...)`, counts by
 * the property name, as the old pattern over the text counted it.
 */
function callSites(source: ts.SourceFile): Array<ts.Expression | undefined> {
  const locals = localNames(source, 'pgArrivalSignal');
  return nodes(source)
    .filter(ts.isCallExpression)
    .filter((call) => (ts.isIdentifier(call.expression) && locals.has(call.expression.text))
      || (ts.isPropertyAccessExpression(call.expression)
        && call.expression.name.text === 'pgArrivalSignal'))
    .map((call) => call.arguments[0]);
}

/** Whether a first argument is a call to a function that yields a connection string. */
function isConnectionString(argument: ts.Expression | undefined): boolean {
  return argument !== undefined && ts.isCallExpression(argument)
    && ts.isIdentifier(argument.expression) && URL_SOURCES.includes(argument.expression.text);
}

describe('the arrival signal listener', () => {
  it('never names Pool, so it cannot take a daemon client', () => {
    const identifiers = nodes(parse(join(REPO_ROOT, SIGNAL_MODULE)))
      .filter(ts.isIdentifier)
      .map((identifier) => identifier.text);
    // `Client` is the whole point; `Pool` is the hazard. The check is on the
    // name, so a type-only import counts too: an ArrivalSignal that accepted
    // a Pool in its signature would be the same defect with no `new`.
    expect(identifiers).toContain('Client');
    // `PoolClient` too: a signature that accepts a daemon's only client is
    // the same defect as one that accepts the pool, and it needs no `new`.
    expect(identifiers.filter((text) => text === 'Pool' || text === 'PoolClient')).toEqual([]);
  });

  it('is only ever handed a connection string, at every shipped call site', () => {
    const offenders: string[] = [];
    const callers: string[] = [];
    for (const file of shippedModules(join(REPO_ROOT, 'src'))) {
      const rel = relative(REPO_ROOT, file);
      if (rel === SIGNAL_MODULE) continue;
      for (const argument of callSites(parse(file))) {
        callers.push(rel);
        if (!isConnectionString(argument)) {
          offenders.push(`${rel} passes ${JSON.stringify(argument?.getText() ?? '')}`);
        }
      }
    }
    expect(offenders).toEqual([]);
    // The anti-vacuity floor. With no call site the loop above finds no
    // offender and the case passes while proving nothing — which it did,
    // with the daemon's own `signal:` line deleted.
    expect(callers).toContain(REQUIRED_CALLER);
  });

  // Each shape a call can take, parsed from text, so the rule is shown to
  // read it without a shipped module written that way.
  it('reads every shape a call can take', () => {
    const shapes: Array<[string, boolean]> = [
      ["import { pgArrivalSignal } from './a.js'; pgArrivalSignal(pool);", false],
      ["import { pgArrivalSignal as listen } from './a.js'; listen(pool);", false],
      ["import * as sig from './a.js'; sig.pgArrivalSignal(pool);", false],
      ["const { pgArrivalSignal } = await import('./a.js'); pgArrivalSignal(pool);", false],
      ["const { pgArrivalSignal: listen } = await import('./a.js'); listen(pool);", false],
      ["import { pgArrivalSignal } from './a.js'; pgArrivalSignal(requireDbUrl('x'));", true],
      ["import * as sig from './a.js'; sig.pgArrivalSignal(dbUrl());", true],
    ];
    for (const [text, clean] of shapes) {
      const sites = callSites(parse('shape.ts', text));
      expect(sites, text).toHaveLength(1);
      expect(isConnectionString(sites[0]), text).toBe(clean);
    }
    // A comment or a string that names the listener is not a call.
    expect(callSites(parse('shape.ts', "// pgArrivalSignal(pool)\nconst s = 'pgArrivalSignal(pool)';")))
      .toHaveLength(0);
  });
});
