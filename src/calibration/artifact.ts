// Versioned calibration artifact (section 4.11, DEC-13, DEC-31).
//
// The calibration job writes its fitted threshold here; classifier config
// consumers load it. Each run writes a new version file (v1.json, v2.json,
// ...) so the history of the one global threshold stays inspectable.
// Loading picks the highest version and validates what it reads, mirroring
// src/fixtures/load.ts: a broken artifact fails fast instead of silently
// moving a live gate.

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';

export interface CalibrationInterval {
  confidence: number;
  lower: number;
  upper: number;
}

export interface CalibrationArtifact {
  /** Discriminates this artifact kind from other config artifacts. */
  artifact: 'agreement-threshold';
  /** Monotonic version; each run of the job mints the next one. */
  version: number;
  /** ISO timestamp of the fitting run. */
  fitted_at: string;
  /** DEC-18: the shipped gold set is synthetic only. */
  gold_source: 'synthetic';
  /** DEC-31: the fit consumed the fit half only. */
  split_used: 'fit';
  /** Number of fit-half tickets the fit consumed. */
  fit_tickets: number;
  /** DEC-26 pins in force during the run. */
  prompt_ver: string;
  model_ver: string;
  target_precision: number;
  threshold: number;
  precision_at_threshold: number;
  coverage_at_threshold: number;
  interval: CalibrationInterval;
}

const ARTIFACT_NAME = 'agreement-threshold';

/** Resolved against this module's location so src and dist both reach <repo>/calibration/. */
export function defaultCalibrationDir(): URL {
  return new URL('../../calibration/', import.meta.url);
}

function withTrailingSlash(dir: URL): URL {
  return dir.href.endsWith('/') ? dir : new URL(`${dir.href}/`);
}

/** Validate an unknown value as a calibration artifact. Exported for tests
 * and for consumers that read artifacts through their own transport. */
export function validateCalibrationArtifact(raw: unknown): CalibrationArtifact {
  assert(isRecord(raw), 'artifact is not an object');
  assert(
    raw['artifact'] === ARTIFACT_NAME,
    `artifact.artifact is ${String(raw['artifact'])}, expected ${ARTIFACT_NAME}`,
  );
  const version = raw['version'];
  assert(typeof version === 'number' && Number.isInteger(version) && version >= 1, 'artifact.version is not a positive integer');
  assert(typeof raw['fitted_at'] === 'string' && !Number.isNaN(Date.parse(raw['fitted_at'])), 'artifact.fitted_at is not a valid timestamp');
  assert(raw['gold_source'] === 'synthetic', 'artifact.gold_source is not synthetic (DEC-18)');
  // DEC-31 as code: an artifact fitted on any other split must not load.
  assert(raw['split_used'] === 'fit', 'artifact.split_used is not the fit half (DEC-31)');
  assert(
    typeof raw['fit_tickets'] === 'number' && Number.isInteger(raw['fit_tickets']) && raw['fit_tickets'] > 0,
    'artifact.fit_tickets is not a positive integer',
  );
  assert(typeof raw['prompt_ver'] === 'string' && raw['prompt_ver'].length > 0, 'artifact.prompt_ver is missing');
  assert(typeof raw['model_ver'] === 'string' && raw['model_ver'].length > 0, 'artifact.model_ver is missing');
  const target = raw['target_precision'];
  assert(typeof target === 'number' && target > 0 && target <= 1, 'artifact.target_precision is outside (0, 1]');
  assertThresholdField(raw['threshold'], 'threshold');
  assertThresholdField(raw['precision_at_threshold'], 'precision_at_threshold');
  assertThresholdField(raw['coverage_at_threshold'], 'coverage_at_threshold');
  const interval = raw['interval'];
  assert(isRecord(interval), 'artifact.interval is not an object');
  assert(typeof interval['confidence'] === 'number' && interval['confidence'] > 0 && interval['confidence'] < 1, 'interval.confidence is not a fraction below 1');
  assertThresholdField(interval['lower'], 'interval.lower');
  assertThresholdField(interval['upper'], 'interval.upper');
  assert(
    (interval['lower'] as number) <= (raw['precision_at_threshold'] as number) &&
      (raw['precision_at_threshold'] as number) <= (interval['upper'] as number),
    'interval does not bracket precision_at_threshold',
  );
  return raw as unknown as CalibrationArtifact;
}

/** Write the artifact as v<version>.json under dir (defaults to <repo>/calibration/).
 * Creates the directory when absent, so a first run on a fresh checkout works. */
export async function writeCalibrationArtifact(
  artifact: CalibrationArtifact,
  dir: URL = defaultCalibrationDir(),
): Promise<void> {
  const validated = validateCalibrationArtifact(artifact);
  const base = withTrailingSlash(dir);
  await mkdir(base, { recursive: true });
  await writeFile(new URL(`v${validated.version}.json`, base), JSON.stringify(validated, null, 2) + '\n');
}

/**
 * Load a calibration artifact by version, or the highest version when no
 * version is given. Returns null when nothing has been calibrated yet —
 * callers fall back to the seed GATE_AGREEMENT.
 */
export async function loadCalibrationArtifact(
  version?: number,
  dir: URL = defaultCalibrationDir(),
): Promise<CalibrationArtifact | null> {
  const base = withTrailingSlash(dir);
  const target = version ?? (await highestVersion(base));
  if (target === null) return null;
  const text = await readFile(new URL(`v${target}.json`, base), 'utf8');
  return validateCalibrationArtifact(JSON.parse(text));
}

async function highestVersion(base: URL): Promise<number | null> {
  let names: string[];
  try {
    names = await readdir(base);
  } catch (err) {
    // An absent directory means nothing has been calibrated yet.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let max: number | null = null;
  for (const name of names) {
    const match = /^v(\d+)\.json$/.exec(name);
    if (!match) continue;
    const version = Number(match[1]);
    if (max === null || version > max) max = version;
  }
  return max;
}

/** Mint the next version number by scanning existing artifacts under dir. */
export async function nextVersion(dir: URL): Promise<number> {
  const current = await highestVersion(withTrailingSlash(dir));
  return current === null ? 1 : current + 1;
}

function assert(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(`calibration artifact validation failed: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertThresholdField(value: unknown, field: string): void {
  assert(typeof value === 'number' && value >= 0 && value <= 1, `artifact.${field} is outside [0, 1]`);
}
