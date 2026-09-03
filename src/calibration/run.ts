// The offline calibration job (section 4.11, DEC-13, DEC-31).
//
// Classifies every fit-half ticket through the real classifier port, fits the
// ONE global agreement threshold (DEC-13) and writes a versioned artifact.
// The report half's CASES are never read here. On the committed corpus this
// module opens the fit half alone. On a real half it also opens the report
// file, to prove the two disjoint (DEC-31) — but only through
// readHalfIdentity, which returns identifiers and whose type has no field
// that could carry a subject or a body. So a case-level leak still needs a
// code change and not an accident.
//
// Every turn counts here. DEC-39 narrows the replay and the gold report to
// first turns because both score against a conversation-level disposition.
// This job scores a prediction against the case's own intent label, which a
// later turn carries, and section 6 requires the threshold to be re-fitted on
// multi-turn data. Each later turn is classified with the history the runtime
// would send (DEC-37), and the artifact records the population as `scope`.
//
// Offline and on demand. The monthly cadence in section 4.11 is operational,
// not code.

import { classifyTicket } from '../classifier/classifier.js';
import type { ClassifierTaxonomy } from '../classifier/classifier.js';
import { loadDotEnv, dataGuaranteeOption } from '../config/env.js';
import {
  FIT_COUNT,
  GOLD_SOURCES,
  assertHalvesDisjoint,
  conversationHistories,
  goldCaseText,
  halfDigest,
  identityOf,
  isFirstTurn,
  loadGoldHalf,
  loadTaxonomy,
} from '../fixtures/load.js';
import type { GoldFile, HalfIdentity } from '../fixtures/load.js';
import { selectHalf } from '../fixtures/half-from-env.js';
import type { ModelProvider } from '../models/provider.js';
import { OpenRouterProvider } from '../models/openrouter.js';
import { assertCalibrationDirUsable, nextVersion, validateCalibrationArtifact, writeCalibrationArtifact, defaultCalibrationDir } from './artifact.js';
import type { CalibrationArtifact, CalibrationScope } from './artifact.js';
import { fitAgreementThreshold } from './calibrate.js';
import { startedAsCommand } from '../corpus/output-path.js';

export interface CalibrationRunOptions {
  provider: ModelProvider;
  /** Defaults to the committed taxonomy fixture. */
  taxonomy?: ClassifierTaxonomy;
  /**
   * Defaults to fixtures/gold/fit.json. Injectable for tests. The runner
   * asserts the injected half really is the fit split (DEC-31).
   */
  fitHalf?: GoldFile;
  /**
   * Identifiers of the report half, for the DEC-31 proof.
   *
   * Required when the fit half is not the shipped corpus, and unnecessary
   * otherwise. This job must never open the report half's cases — the
   * guarantee that a leak needs a code change is worth more than any check —
   * so the caller reads the identifiers and passes those alone.
   */
  reportIdentity?: HalfIdentity;
  promptVer?: string;
  modelVer?: string;
  targetPrecision?: number;
  temperature?: number;
  /** Artifact directory override (tests). */
  artifactDir?: URL;
}

export const DEFAULT_TARGET_PRECISION = 0.985;

/**
 * How many fit cases may carry an unreadable sample before the fit is
 * measuring the answer budget rather than the model.
 *
 * Not the same rule the coverage job applies. That job drops a draft it could
 * not score, so the draft never reaches the fit. This job keeps the case and
 * fits on it, because a case with eight readable samples still measured
 * something; the ceiling bounds how much depressed evidence may enter, and
 * does not remove it. A reader of the artifact needs the count for that
 * reason, not despite it.
 */
const MAX_DEPRESSED_SHARE = 0.05;
const DEFAULT_PROMPT_VER = 'classify-p1';

export interface CalibrationRunResult {
  artifact: CalibrationArtifact;
}

/**
 * Run one calibration pass over the fit half only.
 *
 * DEC-31 discipline, enforced in order:
 * 1. only the fit half enters this function (the CLI loads fit.json alone);
 * 2. the injected half must declare split 'fit' and a provenance in the
 *    closed set; a half that is not the committed corpus must also carry the
 *    report half's identifiers, and the two are proved disjoint;
 * 3. the artifact records split_used 'fit' and the pair it proved, and the
 *    loader refuses any other split, and refuses a real fit that names no
 *    proved pair.
 */
