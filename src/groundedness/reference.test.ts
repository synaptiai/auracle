// The one groundedness file this repository tracks, and the guarantee that it
// is inert.
//
// `groundedness/` is ignored, because a committed fit would move every
// adopter's second gate to a number fitted on this repository's own synthetic
// corpus. A reader still needs to check the published numbers against the file
// that produced them, so one copy is tracked under a name the version scanner
// does not read.
//
// That is a safety property, not a naming convention. These cases hold it.

import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import { scanArtifactNames } from '../artifacts/versioned.js';
import { FIT_COUNT } from '../domain/gold-types.js';
import {
  loadGroundednessArtifact,
  validateGroundednessArtifact,
} from './artifact.js';

const ROOT = new URL('../../', import.meta.url);

/**
 * The one tracked reference, discovered rather than named.
 *
 * A refit mints `reference-v4.json` and moves the `.gitignore` exception with
 * it. A literal here would then fail with a bare `ENOENT` instead of the
 * assertions below, which is the drift `committedGoldReport` already avoids.
 */
function committedReference(): URL {
  const tracked = execFileSync('git', ['ls-files', 'groundedness'], {
    cwd: fileURLToPath(ROOT),
    encoding: 'utf8',
  })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^groundedness\/reference-v\d+\.json$/.test(line));
  expect(tracked, 'the repository tracks exactly one groundedness reference')
    .toHaveLength(1);
  return new URL(tracked[0]!, ROOT);
}

const REFERENCE = committedReference();

