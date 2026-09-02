import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  loadGroundednessArtifact,
  validateGroundednessArtifact,
  writeGroundednessArtifact,
} from './artifact.js';
import type { GroundednessArtifact } from './artifact.js';

const tempDir = (): URL => pathToFileURL(mkdtempSync(join(tmpdir(), 'auracle-gnd-')));

function makeArtifact(over: Partial<GroundednessArtifact> = {}): GroundednessArtifact {
  return {
    artifact: 'groundedness-thresholds',
    version: 1,
    fitted_at: '2026-02-01T09:00:00.000Z',
    gold_source: 'synthetic',
    fit_half_digest: null,
    report_half_digest: null,
    split_used: 'fit',
    fit_drafts: 385,
    faulted_drafts: 0,
    prompt_ver: 'ground-p1',
    model_ver: 'z-ai/glm-5.3-flash',
    target_precision: 0.985,
    target_npv: 0.9,
    block: 0.6,
    block_npv: 0.94,
    block_drafts: 37,
    block_interval: { confidence: 0.95, lower: 0.88, upper: 0.98 },
    review: 0.8,
    review_precision: 0.99,
    review_coverage: 0.55,
    review_interval: { confidence: 0.95, lower: 0.96, upper: 1 },
    by_grade: [{ grade: 'absent', drafts: 100, mean_coverage: 0.6 }],
    ...over,
  };
}

// The spend fields (DEC-25, AC6). The whole block was deletable with the
// groundedness suite green: the only assertions on these fields read the
// committed reference file, which does not change when the validator does.
describe('the spend a fit reports', () => {
  it('accepts a run that recorded an exact total', () => {
    expect(() => validateGroundednessArtifact({
      ...makeArtifact(), cost_micros: 170_780, cost_unknown: false,
    })).not.toThrow();
  });

  it('accepts a run that recorded a floor', () => {
    expect(() => validateGroundednessArtifact({
      ...makeArtifact(), cost_micros: 170_780, cost_unknown: true,
    })).not.toThrow();
  });

  // A cost with no qualifier reads as a total, and half of these runs can
  // only report a floor. Reporting one as the other is what DEC-25 forbids.
  it('refuses a spend that does not say whether it is a total', () => {
    expect(() => validateGroundednessArtifact({
      ...makeArtifact(), cost_micros: 170_780,
    } as unknown as Parameters<typeof validateGroundednessArtifact>[0]))
      .toThrow(/without cost_unknown/);
  });

  it('refuses a qualifier that qualifies nothing', () => {
    expect(() => validateGroundednessArtifact({
      ...makeArtifact(), cost_unknown: true,
    } as unknown as Parameters<typeof validateGroundednessArtifact>[0]))
      .toThrow(/without cost_micros/);
  });

  it.each([-1, Number.NaN])('refuses %s as a spend', (value) => {
    expect(() => validateGroundednessArtifact({
      ...makeArtifact(), cost_micros: value, cost_unknown: false,
    })).toThrow(/cost_micros is not a spend/);
  });

  // An artifact written before the field existed must still read.
  it('accepts a run that recorded no spend at all', () => {
    expect(() => validateGroundednessArtifact(makeArtifact())).not.toThrow();
  });
});

