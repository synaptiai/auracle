// Versioned gold report artifact (method 2, section 4.10, DEC-31).
//
// The report job writes the README numbers here. Each run mints a new
// version file (v1.json, v2.json, ...) so the published numbers stay
// inspectable over time. Structure and validation mirror
// src/calibration/artifact.ts: a broken artifact fails fast instead of
// quietly changing a published number.

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import type { RateWithInterval } from './score.js';

export interface GoldReportArtifact {
  /** Discriminates this artifact kind from other config artifacts. */
  artifact: 'gold-report';
  /** Monotonic version; each run of the job mints the next one. */
  version: number;
  /** ISO timestamp of the scoring run. */
  generated_at: string;
  /** Section 4.10 method 2: human review quality numbers for the README. */
  method: 'human-review';
  /** DEC-18: the shipped gold set is synthetic only. */
  gold_source: 'synthetic';
  /** DEC-31: every number below comes from the report half only. */
  split_used: 'report';
  /** Number of report-half tickets scored. */
  report_tickets: number;
  /** DEC-26 pins in force during the run. */
  prompt_ver: string;
  model_ver: string;
  /** The agreement threshold the policy applied (seed until calibration wires its artifact in). */
  gate_agreement: number;
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
  assert(raw['gold_source'] === 'synthetic', 'artifact.gold_source is not synthetic (DEC-18)');
  // DEC-31 as code: an artifact reporting any other split must not load.
  assert(raw['split_used'] === 'report', 'artifact.split_used is not the report half (DEC-31)');
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
  const target = version ?? (await highestVersion(base));
  if (target === null) return null;
  const text = await readFile(new URL(`v${target}.json`, base), 'utf8');
  return validateGoldReportArtifact(JSON.parse(text));
}

async function highestVersion(base: URL): Promise<number | null> {
  let names: string[];
  try {
    names = await readdir(base);
  } catch (err) {
    // An absent directory means nothing has been reported yet.
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
