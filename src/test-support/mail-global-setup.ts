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

export async function setup({ provide }: GlobalSetupContext): Promise<void> {
  provide('dbUrl', await ensurePostgres());
  provide('mail', await ensureMail());
}

export async function teardown(): Promise<void> {
  await stopContainers();
}
