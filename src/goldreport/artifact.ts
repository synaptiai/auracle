// Versioned gold report artifact (method 2, section 4.10, DEC-31).
//
// The report job writes the README numbers here. Each run mints a new
// version file (v1.json, v2.json, ...) so the published numbers stay
// inspectable over time. Structure and validation mirror
// src/calibration/artifact.ts: a broken artifact fails fast instead of
// quietly changing a published number.

import { mkdir, writeFile } from 'node:fs/promises';

import {
  prepareArtifactDir,
  assertVersionArg,
  listArtifacts,
  nextArtifactVersion,
  readArtifactText,
} from '../artifacts/versioned.js';
import type { ArtifactFile } from '../artifacts/versioned.js';

/** Names this artifact kind in every fault message. */
const LABEL = 'gold report';

import { CALIBRATION_SCOPES } from '../calibration/artifact.js';
import type { RateWithInterval } from './score.js';

export interface GoldReportArtifact {
  /** Discriminates this artifact kind from other config artifacts. */
  artifact: 'gold-report';
  /** Monotonic version; each run of the job mints the next one. */
  version: number;
  /** ISO timestamp of the scoring run. */
  generated_at: string;
  /**
   * Section 4.10 method 2, the method that supplies the README numbers.
   *
   * The value names the method slot, not the scorer. It does not claim a
   * person graded this run. Read `scored_by` for who actually did.
   */
  method: 'human-review';
  /**
   * Who produced the numbers, as distinct from the method slot above.
   *
   * `stub` means the offline stub answered every call, so the figures
   * exercise the pipeline and measure no answer quality. `model` means a
   * real provider scored the run.
   *
   * The field exists because `method` alone misleads a reader who parses
   * this file and never sees the README. A consumer that publishes a number
   * must check this field first.
   */
  scored_by: 'stub' | 'model';
  /** DEC-18: the shipped gold set is synthetic only. */
  gold_source: 'synthetic';
  /** DEC-31: every number below comes from the report half only. */
  split_used: 'report';
  /**
   * DEC-39: the population scored. Replay scores first turns only, so a
   * reader can tell what the number covers without reading the job.
   */
  scope: 'first_turn';
  /** Number of report-half tickets scored. */
  report_tickets: number;
  /** DEC-26 pins in force during the run. */
  prompt_ver: string;
  model_ver: string;
  /** The agreement threshold the policy applied. */
  gate_agreement: number;
  /**
   * Where `gate_agreement` came from.
   *
   * 'seed' is the documented section 4.5 value; 'calibration' names the
   * artifact version that produced it. Without this a reader cannot tell a
   * fitted run from a seeded one, and the two publish different numbers.
   */
  gate_source: 'seed' | 'calibration';
  /** The calibration artifact version behind `gate_agreement`. Null when seeded. */
  gate_calibration_version: number | null;
  /**
   * The turn population the threshold was fitted on. Null when seeded.
   *
   * `scope` above names the population this report SCORED, which DEC-39 fixes
   * at first turns. The threshold may come from a fit over every turn, and a
   * reader who saw only one of the two would attribute the number wrongly.
   */
  gate_calibration_scope: string | null;
  action_match: RateWithInterval;
  containment: RateWithInterval;
  /** Indication-only risk-tier slices; never publishable (section 4.10). */
  strata: {
    risk_tier: string;
    tickets: number;
    action_match: RateWithInterval;
    containment: RateWithInterval;
    publishable: false;
  }[];
}

const ARTIFACT_NAME = 'gold-report';

/** Resolved against this module's location so src and dist both reach <repo>/gold-report/. */
export function defaultGoldReportDir(): URL {
  return new URL('../../gold-report/', import.meta.url);
}

function withTrailingSlash(dir: URL): URL {
  return dir.href.endsWith('/') ? dir : new URL(`${dir.href}/`);
}

/** Validate an unknown value as a gold report artifact. Exported for tests
 * and for consumers that read artifacts through their own transport. */