export async function runCalibrationJob(
  options: CalibrationRunOptions,
): Promise<CalibrationRunResult> {
  const taxonomy = options.taxonomy ?? loadTaxonomy();
  const fitHalf = options.fitHalf ?? loadGoldHalf('fit');
  const promptVer = options.promptVer ?? DEFAULT_PROMPT_VER;
  const modelVer = options.modelVer;
  if (modelVer === undefined || modelVer.length === 0) {
    throw new Error('runCalibrationJob needs a pinned modelVer (DEC-26)');
  }
  const targetPrecision = options.targetPrecision ?? DEFAULT_TARGET_PRECISION;

  assertFitHalf(fitHalf, options.reportIdentity);

  // Check the artifact directory before the sampling loop, not after it. The
  // loop makes CLASSIFIER_K model calls per fit-half ticket, and nextVersion
  // reads the same listing either way; faulting afterwards threw away a run
  // an operator had already paid for, over a directory state visible before
  // the first call.
  const dir = options.artifactDir ?? defaultCalibrationDir();
  await assertCalibrationDirUsable(dir);

  // DEC-37: a later turn's prompt carries the turns before it. Fitting on the
  // bare message would fit a threshold for a prompt the runtime never sends.
  const histories = conversationHistories(fitHalf.tickets);

  // A ticket whose samples were unreadable enters the fit with a depressed
  // agreement, so the threshold is fitted on the provider's answer budget and
  // not on the model's judgement. The coverage job records its own attrition
  // for the same reason, by a different rule; this one must not stay silent.
  const samples: { agreement: number; correct: boolean }[] = [];
  let unreadableSamples = 0;
  let ticketsWithUnreadable = 0;
  for (const ticket of fitHalf.tickets) {
    const result = await classifyTicket(options.provider, {
      taxonomy,
      ticketText: goldCaseText(ticket),
      history: histories.get(ticket.ticket_id) ?? [],
      promptVer,
      modelVer,
      ...(options.temperature === undefined
        ? {}
        : { temperature: options.temperature }),
    });
    unreadableSamples += result.unreadableSamples;
    if (result.unreadableSamples > 0) ticketsWithUnreadable++;
    samples.push({
      agreement: result.agreement,
      correct: normalize(result.intentId) === normalize(ticket.intent),
    });
  }
  if (ticketsWithUnreadable > 0) {
    const share = ticketsWithUnreadable / fitHalf.tickets.length;
    if (share > MAX_DEPRESSED_SHARE) {
      throw new Error(
        `${ticketsWithUnreadable} of ${fitHalf.tickets.length} fit cases carry an unreadable `
          + `sample, above the ${MAX_DEPRESSED_SHARE} ceiling; the agreement this would fit on `
          + 'is the answer budget and not the model (DEC-13)',
      );
    }
    console.warn(
      `${unreadableSamples} samples across ${ticketsWithUnreadable} cases were unreadable `
        + 'and counted against agreement',
    );
  }

  const fit = fitAgreementThreshold(samples, { targetPrecision });

  const version = await nextVersion(dir);
  const artifact = validateCalibrationArtifact({
    artifact: 'agreement-threshold',
    version,
    fitted_at: new Date().toISOString(),
    gold_source: fitHalf.source,
    split_used: 'fit',
    scope: scopeOf(fitHalf),
    fit_tickets: fitHalf.tickets.length,
    unreadable_samples: unreadableSamples,
    tickets_with_unreadable: ticketsWithUnreadable,
    fit_half_digest: options.reportIdentity === undefined ? null : halfDigest(identityOf(fitHalf)),
    report_half_digest:
      options.reportIdentity === undefined ? null : halfDigest(options.reportIdentity),
    prompt_ver: promptVer,
    model_ver: modelVer,
    target_precision: targetPrecision,
    threshold: fit.threshold,
    precision_at_threshold: fit.precision,
    coverage_at_threshold: fit.coverage,
    interval: fit.interval,
  });
  await writeCalibrationArtifact(artifact, dir);
  return { artifact };
}

/**
 * Names the turn population this fit consumed.
 *
 * Derived from the half, never declared: the value then cannot drift from
 * the data a threshold was actually fitted on.
 */
function scopeOf(half: GoldFile): CalibrationScope {
  return half.tickets.every(isFirstTurn) ? 'first_turn' : 'all_turns';
}

/**
 * Refuse a half this job must not fit on.
 *
 * The split rule and the shape rule bind every half. The size rule does not:
 * The size describes the corpus this repository generates, and an adopter's
 * labelled half is whatever size their history gave them. Refusing it for
 * not being that size would say nothing about its correctness.
 *
 * What replaces the size rule is the DEC-31 proof. A synthetic half gets it
 * from the committed corpus, whose two halves the loader cross-checks. A
 * real half has no such guarantee, so the caller must name the report half's
 * identifiers and this refuses to fit without them. A threshold nobody
 * proved disjoint is a threshold fitted and published on one case.
 */
