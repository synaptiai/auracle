// `.env.example` names every variable the code reads.
//
// The file exists so nobody has to read 17 entry points to find out what a
// process needs. That is only true while it is complete, and a file that
// documents configuration drifts the moment somebody adds a variable and
// forgets it. Nothing would fail: the process would read `undefined` and
// take a default nobody chose.
//
// The source is parsed, not matched, because this repository has been caught
// by pattern-matched guards before. But parsing precisely is not enough
// either. The first version of this file resolved `process.env.NAME`,
// `process.env['NAME']` and the two shared helpers, and it passed against an
// example missing twelve variables:
//
//   - `src/config/action-profile.ts` reads `env['ACTION_CLASS']` through a
//     parameter, not `process.env` directly.
//   - `src/adapters/imap-smtp.ts` reads through local `required`, `flag` and
//     `port` helpers, and `port` reaches the environment only by calling
//     `required`, so even a one-level helper rule misses `SMTP_PORT`.
//   - `src/fixtures/half-from-env.ts` holds `GOLD_FIT_PATH` in a frozen
//     record and indexes it with a computed key, so no literal ever appears
//     beside `env[...]`.
//
// So the rule that decides is the coarse one, and it fails closed: every
// SCREAMING_SNAKE string literal in a file that mentions the environment is
// a candidate, and each must be documented or listed below as not a variable
// name. A new variable in a shape nobody anticipated still has to be
// triaged. The precise scan remains, to say which file reads what.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const EXAMPLE = '.env.example';

/** The packages a process is built from. The test harness is not one. */
const ROOTS = ['src', join('console', 'src')];

/** Shared helpers that take the variable's name as a string argument. */
const SHARED_HELPERS = ['requiredEnv', 'positiveIntEnv'];

/**
 * Literals that look like a variable name and are not one.
 *
 * Every entry is a word this codebase passes to something that is not the
 * environment: three SQL statements, two HTTP methods, a mailbox name, two
 * signals and a Unicode normal form. The list is short and each entry is obvious, which is the point —
 * a name that has to be argued about is probably a variable.
 */
const NOT_A_VARIABLE = new Set([
  'BEGIN', 'COMMIT', 'ROLLBACK', // src/ledger/migrate.ts
  'GET', 'POST', // src/adapters/freescout.ts
  'INBOX', // src/adapters/imap-smtp.ts
  'SIGINT', 'SIGTERM', // every daemon's shutdown handler
  'NFKC', // src/config/action-profile.ts
]);

/**
 * Variables no process reads, which the example still has to carry.
 *
 * The compose files interpolate the first five: compose is a shell, not a
 * program. `AURACLE_IMAGE` selects the tag the dev stack runs,
 * `COMPOSE_PROFILES` selects its optional services, and the two passwords
 * are the ledger's and the readers' role's logins in the stack.
 * The rest are read by `src/test-support/`, which the scan skips because a
 * harness is not something an adopter configures — but an adopter running
 * the suite still needs to know they exist.
 */
const NOT_READ_BY_A_PROCESS = new Set([
  'AURACLE_DB_PORT',
  'AURACLE_IMAGE',
  'COMPOSE_PROFILES',
  'AURACLE_READER_PASSWORD',
  'AURACLE_DB_PASSWORD',
  'AURACLE_TEST_DB_REUSE',
  'AURACLE_TEST_MAIL_REUSE',
  'AURACLE_TEST_ALLOW_REMOTE_DB',
  'AURACLE_E2E_ACCEPT',
  'MAIL_HOST',
  'MAIL_SMTP_PORT',
  'MAIL_IMAP_PORT',
]);

const LOOKS_LIKE_A_NAME = /^[A-Z][A-Z0-9_]{2,}$/;

/**
 * A fragment, rather than a whole variable name.
 *
 * `process.env['AURACLE_' + 'SPLIT_NAME']` reads one variable and offers
 * this scan two literals, neither of which is it. Both match the pattern
 * above, so the coarse net reported `AURACLE_` and `SPLIT_NAME` as missing
 * and a maintainer following the message would document those two — turning
 * the suite green with the real variable still undocumented. A name this
 * scan cannot resolve is refused by name here instead.
 */
const LOOKS_BUILT = /_$/;

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'test-support') continue;
      found.push(...sourceFiles(full));
      continue;
    }
    if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) {
      found.push(relative(REPO_ROOT, full).split(sep).join('/'));
    }
  }
  return found;
}

const FILES = ROOTS.flatMap((root) => sourceFiles(join(REPO_ROOT, root)));

function parse(file: string): ts.SourceFile {
  const text = readFileSync(join(REPO_ROOT, file), 'utf8');
  return ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true);
}

