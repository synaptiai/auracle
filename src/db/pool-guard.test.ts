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

/** The local names `pg`'s Pool goes by in a file, and the names of `pg` itself. */
function poolNames(source: ts.SourceFile): { pools: Set<string>; modules: Set<string> } {
  const pools = new Set<string>();
  const modules = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== 'pg') continue;
    const clause = statement.importClause;
    if (clause === undefined || clause.isTypeOnly) continue;
    if (clause.name !== undefined) modules.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (bindings !== undefined && ts.isNamespaceImport(bindings)) modules.add(bindings.name.text);
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if ((element.propertyName ?? element.name).text === 'Pool' && !element.isTypeOnly) pools.add(element.name.text);
      }
    }
  }
  return { pools, modules };
}

/** Each construction of `pg`'s Pool in a file, and whether it is the guard's first argument. */
function pools(file: string): { line: number; guarded: boolean }[] {
  return poolsIn(file, readFileSync(file, 'utf8'));
}

function poolsIn(file: string, text: string): { line: number; guarded: boolean }[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const names = poolNames(source);
  const found: { line: number; guarded: boolean }[] = [];
  const isPool = (expression: ts.Expression): boolean =>
    (ts.isIdentifier(expression) && names.pools.has(expression.text))
    || (ts.isPropertyAccessExpression(expression) && expression.name.text === 'Pool'
      && ts.isIdentifier(expression.expression) && names.modules.has(expression.expression.text));
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
    expect(probe("import { Pool as P } from 'pg';\nconst a = guardLedgerPool(new P(), log);")).toEqual([true]);
    // A type-only import names no constructor.
    expect(probe("import type { Pool } from 'pg';\nclass Pool {}\nconst a = new Pool();")).toEqual([]);
  });

  it('are found at all, so an empty sweep cannot pass', () => {
    expect(files.flatMap((file) => pools(file)).length).toBeGreaterThanOrEqual(14);
  });
});
