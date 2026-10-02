// Pure cases for the run-journal reader (src/journal/query.ts).
//
// Three things are provable without a database and are proved here: the
// canonical step order matches the coordinator's own set, the module issues
// nothing that could change a ledger, and the threshold recovery applies the
// policy engine's precedence to a journalled set the database does not
// constrain.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  boundedReads, callOf, isDeclarationName, literalText, memberReaches, nodesOf, parseSource, withoutComments,
} from '../test-support/source-reader.js';
import { sqlTokens, type SqlToken } from '../test-support/sql-tokens.js';

import { makeThresholds } from '../policy/policy.js';
import { STEP_ORDER, agreementThresholdFromJournal, readGateThresholds } from './query.js';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;

/** The repository's own module settings, which decide what a specifier resolves to. */
const COMPILER_OPTIONS = ts.parseJsonConfigFileContent(
  ts.readConfigFile(join(REPO_ROOT, 'tsconfig.json'), ts.sys.readFile).config, ts.sys, REPO_ROOT,
).options;

/**
 * One module as the compiler reads it (issue #146).
 *
 * The guards below used to blank prose with patterns. A pattern has to guess
 * where a string ends, and a `//` inside a URL, or a quote inside a regular
 * expression, made it blank the rest of a line. The tree cannot be misled
 * that way: a comment is trivia, a string is a node, and an import path is a
 * specifier, so none of them reads as a call or a statement.
 */
function treeOf(relative: string): ts.SourceFile {
  return parseSource(join(REPO_ROOT, relative));
}

/**
 * Each top-level declaration of a module, exported or not: its name, its kind
 * and its text with comments removed, so prose about a gate is not a reading
 * of one. A private helper counts: an export that calls a blender blends.
 *
 * A top-level statement of a kind this does not read is returned in
 * `unread`, and the case below refuses it. `export default (a, g) => …` and
 * a destructured constant hold code as surely as a function does, and a
 * reader that skipped them read nothing of it.
 */
function declarationsOf(relative: string): {
  declarations: Array<{ name: string; kind: string; exported: boolean; text: string }>;
  unread: string[];
} {
  const source = treeOf(relative);
  const exported = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  const text = (node: ts.Node): string => withoutComments(node.getText(source), 'declaration.ts');
  const unread: string[] = [];
  const declarations = source.statements.flatMap((statement) => {
    const entries = declared(statement);
    if (entries === null) {
      unread.push(statement.getText(source).split('\n')[0]!);
      return [];
    }
    return entries.map((entry) => ({ ...entry, exported: exported(statement) }));
  });
  return { declarations, unread };
  function declared(statement: ts.Statement): Array<{ name: string; kind: string; text: string }> | null {
    // An import binds a name and holds no code. A re-export names one.
    if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) return [];
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      return [{ name: statement.name.text, kind: 'function', text: text(statement) }];
    }
    if (ts.isClassDeclaration(statement) && statement.name) {
      return [{ name: statement.name.text, kind: 'class', text: text(statement) }];
    }
    if (ts.isInterfaceDeclaration(statement)) return [{ name: statement.name.text, kind: 'interface', text: text(statement) }];
    if (ts.isTypeAliasDeclaration(statement)) return [{ name: statement.name.text, kind: 'type', text: text(statement) }];
    if (ts.isVariableStatement(statement)) {
      const declarations = statement.declarationList.declarations;
      if (!declarations.every((declaration) => ts.isIdentifier(declaration.name))) return null;
      // The statement's text, because a declaration alone, `A: T = x`, is no
      // statement the parser reads.
      return declarations.map((declaration) =>
        ({ name: (declaration.name as ts.Identifier).text, kind: 'const', text: text(statement) }));
    }
    return null;
  }
}

/** The two journal writers every step calls, as `steps/context.ts` defines them. */
const JOURNAL_WRITERS = ['journalStart', 'journalFinish'];

/**
 * Every call a step module makes to a journal writer, and every use that does
 * not call one.
 *
 * A writer is reached by name, through an alias its import makes, as a
 * member, `helpers.journalStart(…)`, or through a key. A use that hands a
 * writer on, `const start = journalStart`, writes a step id this scan never
 * reads, so it is returned for the case below to refuse. Only a writer
 * imported from `./context.js`, or declared there, counts: `context.ts` also
 * imports the ledger's own writers under other names, and they take no step
 * id.
 */
function journalWriterCalls(source: ts.SourceFile): { calls: ts.CallExpression[]; uses: string[] } {
  const local = new Set<string>();
  for (const node of nodesOf(source)) {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined && JOURNAL_WRITERS.includes(node.name.text)) {
      local.add(node.name.text);
    }
    if (ts.isImportSpecifier(node) && JOURNAL_WRITERS.includes((node.propertyName ?? node.name).text)
      && literalText(node.parent.parent.parent.moduleSpecifier) === './context.js') {
      local.add(node.name.text);
    }
  }
  const calls: ts.CallExpression[] = [];
  const uses: string[] = [];
  for (const node of nodesOf(source)) {
    if (!ts.isIdentifier(node) || !local.has(node.text) || isDeclarationName(node)) continue;
    if (ts.isImportSpecifier(node.parent) || ts.isPropertyAccessExpression(node.parent)) continue;
    const call = callOf(node);
    if (call === null) uses.push(node.getText(source));
    else calls.push(call);
  }
  for (const writer of JOURNAL_WRITERS) {
    for (const { node, call } of memberReaches(source, writer)) {
      if (ts.isBindingElement(node)) continue;
      if (call === null) uses.push(node.getText(source));
      else calls.push(call);
    }
  }
  return { calls, uses };
}

