// The reader that closes the calibration chain. The fitting job wrote
// artifacts nobody loaded; these cases pin what a process adopts, and what it
// says when it adopts a seed.
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SEED_THRESHOLDS } from '../policy/policy.js';
import { FakeProvider } from '../models/fake.js';
import { loadCalibrationArtifact, nextVersion } from './artifact.js';
import { runCalibrationJob } from './run.js';
import { pinFaults, resolveThresholds } from './resolve.js';
import type { CalibrationArtifact } from './artifact.js';

function artifact(overrides: Partial<CalibrationArtifact> = {}): CalibrationArtifact {
  return {
    artifact: 'agreement-threshold',
    version: 1,
    fitted_at: '2026-01-05T10:00:00.000Z',
    gold_source: 'synthetic',
    split_used: 'fit',
    scope: 'all_turns',
    fit_tickets: 385,
    unreadable_samples: 0,
    fit_half_digest: null,
    report_half_digest: null,
    prompt_ver: 'classify-p1',
    model_ver: 'z-ai/glm-5.3-flash',
    target_precision: 0.985,
    threshold: 0.78,
    precision_at_threshold: 0.99,
    coverage_at_threshold: 0.6,
    interval: { confidence: 0.95, lower: 0.97, upper: 1 },
    ...overrides,
  } as CalibrationArtifact;
}

/** A coverage artifact the resolver may adopt. */
function coverageArtifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    artifact: 'groundedness-thresholds',
    version: 1,
    fitted_at: '2026-01-06T10:00:00.000Z',
    gold_source: 'synthetic',
    fit_half_digest: null,
    report_half_digest: null,
    split_used: 'fit',
    fit_drafts: 400,
    faulted_drafts: 0,
    prompt_ver: 'ground-p1',
    model_ver: 'z-ai/glm-5.3-flash',
    target_precision: 0.985,
    target_npv: 0.9,
    block: 0.55,
    block_npv: 0.97,
    block_drafts: 60,
    block_interval: { confidence: 0.95, lower: 0.91, upper: 1 },
    review: 0.85,
    review_precision: 0.99,
    review_coverage: 0.5,
    review_interval: { confidence: 0.95, lower: 0.986, upper: 1 },
    by_grade: [{ grade: 'absent', drafts: 20, mean_coverage: 0.6 }],
    ...overrides,
  };
}

