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
//
// The guard reads each module with the TypeScript compiler. It used to strip
// strings and comments with patterns, and a double-quoted string holding an
// apostrophe paired with the next single quote on its line, which blanked a
// call between them (issue #146). A parsed tree has no such pairing to get
// wrong: a string is a node and a comment is trivia, and neither is a call.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { constantText, nodesOf, parseSource } from '../test-support/source-reader.js';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;

/** The package's own name, which a module could import itself by. */
const PACKAGE_NAME = (JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { name: string }).name;

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
 * The one module allowed to supply a clock (issue #23).
 *
 * The traffic seeder writes a backdated history through the real path, which
 * is what the seam was built for. It is offline tooling, run by hand against
 * a database an operator names.
 *
 * The exception belongs to the shipped-module rule only. The daemon closure
 * below keeps **no** exception, so a daemon that ever imported the seeder
 * fails that case even though the seeder is allowed here. That asymmetry is
 * the guarantee: the seeder may hold the clock, and nothing a daemon reaches
 * may — including the seeder itself.
 */
const SEEDER_MODULES = ['src/seed/write.ts'];

/** The two writes the seam belongs to. */
const WRITES = ['fencedInsert', 'fencedTransition'];

/** The text of a module specifier, when it is written as one literal. */
function specifierText(node: ts.Node | undefined): string | undefined {
  return node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined;
}

/**
 * Every relative specifier `source` imports or re-exports, in every form, and
 * every import whose specifier cannot be read.
 *
 * A static import, an `export … from`, an `import x = require(…)`, a
 * `require(…)` and a dynamic `import(…)` all bring a module into the closure.
 * The repository uses the dynamic form, and a walker blind to it would drop
 * every module reached only that way. Any quote a specifier can wear is one
 * literal to the compiler: the guard once matched single quotes alone, and
 * `await import("../seed/write.js")` was lint-clean and invisible. A
 * commented-out import is not an import, and it is not followed.
 *
 * A specifier built at runtime, `import(path)` or `` import(`./${name}.js`) ``,
 * names no module the source states. It used to be dropped, and the module it
 * reached left the closure with nothing to say so. It is unreadable now, and
 * the cases below refuse it.
 */
function relativeSpecifiers(source: ts.SourceFile): { relative: string[]; unreadable: string[] } {
  const found: string[] = [];
  const unreadable: string[] = [];
  for (const node of nodesOf(source)) {
    let specifier: string | undefined;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier === undefined) continue;
      specifier = specifierText(node.moduleSpecifier);
    } else if (ts.isExternalModuleReference(node)) {
      specifier = specifierText(node.expression);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      specifier = specifierText(node.arguments[0]);
      if (specifier === undefined) unreadable.push(node.getText(source));
    } else {
      continue;
    }
    if (specifier !== undefined && specifier.startsWith('.')) found.push(specifier);
    // The package's own name resolves through its `exports` to `dist/`, so a
    // module reached that way is not the source this walk reads. Refused,
    // rather than followed into compiled output or dropped.
    if (specifier !== undefined && (specifier === PACKAGE_NAME || specifier.startsWith(`${PACKAGE_NAME}/`))) {
      unreadable.push(node.getText(source));
    }
  }
  return { relative: found, unreadable };
}

/** The repository's own module settings, which decide what a specifier resolves to. */
const COMPILER_OPTIONS = ts.parseJsonConfigFileContent(
  ts.readConfigFile(join(REPO_ROOT, 'tsconfig.json'), ts.sys.readFile).config,
  ts.sys,
  REPO_ROOT,
).options;

/**
 * The relative imports of a module, resolved as the compiler resolves them,
 * and each one that resolves to no source file.
 *
 * The walker used to swap `.js` for `.ts` and keep the result if a file was
 * there. A `.tsx` source, a directory or a mistyped path each dropped out of
 * the closure and took every module behind it along. The compiler's own
 * resolution answers instead, and an import it cannot resolve is refused.
 */
