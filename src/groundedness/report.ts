// The report half of the coverage measurement (section 4.7, section 4.10,
// DEC-31).
//
// DEC-31 splits one gold set in two: the thresholds are chosen on one half and
// every published number comes from the other. The fitting job held up the
// first side and refused every half but its own. Nothing held up the second,
// so the report half's coverage numbers were produced by a script written for
// one occasion and thrown away, and no adopter could reproduce them.
//
// This job measures. It never selects a threshold: it takes the pair it is
// given, applies it to the half that chose nothing, and says how that pair
// behaves there. A job that could also fit would let one run do both, which is
// the selection effect the split exists to remove.
//
// It writes no artifact. An artifact is a file a process adopts at startup,
// and nothing adopts this: the fitted pair already reaches the runtime through
// the groundedness artifact. These numbers are published prose, so they belong
// in the register and the README beside the other published figures. Writing
// them to a file nothing reads is the open loop this phase closed elsewhere.
import { fileURLToPath } from 'node:url';

import { wilsonInterval } from '../calibration/calibrate.js';
import type { FitInterval } from '../calibration/calibrate.js';
import {
  GOLD_SOURCES, assertHalvesDisjoint, halfDigest, identityOf, loadDocuments, loadGoldHalf,
} from '../fixtures/load.js';
import { selectHalf } from '../fixtures/half-from-env.js';
import type { GoldFile, HalfIdentity } from '../fixtures/load.js';
import { openResume } from './resume.js';
import { makeThresholds, SEED_THRESHOLDS } from '../policy/policy.js';
import { loadDotEnv, dataGuaranteeOption } from '../config/env.js';
import { OpenRouterProvider } from '../models/openrouter.js';
import type { ModelProvider } from '../models/provider.js';
import { defaultGroundednessDir, loadGroundednessArtifact } from './artifact.js';
import {
  DEFAULT_RETRY_DELAY_MS,
  assertDocumentsResolvable,
  describeFaultShapes, describeSpend, scoreHalf, scoringDigest,
} from './scoring.js';
import { startedAsCommand } from '../corpus/output-path.js';

/** How many drafts the judge may fail to score before the report means nothing. */
const MAX_FAULTED_SHARE = 0.05;

export interface CoverageReportOptions {
  readonly provider: ModelProvider;
  /** The half that fitted nothing. Refused if it declares any other split. */
  readonly reportHalf?: GoldFile;
  /**
   * Identifiers of the fit half, for the DEC-31 proof. Required when the
   * report half is not the shipped corpus; this job never opens the fit
   * half's cases.
   */
  readonly fitIdentity?: HalfIdentity;
  readonly modelVer: string;
  readonly promptVer?: string;
  /** The pair to measure. Taken, never chosen. */
  readonly thresholds: { readonly block: number; readonly review: number };
  readonly limit?: number;
  readonly retryDelayMs?: number;
  /** Where a run that dies picks up. Absent means no resume. */
  readonly resumeFile?: string;
}

export interface CoverageReportResult {
  readonly scoredDrafts: number;
  readonly faultedDrafts: number;
  /** Drafts at or above review, and the share of those truly grounded. */
  readonly reviewPassed: number;
  readonly reviewPrecision: number;
  /**
   * Null when no draft reached the band.
   *
   * An interval over zero trials is not a wide interval, it is no
   * measurement. Passing a denominator of one to keep the type simple
   * reported [0, 0.793] for a band nobody entered, which reads as a result.
   */
  readonly reviewInterval: FitInterval | null;
  /** Drafts below block, and the share of those truly ungrounded. */
  readonly blockBelow: number;
  readonly blockNpv: number;
  /** Null when no draft fell below the block threshold. See reviewInterval. */
  readonly blockInterval: FitInterval | null;
  /** What this measurement cost, and whether that figure is a floor (DEC-25). */
  readonly costMicros: number;
  readonly costUnknown: boolean;
}

