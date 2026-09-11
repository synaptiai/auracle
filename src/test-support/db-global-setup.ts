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

export async function setup({ provide }: GlobalSetupContext): Promise<void> {
  provide('dbUrl', await ensurePostgres());
}

export async function teardown(): Promise<void> {
  await stopContainers();
}