function importsOf(file: string): { resolved: string[]; unresolved: string[] } {
  const { relative: specifiers, unreadable } = relativeSpecifiers(parseSource(file));
  const resolved: string[] = [];
  const unresolved = unreadable.map((text) => `${relative(REPO_ROOT, file)}: ${text}`);
  for (const specifier of specifiers) {
    const target = ts.resolveModuleName(specifier, file, COMPILER_OPTIONS, ts.sys).resolvedModule;
    if (target === undefined || !/\.[cm]?tsx?$/.test(target.resolvedFileName) || target.isExternalLibraryImport) {
      // A JSON module is data, and it holds no call.
      if (target !== undefined && /\.json$/.test(target.resolvedFileName)) continue;
      unresolved.push(`${relative(REPO_ROOT, file)}: ${specifier}`);
    } else {
      resolved.push(target.resolvedFileName);
    }
  }
  return { resolved, unresolved };
}

/** Every module a daemon can reach, transitively, and every import on the way that resolved to nothing. */
function closure(entries: string[]): { modules: Set<string>; unresolved: string[] } {
  const seen = new Set<string>();
  const unresolved: string[] = [];
  const stack = entries.map((e) => join(REPO_ROOT, e));
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const imports = importsOf(file);
    unresolved.push(...imports.unresolved);
    stack.push(...imports.resolved);
  }
  return { modules: seen, unresolved };
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
 * offender. An alias is a rename, not an escape. So is a destructure of a
 * dynamic import, `const { fencedInsert: fi } = await import(…)`.
 */
function localNames(source: ts.SourceFile, name: string): Set<string> {
  const names = new Set<string>([name]);
  for (const node of nodesOf(source)) {
    if (ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === name) names.add(node.name.text);
    // A quoted key names the same property: `{ 'fencedInsert': fi }`.
    if (ts.isBindingElement(node) && ts.isIdentifier(node.name)
      && nameText(node.propertyName ?? node.name) === name) {
      names.add(node.name.text);
    }
    // `import fi = ledger.fencedInsert` is an alias too.
    if (ts.isImportEqualsDeclaration(node) && ts.isQualifiedName(node.moduleReference)
      && node.moduleReference.right.text === name) {
      names.add(node.name.text);
    }
  }
  return names;
}

/** The text of a property name written as an identifier, a string or a plain template, or null. */
function nameText(node: ts.Node): string | null {
  return ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
    ? node.text
    : null;
}

/**
 * The member an element access names: a literal key, or the literal a
 * constant key holds. `ledger[WRITE](…)` with `const WRITE =
 * 'fencedTransition'` calls the write as surely as `ledger.fencedTransition`.
 */
function keyText(node: ts.Expression): string | null {
  return ts.isIdentifier(node) ? constantText(node) : nameText(node);
}

/**
 * Every call to `name` in `source`: through the name, an alias of it, or a
 * member of any object, `ledger.fencedInsert(…)` or `ledger['fencedInsert'](…)`,
 * which is how a namespace import reaches it.
 */
function callsTo(source: ts.SourceFile, name: string): ts.CallExpression[] {
  const locals = localNames(source, name);
  return nodesOf(source).filter(ts.isCallExpression).filter((call) =>
    (ts.isIdentifier(call.expression) && locals.has(call.expression.text))
    || (ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === name)
    || (ts.isElementAccessExpression(call.expression) && keyText(call.expression.argumentExpression) === name));
}

/** An unreadable arity. Refused, never counted. */
const SPREAD = Number.POSITIVE_INFINITY;

/**
 * The argument count of a call. A spread argument, `f(...args)`, makes the
 * count unreadable from the source, so it is refused rather than counted as
 * one argument, which is what a naive count made of it.
 */
function arityOf(call: ts.CallExpression): number {
  return call.arguments.some(ts.isSpreadElement) ? SPREAD : call.arguments.length;
}

