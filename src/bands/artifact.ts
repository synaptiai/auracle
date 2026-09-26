// Versioned control-band artifact (bands.yaml, sections 4.10 and 5).
//
// Each run mints a new version rather than overwriting the last, so the files
// an adopter accumulates are the record Phase 2 asks for: the day a gate
// moved, kept beside the days around it.
//
// Structure and validation mirror src/latency/artifact.ts. Two deliberate
// differences. Every metric carries the counts that partition the day's runs,
// and the validator refuses a file whose parts do not add up to its whole.
// And a band and a shortfall are exclusive: a file that carried both would
// state a verdict and its own reason for having none.

import { link, mkdir, unlink, writeFile } from 'node:fs/promises';

import {
  prepareArtifactDir,
  assertVersionArg,
  listArtifacts,
  nextArtifactVersion,
  readArtifactText,
} from '../artifacts/versioned.js';
import type { ArtifactFile } from '../artifacts/versioned.js';
import { METRICS, WINDOW_DAYS } from './metrics.js';
import type { Direction, MetricName } from './metrics.js';
import type { BandAction, ShortfallCode } from './evaluate.js';

const LABEL = 'bands';
const ARTIFACT_NAME = 'control-bands';

const ACTIONS: readonly BandAction[] = ['in_band', 'log', 'diagnose', 'propose_change'];
const SHORTFALL_CODES: readonly ShortfallCode[] = [
  'day_unmeasured', 'day_not_a_number', 'thin_window', 'steady', 'moved_from_flat',
  'provider_change',
];

export interface ArtifactMetric {
  metric: MetricName;
  direction: Direction;
  /** The day's value, or null when the day measured nothing. Never zero by default. */
  value: number | null;
  /** Runs the value was computed over. */
  count: number;
  /** Runs that never reached the step this metric measures. */
  not_reached: number;
  /** Runs whose journal cannot say whether they reached it. */
  unrecorded: number;
  /**
   * Runs whose contribution may still arrive, so the day is provisional.
   *
   * Deliberately outside the partition below. It overlaps the partition
   * without adding to it, and which part differs by metric: an unapproved run
   * sits in `not_reached`, an undelivered one inside `count`.
   */
  pending: number;
  baseline: { mean: number; sigma: number; days: number } | null;
  band: { sigma_distance: number; action: BandAction; toward_bad: boolean } | null;
  /** Names what was missing when no band could be evaluated. Null otherwise. */
  shortfall: string | null;
  /** The same answer as a value, for a reader that is not a person. */
  shortfall_code: ShortfallCode | null;
}

export interface BandsArtifact {
  artifact: 'control-bands';
  version: number;
  generated_at: string;
  /**
   * This job observes, it never corrects. bands.yaml's three-sigma action is
   * "propose a change through a pull request", and a file that could call
   * itself the change would turn an observation into a decision nobody made.
   */
  role: 'observation';
  /** The UTC day the figures describe. */
  day: string;
  /** Days a baseline covers, and the number this file's baselines were built from. */
  window_days: number;
  /** Runs the day held. Every metric's counts partition this number. */
  runs: number;
  /**
   * What answered the model calls behind this day, or null (issue #23).
   *
   * Null means the day recorded no provider, or recorded more than one. The
   * name only: the literal 'stub' or 'model', never a prompt, a completion or
   * a payload. A band across a provider change measures the provider and not
   * the system, so the file states what produced its numbers rather than
   * leaving a reader to assume they are comparable.
   */
  provider: string | null;
  /**
   * DEC-49, DEC-50: how many of this day's cases a person steered, with a
   * send-back note or a document published from the case. Both raise the
   * attempt, and both mean the system did not answer alone.
   *
   * A day-level count, beside the provider and outside `metrics`, because it
   * is not a metric: bands.yaml declares no band for it, and the evaluator
   * judges only what the file declares. It is a subset of `runs` — the day
   * counts a turn once, from its final attempt, and this counts the turns
   * whose final attempt a person asked for.
   *
   * Read as zero when absent. A file written before this field existed came
   * from a ledger in which no reviewer could send a case back, so zero is
   * what it means rather than a gap in the record.
   */
  assisted: number;
  /** One row per metric, in the order bands.yaml declares them. */
  metrics: ArtifactMetric[];
}

