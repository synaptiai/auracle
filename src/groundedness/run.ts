// The offline groundedness fitting job (section 4.7, section 4.10, DEC-31).
//
// Runs the real gate over every labelled draft in the fit half, then fits the
// two coverage thresholds on what it measured against what was true.
//
// The report half's CASES are never read here. On the committed corpus this
// module opens the fit half alone. On a real half it also opens the report
// file, to prove the two disjoint (DEC-31) — but only through
// readHalfIdentity, which returns identifiers and whose type has no field
// that could carry a subject or a body. So a case-level leak still needs a
// code change and not an accident.
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
import {
  GOLD_SOURCES,
  assertHalvesDisjoint,
  halfDigest,
  identityOf,
  label,
  loadDocuments,
  loadGoldHalf,
} from '../fixtures/load.js';
import { selectHalf } from '../fixtures/half-from-env.js';
import type { GoldFile, GoldSource, GoldTicket, HalfIdentity } from '../fixtures/load.js';
import type { ModelProvider } from '../models/provider.js';
import { OpenRouterProvider } from '../models/openrouter.js';
import { loadDotEnv, dataGuaranteeOption } from '../config/env.js';
import { pathToFileURL } from 'node:url';

export const DEFAULT_TARGET_PRECISION = 0.985;
export const DEFAULT_TARGET_NPV = 0.9;
const DEFAULT_PROMPT_VER = 'ground-p1';

export interface GroundednessRunOptions {
  provider: ModelProvider;
  /**
   * Identifiers of the report half, for the DEC-31 proof. Required when the
   * fit half is not the shipped corpus; this job never opens the report
   * half's cases.
   */
  reportIdentity?: HalfIdentity;
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
  /**
   * The half's provenance, so a fault names a real case by digest (DEC-18).
   *
   * Required. A default here would let a call site forget it and leak a real
   * Message-ID with every test still green, which is worse than no parameter
   * at all: the type system would stop saying anything.
   */
  source: GoldSource,
): Promise<CoverageSample> {
  const claims = ticket.claims ?? [];
  if (claims.length === 0) {
    throw new Error(`gold case ${label(ticket.ticket_id, source)} carries no claims, so it has no coverage`);
  }
  // The gate reads the retrieved text, which here is the documents the claims
  // cite. Every claim of one draft is tested against the same set, as the
  // runtime does.
  const retrievedTexts = [...new Set(claims.map((c) => c.doc_id))].map((id) => {
    const body = bodies.get(id);
    if (body === undefined) {
      // The document id is the adopter's own on a real half, so it is named
      // by digest too. loadDocuments enforces the shipped DOC-SYN- prefixes,
      // so this is the first fault a real fit half hits.
      throw new Error(
        `gold case ${label(ticket.ticket_id, source)} cites unknown document ${label(id, source)}`,
      );
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

  assertFitHalf(fitHalf, options.reportIdentity);

  // Before the loop, not after it: the loop makes one model call per claim,
  // and a directory fault found afterwards throws away a run already paid for.
  const dir = options.artifactDir ?? defaultGroundednessDir();
  await assertGroundednessDirUsable(dir);

  const bodies = new Map(loadDocuments().map((d) => [d.doc_id, d.body]));
  // A case with no labelled claims cannot be scored, and on a real half most
  // cases will be unlabelled at first. Counting them keeps the same
  // count-what-you-drop discipline the export follows, and an upfront refusal
  // names the cause: without it a half with no labels died deep inside the
  // fitter with "needs both classes", which points at the wrong thing.
  const drafts = fitHalf.tickets.filter((t) => (t.claims ?? []).length > 0);
  const unlabelled = fitHalf.tickets.length - drafts.length;
  if (unlabelled > 0) {
    console.warn(
      `${unlabelled} of ${fitHalf.tickets.length} fit-half cases carry no labelled claims `
        + 'and are not scored (DEC-07)',
    );
  }
  if (drafts.length === 0) {
    throw new Error(
      `the fit half carries no labelled claims across ${fitHalf.tickets.length} cases; `
        + 'the coverage gate is fitted against per-claim ground truth (DEC-07)',
    );
  }
  const scored = options.limit === undefined ? drafts : drafts.slice(0, options.limit);

  const samples: CoverageSample[] = [];
  for (const ticket of scored) {
    samples.push(
      await scoreDraft(ticket, bodies, options.provider, { promptVer, modelVer }, fitHalf.source),
    );
  }

  const fit = fitCoverageThresholds(samples, { targetPrecision, targetNpv });

  const version = await nextVersion(dir);
  const artifact = validateGroundednessArtifact({
    artifact: 'groundedness-thresholds',
    version,
    fitted_at: new Date().toISOString(),
    gold_source: fitHalf.source,
    fit_half_digest: options.reportIdentity === undefined ? null : halfDigest(identityOf(fitHalf)),
    report_half_digest:
      options.reportIdentity === undefined ? null : halfDigest(options.reportIdentity),
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

/**
 * Refuse a half this job must not fit on. Same rule as the agreement fit.
 *
 * A synthetic half draws its DEC-31 proof from the committed corpus, whose
 * two halves the loader cross-checks. A real half has no such guarantee, so
 * the caller names the report half's identifiers and this refuses without
 * them. The job never opens the report half's cases.
 */
function assertFitHalf(half: GoldFile, reportIdentity: HalfIdentity | undefined): void {
  if (half.count !== half.tickets.length) {
    throw new Error(`fit half declares ${half.count} tickets but carries ${half.tickets.length}`);
  }
  // The loader checks this, and the injection path does not go through the
  // loader. A provenance nothing understands must not reach an artifact that
  // states it (DEC-18).
  if (!(GOLD_SOURCES as readonly string[]).includes(half.source)) {
    throw new Error(
      `groundedness fitting half declares source ${String(half.source)}, `
        + `expected one of ${GOLD_SOURCES.join(', ')} (DEC-18)`,
    );
  }
  if (half.split !== 'fit') {
    throw new Error(`groundedness fitting consumes the fit half only, got '${half.split}' (DEC-31)`);
  }
  if (half.source !== 'synthetic' && reportIdentity === undefined) {
    throw new Error(
      `a fit half of source '${half.source}' needs the report half's identifiers to prove `
        + 'the two are disjoint; groundedness fitting never opens the report half itself (DEC-31)',
    );
  }
  // Unconditional: see the note on the same check in calibration/run.ts. A
  // half read by path carries no cross-half guarantee, whatever it declares.
  if (reportIdentity !== undefined) {
    assertHalvesDisjoint(identityOf(half), reportIdentity);
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

  const selected = selectHalf('fit');
  if (selected.half !== undefined) {
    console.log(
      `fit half: ${String(selected.path)} (${selected.half.count} cases, source ${selected.half.source})`,
    );
  }

  const { artifact } = await runGroundednessJob({
    provider: new OpenRouterProvider({ apiKey, ...dataGuaranteeOption() }),
    modelVer,
    ...(selected.half === undefined ? {} : { fitHalf: selected.half }),
    ...(selected.counterpart === undefined ? {} : { reportIdentity: selected.counterpart }),
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