/** The arity of every call to `name` in a piece of source text. */
function callArities(text: string, name: string): number[] {
  return callsTo(parseSource('source.ts', text), name).map(arityOf);
}

/**
 * Whether an identifier is the name a binding binds: an import, the name or
 * key of a destructure, or the alias an import-equals declaration makes.
 *
 * Only the name. A destructure's default value is an expression, so
 * `const { w = fencedTransition } = o` mentions the write, and a rule that
 * read the whole element as a binding let it pass (review finding K1).
 */
function isBinding(node: ts.Identifier): boolean {
  for (let parent = node.parent; parent !== undefined; parent = parent.parent) {
    if (ts.isImportDeclaration(parent)) return true;
    // `import x = require('./insert.js')` binds a module, and `x` is the
    // alias either form makes. `import x = ledger.fencedInsert` names a
    // write on its right, and that is a mention.
    if (ts.isImportEqualsDeclaration(parent)) {
      return parent.name === node || ts.isExternalModuleReference(parent.moduleReference);
    }
    if (ts.isStatement(parent)) break;
  }
  const parent = node.parent;
  return ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node);
}

/** Whether an identifier is the thing a call calls, directly or as a member. */
function isCallee(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isCallExpression(parent) && parent.expression === node) return true;
  return ts.isPropertyAccessExpression(parent) && parent.name === node
    && ts.isCallExpression(parent.parent) && parent.parent.expression === parent;
}

/** Whether an identifier is the name a variable declaration binds. */
function isDeclared(node: ts.Identifier): boolean {
  return ts.isVariableDeclaration(node.parent) && node.parent.name === node;
}

/** Whether a specifier names the module that defines the two writes. */
function isInsertModule(specifier: string): boolean {
  return /(?:^|\/)ledger\/insert\.js$/.test(specifier) || specifier === './insert.js';
}

/**
 * Every local name bound to the whole module that defines the writes: a
 * namespace import, an import-equals `require`, and a name a dynamic import
 * of it is bound to, `const ledger = await import('../ledger/insert.js')`.
 */
function namespacesOf(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const node of nodesOf(source)) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      let value: ts.Expression = node.initializer;
      while (ts.isAwaitExpression(value) || ts.isParenthesizedExpression(value)) value = value.expression;
      if (ts.isCallExpression(value) && value.expression.kind === ts.SyntaxKind.ImportKeyword
        && isInsertModule(specifierText(value.arguments[0]) ?? '')) {
        names.add(node.name.text);
      }
    }
    if (ts.isNamespaceImport(node) && isInsertModule(specifierText(node.parent.parent.moduleSpecifier) ?? '')) {
      names.add(node.name.text);
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
      && isInsertModule(specifierText(node.moduleReference.expression) ?? '')) {
      names.add(node.name.text);
    }
  }
  return names;
}

/**
 * Every mention of a write in `source` that neither calls it nor binds it.
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
 * a helper.
 *
 * An alias is held to the same rule as the name, because it is the same
 * value: `import { fencedInsert as fi }` and then `wrap(fi)` hands the write
 * on as surely as `wrap(fencedInsert)`. So is the namespace that holds both
 * writes. It may be read through a member and nothing else, so
 * `helper(ledger)` and `const { fencedInsert: fi } = ledger` are refused.
 */
