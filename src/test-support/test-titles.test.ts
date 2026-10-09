// A test title says what the case proves, in plain words.
//
// The reporter prints each title as the record of a run, and a reader of that
// record has no tracker open beside it. A title that cites an issue number
// points at a conversation instead of saying what holds. So no title in the
// core or the console cites one.
//
// The titles are read with the TypeScript parser, not a pattern over the
// source. The guard reads a small set of shapes, and it fails the run on any
// other: a title or a table it cannot read is a title it cannot clear.
//
// - A value is a string, a number or a template, a `+` of values, or a name
//   that the compiler resolves to one `const` holding a value. The name may be
//   imported. A value spliced into a template, or a `+` operand that is none
//   of these, reads as the digit 0, so `#${n}` still reads as a citation.
// - A table is an array literal, or a `const` holding one, or a tagged
//   template. Each row is a value, an array of values, or an object whose
//   properties are plain `key: value` pairs.
// - The guard prints each row's title as vitest does, and reads the result.
//
// A table that the test builds at run time, such as a list of files, holds no
// text the source states. Each one the tree holds is named in `BUILT_TABLES`,
// with the reason it is safe, and a stale entry fails the run too.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { declarationsOf, importedDeclarationsOf, literalText, parseSource, projectSource, projectSources } from './source-reader.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
// The console has a walker of its own in `purity.test.ts`, which skips it.
// This guard reads both trees, each with a floor of its own.
const TREES = [
  { tree: 'src', files: 150, titles: 2000, known: 'src/test-support/test-titles.test.ts' },
  { tree: 'console/src', files: 15, titles: 500, known: 'console/src/server.test.ts' },
];
const RUNNERS = new Set(['it', 'test', 'describe', 'suite', 'bench']);
// The methods that take something other than a title and hand back a runner.
const BUILDERS = new Set(['each', 'for', 'skipIf', 'runIf', 'extend']);
// The two of them that take a table.
const TABLES = new Set(['each', 'for']);

/**
 * The tables in the tree that a test builds at run time. Each prints a path
 * or a module name the test reads from the disk, which no author writes into
 * a title. The key is the file and the table's source text.
 */
const BUILT_TABLES = new Map([
  ['src/bands/bands.test.ts the table READ_ONLY_MODULES', 'the modules under src/bands, read from the disk'],
  ['src/bands/bands.test.ts the table cites', 'the documents whose text, read from the disk, names the file'],
  ['src/calibration/gold-report-gate.test.ts the table documents', 'the guarded documents, each with its text read from the disk'],
  ['src/journal/journal.test.ts the table readers', 'the reader modules, filtered from a list of paths'],
]);

// `issue 12`, `issue: 12`, `issue no. 12`, `issue number 12`, `issues #3`, `issues/154`,
// `issue-12`, `PR 5`, `PRs 5`, `pull/5`, `pull request 5`, `gh-6` or `GH 12`.
// A `#` and digits anywhere, `owner/repo#154` among them, is the rule below.
const NAMES_AN_ISSUE = /\b(?:issues?|prs?|pull(?:\s+requests?)?|gh)\b[^a-z0-9]{0,3}(?:(?:no|num(?:ber)?)\.?\s*)?\d/i;
// A `#` and the letters and digits that follow it.
const HASH_RUN = /#([0-9a-z]*)/gi;

/**
 * Whether a title cites an issue: a spelling `NAMES_AN_ISSUE` holds, or `#`
 * and up to five digits, such as `#154`.
 *
 * A color is no citation: `#` and three, four, six or eight hex digits with a
 * letter among them, six or eight digits, or one digit three times. So `#111`
 * and `#154a` read as colors, and `#154` as an issue. A false positive costs
 * an author a reword, and a miss costs a review, so the rule leans wide.
 */
function citesAnIssue(title: string): boolean {
  if (NAMES_AN_ISSUE.test(title)) return true;
  return [...title.matchAll(HASH_RUN)].some(([, run = '']) => {
    if (!/^\d{1,5}$/.test(run)) return false;
    return !(run.length === 3 && /^(\d)\1\1$/.test(run));
  });
}

/** An expression with the wrappers that change no value removed: parentheses, `as`, `!` and `satisfies`. */
function unwrapped(node: ts.Expression): ts.Expression {
  let at = node;
  while (ts.isParenthesizedExpression(at) || ts.isAsExpression(at) || ts.isNonNullExpression(at)
    || ts.isSatisfiesExpression(at) || ts.isTypeAssertionExpression(at)) {
    at = at.expression;
  }
  return at;
}