function assertFitHalf(half: GoldFile, reportIdentity: HalfIdentity | undefined): void {
  // The production loader cross-checks these; the injection path must not
  // trust a declared count that disagrees with the array it will fit on.
  if (half.count !== half.tickets.length) {
    throw new Error(
      `fit half declares ${half.count} tickets but carries ${half.tickets.length}`,
    );
  }
  // The loader checks this, and the injection path does not go through the
  // loader. A provenance nothing understands must not reach an artifact that
  // states it (DEC-18).
  if (!(GOLD_SOURCES as readonly string[]).includes(half.source)) {
    throw new Error(
      `calibration half declares source ${String(half.source)}, `
        + `expected one of ${GOLD_SOURCES.join(', ')} (DEC-18)`,
    );
  }
  if (half.split !== 'fit') {
    throw new Error(
      `calibration consumes the fit half only, got split '${half.split}' (DEC-31)`,
    );
  }
  if (half.source === 'synthetic') {
    // The committed corpus holds exactly FIT_COUNT fit tickets (DEC-31).
    if (half.count !== FIT_COUNT) {
      throw new Error(`fit half holds ${half.count} tickets, expected ${FIT_COUNT}`);
    }
  } else if (reportIdentity === undefined) {
    throw new Error(
      `a fit half of source '${half.source}' needs the report half's identifiers to prove `
        + 'the two are disjoint; calibration never opens the report half itself (DEC-31)',
    );
  }
  // Unconditional. An earlier version returned here for a synthetic half, on
  // the ground that the loader cross-checks the committed corpus. That ground
  // does not hold for a file read by path: `loadGoldHalf(split, path)` checks
  // nothing across halves, so a file declaring `synthetic` with that many SYN- ids
  // took the fit through with the caller's proof in hand and unused. A
  // counterpart the caller supplied is a counterpart this must check.
  if (reportIdentity !== undefined) {
    assertHalvesDisjoint(identityOf(half), reportIdentity);
  }
}

function normalize(text: string): string {
  return text.trim().toLowerCase();
}

// CLI entry: `pnpm run calibrate` executes dist/calibration/run.js.
// Needs OPENROUTER_API_KEY and CALIBRATION_MODEL_VER in the environment;
// CALIBRATION_TARGET_PRECISION overrides the default precision floor.
//
// GOLD_FIT_PATH points the job at a labelled half held outside the
// repository, following the CORPUS_PATH precedent. GOLD_REPORT_PATH must
// then name the other half. The job opens that file and validates it, and
// takes identifiers from it alone: no case of the report half reaches this
// job, and the type carrying them holds no field that could. Neither variable is
// needed for the committed synthetic corpus, whose halves the loader already
// cross-checks. Keep both files under corpus/, which is gitignored (DEC-18).
async function main(): Promise<void> {
  loadDotEnv();
  const apiKey = process.env['OPENROUTER_API_KEY'];
  if (!apiKey) {
    console.error('OPENROUTER_API_KEY is not set.');
    process.exitCode = 1;
    return;
  }
  const modelVer = process.env['CALIBRATION_MODEL_VER'];
  if (!modelVer) {
    console.error('CALIBRATION_MODEL_VER is not set.');
    process.exitCode = 1;
    return;
  }
  const rawTarget = process.env['CALIBRATION_TARGET_PRECISION'];
  const targetPrecision =
    rawTarget === undefined ? undefined : Number(rawTarget);
  if (rawTarget !== undefined && !(targetPrecision !== undefined && targetPrecision > 0 && targetPrecision <= 1)) {
    console.error(`CALIBRATION_TARGET_PRECISION must be in (0, 1], got ${rawTarget}`);
    process.exitCode = 1;
    return;
  }

  const selected = selectHalf('fit');
  if (selected.half !== undefined) {
    console.log(
      `fit half: ${String(selected.path)} (${selected.half.count} cases, source ${selected.half.source})`,
    );
  }

  const { artifact } = await runCalibrationJob({
    provider: new OpenRouterProvider({ apiKey, ...dataGuaranteeOption() }),
    modelVer,
    ...(selected.half === undefined ? {} : { fitHalf: selected.half }),
    ...(selected.counterpart === undefined ? {} : { reportIdentity: selected.counterpart }),
    ...(targetPrecision === undefined ? {} : { targetPrecision }),
  });
  console.log(
    `fitted global agreement threshold v${artifact.version} `
      + `(${artifact.tickets_with_unreadable ?? 0} of ${artifact.fit_tickets} cases carried an `
      + `unreadable sample): ${artifact.threshold} ` +
      `(precision ${artifact.precision_at_threshold}, coverage ${artifact.coverage_at_threshold}, ` +
      `${Math.round(artifact.interval.confidence * 100)}% CI [${artifact.interval.lower.toFixed(3)}, ${artifact.interval.upper.toFixed(3)}])`,
  );
}

const invokedDirectly =
  startedAsCommand(import.meta.url, process.argv[1]);

if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
