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
import { resolveThresholds } from './resolve.js';
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
    fit_half_digest: null,
    report_half_digest: null,
    prompt_ver: 'classify-p1',
    model_ver: 'stealth/ox-alpha',
    target_precision: 0.985,
    threshold: 0.78,
    precision_at_threshold: 0.99,
    coverage_at_threshold: 0.6,
    interval: { confidence: 0.95, lower: 0.97, upper: 1 },
    ...overrides,
  } as CalibrationArtifact;
}

describe('resolveThresholds (DEC-05, DEC-13, DEC-31)', () => {
  let dir: URL;
  let base: string;
  let logged: Record<string, unknown>[];
  const log = (entry: Record<string, unknown>): void => void logged.push(entry);

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), 'auracle-resolve-'));
    dir = pathToFileURL(`${base}/`);
    logged = [];
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  async function write(value: unknown, version = 1): Promise<void> {
    await writeFile(path.join(base, `v${version}.json`), JSON.stringify(value));
  }

  it('adopts the fitted agreement threshold when an artifact exists', async () => {
    await write(artifact({ threshold: 0.78 }));

    const resolved = await resolveThresholds({ dir, log });

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

    const resolved = await resolveThresholds({ dir, log });

    expect(resolved.thresholds.agreement).toBe(0.72);
    expect(resolved.provenance).toMatchObject({ version: 2 });
  });

  it('keeps the groundedness seeds, which no job fits yet (DEC-05)', async () => {
    // The two gates are independent, so fitting one moves neither of the
    // other's numbers. A blended resolver would move all three together.
    await write(artifact({ threshold: 0.78 }));

    const resolved = await resolveThresholds({ dir, log });

    expect(resolved.thresholds.groundednessBlock).toBe(SEED_THRESHOLDS.groundednessBlock);
    expect(resolved.thresholds.groundednessReview).toBe(SEED_THRESHOLDS.groundednessReview);
  });

  it('adopts the seeds when no artifact exists, and says so', async () => {
    const resolved = await resolveThresholds({ dir, log });

    expect(resolved.thresholds).toEqual(SEED_THRESHOLDS);
    expect(resolved.provenance).toEqual({ source: 'seed' });
    // The whole point of the issue: an operator can tell a seeded gate from a
    // fitted one by reading the log, not by reading the source.
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      event: 'gate_thresholds_seeded',
      agreement: SEED_THRESHOLDS.agreement,
      groundedness_block: SEED_THRESHOLDS.groundednessBlock,
      groundedness_review: SEED_THRESHOLDS.groundednessReview,
    });
  });

  it('says which artifact it adopted when one exists', async () => {
    await write(artifact({ threshold: 0.78 }));

    await resolveThresholds({ dir, log });

    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      event: 'gate_thresholds_fitted',
      version: 1,
      agreement: 0.78,
      scope: 'all_turns',
    });
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

    const resolved = await resolveThresholds({ dir, log });

    expect(resolved.thresholds.agreement).toBe(0.71);
    expect(resolved.provenance).toMatchObject({ source: 'calibration', goldSource: 'real' });
    expect(logged[0]).toMatchObject({
      event: 'gate_thresholds_fitted',
      gold_source: 'real',
    });
    // Never a seed line: a fitted number must not read as an unfitted one.
    expect(logged[0]).not.toMatchObject({ event: 'gate_thresholds_seeded' });
  });

  it('names the provenance of a synthetic fit too', async () => {
    await write(artifact({ threshold: 0.78 }));
    await resolveThresholds({ dir, log });
    expect(logged[0]).toMatchObject({ gold_source: 'synthetic' });
  });

  // Null digests mean the committed corpus. A real artifact declaring them
  // would be a threshold whose DEC-31 proof is absent, adopted at startup
  // with the field that would reveal the gap asserting the opposite.
  it('refuses a real artifact that names no proved pair (DEC-31)', async () => {
    await write(artifact({ gold_source: 'real', threshold: 0.71 }));
    await expect(resolveThresholds({ dir, log })).rejects.toThrow(/must name the pair it proved/);
  });

  it('refuses a provenance outside the closed set', async () => {
    await write(artifact({ gold_source: 'imap' as CalibrationArtifact['gold_source'] }));
    await expect(resolveThresholds({ dir, log })).rejects.toThrow(/gold_source/);
  });

  it('refuses an artifact fitted on the report half (DEC-31)', async () => {
    // Selection on the test data. The validator owns this rule; the case
    // proves the resolver does not route around it.
    await write(artifact({ split_used: 'report' as CalibrationArtifact['split_used'] }));

    await expect(resolveThresholds({ dir, log })).rejects.toThrow(/split_used/);
  });

  it('refuses a corrupt artifact rather than falling back to seeds', async () => {
    // A missing artifact is an ordinary state. A broken one is a fault, and
    // treating it as "not calibrated" would hide a truncated write behind a
    // gate that still looks healthy.
    await write({ artifact: 'agreement-threshold', version: 1 });

    await expect(resolveThresholds({ dir, log })).rejects.toThrow(/validation failed/);
  });

  it('refuses an artifact whose threshold is outside (0, 1]', async () => {
    await write(artifact({ threshold: 1.5 }));

    await expect(resolveThresholds({ dir, log })).rejects.toThrow(/threshold/);
  });

  it('refuses a threshold of zero at the artifact boundary, not inside a daemon', async () => {
    // A gate at zero passes every ticket. The validator used to accept it and
    // makeThresholds refused it later, so a file that validated still stopped
    // a process that had already read it.
    await write(artifact({ threshold: 0 }));

    await expect(resolveThresholds({ dir, log })).rejects.toThrow(
      /artifact\.threshold is outside \(0, 1\]/,
    );
  });
});

