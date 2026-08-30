// Both CLIs run `main()` unless a guard stops them, and one of them is
// imported by a suite for its helpers. Without the guard, importing it
// executes the mailbox fetch command inside the test process.
//
// Cycle 5 extracted `startedAsCommand` so the guard could be tested, and
// tested the function while leaving both call sites it exists to serve
// uncovered. These cases cover the call sites: the wiring, not the rule.

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let dir: string;
let marker: string;
const saved = process.env['CORPUS_FETCH_CMD'];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'entry-guard-'));
  marker = join(dir, 'main-ran');
  // A fetch command whose only effect is observable. If `main()` runs on
  // import, the export shells out and this file appears.
  process.env['CORPUS_FETCH_CMD'] = `sh -c 'touch ${marker}; echo'`;
  vi.resetModules();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (saved === undefined) delete process.env['CORPUS_FETCH_CMD'];
  else process.env['CORPUS_FETCH_CMD'] = saved;
});

describe('a CLI module does not run when it is imported', () => {
  it('does not start the corpus export', async () => {
    await import('./export-main.js');
    // Give an unguarded main() its chance: the shell-out is asynchronous.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(existsSync(marker)).toBe(false);
  });

  it('does not start the taxonomy induction job', async () => {
    // CORPUS_PATH names a file that does not exist, so an unguarded main()
    // reaches loadCorpusFile and throws — before it constructs a provider,
    // so this observable can never cost a model call. The catch handler
    // then reports it, which is what the spy sees.
    process.env['CORPUS_PATH'] = 'corpus/does-not-exist-entry-guard.json';
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await import('../jobs/run-taxonomy-induction.js');
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
      delete process.env['CORPUS_PATH'];
    }
  });
});
