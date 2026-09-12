// Which gold half a job consumes, resolved from the environment.
//
// Three jobs need the same answer: the agreement fit, the coverage fit and
// the gold report. The rule is one rule, so it lives in one place.
//
// With neither variable set a job reads the committed synthetic corpus and
// needs no counterpart: `loadGoldSet` already cross-checks its two halves.
// With a path set the job reads that file, and the other variable must name
// the other half, which the job's own guard then proves disjoint (DEC-31).
//
// The counterpart file is opened and validated in full — `readHalfIdentity`
// parses it and runs every field rule, because an identity taken from a file
// nobody validated would prove nothing. What it RETURNS is identifiers only,
// and `HalfIdentity` has no field that could hold a subject or a body. So no
// case text of the counterpart reaches the job, which is the guarantee that
// matters; "the file is never read" would be the wrong claim and it is not
// the one made here.
//
// Both files belong under `corpus/`, which is gitignored. A labelled half of
// real history never enters this repository (DEC-18).

import { loadGoldHalf, readHalfIdentity } from './load.js';
import type { GoldFile, GoldSplit, HalfIdentity } from '../domain/gold-types.js';

/** The environment variable naming each half. Follows the CORPUS_PATH precedent. */
const HALF_PATH_VARS: Readonly<Record<GoldSplit, string>> = Object.freeze({
  fit: 'GOLD_FIT_PATH',
  report: 'GOLD_REPORT_PATH',
});

export interface SelectedHalf {
  /** Absent when the job should read the committed corpus. */
  half?: GoldFile;
  /** Identifiers of the other half. Absent when no path was given. */
  counterpart?: HalfIdentity;
  /** The path read, for the log line. Absent when the corpus was used. */
  path?: string;
}

/**
 * Resolve the half a job consumes, or throw with the variable to set.
 *
 * Throws rather than warning. A path given for one half and not the other is
 * an operator halfway through a change; fitting on the named half anyway
 * would publish a threshold whose disjointness nobody checked.
 *
 * This resolves. It does not prove: the job's own guard calls
 * `assertHalvesDisjoint` with what this returns, and it does so for every
 * provenance, because a file read by path carries no cross-half guarantee
 * whatever it declares itself to be.
 */
export function selectHalf(
  own: GoldSplit,
  env: Readonly<Record<string, string | undefined>> = process.env,
): SelectedHalf {
  const other: GoldSplit = own === 'fit' ? 'report' : 'fit';
  const ownVar = HALF_PATH_VARS[own];
  const otherVar = HALF_PATH_VARS[other];
  // `GOLD_FIT_PATH=` is the usual shell idiom for clearing a variable, and it
  // is a defined empty string. Untrimmed, it skipped both guidance errors and
  // died in readFileSync('') with an ENOENT naming no variable.
  const ownPath = env[ownVar]?.trim() || undefined;
  const otherPath = env[otherVar]?.trim() || undefined;

  if (ownPath === undefined && otherPath === undefined) return {};
  if (ownPath === undefined) {
    throw new Error(
      `${otherVar} is set but ${ownVar} is not; name the half this job consumes, `
        + 'or unset both to read the committed corpus',
    );
  }
  if (otherPath === undefined) {
    throw new Error(
      `${ownVar} is set but ${otherVar} is not; the other half proves the two disjoint `
        + '(DEC-31); the job takes identifiers from it and reads none of its cases',
    );
  }
  return {
    half: loadGoldHalf(own, ownPath),
    counterpart: readHalfIdentity(otherPath, other),
    path: ownPath,
  };
}
