// The clock seam must not be reachable from anything that ships (issue #22).
//
// `webhook`, `imap`, `consumer` and `relay` write production rows. A clock
// passed from one of them would stamp a caller's wall clock onto a live run,
// and nothing downstream could tell that row from a seeded one. The seam is
// a trailing parameter rather than a field on FencedRunInput precisely so
// this is an arity property of each call site, which a reader can check.
//
// The rule is stated over every shipped module and not only over the four
// entry points. A guard that walked out from the daemons alone missed
// src/approval/approve.ts, which is the second of the two non-test callers
// of the fenced path and reaches a terminal state: no daemon imports it, so
// no daemon closure contains it, and a clock added there would have passed.
// A new entry point would have been missed the same way.
//
// The daemon closure is still asserted, because the acceptance criterion
// names those four processes. It is now the narrower of two statements
// rather than the only one.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;

/** The four long-running processes, as package.json names them. */
const DAEMON_ENTRIES = [
  'src/intake/webhook-main.ts',
  'src/imap/main.ts',
  'src/coordinator/consumer-main.ts',
  'src/relay/main.ts',
];

/**
 * The two modules that define the seam, which name its types by necessity.
 * Every other shipped module is held to the rule.
 */
const SEAM_MODULES = ['src/ledger/clock.ts', 'src/ledger/insert.ts'];

/**
 * Blanks comments, and only comments.
 *
 * A naive `//` sweep also blanks the rest of any line holding a URL, and
 * this tree holds several. The remainder of such a line then becomes
 * invisible to the searches below, and the guard reports no offender because
 * it stopped reading, not because there was none. So string and template
 * literals are blanked first, which puts a `//` inside one out of reach.
 */
function stripComments(source: string): string {
  return source
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

/**
 * Relative-specifier imports, resolved from `.js` back onto the `.ts` source.
 *
 * Both forms. A module reached only through `await import('./x.js')` would
 * otherwise never enter the closure, and the repository uses that form.
 *
 * Read raw, not through `stripComments`: that pass blanks string literals,
 * which is exactly where a specifier lives. So a commented-out import is
 * followed too. That over-counts the closure, which is the safe direction
 * for a guard — it can only bring more modules under the rule.
 */
function importsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const found: string[] = [];
  for (const pattern of [/from\s+'(\.[^']+)'/g, /import\s*\(\s*'(\.[^']+)'/g]) {
    for (const match of source.matchAll(pattern)) {
      const candidate = resolve(dirname(file), match[1]!.replace(/\.js$/, '.ts'));
      if (existsSync(candidate)) found.push(candidate);
    }
  }
  return found;
}

/** Every module a daemon can reach, transitively. */
function closure(entries: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = entries.map((e) => join(REPO_ROOT, e));
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    stack.push(...importsOf(file));
  }
  return seen;
}

/** Every shipped module: `.ts` under `src/`, tests and support excluded. */
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
 * `import { fencedInsert as fi }` used to defeat the scan completely: the
 * arity search built its pattern from the literal name, so a call written
 * `fi(pool, run, null, clock)` was invisible and the guard reported no
 * offender. An alias is a rename, not an escape.
 */
function localNames(source: string, name: string): string[] {
  const names = new Set<string>([name]);
  for (const match of source.matchAll(new RegExp(`\\b${name}\\s+as\\s+(\\w+)`, 'g'))) {
    names.add(match[1]!);
  }
  return [...names];
}

/** Blanks every import statement, so a specifier or an alias reads as nothing. */
function stripImports(source: string): string {
  return source
    .replace(/import\s+type?\s*\{[\s\S]*?\}\s*from\s*'[^']*';/g, '')
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*'[^']*';/g, '')
    .replace(/import\s+[\w*\s,{}]*\s*from\s*'[^']*';/g, '')
    .replace(/import\s*'[^']*';/g, '');
}

