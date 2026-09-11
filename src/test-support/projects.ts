// The three projects' file patterns, in one place.
//
// `vitest.config.ts` builds its projects from these, and
// `src/test-support/purity.test.ts` checks the partition they describe. If the
// two restated the patterns separately, a suite could fall between them: the
// config would collect it nowhere and the guard would still pass.
//
// The `db` and `mail` split is the reason this file exists. `mail` is a
// hand-listed set, so a third mail suite that nobody adds here would be
// collected by `db`, where `provide('mail', ...)` never runs. `inject` returns
// `undefined` for a key no setup provided rather than throwing, so the suite
// would fail on a property read far from the cause. The guard asserts the list
// matches the files that actually call `inject('mail')`.

/** Files every project ignores. */
export const SHARED_EXCLUDE = [
  '**/node_modules/**',
  '**/dist/**',
  '.claude/worktrees/**',
  'console/**',
];

/** The suites that drive the GreenMail server. */
export const MAIL_SUITES = [
  'src/e2e/v1-email-flow.db.test.ts',
  'src/e2e/v1-imap-ingress.db.test.ts',
];

/**
 * A database the `unit` project cannot reach, and is not meant to.
 *
 * The suffix rule is a static check, and a static check cannot see a suite
 * that opens a connection through a helper. Without this, such a suite finds
 * `DATABASE_URL` unset, falls back to the compose default in
 * `src/db/config.ts`, and passes green against the developer's own ledger — or
 * against the service Postgres that `tests.yml` exports to the whole run. A
 * green pass is a worse failure than a connection refused, because nobody
 * reads it.
 *
 * Port 1 refuses immediately. So an accidental connection in a pure suite
 * fails fast, and it names this constant when it does.
 */
export const NO_DATABASE_URL = 'postgres://unit-project-must-not-open-a-connection@127.0.0.1:1/none';

/** True when the path is a database suite, by the AGENTS.md suffix rule. */
export function isDbSuite(file: string): boolean {
  return file.endsWith('.db.test.ts');
}

/** True when the path is a pure suite. */
export function isPureSuite(file: string): boolean {
  return file.endsWith('.test.ts') && !isDbSuite(file);
}

/** The project that owns a test file, by path alone. */
export function projectOf(file: string): 'unit' | 'db' | 'mail' {
  if (MAIL_SUITES.includes(file)) return 'mail';
  return isDbSuite(file) ? 'db' : 'unit';
}