/** Each file read again inside the whole project, with the text it was read from. */
const projects = new Map<string, { text: string; project: ts.SourceFile }>();

/**
 * Test files read from the disk inside one program, by `scannedFiles`. A file
 * whose text matches its entry reuses it, so the scan builds one program in
 * all rather than one for each file.
 */
const fromDisk = new Map<string, ts.SourceFile>();

/** A file read again inside the whole project, once, so an import resolves. */
function projectOf(file: ts.SourceFile): ts.SourceFile {
  const held = projects.get(file.fileName);
  if (held !== undefined && held.text === file.text) return held.project;
  const read = fromDisk.get(file.fileName);
  if (read !== undefined && read.text === file.text) return read;
  const project = projectSource(file.fileName, file.text);
  projects.set(file.fileName, { text: file.text, project });
  return project;
}

/** The identifier that starts at `position` in `source`, or null. */
function findIdentifierAt(source: ts.SourceFile, position: number): ts.Identifier | null {
  let found: ts.Identifier | null = null;
  const visit = (node: ts.Node): void => {
    if (found !== null || position < node.getFullStart() || position >= node.getEnd()) return;
    if (ts.isIdentifier(node) && node.getStart() === position) found = node;
    else ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The declarations a name refers to, with an import followed through the whole project. */
function declarationsThrough(name: ts.Identifier): readonly ts.Declaration[] {
  const declarations = declarationsOf(name);
  if (declarations.length !== 1 || !ts.isImportSpecifier(declarations[0]!)) return declarations;
  const found = findIdentifierAt(projectOf(name.getSourceFile()), name.getStart());
  return found === null ? [] : importedDeclarationsOf(found);
}

/**
 * The initializer of the one `const` a name refers to, or null.
 *
 * The compiler resolves the name in its own scope, so two tables of the same
 * name in two blocks are two tables. Anything else, such as a parameter, a
 * `let`, an import of a missing module or two declarations, holds a value the
 * source does not state, and is null.
 */
function constantOf(name: ts.Identifier): ts.Expression | null {
  const declarations = declarationsThrough(name);
  if (declarations.length !== 1) return null;
  const declaration = declarations[0]!;
  if (!ts.isVariableDeclaration(declaration) || declaration.initializer === undefined) return null;
  if (!ts.isVariableDeclarationList(declaration.parent)
    || (declaration.parent.flags & ts.NodeFlags.Const) === 0) {
    return null;
  }
  return unwrapped(declaration.initializer);
}

/**
 * The text of a value, or null when it is no value the guard reads.
 *
 * A spliced value, and an operand of `+` that is no value, reads as the digit
 * 0, so `'issue #' + n` reads as `issue #0`.
 */
function textOf(node: ts.Expression): string | null {
  const at = unwrapped(node);
  const literal = literalText(at);
  if (literal !== null) return literal;
  if (ts.isNumericLiteral(at)) return at.text;
  if (ts.isPrefixUnaryExpression(at) && ts.isNumericLiteral(at.operand)) return at.getText();
  if ([ts.SyntaxKind.NullKeyword, ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(at.kind)) {
    return at.getText();
  }
  // A member of a global, such as `Number.NaN`, holds no text a test writes.
  if (ts.isPropertyAccessExpression(at) && ts.isIdentifier(at.expression)
    && declarationsOf(at.expression).length === 0) {
    return at.getText();
  }
  if (ts.isTemplateExpression(at)) {
    return at.head.text + at.templateSpans.map((span) => `${textOf(span.expression) ?? '0'}${span.literal.text}`).join('');
  }
  if (ts.isTaggedTemplateExpression(at)) return textOf(at.template);
  if (ts.isBinaryExpression(at) && at.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = textOf(at.left);
    const right = textOf(at.right);
    return left === null && right === null ? null : `${left ?? '0'}${right ?? '0'}`;
  }
  if (ts.isIdentifier(at)) {
    const held = constantOf(at);
    return held === null ? null : textOf(held);
  }
  return null;
}

/** One row of a table: its values in order, and its values by key. Null is a value the guard cannot read. */
interface Row {
  values: (string | null)[];
  keys: Map<string, string | null>;
}

/** The text of a property name, or null for a computed one. */
function keyOf(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) ? name.text : null;
}

/** One row, or null when its shape is none the guard reads: a spread, a shorthand, a method or a computed key. */
function rowOf(node: ts.Expression): Row | null {
  const at = unwrapped(node);
  if (ts.isArrayLiteralExpression(at)) {
    if (at.elements.some((element) => ts.isSpreadElement(element))) return null;
    const values = at.elements.map((element) => textOf(element));
    return { values, keys: new Map(values.map((value, index) => [String(index), value])) };
  }
  if (ts.isObjectLiteralExpression(at)) {
    const keys = new Map<string, string | null>();
    for (const property of at.properties) {
      if (!ts.isPropertyAssignment(property)) return null;
      const key = keyOf(property.name);
      if (key === null) return null;
      keys.set(key, textOf(property.initializer));
    }
    // `%s` prints the whole object, so every value is in what it prints.
    const values = [...keys.values()];
    const whole = values.includes(null)
      ? null
      : `{ ${[...keys].map(([key, value]) => `${key}: ${value ?? ''}`).join(', ')} }`;
    return { values: [whole], keys };
  }
  const value = textOf(at);
  return { values: [value], keys: new Map() };
}

/** The rows of a table, or null when the table is none the guard reads. */
function rowsOf(table: ts.Node): Row[] | null {
  let at: ts.Node = ts.isExpression(table) ? unwrapped(table) : table;
  if (ts.isIdentifier(at)) {
    const held = constantOf(at);
    if (held === null) return null;
    at = held;
  }
  // A tagged table: the first line names the columns, and the spliced values
  // fill them a row at a time.
  if (ts.isNoSubstitutionTemplateLiteral(at)) return [];
  if (ts.isTemplateExpression(at)) {
    const columns = at.head.text.split('\n')[0]!.split('|').map((column) => column.trim()).filter(Boolean);
    const values = at.templateSpans.map((span) => textOf(span.expression));
    if (columns.length === 0 || values.length % columns.length !== 0) return null;
    const rows: Row[] = [];
    for (let start = 0; start < values.length; start += columns.length) {
      const slice = values.slice(start, start + columns.length);
      rows.push({ values: slice, keys: new Map(columns.map((column, index) => [column, slice[index]!])) });
    }
    return rows;
  }
  if (!ts.isArrayLiteralExpression(at)) return null;
  const rows: Row[] = [];
  for (const element of at.elements) {
    if (ts.isSpreadElement(element)) return null;
    const row = rowOf(element);
    if (row === null) return null;
    rows.push(row);
  }
  return rows;
}

// The placeholders vitest fills from a row: `%s` and its siblings in order,
// `%#` and `%$` with the row's index, and `$key` or `$0` by name.
const PLACEHOLDER = /%%|%[sdifjoOc]|%#|%\$|\$([$\p{ID_Continue}.]+)/gu;

/**
 * A row's title as vitest prints it, or null when the title prints a value
 * the guard cannot read. A row that is not a list prints as one value.
 */
function printed(title: string, row: Row): string | null {
  let next = 0;
  let unread = false;
  const text = title.replace(PLACEHOLDER, (match, key: string | undefined) => {
    if (match === '%%') return '%';
    if (match === '%#') return '0';
    if (match === '%$') return '1';
    const value = key === undefined ? row.values[next++] : row.keys.get(key.split('.')[0]!);
    if (value === undefined) return match;
    if (value === null) unread = true;
    return value ?? '';
  });
  return unread ? null : text;
}

/** Whether a title prints anything from its row. */
const printsARow = (title: string): boolean => [...title.matchAll(PLACEHOLDER)].some(([match]) => match !== '%%');

/** The callee a name stands for, when it names the one `const` that holds a runner. */
function heldRunner(callee: ts.Expression): ts.Expression {
  const at = unwrapped(callee);
  if (!ts.isIdentifier(at) || RUNNERS.has(at.text)) return at;
  const held = constantOf(at);
  return held !== null && runnerOf(held) !== null ? held : at;
}

/**
 * The runner a callee reaches: `it`, `it.each(...)`, `describe.skipIf(...)`,
 * a runner imported from vitest under another name, or a `const` holding one.
 */
function runnerOf(callee: ts.Expression): string | null {
  let node: ts.Expression = unwrapped(callee);
  for (;;) {
    if (ts.isIdentifier(node)) {
      const declarations = declarationsOf(node);
      const imported = declarations.length === 1 && ts.isImportSpecifier(declarations[0]!) ? declarations[0] : null;
      if (imported !== null) {
        // A runner's name from any module is a runner: vitest's own, or a
        // fixture module's `test = base.extend({})`. Another name may hold
        // one, so the import is followed to the const it names.
        const name = (imported.propertyName ?? imported.name).text;
        if (RUNNERS.has(name)) return name;
        const held = constantOf(node);
        return held === null ? null : runnerOf(held);
      }
      if (RUNNERS.has(node.text)) return node.text;
      const held = constantOf(node);
      return held === null ? null : runnerOf(held);
    }
    if (ts.isPropertyAccessExpression(node)) {
      // `v.it` after `import * as v`: the member is the runner.
      if (ts.isIdentifier(node.expression) && RUNNERS.has(node.name.text)
        && declarationsOf(node.expression).some((declaration) => ts.isNamespaceImport(declaration))) {
        return node.name.text;
      }
      node = node.expression;
    } else if (ts.isCallExpression(node)) node = node.expression;
    else if (ts.isTaggedTemplateExpression(node)) node = node.tag;
    else if (ts.isParenthesizedExpression(node)) node = node.expression;
    else return null;
  }
}

/** The table a callee such as `it.each(table)` or `` it.each`…` `` takes, or null when it takes none. */
function tableOf(callee: ts.Expression): ts.Node | null {
  const at = heldRunner(callee);
  if (ts.isCallExpression(at) && ts.isPropertyAccessExpression(at.expression)
    && TABLES.has(at.expression.name.text) && at.arguments.length > 0) {
    return at.arguments[0]!;
  }
  if (ts.isTaggedTemplateExpression(at) && ts.isPropertyAccessExpression(at.tag) && TABLES.has(at.tag.name.text)) {
    return at.template;
  }
  return null;
}

/** Whether a call builds a runner, such as `it.each(table)` or `it.extend({})`, rather than declaring a test. */
function buildsARunner(call: ts.CallExpression): boolean {
  const callee = unwrapped(call.expression);
  return ts.isPropertyAccessExpression(callee) && BUILDERS.has(callee.name.text);
}

/** What a title prints, read where its runner is called. */
interface Found {
  line: number;
  title: string;
}

/** Every title a source declares, with its line, and every title or table the guard cannot read. */
export function titlesOf(fileName: string, source: string): { found: Found[]; unread: Found[] } {
  const file = parseSource(fileName, source);
  const found: Found[] = [];
  const unread: Found[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && !buildsARunner(node) && runnerOf(node.expression) !== null
      && node.arguments.length > 0) {
      const line = file.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      const title = textOf(node.arguments[0]!);
      if (title === null) {
        unread.push({ line, title: node.arguments[0]!.getText() });
      } else {
        found.push({ line, title });
        const table = tableOf(node.expression);
        if (table !== null && printsARow(title)) {
          const rows = rowsOf(table);
          if (rows === null) {
            unread.push({ line, title: `the table ${table.getText()}` });
          } else {
            rows.forEach((row, index) => {
              const text = printed(title, row);
              if (text === null) unread.push({ line, title: `row ${String(index)} of the table ${table.getText()}` });
              else found.push({ line, title: text });
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { found, unread };
}

function testFiles(tree: string): string[] {
  return readdirSync(join(REPO_ROOT, tree), { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.test.ts'))
    .map((name) => join(REPO_ROOT, tree, name));
}

/** Every test file of both trees with its titles, checked against each tree's floor. */
function scannedFiles(): Array<{ path: string; found: Found[]; unread: Found[] }> {
  return TREES.flatMap(({ tree, files, titles, known }) => {
    const paths = testFiles(tree);
    for (const [path, source] of projectSources(paths)) fromDisk.set(path, source);
    const results = paths.map((path) => ({ path, ...titlesOf(path, readFileSync(path, 'utf8')) }));
    const read = results.flatMap(({ found }) => found);
    // A scan that read nothing would pass. These floors fail it first.
    expect(paths.length, `the scan found too few test files under ${tree}`).toBeGreaterThan(files);
    expect(read.length, `the scan read too few titles under ${tree}`).toBeGreaterThan(titles);
    expect(paths.map((path) => relative(REPO_ROOT, path)), `the scan missed ${known}`).toContain(known);
    return results;
  });
}

// A sample sits at a path inside the project, so its imports resolve.
const SAMPLE = join(REPO_ROOT, 'src/test-support/sample-titles.test.ts');
const read = (source: string): { found: string[]; unread: string[] } => {
  const { found, unread } = titlesOf(SAMPLE, source);
  return { found: found.map((title) => title.title), unread: unread.map((title) => title.title) };
};
const titles = (source: string): string[] => read(source).found;

describe('test titles', () => {
  it('reads a title in each shape a test file writes', () => {
    const source = [
      "it('a plain title', () => {});",
      "describe.each([1])('a title after each', () => {});",
      'it.skipIf(true)(`a template ${1} title`, () => {});',
      "test('a title split '\n  + 'across lines', () => {});",
      "suite('a suite title', () => {});",
      "const TITLE = 'a title held by name';",
      'it(TITLE, () => {});',
      'const n = 7;',
      "it('a title and a number ' + n, () => {});",
      'it(`a template holding ${TITLE}`, () => {});',
      "it('a title with 100%% of its words' satisfies string, () => {});",
      'helper("not a title");',
    ].join('\n');
    expect(titles(source)).toEqual([
      'a plain title',
      'a title after each',
      'a template 1 title',
      'a title split across lines',
      'a suite title',
      'a title held by name',
      'a title and a number 7',
      'a template holding a title held by name',
      'a title with 100%% of its words',
    ]);
  });

  it('reads a runner imported under another name, a runner held in a const, and an extended one', () => {
    const source = [
      "import { it as check, test } from 'vitest';",
      "check('a renamed runner', () => {});",
      'const scenario = test.each([[\'a held row\']]);',
      "scenario('%s', () => {});",
      'const myTest = test.extend({});',
      "myTest('an extended runner', () => {});",
      "import * as v from 'vitest';",
      "v.it('a namespace runner', () => {});",
      "import { test as fixtureTest } from './no-such-fixture.js';",
      "fixtureTest('a fixture runner', () => {});",
    ].join('\n');
    expect(read(source)).toEqual({
      found: ['a renamed runner', '%s', 'a held row', 'an extended runner', 'a namespace runner', 'a fixture runner'],
      unread: [],
    });
  });

  it('flags a title that cites an issue, in any of those spellings', () => {
    for (const title of [
      'the queue (issue #101)', 'a fault (#94)', 'fixed in issue 12', 'see issues #3', 'per issue#4',
      'see issue-154', 'see issue: 12', 'see issue no. 12', 'from PR#5', 'see PR 12', 'see PRs 5',
      'see pull request 12', 'tracked as gh-6', 'tracked as GH#12', 'tracked as GH 12', 'a list [#12]',
      'a list {#12}', 'fixed in #0', 'the `#154` case', "the '#154' case", 'the "#154" case', 'fix,#154',
      'fixed:#154', 'step #1 of 3', 'see auracle#154', 'see owner/repo#154', 'see issues/154',
      'https://github.com/o/r/issues/154', 'see pull/154', 'see ##154', 'a big one, #12345',
      'the 2 issues 3 times', 'fixed under issue number 12', 'see PR num. 5',
    ]) {
      expect(citesAnIssue(title), title).toBe(true);
    }
    for (const title of [
      'the queue a reviewer lands on', 'draws the rail in #0d0e10', 'draws the ink in #000000',
      'draws the ink in #000', 'a border of #333', 'a border of #111', 'a border of #ddd',
      'a border of #154a', 'a run of six, #123456', 'a reply with an issue in it',
    ]) {
      expect(citesAnIssue(title), title).toBe(false);
    }
  });

  it('reads a spliced value as a digit, so a spliced citation still counts', () => {
    const source = 'let n = 154;\nit(`fixed in #${n}`, () => {});\nit("fixed in issue #" + n, () => {});';
    expect(titles(source)).toEqual(['fixed in #0', 'fixed in issue #0']);
  });

  // A table's rows print as vitest prints them, whether the table is written
  // inline, held in a const, imported, or tagged.
  it('prints each row of a table into its title, as vitest does', () => {
    const source = [
      "it.each([['the queue (issue #154)', 'data with #41 in it']])('%s', () => {});",
      'it.each([[154]])(\'fixed in #%d\', () => {});',
      "const ROWS = [{ name: 'a row by name', input: 'data #41' }, { 'name': 'a quoted key' }];",
      "describe.each(ROWS)('$name', () => {});",
      "it.for([['a row of for', 1]])('%s', () => {});",
      'it.each([[`a spliced row #${1}`]])(\'%s\', () => {});',
      "it.each`a | b\n${'a tagged row'} | ${2}`('$a then $b', () => {});",
      "it.each([['x', 'issue #12']])('%s then $1', () => {});",
      "const T = 'a constant in a row';",
      "it.each([[T]])('%s and %% of %#', () => {});",
      "it.each([[-1], [null], [Number.NaN]])('reads %s', () => {});",
      "it.each([['one', 'two']])('%s and %s', () => {});",
      "it.each([{ a: 'x', b: 'issue #12' }])('%s', () => {});",
      "it.each(['plain'])('a title with no placeholder', () => {});",
    ].join('\n');
    expect(titles(source)).toEqual([
      '%s', 'the queue (issue #154)',
      'fixed in #%d', 'fixed in #154',
      '$name', 'a row by name', 'a quoted key',
      '%s', 'a row of for',
      '%s', 'a spliced row #1',
      '$a then $b', 'a tagged row then 2',
      '%s then $1', 'x then issue #12',
      '%s and %% of %#', 'a constant in a row and % of 0',
      'reads %s', 'reads -1', 'reads null', 'reads Number.NaN',
      '%s and %s', 'one and two',
      '%s', '{ a: x, b: issue #12 }',
      'a title with no placeholder',
    ]);
  });

  it('reads the table a name refers to in its own scope', () => {
    const source = [
      "describe('one', () => { const cases = [['the first table']]; it.each(cases)('%s', () => {}); });",
      "describe('two', () => { const cases = [['the second table']]; it.each(cases)('%s', () => {}); });",
    ].join('\n');
    expect(titles(source)).toEqual(['one', '%s', 'the first table', 'two', '%s', 'the second table']);
  });

  it('follows an import to the table or the title it names', () => {
    const source = [
      "import { CLAIM_GRADES, CLAIM_GRADES as GRADES } from '../domain/gold-types.js';",
      "import { DEFAULT_EGRESS_ADAPTER } from '../adapters/performs.js';",
      "it.each(CLAIM_GRADES)('grades %s', () => {});",
      "it.each(GRADES)('grades %s again', () => {});",
      'it(DEFAULT_EGRESS_ADAPTER, () => {});',
    ].join('\n');
    expect(read(source)).toEqual({
      found: [
        'grades %s', 'grades off_topic', 'grades absent', 'grades unstated_detail',
        'grades %s again', 'grades off_topic again', 'grades absent again', 'grades unstated_detail again',
        'helpdesk',
      ],
      unread: [],
    });
  });

  it('refuses a table, a row or a title it cannot read', () => {
    const source = [
      "import { ROWS } from './no-such-module.js';",
      "it.each(ROWS)('%s', () => {});",
      "function run(rows: string[][]) { it.each(rows)('%s', () => {}); it.each([...rows])('%s', () => {}); }",
      "it.each(makeRows())('%s', () => {});",
      "let mutable = [['a']];",
      "it.each(mutable)('%s', () => {});",
      "const name = 'issue #12';",
      "it.each([{ name }])('$name', () => {});",
      "const BASE = { name: 'issue #12' };",
      "it.each([{ ...BASE }])('$name', () => {});",
      "it.each([[makeTitle()]])('%s', () => {});",
      "const XS = ['a'];",
      "it.each([[...XS, 'issue #12']])('$1', () => {});",
      "it.each`a | b\n${'only one value'}`('$a', () => {});",
      'it(makeTitle(), () => {});',
    ].join('\n');
    expect(read(source).unread).toEqual([
      'the table ROWS',
      'the table rows',
      'the table [...rows]',
      'the table makeRows()',
      'the table mutable',
      'the table [{ name }]',
      'the table [{ ...BASE }]',
      'row 0 of the table [[makeTitle()]]',
      "the table [[...XS, 'issue #12']]",
      "the table `a | b\n${'only one value'}`",
      'makeTitle()',
    ]);
  });

  it('cites no issue number in any core or console test title, and reads every one', () => {
    const scanned = scannedFiles().map((result) => ({ ...result, path: relative(REPO_ROOT, result.path) }));
    const paths = scanned.map(({ path }) => path);
    for (const { known } of TREES) expect(paths).toContain(known);
    expect(paths.some((path) => path.startsWith('console/src/')), 'the console was scanned').toBe(true);
    const unread = scanned.flatMap(({ path, unread }) => unread.map((title) => `${path} ${title.title}`));
    expect([...new Set(unread)].sort(), 'each table built at run time is named, and nothing else is unread')
      .toEqual([...BUILT_TABLES.keys()].sort());
    const citing = scanned.flatMap(({ path, found }) => found
      .filter((title) => citesAnIssue(title.title))
      .map((title) => `${path}:${String(title.line)} ${title.title}`));
    expect(citing).toEqual([]);
  });
});