/**
 * True for a file that touches the environment at all.
 *
 * The shared helpers count. `src/config/env.ts` is the repository's own way
 * to read a required variable, and a module whose only access is
 * `requiredEnv('X')` never contains the words `process.env` — so the filter
 * skipped it before either scan ran, and a variable read that way was
 * undocumented with the suite green.
 */
function touchesEnv(file: string): boolean {
  const text = readFileSync(join(REPO_ROOT, file), 'utf8');
  return new RegExp(`process\\.env|NodeJS\\.ProcessEnv|${SHARED_HELPERS.join('|')}`).test(text);
}

/** `process.env`, in either spelling. */
function isProcessEnv(node: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === 'process'
    && node.name.text === 'env'
  );
}

/** Every candidate name in one file: the net that must not have holes. */
function coarseNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    // A template literal with no substitution is not a `StringLiteral`, and
    // `env[`X`]` is legal TypeScript that read a variable this scan could
    // not see.
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      && LOOKS_LIKE_A_NAME.test(node.text)
    ) names.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

/**
 * The names this file certainly reads, for attribution.
 *
 * Resolves a name held in a constant, and calls to the shared helpers or to
 * a local one — a function whose body indexes an environment object, or
 * calls something that does. The transitive step is what reaches `port` in
 * `src/adapters/imap-smtp.ts`, which only ever calls `required`.
 */
