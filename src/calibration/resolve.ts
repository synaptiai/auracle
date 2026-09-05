// The reader that closes the calibration chain (section 4.11, DEC-13, DEC-31).
//
// The fitting job has written versioned artifacts since it shipped, and until
// this module existed nothing loaded one: every gate ran on the seeds of
// section 4.5 and section 4.7, and a refit changed nothing observable. A
// process resolves its thresholds once at startup and passes them down.
//
// DEC-05 keeps the gates independent, and this resolver reads them that way:
// two artifacts, loaded separately, neither supplying a number to the other.
// The agreement number comes from the calibration artifact and the two
// coverage numbers from the groundedness artifact. Each gate falls back to its
// own documented seed on its own, so a process can run one fitted gate beside
// one seeded gate and its log says which is which.
//
// The coverage half of that was missing. The coverage fit wrote versioned
// artifacts and nothing loaded one, so those two numbers stayed at their seeds
// however often the job ran. That is the same open loop this module was built
// to close for the agreement gate.
//
// A missing artifact is an ordinary state on a fresh checkout, so it yields
// the seeds and a log line. A malformed artifact is a fault and throws: a
// truncated write must not read as "not calibrated yet" behind a gate that
// still looks healthy.

import { SEED_THRESHOLDS, makeThresholds } from '../policy/policy.js';
import type { GateThresholds } from '../policy/policy.js';
import { defaultCalibrationDir, loadCalibrationArtifact } from './artifact.js';
import type { CalibrationScope } from './artifact.js';
import { defaultGroundednessDir, loadGroundednessArtifact } from '../groundedness/artifact.js';
import type { GoldSource } from '../fixtures/load.js';

/** Where a threshold set came from. Recorded by every job that publishes numbers. */
export type ThresholdProvenance =
  | { readonly source: 'seed' }
  | {
      readonly source: 'calibration';
      readonly version: number;
      /**
       * The turn population the fit consumed. A closed set, so a published
       * artifact cannot name a population that does not exist.
       * See CalibrationArtifact.scope.
       */
      readonly scope: CalibrationScope;
      /**
       * Which data the threshold was fitted on (DEC-18). A number fitted on
       * an adopter's own history and one fitted on the shipped corpus are
       * different claims, and a reader must not have to guess which they
       * hold.
       */
      readonly goldSource: GoldSource;
    };

/**
 * Where the two coverage numbers came from.
 *
 * Separate from the agreement provenance above, and never merged with it. A
 * reader of a published number must be able to say which gate was fitted and
 * which was seeded, and one field covering both cannot (DEC-05).
 */
export type CoverageProvenance =
  | { readonly source: 'seed' }
  | {
      readonly source: 'groundedness';
      readonly version: number;
      /** Which data the pair was fitted on (DEC-18). */
      readonly goldSource: GoldSource;
    };

export interface ResolvedThresholds {
  readonly thresholds: GateThresholds;
  /** Where the agreement number came from. */
  readonly provenance: ThresholdProvenance;
  /** Where the two coverage numbers came from. */
  readonly coverageProvenance: CoverageProvenance;
  /**
   * The pins each fitted artifact was produced under, when one was adopted.
   *
   * Returned rather than only logged, so a caller that knows its own runtime
   * pin can compare. The resolver cannot do that comparison itself: it is a
   * pure resolver and does not know what model the process will run.
   */
  readonly fittedPins: {
    readonly coverage: { modelVer: string; promptVer: string } | null;
    readonly agreement: { modelVer: string; promptVer: string } | null;
  };
}

export interface ResolveOptions {
  /** Agreement artifact directory override. Defaults to <repo>/calibration/. */
  dir?: URL;
  /** Coverage artifact directory override. Defaults to <repo>/groundedness/. */
  groundednessDir?: URL;
  /** Structured log sink. Defaults to stdout, one JSON line. */
  log?: (entry: Record<string, unknown>) => void;
}

function defaultLog(entry: Record<string, unknown>): void {
  console.log(JSON.stringify(entry));
}

/**
 * Resolve the gate thresholds a process runs on, and say which they are.
 *
 * Called once at startup, never per ticket: the policy engine stays a pure
 * synchronous function, so nothing loads a file inside a gate decision.
 */
/**
 * The fault to report when a fitted gate was produced under a pin this
 * process does not run, or null when both gates are safe to adopt.
 *
 * Lives here, beside the resolver that returns the pins, and is exported so
 * the rule has a test. The first version of this check sat inside
 * `consumer-main`'s `main()` behind an `invokedDirectly` guard — untestable,
 * and the exact place this branch had just finished pulling a different rule
 * out of for the same reason.
 *
 * Each gate is judged on its own and reported on its own (DEC-05).
 *
 * Neither fault falls back to the seed. For coverage the seeds are looser than
 * this repository's own fit, so the safe-looking fallback opens the gate at
 * the moment it stops being justified. For agreement a fitted threshold can
 * sit either side of the seed, so a fallback is a silent, unmeasured change of
 * gate rather than a conservative one. A gate a process cannot justify is one
 * it must not run.
 */
