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
import { loadDotEnv } from '../config/env.js';
import {
  FIT_COUNT, GOLD_SOURCES, REPORT_COUNT, goldCaseText, isFirstTurn,
} from '../domain/gold-types.js';
import { assertHalvesDisjoint, halfDigest, identityOf } from '../fixtures/digest.js';
import { conversationHistories, loadGoldHalf, loadTaxonomy } from '../fixtures/load.js';
import type { GoldFile, GoldTicket, HalfIdentity } from '../domain/gold-types.js';
import { selectHalf } from '../fixtures/half-from-env.js';
import type { ModelProvider } from '../models/provider.js';
import { openRouterFromEnv } from '../models/from-env.js';
import {
  assertCalibrationDirUsable, nextVersion, validateCalibrationArtifact, writeCalibrationArtifact, defaultCalibrationDir,
} from './artifact.js';
import type { CalibrationArtifact, CalibrationScope } from './artifact.js';
import { fitAgreementThreshold } from './calibrate.js';
import { fitPerIntent } from './per-intent.js';
import type { IntentSample } from './per-intent.js';
import { STUB_LABELLER_PIN, scoreLabeller } from '../labeller/labeller.js';
import { startedAsCommand } from '../corpus/output-path.js';
import { runEntry } from '../cli/entry.js';

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
  // Before the loop, never after. A label fault found afterwards discards a
  // run an operator has already paid for.
  assertLabelsScoreable(fitHalf.tickets);

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
  const samples: IntentSample[] = [];
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
      intent: ticket.intent,
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

  // DEC-41. The trigger counts labelled cases in the corpus, and the corpus
  // is both halves: DEC-31 splits one gold set in two and this job consumes
  // the fit half, so counting what the fit consumed would hold the trigger
  // permanently at half its own bar.
  //
  // Counted, never assumed. A first version read `FIT_COUNT + REPORT_COUNT`
  // and justified it with `assertFitHalf`, but that size check runs only for
  // a synthetic half — so an adopter's 200-case corpus cleared a trigger of
  // 8000 and installed per-intent gates DEC-41 forbids it. That failure was
  // open: unmeasured thresholds reached a live gate.
  //
  // A non-synthetic half always carries `reportIdentity`, because
  // `assertFitHalf` refuses one without it, so the counterpart's size is
  // available exactly where the constant is wrong.
  const counterpart = options.reportIdentity?.ticketIds.size
    ?? (fitHalf.source === 'synthetic' ? REPORT_COUNT : 0);
  const labelledCases = fitHalf.tickets.length + counterpart;
  const perIntent = fitPerIntent(samples, { targetPrecision, labelledCases });
  const labellers = labellersOf(fitHalf.tickets);

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
    trigger_min_labelled: perIntent.trigger_min_labelled,
    labelled_cases: perIntent.labelled_cases,
    per_intent: perIntent.per_intent,
    below_floor: perIntent.below_floor,
    ...(labellers.length === 0 ? {} : { labellers }),
  });
  await writeCalibrationArtifact(artifact, dir);
  return { artifact };
}

/**
 * What labelled the fit half, and how accurate each labeller was (DEC-41).
 *
 * A list, one entry per pin. DEC-41 asks for the count and the accuracy of
 * each kind, so a corpus labelled by two producers must be representable: an
 * earlier version returned a single entry and gave up — returning nothing at
 * all — the moment it saw two, which published per-intent thresholds with no
 * provenance and read exactly like a corpus that predates DEC-41.
 *
 * Each entry is scored over its own cases alone. Scoring one pin over the
 * whole half attributes cases to a labeller that did not label them.
 *
 * Empty when no case carries a label, which keeps a pre-DEC-41 gold set
 * usable.
 */
function labellersOf(
  tickets: readonly GoldTicket[],
): { kind: 'stub' | 'model'; pin: string; agreement: number; cases: number }[] {
  const byPin = new Map<string, GoldTicket[]>();
  for (const ticket of tickets) {
    if (ticket.labelled_by === undefined) continue;
    const group = byPin.get(ticket.labelled_by) ?? [];
    group.push(ticket);
    byPin.set(ticket.labelled_by, group);
  }
  // Sorted, so the artifact reads the same way on every run.
  return [...byPin.keys()].sort().map((pin) => {
    const score = scoreLabeller(byPin.get(pin)!);
    return {
      // The pin says which, and a stand-in must never read as a model.
      kind: pin === STUB_LABELLER_PIN ? 'stub' as const : 'model' as const,
      pin,
      agreement: score.agreement,
      cases: score.total,
    };
  });
}

/**
 * Refuses a half whose labels cannot be scored, before the run spends
 * anything.
 *
 * `scoreLabeller` throws on a case that carries a labeller but no label, and
 * it used to run after the classification loop — so one such case discarded a
 * run of 36 900 model calls over a field readable before the first one. This
 * is the hazard `assertCalibrationDirUsable` was moved ahead of the loop for.
 */
function assertLabelsScoreable(tickets: readonly GoldTicket[]): void {
  for (const ticket of tickets) {
    if (ticket.labelled_by === undefined) continue;
    if (ticket.labelled_intent === undefined || ticket.labelled_intent === '') {
      throw new Error(
        `case ${ticket.ticket_id} names a labeller but carries no label, so its `
          + 'agreement could be neither measured nor honestly omitted (DEC-41)',
      );
    }
  }
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
    provider: openRouterFromEnv(),
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
  void runEntry(main);
}
