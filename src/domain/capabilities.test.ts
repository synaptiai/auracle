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

/** The corpus types, held to the same import rule as this module's own home. */
const TYPES = 'src/domain/gold-types.ts';

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

/**
 * The modules a file loads at runtime, in source order.
 *
 * Parsed with the compiler, because a line regex is defeated by ordinary
 * spellings. `export { X } from './y.js'` is a module load and does not
 * begin with the word `import`; `import { type A, B } from './x.js'` is one
 * too, and its first specifier says `type`.
 *
 * A clause marked `type` in full is erased at emit and names nothing here.
 * A clause with one value specifier is a load, whatever else it carries.
 * A bare `import './x.js'` has no clause at all and is a load for its
 * side effects alone.
 */
function runtimeSpecifiers(source: string): string[] {
  const parsed = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.ESNext, true);
  const loaded: string[] = [];
  for (const statement of parsed.statements) {
    let clause: ts.ImportClause | ts.NamedExportBindings | undefined;
    let specifier: ts.Expression | undefined;
    if (ts.isImportDeclaration(statement)) {
      clause = statement.importClause;
      specifier = statement.moduleSpecifier;
      // `import './x.js'` carries no clause and still loads the module.
      if (clause !== undefined && clause.isTypeOnly) continue;
    } else if (ts.isExportDeclaration(statement)) {
      if (statement.moduleSpecifier === undefined) continue;
      clause = statement.exportClause;
      specifier = statement.moduleSpecifier;
      if (statement.isTypeOnly) continue;
    } else {
      continue;
    }
    // A named clause whose every specifier says `type` emits nothing, the
    // same as a clause-level `type`. TypeScript allows either spelling.
    if (clause !== undefined && ts.isNamedImports(clause.kind === ts.SyntaxKind.ImportClause
      ? ((clause as ts.ImportClause).namedBindings ?? clause)
      : clause)) {
      const named = clause.kind === ts.SyntaxKind.ImportClause
        ? ((clause as ts.ImportClause).namedBindings as ts.NamedImports)
        : (clause as ts.NamedImports | ts.NamedExports);
      if (named.elements.length > 0 && named.elements.every((element) => element.isTypeOnly)) {
        continue;
      }
    }
    if (specifier !== undefined && ts.isStringLiteral(specifier)) loaded.push(specifier.text);
  }
  return loaded;
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
      TYPES,
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

  it('leaves the former homes re-exporting rather than declaring', () => {
    // A re-export keeps every existing importer working, so nothing had to
    // move to fix the split.
    const policy = read('src/policy/policy.ts');
    const adapters = read('src/adapters/types.ts');
    const from = '../domain/capabilities.js';
    expect(reExportsFrom(policy, 'AdapterCapabilities', from)).toBe(true);
    expect(reExportsFrom(policy, 'RiskTier', from)).toBe(true);
    expect(reExportsFrom(adapters, 'AdapterCapabilities', from)).toBe(true);
    // `src/fixtures/load.ts` held the fixture corpus's copy and re-exported
    // here. The corpus types moved to a sibling of this file, so that is the
    // module that surfaces the tier to them now, and the specifier is
    // relative to this directory rather than up out of `src/fixtures/`.
    expect(reExportsFrom(read(TYPES), 'RiskTier', './capabilities.js')).toBe(true);
  });

  it('imports nothing, so a type does not drag a module behind it', () => {
    // The reason the fixture loader's copy existed: any module that wanted
    // the word `RiskTier` had to import fixture file I/O to get it.
    expect(read(HOME)).not.toMatch(/^\s*import\b/m);
  });

  it('the corpus types import no value, so they drag no module either', () => {
    // A weaker rule than the one above, and deliberately so.
    // `TaxonomyIntent.risk_tier` is a `RiskTier`, and the tier is declared
    // here and nowhere else, so `gold-types.ts` has to name this module to
    // have the symbol in scope. `export type { RiskTier } from` re-exports it
    // without binding it locally, so a type-only import stands beside it.
    //
    // What matters is the emitted output, not the line count. TypeScript
    // erases an `import type`, so the compiled `gold-types.js` requires
    // nothing and a caller who wants the word `Taxonomy` loads one file.
    // A value import would not be erased, and that is what this refuses.
    expect(runtimeSpecifiers(read(TYPES))).toEqual([]);
  });

  it('reads a re-export as a runtime load, because that is what it compiles to', () => {
    // The first version of the rule above was a line regex anchored on
    // `import`. `export { RISK_TIERS } from './capabilities.js';` is one word
    // from the line the file actually carries, emits a real module load, and
    // walked straight through: the line begins with `export`, so the filter
    // never saw it, and every other case in this file stayed green while the
    // module's whole reason for existing was false.
    //
    // Parsed now, not matched. Both directions are asserted, because a
    // detector that flags everything and a detector that flags nothing both
    // make the case above pass.
    expect(runtimeSpecifiers("export { RISK_TIERS } from './capabilities.js';"))
      .toEqual(['./capabilities.js']);
    expect(runtimeSpecifiers("import { readFileSync } from 'node:fs';")).toEqual(['node:fs']);
    expect(runtimeSpecifiers("import ts from 'typescript';")).toEqual(['typescript']);
    expect(runtimeSpecifiers("import './side-effect.js';")).toEqual(['./side-effect.js']);
    // An inline `type` specifier among value ones does not save the line.
    expect(runtimeSpecifiers("import { type A, B } from './x.js';")).toEqual(['./x.js']);

    // Erased at emit, so none of these is a load.
    expect(runtimeSpecifiers("import type { RiskTier } from './capabilities.js';")).toEqual([]);
    expect(runtimeSpecifiers("export type { RiskTier } from './capabilities.js';")).toEqual([]);
    expect(runtimeSpecifiers("export type { A, B } from './x.js';")).toEqual([]);
    // Every specifier marked `type` individually: the clause emits nothing.
    expect(runtimeSpecifiers("import { type A, type B } from './x.js';")).toEqual([]);
    // A local re-export names no module and loads none.
    expect(runtimeSpecifiers('export { thing };')).toEqual([]);
  });
});
