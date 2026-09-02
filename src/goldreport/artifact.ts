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
import { GOLD_SOURCES } from '../fixtures/load.js';
import type { GoldSource } from '../fixtures/load.js';

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
  /**
   * Where the half this run consumed came from (DEC-18).
   *
   * A closed set. The shipped corpus is synthetic and every number this
   * repository publishes is measured on it. An adopter fitting on their own
   * labelled history records 'real', so a reader never has to infer which
   * data a number covers.
   */
  gold_source: GoldSource;
  /** DEC-31: every number below comes from the report half only. */
  split_used: 'report';
  /**
   * DEC-39: the population scored. Replay scores first turns only, so a
   * reader can tell what the number covers without reading the job.
   */
  scope: 'first_turn';
  /** Number of report-half tickets scored. */
  report_tickets: number;
  /**
   * Samples that yielded no readable answer across the scored half, out of
   * K per case. A refusal and an empty answer both count.
   *
   * A published number that was depressed by unreadable samples must say so.
   * Optional for the same reason the calibration field is: an artifact
   * published before this field existed must still read.
   *
   * No case count beside it, unlike the calibration artifact: that one bounds
   * a ceiling on cases, and this job has no ceiling to bound.
   */
  unreadable_samples?: number;
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
  /**
   * Which data the threshold was fitted on. Null when seeded.
   *
   * `gold_source` above names the half this report SCORED. The threshold may
   * come from a fit over different data — an adopter can publish on their own
   * report half against a gate fitted on their own fit half, and a reader
   * must be able to see both provenances rather than assume they match.
   */
  gate_calibration_gold_source: GoldSource | null;
  /**
   * The coverage pair the policy applied (DEC-05, DEC-07).
   *
   * The published rates are scored through the policy engine, which reads
   * both gates. An earlier version recorded the agreement gate alone and the
   * job refused to run at all once a coverage fit existed, because a moved
   * coverage value would otherwise have reached the published rates with
   * nothing in the file naming it. Recording the pair is the disclosure that
   * refusal stood in for, and it is what lets the job run again.
   *
   * Named on their own and never joined to the agreement fields: a reader
   * must be able to say which gate was fitted and which was seeded (DEC-05).
   *
   * Optional, like `unreadable_samples`: an artifact published before these
   * fields existed must still read.
   */
  coverage_block?: number;
  coverage_review?: number;
  /**
   * Where the coverage pair came from.
   *
   * 'seed' is the documented section 4.7 pair; 'groundedness' names the fit
   * artifact version that produced it.
   */
  coverage_source?: 'seed' | 'groundedness';
  /** The groundedness artifact version behind the pair. Null when seeded. */
  coverage_fit_version?: number | null;
  /**
   * Which data the pair was fitted on. Null when seeded.
   *
   * Separate from `gate_calibration_gold_source` for the same reason that one
   * is separate from `gold_source`: the two gates can be fitted on different
   * data, and a reader who saw one figure would attribute the other wrongly.
   */
  coverage_fit_gold_source?: GoldSource | null;
  /**
   * Names the exact case sets this run proved disjoint (DEC-31).
   *
   * Null when no counterpart was named, which is the committed corpus. A
   * reader compares these against the calibration artifact's own pair. If the
   * two runs were proved against different sets, the gate in force was fitted
   * against a half this report never saw, and the proof recorded here does
   * not cover it.
   */
  report_half_digest: string | null;
  fit_half_digest: string | null;
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
  const goldSource = raw['gold_source'];
  assert(
    typeof goldSource === 'string' && (GOLD_SOURCES as readonly string[]).includes(goldSource),
    `artifact.gold_source is ${String(goldSource)}, expected one of ${GOLD_SOURCES.join(', ')} (DEC-18)`,
  );
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
  if (raw['unreadable_samples'] !== undefined) {
    assert(
      typeof raw['unreadable_samples'] === 'number'
        && Number.isInteger(raw['unreadable_samples'])
        && raw['unreadable_samples'] >= 0,
      'artifact.unreadable_samples is not a count',
    );
  }
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
    assert(
      typeof raw['gate_calibration_gold_source'] === 'string'
        && (GOLD_SOURCES as readonly string[]).includes(raw['gate_calibration_gold_source']),
      `artifact.gate_calibration_gold_source is ${String(raw['gate_calibration_gold_source'])}, `
        + `expected one of ${GOLD_SOURCES.join(', ')}`,
    );
  } else {
    // A seeded run names no version. A number here would claim a fit that
    // never produced this number.
    assert(gateVersion === null, 'artifact.gate_calibration_version is set on a seeded run');
    assert(
      raw['gate_calibration_scope'] === null,
      'artifact.gate_calibration_scope is set on a seeded run',
    );
    assert(
      raw['gate_calibration_gold_source'] === null,
      'artifact.gate_calibration_gold_source is set on a seeded run',
    );
  }
  // The coverage half of the record (DEC-05). Checked entirely on its own:
  // nothing above reads a coverage field and nothing here reads an agreement
  // field, so the two gates cannot become one through the validator.
  const coverageSource = raw['coverage_source'];
  if (coverageSource !== undefined) {
    assert(
      coverageSource === 'seed' || coverageSource === 'groundedness',
      `artifact.coverage_source is ${String(coverageSource)}, expected seed or groundedness`,
    );
    // The pair travels with its source. A source naming a fit beside no pair
    // discloses nothing, which is the gap this record exists to close.
    for (const field of ['coverage_block', 'coverage_review'] as const) {
      const value = raw[field];
      assert(
        typeof value === 'number' && value >= 0 && value <= 1,
        `artifact.${field} is outside [0, 1]`,
      );
    }
    // Block never exceeds review, exactly as the policy engine requires of
    // the pair it is given. An artifact recording the reverse would describe
    // a gate the engine refuses to build.
    assert(
      (raw['coverage_block'] as number) <= (raw['coverage_review'] as number),
      `artifact.coverage_block ${String(raw['coverage_block'])} exceeds `
        + `coverage_review ${String(raw['coverage_review'])}`,
    );
    const coverageVersion = raw['coverage_fit_version'];
    if (coverageSource === 'groundedness') {
      assert(
        typeof coverageVersion === 'number' && Number.isInteger(coverageVersion) && coverageVersion > 0,
        'artifact.coverage_fit_version is not a positive integer on a fitted run',
      );
      assert(
        typeof raw['coverage_fit_gold_source'] === 'string'
          && (GOLD_SOURCES as readonly string[]).includes(raw['coverage_fit_gold_source']),
        `artifact.coverage_fit_gold_source is ${String(raw['coverage_fit_gold_source'])}, `
          + `expected one of ${GOLD_SOURCES.join(', ')}`,
      );
    } else {
      assert(coverageVersion === null, 'artifact.coverage_fit_version is set on a seeded run');
      assert(
        raw['coverage_fit_gold_source'] === null,
        'artifact.coverage_fit_gold_source is set on a seeded run',
      );
    }
  } else {
    // An artifact published before these fields existed carries none of them.
    // A partial record is a different thing: it names a pair whose source
    // nobody can read, and that is the undisclosed gate all over again.
    for (const field of [
      'coverage_block', 'coverage_review', 'coverage_fit_version', 'coverage_fit_gold_source',
    ] as const) {
      assert(
        raw[field] === undefined,
        `artifact.${field} is set without coverage_source, so its provenance is unreadable`,
      );
    }
  }
  for (const field of ['report_half_digest', 'fit_half_digest'] as const) {
    const value = raw[field];
    assert(
      value === null || (typeof value === 'string' && /^[0-9a-f]{16}$/.test(value)),
      `artifact.${field} is neither null nor a digest`,
    );
  }
  // Null means the committed corpus, whose two halves the loader cross-checks.
  // A run on real history has no such guarantee, so it must name the pair it
  // proved. Without this an artifact could declare real provenance with the
  // proof absent, and the startup resolver would adopt that threshold — the
  // very field that would reveal the gap asserting the opposite (DEC-31).
  if (goldSource !== 'synthetic') {
    for (const field of ['report_half_digest', 'fit_half_digest'] as const) {
      assert(
        raw[field] !== null,
        `artifact.${field} is null on a ${String(goldSource)} run; a half that is not the `
          + 'committed corpus must name the pair it proved disjoint (DEC-31)',
      );
    }
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
    // Section 4.10: at this corpus size the three tiers stay too small
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
