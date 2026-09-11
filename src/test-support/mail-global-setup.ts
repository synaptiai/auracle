// Global setup for the `mail` project: the GreenMail server, and the same
// Postgres the `db` project uses.
//
// Both projects' global setups run in one Node process, so `ensurePostgres`
// returns the container the `db` project already started (or starts it, if
// this project runs alone). No other project asks for the mail server, so
// `pnpm run test:db` does not wait for it. A combined `pnpm test` still does:
// vitest completes every project's setup before it runs any file.
//
// The two end-to-end mail suites used to start one server each, at module
// scope, and guard themselves with `describe.skipIf(!greenmail)`. A
// container that failed to start therefore produced a green run, the same
// failure mode the database probe removes. It is one container per run now,
// it must answer IMAP before any worker forks, and the suites no longer
// guard themselves.
import type { GlobalSetupContext } from 'vitest/node';

import { ensureMail, ensurePostgres, stopContainers } from './containers.js';
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
