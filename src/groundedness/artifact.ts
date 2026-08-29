// Versioned groundedness-threshold artifact (section 4.7, DEC-05, DEC-31).
//
// Its own directory, not the calibration one. Both kinds are named v<n>.json
// and the loader picks by version, so sharing a directory would make one kind
// load the other and fail on the artifact field. Separate directories keep
// each kind's version line its own.
//
// DEC-05: this file records no agreement value. The two gates are fitted by
// two jobs into two artifacts, and nothing joins them.

import { mkdir, writeFile } from 'node:fs/promises';

import {
  assertVersionArg,
  listArtifacts,
  nextArtifactVersion,
  prepareArtifactDir,
  readArtifactText,
} from '../artifacts/versioned.js';
import type { ArtifactFile } from '../artifacts/versioned.js';

const LABEL = 'groundedness';
const ARTIFACT_NAME = 'groundedness-thresholds';

export interface ThresholdInterval {
  confidence: number;
  lower: number;
  upper: number;
}

/** Measured coverage per difficulty grade, so an easy-only fit is visible. */
export interface GradeRecord {
  grade: string;
  drafts: number;
  mean_coverage: number;
}

export interface GroundednessArtifact {
  artifact: 'groundedness-thresholds';
  version: number;
  fitted_at: string;
  /** DEC-18: the shipped gold set is synthetic only. */
  gold_source: 'synthetic';
  /** DEC-31: the fit consumed the fit half only. */
  split_used: 'fit';
  /** Drafts the fit consumed. */
  fit_drafts: number;
  /** DEC-26 pins in force during the run. */
  prompt_ver: string;
  model_ver: string;
  /** The floor each threshold was fitted against. They answer different questions. */
  target_precision: number;
  target_npv: number;
  /** Below this, block. Fitted on negative predictive value. */
  block: number;
  block_npv: number;
  /**
   * Drafts the block value was measured over.
   *
   * The lowest qualifying threshold has the smallest below-set, so its
   * interval is the widest by construction. Without this a reader sees a
   * negative predictive value of 1.0 and cannot tell it came from a handful
   * of drafts.
   */
  block_drafts: number;
  block_interval: ThresholdInterval;
  /** Below this, send to a person. Fitted on precision. */
  review: number;
  review_precision: number;
  review_coverage: number;
  review_interval: ThresholdInterval;
  by_grade: GradeRecord[];
}

export function validateGroundednessArtifact(raw: unknown): GroundednessArtifact {
  assert(isRecord(raw), 'artifact is not an object');
  assert(raw['artifact'] === ARTIFACT_NAME, `artifact.artifact is not ${ARTIFACT_NAME}`);
  const version = raw['version'];
  assert(
    typeof version === 'number' && Number.isInteger(version) && version >= 1,
    'artifact.version is not a positive integer',
  );
  assert(
    typeof raw['fitted_at'] === 'string' && !Number.isNaN(Date.parse(raw['fitted_at'])),
    'artifact.fitted_at is not a valid timestamp',
  );
  assert(raw['gold_source'] === 'synthetic', 'artifact.gold_source is not synthetic (DEC-18)');
  assert(raw['split_used'] === 'fit', 'artifact.split_used is not the fit half (DEC-31)');
  assert(
    typeof raw['fit_drafts'] === 'number' && Number.isInteger(raw['fit_drafts']) && raw['fit_drafts'] > 0,
    'artifact.fit_drafts is not a positive integer',
  );
  for (const field of ['prompt_ver', 'model_ver'] as const) {
    assert(typeof raw[field] === 'string' && (raw[field] as string).length > 0, `artifact.${field} is missing`);
  }
  for (const field of ['target_precision', 'target_npv'] as const) {
    const value = raw[field];
    assert(typeof value === 'number' && value > 0 && value <= 1, `artifact.${field} is outside (0, 1]`);
  }
  assert(
    typeof raw['block_drafts'] === 'number'
      && Number.isInteger(raw['block_drafts'])
      && (raw['block_drafts'] as number) > 0,
    'artifact.block_drafts is not a positive integer',
  );
  for (const field of ['block', 'review', 'block_npv', 'review_precision', 'review_coverage'] as const) {
    const value = raw[field];
    assert(typeof value === 'number' && value >= 0 && value <= 1, `artifact.${field} is outside [0, 1]`);
  }
  // The order the engine depends on. Below block it escalates and below
  // review it gates, so an inverted pair has no review band at all.
  assert(
    (raw['block'] as number) < (raw['review'] as number),
    `artifact.block ${String(raw['block'])} does not sit below review ${String(raw['review'])}; `
      + 'an equal pair leaves no band for a person to review',
  );
  assertInterval(raw['block_interval'], 'block_interval');
  assertInterval(raw['review_interval'], 'review_interval');
  const grades = raw['by_grade'];
  assert(Array.isArray(grades) && grades.length > 0, 'artifact.by_grade is empty');
  for (const [i, entry] of grades.entries()) {
    assert(isRecord(entry), `by_grade ${i} is not an object`);
    assert(typeof entry['grade'] === 'string' && entry['grade'].length > 0, `by_grade ${i} has no grade`);
    assert(
      typeof entry['drafts'] === 'number' && Number.isInteger(entry['drafts']) && entry['drafts'] > 0,
      `by_grade ${i} has no positive draft count`,
    );
    const mean = entry['mean_coverage'];
    assert(typeof mean === 'number' && mean >= 0 && mean <= 1, `by_grade ${i} mean_coverage is outside [0, 1]`);
  }
  // DEC-05: an agreement value here would mean the two gates were fitted
  // together, which is the one thing the decision forbids.
  assert(!('agreement' in raw), 'artifact carries an agreement value; the gates are independent (DEC-05)');
  return raw as unknown as GroundednessArtifact;
}