/** Resolved against this module's location so src and dist both reach <repo>/bands/. */
export function defaultBandsDir(): URL {
  return new URL('../../bands/', import.meta.url);
}

function withTrailingSlash(dir: URL): URL {
  return dir.href.endsWith('/') ? dir : new URL(`${dir.href}/`);
}

function assert(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(`bands artifact validation failed: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertCount(value: unknown, field: string): void {
  assert(
    typeof value === 'number' && Number.isInteger(value) && value >= 0,
    `artifact.${field} is not a count`,
  );
}

function assertFinite(value: unknown, field: string): void {
  assert(typeof value === 'number' && Number.isFinite(value), `artifact.${field} is not a number`);
}

/** A UTC calendar day, and one the calendar actually holds. */
function assertDay(value: unknown, field: string): void {
  assert(
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value),
    `artifact.${field} is not a YYYY-MM-DD day`,
  );
  const parsed = new Date(`${value as string}T00:00:00.000Z`);
  assert(
    !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value,
    `artifact.${field} is not a day the calendar holds`,
  );
}

/** Validate an unknown value as a control-band artifact. Exported for tests. */
export function validateBandsArtifact(raw: unknown): BandsArtifact {
  assert(isRecord(raw), 'artifact is not an object');
  assert(
    raw['artifact'] === ARTIFACT_NAME,
    `artifact.artifact is ${String(raw['artifact'])}, expected ${ARTIFACT_NAME}`,
  );
  const version = raw['version'];
  assert(
    typeof version === 'number' && Number.isInteger(version) && version >= 1,
    'artifact.version is not a positive integer',
  );
  assert(
    typeof raw['generated_at'] === 'string' && !Number.isNaN(Date.parse(raw['generated_at'])),
    'artifact.generated_at is not a valid timestamp',
  );
  assert(raw['role'] === 'observation', "artifact.role is not 'observation'");
  assertDay(raw['day'], 'day');
  assert(raw['window_days'] === WINDOW_DAYS, `artifact.window_days is not ${WINDOW_DAYS}`);
  assertCount(raw['runs'], 'runs');
  const runs = raw['runs'] as number;

  // Absent on every artifact written before the field existed, and
  // `artifact.version` is a per-run mint counter rather than a schema
  // version, so nothing else tells the two shapes apart. Read as null, which
  // is what such a file means: it recorded no provider.
  //
  // Asserted without this, `loadBandsArtifact` threw on every bands/v<n>.json
  // an adopter already held, and no test caught it because every case here
  // writes and reads inside one shape.
  const provider = raw['provider'] ?? null;
  assert(
    provider === null || typeof provider === 'string',
    'artifact.provider is not a string or null',
  );

  // Absent on every artifact written before the field existed, and such a
  // day steered no attempt: a reviewer could not send a case back yet. Zero
  // is the honest reading, and a missing field is not a fault.
  const assisted = raw['assisted'] ?? 0;
  assertCount(assisted, 'assisted');
  assert(
    (assisted as number) <= runs,
    'artifact.assisted is larger than artifact.runs',
  );

  const metrics = raw['metrics'];
  assert(Array.isArray(metrics), 'artifact.metrics is not an array');
  // Every metric bands.yaml declares, in its order. A file missing one would
  // read as a clean report on a metric nobody looked at.
  assert(
    metrics.length === METRICS.length,
    `artifact.metrics holds ${metrics.length} rows, expected ${METRICS.length}`,
  );

  for (const [i, entry] of metrics.entries()) {
    const where = `metrics[${i}]`;
    assert(isRecord(entry), `artifact.${where} is not an object`);
    const definition = METRICS[i]!;
    assert(
      entry['metric'] === definition.name,
      `artifact.${where}.metric is ${String(entry['metric'])}, expected ${definition.name}`,
    );
    assert(
      entry['direction'] === definition.direction,
      `artifact.${where}.direction disagrees with the definition`,
    );

    assertCount(entry['count'], `${where}.count`);
    assertCount(entry['not_reached'], `${where}.not_reached`);
    assertCount(entry['unrecorded'], `${where}.unrecorded`);
    assertCount(entry['pending'], `${where}.pending`);
    // Pending overlaps the exclusions, so it is bounded by the day rather
    // than added to them.
    assert(
      (entry['pending'] as number) <= runs,
      `artifact.${where}.pending exceeds the ${runs} runs the day held`,
    );
    // The three counts partition the day's runs. Nothing else here notices a
    // run counted twice or dropped, and the rate would then be computed over
    // a population the file itself contradicts.
    const covered =
      (entry['count'] as number) + (entry['not_reached'] as number) + (entry['unrecorded'] as number);
    assert(
      covered === runs,
      `artifact.${where} covers ${covered} runs, but the day held ${runs}`,
    );

    // A value and its support imply each other, in both directions. Checking
    // one way only let a file report a rate computed over zero runs, which is
    // not a small measurement but no measurement, and nothing downstream
    // would have said so.
    const value = entry['value'];
    const count = entry['count'] as number;
    if (value === null) {
      assert(count === 0, `artifact.${where} reports no value over ${count} runs`);
    } else {
      assertFinite(value, `${where}.value`);
      assert(count > 0, `artifact.${where} reports a value over 0 runs`);
    }

    const baseline = entry['baseline'];
    if (baseline !== null) {
      assert(isRecord(baseline), `artifact.${where}.baseline is neither null nor an object`);
      assertFinite(baseline['mean'], `${where}.baseline.mean`);
      assertFinite(baseline['sigma'], `${where}.baseline.sigma`);
      assert(
        (baseline['sigma'] as number) >= 0,
        `artifact.${where}.baseline.sigma is negative`,
      );
      assert(
        baseline['days'] === WINDOW_DAYS,
        `artifact.${where}.baseline covers ${String(baseline['days'])} days, not ${WINDOW_DAYS}`,
      );
    }

    const band = entry['band'];
    const shortfall = entry['shortfall'];
    // Exclusive, both ways. A file carrying both would state a verdict and
    // its own reason for having none; a file carrying neither would say
    // nothing at all about the metric it was written for.
    const code = entry['shortfall_code'];
    if (band === null) {
      assert(
        typeof shortfall === 'string' && shortfall.length > 0,
        `artifact.${where} has no band and no shortfall naming why`,
      );
      // The prose and the code answer the same question, so a file carrying
      // one without the other would read differently to a person and to a
      // machine.
      assert(
        SHORTFALL_CODES.includes(code as ShortfallCode),
        `artifact.${where}.shortfall_code is ${String(code)}, not one of ${SHORTFALL_CODES.join(', ')}`,
      );
    } else {
      assert(code === null, `artifact.${where} reports a band and a shortfall code`);
      assert(isRecord(band), `artifact.${where}.band is neither null nor an object`);
      assert(shortfall === null, `artifact.${where} reports a band and a shortfall`);
      assert(
        baseline !== null,
        `artifact.${where} reports a band with no baseline behind it`,
      );
      // A band is a position of a point. Without one there is nothing placed.
      assert(value !== null, `artifact.${where} reports a band with no value`);
      assertFinite(band['sigma_distance'], `${where}.band.sigma_distance`);
      assert(
        ACTIONS.includes(band['action'] as BandAction),
        `artifact.${where}.band.action is ${String(band['action'])}, not one of ${ACTIONS.join(', ')}`,
      );
      assert(
        typeof band['toward_bad'] === 'boolean',
        `artifact.${where}.band.toward_bad is not a boolean`,
      );
    }
  }
  // `provider` is normalised rather than passed through, so a caller reading
  // an older artifact gets null and never undefined.
  return { ...raw, provider, assisted } as unknown as BandsArtifact;
}

/**
 * Write the artifact, whole or not at all, and never over an existing one.
 *
 * Two rules, both about a file that already wears a canonical name.
 *
 * The bytes land under a temporary name and are linked into place. `link`
 * is atomic and it refuses an existing target, which is the combination this
 * needs. A reader therefore sees the whole file or no file, and a second run
 * cannot overwrite the first.
 *
 * `rename` was the obvious choice and it is wrong: it atomically REPLACES the
 * destination. Measured — two writes of version 1 both succeeded and the
 * first artifact's bytes were gone. Putting `wx` on the staging file did not
 * help, because the staging file is not the one being protected. Two runs
 * that overlap both scan the directory before either has written, so both
 * resolve the same number, and the accumulated record this module exists to
 * keep would lose a day.
 *
 * Written directly instead, a full disk or a killed process left a truncated
 * file already named `v<n>.json`; the version scan matches on the name alone,
 * so that fragment would be read as the artifact and the next run would mint
 * `v<n+1>` and never revisit it.
 */
export async function writeBandsArtifact(
  artifact: BandsArtifact,
  dir: URL = defaultBandsDir(),
): Promise<void> {
  const validated = validateBandsArtifact(artifact);
  const base = withTrailingSlash(dir);
  await mkdir(base, { recursive: true });
  const name = `v${validated.version}.json`;
  const target = new URL(name, base);
  // Named for the process, so two overlapping runs cannot share a temporary
  // file either. The suffix keeps it outside the version scan's pattern.
  const staging = new URL(`.${name}.${process.pid}.tmp`, base);
  try {
    await writeFile(staging, JSON.stringify(validated, null, 2) + '\n', { flag: 'wx' });
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      throw new Error(
        `${LABEL} staging file for ${name} already exists. It is a leftover from an `
          + 'interrupted run and is safe to remove.',
        { cause: error },
      );
    }
    throw error;
  }
  try {
    await link(staging, target);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    // Only EEXIST means another run minted this version. Reporting every
    // errno that way sent an operator after a race that never happened: a
    // directory occupying the name, a full disk and a read-only filesystem
    // all read as concurrency.
    throw new Error(
      code === 'EEXIST'
        ? `${LABEL} artifact ${name} already exists; another run minted this version`
        : `${LABEL} could not write ${name}${code === undefined ? '' : ` (${code})`}`,
      { cause: error },
    );
  } finally {
    // The staging file is invisible: the version scan ignores it and the
    // directory is not tracked, so one left behind accumulates unseen and
    // later collides with itself when a process id repeats.
    await unlink(staging).catch(() => undefined);
  }
}

/** Load by version, or the highest when none is given. Null when nothing exists. */
export async function loadBandsArtifact(
  version?: number,
  dir: URL = defaultBandsDir(),
): Promise<BandsArtifact | null> {
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
  const text = await readArtifactText(base, found, LABEL);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error: unknown) {
    // `readArtifactText` goes to trouble to name the artifact and the errno,
    // and a bare SyntaxError discards all of it: it names neither the file nor
    // the directory. A truncated artifact is exactly what an interrupted write
    // used to leave behind, so this is the message that would explain one.
    throw new Error(`${LABEL} artifact ${found.name} is not valid JSON`, { cause: error });
  }
  return validateBandsArtifact(parsed);
}

/** Fault on a directory that would fault at write time, before the ledger is read. */
export async function assertBandsDirUsable(dir: URL): Promise<void> {
  await prepareArtifactDir(withTrailingSlash(dir), LABEL);
}

/** Mint the next version number by scanning existing artifacts under dir. */
export async function nextVersion(dir: URL): Promise<number> {
  return nextArtifactVersion(withTrailingSlash(dir), LABEL);
}