/**
 * The functions the reader statements call today, and the SQL keywords a
 * parenthesis may follow. Any other name before a parenthesis is refused.
 */
const READ_FUNCTIONS = new Set([
  // Functions.
  'array_position', 'coalesce', 'convert_to', 'count', 'encode', 'extract', 'jsonb_typeof', 'max',
  'percentile_disc', 'sha256', 'to_char', 'unnest',
  // Keywords.
  'all', 'and', 'as', 'exists', 'filter', 'from', 'group', 'in', 'lateral', 'not', 'or', 'ordinality', 'select',
  'where',
]);

/** The words of a statement that changes something. None of them reads. */
const WRITING_WORDS = new Set([
  'alter', 'analyze', 'begin', 'call', 'commit', 'copy', 'create', 'deallocate', 'delete', 'discard', 'do', 'drop',
  'execute', 'grant', 'insert', 'listen', 'lock', 'merge', 'notify', 'prepare', 'refresh', 'reset', 'revoke',
  'rollback', 'set', 'truncate', 'update', 'vacuum',
]);

/** The token after `tokens[i]`, or undefined. */
const after = (tokens: readonly SqlToken[], i: number): SqlToken | undefined => tokens[i + 1];
const isName = (token: SqlToken | undefined): boolean => token !== undefined && (token.kind === 'word' || token.kind === 'name');
const isPunct = (token: SqlToken | undefined, text: string): boolean => token?.kind === 'punct' && token.text === text;

/**
 * What is wrong with one reader statement, or nothing.
 *
 * The statement is read as SQL tokens, so a comment marker inside a string
 * is text and a quoted name is a name. Stripping comments with a pattern let
 * `SELECT '/*'; COMMIT; …; SELECT '*\/'` read as one statement, and
 * `"pg_terminate_backend"(…)` read as no function.
 *
 * Beginning with SELECT is not the same as reading. A statement can write
 * through a function — `SELECT setval(...)` advances a sequence and passes
 * every check that looks at the leading verb — and a semicolon lets a second
 * statement ride behind the first.
 *
 * A list of forbidden functions can never be complete:
 * `pg_terminate_backend` ends another session and runs in a read-only
 * transaction. So the list is of the functions these reads use, and any
 * other is refused until someone adds it here on purpose. A name after `AS`
 * is an alias, and its parenthesis lists columns: `unnest(…) AS ids(doc_id,
 * ord)`. `SELECT … INTO` creates a table, and `FOR UPDATE` takes a row lock.
 */
function statementFaults(text: string): string[] {
  let tokens: SqlToken[];
  try {
    tokens = sqlTokens(text);
  } catch (error) {
    return [(error as Error).message];
  }
  const faults: string[] = [];
  if (!(tokens[0]?.kind === 'word' && ['select', 'with'].includes(tokens[0].text))) faults.push('is not a SELECT');
  tokens.forEach((token, i) => {
    if (isName(token) && isPunct(after(tokens, i), '(')) {
      const alias = tokens[i - 1]?.kind === 'word' && tokens[i - 1]!.text === 'as';
      if (!alias && !READ_FUNCTIONS.has(token.text)) faults.push(`calls ${token.text}`);
    }
    if (token.kind === 'word' && token.text === 'into') faults.push('selects into a table');
    // A WITH may hold a statement that writes, `WITH x AS (DELETE … RETURNING
    // …) SELECT …`, so a verb that changes anything is refused wherever it
    // stands.
    if (token.kind === 'word' && WRITING_WORDS.has(token.text)) faults.push(`writes with ${token.text}`);
    if (token.kind === 'word' && token.text === 'for'
      && ['update', 'share', 'no', 'key'].includes(after(tokens, i)?.text ?? '')) faults.push('locks what it reads');
    if (isPunct(token, ';') && i !== tokens.length - 1) faults.push('chains a second statement');
  });
  return faults;
}

/** The words after which a name in a FROM clause is not an alias. */
const CLAUSE_WORDS = new Set([
  'where', 'join', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'natural', 'on', 'using', 'group',
  'order', 'limit', 'offset', 'union', 'with', 'lateral', 'window', 'having', 'for',
]);

/**
 * The customer text one journal statement reaches, or nothing.
 *
 * A name is a column wherever it appears, in any case and in quotes. A body
 * may be read only to digest it. A whole row carries every column, the ones
 * named here included, so `*`, `alias.*` and a table or alias used as a
 * value are refused. `count(*)` counts rows and reads none.
 */
function customerTextFaults(text: string): string[] {
  const tokens = sqlTokens(text);
  const faults: string[] = [];
  const columns = [
    'payload', 'ticket_id', 'ticket_text', 'sender', 'message_id', 'body_text', 'saved_reply_text',
    'approved_reply_text',
  ];
  const calls: string[] = [];
  // The names a FROM or a JOIN binds, and where each is bound.
  const bound = new Map<string, number[]>();
  tokens.forEach((token, i) => {
    if (isPunct(token, '(')) calls.push(isName(tokens[i - 1]) ? tokens[i - 1]!.text : '');
    if (isPunct(token, ')')) calls.pop();
    if (isName(token) && columns.includes(token.text)) faults.push(`reads ${token.text}`);
    if (isName(token) && token.text === 'body' && !calls.includes('sha256')) faults.push('returns a body rather than digesting it');
    if (isPunct(token, '*') && !(isPunct(tokens[i - 1], '(') && tokens[i - 2]?.text === 'count')) {
      faults.push('reads every column of a row');
    }
    if (token.kind === 'word' && (token.text === 'from' || token.text === 'join') && isName(after(tokens, i))
      && !isPunct(tokens[i + 2], '(')) {
      let j = i + 1;
      while (isPunct(tokens[j + 1], '.') && isName(tokens[j + 2])) j += 2;
      bound.set(tokens[j]!.text, [...(bound.get(tokens[j]!.text) ?? []), j]);
      let k = j + 1;
      if (tokens[k]?.kind === 'word' && tokens[k]!.text === 'as') k++;
      if (isName(tokens[k]) && !CLAUSE_WORDS.has(tokens[k]!.text)) {
        bound.set(tokens[k]!.text, [...(bound.get(tokens[k]!.text) ?? []), k]);
      }
    }
  });
  tokens.forEach((token, i) => {
    const binding = isName(token) ? bound.get(token.text) : undefined;
    if (binding === undefined || binding.includes(i)) return;
    if (isPunct(after(tokens, i), '.') || isPunct(tokens[i - 1], '.')) return;
    faults.push(`reads a whole row of ${token.text}`);
  });
  return faults;
}

