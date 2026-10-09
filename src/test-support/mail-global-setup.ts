// Global setup for the `mail` project: the GreenMail server, and the same
// Postgres the `db` project uses.
//
// Both projects' global setups run in one Node process, so `ensurePostgres`
// returns the container the `db` project already started (or starts it, if
// this project runs alone). No other project asks for the mail server, so
// `pnpm run test:db` does not wait for it. A combined `pnpm test` still does:
// vitest completes every project's setup before it runs any file.
//
// A suite that starts its own server at module scope and guards itself with
// `describe.skipIf(!greenmail)` turns a container that fails to start into a
// green run. That is the failure mode the database probe removes. So each
// run starts one container, it must answer IMAP before any worker forks, and
// the suites do not guard themselves.
import type { TestProject } from 'vitest/node';

import { ensureMail, ensurePostgres, stopContainers } from './containers.js';
import { assertIsolation, clearIsolation } from './isolation-registry.js';
import { dropRunDatabases, newRunId, prepareTemplate } from './template-db.js';

let runId = '';

// Vitest hands the global setup its project, and `provide` is read from it.
export async function setup({ provide }: TestProject): Promise<void> {
  const adminUrl = await ensurePostgres();
  runId = newRunId();
  // One migrated template for this run; db-url.setup.ts clones it per file.
  await prepareTemplate(adminUrl, runId);
  clearIsolation(runId);
  provide('dbUrl', adminUrl);
  provide('dbRunId', runId);
  provide('mail', await ensureMail());
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
