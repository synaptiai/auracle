// The reader the source guards share (issue #146).
//
// A guard that strips comments and strings with patterns has to guess where
// a string ends, and every guess in this tree failed on an ordinary line. The
// compiler does not guess. These are the ways the reader that replaced the
// patterns can still fail, and each case below names the one it holds:
//
//   F1  A comment marker inside a string, a template or a regular expression
//       reads as a comment, and the code after it is lost.
//   F2  A comment is kept, so a call or a statement written in one is read.
//   F3  JSX text that starts with `//` is removed as a comment.
//   F4  A module that does not parse is read from the parser's guess.
//   F5  A literal reads as written rather than as the program sees it, or a
//       module path reads as a literal.
//   F6  A query call in a spelling the reader does not list is not read.
//   F7  A query method handed on rather than called reads as no reach.
//   F8  A name resolves to a declaration other than the one whose value the
//       call passes: a `let`, a `var`, a loop variable, a catch clause, a
//       destructured parameter, a function or an import of the same name.
//   F9  A local constant does not shadow a module constant of the same name.
//   F10 A call or a statement in a string or a comment reads as a call.
//   F11 The console's copy of the comment walk drifts from this one, and a
//       fix made here never reaches it.
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { literalTexts, nodesOf, parseSource, queryStatements, withoutComments } from './source-reader.js';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;

describe('withoutComments', () => {
  it('removes a line comment and a block comment (F2)', () => {
    expect(withoutComments('const a = 1; // DELETE FROM run\nconst b = /* DROP TABLE run */ 2;', 'm.ts'))
      .toBe('const a = 1; \nconst b =  2;');
  });

  it('keeps a string holding a URL, and the code after it (F1)', () => {
    expect(withoutComments("const u = 'https://example.test/v1'; f(a); // gone", 'm.ts'))
      .toBe("const u = 'https://example.test/v1'; f(a); ");
  });

  it('keeps a string holding a block-comment marker, and the code after it (F1)', () => {
    const text = "const note = 'see /* the docs'; f(a); /* gone */";
    expect(withoutComments(text, 'm.ts')).toBe("const note = 'see /* the docs'; f(a); ");
  });

  it('keeps the code after a regular expression that holds a quote (F1)', () => {
    const text = `const r = /"/; const u = "http://x"; f(a); // gone`;
    expect(withoutComments(text, 'm.ts')).toBe(`const r = /"/; const u = "http://x"; f(a); `);
  });

  it('keeps the code after a double-quoted string that holds an apostrophe (F1)', () => {
    const text = `const a = "it's"; f(a); const b = 'x'; // gone`;
    expect(withoutComments(text, 'm.ts')).toBe(`const a = "it's"; f(a); const b = 'x'; `);
  });

  it('keeps a comment marker inside a template literal (F1)', () => {
    const text = 'const q = `SELECT 1 -- a note // not a comment`; // gone';
    expect(withoutComments(text, 'm.ts')).toBe('const q = `SELECT 1 -- a note // not a comment`; ');
  });

  it('removes a comment inside a template expression, which is code (F2)', () => {
    expect(withoutComments('const q = `a${/* gone */ b}c`;', 'm.ts')).toBe('const q = `a${ b}c`;');
  });

  it('keeps JSX text that starts with a comment marker, in a JSX file (F3)', () => {
    const text = 'const v = <p>\n  // DELETE FROM run\n</p>; // gone';
    expect(withoutComments(text, 'view.tsx')).toBe('const v = <p>\n  // DELETE FROM run\n</p>; ');
  });
});

describe('parseSource', () => {
  // The parser recovers from each of these and returns a tree. A guard that
  // read that tree would check code the parser guessed at.
  it.each([
    ['an unterminated template', 'const q = `SELECT 1;\nf(a);'],
    ['an unterminated string', "const q = 'SELECT 1;\nf(a);"],
    ['a broken function', 'function (a, { b'],
  ])('refuses a module with %s (F4)', (_case, text) => {
    expect(() => parseSource('m.ts', text)).toThrow(/m\.ts:\d+ does not parse/);
  });
});