function preciseNames(source: ts.SourceFile): Set<string> {
  const constants = new Map<string, string>();
  const collect = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
      && node.initializer !== undefined && ts.isStringLiteral(node.initializer)
    ) constants.set(node.name.text, node.initializer.text);
    ts.forEachChild(node, collect);
  };
  collect(source);

  const indexesEnv = (node: ts.Node): boolean => {
    let found = false;
    const walk = (inner: ts.Node): void => {
      if (ts.isElementAccessExpression(inner)) {
        const target = inner.expression;
        if ((ts.isIdentifier(target) && target.text === 'env') || isProcessEnv(target)) found = true;
      }
      ts.forEachChild(inner, walk);
    };
    walk(node);
    return found;
  };

  // Grow the helper set until it stops growing, so a helper that only calls
  // another helper is one too.
  const helpers = new Set(SHARED_HELPERS);
  const bodies = new Map<string, ts.Node>();
  const named = (node: ts.Node): void => {
    if ((ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node))
      && node.name !== undefined && ts.isIdentifier(node.name)) {
      const body = ts.isVariableDeclaration(node) ? node.initializer : node;
      if (body !== undefined) bodies.set(node.name.text, body);
    }
    ts.forEachChild(node, named);
  };
  named(source);
  for (const [name, body] of bodies) if (indexesEnv(body)) helpers.add(name);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, body] of bodies) {
      if (helpers.has(name)) continue;
      let calls = false;
      const walk = (inner: ts.Node): void => {
        if (ts.isCallExpression(inner) && ts.isIdentifier(inner.expression)
          && helpers.has(inner.expression.text)) calls = true;
        ts.forEachChild(inner, walk);
      };
      walk(body);
      if (calls) { helpers.add(name); grew = true; }
    }
  }

  const names = new Set<string>();
  const add = (text: string): void => { if (LOOKS_LIKE_A_NAME.test(text)) names.add(text); };
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && isProcessEnv(node.expression)) add(node.name.text);
    if (ts.isElementAccessExpression(node)) {
      const target = node.expression;
      const argument = node.argumentExpression;
      if ((ts.isIdentifier(target) && target.text === 'env') || isProcessEnv(target)) {
        if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
          add(argument.text);
        } else if (ts.isIdentifier(argument) && constants.has(argument.text)) {
          add(constants.get(argument.text)!);
        }
      }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && helpers.has(node.expression.text)) {
      for (const argument of node.arguments) {
        if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
          add(argument.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

const CANDIDATES = new Map<string, string[]>();
const PRECISE = new Map<string, string[]>();
for (const file of FILES) {
  if (!touchesEnv(file)) continue;
  const source = parse(file);
  for (const name of coarseNames(source)) {
    CANDIDATES.set(name, [...(CANDIDATES.get(name) ?? []), file]);
  }
  for (const name of preciseNames(source)) {
    PRECISE.set(name, [...(PRECISE.get(name) ?? []), file]);
  }
}

/** Every name the example declares, commented out or not. */
function documented(): Set<string> {
  const names = new Set<string>();
  for (const line of readFileSync(join(REPO_ROOT, EXAMPLE), 'utf8').split('\n')) {
    const found = /^#?\s*([A-Z][A-Z0-9_]*)=/.exec(line);
    if (found !== null) names.add(found[1]!);
  }
  return names;
}

describe('.env.example', () => {
  it('scanned both packages, so an empty missing list means something', () => {
    expect(FILES.length).toBeGreaterThan(100);
    expect(FILES).toContain('src/db/config.ts');
    expect(FILES.some((file) => file.startsWith('console/src/'))).toBe(true);
    // A scan that resolved nothing would pass every case below.
    expect(CANDIDATES.size).toBeGreaterThan(40);
    expect(documented().size).toBeGreaterThan(40);
  });

  it('reaches the reads no simple rule finds', () => {
    // The three shapes that defeated the first version of this guard. Each
    // is asserted by name, so narrowing the scan later fails here rather
    // than quietly reducing what it covers.
    expect([...PRECISE.keys()]).toContain('AURACLE_ALLOW_COMPOSE_DEFAULT'); // a constant
    expect([...PRECISE.keys()]).toContain('ACTION_CLASS'); // an `env` parameter
    expect([...PRECISE.keys()]).toContain('SMTP_PORT'); // a helper calling a helper
    expect([...CANDIDATES.keys()]).toContain('GOLD_FIT_PATH'); // a frozen record
  });

  it('refuses a variable name it cannot resolve', () => {
    // Fails closed. The alternative is resolving concatenation, which
    // needs constant folding and still loses to a name built at runtime.
    const fragments = [...CANDIDATES.keys()].filter((name) => LOOKS_BUILT.test(name));
    expect(
      fragments.map((name) => `${name} (in ${CANDIDATES.get(name)!.join(', ')})`),
      'a variable name looks assembled from pieces; this scan cannot say what it is',
    ).toEqual([]);
  });

  it('names every variable a process reads', () => {
    const known = documented();
    const missing = [...CANDIDATES.keys()]
      .filter((name) => !known.has(name) && !NOT_A_VARIABLE.has(name))
      .map((name) => `${name} (in ${CANDIDATES.get(name)!.join(', ')})`)
      .sort();
    expect(missing).toEqual([]);
  });

  it('documents nothing a process does not read', () => {
    // The other direction. A renamed variable leaves its old name behind,
    // and an operator sets it and wonders why nothing changed.
    const stale = [...documented()]
      .filter((name) => !CANDIDATES.has(name) && !NOT_READ_BY_A_PROCESS.has(name))
      .sort();
    expect(stale).toEqual([]);
  });

  it('keeps the other hatch honest too', () => {
    // `NOT_A_VARIABLE` has a liveness case below and this set had none, so
    // a name could be listed here forever after the thing that read it was
    // deleted. Each entry must still be documented — that is the whole
    // reason it is listed — and must still appear somewhere the scan does
    // not reach: the compose files, or the test harness.
    const known = documented();
    const reachable = [
      readFileSync(join(REPO_ROOT, 'docker-compose.yml'), 'utf8'),
      readFileSync(join(REPO_ROOT, 'docker-compose.dev.yml'), 'utf8'),
      ...sourceFiles(join(REPO_ROOT, 'src', 'test-support'))
        .map((file) => readFileSync(join(REPO_ROOT, file), 'utf8')),
    ].join('\n');
    for (const name of NOT_READ_BY_A_PROCESS) {
      expect(known, `${name} is hatched but not documented`).toContain(name);
      expect(reachable, `${name} is hatched and nothing reads it any more`).toContain(name);
    }
    expect(NOT_READ_BY_A_PROCESS.size).toBeLessThan(13);
  });

  it('holds no name that is obviously not a variable', () => {
    // The escape hatch must stay small and stay used. An entry that no
    // longer appears in the source is one nobody would notice going stale.
    for (const name of NOT_A_VARIABLE) {
      expect(CANDIDATES.has(name), `${name} is listed but no longer appears`).toBe(true);
    }
    expect(NOT_A_VARIABLE.size).toBeLessThan(12);
  });

  it('gives the credentials no value', () => {
    // A committed example is a template, and a template with a filled-in
    // credential is one route a secret takes into a repository.
    const text = readFileSync(join(REPO_ROOT, EXAMPLE), 'utf8');
    // Credentials, and the DEC-18 PII-shaped values beside them. The PII
    // hook is absolute only inside `fixtures/` and `evals/cases/`; here it
    // warns, so a real support address filled in as an example would ship.
    for (const secret of ['OPENROUTER_API_KEY', 'IMAP_PASS', 'WEBHOOK_SECRET',
      'FREESCOUT_API_KEY', 'SMTP_HOST', 'EMAIL_FROM_ADDRESS',
      'CORPUS_AGENT_ADDRESSES', 'IMAP_USER', 'IMAP_HOST', 'FREESCOUT_BASE_URL']) {
      const found = new RegExp(`^#?\\s*${secret}=(.*)$`, 'm').exec(text);
      expect(found, `${secret} is absent from ${EXAMPLE}`).not.toBeNull();
      expect(found![1]!.trim(), `${secret} carries a value`).toBe('');
    }
  });
});
