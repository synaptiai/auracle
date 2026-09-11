// The containers the suite needs, started at most once per `vitest run`.
//
// Vitest runs every project's `globalSetup` in one Node process, before any
// worker forks. So a module-scoped memo here is shared across projects: the
// `db` project and the `mail` project both ask for Postgres and both get the
// same container. Without the memo a local full run would start two.
//
// GreenMail is asked for by the `mail` project alone, so `pnpm run test:db`
// never waits for the JVM to answer IMAP and `pnpm run test:unit` never
// reaches this file at all. On a combined `pnpm test` the saving does not
// apply: vitest completes every project's global setup before it runs any
// file, so the mail server is on the critical path there whichever project
// owns it.
//
// Precedence for Postgres: an explicit DATABASE_URL in the environment wins.
// The run then targets that database directly and no container starts.
// Otherwise an ephemeral container is created and its URI is handed to the
// workers as DATABASE_URL (see db-url.setup.ts). Non-test code keeps the
// compose fallback in src/db/config.ts.
//
// An explicit DATABASE_URL is probed before it is handed out, and an
// unreachable one fails the run. Without that probe every database suite
// skips itself and the run still exits 0, so a stale URL turns roughly a
// quarter of the suite into a green no-op. Absent DATABASE_URL cannot lie: a
// container either starts or the run fails. Set but dead is the only case
// that can, so it is the only case this guard rejects.
//
// The durability flags below are test-only: data lives on tmpfs inside the
// Docker VM for the length of one run and is discarded afterwards.
//
// Set AURACLE_TEST_DB_REUSE=1 to keep one warm container across local runs
// instead of starting fresh each time, and AURACLE_TEST_MAIL_REUSE=1 for the
// mail server. Reuse stays off on CI; reused containers are exempt from Ryuk
// cleanup, so remove them by hand (`docker rm -f`) or set
// TESTCONTAINERS_REUSE_ENABLE=false to ignore the flag.
import { ImapFlow } from 'imapflow';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';

/** GreenMail's host, and the mapped SMTP and IMAP ports. */
export interface MailAddress {
  host: string;
  smtpPort: number;
  imapPort: number;
}

// Types the values the global setups provide and db-url.setup.ts injects.
// Without it both sides degrade to `never` and the handoff is unchecked.
declare module 'vitest' {
  interface ProvidedContext {
    dbUrl: string;
    mail: MailAddress;
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

// The memos. A promise rather than a value, so two callers that arrive
// before the first start resolves still share one container.
let postgres: Promise<string> | undefined;
let mail: Promise<MailAddress> | undefined;

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
        client.close();
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

async function startPostgres(): Promise<string> {
  const existing = process.env['DATABASE_URL'];
  if (existing !== undefined) {
    await assertReachable(existing);
    return existing;
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
  return container.getConnectionUri();
}

async function startMail(): Promise<MailAddress> {
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
  const address: MailAddress = {
    host: mailContainer.getHost(),
    smtpPort: mailContainer.getMappedPort(MAIL_SMTP_PORT),
    imapPort: mailContainer.getMappedPort(MAIL_IMAP_PORT),
  };
  await awaitMailReady(address.host, address.imapPort);
  return address;
}

/**
 * The ledger database for this run. Starts a container on the first call and
 * returns the same URI to every later caller, including a second project's
 * global setup.
 */
export function ensurePostgres(): Promise<string> {
  postgres ??= startPostgres();
  return postgres;
}

/** The GreenMail server for this run, started at most once. */
export function ensureMail(): Promise<MailAddress> {
  mail ??= startMail();
  return mail;
}

/**
 * Stops whatever was started. Safe to call from more than one project's
 * teardown: the second call finds nothing left to stop.
 *
 * Each stop is isolated and the reset is unconditional. Vitest awaits each
 * project's teardown in turn, so a throw here would abort the teardowns that
 * follow it and leave the GreenMail JVM to Ryuk. A container that will not
 * stop is worth reporting, but it is not worth stranding the others.
 */
export async function stopContainers(): Promise<void> {
  const faults: unknown[] = [];
  try {
    // stop() would also stop and remove a reused container; leave those running.
    if (!reuseEnabled && container !== undefined) {
      await container.stop();
    }
  } catch (error) {
    faults.push(error);
  }
  try {
    if (!mailReuseEnabled && mailContainer !== undefined) {
      await mailContainer.stop();
    }
  } catch (error) {
    faults.push(error);
  } finally {
    container = undefined;
    mailContainer = undefined;
    postgres = undefined;
    mail = undefined;
  }
  if (faults.length > 0) {
    const reasons = faults
      .map((fault) => (fault instanceof Error ? fault.message : String(fault)))
      .join('; ');
    throw new Error(`a test container did not stop cleanly: ${reasons}`);
  }
}
