// The directories that hold dated reasoning rather than current guidance.
//
// A guard that scans shipped documentation asks "does this document state a
// fact that is no longer true". That question is right for the runbook, the
// register and the README, and wrong for a record of why a decision was taken
// on the day it was taken. A design record describing a superseded state is
// still a record, and correcting it would be rewriting history rather than
// fixing a document (issue #79).
//
// `src/bands/bands.test.ts` reached this conclusion first, for
// `docs/decisions/`. Issue #79 moved eleven design documents out of a
// tool-named directory into `docs/design/`, which put them inside three more
// scans at once: the retired-model scan in `src/config/model-pin.test.ts`,
// the partition-key scan in `src/coordinator/partition-statement.test.ts`,
// and the baseline-claim scan in `bands.test.ts`. All three reported, and all
// three were right that the text says what they said it says.
//
// So the exclusion is named once, here, rather than spelled three times.
// A fourth guard that scans documents reads this list instead of learning the
// rule again.
//
// This is not a way to park a document a guard dislikes. Both directories
// hold records: `docs/decisions/` the ones written under the current rule,
// `docs/design/` the ones written before it, whose status the register's
// section 7.1 states. Shipped guidance — the runbook, the register, the
// README, AGENTS.md, CONTRIBUTING.md — is never in here.
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Directories of frozen records, relative to the repository root.
 *
 * `docs/design/console-canvas/` is deliberately absent. Its README gives live
 * instructions — edit a template, run the join — so it is guidance and belongs
 * inside the scans like any other shipped document. Only the records
 * themselves are frozen.
 */
export const FROZEN_RECORD_DIRS = [
  'docs/decisions',
  'docs/design',
  'intent/archive',
] as const;

/** The repository root, from this file's own location. */
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * True when a path is a frozen record.
 *
 * Resolved against the repository root rather than matched as a substring. A
 * checkout under a path that happens to contain `docs/design/` would otherwise
 * exempt every file in the repository from all three guards, and nothing would
 * say so.
 *
 * `console-canvas` is excluded by name, because it sits under a frozen
 * directory and is not a frozen record.
 */
export function isFrozenRecord(path: string): boolean {
  const from = relative(REPO_ROOT, resolve(REPO_ROOT, path));
  // Outside the repository, or climbing out of it: not a record here.
  if (from.startsWith('..') || isAbsolute(from)) return false;
  const posix = from.split(sep).join('/');
  if (posix.startsWith('docs/design/console-canvas/')) return false;
  return FROZEN_RECORD_DIRS.some((dir) => posix.startsWith(`${dir}/`));
}
