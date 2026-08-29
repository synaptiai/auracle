// The reader that closes the calibration chain (section 4.11, DEC-13, DEC-31).
//
// The fitting job has written versioned artifacts since it shipped, and until
// this module existed nothing loaded one: every gate ran on the seeds of
// section 4.5 and section 4.7, and a refit changed nothing observable. A
// process resolves its thresholds once at startup and passes them down.
//
// DEC-05 keeps the gates independent. This resolver moves the agreement
// number alone, because that is the only number a job fits today. The two
// coverage numbers stay at their documented seeds until a coverage fit
// exists, and nothing here blends the two gates into one score.
//
// A missing artifact is an ordinary state on a fresh checkout, so it yields
// the seeds and a log line. A malformed artifact is a fault and throws: a
// truncated write must not read as "not calibrated yet" behind a gate that
// still looks healthy.

import { SEED_THRESHOLDS, makeThresholds } from '../policy/policy.js';
import type { GateThresholds } from '../policy/policy.js';
import { defaultCalibrationDir, loadCalibrationArtifact } from './artifact.js';
import type { CalibrationScope } from './artifact.js';

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
    };

export interface ResolvedThresholds {
  readonly thresholds: GateThresholds;
  readonly provenance: ThresholdProvenance;
}

export interface ResolveOptions {
  /** Artifact directory override. Defaults to <repo>/calibration/. */
  dir?: URL;
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
export async function resolveThresholds(
  options: ResolveOptions = {},
): Promise<ResolvedThresholds> {
  const dir = options.dir ?? defaultCalibrationDir();
  const log = options.log ?? defaultLog;

  const artifact = await loadCalibrationArtifact(undefined, dir);
  if (artifact === null) {
    log({
      event: 'gate_thresholds_seeded',
      reason: 'no calibration artifact found',
      agreement: SEED_THRESHOLDS.agreement,
      groundedness_block: SEED_THRESHOLDS.groundednessBlock,
      groundedness_review: SEED_THRESHOLDS.groundednessReview,
    });
    return { thresholds: SEED_THRESHOLDS, provenance: { source: 'seed' } };
  }

  const thresholds = makeThresholds({
    agreement: artifact.threshold,
    // DEC-05: fitting the first gate moves neither number of the second.
    groundednessBlock: SEED_THRESHOLDS.groundednessBlock,
    groundednessReview: SEED_THRESHOLDS.groundednessReview,
  });
  log({
    event: 'gate_thresholds_fitted',
    version: artifact.version,
    scope: artifact.scope,
    fitted_at: artifact.fitted_at,
    agreement: thresholds.agreement,
    groundedness_block: thresholds.groundednessBlock,
    groundedness_review: thresholds.groundednessReview,
  });
  return {
    thresholds,
    provenance: {
      source: 'calibration',
      version: artifact.version,
      scope: artifact.scope,
    },
  };
}
