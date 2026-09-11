// The `*.test.ts` versus `*.db.test.ts` contract, enforced by the runner
// rather than by a paragraph in AGENTS.md.
//
// A `*.test.ts` file is pure: it runs in the `unit` project, which has no
// global setup and no Docker socket. A file that reaches for Postgres and
// keeps the pure suffix makes `pnpm run test:unit` useless on the very machine
// the split exists to serve. Two files had already drifted that way
// (`src/ledger/insert.test.ts` and `src/relay/daemon.test.ts`, both renamed
// with this guard).
//
// ## Why the TypeScript parser, and not a scan
//
// The first version of this guard matched regular expressions over the source
// with comments blanked by hand. Three holes followed from that, and all three
// are the silent direction — an impure file keeping the pure suffix:
//
//   - `import {\n  Pool,\n} from 'pg';` matched nothing, because the pattern
//     was anchored per line and could not cross a newline. This is ordinary
//     hand-wrapping, not a contrived evasion, and no formatter in the
//     devDependencies would have produced or repaired it.
//   - `const r = /\/\//;` and `const x = a /b/ c;` blanked the rest of the
//     line, because a scanner cannot tell a regular expression from a
//     division without parsing.
//   - `import type { Pool } from 'pg';` was flagged, which is the opposite
//     error: a type-only import is erased at compile time and opens nothing,
//     so a correct pure suite was told to become a database suite.
//
// `typescript` is already a direct devDependency, so the parser costs nothing
// to reach. It also removes the need for the self-exemption the scanning
// version required: the detector cases below hold offending sources as string
// data, and a parser sees a string literal rather than an import.
//
// ## Why the rules are direct and not transitive
//
// Importing `pg` opens no socket. 37 of the 68 pure suites already reach `pg`
// transitively, through `src/db/config.ts` and others, and every one of them
// passes with no database present. A transitive rule would therefore condemn
// more than half the pure suite for a dependency that costs nothing. The rules
// below stay one level deep for that reason, and the runtime backstop in
// `projects.ts` (`NO_DATABASE_URL`) covers what a static rule cannot see.
//
// ## Vacuity
//
// A guard that asserts an empty offender list passes when the scan finds
// nothing, so deleting every test would satisfy it.
// `src/ledger/clock-reachability.test.ts` and
// `src/coordinator/arrival-signal-reachability.test.ts` both carry a floor for
// that reason, and this carries theirs: the scan must find a known number of
// files, it must have looked at named ones, and the detector itself must still
// flag every shape that does offend.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { MAIL_SUITES, isDbSuite, isPureSuite, projectOf } from './projects.js';

// `new URL(...).pathname` is percent-encoded, so a checkout under a path with
// a space compares unequal to every scanned file. fileURLToPath decodes it.
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The pure suite is large; the floor notices the scan collapsing. */
const MIN_PURE_FILES = 60;

/** The db suite is large too, and the mirror rule needs its own floor. */
const MIN_DB_FILES = 25;

/** Files that must be scanned, so the walk cannot silently miss a directory. */
const REQUIRED_SCANNED = ['src/policy/policy.test.ts', 'src/smoke.test.ts'];

/**
 * Pure files that name the forbidden identifiers as data.
 *
 * Both are static-analysis suites that read other files' source, so they hold
 * `'dbUrl'`, `'pg'` and whole import statements as strings. If the guard ever
 * flags either, it has gone back to matching text instead of parsing.
 */
const KNOWN_PURE_MENTIONERS = [
  'src/coordinator/arrival-signal-reachability.test.ts',
  'src/ledger/clock-reachability.test.ts',
];

/**
 * Modules that open a connection for their caller.
 *
 * A suite that imports one of these needs a database without ever naming
 * `pg`, which is how a suite actually drifts. `db/config.js` hands out a URL
 * and a live pool, `ledger/insert.js` writes through one, and
 * `test-support/schema.js` applies the migrations.
 */
const LEDGER_MODULES = ['db/config', 'ledger/insert', 'test-support/schema'];