// The coverage fit wrote versioned artifacts and nothing loaded one, so the
// two coverage numbers stayed at their seeds however often the job ran. That
// is the open loop this resolver was built to close for the other gate.
describe('the coverage gate reaches the runtime too (DEC-05)', () => {
  let dir: string;
  let coverageDir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'resolve-cal-'));
    coverageDir = await mkdtemp(path.join(tmpdir(), 'resolve-cov-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(coverageDir, { recursive: true, force: true });
  });

  // A threshold is one model's judgement of what coverage means, read through
  // one judge prompt. A process that adopts a pair fitted under another pin
  // runs a gate nobody measured, and the resolver cannot check that itself —
  // it is pure and does not know what model the process will run. So it hands
  // the pins back, and the caller that knows its own pin compares.
  it('returns the pins each fitted artifact was produced under (DEC-26)', async () => {
    await writeFile(
      path.join(coverageDir, 'v1.json'),
      JSON.stringify(coverageArtifact({ model_ver: 'vendor/judge-a', prompt_ver: 'ground-p9' })),
    );
    await writeFile(
      path.join(dir, 'v1.json'),
      JSON.stringify(artifact({ model_ver: 'vendor/classify-b', prompt_ver: 'classify-p9' })),
    );
    const lines: Record<string, unknown>[] = [];
    const resolved = await resolveThresholds({
      dir: pathToFileURL(dir + path.sep),
      groundednessDir: pathToFileURL(coverageDir + path.sep),
      log: (e) => lines.push(e),
    });

    // Separately per gate, never merged: the two can be fitted under
    // different pins and a reader must be able to see both (DEC-05).
    expect(resolved.fittedPins.coverage).toEqual({
      modelVer: 'vendor/judge-a', promptVer: 'ground-p9',
    });
    expect(resolved.fittedPins.agreement).toEqual({
      modelVer: 'vendor/classify-b', promptVer: 'classify-p9',
    });
    // And the startup line names them, because that is where an operator
    // looks when a gate moves.
    const coverageLine = lines.find((l) => l['event'] === 'coverage_thresholds_fitted');
    expect(coverageLine?.['model_ver']).toBe('vendor/judge-a');
    expect(coverageLine?.['prompt_ver']).toBe('ground-p9');
  });

  it('reports no fitted pins when both gates keep their seeds', async () => {
    const resolved = await resolveThresholds({
      dir: pathToFileURL(dir + path.sep),
      groundednessDir: pathToFileURL(coverageDir + path.sep),
      log: () => {},
    });
    expect(resolved.fittedPins).toEqual({ coverage: null, agreement: null });
  });

  it('adopts a fitted coverage pair and says where it came from', async () => {
    await writeFile(
      path.join(coverageDir, 'v1.json'),
      JSON.stringify(coverageArtifact()),
    );
    const lines: Record<string, unknown>[] = [];
    const resolved = await resolveThresholds({
      dir: pathToFileURL(dir + path.sep),
      groundednessDir: pathToFileURL(coverageDir + path.sep),
      log: (e) => lines.push(e),
    });

    expect(resolved.thresholds.groundednessBlock).toBe(0.55);
    expect(resolved.thresholds.groundednessReview).toBe(0.85);
    // The agreement gate has no artifact here, so it keeps its seed. The two
    // gates resolve separately and neither supplies a number to the other.
    expect(resolved.thresholds.agreement).toBe(SEED_THRESHOLDS.agreement);
    expect(resolved.coverageProvenance).toEqual({
      source: 'groundedness', version: 1, goldSource: 'synthetic',
    });
    expect(lines.some((e) => e['event'] === 'coverage_thresholds_fitted')).toBe(true);
  });

  it('keeps the seeds and says so when no coverage artifact exists', async () => {
    const lines: Record<string, unknown>[] = [];
    const resolved = await resolveThresholds({
      dir: pathToFileURL(dir + path.sep),
      groundednessDir: pathToFileURL(coverageDir + path.sep),
      log: (e) => lines.push(e),
    });
    expect(resolved.thresholds.groundednessBlock).toBe(SEED_THRESHOLDS.groundednessBlock);
    expect(resolved.thresholds.groundednessReview).toBe(SEED_THRESHOLDS.groundednessReview);
    expect(resolved.coverageProvenance).toEqual({ source: 'seed' });
    expect(lines.some((e) => e['event'] === 'coverage_thresholds_seeded')).toBe(true);
  });

  // A fit that inverts the pair must not reach a running gate. The fitter
  // refuses one, but an artifact can also be edited by hand on the way in.
  it('refuses a coverage artifact whose block exceeds its review', async () => {
    await writeFile(
      path.join(coverageDir, 'v1.json'),
      JSON.stringify(coverageArtifact({ block: 0.9, review: 0.6 })),
    );
    await expect(resolveThresholds({
      dir: pathToFileURL(dir + path.sep),
      groundednessDir: pathToFileURL(coverageDir + path.sep),
      log: () => undefined,
      // The artifact validator refuses it before the threshold constructor
      // sees it, which is earlier and names the file rather than the pair.
    })).rejects.toThrow(/groundedness artifact validation failed/);
  });
});

