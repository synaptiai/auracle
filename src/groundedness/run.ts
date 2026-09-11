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
  DEFAULT_RETRY_DELAY_MS, assertDocumentsResolvable, describeFaultShapes, describeSpend,
  scoreHalf, scoringDigest,
} from './scoring.js';
import { openResume } from './resume.js';
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
import { openRouterFromEnv } from '../models/from-env.js';
import { loadDotEnv } from '../config/env.js';
import { fileURLToPath } from 'node:url';
import { startedAsCommand } from '../corpus/output-path.js';
import { runEntry } from '../cli/entry.js';

/**
 * The precision the review threshold must hold, and why.
 *
 * A policy choice, not a fitted number, and it needs a reason of its own. The
 * value coincides with the classifier simulation of paragraph 4.5, at k=9 and
 * a threshold of 0.6. That is the agreement gate, and DEC-05 keeps the two
 * gates independent, so a number borrowed from one is no justification for the
 * other. It is set here on coverage grounds instead.
 *
 * The review threshold decides the automatic path for an internal write
 * (paragraph 4.7). A draft above it executes with no person reading it. So one
 * minus this floor is the rate at which a write acts on a claim the retrieved
 * sources do not support.
 *
 * Paragraph 4.7 also says this gate is the only defence against a confident
 * error, because agreement cannot find one. A gate that backstops another gate
 * must be at least as strict as the gate it backstops, or the backstop is the
 * weaker link and the pair is only as good as this one. The agreement gate
 * operates at 0.985, so this floor is 0.985 and could defensibly be higher.
 *
 * The floor is read against the lower bound of a 95 percent interval, so it
 * also sets a minimum support: 253 drafts above the threshold, from
 * `minimumSupport`. A corpus that cannot offer them produces a refusal.
 */
export const DEFAULT_TARGET_PRECISION = 0.985;

/**
 * The negative predictive value the block threshold must hold.
 *
 * Below block a draft is escalated and no person sees it as a draft to
 * approve, so one minus this floor is the rate at which a grounded draft is
 * thrown away. That is a cost in work, not in correctness, which is why this
 * floor sits below the review floor rather than beside it.
 */
export const DEFAULT_TARGET_NPV = 0.9;
const DEFAULT_PROMPT_VER = 'ground-p1';

/**
 * How many drafts the judge may fail to score before the run is meaningless.
 *
 * A policy choice, not a fitted number. The one measurement this repository
 * holds saw no faulted draft in fifty-two against the pinned model, which
 * bounds the rate loosely and cannot justify a ceiling on its own. Five in a
 * hundred leaves room for a rare fault and none for a systemic one.
 *
 * Attrition is not free even below the ceiling: a judge that faults more
 * often on long drafts drops the negatives that set the block threshold, and
 * the surviving sample then flatters the fit. The artifact records the count
 * so a reader can see how much of the half was dropped.
 */
const MAX_FAULTED_SHARE = 0.05;

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
  /** Overrides DEFAULT_RETRY_DELAY_MS. Tests set it to zero. */
  retryDelayMs?: number;
  /** Where a run that dies picks up. Absent means no resume. */
  resumeFile?: string;
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

/**
 * One draft's measured coverage beside its ground truth, and what it cost.
 *
 * The spend is returned rather than dropped. An earlier version discarded
 * `costMicros` here, so the job that spends the most money in the repository
 * was the one job that could not say what it spent (DEC-25).
 */
