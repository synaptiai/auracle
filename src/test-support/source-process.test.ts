// A process started from source settles in every way it can end, and its
// output reads back as the characters it wrote.
//
// A case that waits on `closed` would hang to its timeout if a failed spawn
// or a hung child never settled it, and would report a timeout instead of
// the cause.
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

import { startFromSource } from './source-process.js';

describe('startFromSource', () => {
  it('settles with the spawn error when the process cannot start', async () => {
    const missing = path.join(tmpdir(), 'auracle-no-such-directory-for-a-spawn');
    const run = startFromSource('src/kb/cli.ts', { cwd: missing, env: process.env });
    const ended = await run.closed;
    // The error path settles with no code. A close after it would carry one.
    expect(ended).toEqual({ code: null, signal: null });
    expect(run.stderr()).toContain('ENOENT');
  }, 10_000);

  it('reads a character split across two chunks as one character', async () => {
    const run = startFromSource('src/test-support/fixtures/split-utf8.ts', { cwd: tmpdir(), env: process.env });
    await run.closed;
    expect(run.stdout()).toBe('€\n');
  }, 10_000);

  // A process that ended reports no kill, however long its output stays open
  // and however long the case waits after it.
  it('reports no kill for a process that exits before its deadline', async () => {
    const run = startFromSource('src/test-support/fixtures/split-utf8.ts', { cwd: tmpdir(), env: process.env, deadlineMs: 500 });
    await run.closed;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(run.stderr()).not.toContain('outlived');
  }, 10_000);

  it('reports no kill for a process that exits while a child holds its output', async () => {
    const run = startFromSource('src/test-support/fixtures/hold-pipe.ts', { cwd: tmpdir(), env: process.env, deadlineMs: 500 });
    const ended = await run.closed;
    expect(ended.signal).toBeNull();
    expect(run.stderr()).not.toContain('outlived');
  }, 10_000);

  it('kills a process that outlives its deadline, and says so', async () => {
    const run = startFromSource('src/test-support/fixtures/hang.ts', { cwd: tmpdir(), env: process.env, deadlineMs: 1_000 });
    const ended = await run.closed;
    expect(ended.signal).toBe('SIGKILL');
    expect(run.stderr()).toContain('outlived its deadline of 1000 ms');
  }, 10_000);
});
