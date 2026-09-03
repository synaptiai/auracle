// What the register says the run-timing columns are for.
//
// The migration added enqueued_at, created_at and finished_at so a latency
// report could be built. The register described that report in the present
// tense before one existed, and this suite refused every such sentence,
// because a register that names a component nobody wrote is worse than one
// that names none: a reader trusts it and goes looking.
//
// One now exists. So the rule inverts rather than lapsing. The register may
// name the report, and these cases hold it to the other half of the same
// bargain: the reader must exist, it must read the columns the register says
// it reads, and it must still not claim to correct anything. V2 open item 7
// asks for the data a correction needs, and stays open until one is chosen.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
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
  // The reader the register now names has to be there. This is the same rule
  // the suite always enforced, read from the other side: documentation and
  // implementation must agree about whether a component exists.
  it('names a reader that exists', () => {
    const register = readFileSync(`${REPO_ROOT}docs/v1-architecture.md`, 'utf8');
    expect(register).toContain('pnpm run latency');
    const script = JSON.parse(readFileSync(`${REPO_ROOT}package.json`, 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(script.scripts['latency']).toContain('dist/latency/run.js');
    expect(existsSync(`${REPO_ROOT}src/latency/run.ts`)).toBe(true);
  });

  // And it must read what the migration added. A reader that named the
  // columns in prose and selected something else would satisfy the case above
  // while leaving the loop exactly as open as it was.
  it('reads the three columns the migration added', () => {
    // Both comment syntaxes blanked, in this order. The file's prose names all
    // three columns, in JavaScript comments around the statement and in SQL
    // comments inside it. Stripping only the JavaScript ones still left
    // `-- db/005: queue wait = created_at - enqueued_at` behind, so the case
    // stayed green with the statement gutted to `SELECT partition` — which is
    // precisely the reader it exists to forbid. Falsified by that mutation.
    const code = readFileSync(`${REPO_ROOT}src/latency/query.ts`, 'utf8')
      .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
      .replace(/--[^\n]*/g, '');
    for (const column of ['enqueued_at', 'created_at', 'finished_at']) {
      expect(code, `the latency reader never reads ${column}`).toContain(column);
    }
  });

  // The open item asks for the data a correction needs, not for a correction.
  // A register sentence saying the delay is corrected would close an item that
  // is still open, on data this repository does not have.
  it('does not claim the delay is corrected', () => {
    // 'src' belongs here and was dropped when the guard inverted. The new
    // module is dense with prose about the limit, so the tree most likely to
    // acquire the claim was the one no longer read.
    const trees = ['docs', 'intent', 'db', 'src'];
    const claiming = trees
      .flatMap((tree) => shippedFiles(`${REPO_ROOT}${tree}`))
      .filter((path) => path !== SELF)
      .filter((path) =>
        readFileSync(path, 'utf8')
          .split('\n')
          .some((line) => /corrects the head-of-line|head-of-line delay is corrected/i.test(line)),
      )
      .map((path) => path.slice(REPO_ROOT.length));
    expect(claiming).toEqual([]);
  });

  it('still names the migration that adds the columns', () => {
    const register = readFileSync(`${REPO_ROOT}docs/v1-architecture.md`, 'utf8');
    expect(register).toContain('db/005_run_timing.sql');
  });
});
