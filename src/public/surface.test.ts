// The public surface is the whole of what another package may import.
//
// Three rules, none of which stays true by itself. This reads the files
// rather than trusting a review. A `package.json` that publishes `./dist/*`
// makes every compiled file public API, and nothing says otherwise.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PUBLIC_DIR = join(REPO_ROOT, 'src/public');
const SRC_DIR = join(REPO_ROOT, 'src');

/** Every module specifier a file imports or re-exports from. */
function specifiersOf(source: string): string[] {
  const tree = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.ES2022, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier !== undefined
      && ts.isStringLiteral(node.moduleSpecifier)
    ) {
      found.push(node.moduleSpecifier.text);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(tree, visit);
  return found;
}

/**
 * True when the module starts a process the moment it is imported.
 *
 * Detected, not named. A name rule such as `/\/run\.js$/` and `/-main\.js$/`
 * reads like the whole set and is ten of nineteen: `imap/main.ts` and
 * `relay/main.ts` carry no hyphen, and `cli.ts`, `report.ts`, `migrate.ts`
 * and `run-taxonomy-induction.ts` match neither shape. With such a rule,
 * `export * from '../relay/main.js'` in a barrel passes every check while the
 * outbox relay starts from the import.
 *
 * `runEntry` at the top level is what actually makes a module an entry
 * point, so that is what this looks for. A file renamed tomorrow is still
 * caught, and a new entry point needs no edit here.
 */
function startsAProcess(file: string): boolean {
  const tree = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.ES2022,
    true,
  );
  let found = false;
  const isRunEntryCall = (node: ts.Node): boolean =>
    ts.isCallExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === 'runEntry';
  // Only the top level, and only inside a plain statement or an `if` that
  // guards one. A `runEntry` reference nested in a function is a definition,
  // not an invocation at import.
  const scan = (statements: readonly ts.Statement[]): void => {
    for (const statement of statements) {
      if (ts.isExpressionStatement(statement)) {
        let expression: ts.Node = statement.expression;
        if (ts.isVoidExpression(expression)) expression = expression.expression;
        if (ts.isAwaitExpression(expression)) expression = expression.expression;
        if (isRunEntryCall(expression)) found = true;
      }
      if (ts.isIfStatement(statement) && ts.isBlock(statement.thenStatement)) {
        scan(statement.thenStatement.statements);
      }
    }
  };
  scan(tree.statements);
  return found;
}

/** Every non-test source file under `src/`. */
function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, found);
      continue;
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) found.push(full);
  }
  return found;
}

const ENTRY_POINTS = new Set(sourceFiles(SRC_DIR).filter(startsAProcess));

const BARRELS = readdirSync(PUBLIC_DIR).filter(
  (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
);

/** The file a barrel's relative specifier names, as an absolute path. */
function targetOf(specifier: string): string {
  return resolve(PUBLIC_DIR, specifier.replace(/\.js$/, '.ts'));
}

/** The exports map, read from the package manifest itself. */
const EXPORTS = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).exports as Record<
  string,
  string
>;