function ledgerModuleOf(specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const normalised = specifier.replace(/\.js$/, '');
  return LEDGER_MODULES.find(
    (mod) => normalised === mod || normalised.endsWith(`/${mod}`),
  );
}

function literalArgument(node: ts.CallExpression): string | undefined {
  const first = node.arguments[0];
  if (first === undefined) return undefined;
  if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) {
    return first.text;
  }
  return undefined;
}

/**
 * Why a source is not pure, empty when it is.
 *
 * Type-only imports are deliberately allowed: `import type { Pool } from 'pg'`
 * is erased before the file runs.
 */
export function impurityReasons(source: string): string[] {
  const tree = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.ES2022, true);
  const reasons = new Set<string>();

  const note = (specifier: string): void => {
    if (specifier === 'pg' || specifier.startsWith('pg/')) {
      reasons.add("imports 'pg'");
      return;
    }
    const ledger = ledgerModuleOf(specifier);
    if (ledger !== undefined) reasons.add(`imports '${ledger}', which opens a connection`);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      // A type-only import is erased, so it cannot open anything.
      // `phaseModifier` replaced the deprecated `isTypeOnly` in TypeScript
      // 5.9; it also carries `defer`, which does still execute the module.
      const phase = node.importClause?.phaseModifier;
      if (phase !== ts.SyntaxKind.TypeKeyword) note(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isInject = ts.isIdentifier(callee) && callee.text === 'inject';
      const argument = literalArgument(node);
      if (argument !== undefined) {
        if (isRequire || isDynamicImport) note(argument);
        if (isInject && argument === 'dbUrl') reasons.add("calls inject('dbUrl')");
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(tree);
  return [...reasons].sort();
}

/** Whether a source calls `inject('mail')`, which only the mail project provides. */
export function usesMailServer(source: string): boolean {
  const tree = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.ES2022, true);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'inject'
      && literalArgument(node) === 'mail'
    ) {
      found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

/** Every test file in the checkout, as repository-relative POSIX paths. */
function testFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (
      entry === 'node_modules'
      || entry === 'dist'
      || entry === 'console'
      || entry === '.git'
      || entry === 'worktrees'
    ) {
      continue;
    }
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      testFiles(full, found);
      continue;
    }
    if (entry.endsWith('.test.ts')) found.push(relative(REPO_ROOT, full).split(sep).join('/'));
  }
  return found;
}

const ALL = testFiles(REPO_ROOT);
const PURE = ALL.filter(isPureSuite);
const DB = ALL.filter(isDbSuite);
const read = (file: string): string => readFileSync(join(REPO_ROOT, file), 'utf8');