/** Every reach of the fault key in `source` that is not a `has(…)` presence check. */
function faultReaches(source: ts.SourceFile): string[] {
  const presence = (node: ts.Node): boolean => ts.isCallExpression(node.parent) && ts.isIdentifier(node.parent.expression)
    && node.parent.expression.text === 'has' && node.parent.arguments[1] === node;
  const reaches: string[] = [];
  for (const node of nodesOf(source)) {
    if (literalText(node) === 'error') {
      if (presence(node)) continue;
      reaches.push(ts.isElementAccessExpression(node.parent) || ts.isCallExpression(node.parent)
        ? node.parent.getText(source)
        : node.getText(source));
    }
  }
  for (const { node } of memberReaches(source, 'error')) {
    if (ts.isElementAccessExpression(node)) continue;
    reaches.push(ts.isBindingElement(node) ? node.getText(source) : node.getText(source));
  }
  return reaches;
}

describe('the canonical step order', () => {
  // The coordinator is the only writer of step ids, so its source is the
  // authority on the set. Read rather than restated: a step added there and
  // missed here would sort last as unrecognised, which is safe, but the
  // console would show the pipeline in the wrong shape for every run.
  //
  // One module per step since issue #75, so the scan reads the directory.
  // The escalate row is written by the sequencer's own helper in
  // `steps/context.ts`, and that file is in the walk too.
  //
  // Every spelling of a writer's call is read, and a step id that is not one
  // literal is refused rather than dropped. A member call, a key or a step id
  // held in a variable each wrote a step this set never held.
  const scanned = readdirSync(join(REPO_ROOT, 'src/coordinator/steps'))
    .filter((name) => name.endsWith('.ts') && !name.includes('.test.'))
    .map((name) => ({ name, ...journalWriterCalls(treeOf(join('src/coordinator/steps', name))) }));
  const stepIds = scanned.flatMap(({ calls }) => calls.map((call) => call.arguments[1]));
  const written = new Set(stepIds.map((step) => (step === undefined ? null : literalText(step)))
    .filter((step): step is string => step !== null));

  it('reads every step id as one literal, and every writer as a call', () => {
    const unreadable = scanned.flatMap(({ name, calls }) => calls
      .filter((call) => call.arguments[1] === undefined || literalText(call.arguments[1]) === null)
      .map((call) => `${name}: ${call.getText()}`));
    expect(unreadable).toEqual([]);
    expect(scanned.flatMap(({ name, uses }) => uses.map((use) => `${name} hands on ${use}`))).toEqual([]);
  });

  it('reads a writer in every spelling', () => {
    const read = (text: string) => journalWriterCalls(parseSource('step.ts', text));
    const imported = "import { journalStart, journalFinish as finish } from './context.js';\n";
    expect(read(`${imported}await journalStart(ctx, 'a'); await finish(ctx, 'a', 'done', {});`).calls).toHaveLength(2);
    expect(read(`${imported}await helpers.journalStart(ctx, 'triage'); await h['journalFinish'](ctx, 'b');`)
      .calls.map((call) => literalText(call.arguments[1]!))).toEqual(['triage', 'b']);
    expect(read(`${imported}const start = journalStart; await start(ctx, 'hidden');`).uses).toEqual(['journalStart']);
    // The ledger's own writers take no step id, and they are not these.
    expect(read("import { journalStart as w } from '../../ledger/journal-write.js'; await w(pool, {});").calls)
      .toEqual([]);
  });

  it('found the writers, so the comparison below means something', () => {
    // Without this the set could match an empty STEP_ORDER because the scan
    // broke rather than because the two agree.
    expect(written.size).toBeGreaterThanOrEqual(7);
  });

  it('holds exactly the step ids the coordinator journals', () => {
    expect([...written].sort()).toEqual([...STEP_ORDER].sort());
  });

  it('is not the alphabetical order a bare ORDER BY would give', () => {
    // The point of the constant. If the two ever coincide, the module is
    // supplying nothing the database could not, and the doc comment claiming
    // otherwise has become false.
    expect(STEP_ORDER).not.toEqual([...STEP_ORDER].sort());
  });

  it('puts each step after the one that must precede it', () => {
    const at = (step: string): number => STEP_ORDER.indexOf(step);
    expect(at('classify')).toBeLessThan(at('retrieve'));
    expect(at('retrieve')).toBeLessThan(at('compose'));
    expect(at('compose')).toBeLessThan(at('gate'));
    // Park and execute are the two arms of the gate decision; escalate is
    // always where the run stopped.
    expect(at('gate')).toBeLessThan(at('park'));
    expect(at('gate')).toBeLessThan(at('execute'));
    expect(at('escalate')).toBe(STEP_ORDER.length - 1);
  });
});

