// Which group a waiting case belongs to, and in what order (issue #101).
//
// Its own module, so the rule a reviewer works by is stated once and tested
// without a page. It reads values the ledger already recorded and decides no
// gate: every case here waits for a person whatever its group (DEC-12).
import { COMPENSATION_ACTION_CLASS } from 'auracle/domain';
import { POLICY_REASONS } from 'auracle/policy';

/**
 * The three groups, in the order a reviewer works them.
 *
 * `first`: the gate rule is `irreversible` or `high_risk`, the gate recorded
 * the intent's risk tier as high, or the run parked a compensation, an action
 * nobody can take back. `clean`: agreement cleared its own line and coverage
 * cleared the review line, each on its own. `rest`: everything else waiting.
 */
export type QueueGroup = 'first' | 'clean' | 'rest';

export const QUEUE_GROUPS: readonly QueueGroup[] = ['first', 'clean', 'rest'];

/** What the grouping reads from a waiting run. */
export interface Groupable {
  readonly gateReason: string | null;
  /** The risk tier the gate recorded for the intent, or null (DEC-13). */
  readonly riskTier: string | null;
  readonly actionClass: string | null;
  readonly agreement: number | null;
  readonly agreementThreshold: number | null;
  readonly gateCoverage: number | null;
  readonly coverageReviewThreshold: number | null;
}

/** Rules that put a case in front of every other. */
const RISK_RULES: ReadonlySet<string> = new Set(['irreversible', 'high_risk']);

/**
 * The group one waiting case belongs to.
 *
 * Risk first, and it outranks clean: an action that cannot be undone is the
 * work to do first even when both gates read well. The recorded tier counts
 * as well as the rule, because a customer reply is gated before the
 * high-risk rule is read and so never records it. Delivery is not read.
 * Every action is `at_most_once` unless `ACTION_DELIVERY` says otherwise, so
 * it would promote the whole queue.
 *
 * Clean compares each gate with its own line and never combines them
 * (DEC-05). A value or a line the ledger did not record is not clean: an
 * unmeasured gate has not cleared anything. Nor is a run whose rule is
 * missing or outside the engine's vocabulary, because the clean group says
 * another rule sent each case to a person.
 */
export function queueGroupOf(run: Groupable): QueueGroup {
  if ((run.gateReason !== null && RISK_RULES.has(run.gateReason))
    || run.riskTier === 'high'
    || run.actionClass === COMPENSATION_ACTION_CLASS) {
    return 'first';
  }
  if (run.gateReason === null || !(POLICY_REASONS as readonly string[]).includes(run.gateReason)) {
    return 'rest';
  }
  const agreementClears = isFraction(run.agreement) && run.agreementThreshold !== null
    && run.agreement >= run.agreementThreshold;
  const coverageClears = isFraction(run.gateCoverage) && run.coverageReviewThreshold !== null
    && run.gateCoverage >= run.coverageReviewThreshold;
  return agreementClears && coverageClears ? 'clean' : 'rest';
}

/**
 * Whether a recorded gate value is a reading at all. Both gates are fractions,
 * and the ledger carries a hand-written 1.4 as it holds it. A value outside
 * [0, 1] has cleared nothing.
 */
function isFraction(value: number | null): value is number {
  return value !== null && value >= 0 && value <= 1;
}

/** One group and the runs in it, oldest first. */
export interface QueueSection<T> {
  readonly group: QueueGroup;
  readonly runs: readonly T[];
}

/**
 * The waiting runs in their groups, in working order.
 *
 * Oldest first inside each group, because the longest wait is the one owed
 * first. A run with no recorded time sorts after every dated one, so a missing
 * value never jumps the line. A group with nothing in it is left out.
 */
export function groupQueue<T extends Groupable & { readonly createdAt: Date | null }>(
  runs: readonly T[],
): QueueSection<T>[] {
  const byAge = (a: T, b: T): number => {
    if (a.createdAt === null) return b.createdAt === null ? 0 : 1;
    if (b.createdAt === null) return -1;
    return a.createdAt.getTime() - b.createdAt.getTime();
  };
  return QUEUE_GROUPS
    .map((group) => ({
      group,
      runs: runs.filter((run) => queueGroupOf(run) === group).sort(byAge),
    }))
    .filter((section) => section.runs.length > 0);
}
