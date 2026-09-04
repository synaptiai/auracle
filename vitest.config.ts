import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each run gets its own throwaway pgvector Postgres, started once here
    // before workers fork (see src/test-support/global-setup.ts); its URI is
    // injected as DATABASE_URL per test file by src/test-support/db-url.setup.ts.
    // Only this checkout's suites. The Agent tool creates a worktree under
    // .claude/worktrees/ for a subagent working in parallel, and that holds a
    // second full checkout. Without this the runner collected both trees: the
    // file and case counts roughly doubled, and the two copies of the
    // end-to-end mail suite raced for the one GreenMail server the global
    // setup starts, so one of them failed on a mailbox the other had emptied.
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/worktrees/**'],
    globalSetup: ['./src/test-support/global-setup.ts'],
    setupFiles: ['./src/test-support/db-url.setup.ts'],
    // Suites still truncate tables between cases within a run; running test
    // files in parallel corrupts their results.
    fileParallelism: false,
    // The end-to-end hooks apply DDL and truncate against containers that
    // may have just started; the 10s default is too tight on a loaded host.
    hookTimeout: 60_000,
    // The same reason, for the cases themselves. The hooks were raised and
    // the cases were not, so a database suite that ran two consumers
    // concurrently failed on a loaded host at 5s while taking 7s of real
    // work. That looked like flakiness and was this line.
    testTimeout: 30_000,
  },
});
