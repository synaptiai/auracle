// Every pool the shipped code opens is guarded against a client that fails
// while a caller holds it (src/db/client-errors.ts). Without the guard that
// failure ends the process, and no try/catch sees it, so a new pool built
// without one is refused here by name.
//
// Parsed, not matched: each `new Pool(...)` must be the first argument of a
// `guardLedgerPool(...)` call.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function shipped(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'test-support' || name === 'node_modules' || name === 'dist') continue;
      out.push(...shipped(full));
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** An expression with the wrappers that change no value removed: await, parentheses and casts. */
function strip(expression: ts.Expression): ts.Expression {
  let at = expression;
  while (ts.isAwaitExpression(at) || ts.isParenthesizedExpression(at) || ts.isAsExpression(at)
    || ts.isNonNullExpression(at) || ts.isSatisfiesExpression(at) || ts.isTypeAssertionExpression(at)) {
    at = at.expression;
  }
  return at;
}

/**
 * The names `pg`'s Pool goes by in a file, the names of `pg` itself, and a
 * test for an expression that is the Pool.
 *
 * `pg` is bound by an import, by an import-equals `require` and by a dynamic
 * `import('pg')`, including the default a dynamic import hands back. A
 * second name for either is the same value: `const { Pool } = pg`,
 * `const P = pg.Pool`, `import P = pg.Pool`, `pg ??= await import('pg')`
 * and the parameter of `import('pg').then(…)`. The walk repeats until no new
 * name appears, because one name can lead to the next.
 */
function poolNames(source: ts.SourceFile): {
  pools: Set<string>;
  modules: Set<string>;
  isPool: (expression: ts.Expression) => boolean;
} {
  const pools = new Set<string>();
  const modules = new Set<string>();
  for (const statement of source.statements) {
    // `import pg = require('pg')` binds the module as a default import does.
    if (ts.isImportEqualsDeclaration(statement) && !statement.isTypeOnly
      && ts.isExternalModuleReference(statement.moduleReference)
      && ts.isStringLiteral(statement.moduleReference.expression)
      && statement.moduleReference.expression.text === 'pg') {
      modules.add(statement.name.text);
      continue;
    }
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== 'pg') continue;
    const clause = statement.importClause;
    if (clause === undefined || clause.phaseModifier === ts.SyntaxKind.TypeKeyword) continue;
    if (clause.name !== undefined) modules.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (bindings !== undefined && ts.isNamespaceImport(bindings)) modules.add(bindings.name.text);
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if ((element.propertyName ?? element.name).text === 'Pool' && !element.isTypeOnly) pools.add(element.name.text);
      }
    }
  }
  const loadsPg = (expression: ts.Expression): boolean => {
    const at = strip(expression);
    return ts.isCallExpression(at) && at.expression.kind === ts.SyntaxKind.ImportKeyword
      && at.arguments[0] !== undefined && ts.isStringLiteralLike(at.arguments[0]) && at.arguments[0].text === 'pg';
  };
  const isModule = (expression: ts.Expression): boolean => {
    const at = strip(expression);
    if (ts.isIdentifier(at)) return modules.has(at.text);
    if (loadsPg(at)) return true;
    return ts.isPropertyAccessExpression(at) && at.name.text === 'default' && isModule(at.expression);
  };
  const isPool = (expression: ts.Expression): boolean => {
    const at = strip(expression);
    if (ts.isIdentifier(at)) return pools.has(at.text);
    return ts.isPropertyAccessExpression(at) && at.name.text === 'Pool' && isModule(at.expression);
  };
  // A name bound to the module: the name itself, or the Pool and the default
  // a destructure takes from it.
  const bindModule = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      modules.add(name.text);
      return;
    }
    if (!ts.isObjectBindingPattern(name)) return;
    for (const element of name.elements) {
      const key = element.propertyName ?? element.name;
      if (!ts.isIdentifier(key)) continue;
      if (key.text === 'Pool' && ts.isIdentifier(element.name)) pools.add(element.name.text);
      if (key.text === 'default') bindModule(element.name);
    }
  };
  const assigning = new Set([
    ts.SyntaxKind.EqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken, ts.SyntaxKind.BarBarEqualsToken,
  ]);
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      if (isModule(node.initializer)) bindModule(node.name);
      else if (isPool(node.initializer) && ts.isIdentifier(node.name)) pools.add(node.name.text);
    }
    if (ts.isBinaryExpression(node) && assigning.has(node.operatorToken.kind) && ts.isIdentifier(node.left)) {
      if (isModule(node.right)) modules.add(node.left.text);
      else if (isPool(node.right)) pools.add(node.left.text);
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isQualifiedName(node.moduleReference)
      && node.moduleReference.right.text === 'Pool' && ts.isIdentifier(node.moduleReference.left)
      && modules.has(node.moduleReference.left.text)) {
      pools.add(node.name.text);
    }
    // `import('pg').then((m) => …)` hands the module to the callback.
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'then' && isModule(node.expression.expression)) {
      const callback = node.arguments[0];
      const parameter = callback !== undefined && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
        ? callback.parameters[0]
        : undefined;
      if (parameter !== undefined) bindModule(parameter.name);
    }
    ts.forEachChild(node, visit);
  };
  let before = -1;
  while (pools.size + modules.size !== before) {
    before = pools.size + modules.size;
    visit(source);
  }
  return { pools, modules, isPool };
}