/**
 * Modules that name the seam without calling it.
 *
 * This closes the class, rather than another member of it. Three members
 * were closed one at a time — an import alias, a spread call, and
 * `Parameters<typeof fencedInsert>` — and a fourth walked straight through:
 * `const write = fencedInsert;` followed by `write(pool, run, null, clock)`.
 * Nothing enumerates the fifth.
 *
 * So the rule is stated positively instead. A shipped module may call the
 * two writes and may import them. Every other mention is refused, whatever
 * form it takes: an assignment, a re-export, a `typeof`, a value passed to
 * a helper. Imports are blanked first, then any residual mention that is not
 * immediately followed by `(` is an offender.
 */
function offendingMentions(files: readonly string[]): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    const rel = relative(REPO_ROOT, file);
    if (SEAM_MODULES.includes(rel)) continue;
    const source = stripImports(stripComments(readFileSync(file, 'utf8')));
    for (const match of source.matchAll(/\bfenced(?:Insert|Transition)\b\s*/g)) {
      const next = source[match.index + match[0].length];
      if (next !== '(') offenders.push(`${rel} names ${match[0].trim()} without calling it`);
    }
  }
  return offenders;
}

/**
 * The top-level argument count of every call to `name` in `source`.
 *
 * Counts arguments at paren depth one, ignoring commas nested in an object
 * literal, an array or a further call. A trailing comma contributes nothing,
 * because a multi-line call in this repository always carries one and would
 * otherwise read as one argument more than it passes.
 *
 * A call whose arguments are spread — `f(...args)` — returns `SPREAD`. Its
 * arity is not readable from the source, so it is refused rather than
 * counted as one argument, which is what a naive count made of it.
 */
function callArities(source: string, name: string): number[] {
  const arities: number[] = [];
  const pattern = new RegExp(`\\b${name}\\s*\\(`, 'g');
  for (const match of source.matchAll(pattern)) {
    let i = match.index + match[0].length;
    let depth = 1;
    let args = 0;
    let tokenSinceComma = false;
    let spread = false;
    while (i < source.length && depth > 0) {
      const c = source[i]!;
      if (depth === 1 && source.startsWith('...', i)) spread = true;
      if (depth === 1 && c === ',') {
        if (tokenSinceComma) args += 1;
        tokenSinceComma = false;
      } else if (!/\s/.test(c)) {
        // An opening bracket is itself a token, and it counts as one before
        // it changes the depth. Counting it afterwards would let
        // `f([1, 2])` read as no argument at all.
        if (depth === 1 && c !== ')' && c !== ']' && c !== '}') tokenSinceComma = true;
        if (c === '(' || c === '[' || c === '{') depth += 1;
        else if (c === ')' || c === ']' || c === '}') depth -= 1;
      }
      i += 1;
    }
    arities.push(spread ? SPREAD : tokenSinceComma ? args + 1 : args);
  }
  return arities;
}

/** An unreadable arity. Refused, never counted. */
const SPREAD = Number.POSITIVE_INFINITY;

const SHIPPED = shippedModules(join(REPO_ROOT, 'src'))
  .filter((f) => !/\/test-support\//.test(f))
  .sort();
const DAEMON_CLOSURE = [...closure(DAEMON_ENTRIES)].sort();

/** The seam's own module is excluded; a declaration is not a call site. */
function offendingArities(files: readonly string[], name: string, limit: number): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    const rel = relative(REPO_ROOT, file);
    if (SEAM_MODULES.includes(rel)) continue;
    const source = stripComments(readFileSync(file, 'utf8'));
    for (const local of localNames(source, name)) {
      for (const arity of callArities(source, local)) {
        if (arity === SPREAD) offenders.push(`${rel} spread call to ${local}`);
        else if (arity > limit) offenders.push(`${rel} arity ${arity}`);
      }
    }
  }
  return offenders;
}

/**
 * Modules that name the seam at the type level.
 *
 * `Parameters<typeof fencedInsert>[3]` is the clock's type without either
 * clock type's name, so the name search below could not see it. A shipped
 * module has no reason to reach for the signature of a write it calls.
 */
function offendingTypeReferences(files: readonly string[]): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    const rel = relative(REPO_ROOT, file);
    if (SEAM_MODULES.includes(rel)) continue;
    const source = stripComments(readFileSync(file, 'utf8'));
    if (/typeof\s+fenced(Insert|Transition)\b/.test(source)) offenders.push(rel);
  }
  return offenders;
}

