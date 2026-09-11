// The contract stays single-sourced (issue #70, DEC-06).
//
// `AdapterCapabilities` was defined in `src/policy/policy.ts` and again in
// `src/adapters/types.ts`, both comments claiming to be "the exact shape from
// section 4.1". Adapters declared against one copy and the policy engine read
// the other, and structural typing carried objects between them. A sixth flag
// added to either side compiled, the other side never saw it, and nothing
// failed. `RiskTier` had the same split between `policy.ts` and
// `src/fixtures/load.ts`.
//
// A type error is what should stop that returning, and a type error cannot be
// written as a test. So this reads the tree: exactly one file may declare each
// of these names.
//
// It parses rather than greps. The first version matched
// `export interface AdapterCapabilities`, and adversarial review defeated it
// in one line: `export type AdapterCapabilities = { ... }` declares the same
// contract, is structurally interchangeable with the interface, and matched
// no pattern. A second declaration therefore sat in the tree with the guard
// green — the exact split it exists to prevent. An interface, a type alias, a
// separate declaration re-exported through `export { type X }`: the parser
// sees all three as declarations, because that is what they are.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The one file allowed to declare them. */
const HOME = 'src/domain/capabilities.ts';

/** The names that must have exactly one declaration each. */
const SINGLE = ['AdapterCapabilities', 'RiskTier', 'RISK_TIERS'];

/**
 * Both packages. `console/` is a separate package that imports the core's
 * compiled output, so a second declaration there would split the contract
 * just as effectively. Nothing lives there today; the scan says so rather
 * than leaving it unexamined.
 */
const ROOTS = ['src', join('console', 'src')];

/** Every name this source *declares*, as opposed to re-exports. */
export function declaredNames(source: string): string[] {
  const tree = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.ES2022, true);
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    // `export type X = ...` and `export interface X { ... }`.
    if (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) {
      names.push(node.name.text);
    }
    // `export const X = ...`, and a plain `const X` that is exported later.
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      names.push(node.name.text);
    }
    if (ts.isEnumDeclaration(node) || ts.isClassDeclaration(node)) {
      if (node.name !== undefined) names.push(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return names;
}

/** True when the source re-exports a name from elsewhere rather than declaring it. */
export function reExportsFrom(source: string, name: string, from: string): boolean {
  const tree = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.ES2022, true);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isExportDeclaration(node)
      && node.moduleSpecifier !== undefined
      && ts.isStringLiteral(node.moduleSpecifier)
      && node.moduleSpecifier.text === from
      && node.exportClause !== undefined
      && ts.isNamedExports(node.exportClause)
      && node.exportClause.elements.some((element) => element.name.text === name)
    ) {
      found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, found);
      continue;
    }
    if (entry.endsWith('.ts')) found.push(relative(REPO_ROOT, full).split(sep).join('/'));
  }
  return found;
}

const FILES = ROOTS.flatMap((root) => sourceFiles(join(REPO_ROOT, root)));
const read = (file: string): string => readFileSync(join(REPO_ROOT, file), 'utf8');

describe('the adapter contract has one declaration', () => {
  it('scanned both packages, so an empty offender list means something', () => {
    expect(FILES.length).toBeGreaterThan(100);
    for (const required of [
      HOME,
      'src/policy/policy.ts',
      'src/adapters/types.ts',
      'src/fixtures/load.ts',
    ]) {
      expect(FILES).toContain(required);
    }
    // The console is a separate package and is scanned too.
    expect(FILES.some((file) => file.startsWith('console/src/'))).toBe(true);
  });

  it('still reads a declaration in any of its spellings', () => {
    // Without this the scan could pass because the parser walk broke.
    expect(declaredNames('export interface AdapterCapabilities { a: boolean }')).toContain(
      'AdapterCapabilities',
    );
    expect(declaredNames('export type AdapterCapabilities = { a: boolean };')).toContain(
      'AdapterCapabilities',
    );
    expect(declaredNames("type RiskTier = 'low';\nexport { type RiskTier };")).toContain(
      'RiskTier',
    );
    expect(declaredNames("export const RISK_TIERS = ['low'] as const;")).toContain('RISK_TIERS');
    // A re-export declares nothing.
    expect(declaredNames("export type { RiskTier } from './domain/capabilities.js';")).toEqual([]);
  });

  for (const name of SINGLE) {
    it(`declares ${name} in exactly one file`, () => {
      const declarers = FILES.filter((file) => declaredNames(read(file)).includes(name));
      expect(declarers).toEqual([HOME]);
    });
  }

  it('leaves the two former homes re-exporting rather than declaring', () => {
    // A re-export keeps every existing importer working, so nothing had to
    // move to fix the split.
    const policy = read('src/policy/policy.ts');
    const adapters = read('src/adapters/types.ts');
    const fixtures = read('src/fixtures/load.ts');
    const from = '../domain/capabilities.js';
    expect(reExportsFrom(policy, 'AdapterCapabilities', from)).toBe(true);
    expect(reExportsFrom(policy, 'RiskTier', from)).toBe(true);
    expect(reExportsFrom(adapters, 'AdapterCapabilities', from)).toBe(true);
    expect(reExportsFrom(fixtures, 'RiskTier', from)).toBe(true);
  });

  it('imports nothing, so a type does not drag a module behind it', () => {
    // The reason the fixture loader's copy existed: any module that wanted
    // the word `RiskTier` had to import fixture file I/O to get it.
    expect(read(HOME)).not.toMatch(/^\s*import\b/m);
  });
});
