// Who may write `step_journal`, and with what handle.
//
// Two rules that the review found nothing holding. Both are properties of
// the source rather than of a run, so both are parsed here rather than
// exercised: a behavioral case would need a second relay process for one
// and a deadlock for the other.
//
// Rule 1: one module writes the table. `journal-statement.test.ts` pins the
// column list, but only inside the builder — a new module open-coding its
// own INSERT passes that suite while writing a row the console and
// `src/escalations/query.ts` cannot explain.
//
// Rule 2: a writer inside an open transaction passes that transaction's
// client. `JournalDb` is `Pool | PoolClient`, so `pool` and `client` are
// both accepted and only one is right. Substituting `pool` for `client` in
// `relay.ts` kept every database suite green, and the escalate row then
// commits on its own connection: the relay's rollback would undo the run
// state and the outbox while leaving a journalled escalation standing, so
// an operator reads an escalation that never happened (section 4.2 rule 1).
//
// Parsed with the compiler, never matched. A regex over these call sites
// is defeated by a rename, and this repository has shipped regex guards
// that ordinary spellings walked through.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SRC = join(REPO_ROOT, 'src');

/** The one module allowed to name the table in a statement. */
const WRITER = 'src/ledger/journal-write.ts';

/**
 * Where each journal write happens, and what handle it was given.
 *
 * A test file may hand-write a journal row — `coordinator.db.test.ts`
 * inserts a `'parking'` marker to drive the DEC-11 crash path — so the scan
 * covers production modules only. `src/test-support/` is not one: the build
 * excludes it in `tsconfig.json`, beside the test files, and
 * `race-twin.ts` there hides a park row to build a twin.
 */
function productionFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && full !== join(SRC, 'test-support')) {
        found.push(...productionFiles(full));
      }
      continue;
    }
    if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) found.push(full);
  }
  return found;
}

const FILES = productionFiles(SRC);

function name(file: string): string {
  return relative(REPO_ROOT, file).split(sep).join('/');
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ESNext, true);
}

/** Every string literal in a file that is a statement against `step_journal`. */
function writesTheTable(source: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
        || ts.isTemplateExpression(node))
      && /\b(INSERT\s+INTO|UPDATE)\s+step_journal\b/i.test(node.getText())
    ) found = true;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * The local names a file binds to the ledger's journal functions.
 *
 * Resolved through the import, not by spelling. `steps/context.ts` wraps
 * them as `writeJournalStart` and `writeJournalFinish`, and the step modules
 * call same-named helpers of its own whose first argument is a run context
 * and not a database. A guard keyed on the word `journalStart` would read
 * those as call sites and compare the wrong argument.
 */
function ledgerJournalNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!statement.moduleSpecifier.text.endsWith('ledger/journal-write.js')) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) names.add(element.name.text);
  }
  return names;
}

/** The identifier each ledger journal call was handed as its database. */
function journalCallHandles(source: ts.SourceFile): string[] {
  const names = ledgerJournalNames(source);
  if (names.size === 0) return [];
  const handles: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && names.has(node.expression.text)) {
      const first = node.arguments[0];
      handles.push(first === undefined ? '(none)' : first.getText());
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return handles;
}

describe('the step_journal write path', () => {
  it('scanned the tree, so an empty offender list means something', () => {
    expect(FILES.length).toBeGreaterThan(100);
    expect(FILES.map(name)).toContain(WRITER);
    // The detector finds the writer it is meant to find.
    expect(writesTheTable(parse(join(REPO_ROOT, WRITER)))).toBe(true);
    // And does not fire on a module that only mentions the table in prose.
    const prose = ts.createSourceFile(
      'p.ts', '// INSERT INTO step_journal is owned elsewhere\nexport const a = 1;',
      ts.ScriptTarget.ESNext, true,
    );
    expect(writesTheTable(prose)).toBe(false);
    // A template literal is a statement too — that is the spelling every
    // writer in this repository actually uses.
    const template = ts.createSourceFile(
      't.ts', 'const q = `INSERT INTO step_journal (run_id) VALUES ($1)`;',
      ts.ScriptTarget.ESNext, true,
    );
    expect(writesTheTable(template)).toBe(true);
  });

  it('has exactly one module', () => {
    const writers = FILES.filter((file) => writesTheTable(parse(file))).map(name);
    expect(writers).toEqual([WRITER]);
  });

  it('hands a transaction its own client, never the pool', () => {
    // These writers journal inside a transaction they are already committing,
    // and must pass that transaction's client. The coordinator's steps hold no
    // transaction of their own and pass the pool, except where a step's
    // record rides the commit of the transition it explains.
    const expected: Record<string, string> = {
      // DEC-48: the reply a person wrote from scratch. It journals inside its
      // own transaction, under the run row lock, so it passes that client.
      'src/approval/rewrite.ts': 'client',
      'src/approval/undo.ts': 'client',
      'src/coordinator/consumer.ts': 'client',
      'src/outcomes/close.ts': 'client',
      // DEC-49: the case a reviewer sends back. It journals inside its own
      // transaction, under the run row lock, so it passes that client.
      'src/outcomes/send-back.ts': 'client',
      'src/outcomes/snooze.ts': 'client',
      'src/relay/relay.ts': 'client',
      'src/seed/write.ts': 'client',
      'src/coordinator/steps/context.ts': 'ctx.pool',
      // The park's record of a turn already answered. It journals in the commit
      // that ends the run superseded, so it passes that client.
      'src/coordinator/steps/park.ts': 'client',
    };
    const seen: Record<string, string[]> = {};
    for (const file of FILES) {
      if (name(file) === WRITER) continue;
      const handles = journalCallHandles(parse(file));
      if (handles.length > 0) seen[name(file)] = [...new Set(handles)].sort();
    }
    // Every caller is named above, so a new one has to be triaged here
    // rather than inheriting whichever handle its author reached for.
    expect(Object.keys(seen).sort()).toEqual(Object.keys(expected).sort());
    for (const [file, handles] of Object.entries(seen)) {
      expect(handles, `${file} passes the wrong database handle`).toEqual([expected[file]]);
    }
  });

  it('asks for ON CONFLICT at the relay and nowhere else', () => {
    // The relay journals one escalate row per run and a repeat must keep the
    // first reason rather than raise a duplicate key inside its open
    // transaction. Deleting the option left every suite green.
    const asking: string[] = [];
    for (const file of FILES) {
      const source = parse(file);
      const ledgerNames = ledgerJournalNames(source);
      if (ledgerNames.size === 0) continue;
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
          && ledgerNames.has(node.expression.text)
          && node.arguments.length > 2
          && /ifAbsent\s*:\s*true/.test(node.arguments[2]!.getText())) {
          asking.push(name(file));
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(asking).toEqual(['src/relay/relay.ts']);
  });
});
