// A statement read as Postgres reads it, for the guards that check the SQL
// a reader sends (issue #146).
//
// The guards removed SQL comments with patterns before they looked for a
// second statement or a function. A pattern does not know where a string
// starts, so `SELECT '/*'; COMMIT; CREATE TABLE t (x int); SELECT '*/'` read
// as one statement with a comment in it, and a quoted name, `"setval"(…)`,
// read as no function at all. A lexer knows both, so neither hides anything.

/** One token of a statement. Comments are dropped, and nothing else is. */
export interface SqlToken {
  /**
   * `word` is a keyword or a bare name, and `name` is a quoted one. A
   * `string` is any string constant, `param` a `$1`, and `punct` one
   * character of punctuation or an operator.
   */
  readonly kind: 'word' | 'name' | 'string' | 'number' | 'param' | 'punct';
  /** A word lower-cased, as Postgres folds it. A quoted name, a string and a punct as written. */
  readonly text: string;
}

/**
 * The tokens of `sql`, with every comment removed.
 *
 * It reads what the reader statements use, and refuses everything else.
 * Modelling more of Postgres's scanner one case at a time failed: a line
 * comment ends at a carriage return in Postgres and not in a lexer that
 * knew only the line feed, and a character outside ASCII is part of a name
 * to Postgres and punctuation to a lexer that guessed. Each difference hid a
 * function from the guard. So a character or a form the lexer does not read
 * exactly as Postgres does is refused, and a guard that meets one fails.
 *
 * It reads a string with doubled quotes, a quoted name, a nested block
 * comment and a line comment. It refuses a character outside printable
 * ASCII other than a space, a tab or a line feed; an `E''` or `U&` string;
 * a dollar-quoted string; and two strings in a row, which Postgres joins
 * when a line break parts them. A string, a quoted name or a block comment
 * that never ends is refused too: a guard that guessed its end could read
 * the rest as code.
 */
export function sqlTokens(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let at = 0;
  const fail = (what: string): never => {
    throw new Error(`the statement holds ${what} that never ends, at ${at}: ${sql.slice(at, at + 40)}`);
  };
  const refuse = (what: string): never => {
    throw new Error(`the statement holds ${what}, which this lexer does not read, at ${at}: ${sql.slice(at, at + 40)}`);
  };
  const unread = /[^\x20-\x7e\t\n]/.exec(sql);
  if (unread !== null) {
    at = unread.index;
    refuse(`the character U+${unread[0].codePointAt(0)!.toString(16).padStart(4, '0')}`);
  }
  while (at < sql.length) {
    const c = sql[at]!;
    const next = sql[at + 1];
    if (/\s/.test(c)) {
      at++;
    } else if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', at);
      at = end === -1 ? sql.length : end + 1;
    } else if (c === '/' && next === '*') {
      let depth = 0;
      let i = at;
      do {
        if (sql.startsWith('/*', i)) { depth++; i += 2; } else if (sql.startsWith('*/', i)) { depth--; i += 2; } else if (i >= sql.length) { fail('a comment'); } else { i++; }
      } while (depth > 0);
      at = i;
    } else if (/[eEuUbBxXnN]/.test(c) && (next === "'" || (next === '&' && /['"]/.test(sql[at + 2] ?? '')))) {
      refuse('a string with a prefix');
    } else if (c === "'") {
      if (tokens.at(-1)?.kind === 'string') refuse('a string that follows a string');
      let i = at + 1;
      let text = '';
      for (;;) {
        if (i >= sql.length) fail('a string');
        const ch = sql[i]!;
        if (ch === "'" && sql[i + 1] === "'") { text += "'"; i += 2; continue; }
        if (ch === "'") { i++; break; }
        text += ch;
        i++;
      }
      tokens.push({ kind: 'string', text });
      at = i;
    } else if (c === '$' && next !== undefined && /\d/.test(next)) {
      let i = at + 1;
      while (i < sql.length && /\d/.test(sql[i]!)) i++;
      tokens.push({ kind: 'param', text: sql.slice(at, i) });
      at = i;
    } else if (c === '$') {
      refuse('a dollar sign that opens no parameter');
    } else if (c === '"') {
      let i = at + 1;
      let text = '';
      for (;;) {
        if (i >= sql.length) fail('a quoted name');
        if (sql[i] === '"' && sql[i + 1] === '"') { text += '"'; i += 2; continue; }
        if (sql[i] === '"') { i++; break; }
        text += sql[i];
        i++;
      }
      tokens.push({ kind: 'name', text });
      at = i;
    } else if (/[A-Za-z_]/.test(c)) {
      let i = at + 1;
      while (i < sql.length && /[A-Za-z0-9_$]/.test(sql[i]!)) i++;
      tokens.push({ kind: 'word', text: sql.slice(at, i).toLowerCase() });
      at = i;
    } else if (/\d/.test(c)) {
      let i = at + 1;
      while (i < sql.length && /[0-9.]/.test(sql[i]!)) i++;
      tokens.push({ kind: 'number', text: sql.slice(at, i) });
      at = i;
    } else {
      tokens.push({ kind: 'punct', text: c });
      at++;
    }
  }
  return tokens;
}