describe('literalTexts', () => {
  it('reads every string and template literal, and no comment (F2)', () => {
    const source = parseSource('m.ts', [
      "const a = 'one'; // 'not a literal'",
      'const b = "two";',
      'const c = `three`;',
      'const d = `four ${x} five`;',
      "/* 'nor this' */",
    ].join('\n'));
    expect(literalTexts(source)).toEqual(['one', 'two', 'three', 'four ${…} five']);
  });

  // An escape is the character it stands for in both kinds of literal, so a
  // word spelled with one is read as the word (F5).
  it('reads an escape as the character it stands for, in a string and in a template (F5)', () => {
    const b = String.fromCharCode(92);
    const source = parseSource('m.ts', `const a = '${b}x44ELETE'; const t = \`${b}x44ELETE \${x}\`;`);
    expect(literalTexts(source)).toEqual(['DELETE', 'DELETE ${…}']);
  });

  it('reads no module path, in any form (F5)', () => {
    const source = parseSource('m.ts', [
      "import a from './a.js';",
      "export { b } from './b.js';",
      "import c = require('./c.js');",
      "const d = await import('./d.js');",
      "const e = require('./e.js');",
      "type F = typeof import('./f.js');",
      "const kept = 'kept';",
    ].join('\n'));
    expect(literalTexts(source)).toEqual(['kept']);
  });
});

