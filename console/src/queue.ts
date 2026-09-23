// Which group a waiting case belongs to, and in what order (issue #101).
//
// Its own module, so the rule a reviewer works by is stated once and tested
// without a page. It reads values the ledger already recorded and decides no
// gate: every case here waits for a person whatever its group (DEC-12).
import { COMPENSATION_ACTION_CLASS } from 'auracle/domain';
import { POLICY_REASONS } from 'auracle/policy';

import { isReadableTime } from './render.js';

/**
 * The four groups, in the order a reviewer works them.
 *
 * `first`: the gate rule is `irreversible` or `high_risk`, the gate recorded
 * the intent's risk tier as high, or the run parked a compensation, an action
 * nobody can take back. `clean`: agreement cleared its own line and coverage
 * cleared the review line, each on its own. `rest`: everything else waiting.
 * `held` (DEC-46): somebody else took the case, so it is not work to start —
 * it waits last, and returns to its own group when the hold ends.
 */
export type QueueGroup = 'first' | 'clean' | 'rest' | 'held';

export const QUEUE_GROUPS: readonly QueueGroup[] = ['first', 'clean', 'rest', 'held'];

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
  /**
   * #123: the park's helpdesk draft, or null. Only a reply the batch holds for
   * an undo can be confirmed with one press (DEC-51).
   */
  readonly draftExternalId: string | null;
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
  // DEC-48: a reply a person wrote keeps its place here. The number this reads
  // is the gate's verdict on the draft — the escalations read reports it for
  // such a run — and the group decides which cases one press can confirm. A
  // rewritten case is one a reviewer can send, so withholding the number would
  // drop it out of the batch in silence. The row says whose reply it is.
  if ((run.gateReason !== null && RISK_RULES.has(run.gateReason))
    || run.riskTier === 'high'
    || run.actionClass === COMPENSATION_ACTION_CLASS) {
    return 'first';
  }
  if (run.gateReason === null || !(POLICY_REASONS as readonly string[]).includes(run.gateReason)) {
    return 'rest';
  }
  // #123: the clean group is the one a single press confirms, and that batch
  // holds each reply so a mistake can be undone (DEC-51). An internal write
  // parks no reply and takes no hold (DEC-34), so it waits here and is
  // approved on its own case page, where the page names the action.
  if (run.draftExternalId === null) return 'rest';
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
 * first. A run with no readable time sorts after every dated one, so a missing
 * value never jumps the line. A group with nothing in it is left out.
 *
 * `held` names the cases somebody else holds (DEC-46). It is a parameter
 * rather than a field of the run, because a hold is not a fact about the case:
 * the same case is held for one reviewer and free for another, and
 * `queueGroupOf` reads only what the ledger recorded about the run.
 *
 * `mine` is DEC-47's own-products preference: a case whose product the
 * reviewer covers sorts first inside its group, and the groups themselves do
 * not move. It decides order and nothing else. Every case still waits for a
 * person, and a reviewer who covers no product sees the queue as it was.
 */
export function groupQueue<T extends Groupable & { readonly createdAt: Date | null }>(
  runs: readonly T[],
  held?: (run: T) => boolean,
  mine?: (run: T) => boolean,
): QueueSection<T>[] {
  // An unreadable time is no more a date than a missing one, and sorts with
  // the undated rather than throwing or scattering the order.
  const byAge = (a: T, b: T): number => {
    const left = isReadableTime(a.createdAt) ? a.createdAt.getTime() : null;
    const right = isReadableTime(b.createdAt) ? b.createdAt.getTime() : null;
    if (left === null) return right === null ? 0 : 1;
    if (right === null) return -1;
    return left - right;
  };
  const groupOf = (run: T): QueueGroup =>
    held?.(run) === true ? 'held' : queueGroupOf(run);
  // The reader's own products first, then the longest wait. Age decides
  // inside each half, so a run the reader covers never jumps ahead of
  // another run they cover.
  const byOwnProductFirst = (a: T, b: T): number => {
    if (mine === undefined) return 0;
    const left = mine(a) ? 0 : 1;
    const right = mine(b) ? 0 : 1;
    return left - right;
  };
  return QUEUE_GROUPS
    .map((group) => ({
      group,
      runs: runs
        .filter((run) => groupOf(run) === group)
        .sort((a, b) => byOwnProductFirst(a, b) || byAge(a, b)),
    }))
    .filter((section) => section.runs.length > 0);
}
