// The offline groundedness fitting job (section 4.7, section 4.10, DEC-31).
//
// Runs the real gate over every labelled draft in the fit half, then fits the
// two coverage thresholds on what it measured against what was true.
//
// The report half is never read here: this module imports loadGoldHalf, not
// loadGoldSet, so a leak needs a code change and not an accident (DEC-31).
//
// The job refuses more readily than it emits. A corpus whose classes do not
// separate produces a threshold any candidate would satisfy, and the fit
// throws rather than publishing one. That refusal is a legitimate outcome and
// section 6 keeps its caveat when it happens.

import { checkGroundedness } from './groundedness.js';
import { fitCoverageThresholds } from './fit.js';
import type { CoverageSample } from './fit.js';
import {
  assertGroundednessDirUsable,
  defaultGroundednessDir,
  nextVersion,
  validateGroundednessArtifact,
  writeGroundednessArtifact,
} from './artifact.js';
import type { GroundednessArtifact } from './artifact.js';
import { loadDocuments, loadGoldHalf } from '../fixtures/load.js';
import type { GoldFile, GoldTicket } from '../fixtures/load.js';
import type { ModelProvider } from '../models/provider.js';
import { OpenRouterProvider } from '../models/openrouter.js';
import { loadDotEnv, dataGuaranteeOption } from '../config/env.js';
import { pathToFileURL } from 'node:url';

export const DEFAULT_TARGET_PRECISION = 0.985;
export const DEFAULT_TARGET_NPV = 0.9;
const DEFAULT_PROMPT_VER = 'ground-p1';

export interface GroundednessRunOptions {
  provider: ModelProvider;
  /** Defaults to fixtures/gold/fit.json. The runner asserts the split (DEC-31). */
  fitHalf?: GoldFile;
  promptVer?: string;
  modelVer?: string;
  targetPrecision?: number;
  targetNpv?: number;
  /** Cap the drafts scored. Used to measure separability before a full run. */
  limit?: number;
  artifactDir?: URL;
}

export interface GroundednessRunResult {
  artifact: GroundednessArtifact;
  samples: CoverageSample[];
}

/** One draft's measured coverage beside its ground truth. */
export async function scoreDraft(
  ticket: GoldTicket,
  bodies: ReadonlyMap<string, string>,
  provider: ModelProvider,
  pins: { promptVer: string; modelVer: string },
): Promise<CoverageSample> {
  const claims = ticket.claims ?? [];
  if (claims.length === 0) {
    throw new Error(`gold case ${ticket.ticket_id} carries no claims, so it has no coverage`);
  }
  // The gate reads the retrieved text, which here is the documents the claims
  // cite. Every claim of one draft is tested against the same set, as the
  // runtime does.
  const retrievedTexts = [...new Set(claims.map((c) => c.doc_id))].map((id) => {
    const body = bodies.get(id);
    if (body === undefined) {
      throw new Error(`gold case ${ticket.ticket_id} cites unknown document ${id}`);
    }
    return body;
  });

  const measured = await checkGroundedness(
    { claims: claims.map((c) => c.text), retrievedTexts },
    { provider, versions: pins },
  );

  const unsupported = claims.filter((c) => !c.supported);
  return {
    coverage: measured.groundedness,
    grounded: unsupported.length === 0,
    // The hardest grade present decides how the draft is reported: a draft
    // carrying one easy and one hard negative is not an easy case.
    grade: unsupported.length === 0 ? null : hardestGrade(unsupported.map((c) => c.grade ?? 'absent')),
  };
}

/** Hardest first, so a mixed draft is counted by the claim that matters. */
const GRADE_ORDER = ['unstated_detail', 'absent', 'off_topic'] as const;

function hardestGrade(grades: readonly string[]): string {
  for (const grade of GRADE_ORDER) {
    if (grades.includes(grade)) return grade;
  }
  return grades[0] as string;
}