function mentionsIn(source: ts.SourceFile): string[] {
  const aliases = new Map<string, string>();
  for (const write of WRITES) for (const name of localNames(source, write)) aliases.set(name, write);
  const named = nodesOf(source)
    .filter(ts.isIdentifier)
    .filter((node) => aliases.has(node.text) && !isCallee(node) && !isBinding(node)
      && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node && !WRITES.includes(node.text))
      && !(ts.isQualifiedName(node.parent) && node.parent.right === node && !WRITES.includes(node.text)));
  // `ledger['fencedInsert']` names the write as surely as the dot does, and
  // so does a constant key that holds the name.
  const keyed = nodesOf(source)
    .filter(ts.isElementAccessExpression)
    .filter((access) => WRITES.includes(keyText(access.argumentExpression) ?? '')
      && !(ts.isCallExpression(access.parent) && access.parent.expression === access));
  const namespaces = namespacesOf(source);
  // The namespace may be read through a dot or a literal key, and nothing
  // else. A key built at runtime could name either write, and no reader of
  // the source can say which.
  const readable = (node: ts.Identifier): boolean => {
    const parent = node.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node) return true;
    if (ts.isElementAccessExpression(parent) && parent.expression === node) {
      return keyText(parent.argumentExpression) !== null;
    }
    return ts.isQualifiedName(parent) && parent.left === node;
  };
  const handedOn = nodesOf(source)
    .filter(ts.isIdentifier)
    .filter((node) => namespaces.has(node.text) && !isBinding(node) && !isDeclared(node) && !readable(node));
  // A dynamic import of the module may bind a const: a namespace, held by
  // the rule above, or a destructure with keys the source states. Any other
  // use of the promise, `.then((m) => …)` or `x = await import(…)`, hands the
  // module to code this scan does not follow.
  const loose = nodesOf(source).filter(ts.isCallExpression)
    .filter((call) => call.expression.kind === ts.SyntaxKind.ImportKeyword
      && isInsertModule(specifierText(call.arguments[0]) ?? ''))
    .filter((call) => {
      let at: ts.Node = call;
      while (ts.isAwaitExpression(at.parent) || ts.isParenthesizedExpression(at.parent)) at = at.parent;
      const declaration = at.parent;
      if (!ts.isVariableDeclaration(declaration) || declaration.initializer !== at
        || (declaration.parent.flags & ts.NodeFlags.Const) === 0) return true;
      if (ts.isIdentifier(declaration.name)) return false;
      return !ts.isObjectBindingPattern(declaration.name) || declaration.name.elements.some((element) =>
        element.dotDotDotToken !== undefined || (element.propertyName !== undefined && nameText(element.propertyName) === null));
    });
  return [
    ...named.map((node) => aliases.get(node.text)!),
    ...keyed.map((access) => keyText(access.argumentExpression)!),
    ...handedOn.map(() => 'the ledger namespace'),
    ...loose.map(() => 'a dynamic import of the ledger'),
  ];
}

function offendingMentions(
  files: readonly string[],
  allowed: readonly string[] = [],
): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    const rel = relative(REPO_ROOT, file);
    if (SEAM_MODULES.includes(rel) || allowed.includes(rel)) continue;
    for (const name of mentionsIn(parseSource(file))) offenders.push(`${rel} names ${name} without calling it`);
  }
  return offenders;
}

const SHIPPED = shippedModules(join(REPO_ROOT, 'src'))
  .filter((f) => !/\/test-support\//.test(f))
  .sort();
const DAEMON_WALK = closure(DAEMON_ENTRIES);
const DAEMON_CLOSURE = [...DAEMON_WALK.modules].sort();

/** The seam's own module is excluded; a declaration is not a call site. */
function offendingArities(
  files: readonly string[],
  name: string,
  limit: number,
  allowed: readonly string[] = [],
): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    const rel = relative(REPO_ROOT, file);
    if (SEAM_MODULES.includes(rel) || allowed.includes(rel)) continue;
    for (const call of callsTo(parseSource(file), name)) {
      const arity = arityOf(call);
      if (arity === SPREAD) offenders.push(`${rel} spread call to ${call.expression.getText()}`);
      else if (arity > limit) offenders.push(`${rel} arity ${arity}`);
    }
  }
  return offenders;
}

/**
 * The writes `source` names at the type level.
 *
 * `Parameters<typeof fencedInsert>[3]` is the clock's type without either
 * clock type's name, so the name search below could not see it. Neither
 * could `(typeof ledger)['fencedInsert']`, which names the write as an
 * index rather than in the query (review finding K8). A shipped module has
 * no reason to reach for the signature of a write it calls.
 */
