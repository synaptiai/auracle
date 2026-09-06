// What gates the shipped gold report, and what the documents say gates it
// (DEC-13, DEC-41, section 4.10).
//
// The gold report records the provenance of its agreement gate. A
// `gate_source` of `seed` names the section 4.5 seed. A `gate_source` of
// `calibration` names the artifact version that fitted the number. The two
// publish different claims, so a document describing the report must agree
// with the field.
//
// This file exists because the roadmap did not. It stated that the shipped
// corpus clears the trigger, so the per-intent path runs and its thresholds
// gate the shipped gold report. The shipped report names a seeded gate and
// no calibration version, so no fitted threshold has ever gated it.
//
// ## What this file can decide, and what it cannot
//
// It cannot decide that a document is truthful. Prose contradicts a field in
// as many ways as a writer has words, and no list of them is complete. Two
// earlier versions of this file overclaimed, and each was defeated:
//
//   - The first banned one wording. The same claim, reworded, walked past it.
//   - The second read a paragraph. Four attacks walked past it: a synonym
//     for the verb, the word `seed` used as decoration in the same
//     paragraph, a paragraph break between the two halves, and a paraphrase
//     of the noun. A whole-section rule fails differently again, because a
//     false sentence beside a true one satisfies any test for the true one.
//   - The third read sentences of prose. A claim written into a table cell
//     walked past it, because the cells of one row flattened into a single
//     unit and a neighbour's `nothing` denied the claim beside it.
//
// So this is a tripwire and not a proof, and it states two things it can
// decide. First, the documents say what the field records. Second, a
// sentence that claims gating or fitting for the report carries either a
// negation or the recorded value.
//
// A determined writer evades the second. A regression of the sentence this
// change removed, and its near neighbours, does not.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Documents that describe the published gate. Both name the same field. */
const GUARDED = ['docs/v2-roadmap.md', 'README.md'] as const;

/**
 * The newest gold report the repository commits.
 *
 * Tracked files only. `readdirSync` would read what is on disk, and
 * `.gitignore` keeps one version while `pnpm run gold-report` writes the
 * next one. So a maintainer who runs that job locally would turn this case
 * red over a file the repository does not ship.
 *
 * Pinned to a version, this file would validate a superseded report for
 * ever: the maintainer who ships a fitted report leaves the old pin behind,
 * and the check goes on guarding a document nobody publishes.
 */
interface GoldReport {
  readonly name: string;
  readonly body: Record<string, unknown>;
}

function newestCommittedGoldReport(): GoldReport {
  const tracked = execFileSync('git', ['ls-files', 'gold-report'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^gold-report\/v\d+\.json$/.test(line));
  const versionOf = (path: string): number => Number(/v(\d+)\.json$/.exec(path)?.[1] ?? -1);
  const newest = tracked.sort((a, b) => versionOf(a) - versionOf(b)).at(-1);
  if (newest === undefined) throw new Error('git tracks no gold report under gold-report/');
  const text = readFileSync(join(REPO_ROOT, newest), 'utf8');
  try {
    return { name: newest, body: JSON.parse(text) as Record<string, unknown> };
  } catch (cause) {
    // Named. A parse fault reports a byte position, and this file is built
    // to outlive any one version, so the position alone leaves a reader
    // hunting for which report holds it.
    throw new Error(`${newest} is not readable JSON`, { cause });
  }
}

/**
 * The units of a markdown file that carry a claim.
 *
 * A paragraph gives its sentences, with the line wrapping removed. A table
 * gives each cell, and a list gives each item. Those two must not merge: a
 * row flattened whole reads as one unit, so a denial in one cell reaches a
 * claim in the next, and a claim written into a table walked past an earlier
 * version of this file for exactly that reason.
 */
function units(markdown: string): string[] {
  const raw: string[] = [];
  for (const block of markdown.split(/\n\s*\n/)) {
    const prose: string[] = [];
    for (const line of block.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('|')) {
        for (const cell of trimmed.replace(/^\||\|$/g, '').split('|')) raw.push(cell);
      } else if (/^(?:\d+\.|[-*+])\s/.test(trimmed)) {
        raw.push(trimmed.replace(/^(?:\d+\.|[-*+])\s/, ''));
      } else {
        prose.push(trimmed);
      }
    }
    if (prose.length > 0) raw.push(prose.join(' '));
  }
  return raw
    .flatMap((unit) => unit.split(/(?<=[.!?])\s+/))
    .map((unit) => unit.replace(/\s+/g, ' ').trim())
    .filter((unit) => unit.length > 0);
}