describe('resolveThresholds (DEC-05, DEC-13, DEC-31)', () => {
  let dir: URL;
  let base: string;
  // An empty coverage directory of its own. Without it these cases read
  // whatever `groundedness/` happens to hold in the checkout, so a fitting run
  // on the developer's machine would change what they assert.
  let groundednessDir: URL;
  let coverageBase: string;
  let logged: Record<string, unknown>[];
  const log = (entry: Record<string, unknown>): void => void logged.push(entry);

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), 'auracle-resolve-'));
    dir = pathToFileURL(`${base}/`);
    coverageBase = await mkdtemp(path.join(tmpdir(), 'auracle-resolve-cov-'));
    groundednessDir = pathToFileURL(`${coverageBase}/`);
    logged = [];
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
    await rm(coverageBase, { recursive: true, force: true });
  });

  async function write(value: unknown, version = 1): Promise<void> {
    await writeFile(path.join(base, `v${version}.json`), JSON.stringify(value));
  }

  it('adopts the fitted agreement threshold when an artifact exists', async () => {
    await write(artifact({ threshold: 0.78 }));

    const resolved = await resolveThresholds({ dir, groundednessDir, log });

    expect(resolved.thresholds.agreement).toBe(0.78);
    expect(resolved.provenance).toEqual({
      source: 'calibration',
      goldSource: 'synthetic',
      version: 1,
      scope: 'all_turns',
    });
  });

  it('takes the highest version when several artifacts exist', async () => {
    await write(artifact({ version: 1, threshold: 0.5 }), 1);
    await write(artifact({ version: 2, threshold: 0.72 }), 2);

    const resolved = await resolveThresholds({ dir, groundednessDir, log });

    expect(resolved.thresholds.agreement).toBe(0.72);
    expect(resolved.provenance).toMatchObject({ version: 2 });
  });

  it('keeps the groundedness seeds, which no job fits yet (DEC-05)', async () => {
    // The two gates are independent, so fitting one moves neither of the
    // other's numbers. A blended resolver would move all three together.
    await write(artifact({ threshold: 0.78 }));

    const resolved = await resolveThresholds({ dir, groundednessDir, log });

    expect(resolved.thresholds.groundednessBlock).toBe(SEED_THRESHOLDS.groundednessBlock);
    expect(resolved.thresholds.groundednessReview).toBe(SEED_THRESHOLDS.groundednessReview);
  });

  it('adopts the seeds when no artifact exists, and says so', async () => {
    const resolved = await resolveThresholds({ dir, groundednessDir, log });

    expect(resolved.thresholds).toEqual(SEED_THRESHOLDS);
    expect(resolved.provenance).toEqual({ source: 'seed' });
    // The whole point of the issue: an operator can tell a seeded gate from a
    // fitted one by reading the log, not by reading the source. Each gate
    // logs its own line, so one fitted gate beside one seeded gate reads
    // correctly rather than as a single verdict over both (DEC-05).
    expect(logged.map((e) => e['event']).sort()).toEqual([
      'coverage_thresholds_seeded', 'gate_thresholds_seeded',
    ]);
    expect(logged.find((e) => e['event'] === 'gate_thresholds_seeded')).toMatchObject({
      agreement: SEED_THRESHOLDS.agreement,
    });
    expect(logged.find((e) => e['event'] === 'coverage_thresholds_seeded')).toMatchObject({
      groundedness_block: SEED_THRESHOLDS.groundednessBlock,
      groundedness_review: SEED_THRESHOLDS.groundednessReview,
    });
  });

  it('says which artifact it adopted when one exists', async () => {
    await write(artifact({ threshold: 0.78 }));

    await resolveThresholds({ dir, groundednessDir, log });

    expect(logged.find((e) => e['event'] === 'gate_thresholds_fitted')).toMatchObject({
      version: 1,
      agreement: 0.78,
      scope: 'all_turns',
    });
    // The coverage gate has no artifact here and says so on its own line.
    expect(logged.find((e) => e['event'] === 'coverage_thresholds_seeded')).toBeDefined();
  });

  // The verified blocking chain this issue closes. Before it, a threshold
  // fitted on an adopter's own labelled half wrote an artifact whose own
  // validator refused it, and every daemon reading that artifact at startup
  // threw instead of starting. Fitting on real data broke the runtime.
  it('starts against an artifact fitted on real history and names the provenance', async () => {
    await write(artifact({
      gold_source: 'real',
      threshold: 0.71,
      fit_half_digest: 'a1b2c3d4e5f60718',
      report_half_digest: 'f0e1d2c3b4a59687',
    }));

    const resolved = await resolveThresholds({ dir, groundednessDir, log });

    expect(resolved.thresholds.agreement).toBe(0.71);
    expect(resolved.provenance).toMatchObject({ source: 'calibration', goldSource: 'real' });
    const line = logged.find((e) => e['event'] === 'gate_thresholds_fitted');
    expect(line).toMatchObject({ gold_source: 'real' });
    // Never a seed line: a fitted number must not read as an unfitted one.
    expect(logged.some((e) => e['event'] === 'gate_thresholds_seeded')).toBe(false);
  });

  it('names the provenance of a synthetic fit too', async () => {
    await write(artifact({ threshold: 0.78 }));
    await resolveThresholds({ dir, groundednessDir, log });
    expect(logged.find((e) => e['event'] === 'gate_thresholds_fitted'))
      .toMatchObject({ gold_source: 'synthetic' });
  });

  // Null digests mean the committed corpus. A real artifact declaring them
  // would be a threshold whose DEC-31 proof is absent, adopted at startup
  // with the field that would reveal the gap asserting the opposite.
  it('refuses a real artifact that names no proved pair (DEC-31)', async () => {
    await write(artifact({ gold_source: 'real', threshold: 0.71 }));
    await expect(resolveThresholds({ dir, groundednessDir, log })).rejects.toThrow(/must name the pair it proved/);
  });

  it('refuses a provenance outside the closed set', async () => {
    await write(artifact({ gold_source: 'imap' as CalibrationArtifact['gold_source'] }));
    await expect(resolveThresholds({ dir, groundednessDir, log })).rejects.toThrow(/gold_source/);
  });

  it('refuses an artifact fitted on the report half (DEC-31)', async () => {
    // Selection on the test data. The validator owns this rule; the case
    // proves the resolver does not route around it.
    await write(artifact({ split_used: 'report' as CalibrationArtifact['split_used'] }));

    await expect(resolveThresholds({ dir, groundednessDir, log })).rejects.toThrow(/split_used/);
  });

  it('refuses a corrupt artifact rather than falling back to seeds', async () => {
    // A missing artifact is an ordinary state. A broken one is a fault, and
    // treating it as "not calibrated" would hide a truncated write behind a
    // gate that still looks healthy.
    await write({ artifact: 'agreement-threshold', version: 1 });

    await expect(resolveThresholds({ dir, groundednessDir, log })).rejects.toThrow(/validation failed/);
  });

  it('refuses an artifact whose threshold is outside (0, 1]', async () => {
    await write(artifact({ threshold: 1.5 }));

    await expect(resolveThresholds({ dir, groundednessDir, log })).rejects.toThrow(/threshold/);
  });

  it('refuses a threshold of zero at the artifact boundary, not inside a daemon', async () => {
    // A gate at zero passes every ticket. The validator refuses it here. If
    // only makeThresholds refused it, a file that validated would still stop
    // a process that had already read it.
    await write(artifact({ threshold: 0 }));

    await expect(resolveThresholds({ dir, groundednessDir, log })).rejects.toThrow(
      /artifact\.threshold is outside \(0, 1\]/,
    );
  });
});

