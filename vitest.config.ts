import { defineConfig } from 'vitest/config';

import {
  MAIL_SUITES,
  NO_DATABASE_URL,
  SHARED_EXCLUDE,
} from './src/test-support/projects.js';

// Three projects, split by what a suite needs to run.
//
// `unit` needs nothing. No global setup, no setup files, no Docker socket: a
// contributor or a cloud agent without a Docker daemon runs `pnpm run
// test:unit` and gets every pure case, in parallel, in seconds. This is the
// reason for the split. One `globalSetup` used to cover every file, so the
// 1,300-odd pure cases could not run at all without a container.
//
// `db` needs Postgres. `mail` needs Postgres and a GreenMail server. They are
// separate projects so `pnpm run test:db` does not wait on a JVM that only the
// two end-to-end mail suites use. Both global setups call the same memoised
// helpers in src/test-support/containers.ts and share one Postgres container.
//
// Note the scope: on a combined `pnpm test`, vitest completes every project's
// global setup before it runs any file, so the mail server's start is on the
// critical path there whichever project owns it. The saving is real for
// `test:unit` and `test:db`, which is where the inner loop lives.
//
// The patterns come from src/test-support/projects.ts so the config and
// src/test-support/purity.test.ts cannot disagree about which project owns a
// file.
export default defineConfig({
  test: {
    // The end-to-end hooks apply DDL and truncate against containers that
    // may have just started; the 10s default is too tight on a loaded host.
    hookTimeout: 60_000,
    // The same reason, for the cases themselves. The hooks were raised and
    // the cases were not, so a database suite that ran two consumers
    // concurrently failed on a loaded host at 5s while taking 7s of real
    // work. That looked like flakiness and was this line.
    testTimeout: 30_000,
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: [...SHARED_EXCLUDE, 'src/**/*.db.test.ts'],
          // The suffix rule is static, and a static rule cannot see a suite
          // that connects through a helper. Such a suite would otherwise find
          // DATABASE_URL unset, take the compose default from src/db/config.ts
          // and pass green against the developer's own ledger — or against the
          // service Postgres that tests.yml exports to the whole run. This
          // points it at a port that refuses, so it fails where it stands.
          env: { DATABASE_URL: NO_DATABASE_URL },
          hookTimeout: 60_000,
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'db',
          include: ['src/**/*.db.test.ts'],
          exclude: [...SHARED_EXCLUDE, ...MAIL_SUITES],
          globalSetup: ['./src/test-support/db-global-setup.ts'],
          setupFiles: ['./src/test-support/db-url.setup.ts'],
          // Files run in parallel. They truncate tables between cases, which
          // is why this project ran one file at a time until issue #68 —
          // src/test-support/db-url.setup.ts now clones the migrated template
          // into a database of each file's own, so no two files share one.
          hookTimeout: 60_000,
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'mail',
          include: MAIL_SUITES,
          exclude: SHARED_EXCLUDE,
          globalSetup: ['./src/test-support/mail-global-setup.ts'],
          setupFiles: ['./src/test-support/db-url.setup.ts'],
          // Both suites drive the one GreenMail server and own mailboxes on
          // it; running them at once races for the same mail.
          poolOptions: { forks: { singleFork: true, isolate: true } },
          hookTimeout: 60_000,
          testTimeout: 30_000,
        },
      },
    ],
  },
});
