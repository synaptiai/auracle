// What the register says the run-timing columns are for.
//
// The migration added enqueued_at, created_at and finished_at so a latency
// report could be built. The register then described that report in the
// present tense, as a thing that reads the columns. No such report exists,
// and the columns have writers and no readers outside the tests.
//
// A register that names a component nobody wrote is worse than one that names
// none: a reader trusts it and looks for the report.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
/** This suite states the stale phrase, so it must not scan itself. */
const SELF = new URL(import.meta.url).pathname;

function shippedFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) shippedFiles(path, acc);
    else if (/\.(ts|md|sql)$/.test(entry)) acc.push(path);
  }
  return acc;
}

describe('the register on the run-timing columns', () => {
  it('claims no reader that does not exist, anywhere it ships', () => {
    // One file was not the class. An intent file from an earlier phase named
    // the same report twice as a thing people read, and a guard reading only
    // the register could not see it.
    const trees = ['docs', 'intent', 'src', 'db'];
    const naming = trees
      .flatMap((tree) => shippedFiles(`${REPO_ROOT}${tree}`))
      .filter((path) => path !== SELF)
      .filter((path) =>
        readFileSync(path, 'utf8')
          .split('\n')
          // A sentence reporting that the claim was made and withdrawn is
          // history, not an assertion, exactly as a decision row is.
          .filter((line) => !/claimed a latency report/i.test(line))
          .some((line) => /the latency report/i.test(line)),
      )
      .map((path) => path.slice(REPO_ROOT.length));
    expect(naming).toEqual([]);
  });

  it('still names the migration that adds the columns', () => {
    const register = readFileSync(`${REPO_ROOT}docs/v1-architecture.md`, 'utf8');
    expect(register).toContain('db/005_run_timing.sql');
  });
});