function typeReferencesIn(source: ts.SourceFile): string[] {
  const queried = nodesOf(source).filter(ts.isTypeQueryNode)
    .map((query) => query.exprName.getText().split('.').pop()!);
  const indexed = nodesOf(source).filter(ts.isIndexedAccessTypeNode)
    .map((access) => access.indexType)
    .filter((index): index is ts.LiteralTypeNode => ts.isLiteralTypeNode(index))
    .map((index) => nameText(index.literal) ?? '');
  return [...queried, ...indexed].filter((name) => WRITES.includes(name));
}

function offendingTypeReferences(files: readonly string[]): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    const rel = relative(REPO_ROOT, file);
    if (SEAM_MODULES.includes(rel)) continue;
    if (typeReferencesIn(parseSource(file)).length > 0) offenders.push(rel);
  }
  return offenders;
}

function offendingTypeNames(
  files: readonly string[],
  allowed: readonly string[] = [],
): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    const rel = relative(REPO_ROOT, file);
    if (SEAM_MODULES.includes(rel) || allowed.includes(rel)) continue;
    const named = nodesOf(parseSource(file)).filter(ts.isIdentifier)
      .some((node) => node.text === 'SeededInsertClock' || node.text === 'SeededFinishClock');
    if (named) offenders.push(rel);
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

  // Each write is called from shipped code, and each call is read. A reader
  // blind to one of them would pass the arity cases below for that write.
  it('reads a real call to each write', () => {
    const read = (rel: string, write: string): number => callsTo(parseSource(join(REPO_ROOT, rel)), write).length;
    expect(read('src/approval/approve.ts', 'fencedTransition')).toBeGreaterThan(0);
    expect(read('src/coordinator/steps/context.ts', 'fencedTransition')).toBeGreaterThan(0);
    expect(read('src/seed/write.ts', 'fencedInsert')).toBeGreaterThan(0);
  });

  it('can read the module every shipped import names', () => {
    expect(SHIPPED.flatMap((file) => importsOf(file).unresolved)).toEqual([]);
  });

  it('passes no clock to fencedInsert from any shipped module', () => {
    expect(offendingArities(SHIPPED, 'fencedInsert', 3, SEEDER_MODULES)).toEqual([]);
  });

  it('passes no clock to fencedTransition from any shipped module', () => {
    expect(offendingArities(SHIPPED, 'fencedTransition', 2, SEEDER_MODULES)).toEqual([]);
  });

  // An arity check alone would miss a module that builds a clock and hands
  // it on through a helper of its own.
  it('names neither clock type in any shipped module', () => {
    expect(offendingTypeNames(SHIPPED, SEEDER_MODULES)).toEqual([]);
  });

  it('reaches for neither write signature in any shipped module', () => {
    expect(offendingTypeReferences(SHIPPED)).toEqual([]);
  });

  // The whole class, not a fourth member of it.
  it('names neither write except to call it, in any shipped module', () => {
    expect(offendingMentions(SHIPPED, SEEDER_MODULES)).toEqual([]);
  });
});