describe('the public surface', () => {
  it('has barrels to check, so an empty pass means something', () => {
    expect(BARRELS.length).toBeGreaterThanOrEqual(5);
    for (const required of ['ledger-read.ts', 'policy.ts', 'domain.ts', 'format.ts', 'cli.ts']) {
      expect(BARRELS).toContain(required);
    }
  });

  it('found the entry points, so the rule below means something', () => {
    // Without this the entry-point rule could pass because the detector
    // broke rather than because no barrel reaches one.
    expect(ENTRY_POINTS.size).toBeGreaterThanOrEqual(19);
    for (const file of [
      'src/relay/main.ts',
      'src/imap/main.ts',
      'src/coordinator/consumer-main.ts',
      'src/intake/webhook-main.ts',
      'src/bands/run.ts',
      'src/kb/cli.ts',
      'src/ledger/migrate.ts',
      'src/groundedness/report.ts',
    ]) {
      expect([...ENTRY_POINTS].map((p) => relative(REPO_ROOT, p).split(sep).join('/'))).toContain(
        file,
      );
    }
    // And a pure module is not one.
    expect(ENTRY_POINTS.has(join(SRC_DIR, 'bands/format.ts'))).toBe(false);
    expect(ENTRY_POINTS.has(join(SRC_DIR, 'policy/policy.ts'))).toBe(false);
  });

  it('never re-exports from a module that starts a process', () => {
    // The defect this case guards against. The console imported `bands/run.js`
    // and `latency/run.js` — modules that parse argv and set `process.exitCode`
    // — to format a rate and a duration. A barrel pointing at one would put
    // that back with a tidier name, and pointing at `relay/main.js` would hand
    // a consumer the outbox drainer.
    const offenders: string[] = [];
    for (const file of BARRELS) {
      for (const specifier of specifiersOf(readFileSync(join(PUBLIC_DIR, file), 'utf8'))) {
        if (!specifier.startsWith('.')) continue;
        const target = targetOf(specifier);
        if (ENTRY_POINTS.has(target)) {
          offenders.push(`${file} -> ${relative(REPO_ROOT, target).split(sep).join('/')}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('names a target that exists, so a typo cannot read as compliance', () => {
    const missing: string[] = [];
    for (const file of BARRELS) {
      for (const specifier of specifiersOf(readFileSync(join(PUBLIC_DIR, file), 'utf8'))) {
        if (!specifier.startsWith('.')) continue;
        if (!existsSync(targetOf(specifier))) missing.push(`${file} -> ${specifier}`);
      }
    }
    expect(missing).toEqual([]);
  });

  // DEC-46. The console's write guard reads `LEDGER_WRITES`, so a name here
  // that the barrel does not export would make that guard report on a write
  // that is not there. Read as source: importing the barrel opens connections
  // transitively, and this suite is pure.
  it('names its writes to something the barrel actually exports', () => {
    const source = readFileSync(join(PUBLIC_DIR, 'ledger-read.ts'), 'utf8');
    const tree = ts.createSourceFile('ledger-read.ts', source, ts.ScriptTarget.ES2022, true);

    /** The keys of the `LEDGER_WRITES` record literal. */
    const declared: string[] = [];
    for (const statement of tree.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.name.text !== 'LEDGER_WRITES') continue;
        const initializer = declaration.initializer;
        if (initializer === undefined || !ts.isObjectLiteralExpression(initializer)) continue;
        for (const property of initializer.properties) {
          if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) {
            declared.push(property.name.text);
          }
        }
      }
    }

    /** Every name the barrel exports, by either spelling. */
    const exported = new Set<string>();
    for (const statement of tree.statements) {
      if (ts.isExportDeclaration(statement) && statement.exportClause !== undefined
          && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) exported.add(element.name.text);
      }
      if (ts.isVariableStatement(statement)
          && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) exported.add(declaration.name.text);
        }
      }
    }

    // The floor: a scan that found no writes would pass the loop below.
    expect(declared.length).toBeGreaterThanOrEqual(4);
    const missing = declared.filter((name) => !exported.has(name));
    expect(missing).toEqual([]);
  });

  it('reaches only into the core, never out of it', () => {
    // A barrel is the core describing itself. One importing a third-party
    // package would make that package part of the core's public contract
    // without anybody deciding so.
    const offenders: string[] = [];
    for (const file of BARRELS) {
      for (const specifier of specifiersOf(readFileSync(join(PUBLIC_DIR, file), 'utf8'))) {
        if (!specifier.startsWith('.')) offenders.push(`${file} -> ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the exports map and the barrels agree', () => {
  // Neither half is checked by the other. A `"./dist/*": "./dist/*"` entry, or
  // a sixth barrel that `package.json` does not publish, passes a check of
  // either half alone. So the manifest and the directory are compared in both
  // directions: a wildcard is a failure, and an unreachable barrel is too.

  it('publishes no wildcard', () => {
    const wildcards = Object.keys(EXPORTS).filter((key) => key.includes('*'));
    expect(wildcards).toEqual([]);
  });

  it('publishes exactly the barrels, and every barrel is published', () => {
    const published = Object.keys(EXPORTS)
      .filter((key) => key !== '.')
      .map((key) => `${key.replace('./', '')}.ts`)
      .sort();
    expect(published).toEqual([...BARRELS].sort());
  });

  it('points every subpath at the built barrel of the same name', () => {
    for (const [subpath, target] of Object.entries(EXPORTS)) {
      if (subpath === '.') continue;
      expect(target).toBe(`./dist/public/${subpath.replace('./', '')}.js`);
    }
  });
});