/** Each construction of `pg`'s Pool in a file, and whether it is the guard's first argument. */
function pools(file: string): { line: number; guarded: boolean }[] {
  return poolsIn(file, readFileSync(file, 'utf8'));
}

function poolsIn(file: string, text: string): { line: number; guarded: boolean }[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const names = poolNames(source);
  const found: { line: number; guarded: boolean }[] = [];
  const isPool = names.isPool;
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && isPool(node.expression)) {
      const parent = node.parent;
      const guarded = ts.isCallExpression(parent)
        && ts.isIdentifier(parent.expression)
        && parent.expression.text === 'guardLedgerPool'
        && parent.arguments[0] === node;
      found.push({ line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, guarded });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('the pools the shipped code opens', () => {
  const files = [...shipped(path.join(ROOT, 'src')), ...shipped(path.join(ROOT, 'console/src'))];

  it('guard every client a caller holds', () => {
    const unguarded = files.flatMap((file) => pools(file)
      .filter((pool) => !pool.guarded)
      .map((pool) => `${path.relative(ROOT, file)}:${String(pool.line)}`));
    expect(unguarded).toEqual([]);
  });

  it('finds the Pool under another name, and pg.Pool', () => {
    const probe = (text: string) => poolsIn('probe.ts', text).map((pool) => pool.guarded);
    expect(probe("import { Pool as P } from 'pg';\nconst a = new P();")).toEqual([false]);
    expect(probe("import pg from 'pg';\nconst a = new pg.Pool();")).toEqual([false]);
    expect(probe("import * as pg from 'pg';\nconst a = new pg.Pool();")).toEqual([false]);
    // An import-equals require loads `pg` as surely as an import does.
    expect(probe("import pg = require('pg');\nconst a = new pg.Pool();")).toEqual([false]);
    expect(probe("import type pg = require('pg');\nconst a = new pg.Pool();")).toEqual([]);
    // A second name for the Pool is the Pool.
    expect(probe("import pg from 'pg';\nconst { Pool } = pg;\nconst a = new Pool();")).toEqual([false]);
    expect(probe("import pg from 'pg';\nconst { Pool: P } = pg;\nconst a = new P();")).toEqual([false]);
    expect(probe("import pg from 'pg';\nconst P = pg.Pool;\nconst a = new P();")).toEqual([false]);
    expect(probe("import * as pg from 'pg';\nimport P = pg.Pool;\nconst a = new P();")).toEqual([false]);
    expect(probe("import pg from 'pg';\nconst { Pool } = pg;\nconst a = guardLedgerPool(new Pool(), log);")).toEqual([true]);
    // A lazy load binds the module, or the Pool, as an import does.
    expect(probe("export async function f() { const pg = await import('pg');\nreturn new pg.Pool(); }")).toEqual([false]);
    expect(probe("export async function f() { const { Pool } = await import('pg');\nreturn new Pool(); }")).toEqual([false]);
    expect(probe("export async function f() { const { default: pg } = await import('pg');\nreturn new pg.Pool(); }")).toEqual([false]);
    // The default a dynamic import hands back, a `.then` callback, a cached
    // module and a constructor read straight off the load.
    expect(probe("export async function f() { const pg = (await import('pg')).default;\nreturn new pg.Pool(); }")).toEqual([false]);
    expect(probe("export async function f() { const { Pool } = (await import('pg')).default;\nreturn new Pool(); }")).toEqual([false]);
    expect(probe("export async function f() { const { default: { Pool } } = await import('pg');\nreturn new Pool(); }")).toEqual([false]);
    expect(probe("export const f = () => import('pg').then((m) => new m.Pool());")).toEqual([false]);
    expect(probe("export const f = () => import('pg').then(({ Pool }) => new Pool());")).toEqual([false]);
    expect(probe("let pg: unknown;\nexport async function f() { pg ??= await import('pg');\nreturn new (pg as any).Pool(); }")).toEqual([false]);
    expect(probe("export async function f() { return new (await import('pg')).Pool(); }")).toEqual([false]);
    expect(probe("export const f = () => import(`pg`).then((m) => new m.Pool());")).toEqual([false]);
    // A dynamic import of another module binds nothing.
    expect(probe("export async function f() { const pg = await import('pg-pool');\nreturn new pg.Pool(); }")).toEqual([]);
    expect(probe("import { Pool as P } from 'pg';\nconst a = guardLedgerPool(new P(), log);")).toEqual([true]);
    // A type-only import names no constructor.
    expect(probe("import type { Pool } from 'pg';\nclass Pool {}\nconst a = new Pool();")).toEqual([]);
  });

  it('are found at all, so an empty sweep cannot pass', () => {
    expect(files.flatMap((file) => pools(file)).length).toBeGreaterThanOrEqual(14);
  });
});
