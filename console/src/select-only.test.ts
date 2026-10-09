// Every write this console makes, proved structurally (DEC-46).
//
// `bands` and `latency` are safe against a live database because every
// statement they issue is a SELECT. The console cannot inherit that claim: it
// writes the ledger — the approval, and the case holds. So it must state the
// claim itself, and this is where it is held to the list it names.
//
// The rule is structural rather than a matter of care at the call site,
// following `src/ledger/clock-reachability.test.ts`. The console names no SQL
// at all: it reads through the query modules the jobs use, and every write goes
// through a function of `auracle/ledger-read` that the core declares in
// `LEDGER_WRITES`. Anything that looks like a statement in this package is a
// second definition of a ledger read, which is the drift the console's first
// design ruled out.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { LEDGER_WRITES } from 'auracle/ledger-read';

const PACKAGE_ROOT = new URL('../', import.meta.url).pathname;

/**
 * Every shipped file in the console package, tests excluded.
 *
 * Every file, not only `.ts`. A `.json`, a `.css` or an `.mjs` holding a
 * statement is exactly as much a second definition of a ledger read, and a
 * sweep that saw only TypeScript would have said the package was clean while
 * one sat beside it. `docs/operations.md` claims this refuses "any SQL
 * keyword in the package", and the sweep has to mean the package.
 */
function shippedModules(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) shippedModules(path, acc);
    else if (!/\.test\.ts$/.test(entry)) acc.push(path);
  }
  return acc;
}

/**
 * One file as the compiler reads it: TypeScript and JavaScript as code, and a
 * JSON file as JSON, which the tsconfig files here write with comments. Any
 * other file is not code, and it has no tree.
 *
 * A file the parser cannot read is refused. The parser recovers from a
 * syntax error and hands back a tree, but that tree is a guess, and a sweep
 * that reads a guess can pass on code it never saw. JSX is read only in a
 * `.tsx` or `.jsx` file.
 */
function tree(file: string, text: string): ts.SourceFile | null {
  if (/\.json$/.test(file)) {
    const error = ts.parseConfigFileTextToJson(file, text).error;
    if (error !== undefined) throw new Error(`${file} does not parse: ${ts.flattenDiagnosticMessageText(error.messageText, ' ')}`);
    return ts.parseJsonText(file, text);
  }
  if (!/\.[cm]?[jt]sx?$/.test(file)) return null;
  const kind = /\.tsx$/.test(file) ? ts.ScriptKind.TSX : /\.jsx$/.test(file) ? ts.ScriptKind.JSX
    : /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const errors = ts.transpileModule(text, { fileName: file, reportDiagnostics: true }).diagnostics ?? [];
  const first = errors[0];
  if (first !== undefined) {
    throw new Error(`${file} does not parse: ${ts.flattenDiagnosticMessageText(first.messageText, ' ')}`);
  }
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
}

/**
 * Removes comments and keeps everything else, string literals included.
 *
 * The comments are the ones the compiler finds, as trivia between tokens.
 * A pattern or a character loop has to guess where a string ends, and each
 * guess failed: a regular expression cut at the `//` inside
 * `'http://console.invalid'`, and a loop that knew no regular-expression
 * literal paired the quote inside `/"/` with a later one. Either way the rest
 * of the line was erased, and a statement written there went unread. String
 * contents are the one place the rule most needs to look, because SQL travels
 * as a string.
 *
 * The consequence is that HTML counts too. A `<select>` element in a surface
 * trips the SQL sweep below, and that is the sweep working rather than a
 * fault. Rename the offender or narrow the rule; do not stop reading strings.
 *
 * A file with no tree keeps its text whole: reading too much is the safe
 * direction for a guard. JSX text is text, so a line of it that starts with
 * `//` stays.
 *
 * The core's `src/test-support/source-reader.ts` holds the same reader. This
 * package reaches the core only through its published barrels, and test
 * support is not one of them, so the console keeps its own copy, which also
 * reads the JSON its tsconfig files are written in. From `const ranges`
 * onward the two are the same text, and a core case holds them to it.
 *
 * The file name decides whether JSX is read, so it is required.
 */