describe('the detector', () => {
  it('flags every shape that reaches a database', () => {
    // Without this the guard could pass because the detector broke rather
    // than because every file is pure. Each line is an evasion that a
    // previous version of this guard missed.
    expect(impurityReasons("import { Pool } from 'pg';")).toContain("imports 'pg'");
    expect(impurityReasons("import pg from 'pg';")).toContain("imports 'pg'");
    expect(impurityReasons("import {\n  Pool,\n} from 'pg';")).toContain("imports 'pg'");
    expect(impurityReasons("import 'pg';")).toContain("imports 'pg'");
    expect(impurityReasons("import Client from 'pg/lib/client.js';")).toContain("imports 'pg'");
    expect(impurityReasons("const { Pool } = require('pg');")).toContain("imports 'pg'");
    expect(impurityReasons("const { Pool } = await import('pg');")).toContain("imports 'pg'");
    expect(impurityReasons("process.env.DATABASE_URL = inject('dbUrl');")).toContain(
      "calls inject('dbUrl')",
    );
    expect(impurityReasons('inject(`dbUrl`);')).toContain("calls inject('dbUrl')");
  });

  it('flags a suite that reaches the ledger without naming pg', () => {
    // The realistic drift. A suite acquires a database through a helper, and
    // a rule that only knew the word `pg` would call it pure.
    expect(impurityReasons("import { tryConnect } from '../db/config.js';")).toEqual([
      "imports 'db/config', which opens a connection",
    ]);
    expect(impurityReasons("import { requireDbUrl } from '../../db/config.js';")).toEqual([
      "imports 'db/config', which opens a connection",
    ]);
    expect(impurityReasons("import { fencedInsert } from '../ledger/insert.js';")).toEqual([
      "imports 'ledger/insert', which opens a connection",
    ]);
    expect(impurityReasons("import { applyLedgerSchema } from '../test-support/schema.js';")).toEqual([
      "imports 'test-support/schema', which opens a connection",
    ]);
  });

  it('does not accuse a file that only names the hazard', () => {
    // Shapes that broke the scanning version: the name as data, the name in a
    // comment, a string containing `//`, a regular expression containing a
    // quote, and a quoted import statement.
    expect(impurityReasons("const URL_SOURCES = ['requireDbUrl', 'dbUrl'];")).toEqual([]);
    expect(impurityReasons("// never import { Pool } from 'pg'")).toEqual([]);
    expect(impurityReasons("/* inject('dbUrl') is forbidden */")).toEqual([]);
    expect(impurityReasons("const url = 'postgres://host/db';")).toEqual([]);
    expect(impurityReasons("const r = /['\"]/; const s = \"from 'pg'\";")).toEqual([]);
    expect(impurityReasons(`check("import { Pool } from 'pg';");`)).toEqual([]);
  });

  it('allows a type-only import, which is erased before the file runs', () => {
    expect(impurityReasons("import type { Pool } from 'pg';")).toEqual([]);
    expect(impurityReasons("import { type Pool } from 'pg';")).toContain("imports 'pg'");
  });

  it('reads the two static-analysis suites as pure, because they are', () => {
    for (const file of KNOWN_PURE_MENTIONERS) {
      expect({ file, reasons: impurityReasons(read(file)) }).toEqual({ file, reasons: [] });
    }
  });
});

describe('the pure-suffix contract is executable', () => {
  it('scanned both suites, so an empty offender list means something', () => {
    expect(PURE.length).toBeGreaterThanOrEqual(MIN_PURE_FILES);
    expect(DB.length).toBeGreaterThanOrEqual(MIN_DB_FILES);
    for (const required of REQUIRED_SCANNED) expect(PURE).toContain(required);
    for (const mentioner of KNOWN_PURE_MENTIONERS) expect(PURE).toContain(mentioner);
  });

  it('finds no *.test.ts that needs a database', () => {
    // A suite that needs Postgres belongs in the `db` project. Rename it to
    // `*.db.test.ts`; the runner does the rest.
    const offenders = PURE.map((file) => ({ file, reasons: impurityReasons(read(file)) }))
      .filter((row) => row.reasons.length > 0)
      .map((row) => `${row.file}: ${row.reasons.join(', ')}`);
    expect(offenders).toEqual([]);
  });

  it('finds no *.db.test.ts that needs no database', () => {
    // The other direction. A pure suite wearing the database suffix makes
    // Docker mandatory for it and for nothing, which is the cost the split
    // exists to remove.
    const misfiled = DB.filter((file) => impurityReasons(read(file)).length === 0);
    expect(misfiled).toEqual([]);
  });
});

describe('every test file belongs to exactly one project', () => {
  it('collects each file once, with none falling between the patterns', () => {
    // The `include` globs are scoped to `src/**`. A test file written
    // anywhere else is collected by no project at all, and nothing reports
    // it — the same silent-green failure the database probe removes.
    const stray = ALL.filter((file) => !file.startsWith('src/'));
    expect(stray).toEqual([]);
    const counts = ALL.map((file) => projectOf(file));
    expect(counts.length).toBe(ALL.length);
    expect(ALL.length).toBe(PURE.length + DB.length);
  });

  it('lists exactly the suites that ask for a mail server', () => {
    // A third mail suite that nobody adds to MAIL_SUITES lands in the `db`
    // project, where `provide('mail', ...)` never runs. `inject` returns
    // undefined for an unprovided key rather than throwing, so the suite
    // fails on a property read far from the cause.
    const asking = ALL.filter((file) => usesMailServer(read(file))).sort();
    expect(asking).toEqual([...MAIL_SUITES].sort());
  });
});