function offendingTypeNames(files: readonly string[]): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    const rel = relative(REPO_ROOT, file);
    if (SEAM_MODULES.includes(rel)) continue;
    const source = stripComments(readFileSync(file, 'utf8'));
    if (/\bSeededInsertClock\b|\bSeededFinishClock\b/.test(source)) offenders.push(rel);
  }
  return offenders;
}

describe('the clock seam and everything that ships', () => {
  // A guard whose scan found nothing would report no offender either. These
  // two cases separate "no offender" from "nothing read".
  it('scans the two known callers of the fenced path', () => {
    const rels = SHIPPED.map((f) => relative(REPO_ROOT, f));
    expect(rels).toContain('src/coordinator/coordinator.ts');
    expect(rels).toContain('src/approval/approve.ts');
  });

  it('scans a tree of the size this repository has', () => {
    expect(SHIPPED.length).toBeGreaterThan(60);
  });

  it('passes no clock to fencedInsert from any shipped module', () => {
    expect(offendingArities(SHIPPED, 'fencedInsert', 3)).toEqual([]);
  });

  it('passes no clock to fencedTransition from any shipped module', () => {
    expect(offendingArities(SHIPPED, 'fencedTransition', 2)).toEqual([]);
  });

  // An arity check alone would miss a module that builds a clock and hands
  // it on through a helper of its own.
  it('names neither clock type in any shipped module', () => {
    expect(offendingTypeNames(SHIPPED)).toEqual([]);
  });

  it('reaches for neither write signature in any shipped module', () => {
    expect(offendingTypeReferences(SHIPPED)).toEqual([]);
  });

  // The whole class, not a fourth member of it.
  it('names neither write except to call it, in any shipped module', () => {
    expect(offendingMentions(SHIPPED)).toEqual([]);
  });
});

describe('the clock seam and the four daemons', () => {
  it('reaches the fenced write path, so the closure is not vacuous', () => {
    const reaching = DAEMON_CLOSURE.filter((f) => f.endsWith('src/ledger/insert.ts'));
    expect(reaching).toHaveLength(1);
  });

  // A closure that silently shrank — a moved import, a specifier form the
  // walker stopped matching — would pass every case below while reading
  // almost nothing. The floor turns that into a failure.
  it('reaches a tree of the size the four daemons need', () => {
    expect(DAEMON_CLOSURE.length).toBeGreaterThan(30);
  });

  it('passes no clock to fencedInsert from anywhere a daemon reaches', () => {
    expect(offendingArities(DAEMON_CLOSURE, 'fencedInsert', 3)).toEqual([]);
  });

  it('passes no clock to fencedTransition from anywhere a daemon reaches', () => {
    expect(offendingArities(DAEMON_CLOSURE, 'fencedTransition', 2)).toEqual([]);
  });
});

// The two readers are the load-bearing parts of the cases above, so they are
// tested rather than trusted.
describe('callArities', () => {
  it('counts a plain three-argument call', () => {
    expect(callArities('await fencedInsert(pool, run, null);', 'fencedInsert')).toEqual([3]);
  });

  it('counts a four-argument call as four', () => {
    expect(callArities('fencedInsert(pool, run, null, clock);', 'fencedInsert')).toEqual([4]);
  });

  it('does not count commas nested in an object literal', () => {
    expect(callArities('fencedInsert(pool, { a: 1, b: 2 }, null);', 'fencedInsert')).toEqual([3]);
  });

  it('does not count commas nested in a further call', () => {
    expect(callArities('fencedInsert(pool, makeRun(a, b), null);', 'fencedInsert')).toEqual([3]);
  });

  it('does not count commas nested in an array literal', () => {
    expect(callArities('f(a, [1, 2, 3], c);', 'f')).toEqual([3]);
  });

  it('counts a call spread over several lines', () => {
    expect(callArities('fencedInsert(\n  pool,\n  run,\n  null,\n);', 'fencedInsert')).toEqual([3]);
  });

  it('ignores a trailing comma on a multi-line four-argument call', () => {
    expect(callArities('f(\n  a,\n  b,\n  c,\n  d,\n);', 'f')).toEqual([4]);
  });

  it('counts an inline arrow argument as one', () => {
    expect(callArities('f(pool, t, async (c) => { await g(c, 1); });', 'f')).toEqual([3]);
  });

  it('counts every call in a file', () => {
    expect(callArities('f(a); f(a, b); f(a, b, c);', 'f')).toEqual([1, 2, 3]);
  });

  it('counts a zero-argument call as zero', () => {
    expect(callArities('f();', 'f')).toEqual([0]);
  });
});

