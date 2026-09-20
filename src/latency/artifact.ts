// Versioned latency artifact (docs/v1-architecture.md section 6, V2 open item 7).
//
// The latency job writes its per-partition distributions here. Each run mints
// a new version file rather than overwriting the last, so the files an
// adopter accumulates are the record open item 7 asks for: a busy week and a
// quiet one, kept side by side for whoever chooses the correction.
//
// This module does not perform that comparison, and says so rather than
// implying one. `loadLatencyArtifact` reads a written file back, which is how
// the job's own suite checks that what reached disk is what it computed.
//
// Structure and validation mirror src/triage/artifact.ts. One deliberate
// difference: this artifact carries counts beside every distribution, and the
// validator refuses a distribution that reports a percentile without the
// support behind it. A p99 over three runs is not a p99, and an artifact that
// could state one without saying so would be read as though it were.

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
const LABEL = 'latency';
const ARTIFACT_NAME = 'run-latency';

/** One duration distribution as the artifact records it. */
export interface ArtifactDistribution {
  count: number;
  p50_ms: number | null;
  p95_ms: number | null;
  p99_ms: number | null;
  max_ms: number | null;
}

/**
 * Every exclusion carries its own count, and none is folded into `count`.
 *
 * One label per remedy. `unmeasured` sends an operator to a run with no
 * intake row and `unordered` sends them to two hosts that disagree about the
 * time; one count covering both would send them to neither.
 */
export interface ArtifactPartition {
  partition: number;
  wait: ArtifactDistribution & {
    /** Runs with no arrival time. */
    unmeasured: number;
    /** Runs whose pickup precedes their arrival, so the wait is not a duration. */
    unordered: number;
  };
  service: ArtifactDistribution & {
    /** Runs not yet in a terminal state. Keyed on the state, not on a null finish. */
    unfinished: number;
    /** Terminal runs from before `db/005` added the finish column. */
    unstamped: number;
    /** Terminal runs whose finish precedes their creation. */
    unordered: number;
    /** Terminal runs that never entered service, such as an intake abandonment. */
    never_ran: number;
    /** Runs that were ever snoozed (DEC-48), whose duration is a wait. */
    snoozed: number;
  };
}

export interface LatencyArtifact {
  /** Discriminates this artifact kind from the others. */
  artifact: 'run-latency';
  /** Monotonic version; each run of the job mints the next one. */
  version: number;
  /** ISO timestamp of the reporting run. */
  generated_at: string;
  /**
   * V2 open item 7 as code: this job observes, it never corrects.
   *
   * Item 7 asks for the data a correction needs. Choosing a correction needs
   * production data this repository does not have, so a reader must not take
   * this file for one.
   */
  role: 'observation';
  /**
   * The window the figures cover. Null means the whole ledger.
   *
   * Recorded because a latency figure without its window is unreadable: an
   * hour of an incident and a quiet month produce very different numbers and
   * nothing else in the file would say which this is.
   */
  since: string | null;
  /** Runs the window covered, across every partition. */
  runs: number;
  /** One row per partition holding a run, lowest partition first. */
  partitions: ArtifactPartition[];
}

/** Resolved against this module's location so src and dist both reach <repo>/latency/. */
export function defaultLatencyDir(): URL {
  return new URL('../../latency/', import.meta.url);
}

function withTrailingSlash(dir: URL): URL {
  return dir.href.endsWith('/') ? dir : new URL(`${dir.href}/`);
}