/** Resolved against this module's location so src and dist both reach <repo>/groundedness/. */
export function defaultGroundednessDir(): URL {
  return new URL('../../groundedness/', import.meta.url);
}

function withTrailingSlash(dir: URL): URL {
  return dir.href.endsWith('/') ? dir : new URL(`${dir.href}/`);
}

export async function writeGroundednessArtifact(
  artifact: GroundednessArtifact,
  dir: URL = defaultGroundednessDir(),
): Promise<void> {
  const validated = validateGroundednessArtifact(artifact);
  const base = withTrailingSlash(dir);
  await mkdir(base, { recursive: true });
  await writeFile(new URL(`v${validated.version}.json`, base), JSON.stringify(validated, null, 2) + '\n');
}

export async function loadGroundednessArtifact(
  version?: number,
  dir: URL = defaultGroundednessDir(),
): Promise<GroundednessArtifact | null> {
  const base = withTrailingSlash(dir);
  const all = await listArtifacts(base, LABEL);
  let found: ArtifactFile | null;
  if (version === undefined) {
    found = all.at(-1) ?? null;
  } else {
    assertVersionArg(version, LABEL);
    found = all.find((entry) => entry.version === version) ?? null;
  }
  if (found === null) return null;
  const artifact = validateGroundednessArtifact(JSON.parse(await readArtifactText(base, found, LABEL)));
  if (artifact.version !== found.version) {
    throw new Error(
      `groundedness artifact '${found.name}' declares version ${artifact.version}; `
        + 'the file name and its contents must agree',
    );
  }
  return artifact;
}

/** Fault on a directory that would fault at the write, before the job spends. */
export async function assertGroundednessDirUsable(dir: URL): Promise<void> {
  await prepareArtifactDir(withTrailingSlash(dir), LABEL);
}

export async function nextVersion(dir: URL): Promise<number> {
  return nextArtifactVersion(withTrailingSlash(dir), LABEL);
}

function assertInterval(value: unknown, field: string): void {
  assert(isRecord(value), `artifact.${field} is not an object`);
  const conf = value['confidence'];
  assert(typeof conf === 'number' && conf > 0 && conf < 1, `${field}.confidence is not a fraction below 1`);
  for (const bound of ['lower', 'upper'] as const) {
    const v = value[bound];
    assert(typeof v === 'number' && v >= 0 && v <= 1, `${field}.${bound} is outside [0, 1]`);
  }
}

function assert(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(`groundedness artifact validation failed: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