function stripComments(text: string, file: string): string {
  const source = tree(file, text);
  if (source === null) return text;
  const ranges = new Map<number, number>();
  const jsxText: Array<[number, number]> = [];
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.JsxText) jsxText.push([node.getStart(source), node.getEnd()]);
    for (const range of ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []) ranges.set(range.pos, range.end);
    for (const range of ts.getTrailingCommentRanges(text, node.getEnd()) ?? []) ranges.set(range.pos, range.end);
    for (const child of node.getChildren(source)) visit(child);
  };
  visit(source);
  for (const [pos] of ranges) {
    if (jsxText.some(([start, end]) => pos >= start && pos < end)) ranges.delete(pos);
  }
  let out = '';
  let at = 0;
  for (const [pos, end] of [...ranges].sort(([a], [b]) => a - b)) {
    if (pos < at) continue;
    out += text.slice(at, pos);
    at = end;
  }
  return out + text.slice(at);
}

/** A text that reaches a query method: `.query`, or a `['query']` key. */
const QUERY_IN_TEXT = /\.\s*query\b|\[\s*['"`]query['"`]\s*\]/g;

/**
 * Every place a file takes a module at runtime: `import(…)`, `require(…)`,
 * `createRequire`, code built at runtime and the module methods on
 * `process`.
 *
 * The barrel sweep below reads import declarations, and a dynamic import of
 * the barrel took a write outside the entry point with nothing to see it.
 * The console imports nothing at runtime, so any such import is refused.
 *
 * This catches a mistake written in ordinary code. Code written to evade a
 * source sweep can always find a spelling it does not list. The console
 * writes the ledger by design, so the barrier against that is the database
 * role the console connects as, not this sweep.
 */
function dynamicImports(text: string, file: string): string[] {
  const source = tree(file, text);
  if (source === null || /\.json$/.test(file)) return [];
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && ['require', 'createRequire'].includes(node.expression.text)))) {
      found.push(node.getText(source));
    }
    // A module also loads through code built at runtime, `eval` and
    // `Function`, and through the methods on `process` that hand out a
    // module or a native binding. The console uses none of them.
    if (ts.isIdentifier(node) && ['eval', 'Function'].includes(node.text)
      && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) {
      found.push(node.parent.getText(source));
    }
    if (ts.isPropertyAccessExpression(node) && ['getBuiltinModule', 'binding', 'dlopen'].includes(node.name.text)) {
      found.push(node.getText(source));
    }
    // `createRequire` makes a `require` under any name, so the module that
    // offers it is refused wherever it is imported.
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
      && ['module', 'node:module'].includes(node.moduleSpecifier.text)) {
      found.push(node.getText(source));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * Every place a file reaches a query method: `pool.query`, or
 * `pool['query']`, which reaches the ledger exactly as the dot does.
 *
 * In code, any use counts, not only a call: `pool.query.bind(pool)` hands the
 * method on, and a call through it is still a statement. So does a
 * destructure, `const { query: run } = pool`, and `Reflect.get(pool,
 * 'query')`. Read from the tree, so a mention in a comment is none, and one
 * after a string or a comment is still one.
 *
 * A string that holds code reaching the method counts as well. `new
 * Function('p', "return p.query(…)")` and a child process started with
 * `node -e` run the code a string holds, so the text of every literal is read
 * as the text of a `package.json` script is.
 *
 * A file with no tree, and the JSON beside the code, is read as text with its
 * comments removed. A `package.json` script holds code in a string, and a
 * `db:*` script that queried the pool is the second write path this rule
 * forbids.
 *
 * A key must come from somewhere. `pool[METHOD](…)` with `METHOD = 'query'`
 * holds the name in a literal, so the literal `'query'` counts wherever it
 * stands, and a key read from a variable that holds it counts too. A key
 * assembled at runtime from pieces, `'qu' + 'ery'`, spells no name, and no
 * reader of the source can say what it reaches. The console writes the
 * ledger by design, so no read-only transaction stands behind this rule, and
 * that one spelling is outside what it can see.
 */
function queryCalls(text: string, file: string): number[] {
  const source = tree(file, text);
  if (source === null || /\.json$/.test(file)) {
    const bare = stripComments(text, file);
    return [...bare.matchAll(QUERY_IN_TEXT)].map((match) => match.index);
  }
  const keyText = (node: ts.Node | undefined): string | null =>
    node !== undefined && (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      ? node.text
      : null;
  const found: number[] = [];
  const visit = (node: ts.Node): void => {
    const byName = ts.isPropertyAccessExpression(node) && node.name.text === 'query';
    const byKey = ts.isElementAccessExpression(node)
      && !ts.isIdentifier(node.argumentExpression) && keyText(node.argumentExpression) === 'query';
    const byBinding = ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)
      && keyText(node.propertyName ?? node.name) === 'query';
    const byReflect = ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'get' && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === 'Reflect' && node.arguments.length >= 2
      && !ts.isIdentifier(node.arguments[1]!) && keyText(node.arguments[1]) === 'query';
    // The literal is a key already counted when it keys an access, a
    // `Reflect.get` or a destructure; anywhere else it is a name held for one.
    const keys = (literal: ts.Node): boolean => {
      const parent = literal.parent;
      return (ts.isElementAccessExpression(parent) && parent.argumentExpression === literal)
        || (ts.isBindingElement(parent) && parent.propertyName === literal)
        || (ts.isCallExpression(parent) && parent.arguments[1] === literal && ts.isPropertyAccessExpression(parent.expression)
          && parent.expression.name.text === 'get');
    };
    const inText = (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      && ([...node.text.matchAll(QUERY_IN_TEXT)].length > 0 || (node.text === 'query' && !keys(node)));
    const inTemplate = ts.isTemplateExpression(node) && [...node.getText(source).matchAll(QUERY_IN_TEXT)].length > 0;
    if (byName || byKey || byBinding || byReflect || inText || inTemplate) found.push(node.getStart(source));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

// From the package root, not from `src`. The docstring above and
// `docs/operations.md` both say "the package", and a sweep of `src` alone
// walked past `console/package.json` — where a `db:*` script would be exactly
// the second write path this rule exists to forbid.
const MODULES = shippedModules(PACKAGE_ROOT);

/** The barrel the console reaches the ledger through, and the only one. */
const READ_BARREL = 'auracle/ledger-read';

/**
 * The one module that may take a ledger write from the barrel.
 *
 * The console has no SQL of its own, so a write is a core function it holds.
 * `main.ts` is the entry point: it takes each write and injects it, which is
 * what lets a server be driven in a test with no ledger behind it. A second
 * module importing one would be a second write path inside one console, and
 * that is what the sweep below refuses.
 */
const WRITE_IMPORTERS = ['src/main.ts'];

/**
 * The one module that may invoke the approval.
 *
 * `approveRun` reaches the console through `ConsoleDeps` rather than by
 * import — `src/approve.ts` validates the form and calls what it was handed —
 * and `main.ts` passes it on rather than calling it. Stated as a property
 * call, because that is the shape the call actually takes.
 */
const APPROVAL_CALLERS = ['src/approve.ts'];

/**
 * The writes the entry point calls itself, rather than passing on.
 *
 * `approveRun` and `closeRun` are the two it passes: each has a module of its
 * own — the approval bridge and the outcomes — and the holds are wired
 * straight into the surfaces that use them.
 */
const CALLED_BY_THE_ENTRY_POINT = ['handoverHold', 'readHold', 'releaseHold', 'takeHold'];

/** The writes the entry point hands to a helper instead of calling. */
const PASSED_ON_BY_THE_ENTRY_POINT = [
  'approveRun', 'closeRun', 'publishDocument', 'rewriteReply', 'sendBackRun', 'snoozeRun',
];

/**
 * Every symbol this console takes from the barrel, and whether it writes.
 *
 * The list is the claim. The sweep below fails on a symbol the console takes
 * and does not name here, so a new dependency — and above all a new write —
 * cannot arrive unnamed; and it fails when one of these is called from a
 * module other than the one above.
 */
const CALLED: Readonly<Record<string, 'read' | 'write'>> = {
  // DEC-49: the length a send-back note may have. A value and not a write or
  // a read, and named here because the sweep counts every symbol this console
  // takes from the barrel: the form's own `maxlength` and the ledger's bound
  // are one number, and a page that spelled its own would be the second.
  MAX_SEND_BACK_NOTE_CHARS: 'read',
  // DEC-50: the bounds of a document's title, answer and owner. The fields'
  // own `maxlength` and the ledger's bound are one number each. Values, and
  // no statement.
  MAX_DOCUMENT_BODY_CHARS: 'read',
  MAX_DOCUMENT_OWNER_CHARS: 'read',
  MAX_DOCUMENT_TITLE_CHARS: 'read',
  activeReviewer: 'read',
  approveRun: 'write',
  // DEC-48: the case a reviewer finishes with no reply. The console's fourth
  // write, and the only one that ends a case without sending anything.
  closeRun: 'write',
  // DEC-48: a case a reviewer puts aside for a period. It sends nothing and
  // records no approver: the run leaves the queue and comes back.
  snoozeRun: 'write',
  // DEC-48: the reply a reviewer writes from scratch. It replaces the draft
  // on the turn, and it is the one write that changes who authored the reply
  // the customer receives.
  rewriteReply: 'write',
  // DEC-49: the case a reviewer sends back. It writes the run it ends and the
  // note the next attempt reads; the attempt itself is the consumer's.
  sendBackRun: 'write',
  // DEC-50: a document a reviewer writes from a case. It writes the pending
  // document and the re-run request; the embedding and the attempt are the
  // consumer's.
  publishDocument: 'write',
  conversationOfRun: 'read',
  // DEC-44: whether a copy read back from the helpdesk holds text. A rule
  // read by the approval and by the page, and no statement either way.
  copyHoldsText: 'read',
  // DEC-50: the gap window the screen names. A number, and no statement.
  GAP_WINDOW_DAYS: 'read',
  // A listener on the pool for a connection that fails while a request holds
  // it, and the log line it writes. No statement.
  guardLedgerPool: 'read',
  logLedgerPoolError: 'read',
  handoverHold: 'write',
  LEDGER_STATES: 'read',
  listEscalations: 'read',
  listRuns: 'read',
  // DEC-48: how long a reason a close may record. The bound the form's field
  // is built with and the ledger enforces, from one definition. A number, and
  // no statement.
  MAX_CLOSE_REASON_CHARS: 'read',
  // DEC-48: how long a snooze may last. The bounds the form is built with and
  // the ledger enforces, from one definition. Two numbers, and no statement.
  MAX_SNOOZE_MS: 'read',
  MIN_SNOOZE_MS: 'read',
  // DEC-51: whether an approval's send is still held, and for how long. A
  // read of the record the approval wrote, and no statement.
  readApprovalHold: 'read',
  // DEC-30: the class of egress fault a retry cannot clear, read to tell the
  // two read-back faults apart. A class, and no statement.
  PermanentEgressError: 'read',
  probeLedger: 'read',
  // At startup, one bounded read on the readers' pool and one SELECT on
  // the writer's, which refuse a pool that is not the readers' role or not this ledger.
  assertOneLedger: 'read',
  // DEC-47: the product catalogue, read once at startup for the labels the
  // queue draws. A file read, and no statement.
  productCatalogueFromEnv: 'read',
  // DEC-50: the case's gap, read in one READ ONLY transaction.
  readCaseGap: 'read',
  // DEC-50: the documents published from a case, read in one READ ONLY
  // transaction.
  readCaseReruns: 'read',
  readConversation: 'read',
  readDays: 'read',
  readDocument: 'read',
  readHold: 'write',
  readHolds: 'read',
  // DEC-50: the knowledge screen, read in one READ ONLY transaction.
  readKnowledge: 'read',
  readLatency: 'read',
  readQueueToday: 'read',
  // What each product may do without a person, from the gate records, read in
  // one READ ONLY transaction.
  readRouting: 'read',
  readRun: 'read',
  readRunJournal: 'read',
  // The team screen, read in one READ ONLY transaction. The hold history it
  // totals is read, never written: a lapse it meets stays unrecorded.
  readTeam: 'read',
  releaseHold: 'write',
  replyDigest: 'read',
  requireDbUrl: 'read',
  requireReaderDbUrl: 'read',
  // DEC-47: the products the reviewer covers, for the queue's own order. A
  // read of the roster: the console can order by a preference, and cannot
  // set one.
  reviewerProducts: 'read',
  // DEC-44: the reply a reviewer saves, written onto the turn it answers.
  // The console's second write, and the second one that is not a hold.
  saveReply: 'write',
  selectReadBackAdapter: 'read',
  takeHold: 'write',
  // The length of the team screen's week, so a product's cases a day are over
  // the days the read counted. A value, and no statement.
  TEAM_WEEK_DAYS: 'read',
  // DEC-51: the way back inside a held send. It removes the record, the
  // approver, the distance, the approved text and the finish time.
  undoApproval: 'write',
  turnAnsweredBy: 'read',
  // DEC-50: the verdict for one claim, the rule the gap count shares. A
  // function over a list, and no statement.
  verdictAt: 'read',
};

/** One shipped module, as the parser sees it. */
interface Parsed {
  readonly file: string;
  /** Names taken from the barrel by a value import, and used. */
  readonly referenced: ReadonlySet<string>;
  /** Of those, the ones this module calls directly. */
  readonly called: ReadonlySet<string>;
  /** Any barrel call made through another object: `deps.approveRun(…)`. */
  readonly calledThrough: ReadonlySet<string>;
}

/**
 * What one module takes from the barrel, and how it uses it.
 *
 * Parsed rather than matched. An import this sweep cannot see is a write it
 * cannot report, and the spellings that defeat a scan are ordinary: a
 * multi-line import, a rename, a type-only import that is not a call at all.
 */
function parse(file: string): Parsed {
  const tree = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
  const imported = new Set<string>();
  // `import * as ledger from …` reaches every export of the barrel through
  // one alias, so the names it uses are only visible at the call: `ledger
  // .takeHold(…)`. A sweep that read named imports alone left that spelling
  // as a second write path the guard could not see.
  const namespaces = new Set<string>();
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== READ_BARREL) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
      continue;
    }
    if (!ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) imported.add(element.name.text);
  }
  const referenced = new Set<string>();
  const called = new Set<string>();
  const calledThrough = new Set<string>();
  const visit = (node: ts.Node): void => {
    // The import statement itself is not a use: its specifiers are the names
    // as written, and counting them would make every type-only import look
    // like a value the console holds.
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    // A type is not a call, and a type-only import is erased before the
    // console runs. Skipping the whole type subtree is what tells the two
    // apart: `hold: Hold | null` is a type, while `readHold(runId)` is a call
    // whatever it is bound to.
    if (ts.isTypeNode(node)) return;
    if (ts.isIdentifier(node) && imported.has(node.text)) referenced.add(node.text);
    // A member of a namespace import is a name this module takes from the
    // barrel, whatever it is called.
    if (
      ts.isPropertyAccessExpression(node)
      && ts.isIdentifier(node.expression)
      && namespaces.has(node.expression.text)
    ) {
      referenced.add(node.name.text);
      const parent = node.parent;
      if (ts.isCallExpression(parent) && parent.expression === node) called.add(node.name.text);
    }
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && imported.has(node.expression.text)
    ) {
      called.add(node.expression.text);
    }
    // The injected shape: `deps.approveRun(…)`, or a call through any other
    // object. The name is not an identifier here, so it needs its own rule.
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && Object.hasOwn(CALLED, node.expression.name.text)
    ) {
      calledThrough.add(node.expression.name.text);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(tree, visit);
  return { file, referenced, called, calledThrough };
}

const PARSED = MODULES.map((file) => parse(file));
const rel = (file: string): string => relative(PACKAGE_ROOT, file).split('\\').join('/');

/**
 * The statement-shaped words in one piece of source, or none.
 *
 * A keyword alone is not a statement. This package renders prose and markup:
 * a control that says "Delete the sentence" is a button, and an HTML
 * `<select>` is an element, and a sweep that refused the bare word refused
 * both. So each pattern names what the keyword governs — the token that makes
 * it a clause — and the sweep reports the keyword when its clause is there.
 *
 * What that costs: a statement written in lowercase with no clause this table
 * knows (`select 1`) is no longer seen here. The guarantee does not rest on
 * this function alone. `.query(` is refused by its own case below, and a
 * statement reaches a ledger through that call or not at all, so the teeth
 * are in the pair and not in this one pattern set.
 */
const STATEMENTS: readonly (readonly [string, RegExp])[] = [
  // A probe, or the head of a query. Never an English word: `Select` in a
  // sentence is followed by a letter.
  ['SELECT', /\bSELECT\s+[\d*"'`(]/i],
  ['SELECT', /\bSELECT\b[\s\S]{0,400}?\bFROM\b/i],
  ['INSERT', /\bINSERT\s+INTO\b/i],
  ['UPDATE', /\bUPDATE\b[\s\S]{0,200}?\bSET\b/i],
  ['DELETE', /\bDELETE\s+FROM\b/i],
  ['DROP', /\bDROP\s+(TABLE|INDEX|VIEW|COLUMN|CONSTRAINT|SCHEMA|DATABASE|TRIGGER|FUNCTION)\b/i],
  ['ALTER', /\bALTER\s+(TABLE|INDEX|VIEW|SCHEMA|DATABASE)\b/i],
  ['CREATE', /\bCREATE\s+(TABLE|INDEX|VIEW|SCHEMA|DATABASE|EXTENSION|UNIQUE)\b/i],
  ['TRUNCATE', /\bTRUNCATE\s+(TABLE\s+)?\w/i],
  ['MERGE', /\bMERGE\s+INTO\b/i],
  ['COMMIT', /\b(COMMIT|ROLLBACK)\s*[;'"]/i],
];

export function statementKeywords(source: string): string[] {
  const found = new Set<string>();
  for (const [keyword, pattern] of STATEMENTS) {
    if (pattern.test(source)) found.add(keyword);
  }
  return [...found];
}

describe('the console against a live database', () => {
  it('has modules to check, so the rules below are not vacuous', () => {
    expect(MODULES.length).toBeGreaterThan(2);
  });

  // The sweep reads what it strips, so the stripper is held to it. A cut at
  // the `//` of a URL erases the rest of that line, and a statement sitting
  // there goes unread.
  it('keeps a statement written after a URL on the same line', () => {
    const line = `const u = 'http://console.invalid'; const q = 'SELECT 1';`;
    expect(stripComments(line, 'm.ts')).toContain('SELECT 1');
  });

  // A quote inside a regular expression shifted the pairing of quotes, so the
  // `//` of a later URL read as a comment and blanked the rest of the line.
  it('keeps a statement written after a regular expression holding a quote', () => {
    const line = `const r = /"/; const u = "http://console.invalid"; const q = 'SELECT 1';`;
    expect(stripComments(line, 'm.ts')).toContain('SELECT 1');
  });

  it('still removes a comment, of either kind', () => {
    expect(stripComments('const a = 1; // SELECT 1\n', 'm.ts')).not.toContain('SELECT');
    expect(stripComments('const a = /* SELECT 1 */ 1;', 'm.ts')).not.toContain('SELECT');
    // A comment in a tsconfig file, which is JSON with comments.
    expect(stripComments('{ /* SELECT 1 */ "a": 1 // SELECT 1\n}', 'tsconfig.json')).not.toContain('SELECT');
    expect(stripComments('{ "a": "SELECT 1" }', 'tsconfig.json')).toContain('SELECT 1');
  });

  it('keeps a statement written after a string that holds an apostrophe', () => {
    expect(stripComments(`const a = "it's"; const u = 'http://console.invalid'; const q = 'SELECT 1';`, 'm.ts'))
      .toContain('SELECT 1');
  });

  // Every statement-shaped keyword, not only the writing ones. A SELECT here
  // would be a second definition of a ledger read.
  it('names no SQL statement of its own, of any kind', () => {
    const offenders: string[] = [];
    for (const file of MODULES) {
      const source = stripComments(readFileSync(file, 'utf8'), file);
      for (const keyword of statementKeywords(source)) {
        offenders.push(`${relative(PACKAGE_ROOT, file)} names ${keyword}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // The sweep reads code, and this package also renders prose. The narrowing
  // above is only honest if it still sees a statement and still passes a
  // sentence, so both are held here.
  it('reads a statement as a statement, and a sentence as a sentence', () => {
    expect(statementKeywords("await pool.query('DELETE FROM run')")).toEqual(['DELETE']);
    expect(statementKeywords("const q = 'select * from run';")).toEqual(['SELECT']);
    expect(statementKeywords("const q = `INSERT INTO run (a) VALUES (1)`;")).toEqual(['INSERT']);
    expect(statementKeywords("'UPDATE run SET state = $1'")).toEqual(['UPDATE']);
    expect(statementKeywords("'CREATE TABLE turn_reply (id int)'")).toEqual(['CREATE']);
    expect(statementKeywords("'DROP TABLE run'")).toEqual(['DROP']);
    expect(statementKeywords("'COMMIT;'")).toEqual(['COMMIT']);
    expect(statementKeywords("'SELECT 1'")).toEqual(['SELECT']);
    // The copy this package renders. None of these is a clause.
    expect(statementKeywords('Delete the sentence')).toEqual([]);
    expect(statementKeywords('Update the reply before you send it.')).toEqual([]);
    expect(statementKeywords('<select name="product">')).toEqual([]);
    expect(statementKeywords('Create a document from this case.')).toEqual([]);
  });

  // `pool.query` is how a statement reaches the ledger. The console never
  // calls it: reads go through the query modules and the one write goes
  // through `approveRun`.
  it('never calls pool.query, so it cannot issue a statement at all', () => {
    const offenders: string[] = [];
    for (const file of MODULES) {
      for (const at of queryCalls(readFileSync(file, 'utf8'), file)) {
        offenders.push(`${relative(PACKAGE_ROOT, file)} reaches query at ${at}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // Both spellings reach the ledger, and neither hides behind a string or a
  // comment, before it or around it.
  it('reads a query method handed on, and one a package script reaches', () => {
    expect(queryCalls("const run = pool['query'].bind(pool);", 'm.ts')).toHaveLength(1);
    expect(queryCalls('const run = pool.query.bind(pool);', 'm.ts')).toHaveLength(1);
    expect(queryCalls("const { query: run } = pool; await run('upd' + 'ate run set x = 1');", 'm.ts')).toHaveLength(1);
    expect(queryCalls("const { 'query': run } = pool;", 'm.ts')).toHaveLength(1);
    expect(queryCalls("const run = Reflect.get(pool, 'query');", 'm.ts')).toHaveLength(1);
    // Code held in a string runs as surely as code in the tree.
    expect(queryCalls(`const f = new Function('p', "return p.query('DEL' + 'ETE FROM run')");`, 'm.ts')).toHaveLength(1);
    expect(queryCalls(`export const c = ['node', '-e', "import('x').then((m) => m.pool.query(q))"];`, 'm.ts'))
      .toHaveLength(1);
    expect(queryCalls('{ "scripts": { "db:x": "node -e \\"m.pool.query(q)\\"" } }', 'package.json')).toHaveLength(1);
    expect(queryCalls('{ /* pool.query(q) */ "a": 1 }', 'tsconfig.json')).toHaveLength(0);
  });

  it('reads a query call in every spelling, and none in a comment', () => {
    expect(queryCalls("await pool.query('SELECT 1');", 'm.ts')).toHaveLength(1);
    expect(queryCalls("await pool['query']('SELECT 1');", 'm.ts')).toHaveLength(1);
    expect(queryCalls('const r = /"/; const u = "http://console.invalid"; await pool.query(q);', 'm.ts')).toHaveLength(1);
    expect(queryCalls(`const a = "it's"; await pool.query(q); const b = 'x';`, 'm.ts')).toHaveLength(1);
    expect(queryCalls('// pool.query(q)\n/* pool.query(q) */ const query = 1;', 'm.ts')).toHaveLength(0);
  });

  it('reads a key held in a constant, and takes no module at runtime', () => {
    expect(queryCalls("const METHOD = 'query'; await pool[METHOD]('upd' + 'ate run set x = 1');", 'm.ts').length)
      .toBeGreaterThan(0);
    expect(queryCalls('const METHOD = `query`; const run = Reflect.get(pool, METHOD);', 'm.ts').length).toBeGreaterThan(0);
    expect(dynamicImports("const ledger = await import('auracle/ledger-read');", 'm.ts')).toHaveLength(1);
    expect(dynamicImports("const m = require('auracle/ledger-read');", 'm.ts')).toHaveLength(1);
    expect(dynamicImports("import { createRequire } from 'node:module'; const load = createRequire(import.meta.url); load('auracle/ledger-read');", 'm.ts'))
      .toHaveLength(2);
    expect(dynamicImports("const load = process.getBuiltinModule('node:module').createRequire(import.meta.url);", 'm.ts'))
      .toHaveLength(1);
    expect(dynamicImports("const m = (0, eval)(\"import('auracle/ledger-read')\");", 'm.ts')).toHaveLength(1);
    expect(dynamicImports("const m = new Function(\"return import('auracle/ledger-read')\");", 'm.ts')).toHaveLength(1);
  });

  it('takes no module at runtime, so no write escapes the barrel sweep', () => {
    const offenders = MODULES.flatMap((file) => dynamicImports(readFileSync(file, 'utf8'), file)
      .map((text) => `${relative(PACKAGE_ROOT, file)}: ${text}`));
    expect(offenders).toEqual([]);
  });

  it('refuses a file the parser cannot read', () => {
    expect(() => queryCalls("const q = 'SELECT 1;\nf(a);", 'm.ts')).toThrow(/m\.ts does not parse/);
    expect(() => queryCalls('{ "a": ', 'tsconfig.json')).toThrow(/tsconfig\.json does not parse/);
  });

  // DEC-46. Every write is named above, and the sweep is what makes the naming
  // a check rather than a habit: a symbol this console takes from the barrel
  // and does not name fails here, so a new write cannot reach the ledger
  // unnamed.
  it('names every symbol it takes from the read barrel', () => {
    const unnamed = PARSED.flatMap(({ file, referenced }) =>
      [...referenced].filter((name) => !Object.hasOwn(CALLED, name)).map((name) => `${rel(file)} takes ${name}`),
    );
    expect(unnamed).toEqual([]);
    // The floor: a sweep that parsed nothing would pass the line above.
    const named = new Set(PARSED.flatMap((module) => [...module.referenced]));
    expect(named.size).toBeGreaterThanOrEqual(15);
  });

  // Every write the core declares is a write here too. A guard that called
  // one of them a read would pass its own completeness rule while reporting
  // that a console which writes the ledger does not.
  it('calls every write the barrel declares a write', () => {
    const missed = Object.keys(LEDGER_WRITES)
      .filter((name) => CALLED[name] !== 'write')
      .map((name) => `${name} is declared a write by ${READ_BARREL}, and not named one here`);
    expect(missed).toEqual([]);
    // And nothing named a write is a read at the barrel, so the two statements
    // are one statement.
    const mismatched = Object.keys(CALLED)
      .filter((name) => CALLED[name] === 'write')
      .filter((name) => !Object.hasOwn(LEDGER_WRITES, name));
    expect(mismatched).toEqual([]);
  });

  // Every write is taken from the barrel in one module, and it is the entry
  // point. A second importer would hold the ledger in a second place.
  it('takes no ledger write from the barrel outside the entry point', () => {
    const writes = Object.keys(CALLED).filter((name) => CALLED[name] === 'write');
    const offenders = PARSED.flatMap((module) =>
      writes
        .filter((name) => module.referenced.has(name))
        .filter(() => !WRITE_IMPORTERS.includes(rel(module.file)))
        .map((name) => `${rel(module.file)} takes ${name}`),
    );
    expect(offenders).toEqual([]);
    // And the entry point does take them, so the rule above cannot pass
    // because the guard stopped seeing imports.
    const main = PARSED.find((module) => rel(module.file) === 'src/main.ts')!;
    expect(writes.filter((write) => main.referenced.has(write)).sort())
      .toEqual([...writes].sort());
    // The floor, again: an empty write list would pass every line above.
    expect(writes.length).toBeGreaterThanOrEqual(4);
  });

  it('calls the writes the entry point takes, except the one it passes on', () => {
    const main = PARSED.find((module) => rel(module.file) === 'src/main.ts')!;
    expect(CALLED_BY_THE_ENTRY_POINT.filter((name) => main.called.has(name)).sort())
      .toEqual([...CALLED_BY_THE_ENTRY_POINT].sort());
    // Naming a write is not calling it, and the difference is the whole
    // design: `main.ts` imports `approveRun` to hand it to
    // `approveFromConsole`, and `closeRun` to hand it to `closeFor`, which is
    // what lets a test drive each delegation without a ledger. So the
    // injector is asserted to be an injector.
    for (const name of PASSED_ON_BY_THE_ENTRY_POINT) {
      expect(main.referenced.has(name), name).toBe(true);
      expect(main.called.has(name), name).toBe(false);
    }
  });

  // And the approval is invoked in one module: `approve.ts` calls what it was
  // handed. Two callers would be two approval paths inside one console.
  it('invokes the approval from exactly one module', () => {
    const callers = PARSED
      .filter((module) => module.calledThrough.has('approveRun') || module.called.has('approveRun'))
      .map((module) => rel(module.file))
      .sort();
    expect(callers).toEqual([...APPROVAL_CALLERS].sort());
  });
});
