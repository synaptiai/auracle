import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each run gets its own throwaway pgvector Postgres, started once here
    // before workers fork (see src/test-support/global-setup.ts); its URI is
    // injected as DATABASE_URL per test file by src/test-support/db-url.setup.ts.
    globalSetup: ['./src/test-support/global-setup.ts'],
    setupFiles: ['./src/test-support/db-url.setup.ts'],
    // Suites still truncate tables between cases within a run; running test
    // files in parallel corrupts their results.
    fileParallelism: false,
  },
});
