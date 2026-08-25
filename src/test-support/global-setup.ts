// Vitest global setup: starts one throwaway pgvector Postgres per test run
// and provides its connection URI to every worker. This runs once before
// workers fork (unlike setupFiles, which run per test file), so concurrent
// `npm test` processes each get their own container and never contend on a
// shared database.
//
// Precedence: an explicit DATABASE_URL in the environment wins. The run then
// targets that database directly and no container starts. Otherwise an
// ephemeral container is created and its URI is injected as DATABASE_URL for
// the workers (see db-url.setup.ts). Non-test code keeps the compose fallback
// in src/db/config.ts.
//
// The durability flags below are test-only: data lives on tmpfs inside the
// Docker VM for the length of one run and is discarded afterwards.
//
// Set AURACLE_TEST_DB_REUSE=1 to keep one warm container across local runs
// instead of starting fresh each time. Reuse stays off on CI; reused
// containers are exempt from Ryuk cleanup, so remove them by hand
// (`docker rm -f`) or set TESTCONTAINERS_REUSE_ENABLE=false to ignore the flag.
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { GlobalSetupContext } from 'vitest/node';

const IMAGE = 'pgvector/pgvector:pg16';

let container: StartedPostgreSqlContainer | undefined;
let reuseEnabled = false;

export async function setup({ provide }: GlobalSetupContext): Promise<void> {
  const existing = process.env['DATABASE_URL'];
  if (existing !== undefined) {
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
}
