// What the isolation record can and cannot see.
//
// The property is "every test file got a database of its own", and no single
// file can check it about itself. The run's teardown reads the record back.
//
// The record used to hold the database alone, one line per evaluation of
// `db-url.setup.ts`. That caught two files that each recorded the same
// database. It could not catch a setup that stopped running per file: fewer
// lines and no duplicate reads exactly like a smaller run, and a targeted run
// of one file is ordinary, so there is no floor to compare against.
//
// It holds the file's path now, recorded from a hook where
// `expect.getState().testPath` is populated. Two files on one database are
// two lines naming it however the module registry behaved.
import { afterEach, describe, expect, it } from 'vitest';

import { assertIsolation, clearIsolation, readIsolation, recordDatabase } from './isolation-registry.js';

const runIds: string[] = [];

function freshRun(): string {
  const runId = `test-${Math.random().toString(36).slice(2, 10)}`;
  runIds.push(runId);
  return runId;
}

afterEach(() => {
  for (const runId of runIds.splice(0)) clearIsolation(runId);
});

describe('the isolation record', () => {
  it('reads back one database per file', () => {
    const runId = freshRun();
    recordDatabase(runId, 'db_a', '/repo/src/one.db.test.ts');
    recordDatabase(runId, 'db_b', '/repo/src/two.db.test.ts');

    const report = readIsolation(runId);

    expect(report.handouts).toBe(2);
    expect(report.databases).toBe(2);
    expect(report.shared).toEqual([]);
    expect(() => assertIsolation(runId)).not.toThrow();
  });

  it('names the files when one database served two', () => {
    const runId = freshRun();
    recordDatabase(runId, 'db_shared', '/repo/src/one.db.test.ts');
    recordDatabase(runId, 'db_shared', '/repo/src/two.db.test.ts');

    expect(() => assertIsolation(runId)).toThrow(/isolation is broken/);
    // The paths, not just a count. An operator reading this needs to know
    // which two suites were corrupting each other.
    expect(() => assertIsolation(runId)).toThrow(/one\.db\.test\.ts/);
    expect(() => assertIsolation(runId)).toThrow(/two\.db\.test\.ts/);
  });

  // The case the database-only record could not see. A worker that evaluated
  // the setup once and ran two files with it recorded one line; now the hook
  // runs per file, so the second file records the database it actually used.
  it('sees a setup that ran once for two files', () => {
    const runId = freshRun();
    // What the old record held: one line, and nothing to compare it against.
    expect(() => assertIsolation(runId)).toThrow(/no test file recorded a database/);
    recordDatabase(runId, 'db_cached', '/repo/src/one.db.test.ts');
    expect(() => assertIsolation(runId)).not.toThrow();
    // What the hook records: the second file, on the same database.
    recordDatabase(runId, 'db_cached', '/repo/src/two.db.test.ts');
    expect(() => assertIsolation(runId)).toThrow(/isolation is broken/);
  });

  // One file recording twice is a hook that ran twice, which is not the
  // failure this looks for. Counting lines would have called it one.
  it('does not call one file recording twice a shared database', () => {
    const runId = freshRun();
    recordDatabase(runId, 'db_a', '/repo/src/one.db.test.ts');
    recordDatabase(runId, 'db_a', '/repo/src/one.db.test.ts');

    expect(readIsolation(runId).handouts).toBe(2);
    expect(() => assertIsolation(runId)).not.toThrow();
  });

  it('refuses a run where nothing was recorded at all', () => {
    const runId = freshRun();

    expect(readIsolation(runId)).toEqual({ handouts: 0, databases: 0, shared: [] });
    expect(() => assertIsolation(runId)).toThrow(/per-file isolation is unproven/);
  });
});
