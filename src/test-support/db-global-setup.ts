// Global setup for the `db` project: one Postgres, no mail server.
//
// This runs once before the workers fork, so concurrent `pnpm test`
// processes each get their own container and never contend on a shared
// database. The URI is handed to every worker through `provide` and
// published as DATABASE_URL per test file by db-url.setup.ts.
//
// GreenMail is not started here. It belongs to the `mail` project's setup,
// so the database suites in this project do not wait on a JVM.
import type { GlobalSetupContext } from 'vitest/node';

import { ensurePostgres, stopContainers } from './containers.js';
import { assertIsolation, clearIsolation } from './isolation-registry.js';
import { dropRunDatabases, newRunId, prepareTemplate } from './template-db.js';

let runId = '';

export async function setup({ provide }: GlobalSetupContext): Promise<void> {
  const adminUrl = await ensurePostgres();
  runId = newRunId();
  // One migrated template for this run; db-url.setup.ts clones it per file.
  await prepareTemplate(adminUrl, runId);
  clearIsolation(runId);
  provide('dbUrl', adminUrl);
  provide('dbRunId', runId);
}

export async function teardown(): Promise<void> {
  // Vitest runs this after every file, so it is the one place that can see
  // whether each file really got a database of its own.
  let isolation: Error | undefined;
  try {
    assertIsolation(runId);
  } catch (error) {
    isolation = error as Error;
  }
  // A reused container outlives the run, so this run's databases must not.
  try {
    await dropRunDatabases(await ensurePostgres(), runId);
  } catch {
    // The server may already be gone; the container teardown is what matters.
  }
  clearIsolation(runId);
  await stopContainers();
  if (isolation !== undefined) throw isolation;
}