describe('queryStatements', () => {
  // Shipped files are modules, and so is each sample. In a script `await` is
  // a name, and `await (pool.query)(…)` reads as a call to it.
  const statements = (text: string) => queryStatements(parseSource('m.ts', `export {};\n${text}`));

  it('reads the statement of each query call, in every spelling (F6)', () => {
    expect(statements([
      "await pool.query('SELECT 1');",
      "await pool['query']('SELECT 2');",
      'await pool[`query`](`SELECT 3`, [a]);',
      "await (pool.query)('SELECT 4');",
      "await pool.query!('SELECT 5');",
      "await (pool.query as Q)('SELECT 6');",
      "await query('SELECT 7');",
    ].join('\n')).map((s) => [s.call !== null, s.statement])).toEqual([
      [true, 'SELECT 1'], [true, 'SELECT 2'], [true, 'SELECT 3'], [true, 'SELECT 4'],
      [true, 'SELECT 5'], [true, 'SELECT 6'], [true, 'SELECT 7'],
    ]);
  });

  // The statements a guard exists to catch sit after the shapes that blinded
  // the patterns: a URL, a quote inside a regular expression and an
  // apostrophe inside a double-quoted string (F1).
  it('reads a call after a URL, a regular expression quote and an apostrophe (F1)', () => {
    expect(statements(
      `const r = /"/; const u = "http://x"; const a = "it's"; await pool.query('DELETE FROM run'); const b = 'x';`,
    ).map((s) => s.statement)).toEqual(['DELETE FROM run']);
  });

  // Each of these takes the method off the pool, so the statement it runs is
  // never an argument the reader can see. A guard must refuse each one.
  it('reads every use that hands the method on, with no call (F7)', () => {
    const uses = statements([
      'const run = pool.query.bind(pool);',
      "await pool.query.call(pool, 'DELETE FROM run');",
      'const { query } = pool;',
      'const { query: q } = pool;',
      "const { 'query': r } = pool;",
      "const m = Reflect.get(pool, 'query');",
      "const code = \"return p.query('DELETE FROM run')\";",
      "const k = \"p['query']\";",
    ].join('\n'));
    expect(uses.map((s) => s.call)).toEqual([null, null, null, null, null, null, null, null]);
    expect(uses.map((s) => s.statement)).toEqual([null, null, null, null, null, null, null, null]);
  });

  // A key held in a constant names the method as surely as a literal key.
  it('reads a call through a key a constant holds (F6)', () => {
    expect(statements("const K = 'query'; await pool[K]('DELETE FROM run');").map((s) => [s.call !== null, s.statement]))
      .toEqual([[true, 'DELETE FROM run']]);
    expect(statements("const K = 'query'; const m = Reflect.get(pool, K);").map((s) => s.call)).toEqual([null]);
  });

  it('reads a constant the call names, from the scope the call sits in (F9)', () => {
    const read = statements([
      "const READ = 'SELECT 1';",
      'async function f() { await pool.query(READ); }',
      "async function g() { const READ = 'DELETE FROM run'; await pool.query(READ); }",
    ].join('\n'));
    expect(read.map((s) => s.statement)).toEqual(['SELECT 1', 'DELETE FROM run']);
  });

  // Each call passes a value other than the module constant's. The module
  // constant is a SELECT, so a reader that resolved to it would read the
  // DELETE as a read (F8).
  it.each([
    ['a let that is reassigned', "let READ = 'SELECT 1'; READ = 'DELETE FROM run'; await pool.query(READ);"],
    ['a var', "var READ = 'SELECT 1'; await pool.query(READ);"],
    ['a destructured parameter', "const READ = 'SELECT 1'; async function f({ READ }) { await pool.query(READ); }"],
    ['an array parameter', "const READ = 'SELECT 1'; async function f([READ]) { await pool.query(READ); }"],
    ['a loop variable', "const READ = 'SELECT 1'; for (const READ of ['DELETE FROM run']) await pool.query(READ);"],
    ['a catch clause', "const READ = 'SELECT 1'; try { f(); } catch (READ) { await pool.query(READ); }"],
    ['a local destructure', "const READ = 'SELECT 1'; function f() { const { READ } = o; return pool.query(READ); }"],
    ['a hoisted var', "const READ = 'SELECT 1'; function f() { { var READ = x; } return pool.query(READ); }"],
    ['a function of the same name', "const READ = 'SELECT 1'; function f() { function READ() {} return pool.query(READ); }"],
    ['an import', "import { READ } from './sql.js'; await pool.query(READ);"],
    ['a constant built from another', "const A = 'SELECT 1'; const READ = A; await pool.query(READ);"],
  ])('reads no statement through %s (F8)', (_case, text) => {
    const read = statements(text);
    expect(read).toHaveLength(1);
    expect(read[0]!.statement).toBeNull();
  });

  it('reads no statement for a call it cannot resolve to one literal (F8)', () => {
    const read = statements([
      'await pool.query(`SELECT ${table}`);',
      'await pool.query(sql);',
      "await pool.query('SEL' + 'ECT 1');",
    ].join('\n'));
    expect(read.map((s) => s.statement)).toEqual([null, null, null]);
    expect(read.map((s) => s.argument)).toEqual(['`SELECT ${table}`', 'sql', "'SEL' + 'ECT 1'"]);
  });

  it('reads no call in a comment, and no declaration as a use (F10)', () => {
    expect(statements('// pool.query(\'DELETE FROM run\')\n/* query(x) */')).toEqual([]);
    expect(statements('async function f(query: Q) {} interface P { query(): void }')).toEqual([]);
  });
});

// The console reaches the core only through its published barrels, and this
// module is not one, so the console's SQL guard keeps its own copy of the
// comment walk. Nothing else would notice a fix made to one copy alone (F11).
describe('the console copy of the comment walk', () => {
  const walk = (relative: string, name: string): string => {
    const declaration = nodesOf(parseSource(`${REPO_ROOT}${relative}`)).find((node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === name);
    const body = declaration?.body?.getText() ?? '';
    return body.slice(body.indexOf('const ranges'));
  };

  it('is the same text as this one, from the comment walk onward (F11)', () => {
    const core = walk('src/test-support/source-reader.ts', 'withoutComments');
    expect(core).toContain('getLeadingCommentRanges');
    expect(walk('console/src/select-only.test.ts', 'stripComments')).toBe(core);
  });
});
