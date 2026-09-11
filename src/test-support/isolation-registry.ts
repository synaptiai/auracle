// A record of which database each test file was given.
//
// Isolation is the property this run depends on, and it is the one a green
// run cannot demonstrate: thirty files sharing one database pass most of the
// time, and the day they do not, the failure reads as a flake in whatever
// suite happened to lose. Adversarial review made that concrete — it pointed
// every file at a single clone, and the per-file guard stayed green while a
// DEC-28 fencing-epoch case broke in the suite next door.
//
// So each file appends the database it received, and the run's teardown
// asserts the set. That is a claim no single file can make about itself.
//
// One line per setup invocation, and the setup runs exactly once per test
// file. So the line count is the file count, and two lines naming one
// database means two files shared it. The file's own path is deliberately not
// used: `expect.getState().testPath` is not populated inside a setup file,
// and recording `unknown` for every file made the check look like it had
// nothing to compare.
import { appendFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function registryPath(runId: string): string {
  return path.join(tmpdir(), `auracle-run-${runId}.txt`);
}

/** Records one database handed out. Called once per test file. */
export function recordDatabase(runId: string, database: string): void {
  mkdirSync(path.dirname(registryPath(runId)), { recursive: true });
  appendFileSync(registryPath(runId), `${database}\n`);
}

export interface IsolationReport {
  /** How many test files asked for a database. */
  handouts: number;
  /** How many distinct databases were handed out. */
  databases: number;
  /** Databases given to more than one file, with the count. */
  shared: { database: string; files: number }[];
}

/** Reads the record back and finds any database handed to more than one file. */
export function readIsolation(runId: string): IsolationReport {
  let raw = '';
  try {
    raw = readFileSync(registryPath(runId), 'utf8');
  } catch {
    return { handouts: 0, databases: 0, shared: [] };
  }
  const counts = new Map<string, number>();
  let handouts = 0;
  for (const line of raw.split('\n')) {
    const name = line.trim();
    if (name === '') continue;
    handouts += 1;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const shared = [...counts.entries()]
    .filter(([, files]) => files > 1)
    .map(([database, files]) => ({ database, files }));
  return { handouts, databases: counts.size, shared };
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
      .map((row) => `${row.database} served ${row.files} files`)
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