describe('the DEC-31 proof a real run must carry', () => {
  // Its two siblings got this case in cycle 9; this one did not, and the
  // sweep that claimed to cover the branch's guards never mutated it. The
  // non-null rule below is tested, so without this any junk string satisfied
  // the proof-binding this change argues hardest for.
  it('refuses an artifact that does not say how many drafts it dropped', () => {
    // A published threshold must state its attrition: a reader cannot tell
    // 385 of 385 from 366 of 385 without it.
    const raw = makeArtifact() as unknown as Record<string, unknown>;
    delete raw['faulted_drafts'];
    expect(() => validateGroundednessArtifact(raw)).toThrow(/faulted_drafts/);
    expect(() => validateGroundednessArtifact({ ...makeArtifact(), faulted_drafts: -1 })).toThrow(
      /faulted_drafts/,
    );
  });

  it('refuses a digest that is neither null nor a digest', () => {
    for (const field of ['fit_half_digest', 'report_half_digest'] as const) {
      expect(() => validateGroundednessArtifact(makeArtifact({ [field]: 'not-a-digest' })))
        .toThrow(new RegExp(field));
      expect(() => validateGroundednessArtifact(makeArtifact({ [field]: 'ABCDEF0123456789' })))
        .toThrow(new RegExp(field));
    }
  });

  // Null digests mean the committed corpus, whose halves the loader
  // cross-checks. A real run has no such guarantee, so an artifact declaring
  // real provenance with no proved pair would be a threshold nobody checked.
  it('refuses a real artifact that names no proved pair', () => {
    expect(() => validateGroundednessArtifact(makeArtifact({ gold_source: 'real' })))
      .toThrow(/must name the pair it proved disjoint/);
  });

  it('accepts a real artifact that names one', () => {
    expect(() => validateGroundednessArtifact(makeArtifact({
      gold_source: 'real',
      fit_half_digest: 'a1b2c3d4e5f60718',
      report_half_digest: 'f0e1d2c3b4a59687',
    }))).not.toThrow();
  });
});

describe('groundedness artifact (DEC-05, DEC-18, DEC-31)', () => {
  it('round-trips through its own directory', async () => {
    const dir = tempDir();
    try {
      await writeGroundednessArtifact(makeArtifact(), dir);

      const loaded = await loadGroundednessArtifact(undefined, dir);

      expect(loaded?.review).toBe(0.8);
      expect(loaded?.block).toBe(0.6);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('answers null when nothing has been fitted', async () => {
    expect(await loadGroundednessArtifact(undefined, tempDir())).toBeNull();
  });

  it.each([[0.9, 0.8], [0.8, 0.8]])(
    'refuses an artifact whose block %s does not sit below review %s',
    (block, review) => {
      // The engine escalates below block and gates below review. Inverted
      // leaves no review band; equal leaves it empty, which is the same
      // outcome and the commoner one.
      expect(() => validateGroundednessArtifact(makeArtifact({ block, review }))).toThrow(
        /does not sit below review/,
      );
    },
  );

  it('refuses an artifact fitted on the report half (DEC-31)', () => {
    expect(() =>
      validateGroundednessArtifact(makeArtifact({ split_used: 'report' as 'fit' })),
    ).toThrow(/split_used/);
  });

  it('refuses an artifact that carries an agreement value (DEC-05)', () => {
    // The two gates are fitted by two jobs into two artifacts. An agreement
    // value here would mean they were fitted together.
    expect(() =>
      validateGroundednessArtifact({ ...makeArtifact(), agreement: 0.6 }),
    ).toThrow(/gates are independent/);
  });

  it.each([[0], [-1], [1.5], ['many']])(
    'refuses block_drafts of %s',
    (value) => {
      // Every other rule in this validator had a negative case and this one
      // did not, so deleting the whole assertion left all 40 tests green.
      expect(() =>
        validateGroundednessArtifact(makeArtifact({ block_drafts: value as number })),
      ).toThrow(/block_drafts/);
    },
  );

  it('refuses an artifact with no per-grade record', () => {
    // Without it a fit that holds only on the easy negatives is invisible.
    expect(() => validateGroundednessArtifact(makeArtifact({ by_grade: [] }))).toThrow(/by_grade is empty/);
  });

  it('refuses a non-synthetic source (DEC-18)', () => {
    expect(() =>
      validateGroundednessArtifact(makeArtifact({ gold_source: 'production' as 'synthetic' })),
    ).toThrow(/gold_source/);
  });

  it('refuses a threshold outside [0, 1]', () => {
    expect(() => validateGroundednessArtifact(makeArtifact({ review: 1.5 }))).toThrow(/review is outside/);
  });
});
