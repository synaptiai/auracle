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

  // The latency CLI is the third of this class. `latency.test.ts` imports it
  // for `parseSince` and `excluded`, which is exactly the shape this suite's
  // header describes. Unguarded, that import would open a pool and query the
  // ledger inside the test process.
  //
  // `humanMs` was the other reason for that import until a cleanup moved it to
  // `src/latency/format.ts`, which is pure. The guard still matters, because
  // the two argument parsers stayed here.
  //
  // The observable is the catch handler, as in the induction case above, and
  // not a written artifact. A first version watched the artifact directory
  // after 250 milliseconds; a database round trip does not finish inside that
  // window, so removing the guard left the case green and it proved nothing.
  // The argument the case now supplies is refused before any pool is built,
  // which the handler reports inside the window and without a database.
  it('does not start the latency report', async () => {
    // The observable must touch nothing another suite reads. An earlier
    // version pointed DATABASE_URL at a closed port. That is shared state:
    // a worker runs many suites in turn, and each builds its pool from the
    // same variable. A suite that ran after this one would have connected to
    // a closed port through no fault of its own.
    //
    // `--since` with no value is read by this CLI alone. An unguarded main()
    // reports it and returns before it constructs a pool, so the case is
    // decided without a database at all, and no later suite can see it.
    const savedArgv = process.argv;
    const savedExit = process.exitCode;
    process.argv = [...savedArgv, '--since'];
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await import('../latency/run.js');
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(errors, 'importing the latency CLI ran the job').not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
      process.argv = savedArgv;
      process.exitCode = savedExit;
    }
  });
  // The fourth of this class. `bands.test.ts` imports this CLI for `parseDay`
  // and `bandLine`, which is the shape this suite's header describes:
  // unguarded, that import would open a pool and query the ledger inside the
  // test process.
  //
  // `humanValue` and `lastCompleteDay` were also reasons for that import until
  // a cleanup moved them to `src/bands/format.ts` and `src/time/day.ts`. Both
  // are pure now, and the two that stayed keep the guard load-bearing.
  //
  // The observable is `--day` with no value, which this CLI alone reads and
  // which is refused before any pool is built. It touches no shared state, so
  // no later suite in this worker can see it.
  it('does not start the control-band report', async () => {
    const savedArgv = process.argv;
    const savedExit = process.exitCode;
    process.argv = [...savedArgv, '--day'];
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await import('../bands/run.js');
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(errors, 'importing the bands CLI ran the job').not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
      process.argv = savedArgv;
      process.exitCode = savedExit;
    }
  });

  // The fifth of this class. `cli.test.ts`
  // imports this module for its parsers and its outcome sentences, which is
  // the shape this suite's header describes: unguarded, that import opens a
  // pool and queries the roster inside the test process.
  //
  // The rule it needs is `startedAsCommand`, not a local suffix test on
  // `process.argv[1]`. The two differ exactly where a linked path runs
  // nothing and exits 0.
  //
  // The observable is a printed line rather than a fault, because every path
  // through this command prints: the roster, what it changed, or why it
  // refused. So the case spies on both streams. Watching an error alone would
  // hold vacuously where the ledger answers, which is the trap the latency
  // case's comment describes.
  it('does not start the reviewer roster command', async () => {
    const savedExit = process.exitCode;
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await import('../reviewers/cli.js');
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(out, 'importing the reviewers CLI ran the command').not.toHaveBeenCalled();
      expect(errors, 'importing the reviewers CLI ran the command').not.toHaveBeenCalled();
    } finally {
      out.mockRestore();
      errors.mockRestore();
      process.exitCode = savedExit;
    }
  });
});