// The resolver's error posture. Its stated contract is that a missing
// artifact seeds and a malformed one throws, and each case below holds one
// way to break that.
describe('resolveThresholds error posture', () => {
  let dir: URL;
  let base: string;
  // Its own empty coverage directory, so these cases never read whatever the
  // checkout happens to hold under `groundedness/`.
  let groundednessDir: URL;
  let coverageBase: string;
  let logged: Record<string, unknown>[];
  const log = (entry: Record<string, unknown>): void => void logged.push(entry);

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), 'auracle-posture-'));
    dir = pathToFileURL(`${base}/`);
    coverageBase = await mkdtemp(path.join(tmpdir(), 'auracle-posture-cov-'));
    groundednessDir = pathToFileURL(`${coverageBase}/`);
    logged = [];
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
    await rm(coverageBase, { recursive: true, force: true });
  });

  async function write(name: string, value: unknown): Promise<void> {
    await writeFile(path.join(base, name), JSON.stringify(value));
  }

  it.each([
    // Parses to 1, so a loader that accepts it opens v1.json instead. That is
    // a different file, or none, and a daemon dies on a bare ENOENT.
    ['v01.json'],
    // nextVersion never mints v0.
    ['v0.json'],
    // Rounds to 1e21 and renders back as 'v1e+21.json', which names no file.
    ['v1000000000000000000000.json'],
  ])('refuses %s rather than skipping it', async (name) => {
    await write(name, artifact({ version: 1 }));

    await expect(resolveThresholds({ dir, groundednessDir, log })).rejects.toThrow(
      /not a versioned artifact|too large to read/,
    );
  });

  it('does not let a malformed name shadow a real artifact', async () => {
    // The worst shape of the old bug: a valid v1.json present, and a stray
    // name silently chosen over it.
    await write('v1.json', artifact({ version: 1, threshold: 0.66 }));
    await write('v01.json', artifact({ version: 1 }));

    await expect(resolveThresholds({ dir, groundednessDir, log })).rejects.toThrow(/not a versioned artifact/);
  });

  it('leaves an operator file alone, even one that starts with v', async () => {
    // The fault must not become a denial of service on somebody's own
    // scratch file. highestVersion also feeds nextVersion, so a rule that
    // faulted on any v-shaped name would break `pnpm run calibrate` too.
    await write('v1.json', artifact({ version: 1, threshold: 0.66 }));
    for (const name of ['valid.json', 'vendor.json', 'versions.json', 'notes.txt']) {
      await writeFile(path.join(base, name), '{}');
    }
    await writeFile(path.join(base, '.DS_Store'), '');

    const resolved = await resolveThresholds({ dir, groundednessDir, log });

    expect(resolved.thresholds.agreement).toBe(0.66);
  });

  it('reads a capitalised artifact name, which macOS resolves to the same file', async () => {
    // On a case-insensitive filesystem the writer's own v1.json comes back
    // from readdir as whatever case the entry was created with. Refusing it
    // would make the reader reject the file the writer just produced, with
    // no way out.
    await write('V1.json', artifact({ version: 1, threshold: 0.66 }));

    const resolved = await resolveThresholds({ dir, groundednessDir, log });

    expect(resolved.thresholds.agreement).toBe(0.66);
    expect(resolved.provenance).toMatchObject({ version: 1 });
  });

  it.each([
    ['a directory wearing an artifact name', 'dir'],
    ['a dangling symlink', 'symlink'],
  ])('names the fault for %s rather than raising a bare errno', async (_label, kind) => {
    // The old loader rebuilt the path from the parsed number and read it
    // unguarded, so any of these died at daemon startup with an errno that
    // named neither calibration nor the file.
    const target = path.join(base, 'v1.json');
    if (kind === 'dir') {
      await mkdir(target);
    } else {
      await symlink(path.join(base, 'gone.json'), target);
    }

    await expect(resolveThresholds({ dir, groundednessDir, log })).rejects.toThrow(
      /artifact 'v1\.json' cannot be read/,
    );
  });

  it('refuses the same directory from the loader and from nextVersion', async () => {
    // An earlier pass made nextVersion lenient, on the argument that
    // `pnpm run calibrate` is the way out of a refused directory. It is not:
    // the job mints the next version and writes it, and the loader then
    // refuses the same stray file as before. One posture, and the message
    // names the file to remove.
    await write('v0.json', artifact({ version: 0 }));
    await write('v2.json', artifact({ version: 2 }));

    await expect(resolveThresholds({ dir, groundednessDir, log })).rejects.toThrow(/not a versioned artifact/);
    await expect(nextVersion(dir)).rejects.toThrow(/not a versioned artifact/);
  });

  it('checks the artifact directory before the run spends a model call', async () => {
    // nextVersion runs before the sampling loop. After it, a fault would throw
    // away a run the operator had already paid for. The listing it reads is
    // readable before the first call.
    await write('v0.json', artifact({ version: 0 }));
    const provider = new FakeProvider([]);

    await expect(
      runCalibrationJob({ provider, modelVer: 'm', artifactDir: dir }),
    ).rejects.toThrow(/not a versioned artifact/);

    // Nothing was sampled: the fault was found before the loop.
    expect(provider.calls).toHaveLength(0);
  });

  it('mints the next version once the stray file is gone', async () => {
    await write('v2.json', artifact({ version: 2 }));

    expect(await nextVersion(dir)).toBe(3);
  });

  it.each([[0], [1.5], [Number.NaN], [-1]])(
    'refuses an explicit version of %s instead of naming a file that never existed',
    async (version) => {
      // An explicit branch that builds the name by hand applies no canonical
      // check, and reports 'vNaN.json cannot be read'.
      await expect(loadCalibrationArtifact(version, dir)).rejects.toThrow(
        /must be a positive integer/,
      );
    },
  );

  it('answers null for an explicit version that is absent', async () => {
    await write('v2.json', artifact({ version: 2 }));

    expect(await loadCalibrationArtifact(5, dir)).toBeNull();
  });

  it('never reports a seed over a directory that holds an artifact', async () => {
    // The seeded log line says "no calibration artifact found". Skipping a
    // malformed name made that line false, and an operator who deployed a fit
    // would read a healthy process running the seed (DEC-05, DEC-13).
    await write('v0.json', artifact({ version: 0 }));

    const error = await resolveThresholds({ dir, groundednessDir, log }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(logged.map((entry) => entry['event'])).not.toContain('gate_thresholds_seeded');
  });

  it('refuses an artifact whose file name and contents disagree', async () => {
    // The file is picked by name and the provenance is read from inside it.
    // A copy renamed by hand would run one threshold and report another
    // version, and every log line would name the wrong fit.
    await write('v9.json', artifact({ version: 2, threshold: 0.99 }));

    await expect(resolveThresholds({ dir, groundednessDir, log })).rejects.toThrow(
      /'v9\.json' declares version 2/,
    );
  });

  it('refuses a calibration path that is a file, rather than seeding', async () => {
    const asFile = path.join(base, 'notadir');
    await writeFile(asFile, 'x');

    await expect(
      resolveThresholds({ dir: pathToFileURL(`${asFile}/`), log }),
    ).rejects.toThrow(/cannot be read/);
  });
});

