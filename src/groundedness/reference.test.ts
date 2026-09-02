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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import { scanArtifactNames } from '../artifacts/versioned.js';
import {
  defaultGroundednessDir,
  loadGroundednessArtifact,
  validateGroundednessArtifact,
} from './artifact.js';

const REFERENCE = new URL('reference-v2.json', defaultGroundednessDir());

describe('the tracked reference fit', () => {
  it('is a real artifact this repository can still validate', () => {
    const artifact = validateGroundednessArtifact(
      JSON.parse(readFileSync(REFERENCE, 'utf8')),
    );
    expect(artifact.split_used).toBe('fit');
    expect(artifact.gold_source).toBe('synthetic');
    // The register quotes these four. A change here republishes a number.
    expect(artifact.block).toBe(0.75);
    expect(artifact.review).toBe(1);
    expect(artifact.fit_drafts).toBe(1043);
    expect(artifact.faulted_drafts).toBe(19);
    // AC6: the run reports what it spent, and says the figure is a floor,
    // because 19 faulted drafts carry spend nothing can attribute (DEC-25).
    expect(artifact.cost_micros).toBe(170_780);
    expect(artifact.cost_unknown).toBe(true);
  });

  // The whole ruling rests on this. A name the scanner reads would be adopted
  // by every checkout, which is what `/groundedness/` is ignored to prevent.
  it('carries a name no version scan will pick up', () => {
    const found = scanArtifactNames(
      ['reference-v2.json', 'v1.json', 'v2.json'],
      'groundedness',
    );
    expect(found.map((f) => f.name)).toEqual(['v1.json', 'v2.json']);
  });

  // And it is not merely un-preferred: a directory holding the reference and
  // nothing else must read as no artifact at all, not as version 1.
  it('is invisible to the loader that installs a fitted gate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'auracle-reference-'));
    try {
      writeFileSync(join(dir, 'reference-v2.json'), readFileSync(REFERENCE));
      const found = await loadGroundednessArtifact(undefined, pathToFileURL(`${dir}/`));
      expect(found).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A name the scanner refuses outright would stop a process rather than be
  // ignored, so the choice of prefix matters. `v1-reference.json` is
  // artifact-shaped and is a fault; `reference-v2.json` is an operator's file.
  it('would have been a fault under the other obvious name', () => {
    expect(() => scanArtifactNames(['v2-reference.json'], 'groundedness'))
      .toThrow(/not a versioned artifact/);
  });
});