export async function runCoverageReportJob(
  options: CoverageReportOptions,
): Promise<CoverageReportResult> {
  const modelVer = options.modelVer;
  if (!modelVer) {
    throw new Error('runCoverageReportJob needs a pinned modelVer (DEC-26)');
  }
  // The same constructor the policy engine uses, so a pair this job reports on
  // is a pair the engine would accept. An inverted pair leaves no review band
  // and the engine refuses it; measuring one would describe a gate that cannot
  // exist.
  makeThresholds({
    agreement: SEED_THRESHOLDS.agreement,
    groundednessBlock: options.thresholds.block,
    groundednessReview: options.thresholds.review,
  });

  const half = options.reportHalf ?? loadGoldHalf('report');
  assertReportHalf(half, options.fitIdentity);

  const bodies = new Map(loadDocuments().map((d) => [d.doc_id, d.body]));
  const drafts = half.tickets.filter((t) => (t.claims ?? []).length > 0);
  if (drafts.length === 0) {
    throw new Error(
      `the report half carries no labelled claims across ${half.tickets.length} cases; `
        + 'coverage is measured against per-claim ground truth (DEC-07)',
    );
  }
  const scored = options.limit === undefined ? drafts : drafts.slice(0, options.limit);

  assertDocumentsResolvable(scored, bodies, half.source);

  const promptVer = options.promptVer ?? DEFAULT_JUDGE_PROMPT_VER;
  const resume = options.resumeFile === undefined ? undefined : await openResume(
    options.resumeFile,
    {
      modelVer,
      promptVer,
      split: half.split,
      halfDigest: halfDigest(identityOf(half)),
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
    half.source,
    options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
    resume,
  );

  // The same ceiling the fit holds. A judge that drops the hard drafts leaves
  // a sample that flatters whatever is measured on it.
  if (faulted.length / scored.length > MAX_FAULTED_SHARE) {
    const shapes = describeFaultShapes(faultShapes);
    throw new Error(
      `the judge could not score ${faulted.length} of ${scored.length} drafts, above the `
        + `${MAX_FAULTED_SHARE} ceiling; the surviving sample no longer represents the half. `
        + `Shapes: ${shapes}`,
    );
  }
  if (samples.length === 0) {
    throw new Error('the coverage judge scored no draft of the report half (DEC-07)');
  }

  const passed = samples.filter((s) => s.coverage >= options.thresholds.review);
  const correct = passed.filter((s) => s.grounded).length;
  const below = samples.filter((s) => s.coverage < options.thresholds.block);
  const ungrounded = below.filter((s) => !s.grounded).length;

  return {
    scoredDrafts: samples.length,
    faultedDrafts: faulted.length,
    reviewPassed: passed.length,
    // A band nobody reaches has no precision. Reported as zero with an empty
    // band rather than as NaN, which reads as a measurement that failed.
    reviewPrecision: passed.length === 0 ? 0 : correct / passed.length,
    reviewInterval: passed.length === 0 ? null : wilsonInterval(correct, passed.length),
    blockBelow: below.length,
    blockNpv: below.length === 0 ? 0 : ungrounded / below.length,
    blockInterval: below.length === 0 ? null : wilsonInterval(ungrounded, below.length),
    costMicros,
    costUnknown,
  };
}

/**
 * Refuse to measure a pair under a pin it was not fitted under (DEC-26).
 *
 * The thresholds are the fit model's judgement of what coverage means. A model
 * that reads claims more generously reaches the same numbers on easier
 * evidence, so a pair measured under another pin describes a gate nothing ever
 * ran. An operator who means to change model must fit again.
 *
 * Exported so the rule has a test. Every other guard in this job has one; this
 * lived inside the CLI entry point, which is exactly where the defects this
 * branch fixed were hiding.
 */
export function pinMismatch(
  artifact: { version: number; model_ver: string; prompt_ver: string },
  modelVer: string,
  promptVer: string,
): string | null {
  const differing: string[] = [];
  if (artifact.model_ver !== modelVer) {
    differing.push(`model ${artifact.model_ver} against ${modelVer}`);
  }
  if (artifact.prompt_ver !== promptVer) {
    differing.push(`prompt ${artifact.prompt_ver} against ${promptVer}`);
  }
  if (differing.length === 0) return null;
  return `the coverage pair in v${artifact.version} was fitted under a different pin: `
    + `${differing.join(', ')}. A pair measured under another pin describes a gate `
    + 'nothing ran (DEC-26). Fit again, or set the pins the fit used.';
}

/** The judge prompt this job sends. One default, named once. */
export const DEFAULT_JUDGE_PROMPT_VER = 'ground-p1';

function promptVerFor(env: Readonly<Record<string, string | undefined>>): string {
  return env['GROUNDEDNESS_PROMPT_VER'] ?? DEFAULT_JUDGE_PROMPT_VER;
}

/** An empty band has no interval, and says so rather than printing one. */
function describeInterval(interval: FitInterval | null): string {
  return interval === null
    ? 'no interval: no draft reached this band'
    : `interval ${interval.lower.toFixed(4)} to ${interval.upper.toFixed(4)}`;
}

/**
 * Refuse a half this job must not report on. The mirror of `assertFitHalf`.
 *
 * A synthetic half draws its DEC-31 proof from the committed corpus, whose two
 * halves the loader cross-checks. A half read by path carries no such
 * guarantee, so the caller names the fit half's identifiers and this refuses
 * without them. The job never opens the fit half's cases.
 */
function assertReportHalf(half: GoldFile, fitIdentity: HalfIdentity | undefined): void {
  if (half.count !== half.tickets.length) {
    throw new Error(`report half declares ${half.count} tickets but carries ${half.tickets.length}`);
  }
  if (!(GOLD_SOURCES as readonly string[]).includes(half.source)) {
    throw new Error(
      `coverage reporting half declares source ${String(half.source)}, `
        + `expected one of ${GOLD_SOURCES.join(', ')} (DEC-18)`,
    );
  }
  if (half.split !== 'report') {
    throw new Error(
      `coverage reporting consumes the report half only, got '${half.split}' (DEC-31). `
        + 'A number reported from the half that chose the threshold carries the selection '
        + 'effect the split exists to remove',
    );
  }
  if (half.source !== 'synthetic' && fitIdentity === undefined) {
    throw new Error(
      `a report half of source '${half.source}' needs the fit half's identifiers to prove `
        + 'the two are disjoint; coverage reporting never opens the fit half itself (DEC-31)',
    );
  }
  if (fitIdentity !== undefined) {
    assertHalvesDisjoint(fitIdentity, identityOf(half));
  }
}

// Needs OPENROUTER_API_KEY and GROUNDEDNESS_MODEL_VER, like the fit. The pair
// comes from the highest groundedness artifact unless the caller names one.
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
  const artifact = await loadGroundednessArtifact();
  if (artifact === null) {
    console.error(
      'no groundedness artifact found. Run `pnpm run fit-groundedness` first: this job '
        + 'measures a fitted pair on the report half and never chooses one (DEC-31).',
    );
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
  const pinFault = pinMismatch(artifact, modelVer, promptVerFor(process.env));
  if (pinFault !== null) {
    console.error(pinFault);
    process.exitCode = 1;
    return;
  }
  // The same rule the fit and the gold report follow. Without this the job
  // silently read the committed synthetic report half whatever GOLD_REPORT_PATH
  // said, so a pair fitted on a real corpus was reported against synthetic
  // cases the fit had never seen.
  const selected = selectHalf('report');
  if (selected.half !== undefined) {
    console.error(
      `report half: ${String(selected.path)} (${selected.half.count} cases, `
        + `source ${selected.half.source})`,
    );
  }
  const result = await runCoverageReportJob({
    provider: new OpenRouterProvider({ apiKey, ...dataGuaranteeOption() }),
    modelVer,
    thresholds: { block: artifact.block, review: artifact.review },
    ...(selected.half === undefined ? {} : { reportHalf: selected.half }),
    ...(selected.counterpart === undefined ? {} : { fitIdentity: selected.counterpart }),
    // Under the artifact directory, which the repository ignores. A run that
    // dies continues here rather than starting the five hours over.
    resumeFile: process.env['GROUNDEDNESS_RESUME']
      ?? fileURLToPath(new URL('resume-report.jsonl', defaultGroundednessDir())),
    ...(limit === undefined ? {} : { limit }),
  });
  console.log(
    `report half at the pair fitted in v${artifact.version} `
      + `(block ${artifact.block}, review ${artifact.review}), `
      + `${result.scoredDrafts} drafts scored and ${result.faultedDrafts} dropped:`,
  );
  console.log(
    `  review precision ${result.reviewPrecision.toFixed(4)} on ${result.reviewPassed} drafts, `
      + describeInterval(result.reviewInterval),
  );
  console.log(
    `  block npv ${result.blockNpv.toFixed(4)} on ${result.blockBelow} drafts, `
      + describeInterval(result.blockInterval),
  );
  console.log(`  spend: ${describeSpend(result.costMicros, result.costUnknown)}`);
}

const invokedDirectly =
  startedAsCommand(import.meta.url, process.argv[1]);
if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