export function validateGoldReportArtifact(raw: unknown): GoldReportArtifact {
  assert(isRecord(raw), 'artifact is not an object');
  assert(
    raw['artifact'] === ARTIFACT_NAME,
    `artifact.artifact is ${String(raw['artifact'])}, expected ${ARTIFACT_NAME}`,
  );
  const version = raw['version'];
  assert(typeof version === 'number' && Number.isInteger(version) && version >= 1, 'artifact.version is not a positive integer');
  assert(
    typeof raw['generated_at'] === 'string' && !Number.isNaN(Date.parse(raw['generated_at'])),
    'artifact.generated_at is not a valid timestamp',
  );
  assert(raw['method'] === 'human-review', "artifact.method is not 'human-review' (section 4.10)");
  // `method` names the slot in section 4.10; this names the scorer. An
  // artifact that omits it cannot be read as a quality claim by accident.
  assert(
    raw['scored_by'] === 'stub' || raw['scored_by'] === 'model',
    "artifact.scored_by is not 'stub' or 'model' (section 4.10)",
  );
  assert(raw['gold_source'] === 'synthetic', 'artifact.gold_source is not synthetic (DEC-18)');
  // DEC-31 as code: an artifact reporting any other split must not load.
  assert(raw['split_used'] === 'report', 'artifact.split_used is not the report half (DEC-31)');
  // Same guard shape as split_used: an artifact claiming another population
  // must not load, because its number would not be comparable.
  assert(raw['scope'] === 'first_turn', "artifact.scope is not 'first_turn' (DEC-39)");
  assert(
    typeof raw['report_tickets'] === 'number' &&
      Number.isInteger(raw['report_tickets']) &&
      raw['report_tickets'] > 0,
    'artifact.report_tickets is not a positive integer',
  );
  assert(typeof raw['prompt_ver'] === 'string' && raw['prompt_ver'].length > 0, 'artifact.prompt_ver is missing');
  assert(typeof raw['model_ver'] === 'string' && raw['model_ver'].length > 0, 'artifact.model_ver is missing');
  const gate = raw['gate_agreement'];
  assert(typeof gate === 'number' && gate >= 0 && gate <= 1, 'artifact.gate_agreement is outside [0, 1]');
  const gateSource = raw['gate_source'];
  assert(
    gateSource === 'seed' || gateSource === 'calibration',
    `artifact.gate_source is ${String(gateSource)}, expected seed or calibration`,
  );
  const gateVersion = raw['gate_calibration_version'];
  if (gateSource === 'calibration') {
    assert(
      typeof gateVersion === 'number' && Number.isInteger(gateVersion) && gateVersion >= 1,
      'artifact.gate_calibration_version is not a positive integer on a calibrated run',
    );
    assert(
      typeof raw['gate_calibration_scope'] === 'string'
        && (CALIBRATION_SCOPES as readonly string[]).includes(raw['gate_calibration_scope']),
      `artifact.gate_calibration_scope is ${String(raw['gate_calibration_scope'])}, `
        + `expected one of ${CALIBRATION_SCOPES.join(', ')}`,
    );
  } else {
    // A seeded run names no version. A number here would claim a fit that
    // never produced this number.
    assert(gateVersion === null, 'artifact.gate_calibration_version is set on a seeded run');
    assert(
      raw['gate_calibration_scope'] === null,
      'artifact.gate_calibration_scope is set on a seeded run',
    );
  }
  assertRateWithInterval(raw['action_match'], 'action_match');
  assertRateWithInterval(raw['containment'], 'containment');
  const strata = raw['strata'];
  assert(Array.isArray(strata), 'artifact.strata is not an array');
  for (const [index, stratum] of strata.entries()) {
    assert(isRecord(stratum), `stratum ${index} is not an object`);
    assert(
      typeof stratum['risk_tier'] === 'string' && ['low', 'medium', 'high'].includes(stratum['risk_tier']),
      `stratum ${index} has an unknown risk_tier`,
    );
    assert(
      typeof stratum['tickets'] === 'number' && Number.isInteger(stratum['tickets']) && stratum['tickets'] > 0,
      `stratum ${index} has no positive ticket count`,
    );
    assertRateWithInterval(stratum['action_match'], `strata[${index}].action_match`);
    assertRateWithInterval(stratum['containment'], `strata[${index}].containment`);
    // Section 4.10: at 385 cases with three tiers the strata stay too small
    // to publish. An artifact that marks one publishable must not load.
    assert(stratum['publishable'] === false, `stratum ${index} claims to be publishable`);
  }
  return raw as unknown as GoldReportArtifact;
}

/** Write the artifact as v<version>.json under dir (defaults to <repo>/gold-report/).
 * Creates the directory when absent, so a first run on a fresh checkout works. */
export async function writeGoldReportArtifact(
  artifact: GoldReportArtifact,
  dir: URL = defaultGoldReportDir(),
): Promise<void> {
  const validated = validateGoldReportArtifact(artifact);
  const base = withTrailingSlash(dir);
  await mkdir(base, { recursive: true });
  await writeFile(new URL(`v${validated.version}.json`, base), JSON.stringify(validated, null, 2) + '\n');
}

/**
 * Load a gold report artifact by version, or the highest version when no
 * version is given. Returns null when nothing has been reported yet.
 */
export async function loadGoldReportArtifact(
  version?: number,
  dir: URL = defaultGoldReportDir(),
): Promise<GoldReportArtifact | null> {
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
  return validateGoldReportArtifact(JSON.parse(await readArtifactText(base, found, LABEL)));
}

/**
 * Fault on a directory that would fault at write time, before the caller
 * spends anything. The job then mints the version after its loop.
 */
export async function assertGoldReportDirUsable(dir: URL): Promise<void> {
  await prepareArtifactDir(withTrailingSlash(dir), LABEL);
}

/** Mint the next version number by scanning existing artifacts under dir. */
export async function nextVersion(dir: URL): Promise<number> {
  return nextArtifactVersion(withTrailingSlash(dir), LABEL);
}

function assert(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(`gold report artifact validation failed: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertRateWithInterval(value: unknown, field: string): void {
  assert(isRecord(value), `artifact.${field} is not an object`);
  assertRate(value['rate'], `${field}.rate`);
  assert(
    typeof value['successes'] === 'number' && Number.isInteger(value['successes']) && value['successes'] >= 0,
    `artifact.${field}.successes is not a non-negative integer`,
  );
  assert(
    typeof value['total'] === 'number' && Number.isInteger(value['total']) && value['total'] > 0,
    `artifact.${field}.total is not a positive integer`,
  );
  const interval = value['interval'];
  assert(isRecord(interval), `artifact.${field}.interval is not an object`);
  assert(
    typeof interval['confidence'] === 'number' && interval['confidence'] > 0 && interval['confidence'] < 1,
    `artifact.${field}.interval.confidence is not a fraction below 1`,
  );
  assertRate(interval['lower'], `${field}.interval.lower`);
  assertRate(interval['upper'], `${field}.interval.upper`);
  assert(
    (interval['lower'] as number) <= (value['rate'] as number) &&
      (value['rate'] as number) <= (interval['upper'] as number),
    `artifact.${field}: interval does not bracket the rate`,
  );
}

function assertRate(value: unknown, field: string): void {
  assert(typeof value === 'number' && value >= 0 && value <= 1, `artifact.${field} is outside [0, 1]`);
}
