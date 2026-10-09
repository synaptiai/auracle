// Versioned calibration artifact (section 4.11, DEC-13, DEC-31).
//
// The calibration job writes its fitted threshold here; classifier config
// consumers load it. Each run writes a new version file (v1.json, v2.json,
// ...) so the history of the one global threshold stays inspectable.
// Loading picks the highest version and validates what it reads, mirroring
// src/fixtures/load.ts: a broken artifact fails fast instead of silently
// moving a live gate.

import { mkdir, writeFile } from 'node:fs/promises';

import {
  prepareArtifactDir,
  assertVersionArg,
  listArtifacts,
  nextArtifactVersion,
  readArtifactText,
  scanArtifactNames,
} from '../artifacts/versioned.js';
import type { ArtifactFile } from '../artifacts/versioned.js';
import { GOLD_SOURCES } from '../domain/gold-types.js';
import type { GoldSource } from '../domain/gold-types.js';

/** Names this artifact kind in every fault message. */
const LABEL = 'calibration';

/**
 * The highest artifact in a listing, or null.
 *
 * Kept as a named export so the pure suite attacks the scan through the
 * module that depends on it.
 */
export function selectArtifactName(names: readonly string[]): ArtifactFile | null {
  return scanArtifactNames(names, LABEL).at(-1) ?? null;
}

