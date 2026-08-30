// Where a job that derives its output from real history may write.
//
// Two CLIs need this answer: the corpus export and the taxonomy induction
// job. Both write artifacts built from real customer text — records, or
// labels a model wrote from real bodies and sample ids that are real
// Message-IDs. Both must land under `corpus/`, which the repository ignores
// (DEC-18).
//
// It lives here, apart from either CLI, because neither is importable: each
// runs `main()` at module load, so nothing can test them. A guard that was
// cloned from one to the other inherited the original's absence of tests,
// and both then rejected nothing that any case checked.

import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The path a job should write, or the reason it must not.
 *
 * `pnpm` forwards its own `--` separator to the script, so
 * `pnpm run export-corpus -- out.json` arrives as `['--', 'out.json']`.
 * Taken literally, a job wrote a file named `--` into the repository root
 * and reported it as gitignored. It was not.
 */
export function resolveCorpusOutput(
  argv: readonly string[],
  fallback: string,
  cwd: string = process.cwd(),
): { path: string } | { refusal: string } {
  const named = argv.filter((arg) => arg !== '--');
  const path = named[0] ?? fallback;
  const root = resolve(cwd, 'corpus') + sep;
  if (!resolve(cwd, path).startsWith(root)) {
    return {
      refusal:
        `this job writes under corpus/ only, got ${path} (DEC-18). That directory is `
        + 'gitignored, and the file it writes derives from real customer text.',
    };
  }
  return { path };
}

/**
 * Whether this module was started as a command, rather than imported.
 *
 * A CLI that runs `main()` at module load cannot be tested, so a guard added
 * to one of these files and cloned into the other was untestable in both.
 * The rule lives here, with a case, and each CLI calls it.
 *
 * It is load-bearing for the export: a suite imports that module for
 * `failureLines`, so without the guard `main()` would run during the test
 * run and shell out to whatever `CORPUS_FETCH_CMD` held.
 */
export function startedAsCommand(moduleUrl: string, argv1: string | undefined): boolean {
  if (argv1 === undefined) return false;
  return moduleUrl === pathToFileURL(argv1).href;
}
