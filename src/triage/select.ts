// Judge triage — the selection half of replay method 3 (section 4.10, DEC-09).
//
// A model reviews cases and selects the ones that go to a person. It never
// produces a published number: DEC-09 rejects 'the judge gives the primary
// score' because a judge shares the failure modes of the system it tests and
// is weakest where evaluation matters most. This module therefore has no
// rate, interval or accuracy output of any kind — only selections with a
// reason each.
//
// The judge is a port, not a component: production plugs in an OpenRouter
// model (DEC-16), offline runs plug in the deterministic stub below so a
// triage pass on the synthetic corpus is reproducible without a network.

import type { ConversationTurn } from '../coordinator/coordinator.js';
import { renderPromptBody } from '../coordinator/history.js';
import { predictIntent } from '../replay/fake-model.js';
import type { RiskTier } from '../domain/gold-types.js';

/** Where a triaged case came from. Replay halves name their split; live traffic says so. */
export type CaseOrigin = 'fit' | 'report' | 'live';

/** One case the judge reviews. Provenance rides on the case, not on the run. */
export interface TriageCase {
  ticketId: string;
  origin: CaseOrigin;
  subject: string;
  body: string;
  /**
   * DEC-37: earlier turns of this conversation, oldest first. Empty on a
   * first turn.
   *
   * A follow-up message names no topic of its own. A judge that read the
   * message alone would call every follow-up uncertain and fill the review
   * queue with cases a person cannot read either.
   */
  history?: readonly ConversationTurn[];
}

/**
 * The text a judge reads for one case: the same prompt body the classifier
 * builds, so the judge and the classifier never disagree about the case.
 */
export function caseText(case_: TriageCase): string {
  // The classifier's own assembly, not a copy of it. A copy drifts, and the
  // drift shows up as a review cohort computed from a prompt production never
  // issues — the failure goldCaseText removed for the other jobs.
  return renderPromptBody(case_.history ?? [], `${case_.subject}\n\n${case_.body}`);
}

/** The judge's verdict on one case. `reason` is provenance, not a score. */
export interface JudgeVerdict {
  selected: boolean;
  reason: string;
}

/**
 * The judge port. One call per case; no batch shape, so a streaming or
 * rate-limited implementation works unchanged.
 */
export interface TriageJudge {
  review(case_: TriageCase): Promise<JudgeVerdict>;
}

export interface StubJudgePins {
  prompt_ver: string;
  model_ver: string;
}

export const STUB_JUDGE_PINS: StubJudgePins = {
  prompt_ver: 'triage-p1',
  model_ver: 'replay-stub',
};

/**
 * Deterministic offline judge over the synthetic corpus.
 *
 * It mirrors what a real judge does — flag cases where the model lacks
 * confidence or where a mistake is expensive — using the replay stub's
 * phrase table: an unmatched case falls into the 'other' group (uncertain),
 * and a high risk tier means an error costs a person's time anyway. The
 * phrase table is test tooling for the synthetic fixtures only (DEC-18);
 * it is not the production model path.
 */
export class StubTriageJudge implements TriageJudge {
  readonly pins = STUB_JUDGE_PINS;

  /** Risk tier per intent id, built from the taxonomy by the caller. */
  constructor(private readonly riskByIntent: ReadonlyMap<string, RiskTier>) {}

  async review(case_: TriageCase): Promise<JudgeVerdict> {
    const intent = predictIntent(caseText(case_));
    if (intent === 'other') {
      return {
        selected: true,
        reason: "predicted intent 'other': no known topic matched",
      };
    }
    const tier = this.riskByIntent.get(intent);
    if (tier === 'high') {
      return {
        selected: true,
        reason: `predicted intent '${intent}' carries high risk tier`,
      };
    }
    return {
      selected: false,
      reason: `predicted intent '${intent}' carries low or medium risk tier`,
    };
  }
}