/** The turn population a fit consumed. See `CalibrationArtifact.scope`. */
export const CALIBRATION_SCOPES = ['first_turn', 'all_turns'] as const;
export type CalibrationScope = (typeof CALIBRATION_SCOPES)[number];

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
  /**
   * Where the half this run consumed came from (DEC-18).
   *
   * A closed set. The shipped corpus is synthetic and every number this
   * repository publishes is measured on it. An adopter fitting on their own
   * labelled history records 'real', so a reader never has to infer which
   * data a number covers.
   */
  gold_source: GoldSource;
  /** DEC-31: the fit consumed the fit half only. */
  split_used: 'fit';
  /**
   * The turn population the fit consumed.
   *
   * DEC-39 narrows the replay and the gold report to first turns, because
   * both score against a conversation-level disposition. This job scores a
   * prediction against the case's own intent label, which a later turn
   * carries, so it consumes every turn and section 6 requires it to. The
   * field says which population a threshold actually covers, so a reader
   * never has to infer it from the corpus of the day.
   */
  scope: CalibrationScope;
  /** Number of fit-half tickets the fit consumed. */
  fit_tickets: number;
  /**
   * Samples that yielded no readable answer across the fit, out of K per
   * case. A refusal by the provider and an empty answer both count.
   *
   * A published threshold must say how much of its evidence was missing.
   * These samples lowered agreement without being a judgement, so a reader
   * needs the count to tell a strict model from a small answer budget.
   *
   * Optional only for an artifact written before the field existed, so a
   * daemon holding one still starts. Every fit this code performs writes it.
   */
  unreadable_samples?: number;
  /**
   * Fit cases carrying at least one unreadable sample.
   *
   * The number the ceiling actually bounds. The sample count alone cannot say
   * how much of the half was affected, because K samples belong to one case.
   */
  tickets_with_unreadable?: number;
  /**
   * Names the exact case sets this run proved disjoint (DEC-31).
   *
   * Null when no counterpart was named, which is the committed corpus, whose
   * two halves the loader cross-checks. Otherwise a reader can compare these
   * against a gold report's own pair and see whether the two runs were proved
   * against the same sets. Without them the proof lives only in the moment of
   * the run and binds nothing to the number it produced.
   */
  fit_half_digest: string | null;
  report_half_digest: string | null;
  /** DEC-26 pins in force during the run. */
  prompt_ver: string;
  model_ver: string;
  target_precision: number;
  threshold: number;
  /**
   * DEC-41: the trigger in force when this ran, so a reader need not know it.
   *
   * Every field below is optional on read, and only on read. This file is
   * loaded at startup by every daemon, so an adopter holding an artifact
   * fitted before DEC-41 must still start. Present and malformed is still
   * refused, and the job always writes them.
   */
  trigger_min_labelled?: number;
  /**
   * Labelled cases in the corpus, which is what the trigger counts.
   *
   * Not the fit population: `fit_tickets` records that, and the two differ
   * because DEC-31 splits the corpus and this job consumes one half.
   */
  labelled_cases?: number;
  /**
   * The threshold fitted for each intent. Empty below the trigger.
   *
   * Absent or empty is the DEC-13 path, and an entry always means a
   * threshold that was fitted: the global value is never copied in, so a
   * reader can tell a fitted threshold from an inherited one.
   */
  per_intent?: Readonly<Record<string, number>>;
  /** Intents that kept the global threshold. Named, because an absence is not a finding. */
  below_floor?: readonly string[];
  /**
   * What labelled the cases behind these thresholds, and how accurate each
   * one was. One entry per pin, because DEC-41 asks for the count and the
   * accuracy of each kind and a corpus may carry more than one.
   *
   * Each `agreement` is scored over that pin's own cases, and `cases` counts
   * them, so the entries never attribute a case to a labeller that did not
   * label it. The counts cover the fit half, which is the population this job
   * reads; `labelled_cases` above covers the corpus.
   *
   * The kind is a closed set for the same reason `gold_source` is. A
   * stand-in's agreement read as a real model's score is exactly the
   * confusion DEC-41 exists to prevent, and `human-review` can never appear
   * here — that value belongs to a gold report and means a person read the
   * case.
   */
  labellers?: readonly {
    kind: 'stub' | 'model';
    pin: string;
    agreement: number;
    cases: number;
  }[];
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
  const goldSource = raw['gold_source'];
  assert(
    typeof goldSource === 'string' && (GOLD_SOURCES as readonly string[]).includes(goldSource),
    `artifact.gold_source is ${String(goldSource)}, expected one of ${GOLD_SOURCES.join(', ')} (DEC-18)`,
  );
  // DEC-31 as code: an artifact fitted on any other split must not load.
  assert(raw['split_used'] === 'fit', 'artifact.split_used is not the fit half (DEC-31)');
  assert(
    typeof raw['scope'] === 'string' && (CALIBRATION_SCOPES as readonly string[]).includes(raw['scope']),
    `artifact.scope is ${String(raw['scope'])}, expected one of ${CALIBRATION_SCOPES.join(', ')}`,
  );
  assert(
    typeof raw['fit_tickets'] === 'number' && Number.isInteger(raw['fit_tickets']) && raw['fit_tickets'] > 0,
    'artifact.fit_tickets is not a positive integer',
  );
  // Absent is allowed, and only here. Every other field rule refuses what it
  // does not understand, but this one is read at startup by every daemon
  // (resolveThresholds -> loadCalibrationArtifact -> here), and an adopter
  // holding an artifact fitted before this field existed must still start.
  // Refusing it would rebuild the blocking chain this repository removed: a
  // threshold that its own loader rejects stops the system rather than the
  // job. Present and malformed is still refused, and the job always writes it.
  for (const field of ['unreadable_samples', 'tickets_with_unreadable'] as const) {
    if (raw[field] === undefined) continue;
    assert(
      typeof raw[field] === 'number'
        && Number.isInteger(raw[field])
        && (raw[field] as number) >= 0,
      `artifact.${field} is not a count`,
    );
  }
  for (const field of ['trigger_min_labelled', 'labelled_cases'] as const) {
    if (raw[field] === undefined) continue;
    assert(
      typeof raw[field] === 'number'
        && Number.isInteger(raw[field])
        && (raw[field] as number) >= 0,
      `artifact.${field} is not a count`,
    );
  }
  if (raw['per_intent'] !== undefined) {
    const map = raw['per_intent'];
    assert(isRecord(map) && !Array.isArray(map), 'artifact.per_intent is not a map');
    for (const [intent, threshold] of Object.entries(map)) {
      // A threshold of zero passes every ticket, which is the gate switched
      // off. It must not survive a round trip any more than it survives the
      // fit that refused it.
      assert(
        typeof threshold === 'number' && threshold > 0 && threshold <= 1,
        `artifact.per_intent[${intent}] is not a fraction in (0, 1]`,
      );
    }
  }
  if (raw['below_floor'] !== undefined) {
    const named = raw['below_floor'];
    assert(
      Array.isArray(named) && named.every((i) => typeof i === 'string' && i.length > 0),
      'artifact.below_floor is not a list of intent ids',
    );
  }
  if (raw['labellers'] !== undefined) {
    const labellers = raw['labellers'];
    assert(Array.isArray(labellers), 'artifact.labellers is not a list');
    const seen = new Set<string>();
    for (const labeller of labellers) {
      assert(isRecord(labeller), 'artifact.labellers holds a non-object');
      assert(
        labeller['kind'] === 'stub' || labeller['kind'] === 'model',
        `artifact.labellers kind is ${String(labeller['kind'])}, expected stub or model`,
      );
      assert(
        typeof labeller['pin'] === 'string' && labeller['pin'].length > 0,
        'artifact.labellers holds an entry with no pin',
      );
      // One entry per pin. Two entries for one pin would split a labeller's
      // cases across rows and no reader could total them.
      assert(!seen.has(labeller['pin']), `artifact.labellers repeats pin ${labeller['pin']}`);
      seen.add(labeller['pin']);
      assert(
        typeof labeller['agreement'] === 'number'
          && labeller['agreement'] >= 0
          && labeller['agreement'] <= 1,
        'artifact.labellers holds an agreement outside [0, 1]',
      );
      assert(
        typeof labeller['cases'] === 'number'
          && Number.isInteger(labeller['cases'])
          && (labeller['cases'] as number) >= 0,
        'artifact.labellers holds a cases value that is not a count',
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
  assert(typeof raw['prompt_ver'] === 'string' && raw['prompt_ver'].length > 0, 'artifact.prompt_ver is missing');
  assert(typeof raw['model_ver'] === 'string' && raw['model_ver'].length > 0, 'artifact.model_ver is missing');
  const target = raw['target_precision'];
  assert(typeof target === 'number' && target > 0 && target <= 1, 'artifact.target_precision is outside (0, 1]');
  // The other fields below are rates, where zero is a real measurement. This
  // one becomes a gate: at zero the comparison never fails and gate 1 passes
  // every ticket. Refusing it here fails at the write, not later inside a
  // daemon that already validated the file (DEC-05).
  const threshold = raw['threshold'];
  assert(
    typeof threshold === 'number' && threshold > 0 && threshold <= 1,
    'artifact.threshold is outside (0, 1]',
  );
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
  // One scan for both paths. A listing pre-filtered on the explicit branch
  // would hide every fault belonging to another version, and leave a second,
  // lenient posture behind a docstring that claims one.
  const all = await listArtifacts(base, LABEL);
  let found: ArtifactFile | null;
  if (version === undefined) {
    found = all.at(-1) ?? null;
  } else {
    assertVersionArg(version, LABEL);
    found = all.find((entry) => entry.version === version) ?? null;
  }
  if (found === null) return null;

  const artifact = validateCalibrationArtifact(
    JSON.parse(await readArtifactText(base, found, LABEL)),
  );
  // The file is chosen by its name and the provenance is read from inside
  // it. A copy renamed by hand would run one threshold and report another
  // version, and every log line and gold report would name the wrong fit.
  if (artifact.version !== found.version) {
    throw new Error(
      `calibration artifact '${found.name}' declares version ${artifact.version}; `
        + 'the file name and its contents must agree',
    );
  }
  return artifact;
}

/**
 * Fault on a directory that would fault at write time, before the caller
 * spends anything. The job then mints the version after its loop.
 */
export async function assertCalibrationDirUsable(dir: URL): Promise<void> {
  await prepareArtifactDir(withTrailingSlash(dir), LABEL);
}

/**
 * Mint the next version number by scanning existing artifacts under dir.
 *
 * Strict, like the loader. A lenient scan would rest on the argument that
 * `pnpm run calibrate` is the way out of a directory the loader refuses. It
 * is not: the job writes a new version, and the loader refuses the same
 * stray file as before. The job checks the directory before it spends
 * anything, so a fault costs no model call.
 */
export async function nextVersion(dir: URL): Promise<number> {
  return nextArtifactVersion(withTrailingSlash(dir), LABEL);
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