function assert(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(`latency artifact validation failed: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A count is a non-negative integer. Zero is a real answer here. */
function assertCount(value: unknown, field: string): void {
  assert(
    typeof value === 'number' && Number.isInteger(value) && value >= 0,
    `artifact.${field} is not a count`,
  );
}

/**
 * A distribution, and the rule that gives it meaning.
 *
 * A percentile with no runs behind it is not a small measurement, it is no
 * measurement. So a count of zero must carry null percentiles, and a non-zero
 * count must carry real ones. Either mismatch is a file that reports a figure
 * nobody could have computed.
 */
function assertDistribution(raw: unknown, field: string): void {
  assert(isRecord(raw), `artifact.${field} is not an object`);
  assertCount(raw['count'], `${field}.count`);
  const count = raw['count'] as number;
  for (const key of ['p50_ms', 'p95_ms', 'p99_ms', 'max_ms'] as const) {
    const value = raw[key];
    if (count === 0) {
      assert(
        value === null,
        `artifact.${field}.${key} reports a figure over zero runs`,
      );
      continue;
    }
    assert(
      typeof value === 'number' && Number.isFinite(value) && value >= 0,
      `artifact.${field}.${key} is not a duration`,
    );
  }
  // Ordering, because a p50 above a p99 describes a distribution that cannot
  // exist and would send an operator to the wrong partition.
  if (count > 0) {
    const p50 = raw['p50_ms'] as number;
    const p95 = raw['p95_ms'] as number;
    const p99 = raw['p99_ms'] as number;
    const max = raw['max_ms'] as number;
    assert(p50 <= p95 && p95 <= p99 && p99 <= max, `artifact.${field} percentiles are not ordered`);
  }
}

/** Validate an unknown value as a latency artifact. Exported for tests. */
export function validateLatencyArtifact(raw: unknown): LatencyArtifact {
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
  // Whitelisted, like the triage artifact's role. An artifact that could call
  // itself a correction would turn an observation into a decision nobody made.
  assert(raw['role'] === 'observation', "artifact.role is not 'observation' (V2 open item 7)");
  const since = raw['since'];
  assert(
    since === null || (typeof since === 'string' && !Number.isNaN(Date.parse(since))),
    'artifact.since is neither null nor a timestamp',
  );
  assertCount(raw['runs'], 'runs');
  const partitions = raw['partitions'];
  assert(Array.isArray(partitions), 'artifact.partitions is not an array');
  let seen = -1;
  let total = 0;
  for (const [i, entry] of partitions.entries()) {
    assert(isRecord(entry), `artifact.partitions[${i}] is not an object`);
    const partition = entry['partition'];
    assert(
      typeof partition === 'number' && Number.isInteger(partition) && partition >= 0,
      `artifact.partitions[${i}].partition is not a partition number`,
    );
    // Ascending and unique: two rows for one partition would let the reader's
    // eye settle on whichever came first, and nothing records which was read.
    assert(
      partition > seen,
      `artifact.partitions[${i}] repeats or unsorts partition ${partition}`,
    );
    seen = partition;
    const wait = entry['wait'];
    const service = entry['service'];
    assertDistribution(wait, `partitions[${i}].wait`);
    assertDistribution(service, `partitions[${i}].service`);
    const waitTotal = assertExclusions(wait, `partitions[${i}].wait`, ['unmeasured', 'unordered']);
    const serviceTotal = assertExclusions(service, `partitions[${i}].service`, [
      'unfinished',
      'unstamped',
      'unordered',
      'never_ran',
      'snoozed',
    ]);
    // The two distributions partition the same runs, so their totals must
    // agree. Nothing else in this file notices a wait figure written into the
    // service field: both halves stay individually well formed and ordered,
    // and the report then names the wrong partition as the busy one.
    assert(
      waitTotal === serviceTotal,
      `artifact.partitions[${i}] covers ${waitTotal} runs by wait and ${serviceTotal} by service`,
    );
    total += waitTotal;
  }
  // `runs` is the sum of what the partitions account for. Left unchecked it
  // was a free-standing number that could say anything at all.
  assert(
    raw['runs'] === total,
    `artifact.runs is ${String(raw['runs'])}, but the partitions account for ${total}`,
  );
  return raw as unknown as LatencyArtifact;
}

/**
 * Checks each exclusion count and returns the runs the distribution covers.
 *
 * Every run in a partition is either measured or excluded for exactly one
 * named reason, so the counts sum to the partition's population. Returning
 * that sum lets the caller check the two distributions against each other.
 */
function assertExclusions(
  raw: unknown,
  field: string,
  names: readonly string[],
): number {
  // Validated here rather than relying on `assertDistribution` having run
  // first. It does today, at both call sites. A third call site without it
  // would make `total` NaN, and the caller's message would then report
  // "covers NaN runs" instead of naming the field that was wrong.
  assert(isRecord(raw), `artifact.${field} is not an object`);
  const record = raw;
  assertCount(record['count'], `${field}.count`);
  let total = record['count'] as number;
  for (const name of names) {
    assertCount(record[name], `${field}.${name}`);
    total += record[name] as number;
  }
  return total;
}

export async function writeLatencyArtifact(
  artifact: LatencyArtifact,
  dir: URL = defaultLatencyDir(),
): Promise<void> {
  const validated = validateLatencyArtifact(artifact);
  const base = withTrailingSlash(dir);
  await mkdir(base, { recursive: true });
  await writeFile(new URL(`v${validated.version}.json`, base), JSON.stringify(validated, null, 2) + '\n');
}

/** Load by version, or the highest when none is given. Null when nothing exists. */
export async function loadLatencyArtifact(
  version?: number,
  dir: URL = defaultLatencyDir(),
): Promise<LatencyArtifact | null> {
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
  return validateLatencyArtifact(JSON.parse(await readArtifactText(base, found, LABEL)));
}

/** Fault on a directory that would fault at write time, before the job reads anything. */
export async function assertLatencyDirUsable(dir: URL): Promise<void> {
  await prepareArtifactDir(withTrailingSlash(dir), LABEL);
}

/** Mint the next version number by scanning existing artifacts under dir. */
export async function nextVersion(dir: URL): Promise<number> {
  return nextArtifactVersion(withTrailingSlash(dir), LABEL);
}