// Findings from an adversarial pass over the resolver's error posture. Its
// stated contract is that a missing artifact seeds and a malformed one
// throws; each case below used to do neither.
describe('resolveThresholds error posture', () => {
  let dir: URL;
  let base: string;
  let logged: Record<string, unknown>[];
  const log = (entry: Record<string, unknown>): void => void logged.push(entry);

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), 'auracle-posture-'));
    dir = pathToFileURL(`${base}/`);
    logged = [];
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  async function write(name: string, value: unknown): Promise<void> {
    await writeFile(path.join(base, name), JSON.stringify(value));
  }

  it.each([
    // Parses to 1, so the loader used to open v1.json instead: a different
    // file, or none, and a daemon died on a bare ENOENT.
    ['v01.json'],
    // nextVersion never mints v0.
    ['v0.json'],
    // Rounds to 1e21 and renders back as 'v1e+21.json', which names no file.
    ['v1000000000000000000000.json'],
  ])('refuses %s rather than skipping it', async (name) => {
    await write(name, artifact({ version: 1 }));

    await expect(resolveThresholds({ dir, log })).rejects.toThrow(
      /not a versioned artifact|too large to read/,
    );
  });

  it('does not let a malformed name shadow a real artifact', async () => {
    // The worst shape of the old bug: a valid v1.json present, and a stray
    // name silently chosen over it.
    await write('v1.json', artifact({ version: 1, threshold: 0.66 }));
    await write('v01.json', artifact({ version: 1 }));

    await expect(resolveThresholds({ dir, log })).rejects.toThrow(/not a versioned artifact/);
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

    const resolved = await resolveThresholds({ dir, log });

    expect(resolved.thresholds.agreement).toBe(0.66);
  });

  it('reads a capitalised artifact name, which macOS resolves to the same file', async () => {
    // On a case-insensitive filesystem the writer's own v1.json comes back
    // from readdir as whatever case the entry was created with. Refusing it
    // would make the reader reject the file the writer just produced, with
    // no way out.
    await write('V1.json', artifact({ version: 1, threshold: 0.66 }));

    const resolved = await resolveThresholds({ dir, log });

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

    await expect(resolveThresholds({ dir, log })).rejects.toThrow(
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

    await expect(resolveThresholds({ dir, log })).rejects.toThrow(/not a versioned artifact/);
    await expect(nextVersion(dir)).rejects.toThrow(/not a versioned artifact/);
  });

  it('checks the artifact directory before the run spends a model call', async () => {
    // nextVersion used to run after the sampling loop, so a fault threw away
    // a run the operator had already paid for over a listing that was
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
      // The explicit branch used to build the name by hand, so it applied no
      // canonical check and reported 'vNaN.json cannot be read'.
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

    const error = await resolveThresholds({ dir, log }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(logged.map((entry) => entry['event'])).not.toContain('gate_thresholds_seeded');
  });

  it('refuses an artifact whose file name and contents disagree', async () => {
    // The file is picked by name and the provenance is read from inside it.
    // A copy renamed by hand would run one threshold and report another
    // version, and every log line would name the wrong fit.
    await write('v9.json', artifact({ version: 2, threshold: 0.99 }));

    await expect(resolveThresholds({ dir, log })).rejects.toThrow(
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
