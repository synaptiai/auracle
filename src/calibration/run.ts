// The offline calibration job (section 4.11, DEC-13, DEC-31).
//
// Classifies every fit-half ticket through the real classifier port, fits the
// ONE global agreement threshold (DEC-13) and writes a versioned artifact.
// The report half is never read here: this module imports loadGoldHalf, not
// loadGoldSet, so a report-half leak needs a code change, not an accident.
//
// Offline and on demand. The monthly cadence in section 4.11 is operational,
// not code.

import { classifyTicket } from '../classifier/classifier.js';
import type { ClassifierTaxonomy } from '../classifier/classifier.js';
import { FIT_COUNT, loadGoldHalf, loadTaxonomy } from '../fixtures/load.js';
import type { GoldFile } from '../fixtures/load.js';
import type { ModelProvider } from '../models/provider.js';
import { OpenRouterProvider } from '../models/openrouter.js';
import { pathToFileURL } from 'node:url';
import { nextVersion, validateCalibrationArtifact, writeCalibrationArtifact, defaultCalibrationDir } from './artifact.js';
import type { CalibrationArtifact } from './artifact.js';
import { fitAgreementThreshold } from './calibrate.js';

export interface CalibrationRunOptions {
  provider: ModelProvider;
  /** Defaults to the committed taxonomy fixture. */
  taxonomy?: ClassifierTaxonomy;
  /**
   * Defaults to fixtures/gold/fit.json. Injectable for tests. The runner
   * asserts the injected half really is the fit split (DEC-31).
   */
  fitHalf?: GoldFile;
  promptVer?: string;
  modelVer?: string;
  targetPrecision?: number;
  temperature?: number;
  /** Artifact directory override (tests). */
  artifactDir?: URL;
}

export const DEFAULT_TARGET_PRECISION = 0.985;
const DEFAULT_PROMPT_VER = 'classify-p1';

export interface CalibrationRunResult {
  artifact: CalibrationArtifact;
}

/**
 * Run one calibration pass over the fit half only.
 *
 * DEC-31 discipline, enforced in order:
 * 1. only the fit half enters this function (the CLI loads fit.json alone);
 * 2. the injected half must declare split 'fit' and source 'synthetic';
 * 3. the artifact records split_used 'fit', and the loader refuses any
 *    other value.
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

  assertFitHalf(fitHalf);

  const samples: { agreement: number; correct: boolean }[] = [];
  for (const ticket of fitHalf.tickets) {
    const result = await classifyTicket(options.provider, {
      taxonomy,
      ticketText: `${ticket.subject}\n\n${ticket.body}`,
      promptVer,
      modelVer,
      ...(options.temperature === undefined
        ? {}
        : { temperature: options.temperature }),
    });
    samples.push({
      agreement: result.agreement,
      correct: normalize(result.intentId) === normalize(ticket.intent),
    });
  }

  const fit = fitAgreementThreshold(samples, { targetPrecision });

  const dir = options.artifactDir ?? defaultCalibrationDir();
  const version = await nextVersion(dir);
  const artifact = validateCalibrationArtifact({
    artifact: 'agreement-threshold',
    version,
    fitted_at: new Date().toISOString(),
    gold_source: 'synthetic',
    split_used: 'fit',
    fit_tickets: fitHalf.tickets.length,
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

function assertFitHalf(half: GoldFile): void {
  // The production loader cross-checks these; the injection path must not
  // trust a declared count that disagrees with the array it will fit on.
  if (half.count !== half.tickets.length) {
    throw new Error(
      `fit half declares ${half.count} tickets but carries ${half.tickets.length}`,
    );
  }
  if (half.split !== 'fit') {
    throw new Error(
      `calibration consumes the fit half only, got split '${half.split}' (DEC-31)`,
    );
  }
  if (half.source !== 'synthetic') {
    throw new Error('calibration runs on synthetic gold data only (DEC-18)');
  }
  // The committed corpus holds exactly 385 fit tickets (DEC-31).
  if (half.count !== FIT_COUNT) {
    throw new Error(`fit half holds ${half.count} tickets, expected ${FIT_COUNT}`);
  }
}

function normalize(text: string): string {
  return text.trim().toLowerCase();
}

// CLI entry: `npm run calibrate` executes dist/calibration/run.js.
// Needs OPENROUTER_API_KEY and CALIBRATION_MODEL_VER in the environment;
// CALIBRATION_TARGET_PRECISION overrides the default precision floor.
async function main(): Promise<void> {
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

  const { artifact } = await runCalibrationJob({
    provider: new OpenRouterProvider({ apiKey }),
    modelVer,
    ...(targetPrecision === undefined ? {} : { targetPrecision }),
  });
  console.log(
    `fitted global agreement threshold v${artifact.version}: ${artifact.threshold} ` +
      `(precision ${artifact.precision_at_threshold}, coverage ${artifact.coverage_at_threshold}, ` +
      `${Math.round(artifact.interval.confidence * 100)}% CI [${artifact.interval.lower.toFixed(3)}, ${artifact.interval.upper.toFixed(3)}])`,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