/**
 * The report, however a writer names it.
 *
 * Both documents are read, and they do not share a vocabulary. The roadmap
 * writes `gold report`. The README writes the file name, and `the report`.
 * A pattern built from one document's words leaves the other unguarded.
 */
const REPORT = /\bgold[- ]report\b|\bshipped report\b|\breport (?:the|this) repository ships\b|\b(?:the|that|this) report\b/i;
/** A claim that something other than a seed produced the gate. */
const CLAIM = /\bgat(?:e|es|ed|ing)\b|\bfitted\b|\bfits\b|\bcalibration\b|\bcalibrated\b/i;
/** A sentence that denies the claim rather than making it. */
const DENIES = /\b(?:no|not|never|nothing|neither|cannot)\b/i;

/**
 * Discovery, captured rather than thrown.
 *
 * At module scope a throw is a collection error, so the file contributes no
 * cases and a reader sees an absence where a red row belongs. An environment
 * with no git, or a checkout with no history, would take this gate offline
 * silently. The first case below re-throws it against a name instead.
 */
const discovered = ((): { report?: GoldReport; error?: unknown } => {
  try {
    return { report: newestCommittedGoldReport() };
  } catch (error) {
    return { error };
  }
})();

const documents = GUARDED.map((path) => ({
  path,
  text: readFileSync(join(REPO_ROOT, path), 'utf8'),
}));

/** The document that states what gates the shipped report. */
const CLAIMANT = 'docs/v2-roadmap.md';

describe('the gate the newest committed gold report records', () => {
  it('is discoverable, and git tracks one', () => {
    // Re-thrown against a name. Whatever went wrong — no git, no checkout
    // history, no tracked report, unreadable JSON — reaches a reader as a
    // failing case with its own message, and not as a file that ran nothing.
    if (discovered.error !== undefined) throw discovered.error;
    expect(discovered.report).toBeDefined();
  });

  it('names a source from the closed set', () => {
    // The invariant. A source outside this set is a schema change, and the
    // cases below could not decide what a document may claim about it.
    const found = discovered.report;
    expect(found, 'no gold report was discovered').toBeDefined();
    expect(['seed', 'calibration'], `${found?.name ?? 'the report'} records an unknown gate source`)
      .toContain(found?.body['gate_source']);
  });

  it('records a seeded gate today, which is a canary and not an invariant', () => {
    // Meant to fail on the day a fitted report ships. The document cases
    // then skip, and this red row is the reminder that every document
    // describing the gate needs re-reading by a person. The two arrive
    // together, in one block, so a reader is never shown green document rows
    // beside a red canary and left to reconcile them.
    const found = discovered.report;
    expect(found, 'no gold report was discovered').toBeDefined();
    expect(found?.body['gate_source'], `${found?.name ?? 'the report'} records a fitted gate`)
      .toBe('seed');
    expect(
      found?.body['gate_calibration_version'],
      `${found?.name ?? 'the report'} names a calibration version`,
    ).toBeNull();
  });

  // A fitted report makes a claim of fitted gating true, so the two cases
  // below must permit what they forbid today. They skip rather than return:
  // an early return reports an unasserted case as passed, which reads as a
  // document that was checked.
  const unguarded = discovered.report === undefined
    || discovered.report.body['gate_source'] === 'calibration';

  it.skipIf(unguarded)(`${CLAIMANT} says what the field records`, () => {
    const document = documents.find((entry) => entry.path === CLAIMANT)!;
    // This document alone. The README defines what each source *means*, and
    // never states which one the shipped report holds, so requiring the
    // statement there would assert a property that document does not have.
    //
    // Read from the units and not from the raw text. A line wrap between the
    // field and its value is a change of typesetting, and it must not fail a
    // case about what a document says.
    //
    // Anchored on the field beside its value, and not on the bare word.
    // `seed` alone is weak evidence: a traffic seeder writes a backdated
    // history in this repository, so a document could satisfy it while
    // saying nothing about the gate.
    expect(
      units(document.text).join(' '),
      `${CLAIMANT} must name the gate source the report records`,
    ).toMatch(/gate[_ ]source(?:` of| of)? `?seed`?/i);
  });

  it.skipIf(unguarded).each(documents)('$path claims no fitted gate for the report', ({ path, text }) => {
    const claims = units(text).filter(
      (unit) =>
        REPORT.test(unit)
        && CLAIM.test(unit)
        && !DENIES.test(unit)
        && !/`seed`/.test(unit),
    );
    expect(claims, `${path} asserts a gate for the report without naming the seed`).toEqual([]);
  });
});
