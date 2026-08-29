// Vitest global setup: starts the containers the suite needs, once per test
// run, and provides their addresses to every worker. This runs once before
// workers fork (unlike setupFiles, which run per test file), so concurrent
// `pnpm test` processes each get their own container and never contend on a
// shared database.
//
// Precedence: an explicit DATABASE_URL in the environment wins. The run then
// targets that database directly and no container starts. Otherwise an
// ephemeral container is created and its URI is injected as DATABASE_URL for
// the workers (see db-url.setup.ts). Non-test code keeps the compose fallback
// in src/db/config.ts.
//
// An explicit DATABASE_URL is probed before it is provided, and an unreachable
// one fails the run here. Without that probe every database suite skips itself
// and the run still exits 0, so a stale URL turns roughly a quarter of the
// suite into a green no-op. Absent DATABASE_URL cannot lie: a container either
// starts or the run fails. Set but dead is the only case that can, so it is
// the only case this guard rejects.
//
// The durability flags below are test-only: data lives on tmpfs inside the
// Docker VM for the length of one run and is discarded afterwards.
//
// A GreenMail server starts here too. The two end-to-end mail suites used to
// start one each, at module scope, and guard themselves with
// `describe.skipIf(!greenmail)`. A container that failed to start therefore
// produced a green run, the same failure mode the database probe removes. It
// is one container per run now, it must answer before any worker forks, and
// the suites no longer guard themselves.
//
// Set AURACLE_TEST_DB_REUSE=1 to keep one warm container across local runs
// instead of starting fresh each time. Reuse stays off on CI; reused
// containers are exempt from Ryuk cleanup, so remove them by hand
// (`docker rm -f`) or set TESTCONTAINERS_REUSE_ENABLE=false to ignore the flag.
import { ImapFlow } from 'imapflow';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import type { GlobalSetupContext } from 'vitest/node';

// Types the value this file provides and db-url.setup.ts injects. Without
// it both sides degrade to `never` and the handoff is unchecked.
declare module 'vitest' {
  interface ProvidedContext {
    dbUrl: string;
    /** GreenMail host, and the mapped SMTP and IMAP ports. */
    mail: { host: string; smtpPort: number; imapPort: number };
  }
}

const IMAGE = 'pgvector/pgvector:pg16';
const MAIL_IMAGE = 'greenmail/standalone:2.1.12';
/** GreenMail's in-container ports; the mapped ones are read at start. */
const MAIL_SMTP_PORT = 3025;
const MAIL_IMAP_PORT = 3143;

let container: StartedPostgreSqlContainer | undefined;
let mailContainer: StartedTestContainer | undefined;
let reuseEnabled = false;
let mailReuseEnabled = false;

/**
 * Fails the run when an externally supplied DATABASE_URL does not answer.
 *
 * A run of nothing but skipped suites still exits 0. That was the one way
 * this harness could report success while proving nothing, so an explicit
 * URL must answer here before any worker forks. The database suites rely on
 * this: they no longer guard themselves, because a database that this
 * function accepted and that later fails is a fault, not a skip.
 */
async function assertReachable(url: string): Promise<void> {
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `DATABASE_URL is set but unreachable, so every database suite would skip `
        + `and the run would still exit 0. Unset DATABASE_URL to use a throwaway `
        + `container, or start the database. Cause: ${reason}`,
    );
  } finally {
    await pool.end();
  }
}

/**
 * Waits until GreenMail answers IMAP, not merely until its port is open.
 *
 * `GenericContainer`'s default readiness is a port check. The JVM binds its
 * ports well before it can serve a mailbox, so a suite that started polling
 * immediately spent its delivery budget on a server that was not ready. This
 * moves that wait to setup, once, instead of into every suite's first assert.
 */
async function awaitMailReady(host: string, imapPort: number): Promise<void> {
  const deadline = Date.now() + 120_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const client = new ImapFlow({
      host,
      port: imapPort,
      secure: false,
      auth: { user: 'readiness@example.test', pass: 'synthetic-password' },
      logger: false,
    });
    try {
      await client.connect();
      await client.logout();
      return;
    } catch (error) {
      lastError = error;
      try {
        await client.close();
      } catch {
        // The probe failed before a usable connection existed.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `GreenMail started but never answered IMAP on ${host}:${imapPort}. `
      + `The mail suites would fail on a server that is not ready. Cause: ${reason}`,
  );
}

/** Starts the shared GreenMail server and returns its mapped address. */
async function startMail(): Promise<{ host: string; smtpPort: number; imapPort: number }> {
  let builder = new GenericContainer(MAIL_IMAGE)
    .withEnvironment({
      GREENMAIL_OPTS:
        '-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.auth.disabled',
    })
    .withExposedPorts(MAIL_SMTP_PORT, MAIL_IMAP_PORT)
    .withStartupTimeout(300_000);
  mailReuseEnabled = !process.env['CI'] && process.env['AURACLE_TEST_MAIL_REUSE'] === '1';
  if (mailReuseEnabled) {
    builder = builder.withReuse();
  }
  mailContainer = await builder.start();
  const address = {
    host: mailContainer.getHost(),
    smtpPort: mailContainer.getMappedPort(MAIL_SMTP_PORT),
    imapPort: mailContainer.getMappedPort(MAIL_IMAP_PORT),
  };
  await awaitMailReady(address.host, address.imapPort);
  return address;
}

export async function setup({ provide }: GlobalSetupContext): Promise<void> {
  provide('mail', await startMail());

  const existing = process.env['DATABASE_URL'];
  if (existing !== undefined) {
    await assertReachable(existing);
    provide('dbUrl', existing);
    return;
  }

  let builder = new PostgreSqlContainer(IMAGE)
    .withTmpFs({ '/var/lib/postgresql/data': 'rw' })
    // tmpfs covers the parent of PGDATA; the entrypoint creates the
    // subdirectory itself.
    .withEnvironment({ PGDATA: '/var/lib/postgresql/data/pgdata' })
    .withCommand([
      'postgres',
      '-c', 'fsync=off',
      '-c', 'synchronous_commit=off',
      '-c', 'full_page_writes=off',
    ])
    // Cold initdb can take well over a minute on Docker Desktop; the module
    // default of 120s is too tight.
    .withStartupTimeout(300_000);
  reuseEnabled = !process.env['CI'] && process.env['AURACLE_TEST_DB_REUSE'] === '1';
  if (reuseEnabled) {
    builder = builder.withReuse();
  }
  container = await builder.start();
  provide('dbUrl', container.getConnectionUri());
}

export async function teardown(): Promise<void> {
  // stop() would also stop and remove a reused container; leave those running.
  if (!reuseEnabled) {
    await container?.stop();
  }
  if (!mailReuseEnabled) {
    await mailContainer?.stop();
  }
}