export async function runGroundednessJob(
  options: GroundednessRunOptions,
): Promise<GroundednessRunResult> {
  const fitHalf = options.fitHalf ?? loadGoldHalf('fit');
  const promptVer = options.promptVer ?? DEFAULT_PROMPT_VER;
  const modelVer = options.modelVer;
  if (modelVer === undefined || modelVer.length === 0) {
    throw new Error('runGroundednessJob needs a pinned modelVer (DEC-26)');
  }
  const targetPrecision = options.targetPrecision ?? DEFAULT_TARGET_PRECISION;
  const targetNpv = options.targetNpv ?? DEFAULT_TARGET_NPV;

  assertFitHalf(fitHalf);

  // Before the loop, not after it: the loop makes one model call per claim,
  // and a directory fault found afterwards throws away a run already paid for.
  const dir = options.artifactDir ?? defaultGroundednessDir();
  await assertGroundednessDirUsable(dir);

  const bodies = new Map(loadDocuments().map((d) => [d.doc_id, d.body]));
  const drafts = fitHalf.tickets.filter((t) => (t.claims ?? []).length > 0);
  const scored = options.limit === undefined ? drafts : drafts.slice(0, options.limit);

  const samples: CoverageSample[] = [];
  for (const ticket of scored) {
    samples.push(await scoreDraft(ticket, bodies, options.provider, { promptVer, modelVer }));
  }

  const fit = fitCoverageThresholds(samples, { targetPrecision, targetNpv });

  const version = await nextVersion(dir);
  const artifact = validateGroundednessArtifact({
    artifact: 'groundedness-thresholds',
    version,
    fitted_at: new Date().toISOString(),
    gold_source: 'synthetic',
    split_used: 'fit',
    fit_drafts: samples.length,
    prompt_ver: promptVer,
    model_ver: modelVer,
    target_precision: targetPrecision,
    target_npv: targetNpv,
    block: fit.block.threshold,
    block_npv: fit.block.npv,
    block_drafts: fit.block.blocked,
    block_interval: fit.block.interval,
    review: fit.review.threshold,
    review_precision: fit.review.precision,
    review_coverage: fit.review.coverage,
    review_interval: fit.review.interval,
    by_grade: fit.byGrade.map((g) => ({
      grade: g.grade,
      drafts: g.drafts,
      mean_coverage: g.meanCoverage,
    })),
  });
  await writeGroundednessArtifact(artifact, dir);
  return { artifact, samples };
}

function assertFitHalf(half: GoldFile): void {
  if (half.count !== half.tickets.length) {
    throw new Error(`fit half declares ${half.count} tickets but carries ${half.tickets.length}`);
  }
  if (half.split !== 'fit') {
    throw new Error(`groundedness fitting consumes the fit half only, got '${half.split}' (DEC-31)`);
  }
  if (half.source !== 'synthetic') {
    throw new Error('groundedness fitting runs on synthetic gold data only (DEC-18)');
  }
}

// CLI entry: `pnpm run fit-groundedness` executes dist/groundedness/run.js.
// Needs OPENROUTER_API_KEY and GROUNDEDNESS_MODEL_VER. One model call per
// claim, so a full fit half is roughly a thousand calls.
//
// The job may refuse. Classes that do not separate produce a threshold any
// candidate would satisfy, and a refusal leaves section 6's caveat standing
// rather than replacing it with a number that measured nothing.
async function main(): Promise<void> {
  loadDotEnv();
  const apiKey = process.env['OPENROUTER_API_KEY'];
  if (!apiKey) {
    console.error('OPENROUTER_API_KEY is not set.');
    process.exitCode = 1;
    return;
  }
  const modelVer = process.env['GROUNDEDNESS_MODEL_VER'];
  if (!modelVer) {
    console.error('GROUNDEDNESS_MODEL_VER is not set.');
    process.exitCode = 1;
    return;
  }
  const rawLimit = process.env['GROUNDEDNESS_LIMIT'];
  const limit = rawLimit === undefined ? undefined : Number(rawLimit);
  if (rawLimit !== undefined && !(Number.isInteger(limit) && (limit as number) > 0)) {
    console.error(`GROUNDEDNESS_LIMIT must be a positive integer, got ${rawLimit}`);
    process.exitCode = 1;
    return;
  }

  const { artifact } = await runGroundednessJob({
    provider: new OpenRouterProvider({ apiKey, ...dataGuaranteeOption() }),
    modelVer,
    ...(limit === undefined ? {} : { limit }),
  });
  console.log(
    `fitted coverage thresholds v${artifact.version} on ${artifact.fit_drafts} drafts: `
      + `block ${artifact.block} (npv ${artifact.block_npv.toFixed(3)}), `
      + `review ${artifact.review} (precision ${artifact.review_precision.toFixed(3)}, `
      + `coverage ${artifact.review_coverage.toFixed(3)})`,
  );
  for (const grade of artifact.by_grade) {
    console.log(`  ${grade.grade}: ${grade.drafts} drafts, mean coverage ${grade.mean_coverage.toFixed(3)}`);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