describe('localNames', () => {
  it('finds the plain name', () => {
    expect(localNames("import { fencedInsert } from './x.js';", 'fencedInsert')).toEqual([
      'fencedInsert',
    ]);
  });

  // The evasion. An alias is a rename, not an escape.
  it('finds an alias', () => {
    const names = localNames("import { fencedInsert as fi } from './x.js';", 'fencedInsert');
    expect(names).toContain('fencedInsert');
    expect(names).toContain('fi');
  });

  it('finds an alias of the transition too', () => {
    expect(localNames('fencedTransition as ft', 'fencedTransition')).toContain('ft');
  });
});

describe('a spread call', () => {
  it('is refused rather than counted as one argument', () => {
    expect(callArities('fencedInsert(...args);', 'fencedInsert')).toEqual([
      Number.POSITIVE_INFINITY,
    ]);
  });

  it('is refused when the spread comes after real arguments', () => {
    expect(callArities('fencedInsert(pool, run, ...rest);', 'fencedInsert')).toEqual([
      Number.POSITIVE_INFINITY,
    ]);
  });

  it('does not confuse a nested spread for a spread call', () => {
    expect(callArities('fencedInsert(pool, { ...run }, null);', 'fencedInsert')).toEqual([3]);
  });
});

describe('offendingMentions', () => {
  it('accepts a module that only calls the write', () => {
    const calls = [...SHIPPED].filter((f) =>
      /coordinator\.ts$|approve\.ts$/.test(f),
    );
    expect(calls.length).toBe(2);
    expect(offendingMentions(calls)).toEqual([]);
  });
});

describe('stripImports', () => {
  it('blanks a braced import', () => {
    expect(stripImports("import { fencedInsert } from '../ledger/insert.js';")).not.toContain(
      'fencedInsert',
    );
  });

  it('blanks a braced import spread over several lines', () => {
    const source = "import {\n  fencedInsert,\n  fencedTransition,\n} from '../ledger/insert.js';";
    expect(stripImports(source)).not.toContain('fenced');
  });

  it('blanks a type-only import', () => {
    expect(
      stripImports("import type { FencedRunInput } from '../ledger/insert.js';"),
    ).not.toContain('FencedRunInput');
  });

  it('keeps a mention that is not an import', () => {
    expect(stripImports('const write = fencedInsert;')).toContain('fencedInsert');
  });
});

describe('stripComments', () => {
  it('blanks a line comment', () => {
    expect(stripComments('const a = 1; // f(a, b, c, d)')).not.toContain('f(a');
  });

  it('blanks a block comment', () => {
    expect(stripComments('/* f(a, b, c, d) */ const a = 1;')).not.toContain('f(a');
  });

  // The bug this guard shipped with. A URL in a string literal used to blank
  // the rest of its line, so a call written after one was never read.
  it('keeps the rest of a line holding a URL in a string', () => {
    const kept = stripComments("const u = 'https://example.test/v1'; f(a, b, c, d);");
    expect(callArities(kept, 'f')).toEqual([4]);
  });

  it('keeps the rest of a line holding a URL in a template literal', () => {
    const kept = stripComments('const u = `https://example.test/${v}`; f(a, b, c, d);');
    expect(callArities(kept, 'f')).toEqual([4]);
  });
});

describe('importsOf', () => {
  it('finds a static relative import', () => {
    const found = importsOf(join(REPO_ROOT, 'src/coordinator/consumer-main.ts'));
    expect(found.length).toBeGreaterThan(0);
  });

  it('follows a dynamic relative import into the closure', () => {
    // The repository writes this form, and a walker blind to it would drop
    // every module reached only that way.
    const dynamic = importsOf(join(REPO_ROOT, 'src/goldreport/run.ts'));
    expect(dynamic.some((f) => /src\//.test(f))).toBe(true);
  });
});
