import { defineConfig } from 'vitest/config';

// The console's own runner. The core suite excludes `console/**` so its file
// and case counts are the ones it reported before this package existed, which
// is what the console's first design asks for.
//
// No global setup and no container: every case here is pure. The console owns
// no SQL, so what there is to test is the rendering and the one write's
// delegation, and both take a stub.
//
// DATABASE_URL is pinned to an address that refuses, for the same reason the
// core's unit project pins one (src/test-support/projects.ts). CI exports a
// live URL for the whole `pnpm run verify` step, so without this a console
// case that opened a pool would reach the service Postgres and pass against
// it. No case does today. The point is that none can start to without saying
// so.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Both URLs: the readers connect through READER_DATABASE_URL, which the
    // runbook tells an operator to export in the shell.
    env: {
      DATABASE_URL: 'postgres://console-tests-must-not-connect@127.0.0.1:1/none',
      READER_DATABASE_URL: 'postgres://console-tests-must-not-connect@127.0.0.1:1/none',
    },
  },
});
