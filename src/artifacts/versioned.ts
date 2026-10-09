// One version scan for every artifact directory this repository writes.
//
// Three modules each mint `v<n>.json` and read the highest one back:
// calibration, the gold report and triage. They carried three copies of the
// scan, and only one of them was hardened. The copies then differed
// on every rule that mattered, and the unhardened ones still rebuilt the file
// name from the parsed number — the defect that made a stray file shadow a
// real artifact and stop a process with a bare error code.
//
// Each rule below guards against a defect that occurred.

import { constants } from 'node:fs';
import { access, mkdir, readFile, readdir } from 'node:fs/promises';

/** A canonical artifact file name and the version it spells. */
export interface ArtifactFile {
  readonly name: string;
  readonly version: number;
}

/**
 * Every artifact in a directory listing, lowest version first.
 *
 * Pure, and exported, because the interesting cases are platform-specific and
 * a test cannot build them. A case-sensitive filesystem holds 'v1.json' and
 * 'V1.json' as two entries; a case-insensitive one cannot. Taking the names
 * as an argument makes both reachable from any machine — this repository is
 * developed on macOS and tested on Linux, and a defect once reached HEAD that
 * no local run could fail on.
 *
 * Rules:
 *
 * - The digits spell the version exactly, with no leading zero. A name that
 *   parses to a number it does not spell sends a reader to a different file.
 * - The match is case-insensitive, because a case-insensitive filesystem
 *   keeps the entry name it was created with while the writer writes
 *   lowercase into it. Refusing that name refuses a real artifact.
 * - Two names for one version is a fault. Both parse to the same number and
 *   nothing downstream records which file was read, so the listing order
 *   would decide it.
 * - A name that looks like an artifact and is not one is a fault, not an
 *   absence. Reporting "nothing here" over a directory that holds an artifact
 *   hides it.
 * - A name that is not artifact-shaped belongs to the operator. A
 *   `vendor.json` must not stop a process.
 */
export function scanArtifactNames(
  names: readonly string[],
  label: string,
): ArtifactFile[] {
  const byVersion = new Map<number, string[]>();
  for (const name of names) {
    const canonical = /^v([1-9]\d*)\.json$/i.exec(name);
    if (canonical !== null) {
      const version = Number(canonical[1]);
      if (!Number.isSafeInteger(version)) {
        throw new Error(
          `${label} artifact '${name}' names a version too large to read; `
            + 'remove it or rename it to the version it holds',
        );
      }
      byVersion.set(version, [...(byVersion.get(version) ?? []), name]);
      continue;
    }
    if (/^v\d.*\.json$/i.test(name)) {
      throw new Error(
        `${label} directory holds '${name}', which is not a versioned artifact; `
          + 'artifacts are named v1.json, v2.json and so on',
      );
    }
  }

  const found: ArtifactFile[] = [];
  for (const [version, matches] of byVersion) {
    // Checked for every version, not only the running maximum: a collision on
    // a lower version is the same ambiguity and the same wrong answer once
    // that version is asked for by name.
    if (matches.length > 1) {
      throw new Error(
        `${label} directory holds ${matches.length} files for version ${version} `
          + `(${[...matches].sort().join(', ')}); nothing records which one was read, `
          + 'so the listing order would decide it. Keep one.',
      );
    }
    found.push({ name: matches[0] as string, version });
  }
  return found.sort((a, b) => a.version - b.version);
}

/**
 * Every artifact under a directory. An absent directory answers an empty
 * list, because nothing has been written yet. Anything else is a fault: a
 * file where the directory should be, or a revoked permission, read as
 * "nothing here" would hide an artifact that exists.
 */
export async function listArtifacts(base: URL, label: string): Promise<ArtifactFile[]> {
  let names: string[];
  try {
    names = await readdir(base);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    throw new Error(
      `${label} directory ${base.pathname} cannot be read (${code ?? 'unknown error'})`,
      { cause: err },
    );
  }
  return scanArtifactNames(names, label);
}

/** The highest-versioned artifact under a directory, or null when there is none. */
export async function latestArtifact(base: URL, label: string): Promise<ArtifactFile | null> {
  const found = await listArtifacts(base, label);
  return found.at(-1) ?? null;
}

/**
 * Read one artifact's text by the name the directory gave it.
 *
 * Never by a name rebuilt from the version: rebuilding is what let 'v01.json'
 * open 'v1.json'. A name that survived the scan and then cannot be read is a
 * fault — a dangling symlink, a directory wearing the name, a revoked
 * permission — and a bare error code names neither the artifact nor the file.
 */
export async function readArtifactText(
  base: URL,
  found: ArtifactFile,
  label: string,
): Promise<string> {
  try {
    return await readFile(new URL(found.name, base), 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(
      `${label} artifact '${found.name}' cannot be read (${code ?? 'unknown error'}); `
        + 'remove it or restore the file it should be',
      { cause: err },
    );
  }
}

/** Refuse a version argument that names no file this module could have written. */
export function assertVersionArg(version: number, label: string): void {
  if (!(Number.isSafeInteger(version) && version >= 1)) {
    throw new Error(`${label} version must be a positive integer, got ${String(version)}`);
  }
}

/**
 * Prepare the output directory before a job spends anything.
 *
 * Creates it the way the writer does, proves it is writable, and scans it.
 *
 * Listing alone was not enough: a readable but unwritable directory passed
 * and the run still died at the write. Creating it is not enough either —
 * `mkdir` with `recursive` resolves without inspecting the mode when the
 * path already exists as a directory, so a mode-500 output directory passed
 * that too. The write permission is what the job needs, so it is what is
 * checked.
 *
 * This narrows the race rather than closing it. Minting the version reads the
 * directory a second time, after the loop, so a file dropped in mid-run still
 * costs the run. What it removes is a directory that was already unusable
 * before the first model call.
 */
export async function prepareArtifactDir(base: URL, label: string): Promise<void> {
  try {
    await mkdir(base, { recursive: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(
      `${label} directory ${base.pathname} cannot be created (${code ?? 'unknown error'})`,
      { cause: err },
    );
  }
  try {
    await access(base, constants.W_OK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(
      `${label} directory ${base.pathname} is not writable (${code ?? 'unknown error'}); `
        + 'the job would fault at the write, after it had spent',
      { cause: err },
    );
  }
  await listArtifacts(base, label);
}

/** The next version to mint. Strict: a directory it cannot read is a fault. */
export async function nextArtifactVersion(base: URL, label: string): Promise<number> {
  const latest = await latestArtifact(base, label);
  return latest === null ? 1 : latest.version + 1;
}
