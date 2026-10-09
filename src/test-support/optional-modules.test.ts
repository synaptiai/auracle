// What a run is told when the throwaway-container packages are absent.
//
// `testcontainers` and `@testcontainers/postgresql` are development
// dependencies. `pnpm install --prod` resolves neither, and the 95 packages
// they reach go with them. A run that names DATABASE_URL and MAIL_HOST never
// loads either one.
//
// A run that names neither does, and the message it gets is the whole of what
// this file asserts. A static import would have failed the `db` and `mail`
// projects at import time with a module-resolution error, which says nothing
// about what to do — and this repository has shipped a refusal whose
// remediation advice was impossible, so the advice is checked here too.
//
// Pure. The loader lives in a module that imports nothing, so this suite
// needs no database — which is what it asserts about. Held inside
// `containers.ts` it made this a `.db.test.ts` that touched no database, and
// `purity.test.ts` refused it, correctly.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadOptional } from './optional-modules.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The refusal, as a reader of a failed run sees it. */
async function refusal(specifier: string, variable: string): Promise<string> {
  return loadOptional(specifier, () => Promise.reject(new Error('absent')), variable).then(
    () => '',
    (error: unknown) => (error as Error).message,
  );
}

describe('the optional container packages', () => {
  it('hands back the module when it loads', async () => {
    const loaded = await loadOptional(
      'a-module-that-loads',
      () => Promise.resolve({ marker: 'loaded' }),
      'DATABASE_URL',
    );

    expect(loaded).toEqual({ marker: 'loaded' });
  });

  it('names the package, the variable and both ways out when it does not', async () => {
    const failed = await loadOptional(
      '@testcontainers/postgresql',
      () => Promise.reject(new Error("Cannot find package '@testcontainers/postgresql'")),
      'DATABASE_URL',
    ).then(
      () => null,
      (error: unknown) => error as Error,
    );

    expect(failed, 'an absent package was not refused').not.toBeNull();
    const message = failed!.message;
    // The package, so a reader knows which install is missing.
    expect(message).toContain('@testcontainers/postgresql');
    // The variable that avoids needing it at all.
    expect(message).toContain('DATABASE_URL');
    // Both ways out, and both of them work. The command names the profile,
    // because GreenMail sits behind one and advice that does not start the
    // server it promises is worse than no advice.
    expect(message).toContain('docker compose --profile test up -d');
    expect(message).toContain('pnpm install');
    // And what the loader actually saw, rather than a message that replaces it.
    expect(message).toContain("Cannot find package '@testcontainers/postgresql'");
  });

  // A real `import()` of a specifier that does not resolve, rather than a
  // hand-rolled rejection. Nothing else here proves the shape of failure this
  // exists for is the shape it catches.
  it('refuses a specifier that genuinely does not resolve', async () => {
    // The specifier is built rather than written, because the compiler
    // resolves a literal `import()` at type-check time and refuses a package
    // that is not installed — which is the whole point of this case.
    const absent = ['@testcontainers', 'a-package-that-is-not-installed'].join('/');
    const failed = await loadOptional(
      absent,
      () => import(/* @vite-ignore */ absent),
      'DATABASE_URL',
    ).then(() => null, (error: unknown) => error as Error);

    expect(failed, 'an unresolvable specifier was not refused').not.toBeNull();
    expect(failed!.message).toContain(absent);
    expect(failed!.message).toContain('DATABASE_URL');
  });

  // The advice, checked against the file that has to make it true. Asserting
  // the sentence contains a command only pins that someone wrote a command —
  // and this repository has shipped a refusal whose advice was impossible.
  it('names a command the compose file actually answers', async () => {
    const message = await refusal('testcontainers', 'MAIL_HOST');
    const compose = readFileSync(`${REPO_ROOT}docker-compose.yml`, 'utf8');

    // The message says `--profile test`, so the file must gate a service on
    // exactly that profile, and that service must be the mail server.
    expect(message).toContain('docker compose --profile test up -d');
    expect(compose).toMatch(/^ {2}mail:$/m);
    expect(compose).toMatch(/profiles: \[test\]/);
    // And the ledger must NOT be gated, because the message promises the one
    // command starts both.
    const db = compose.slice(compose.indexOf('  db:'), compose.indexOf('  mail:'));
    expect(db, 'the ledger is behind a profile the advice does not name')
      .not.toContain('profiles:');
  });

  it('names MAIL_HOST for the mail server, not the database variable', async () => {
    const failed = await loadOptional(
      'testcontainers',
      () => Promise.reject(new Error('absent')),
      'MAIL_HOST',
    ).then(() => null, (error: unknown) => error as Error);

    expect(failed!.message).toContain('MAIL_HOST');
    expect(failed!.message).not.toContain('DATABASE_URL');
  });
});