// The console reads this module against whatever database it is pointed at,
// and the module's own header promises that cannot damage one. A statement
// added later would break that promise and nothing else here would notice.
describe('the read modules never write', () => {
  // Each module's header promises a console can point it at any database
  // without damaging one. A statement added later would break that promise
  // and nothing else here would notice.
  //
  // The set is every shipped module that reads through the shared
  // `boundedRead`, found in the tree, not a list of names. A module that took
  // the read later would otherwise be held to nothing but the database.
  //
  // A module reaches the shared read through any specifier the compiler
  // resolves to it: `../db/bounded-read.js`, `./bounded-read.js` from inside
  // `src/db`, a re-export and a dynamic import alike. The spelling of the path
  // decides nothing, and a re-export or a dynamic import is refused outright,
  // so a module cannot take the read without the set seeing it.
  const SHARED_READ = join(REPO_ROOT, 'src/db/bounded-read.ts');
  const shipped = (dir: string): string[] => readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return path.includes('test-support') ? [] : shipped(path);
      return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && path !== 'src/db/bounded-read.ts' ? [path] : [];
    });
  const reachesSharedRead = (path: string): Array<{ node: ts.Node; plain: boolean }> =>
    nodesOf(treeOf(path)).flatMap((node) => {
      const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
        : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0]
          : undefined;
      const text = specifier === undefined ? null : literalText(specifier);
      if (text === null || !text.startsWith('.')) return [];
      const target = ts.resolveModuleName(text, join(REPO_ROOT, path), COMPILER_OPTIONS, ts.sys).resolvedModule;
      return target?.resolvedFileName === SHARED_READ ? [{ node, plain: ts.isImportDeclaration(node) }] : [];
    });
  const READING = shipped('src').filter((path) => reachesSharedRead(path).length > 0).sort();

  it('takes the shared read only by a plain import, in every module', () => {
    const other = shipped('src').flatMap((path) => reachesSharedRead(path)
      .filter(({ plain }) => !plain).map(({ node }) => `${path}: ${node.getText().slice(0, 60)}`));
    expect(other).toEqual([]);
  });

  /**
   * The modules that read through `boundedRead` and that this scan cannot
   * read. Each hands the statement function to helpers, or builds a
   * statement at runtime from parts, so no literal holds what it sends. The
   * database holds them to one read-only statement at a time. Nothing here
   * refuses, for these modules, what READ ONLY lets through: a function that
   * acts on another session, and a superuser's write to the catalog or a
   * replication slot. A reader role without those rights would refuse them.
   */
  const BUILT_AT_RUNTIME = [
    'src/knowledge/gaps.ts',
    'src/knowledge/rerun.ts',
    'src/routing/query.ts',
    'src/team/query.ts',
  ];
  const readers = READING.filter((reader) => !BUILT_AT_RUNTIME.includes(reader));

  /** The statements each module sends today. */
  const STATEMENTS_SENT: Record<string, number> = {
    'src/conversation/query.ts': 4,
    'src/documents/query.ts': 1,
    'src/escalations/today.ts': 1,
    'src/journal/query.ts': 2,
    'src/latency/query.ts': 1,
  };

  /**
   * The values the readers may import, as `module:name`. A function imported
   * from elsewhere could send a statement on a pool of its own, which no rule
   * here would read. So a new import is added here on purpose.
   */
  const READER_IMPORTS = new Set([
    'src/adapters/types.ts:CUSTOMER_REPLY_ACTION_CLASS',
    'src/db/bounded-read.ts:boundedRead',
    'src/escalations/reason.ts:escalationHead',
    'src/ledger/insert.ts:OUTBOX_STATUSES',
    'src/ledger/insert.ts:TERMINAL_RUN_STATES',
    'src/policy/policy.ts:agreementThresholdFor',
  ]);

  it('holds every module that reads through boundedRead, or names why it cannot', () => {
    expect(READING).toEqual(expect.arrayContaining(BUILT_AT_RUNTIME));
    expect(readers).toEqual(Object.keys(STATEMENTS_SENT));
  });

  it.each(readers)('%s imports only the values the list allows', (reader) => {
    const { imports } = boundedReads(join(REPO_ROOT, reader));
    expect(imports.filter((name) => !READER_IMPORTS.has(name))).toEqual([]);
  });

  /**
   * The globals the readers use today. `eval`, `Function` and `process` are
   * not among them: each could load a module that no import names, and build
   * a pool from it. So a new global is added here on purpose.
   */
  const READER_GLOBALS = new Set(['Array', 'Date', 'Error', 'Map', 'Math', 'Number', 'Object', 'String', 'undefined']);

  it.each(readers)('%s reads only the globals the list allows', (reader) => {
    const { globals } = boundedReads(join(REPO_ROOT, reader));
    expect(globals.filter((name) => !READER_GLOBALS.has(name))).toEqual([]);
  });

  // Every statement these modules issue is a literal that starts with SELECT.
  //
  // A verb list was tried and defeated three ways, each of which compiled and
  // shipped: `SELECT setval('schema_version_seq', 1)` writes through a
  // function and names no forbidden verb; `DO $$ BEGIN EXECUTE 'trunc' ||
  // 'ate table run'; END $$` names neither `DO` nor `EXECUTE` in the list and
  // builds the verb at runtime; and `const verb = 'DEL' + 'ETE'` defeats any
  // list by never spelling the word. A scan over identifiers cannot close
  // that, because the thing being tested is what the database is asked to do
  // rather than which words appear.
  //
  // So this reads the call sites instead. Each `query(` in these modules must
  // take a literal or a module constant, and every such constant must begin
  // with SELECT. A dynamic string cannot be checked here and is refused
  // outright, which is the only honest answer a static scan can give it.
  //
  // The database holds the rule as well. Each module reads through
  // `boundedRead`, which runs its statements in one READ ONLY transaction, so
  // a write that passed this scan would still be refused. The second case
  // below holds each module to that path.
  it.each(readers)('%s asks the database only for SELECT statements', (reader) => {
    // Every statement the module sends, found from the read-only path, and
    // every way it could send one that is not read.
    const { statements, faults } = boundedReads(join(REPO_ROOT, reader));
    expect(faults, `${reader} can reach the database outside a read`).toEqual([]);
    // The count each module sends today. One found statement would pass a
    // floor of one while a second went unread.
    expect(statements.length, `${reader} sends a different number of statements`).toBe(STATEMENTS_SENT[reader]);

    // The whole first argument, as the compiler reads it: a literal, or the
    // literal a constant holds in the call's own scope. A local constant
    // shadows a module one, so the constant read is the one the call passes.
    //
    // A comma-terminated match read `SELECT t.conversation_id` out of a
    // multi-column literal and checked that fragment alone — so appending
    // `; SELECT setval(...)` to the end of such a statement passed every rule
    // below, including the two the guard names in its own comment.
    for (const { argument, statement: text } of statements) {
      expect(text, `${reader} builds a statement rather than naming one: ${argument}`).not.toBeNull();
      expect(statementFaults(text!), `${reader}: ${argument}`).toEqual([]);
    }
  });

  it('refuses each statement that is not a plain read', () => {
    expect(statementFaults('SELECT count(*) FROM run WHERE run_id = $1')).toEqual([]);
    expect(statementFaults('SELECT d FROM unnest($1::text[]) WITH ORDINALITY AS ids(doc_id, ord)')).toEqual([]);
    expect(statementFaults('DELETE FROM run')).toEqual(['is not a SELECT', 'writes with delete']);
    expect(statementFaults("SELECT setval('schema_version_seq', 1)")).toEqual(['calls setval']);
    expect(statementFaults('SELECT pg_terminate_backend(pid) FROM pg_stat_activity')).toEqual(['calls pg_terminate_backend']);
    expect(statementFaults('SELECT * INTO probe_copy FROM document')).toEqual(['selects into a table']);
    expect(statementFaults('SELECT * FROM run FOR UPDATE')).toEqual(['locks what it reads', 'writes with update']);
    expect(statementFaults('SELECT 1; DELETE FROM run')).toEqual(['chains a second statement', 'writes with delete']);
    expect(statementFaults('WITH gone AS (DELETE FROM run RETURNING run_id) SELECT run_id FROM gone'))
      .toEqual(['writes with delete']);
    expect(statementFaults('SELECT 1 /* ; */ FROM run -- ;\n')).toEqual([]);
    // The spellings a pattern could not read.
    expect(statementFaults("SELECT '/*'; COMMIT; CREATE TABLE t (x int); SELECT '*/'"))
      .toEqual(['chains a second statement', 'writes with commit', 'chains a second statement', 'writes with create',
        'calls t', 'chains a second statement']);
    expect(statementFaults('SELECT "pg_terminate_backend"(pid) FROM pg_stat_activity')).toEqual(['calls pg_terminate_backend']);
    expect(statementFaults('SELECT pg_terminate_backend -- a note\n(pid) FROM pg_stat_activity'))
      .toEqual(['calls pg_terminate_backend']);
    expect(statementFaults("SELECT $q$/*$q$, pg_advisory_lock(1), $q$*/$q$")).toEqual([expect.stringMatching(/does not read/)]);
    expect(statementFaults('SELECT 1 AS a --\r, pg_terminate_backend(1)')).toEqual([expect.stringMatching(/does not read/)]);
    expect(statementFaults("SELECT 'x")).toEqual([expect.stringMatching(/never ends/)]);
  });

  // The rule starts from the read-only path, so it reads a statement
  // whatever the callback names its function, and it holds the pool to the
  // one use that path needs.
  it('reads every statement a read sends, and refuses every other path', () => {
    // A sample sits where a reader sits, so its imports resolve as a
    // reader's do.
    const sample = join(REPO_ROOT, 'src/journal/reader-sample.ts');
    const read = (text: string) => boundedReads(sample, [
      "import type { Pool } from 'pg';",
      "import { boundedRead } from '../db/bounded-read.js';",
      text,
    ].join('\n'));
    const sent = (text: string) => read(text).statements.map((s) => s.statement);
    const faults = (text: string) => read(text).faults.map((fault) => fault.replace(/^line \d+: /, ''));

    expect(sent("export const r = (pool: Pool) => boundedRead(pool, 'r', 1, 2, (query) => query('SELECT 1'));"))
      .toEqual(['SELECT 1']);
    // The name the callback gives its function decides nothing.
    expect(sent("export const r = (pool: Pool) => boundedRead(pool, 'r', 1, 2, async (run) => { await run('SELECT 1'); return run('SELECT 2'); });"))
      .toEqual(['SELECT 1', 'SELECT 2']);
    expect(faults("export const r = (pool: Pool) => boundedRead(pool, 'r', 1, 2, (run) => helper(run));"))
      .toEqual(['the statement function is handed on rather than called']);
    expect(faults("export const r = (pool: Pool) => boundedRead(pool, 'r', 1, 2, (...a) => a[0]('DELETE FROM run'));"))
      .toEqual(['the read does not take its statement function as one plain parameter']);
    expect(faults("export async function r(pool: Pool) { return arguments[0]; }"))
      .toEqual(['arguments reaches a parameter by position']);
    // The pool may be handed to the read, and to nothing else.
    expect(faults("export async function r(pool: Pool) { const K = 'query'; await pool[K]('DELETE FROM run'); }"))
      .toEqual([expect.stringMatching(/^reaches a query method outside a read/), expect.stringMatching(/^the pool is used outside boundedRead/)]);
    expect(faults("export async function r(pool: Pool) { await pool['qu' + 'ery']('DELETE FROM run'); }"))
      .toEqual([expect.stringMatching(/^the pool is used outside boundedRead/)]);
    // The client a pool hands out is a pool's too, and so is its use.
    expect(faults('export async function r(pool: Pool) { const c = await pool.connect(); return c; }'))
      .toEqual([expect.stringMatching(/^the pool is used outside boundedRead: pool.connect/),
        expect.stringMatching(/^the pool is used outside boundedRead: return c/)]);
    expect(faults("export async function r(pool: Pool) { await pool.query('SELECT 1'); }").length).toBeGreaterThan(0);
    // Only the shared read counts.
    const local = boundedReads(sample, [
      "import type { Pool } from 'pg';",
      "import { passThrough as boundedRead } from '../db/pass-through.js';",
      "export const r = (pool: Pool) => boundedRead(pool, 'r', 1, 2, (query) => query('DELETE FROM run'));",
    ].join('\n'));
    expect(local.statements).toEqual([]);
    expect(local.faults.map((fault) => fault.replace(/^line \d+: /, ''))).toEqual([
      "an import resolves to no module: '../db/pass-through.js'",
      'boundedRead is not the shared one from src/db/bounded-read.ts',
      "reaches a query method outside a read: 'DELETE FROM run'",
      expect.stringMatching(/^the pool is used outside boundedRead/),
    ]);
    // Every value a module imports is returned for the list below to hold.
    expect(read("import { Pool as P } from 'pg';").imports).toEqual(['src/db/bounded-read.ts:boundedRead', 'pg:Pool']);
    // An import that binds nothing, and a re-export, still load the module.
    expect(read("import '../policy/policy.js';").imports).toContain('src/policy/policy.ts:');
    expect(read("import {} from '../policy/policy.js';").imports).toContain('src/policy/policy.ts:');
    expect(read("import { type GateThresholds } from '../policy/policy.js';").imports).toContain('src/policy/policy.ts:');
    expect(read("export * from '../policy/policy.js';").imports).toContain('src/policy/policy.ts:*');
    expect(read("export { makeThresholds } from '../policy/policy.js';").imports).toContain('src/policy/policy.ts:makeThresholds');
    // An import-equals require takes a module the list cannot hold.
    expect(faults("import p = require('../policy/policy.js');")).toEqual([expect.stringMatching(/^takes a module at runtime/)]);
    expect(faults("import type p = require('../policy/policy.js');")).toEqual([]);
    // An import or a re-export of types alone is erased, and records nothing.
    expect(read("import type { GateThresholds } from '../policy/policy.js'; export type { GateThresholds as G } from '../policy/policy.js';").imports)
      .toEqual(['src/db/bounded-read.ts:boundedRead']);
    expect(faults("export const m = async () => import('pg');")).toEqual([expect.stringMatching(/^takes a module at runtime/)]);
    // The pool is found by its type, however the code spells it.
    expect(faults("type Db = Pool; export async function r(db: Db) { await helper(db); }"))
      .toEqual([expect.stringMatching(/^the pool is used outside boundedRead/)]);
    expect(faults("type Db = Pool; export async function r(db: Db) { await (db as never as { end(): Promise<void> }).end(); }"))
      .toEqual([expect.stringMatching(/^the pool is used outside boundedRead/)]);
    expect(faults("export async function r(pool: Pool) { await (pool as never as Record<string, () => void>)['qu' + 'ery']!(); }"))
      .toEqual([expect.stringMatching(/^the pool is used outside boundedRead/)]);
    expect(faults("export async function r({ pool }: { pool: Pool }) { await helper(pool); }"))
      .toEqual([expect.stringMatching(/^the pool is used outside boundedRead/)]);
    expect(faults("declare function tryConnect(): Promise<Pool>; export async function r() { await helper(await tryConnect()); }"))
      .toEqual([expect.stringMatching(/^the pool is used outside boundedRead/)]);
    // A bare `query` that is not the read's own function. The sample imports
    // a module that does not exist, so that import is refused as well.
    expect(faults("import { query } from '../db/raw-query.js'; export const r = async () => query('DELETE FROM run');"))
      .toEqual([expect.stringMatching(/^an import resolves to no module/),
        expect.stringMatching(/^reaches a query method outside a read/)]);
    // A pool found by its members, whatever its type is called.
    for (const typed of ['Pool & { tag?: 1 }', "Pick<Pool, 'query'>"]) {
      expect(faults(`export async function r(pool: ${typed}) { await helper(pool); }`))
        .toEqual([expect.stringMatching(/^the pool is used outside boundedRead/)]);
    }
    expect(faults('export async function r<P extends Pool>(pool: P) { await helper(pool); }'))
      .toEqual([expect.stringMatching(/^the pool is used outside boundedRead/)]);
    // Each global that could load a module is returned for the list to refuse.
    expect(read("export const g = () => [eval('1'), new Function('return 1'), process.getBuiltinModule('node:module')];").globals)
      .toEqual(['Function', 'eval', 'process']);
    // A shorthand names the global it holds, as the bare name does.
    expect(read('export const o = { process, eval, Function };').globals).toEqual(['Function', 'eval', 'process']);
    // A shorthand's default is a value of its own, not the shorthand's name.
    for (const name of ['eval', 'process', 'Function']) {
      expect(read(`let y: unknown; export function f(x: any) { ({ y = ${name} } = x); return y; }`).globals).toEqual([name]);
    }
    expect(read('let a: unknown; let process: unknown; export function f(x: any) { ({ process = a } = x); }').globals)
      .toEqual([]);
    // A label and `import.meta` are no global.
    expect(read('export function l() { outer: for (;;) { break outer; } return import.meta.url; }').globals).toEqual([]);
  });

  // DEC-18. The journal holds a parked draft, an action payload and a fault
  // message that names two email addresses. None of them may be selected into
  // an operator surface. The scan covers the statements rather than the whole
  // file, because the reader tests for the presence of those keys by name and
  // that is the guard, not a leak.
  // The drafted reply is returned now, and DEC-40 is why: a console may
  // approve a parked draft, and an approver who cannot read the reply cannot
  // approve it. It comes out of the `step_journal.result` object this module
  // already selects, so no statement names it.
  //
  // Scoped to this module on purpose, and not over `readers`. The
  // conversation reader selects `turn.body_text` and returns it, which is its
  // whole job: issue #48 decided the console shows the customer's message and
  // the runbook states the posture that follows. A shared list would have to
  // carry an exemption for the one module the rule was never about, which
  // reads as a rule with a hole rather than two rules.
  //
  // What this cannot check: everything the module returns from a park or a
  // compose row travels inside the `step_journal.result` object, which the
  // statement selects wholesale. So a field added to a returned record — a
  // fault message, an action payload — is invisible here, and the case below
  // covers that instead. This one is about the columns a statement reaches.
  //
  // Postgres folds an unquoted name to lower case, so `SELECT PAYLOAD` reads
  // the column this refuses. Each check ignores case and quotes.
  //
  // `document.body` may be read, and only to digest it. The digest answers
  // whether a document changed since the run read it; the text itself would
  // put the corpus on the wire to answer that, and the console has its own
  // reader for a document a person opens.
  it('reaches no column of customer text directly', () => {
    const { statements } = boundedReads(join(REPO_ROOT, 'src/journal/query.ts'));
    expect(statements.length).toBe(STATEMENTS_SENT['src/journal/query.ts']);
    for (const { argument, statement } of statements) {
      expect(customerTextFaults(statement!), argument).toEqual([]);
    }
  });

  it('refuses customer text in every spelling a statement can name it', () => {
    expect(customerTextFaults('SELECT s.step_id, sha256(convert_to(d.body, $1)) FROM step_journal s JOIN document d ON true'))
      .toEqual([]);
    expect(customerTextFaults('SELECT count(*) FROM step_journal')).toEqual([]);
    expect(customerTextFaults('SELECT PAYLOAD, "Ticket_Text" FROM step_journal')).toEqual(['reads payload']);
    expect(customerTextFaults('select payload from step_journal')).toEqual(['reads payload']);
    expect(customerTextFaults('SELECT BODY FROM document')).toEqual(['returns a body rather than digesting it']);
    expect(customerTextFaults('SELECT saved.body_text FROM turn saved')).toEqual(['reads body_text']);
    expect(customerTextFaults('SELECT saved AS turn_row FROM turn saved')).toEqual(['reads a whole row of saved']);
    expect(customerTextFaults('SELECT s.* FROM step_journal s')).toEqual(['reads every column of a row']);
    expect(customerTextFaults("SELECT '/*', (SELECT o.payload FROM outbox o), '*/'")).toEqual(['reads payload']);
  });

  // The fault message the module withholds, checked where it actually travels.
  //
  // It rides inside `step_journal.result`, which the statement selects
  // wholesale — so the statement scan above cannot see it, and adding
  // `faultText: stringAt(result, 'error')` to the returned record passed it.
  // The park record reports that a fault was recorded, and carries no text of
  // it. The action payload is returned, on purpose: `payloadOf` reads it for
  // a parked internal write, which a reviewer approves.
  //
  // The key is checked across the whole module, not inside `toParkRecord`
  // alone. A helper that read it, `faultText: faultOf(result)`, passed a scan
  // of that one function. So every reach of the key the source states — a
  // literal, a constant holding one, `.error`, a destructure — must be the
  // key a `has(…)` call asks about. A key built at runtime,
  // `['err', 'or'].join('')`, states none, and no scan of the source reads it.
  it('returns the fault message as presence alone', () => {
    const source = treeOf('src/journal/query.ts');
    expect(faultReaches(source)).toEqual([]);
    // Not vacuous: the park record asks about the key.
    expect(nodesOf(source).filter((node) => literalText(node) === 'error').length).toBeGreaterThan(0);
  });

  it('refuses the fault key in every spelling the source states', () => {
    const reaches = (text: string) => faultReaches(parseSource('query.ts', text));
    expect(reaches("const f = has(result, 'error');")).toEqual([]);
    expect(reaches("const f = stringAt(result, 'error');")).toEqual(["stringAt(result, 'error')"]);
    expect(reaches("const f = faultOf(result); function faultOf(r) { return r['error']; }")).toEqual(["r['error']"]);
    expect(reaches('const f = String(result.error);')).toEqual(['result.error']);
    expect(reaches('const { error } = result;')).toEqual(['error']);
  });

  // DEC-05. The two gates are independent, and the absence of a combining
  // function is the rule. A helper taking both and returning one number would
  // compile, ship, and put a blended confidence on the console.
  it('exports nothing that reads both gates', () => {
    const functions = nodesOf(treeOf('src/journal/query.ts')).filter((node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name !== undefined
      && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
    expect(functions.length).toBeGreaterThan(2);
    for (const declaration of functions) {
      const params = declaration.parameters.map((parameter) => parameter.getText()).join(', ');
      const takesBoth = /agreement/i.test(params) && /groundedness/i.test(params);
      expect(takesBoth, `${declaration.name!.text} reads both gates`).toBe(false);
    }
  });

  // The case above reads parameters, and a blender does not need two of them.
  // `readRunJournal` returns both gates in one object, so a blender takes one
  // argument and mentions neither gate in its signature.
  //
  // Parsing declarations was tried twice and defeated twice. A regex over
  // `export function NAME(...): TYPE {` misses an arrow constant, and
  // `([^{]+)\{` captures nothing useful when the return type is itself an
  // object — so both of these compiled, shipped, and passed:
  //
  //   export const confidence = (j: RunJournal): number => …
  //   export function confidence(j: RunJournal): { score: number } { … }
  //
  // So this asks one question of every exported declaration, whatever its
  // shape: does its text read both gates. The compiler lists the
  // declarations, so an arrow constant and a function with an object return
  // type are each one declaration. Anything that reads both must be named
  // here, which makes adding one a deliberate act rather than a shape the
  // scan has not met yet.
  //
  // `readRunJournal` is the one legitimate reader: it returns the journal,
  // which is both gates side by side and no number combining them. That is
  // exactly what DEC-05 permits and what a blender is not.
  it('exports nothing that reads both gates, beyond the reader that returns them', () => {
    const permitted = new Set(['readRunJournal']);
    const { declarations, unread } = declarationsOf('src/journal/query.ts');
    expect(unread, 'a top-level statement this scan does not read').toEqual([]);
    expect(declarations.filter((d) => d.exported).length).toBeGreaterThan(3);

    const named: string[] = [];
    const readingBoth: string[] = [];
    for (const { name, kind, text: chunk } of declarations) {
      named.push(name);
      // A type is not a blender. `RunJournal` declares both gates because
      // that is the shape the reader returns, side by side and uncombined —
      // which is what DEC-05 permits. Only code can average them.
      if (kind === 'interface' || kind === 'type') continue;
      // Every spelling of coverage. The gate row carries a fraction called
      // `groundedness` and a verdict per claim beside it, so a blend can
      // reach coverage by counting supported claims and never write the word.
      const readsCoverage =
        /\bgroundedness\b|\bclaimVerdicts\b|\bsupported\b|\bcoverage\b/.test(chunk);
      const readsBoth = /\bagreement\b/.test(chunk) && readsCoverage;
      if (!readsBoth) continue;
      readingBoth.push(name);
      expect(permitted.has(name), `${name} reads both gates and is not permitted to`).toBe(true);
    }
    // The positive control: the one permitted reader does read both, so a
    // scan that read nothing would fail here rather than pass.
    expect(readingBoth).toContain('readRunJournal');

    // Not vacuous: the split found the module's exports, and the permitted
    // one is among them.
    expect(named).toContain('readRunJournal');
    expect(named).toContain('agreementThresholdFromJournal');
  });
});