export function pinFaults(
  pins: ResolvedThresholds['fittedPins'],
  modelVer: string,
): string[] {
  const faults: string[] = [];
  if (pins.coverage !== null && pins.coverage.modelVer !== modelVer) {
    faults.push(
      `the coverage pair on disk was fitted under ${pins.coverage.modelVer} and this process `
        + `runs ${modelVer}. Adopting it would apply one model's judgement of coverage to `
        + "another model's scores. Re-fit with `pnpm run fit-groundedness`, or set MODEL_VER "
        + 'to the pin the fit used (DEC-26).',
    );
  }
  if (pins.agreement !== null && pins.agreement.modelVer !== modelVer) {
    faults.push(
      `the agreement threshold on disk was fitted under ${pins.agreement.modelVer} and this `
        + `process runs ${modelVer}. Sample agreement is a property of the model that samples, `
        + 'so a threshold fitted on another one gates every ticket on a number nobody measured. '
        + 'Re-fit with `pnpm run calibrate`, or set MODEL_VER to the pin the fit used (DEC-26).',
    );
  }
  return faults;
}

export async function resolveThresholds(
  options: ResolveOptions = {},
): Promise<ResolvedThresholds> {
  const dir = options.dir ?? defaultCalibrationDir();
  const log = options.log ?? defaultLog;

  // Loaded before either gate resolves, so a malformed coverage artifact
  // stops the process rather than being discovered after the agreement gate
  // has already logged itself fitted.
  const coverage = await loadGroundednessArtifact(
    undefined,
    options.groundednessDir ?? defaultGroundednessDir(),
  );
  const coverageBlock = coverage?.block ?? SEED_THRESHOLDS.groundednessBlock;
  const coverageReview = coverage?.review ?? SEED_THRESHOLDS.groundednessReview;
  const coverageProvenance: CoverageProvenance = coverage === null
    ? { source: 'seed' }
    : { source: 'groundedness', version: coverage.version, goldSource: coverage.gold_source };
  log(coverage === null
    ? {
        event: 'coverage_thresholds_seeded',
        reason: 'no groundedness artifact found',
        groundedness_block: coverageBlock,
        groundedness_review: coverageReview,
      }
    : {
        event: 'coverage_thresholds_fitted',
        version: coverage.version,
        gold_source: coverage.gold_source,
        fitted_at: coverage.fitted_at,
        // The pins the pair was fitted under. A threshold is one model's
        // judgement of what coverage means, read through one judge prompt, so
        // a reader of this line must be able to see whether the process about
        // to adopt it runs the same pair (DEC-26).
        model_ver: coverage.model_ver,
        prompt_ver: coverage.prompt_ver,
        groundedness_block: coverageBlock,
        groundedness_review: coverageReview,
      });

  const coveragePins = coverage === null
    ? null
    : { modelVer: coverage.model_ver, promptVer: coverage.prompt_ver };

  const artifact = await loadCalibrationArtifact(undefined, dir);
  if (artifact === null) {
    log({
      event: 'gate_thresholds_seeded',
      reason: 'no calibration artifact found',
      agreement: SEED_THRESHOLDS.agreement,
    });
    return {
      // makeThresholds refuses an inverted pair, so a hand-edited artifact
      // cannot install one behind a gate that still looks healthy.
      thresholds: makeThresholds({
        agreement: SEED_THRESHOLDS.agreement,
        groundednessBlock: coverageBlock,
        groundednessReview: coverageReview,
      }),
      provenance: { source: 'seed' },
      coverageProvenance,
      fittedPins: { coverage: coveragePins, agreement: null },
    };
  }

  const thresholds = makeThresholds({
    agreement: artifact.threshold,
    // DEC-41: the thresholds fitted for each intent, when the artifact carries
    // any. Absent or empty is the DEC-13 path, and the gate then reads the
    // global value for every intent.
    ...(artifact.per_intent === undefined || Object.keys(artifact.per_intent).length === 0
      ? {}
      : { perIntent: artifact.per_intent }),
    // DEC-05: each gate takes its own artifact, and neither reads the other's.
    groundednessBlock: coverageBlock,
    groundednessReview: coverageReview,
  });
  log({
    event: 'gate_thresholds_fitted',
    version: artifact.version,
    scope: artifact.scope,
    gold_source: artifact.gold_source,
    fitted_at: artifact.fitted_at,
    // Named for the same reason as the coverage pins above, and separately,
    // because the two gates can be fitted under different pins (DEC-05).
    model_ver: artifact.model_ver,
    prompt_ver: artifact.prompt_ver,
    agreement: thresholds.agreement,
  });
  return {
    thresholds,
    coverageProvenance,
    fittedPins: {
      coverage: coveragePins,
      agreement: { modelVer: artifact.model_ver, promptVer: artifact.prompt_ver },
    },
    provenance: {
      source: 'calibration',
      version: artifact.version,
      scope: artifact.scope,
      goldSource: artifact.gold_source,
    },
  };
}