// An exception nobody can check is a hole. These pin what it covers, that it
// covers exactly one file, and that the file it covers really does need it.
describe('the seeder exception', () => {
  it('names exactly one module', () => {
    expect(SEEDER_MODULES).toEqual(['src/seed/write.ts']);
  });

  it('names a module that exists and is scanned', () => {
    const rels = SHIPPED.map((f) => relative(REPO_ROOT, f));
    for (const seeder of SEEDER_MODULES) expect(rels).toContain(seeder);
  });

  // If the seeder stopped passing a clock the exception would be dead, and a
  // dead exception is a hole waiting for the next module that lands under it.
  it('covers a module that really does supply a clock', () => {
    const offenders = offendingArities(
      SHIPPED.filter((f) => SEEDER_MODULES.includes(relative(REPO_ROOT, f))),
      'fencedInsert',
      3,
    );
    expect(offenders).toHaveLength(1);
  });

  // The guarantee. The exception is the shipped rule's alone.
  it('is not honoured by the daemon closure', () => {
    const rels = DAEMON_CLOSURE.map((f) => relative(REPO_ROOT, f));
    for (const seeder of SEEDER_MODULES) expect(rels).not.toContain(seeder);
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

  // A module reached through an import the walker cannot resolve is not in
  // the closure, and neither is anything behind it.
  it('resolves every import on the way', () => {
    expect(DAEMON_WALK.unresolved).toEqual([]);
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
  const names = (text: string, name: string): string[] => [...localNames(parseSource('source.ts', text), name)];

  it('finds the plain name', () => {
    expect(names("import { fencedInsert } from './x.js';", 'fencedInsert')).toEqual(['fencedInsert']);
  });

  // The evasion. An alias is a rename, not an escape.
  it('finds an alias', () => {
    expect(names("import { fencedInsert as fi } from './x.js';", 'fencedInsert')).toEqual(['fencedInsert', 'fi']);
  });

  it('finds an alias of the transition too', () => {
    expect(names("import { fencedTransition as ft } from './x.js';", 'fencedTransition')).toContain('ft');
  });

  it('finds a name destructured from a dynamic import, under any key spelling', () => {
    expect(names("const { fencedInsert: fi } = await import('./x.js');", 'fencedInsert')).toContain('fi');
    expect(names("const { 'fencedInsert': fi } = await import('./x.js');", 'fencedInsert')).toContain('fi');
  });

  it('finds an alias an import-equals declaration makes', () => {
    expect(names("import * as ledger from './x.js'; import fi = ledger.fencedInsert;", 'fencedInsert')).toContain('fi');
  });
});

describe('a spread call', () => {
  it('is refused rather than counted as one argument', () => {
    expect(callArities('fencedInsert(...args);', 'fencedInsert')).toEqual([SPREAD]);
  });

  it('is refused when the spread comes after real arguments', () => {
    expect(callArities('fencedInsert(pool, run, ...rest);', 'fencedInsert')).toEqual([SPREAD]);
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

  const mentions = (text: string): string[] => mentionsIn(parseSource('source.ts', text));

  it('reads an import and a call as neither a mention', () => {
    expect(mentions("import { fencedInsert } from '../ledger/insert.js'; await fencedInsert(pool, run, null);"))
      .toEqual([]);
    expect(mentions("import {\n  fencedInsert,\n  fencedTransition,\n} from '../ledger/insert.js';")).toEqual([]);
    expect(mentions("import * as ledger from '../ledger/insert.js'; await ledger.fencedInsert(pool, run, null);"))
      .toEqual([]);
    expect(mentions("const { fencedInsert } = await import('../ledger/insert.js');")).toEqual([]);
  });

  it('refuses every other mention', () => {
    expect(mentions("import * as ledger from './insert.js'; import ft = ledger.fencedTransition;"))
      .toEqual(['fencedTransition']);
    // A default value is an expression, not the name a destructure binds.
    expect(mentions('const { w = fencedTransition } = {} as Record<string, never>; await w(pool, run, clock);'))
      .toEqual(['fencedTransition']);
    // An alias is the write, so handing it on is handing the write on.
    expect(mentions("import { fencedInsert as fi } from './insert.js'; export const leaked = wrap(fi);"))
      .toEqual(['fencedInsert']);
    expect(mentions("const { fencedTransition: ft } = await import('../ledger/insert.js'); const w = ft;"))
      .toEqual(['fencedTransition']);
    expect(mentions("import { fencedTransition as ftAlias } from './insert.js'; const w = ftAlias;"))
      .toEqual(['fencedTransition']);
    // The namespace holds both writes, so it may be read through a member alone.
    expect(mentions("import * as ledger from '../ledger/insert.js'; helper(ledger);"))
      .toEqual(['the ledger namespace']);
    expect(mentions("import * as ledger from '../ledger/insert.js'; const { fencedInsert: fi } = ledger;"))
      .toEqual(['the ledger namespace']);
    // A key the source states through a constant, and one built at runtime.
    expect(mentions("import * as ledger from '../ledger/insert.js'; const WRITE = 'fencedTransition'; const w = ledger[WRITE];"))
      .toEqual(['fencedTransition']);
    expect(mentions("import * as ledger from '../ledger/insert.js'; const w = ledger['fenced' + name];"))
      .toEqual(['the ledger namespace']);
    // A dynamic import binds the namespace as surely as a static one.
    expect(mentions("const ledger = await import('../ledger/insert.js'); helper(ledger);"))
      .toEqual(['the ledger namespace']);
    // And a dynamic import that binds no const hands the module on.
    expect(mentions("import('../ledger/insert.js').then((m) => m['fenced' + 'Transition'](pool, run, clock));"))
      .toEqual(['a dynamic import of the ledger']);
    expect(mentions("let ledger; ledger = await import('../ledger/insert.js'); helper(ledger);"))
      .toEqual(['a dynamic import of the ledger']);
    expect(mentions("const { ...all } = await import('../ledger/insert.js');")).toEqual(['a dynamic import of the ledger']);
    expect(mentions("import * as ledger from './insert.js'; const w = ledger['fencedInsert'];")).toEqual(['fencedInsert']);
    expect(mentions('const write = fencedInsert;')).toEqual(['fencedInsert']);
    expect(mentions('export { fencedTransition };')).toEqual(['fencedTransition']);
    expect(mentions('type P = Parameters<typeof fencedInsert>;')).toEqual(['fencedInsert']);
    expect(mentions('helper(fencedInsert);')).toEqual(['fencedInsert']);
  });

  it('reads a member of another object that shares an alias name as no mention', () => {
    expect(mentions("import { fencedInsert as fi } from './insert.js'; await fi(pool, run, null); other.fi = 1;"))
      .toEqual([]);
  });

  it('refuses a write named as an index at the type level', () => {
    const types = (text: string): string[] => typeReferencesIn(parseSource('source.ts', text));
    expect(types("import * as l from './insert.js'; type C = Parameters<(typeof l)['fencedInsert']>[3];"))
      .toEqual(['fencedInsert']);
    expect(types('type C = Parameters<typeof fencedTransition>[2];')).toEqual(['fencedTransition']);
    expect(types("type C = Parameters<(typeof l)['other']>[3];")).toEqual([]);
  });

  it('reads a name in a string or a comment as no mention', () => {
    expect(mentions("const s = 'fencedInsert'; // fencedTransition\n/* fencedInsert */")).toEqual([]);
  });
});

// Issue #146. The guard reads a comment as trivia and a string as a string,
// so neither can hide a call from it nor invent one.
describe('a call the old patterns could not see', () => {
  it('reads no call written in a comment of either kind', () => {
    expect(callArities('const a = 1; // f(a, b, c, d)', 'f')).toEqual([]);
    expect(callArities('/* f(a, b, c, d) */ const a = 1;', 'f')).toEqual([]);
  });

  it('reads a call after a URL in a string, and in a template literal', () => {
    expect(callArities("const u = 'https://example.test/v1'; f(a, b, c, d);", 'f')).toEqual([4]);
    expect(callArities('const u = `https://example.test/${v}`; f(a, b, c, d);', 'f')).toEqual([4]);
  });

  // An apostrophe inside a double-quoted string paired with the next single
  // quote on the line, and the call between them was blanked.
  it('reads a call after a double-quoted string that holds an apostrophe', () => {
    expect(callArities(`const a = "it's"; fencedInsert(pool, run, null, clock); const b = 'x';`, 'fencedInsert'))
      .toEqual([4]);
  });

  it('reads a call through an element access, an import alias and a quoted key', () => {
    expect(callArities("ledger['fencedInsert'](pool, run, null, clock);", 'fencedInsert')).toEqual([4]);
    expect(callArities("import fi = ledger.fencedInsert; fi(pool, run, null, clock);", 'fencedInsert')).toEqual([4]);
    expect(callArities("const { 'fencedInsert': fi } = m; fi(pool, run, null, clock);", 'fencedInsert')).toEqual([4]);
    expect(callArities('ledger[`fencedTransition`](pool, run, clock);', 'fencedTransition')).toEqual([3]);
    expect(callArities("const WRITE = 'fencedTransition'; ledger[WRITE](pool, run, clock);", 'fencedTransition')).toEqual([3]);
  });

  it('reads a call after a regular expression that holds a quote', () => {
    expect(callArities(`const r = /"'/; fencedInsert(pool, run, null, clock); const b = "x";`, 'fencedInsert'))
      .toEqual([4]);
  });
});

describe('importsOf, on every form a specifier can take', () => {
  const specifiers = (text: string): string[] => relativeSpecifiers(parseSource('source.ts', text)).relative;

  // Every quote a specifier can wear, and every statement that names one.
  // Nothing in this repository enforces which a writer picks.
  it('reads every form', () => {
    expect(specifiers("import { x } from './a.js';")).toEqual(['./a.js']);
    expect(specifiers('import { x } from "./a.js";')).toEqual(['./a.js']);
    expect(specifiers("export { x } from './a.js';")).toEqual(['./a.js']);
    expect(specifiers("import x = require('./a.js');")).toEqual(['./a.js']);
    expect(specifiers("const m = await import('./a.js');")).toEqual(['./a.js']);
    expect(specifiers('const m = await import("./a.js");')).toEqual(['./a.js']);
    expect(specifiers('const m = await import(`./a.js`);')).toEqual(['./a.js']);
    expect(specifiers("const m = require('./a.js');")).toEqual(['./a.js']);
  });

  // The module a runtime specifier reaches is not one the source names.
  it('reads a specifier built at runtime as unreadable', () => {
    const unreadable = (text: string): string[] => relativeSpecifiers(parseSource('source.ts', text)).unreadable;
    expect(unreadable('const m = await import(path);')).toEqual(['import(path)']);
    expect(unreadable('const m = await import(`./${name}.js`);')).toEqual(['import(`./${name}.js`)']);
    expect(unreadable('const m = require(path);')).toEqual(['require(path)']);
    expect(unreadable("const m = await import('./a.js');")).toEqual([]);
    // The package's own name leads to compiled output, not to this source.
    expect(unreadable(`import { x } from '${PACKAGE_NAME}/cli';`)).toEqual([`import { x } from '${PACKAGE_NAME}/cli';`]);
  });

  it('refuses a relative import that resolves to no source file', () => {
    const at = join(REPO_ROOT, 'src/ledger/clock-reachability.test.ts');
    const resolveOne = (specifier: string) =>
      ts.resolveModuleName(specifier, at, COMPILER_OPTIONS, ts.sys).resolvedModule?.resolvedFileName;
    expect(resolveOne('./insert.js')).toBe(join(REPO_ROOT, 'src/ledger/insert.ts'));
    expect(resolveOne('./no-such-module.js')).toBeUndefined();
  });

  it('follows no package import and no specifier in a comment', () => {
    expect(specifiers("import pg from 'pg'; // import { x } from './a.js';")).toEqual([]);
  });

  it('finds a static relative import in a shipped module', () => {
    expect(importsOf(join(REPO_ROOT, 'src/coordinator/consumer-main.ts')).resolved.length).toBeGreaterThan(0);
  });

  it('follows a dynamic relative import into the closure', () => {
    // The repository writes this form, and a walker blind to it would drop
    // every module reached only that way.
    const dynamic = importsOf(join(REPO_ROOT, 'src/goldreport/run.ts')).resolved;
    expect(dynamic.some((f) => /src\//.test(f))).toBe(true);
  });
});
