import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests share one Postgres database and truncate tables
    // between cases; running test files in parallel corrupts their results.
    fileParallelism: false,
  },
});
