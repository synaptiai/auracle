// The lexer the reader guards read SQL with (issue #146).
//
// These are the ways it can fail, and each case names the one it holds:
//
//   T1  A comment marker inside a string or a quoted name reads as a comment,
//       and a second statement after it goes unread.
//   T2  A comment is kept, so a word in one reads as SQL.
//   T3  A quoted name reads as no name, so a function called through one is
//       not read.
//   T4  A character or a form Postgres reads differently from the lexer is
//       read the lexer's way: a carriage return, a character outside ASCII,
//       an `E''`, `U&` or dollar-quoted string, or two strings a line break
//       joins. Each is refused, because none of the readers needs one.
//   T5  A string, a name or a comment that never ends is read as if it did.
import { describe, expect, it } from 'vitest';

import { sqlTokens } from './sql-tokens.js';

const texts = (sql: string): string[] => sqlTokens(sql).map((token) => token.text);

describe('sqlTokens', () => {
  it('reads a comment marker inside a string as text, and the statement after it (T1)', () => {
    expect(texts("SELECT '/*'; COMMIT; SELECT '*/'")).toEqual(['select', '/*', ';', 'commit', ';', 'select', '*/']);
    expect(texts("SELECT '--'; COMMIT")).toEqual(['select', '--', ';', 'commit']);
    expect(texts('SELECT "a/*b"; COMMIT')).toEqual(['select', 'a/*b', ';', 'commit']);
  });

  it('removes every comment, nested ones included (T2)', () => {
    expect(texts('SELECT 1 -- DELETE FROM run\nFROM run')).toEqual(['select', '1', 'from', 'run']);
    expect(texts('SELECT /* a /* DELETE */ b */ 1')).toEqual(['select', '1']);
    expect(texts('SELECT pg_terminate_backend -- a note\n(1)')).toEqual(['select', 'pg_terminate_backend', '(', '1', ')']);
  });

  it('reads a quoted name as a name, and folds a bare word (T3)', () => {
    expect(sqlTokens('SELECT "pg_terminate_backend"(1), SetVal(1)')).toEqual([
      { kind: 'word', text: 'select' },
      { kind: 'name', text: 'pg_terminate_backend' },
      { kind: 'punct', text: '(' }, { kind: 'number', text: '1' }, { kind: 'punct', text: ')' },
      { kind: 'punct', text: ',' },
      { kind: 'word', text: 'setval' },
      { kind: 'punct', text: '(' }, { kind: 'number', text: '1' }, { kind: 'punct', text: ')' },
    ]);
  });

  it('reads a string with a doubled quote, and a parameter (T4)', () => {
    expect(texts("SELECT 'it''s', $1")).toEqual(['select', "it's", ',', '$1']);
  });

  // Each of these hid a function from the guard, because Postgres read the
  // text one way and the lexer another.
  it.each([
    ['a carriage return', 'SELECT 1 AS a --\r, pg_terminate_backend(1)'],
    ['a character outside ASCII', `SELECT x${String.fromCharCode(0xa0)}$t$, pg_terminate_backend(1) --$t$`],
    ['a form feed', `SELECT 1${String.fromCharCode(12)}`],
    ["an E'' string", "SELECT E'a', 1"],
    ['a U& string', "SELECT U&'a', 1"],
    ['a U& name', 'SELECT U&"ticket\\005ftext" FROM step_journal'],
    ['a dollar-quoted string', 'SELECT $q$/*$q$, pg_advisory_lock(1), $q$*/$q$'],
    ['two strings a line break joins', "SELECT E'a'\n'x', pg_terminate_backend(1)"],
    ['two strings in a row', "SELECT 'a'\n'b'"],
  ])('refuses %s (T4)', (_case, sql) => {
    expect(() => sqlTokens(sql)).toThrow(/this lexer does not read/);
  });

  it.each([
    ["a string", "SELECT 'x"],
    ['a quoted name', 'SELECT "x'],
    ['a comment', 'SELECT 1 /* x'],
  ])('refuses %s that never ends (T5)', (_case, sql) => {
    expect(() => sqlTokens(sql)).toThrow(/never ends/);
  });
});
