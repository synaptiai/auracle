// Versioned judge-triage artifact — replay method 3 (section 4.10, DEC-09).
//
// The triage job writes its selections here. Each run mints a new version
// file (v1.json, v2.json, ...) so the review queue stays inspectable over
// time. Structure and validation mirror src/goldreport/artifact.ts, with one
// deliberate difference: this manifest may not carry a score. Validation
// whitelists every key, so an added rate, interval or accuracy field makes
// the artifact fail to load instead of quietly turning a selection tool into
// a published number (DEC-09).

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import type { CaseOrigin } from './select.js';

/** One case the judge sent to a person, with its provenance. */
export interface TriageSelection {
  ticket_id: string;
  /** Where the case came from: a gold split or live traffic. */
  origin: CaseOrigin;
  /** Why the judge picked the case. Provenance, not a score. */
  reason: string;
}

export interface TriageArtifact {
  /** Discriminates this artifact kind from other artifacts. */
  artifact: 'judge-triage';
  /** Monotonic version; each run of the job mints the next one. */
  version: number;
  /** ISO timestamp of the triage run. */
  generated_at: string;
  /** Section 4.10 method 3: the judge selects cases for human review. */
  method: 'judge-triage';
  /**
   * DEC-09 as code: this job selects, it never scores. A reader that wants
   * numbers must go to the gold report, never here.
   */
  role: 'selection';
  /** DEC-18: shipped runs consume synthetic cases only. */
  gold_source: 'synthetic';
  /** Cases the judge reviewed. */
  cases_reviewed: number;
  /** Cases the judge selected. Equal to selections.length by construction. */
  cases_selected: number;
  /** DEC-26 pins in force during the run. */
  prompt_ver: string;
  model_ver: string;
  /** Only selected cases are recorded; unselected cases name no file entry. */
  selections: TriageSelection[];
}

const ARTIFACT_NAME = 'judge-triage';

const TOP_LEVEL_KEYS = new Set([
  'artifact',
  'version',
  'generated_at',
  'method',
  'role',
  'gold_source',
  'cases_reviewed',
  'cases_selected',
  'prompt_ver',
  'model_ver',
  'selections',
]);

const SELECTION_KEYS = new Set(['ticket_id', 'origin', 'reason']);

const ORIGINS = new Set<CaseOrigin>(['fit', 'report', 'live']);

/** Resolved against this module's location so src and dist both reach <repo>/triage/. */
export function defaultTriageDir(): URL {
  return new URL('../../triage/', import.meta.url);
}

function withTrailingSlash(dir: URL): URL {
  return dir.href.endsWith('/') ? dir : new URL(`${dir.href}/`);
}

/** Validate an unknown value as a triage artifact. Exported for tests and
 * for consumers that read artifacts through their own transport. */
export function validateTriageArtifact(raw: unknown): TriageArtifact {
  assert(isRecord(raw), 'artifact is not an object');
  // Whitelist, not blacklist: any key outside the known set fails here, so a
  // future metric field cannot ride along unnoticed (DEC-09).
  for (const key of Object.keys(raw)) {
    assert(TOP_LEVEL_KEYS.has(key), `artifact has an unexpected field '${key}'`);
  }
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
  assert(raw['method'] === 'judge-triage', "artifact.method is not 'judge-triage' (section 4.10)");
  assert(raw['role'] === 'selection', "artifact.role is not 'selection' (DEC-09)");
  assert(raw['gold_source'] === 'synthetic', 'artifact.gold_source is not synthetic (DEC-18)');
  assertCount(raw['cases_reviewed'], 'cases_reviewed');
  // A judge may select nothing; zero is a legitimate outcome.
  assert(
    typeof raw['cases_selected'] === 'number' &&
      Number.isInteger(raw['cases_selected']) &&
      raw['cases_selected'] >= 0,
    'artifact.cases_selected is not a non-negative integer',
  );
  assert(
    typeof raw['prompt_ver'] === 'string' && raw['prompt_ver'].length > 0,
    'artifact.prompt_ver is missing',
  );
  assert(
    typeof raw['model_ver'] === 'string' && raw['model_ver'].length > 0,
    'artifact.model_ver is missing',
  );
  const selections = raw['selections'];
  assert(Array.isArray(selections), 'artifact.selections is not an array');
  const seen = new Set<string>();
  for (const [index, selection] of selections.entries()) {
    assert(isRecord(selection), `selection ${index} is not an object`);
    for (const key of Object.keys(selection)) {
      assert(SELECTION_KEYS.has(key), `selection ${index} has an unexpected field '${key}'`);
    }
    assert(
      typeof selection['ticket_id'] === 'string' && selection['ticket_id'].length > 0,
      `selection ${index} has no ticket_id`,
    );
    const ticketId = selection['ticket_id'] as string;
    assert(!seen.has(ticketId), `selection ${index} repeats ticket '${ticketId}'`);
    seen.add(ticketId);
    assert(
      typeof selection['origin'] === 'string' && ORIGINS.has(selection['origin'] as CaseOrigin),
      `selection ${index} has an unknown origin`,
    );
    assert(
      typeof selection['reason'] === 'string' && selection['reason'].length > 0,
      `selection ${index} has no reason`,
    );
  }
  assert(
    (raw['cases_reviewed'] as number) >= (raw['cases_selected'] as number),
    'artifact.cases_reviewed is smaller than cases_selected',
  );
  assert(
    selections.length === raw['cases_selected'],
    'artifact.cases_selected does not match the number of recorded selections',
  );
  return raw as unknown as TriageArtifact;
}

/** Write the artifact as v<version>.json under dir (defaults to <repo>/triage/).
 * Creates the directory when absent, so a first run on a fresh checkout works. */
export async function writeTriageArtifact(
  artifact: TriageArtifact,
  dir: URL = defaultTriageDir(),
): Promise<void> {
  const validated = validateTriageArtifact(artifact);
  const base = withTrailingSlash(dir);
  await mkdir(base, { recursive: true });
  await writeFile(
    new URL(`v${validated.version}.json`, base),
    JSON.stringify(validated, null, 2) + '\n',
  );
}

/**
 * Load a triage artifact by version, or the highest version when no version
 * is given. Returns null when nothing has been triaged yet.
 */
export async function loadTriageArtifact(
  version?: number,
  dir: URL = defaultTriageDir(),
): Promise<TriageArtifact | null> {
  const base = withTrailingSlash(dir);
  const target = version ?? (await highestVersion(base));
  if (target === null) return null;
  const text = await readFile(new URL(`v${target}.json`, base), 'utf8');
  return validateTriageArtifact(JSON.parse(text));
}

async function highestVersion(base: URL): Promise<number | null> {
  let names: string[];
  try {
    names = await readdir(base);
  } catch (err) {
    // An absent directory means nothing has been triaged yet.
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
  if (!ok) throw new Error(`triage artifact validation failed: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertCount(value: unknown, field: string): void {
  assert(
    typeof value === 'number' && Number.isInteger(value) && value > 0,
    `artifact.${field} is not a positive integer`,
  );
}