describe('the tracked reference fit', () => {
  it('is a real artifact this repository can still validate', () => {
    const artifact = validateGroundednessArtifact(
      JSON.parse(readFileSync(REFERENCE, 'utf8')),
    );
    expect(artifact.split_used).toBe('fit');
    expect(artifact.gold_source).toBe('synthetic');
    // The register quotes these four. A change here republishes a number.
    expect(artifact.block).toBe(2 / 3);
    expect(artifact.review).toBe(5 / 6);
    expect(artifact.fit_drafts).toBe(1098);
    expect(artifact.faulted_drafts).toBe(2);
    // AC6: the run reports what it spent, and says the figure is a floor,
    // because 2 faulted drafts carry spend nothing can attribute (DEC-25).
    expect(artifact.cost_micros).toBe(148_418);
    expect(artifact.cost_unknown).toBe(true);
  });

  // The whole ruling rests on this. A name the scanner reads would be adopted
  // by every checkout, which is what `/groundedness/` is ignored to prevent.
  it('carries a name no version scan will pick up', () => {
    const found = scanArtifactNames(
      ['reference-v3.json', 'v1.json', 'v2.json'],
      'groundedness',
    );
    expect(found.map((f) => f.name)).toEqual(['v1.json', 'v2.json']);
  });

  // And it is not merely un-preferred: a directory holding the reference and
  // nothing else must read as no artifact at all, not as version 1.
  it('is invisible to the loader that installs a fitted gate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'auracle-reference-'));
    try {
      writeFileSync(join(dir, 'reference-v3.json'), readFileSync(REFERENCE));
      const found = await loadGroundednessArtifact(undefined, pathToFileURL(`${dir}/`));
      expect(found).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });


  // The register and the README quote this pair in prose. #40 reshaped the
  // corpus underneath it, and a document that kept the old pair would describe
  // a fit that no longer exists. So every quotation site is pinned.
  //
  // Three earlier versions were too weak, and all three are recorded because
  // the defect keeps taking the same shape. A `toContain` over the whole file
  // passed while a paragraph carried the withdrawn pair, because one correct
  // mention elsewhere satisfied it. A fixed list of three wordings then missed
  // two live sentences. Then classification ran per SENTENCE while the
  // assertion ran per value, so a withdrawal clause, or the word "agreement",
  // handed its exemption to a live value sitting beside it in the same
  // sentence.
  //
  // So the unit is the clause. A clause that withdraws a value may name the
  // old pair; every other clause must name the fitted one. The agreement gate
  // is excluded per clause, not per sentence, because DEC-05 keeps the two
  // gates independent and one sentence can mention both.
  it('is the pair every shipped document quotes, at every site', () => {
    const artifact = validateGroundednessArtifact(
      JSON.parse(readFileSync(REFERENCE, 'utf8')),
    );
    const fitted = [artifact.block.toFixed(2), artifact.review.toFixed(2)];
    // The pair this fit replaced. A clause that withdraws it may say it.
    const withdrawn = ['0.75', '1.00'];

    const VALUE = /\b\d\.\d{2}\b/g;
    const COVERAGE = /\b(blocks?|reviews?|pairs?|thresholds?|coverage|values?)\b|fit reads/i;
    const AGREEMENT = /\bagreement\b/i;
    const WITHDRAWAL = /\b(earlier|stood here|rested on|withdrawn|no longer|seeds?|used to)\b/i;
    const CLAUSE = /(?<=[.!?])\s+|[,;]\s+|\s+and\s+/;

    // A floor, not an exact count: gaining a correct quotation must not fail.
    // Losing one is caught by the floor, and losing a VALUE is caught below.
    const minimumSites: Record<string, number> = {
      'README.md': 3,
      'docs/v1-architecture.md': 4,
    };

    for (const [name, minimum] of Object.entries(minimumSites)) {
      const text = readFileSync(new URL(name, ROOT), 'utf8').replace(/\n/g, ' ');
      let live = 0;
      const quotedLive = new Set<string>();
      for (const clause of text.split(CLAUSE)) {
        const values = clause.match(VALUE);
        if (!values || !COVERAGE.test(clause) || AGREEMENT.test(clause)) continue;
        const withdrawing = WITHDRAWAL.test(clause);
        const allowed = withdrawing ? [...fitted, ...withdrawn] : fitted;
        if (!withdrawing) {
          live += 1;
          for (const value of values) quotedLive.add(value);
        }
        for (const value of values) {
          expect(
            allowed,
            `${name} quotes ${value}, which this fit does not hold: "${clause.trim().slice(0, 90)}"`,
          ).toContain(value);
        }
      }
      // The floor alone is not enough. Dropping a pinned clause while adding
      // one this scan does not classify would hold the count. So both fitted
      // values must still be quoted somewhere the scan does read.
      for (const value of fitted) {
        expect(
          [...quotedLive],
          `${name} no longer quotes ${value} outside a withdrawal`,
        ).toContain(value);
      }
      expect(live, `${name} stopped quoting the fitted pair at every site`)
        .toBeGreaterThanOrEqual(minimum);
    }
  });

  // A pair fitted on part of the half is a pilot, and it must say so.
  //
  // `GROUNDEDNESS_LIMIT` makes the job read a PREFIX, not a sample. The
  // corpus orders its intents, so a prefix is systematically unrepresentative
  // — the shipped run covered 10 intents of 25 and no low-tier draft at all.
  // The shipped pair was published as "one pass over the fit half" until a
  // reviewer measured it. Nothing in the suite tied the drafts read to the
  // size of the half, so this does.
  it('says so in the documents when the fit read a slice of the half', () => {
    const artifact = validateGroundednessArtifact(
      JSON.parse(readFileSync(REFERENCE, 'utf8')),
    );
    const read = artifact.fit_drafts + artifact.faulted_drafts;
    expect(read, 'the fit read more drafts than the half holds')
      .toBeLessThanOrEqual(FIT_COUNT);
    if (read === FIT_COUNT) return;
    // It is a slice. Both documents must disclose that, and neither may call
    // it a pass over the half.
    for (const name of ['README.md', 'docs/v1-architecture.md']) {
      const text = readFileSync(new URL(name, ROOT), 'utf8').replace(/\n/g, ' ');
      expect(
        /\b(pilot|slice|prefix)\b/i.test(text),
        `${name} does not disclose that the fit read ${read} of ${FIT_COUNT} drafts`,
      ).toBe(true);
      expect(
        text,
        `${name} calls a ${read}-draft slice a pass over the fit half`,
      ).not.toMatch(/(one|a) (full )?pass over the (fit half|corpus)/i);
    }
  });

  // A name the scanner refuses outright would stop a process rather than be
  // ignored, so the choice of prefix matters. `v1-reference.json` is
  // artifact-shaped and is a fault; `reference-v3.json` is an operator's file.
  it('would have been a fault under the other obvious name', () => {
    expect(() => scanArtifactNames(['v3-reference.json'], 'groundedness'))
      .toThrow(/not a versioned artifact/);
  });
});
