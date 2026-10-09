// The shared scan, exercised through the label every module passes it.
//
// Three artifact directories read their versions through this one module.
// These cases hold each of them to the same rules.
import { describe, expect, it } from 'vitest';

import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  nextArtifactVersion,
  prepareArtifactDir,
  scanArtifactNames,
} from './versioned.js';

describe('scanArtifactNames', () => {
  it.each([['calibration'], ['gold report'], ['triage']])(
    'names the %s directory in its faults',
    (label) => {
      expect(() => scanArtifactNames(['v01.json'], label)).toThrow(
        new RegExp(`^${label} directory holds`),
      );
    },
  );

  it('returns every artifact, lowest version first', () => {
    expect(scanArtifactNames(['v10.json', 'v2.json', 'v1.json'], 'triage')).toEqual([
      { name: 'v1.json', version: 1 },
      { name: 'v2.json', version: 2 },
      { name: 'v10.json', version: 10 },
    ]);
  });

  it('reads a capitalised name rather than minting over it', () => {
    // A scan that skips 'V5.json' would let the gold report mint version 1
    // over a directory that holds v5. It would then publish v1 while v5 sits
    // unread.
    expect(scanArtifactNames(['V5.json'], 'gold report')).toEqual([
      { name: 'V5.json', version: 5 },
    ]);
  });

  it('refuses a leading zero rather than rebuilding a different name', () => {
    // 'v05.json' parsed to 5, and the loader then opened 'v5.json' — a
    // different file, or none, reported as a bare error code.
    expect(() => scanArtifactNames(['v05.json'], 'gold report')).toThrow(
      /not a versioned artifact/,
    );
  });

  it('refuses a version too large to read back', () => {
    // 'v9007199254740993.json' minted 9007199254740992: the number rounded.
    expect(() =>
      scanArtifactNames(['v9007199254740993.json'], 'triage'),
    ).toThrow(/too large to read/);
  });

  it('refuses two spellings of one version', () => {
    expect(() => scanArtifactNames(['v1.json', 'V1.json'], 'triage')).toThrow(
      /2 files for version 1/,
    );
  });

  it('leaves an operator file alone', () => {
    expect(scanArtifactNames(['vendor.json', 'v1.json'], 'triage')).toEqual([
      { name: 'v1.json', version: 1 },
    ]);
  });
});

/**
 * Whether a mode bit can actually deny this process.
 *
 * `chmod 0o500` does not deny root, so the two cases below would assert a
 * rejection that cannot happen and pass for the wrong reason. Cloud agents
 * and CI containers commonly run as root. Skipping is honest; passing is not.
 *
 * Taken as a parameter so both branches are testable off a non-root machine:
 * the skip itself is the thing that has to be right, and a constant computed
 * at module load can only ever be observed on one side.
 */
export function deniesPermission(getuid: (() => number) | undefined): boolean {
  return getuid === undefined || getuid() !== 0;
}

const DENIES_PERMISSION = deniesPermission(process.getuid?.bind(process));

describe('the root skip for the permission cases', () => {
  it('does not deny root, so those cases must skip', () => {
    expect(deniesPermission(() => 0)).toBe(false);
  });

  it('denies an ordinary user, so those cases must run', () => {
    expect(deniesPermission(() => 501)).toBe(true);
  });

  it('treats a platform without getuid as able to deny', () => {
    // Windows has no getuid; the assertion is meaningful there.
    expect(deniesPermission(undefined)).toBe(true);
  });

  it('decides the skip from this process, not from a literal', () => {
    // The three cases above pass literals, so they all still pass if the
    // constant is rewritten as `deniesPermission(() => 0)` — and both
    // permission cases would then skip silently and permanently, for CI as
    // well. That is the wrong version this suite exists to catch, so the
    // constant itself is asserted against the live process.
    expect(DENIES_PERMISSION).toBe(process.getuid === undefined || process.getuid() !== 0);
  });
});

describe('prepareArtifactDir', () => {
  it.runIf(DENIES_PERMISSION)('faults on a directory it cannot create, before the caller spends', async () => {
    // Listing alone passed a readable but unwritable directory, so the run
    // died at the write instead — the cost the pre-check exists to avoid.
    const base = await mkdtemp(path.join(tmpdir(), 'auracle-ro-'));
    const outer = path.join(base, 'out');
    await mkdir(outer);
    await chmod(outer, 0o500);
    try {
      await expect(
        prepareArtifactDir(pathToFileURL(`${outer}/nested/`), 'gold report'),
      ).rejects.toThrow(/cannot be created \(EACCES\)/);
    } finally {
      await chmod(outer, 0o700);
      await rm(base, { recursive: true, force: true });
    }
  });

  it.runIf(DENIES_PERMISSION)('faults on an existing directory it cannot write to', async () => {
    // The case the fix first missed. `mkdir` with `recursive` resolves
    // without inspecting the mode when the path already exists, so creating
    // the directory proved nothing about writing to it.
    const base = await mkdtemp(path.join(tmpdir(), 'auracle-ro2-'));
    const dir = path.join(base, 'out');
    await mkdir(dir);
    await chmod(dir, 0o500);
    try {
      await expect(
        prepareArtifactDir(pathToFileURL(`${dir}/`), 'calibration'),
      ).rejects.toThrow(/is not writable \(EACCES\)/);
    } finally {
      await chmod(dir, 0o700);
      await rm(base, { recursive: true, force: true });
    }
  });

  it('creates an absent directory, so the job writes into one that exists', async () => {
    // The previous version asserted nextArtifactVersion === 1, which an
    // absent directory already answers. It could not fail.
    const base = await mkdtemp(path.join(tmpdir(), 'auracle-mk-'));
    try {
      const created = path.join(base, 'fresh');
      const dir = pathToFileURL(`${created}/`);

      await prepareArtifactDir(dir, 'triage');

      expect(existsSync(created)).toBe(true);
      expect(await nextArtifactVersion(dir, 'triage')).toBe(1);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