// A fitted gate is one model's judgement, and adopting it under another model
// gates on a number nobody measured (DEC-26). The rule lives beside the
// resolver rather than inside a daemon's main(), so it can be tested at all.
describe('the pins a fitted gate must have been fitted under (DEC-26)', () => {
  const coverage = { modelVer: 'vendor/judge-a', promptVer: 'ground-p1' };
  const agreement = { modelVer: 'vendor/judge-a', promptVer: 'classify-p1' };

  it('reports nothing when both gates match the running pin', () => {
    expect(pinFaults({ coverage, agreement }, 'vendor/judge-a')).toEqual([]);
  });

  it('reports nothing when neither gate was fitted', () => {
    expect(pinFaults({ coverage: null, agreement: null }, 'vendor/anything')).toEqual([]);
  });

  it('reports the coverage gate alone when only it differs', () => {
    const faults = pinFaults({ coverage, agreement: null }, 'vendor/other');
    expect(faults).toHaveLength(1);
    expect(faults[0]).toContain('coverage pair');
    expect(faults[0]).toContain('fit-groundedness');
  });

  // The gate that had no check at all. `fittedPins.agreement` was returned and
  // read by nothing, so an agreement threshold fitted under another model
  // gated every ticket with nothing to say so.
  it('reports the agreement gate alone when only it differs', () => {
    const faults = pinFaults({ coverage: null, agreement }, 'vendor/other');
    expect(faults).toHaveLength(1);
    expect(faults[0]).toContain('agreement threshold');
    expect(faults[0]).toContain('calibrate');
  });

  // Two gates, two faults, never one message covering both (DEC-05).
  it('reports both gates separately when both differ', () => {
    const faults = pinFaults({ coverage, agreement }, 'vendor/other');
    expect(faults).toHaveLength(2);
  });
});