export interface ScoredDraft {
  readonly sample: CoverageSample;
  readonly costMicros: number;
  /**
   * True when this draft's spend is understated.
   *
   * A judge call that raises carries the cost of that call alone. The claims
   * of the same draft already judged cost money that nothing recorded, and a
   * transport attempt that never answered may still have been billed. Neither
   * is knowable from here, so the run says the figure is a floor rather than
   * reporting a floor as a total.
   */
  readonly costUnknown: boolean;
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
): Promise<ScoredDraft> {
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
      // by digest too. Both jobs resolve every cited document before their
      // first model call, so neither reaches this; it holds for a direct
      // caller of `scoreDraft`, which the suite is.
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
    sample: {
      coverage: measured.groundedness,
      grounded: unsupported.length === 0,
      // The hardest grade present decides how the draft is reported: a draft
      // carrying one easy and one hard negative is not an easy case.
      grade: unsupported.length === 0
        ? null
        : hardestGrade(unsupported.map((c) => c.grade ?? 'absent')),
    },
    costMicros: measured.costMicros,
    costUnknown: false,
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

  // One unreadable answer must not discard a whole fitting run. The runtime
  // escalates such a draft because a customer is waiting on it; this job is
  // offline and its correct answer is to drop the draft it could not score and
  // say how many it dropped. A systemic fault still fails: above the ceiling
  // the sample no longer represents the half, and a threshold fitted on it
  // would carry a confidence the data does not support.
  assertDocumentsResolvable(scored, bodies, fitHalf.source);

  const resume = options.resumeFile === undefined ? undefined : await openResume(
    options.resumeFile,
    {
      modelVer,
      promptVer,
      split: fitHalf.split,
      halfDigest: halfDigest(identityOf(fitHalf)),
      // Digested over the whole labelled set, never over the limited slice.
      // `limit` exists to measure separability before a full run, and keying
      // on the slice made the pilot's file describe "different claims" to the
      // full run that followed — refusing samples that were paid for and
      // perfectly reusable.
      inputDigest: scoringDigest(drafts, bodies),
    },
  );
  const { samples, faulted, faultShapes, costMicros, costUnknown } = await scoreHalf(
    scored,
    bodies,
    options.provider,
    { promptVer, modelVer },
    fitHalf.source,
    options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
    resume,
  );
  if (faulted.length > 0) {
    const share = faulted.length / scored.length;
    if (share > MAX_FAULTED_SHARE) {
      const shapes = describeFaultShapes(faultShapes);
      throw new Error(
        `the coverage judge returned an unreadable answer on ${faulted.length} of `
          + `${scored.length} drafts, above the ${MAX_FAULTED_SHARE} ceiling; the scored `
          + `sample no longer represents the half (DEC-07). Shapes: ${shapes}`,
      );
    }
    console.warn(
      `dropped ${faulted.length} of ${scored.length} drafts the judge could not score: `
        + faulted.join(', '),
    );
  }
  if (samples.length === 0) {
    throw new Error('the coverage judge scored no draft at all (DEC-07)');
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
    faulted_drafts: faulted.length,
    cost_micros: costMicros,
    cost_unknown: costUnknown,
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
 * A synthetic half draws its DEC-31 proof from the committed corpus, whose two
 * halves `loadGoldSet` cross-checks. Note where that happens: this job calls
 * `loadGoldHalf`, which opens one half and does not cross-check anything. The
 * committed corpus's proof is carried by the fixture suite, which loads the
 * set, and by the CI gate that regenerates it — not by this call path.
 *
 * A real half has no such guarantee at all, so the caller names the report
 * half's identifiers and this refuses without them. The job never opens the
 * report half's cases.
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
    provider: openRouterFromEnv(),
    modelVer,
    ...(selected.half === undefined ? {} : { fitHalf: selected.half }),
    ...(selected.counterpart === undefined ? {} : { reportIdentity: selected.counterpart }),
    resumeFile: process.env['GROUNDEDNESS_RESUME']
      ?? fileURLToPath(new URL('resume-fit.jsonl', defaultGroundednessDir())),
    ...(limit === undefined ? {} : { limit }),
  });
  console.log(
    `fitted coverage thresholds v${artifact.version} on ${artifact.fit_drafts} drafts `
      + `(${artifact.faulted_drafts} dropped unscored): `
      + `block ${artifact.block} (npv ${artifact.block_npv.toFixed(3)}), `
      + `review ${artifact.review} (precision ${artifact.review_precision.toFixed(3)}, `
      + `coverage ${artifact.review_coverage.toFixed(3)})`,
  );
  console.log(`  spend: ${describeSpend(artifact.cost_micros, artifact.cost_unknown)}`);
  for (const grade of artifact.by_grade) {
    console.log(`  ${grade.grade}: ${grade.drafts} drafts, mean coverage ${grade.mean_coverage.toFixed(3)}`);
  }
}

const invokedDirectly =
  startedAsCommand(import.meta.url, process.argv[1]);

if (invokedDirectly) {
  void runEntry(main);
}
