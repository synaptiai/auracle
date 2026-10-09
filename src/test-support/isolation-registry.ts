// A record of which database each test file was given.
//
// Isolation is the property this run depends on, and it is the one a green
// run cannot demonstrate: thirty files sharing one database pass most of the
// time, and the day they do not, the failure reads as a flake in whatever
// suite happened to lose. Pointing every file at a single clone shows it: the
// per-file guard stays green while a DEC-28 fencing-epoch case breaks in the
// suite next door.
//
// So each file appends the database it received, and the run's teardown
// asserts the set. That is a claim no single file can make about itself.
//
// One line per test file, naming the database it was given and the file that
// was given it.
//
// The path was left out at first, because `expect.getState().testPath` is
// empty at a setup file's module scope. It is populated inside a hook the
// setup registers, which is where this records now — and the difference
// matters. Counting lines alone caught two files that each recorded the same
// database, and could not catch a setup that stopped running for some files
// at all: fewer lines and no duplicate reads exactly like a smaller run. With
// the path, a database that served two files is two lines naming it however
// the setup was evaluated, because the hook runs per file whatever the module
// registry did.
import { appendFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function registryPath(runId: string): string {
  return path.join(tmpdir(), `auracle-run-${runId}.txt`);
}

/**
 * Records the database one test file was given. Called once per file, from a
 * hook, so the file's own path is available.
 */
export function recordDatabase(runId: string, database: string, testFile: string): void {
  mkdirSync(path.dirname(registryPath(runId)), { recursive: true });
  // Tab-separated: a database name cannot hold one, and a path on the
  // platforms this runs on does not either.
  appendFileSync(registryPath(runId), `${database}\t${testFile}\n`);
}

export interface IsolationReport {
  /** How many test files asked for a database. */
  handouts: number;
  /** How many distinct databases were handed out. */
  databases: number;
  /** Databases given to more than one file, with the files that got them. */
  shared: { database: string; files: string[] }[];
}

/** Reads the record back and finds any database handed to more than one file. */
export function readIsolation(runId: string): IsolationReport {
  let raw = '';
  try {
    raw = readFileSync(registryPath(runId), 'utf8');
  } catch {
    return { handouts: 0, databases: 0, shared: [] };
  }
  const byDatabase = new Map<string, Set<string>>();
  let handouts = 0;
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    handouts += 1;
    const [database = '', file = ''] = line.split('\t');
    const files = byDatabase.get(database) ?? new Set<string>();
    // A set, not a count. One file recording twice is a hook that ran twice,
    // which is not the failure this looks for; two files on one database is.
    files.add(file);
    byDatabase.set(database, files);
  }
  const shared = [...byDatabase.entries()]
    .filter(([, files]) => files.size > 1)
    .map(([database, files]) => ({ database, files: [...files].sort() }));
  return { handouts, databases: byDatabase.size, shared };
}

/**
 * Fails the run when any database served more than one file.
 *
 * Called from the global teardown, which vitest runs after every file has
 * finished, so this is the one place that can see the whole set.
 *
 * There is no floor on the number of files. Running one file on purpose is
 * ordinary, and a check that failed a targeted run would be a false alarm
 * every time someone debugged a single suite. The floor that matters is that
 * something was recorded at all: a setup file that stopped running would hand
 * out no databases and leave nothing to compare.
 */
export function assertIsolation(runId: string): void {
  const report = readIsolation(runId);
  if (report.handouts === 0) {
    throw new Error(
      'no test file recorded a database, so per-file isolation is unproven '
        + 'rather than merely unobserved. src/test-support/db-url.setup.ts is '
        + 'what records one, and it runs once per file.',
    );
  }
  if (report.shared.length > 0) {
    const detail = report.shared
      .map((row) => `${row.database} served ${row.files.length} files (${row.files.join(', ')})`)
      .join('; ');
    throw new Error(
      `database isolation is broken: ${detail}. Files that share a database `
        + `truncate each other's rows between cases, which is the `
        + `order-dependent flake per-file clones exist to remove.`,
    );
  }
}

/** Removes the record. */
export function clearIsolation(runId: string): void {
  rmSync(registryPath(runId), { force: true });
}
