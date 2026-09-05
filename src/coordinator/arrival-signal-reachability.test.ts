// The listener must never take a client from a daemon's pool (issue #25).
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
// for the clock seam. This carries its `localNames` helper and its
// anti-vacuity floor rather than learning them again.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;

/** The module that implements the signal. Held to the no-pool rule. */
const SIGNAL_MODULE = 'src/coordinator/arrival-signal.ts';

/** The two functions that produce a connection string. */
const URL_SOURCES = ['requireDbUrl', 'dbUrl'];

/** The call site the daemon must keep, so the guard cannot pass vacuously. */
const REQUIRED_CALLER = 'src/coordinator/consumer-main.ts';

function stripComments(source: string): string {
  return source
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

/** Every `.ts` under `src/`, tests excluded. */
function shippedModules(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) shippedModules(path, acc);
    else if (/\.ts$/.test(entry) && !/\.test\.ts$/.test(entry)) acc.push(path);
  }
  return acc;
}

/**
 * Every local name bound to `name` in `source`, including an alias.
 *
 * `import { pgArrivalSignal as listenArrivals }` used to defeat the scan
 * completely: the search built its pattern from the literal name, so a call
 * written `listenArrivals(pool)` was invisible and the guard reported no
 * offender. An alias is a rename, not an escape.
 */
function localNames(source: string, name: string): string[] {
  const names = new Set<string>([name]);
  for (const match of source.matchAll(new RegExp(`\\b${name}\\s+as\\s+(\\w+)`, 'g'))) {
    names.add(match[1]!);
  }
  return [...names];
}

/** The text of the first argument of each call to `name` in `source`. */
function firstArguments(source: string, name: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(new RegExp(`\\b${name}\\s*\\(`, 'g'))) {
    let i = match.index + match[0].length;
    let depth = 1;
    const start = i;
    while (i < source.length && depth > 0) {
      const c = source[i]!;
      if (c === '(') depth += 1;
      else if (c === ')') depth -= 1;
      else if (c === ',' && depth === 1) break;
      i += 1;
    }
    found.push(source.slice(start, i).trim());
  }
  return found;
}

describe('the arrival signal listener', () => {
  it('never names Pool, so it cannot take a daemon client', () => {
    const source = stripComments(readFileSync(join(REPO_ROOT, SIGNAL_MODULE), 'utf8'));
    // `Client` is the whole point; `Pool` is the hazard. The check is on the
    // word, so a type-only import counts too: an ArrivalSignal that accepted
    // a Pool in its signature would be the same defect with no `new`.
    expect(source).toContain('Client');
    // `PoolClient` too: a signature that accepts a daemon's only client is
    // the same defect as one that accepts the pool, and it needs no `new`.
    expect(source).not.toMatch(/\bPool(Client)?\b/);
  });

  it('is only ever handed a connection string, at every shipped call site', () => {
    const offenders: string[] = [];
    const callers: string[] = [];
    for (const file of shippedModules(join(REPO_ROOT, 'src'))) {
      const rel = relative(REPO_ROOT, file);
      if (rel === SIGNAL_MODULE) continue;
      const source = stripComments(readFileSync(file, 'utf8'));
      for (const local of localNames(source, 'pgArrivalSignal')) {
        for (const argument of firstArguments(source, local)) {
          callers.push(rel);
          const named = URL_SOURCES.some((fn) => new RegExp(`\\b${fn}\\s*\\(`).test(argument));
          if (!named) offenders.push(`${rel} passes ${JSON.stringify(argument)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
    // The anti-vacuity floor. With no call site the loop above finds no
    // offender and the case passes while proving nothing — which it did,
    // with the daemon's own `signal:` line deleted.
    expect(callers).toContain(REQUIRED_CALLER);
  });
});