describe('the agreement threshold a run was judged against', () => {
  const thresholds = makeThresholds({
    agreement: 0.7,
    groundednessBlock: 0.7,
    groundednessReview: 0.8,
    perIntent: { refund_request: 0.9 },
  });

  it('takes the fitted value when the intent has one (DEC-41)', () => {
    expect(agreementThresholdFromJournal('refund_request', thresholds)).toBe(0.9);
  });

  it('falls back to the global value for an intent with no entry', () => {
    expect(agreementThresholdFromJournal('password_reset', thresholds)).toBe(0.7);
  });

  it('normalises the intent id through the engine, not here', () => {
    // The classifier returns a normalised id and the map is keyed on one.
    // Passing the raw id through proves this module re-encodes no part of
    // that rule: the engine lower-cases and trims it.
    expect(agreementThresholdFromJournal('  Refund_Request ', thresholds)).toBe(0.9);
  });

  it('reports an absence when the run recorded no intent', () => {
    expect(agreementThresholdFromJournal(null, thresholds)).toBeNull();
  });

  it('reports an absence when the gate journalled no thresholds', () => {
    expect(agreementThresholdFromJournal('refund_request', null)).toBeNull();
  });
});

describe('the journalled threshold set', () => {
  const sound = { agreement: 0.7, groundednessBlock: 0.7, groundednessReview: 0.8 };

  it('is accepted when every fraction is one', () => {
    expect(readGateThresholds(sound)).toEqual(sound);
  });

  it('keeps the fitted map when the journal carried one', () => {
    const withMap = { ...sound, perIntent: { refund_request: 0.9 } };
    expect(readGateThresholds(withMap)?.perIntent).toEqual({ refund_request: 0.9 });
  });

  // The engine's fallback arm returns `thresholds.agreement` unchecked,
  // because every set it is handed was built by `makeThresholds`. This one
  // comes out of jsonb, which enforces no shape at all. Without the guard a
  // string or a missing key would reach the console as a number, and it would
  // display a threshold no run was ever compared against.
  it.each([
    ['a value that is not an object', 0.7],
    ['a null', null],
    ['an array', [0.7]],
    ['a set missing the agreement value', { groundednessBlock: 0.7, groundednessReview: 0.8 }],
    ['a threshold recorded as a string', { ...sound, agreement: '0.7' }],
    ['a threshold above one', { ...sound, agreement: 1.4 }],
    ['a threshold at zero', { ...sound, agreement: 0 }],
    ['a threshold that is not finite', { ...sound, groundednessReview: Number.NaN }],
  ])('refuses %s', (_case, raw) => {
    expect(readGateThresholds(raw)).toBeNull();
  });

  it('drops a fitted map that is not an object rather than the whole set', () => {
    // The set is still the pair the gate compared against, and DEC-41's map
    // is optional. Refusing the set over an unreadable map would report the
    // coverage thresholds as unrecorded when the journal holds them.
    const result = readGateThresholds({ ...sound, perIntent: 'unrecoverable' });
    expect(result).toEqual(sound);
  });
});
