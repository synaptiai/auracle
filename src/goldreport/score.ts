// Pure metrics for the gold report job (method 2, section 4.10).
//
// Method 2 gives the numbers for the README. DEC-31 prices those numbers:
// fit thresholds live on the fit half, every published rate comes from the
// report half only. This module knows nothing about where scores came from;
// the runner (run.ts) owns the split discipline.
//
// DEC-32 shapes what is scored. The comparison runs against observable
// dispositions only — whether the history shows a person handled the ticket
// (`escalated`) — never against a gold intent label. The gold `intent` field
// never enters this module.
//
// Metrics:
// - action match: the system's decision agrees with the observed handling
//   (auto resolved without a person, gated/escalate handed to a person).
// - containment: the share of tickets the policy sent down the automatic
//   path (section 3.6 measures resolution, this is its offline analogue).
//
// Intervals reuse the calibration job's Wilson implementation verbatim, so
// method 1 and method 2 quote intervals from one piece of math.

import { wilsonInterval } from '../calibration/calibrate.js';
import type { FitInterval } from '../calibration/calibrate.js';
import type { PolicyDecision, RiskTier } from '../policy/policy.js';

/** One report-half ticket after it went through classifier and policy. */
export interface ScoredTicket {
  ticketId: string;
  /** Risk tier of the intent the classifier predicted (DEC-13). */
  riskTier: RiskTier;
  decision: PolicyDecision;
  /** Observable disposition: did a person handle the historical ticket. */
  observedEscalated: boolean;
}

export interface RateWithInterval {
  rate: number;
  successes: number;
  total: number;
  interval: FitInterval;
}

/**
 * One risk-tier slice of the report. Section 4.10: at 385 cases and three
 * tiers each stratum holds roughly 128 cases, its interval widens to about
 * five points, and the strata stay too small to publish. Strata are an
 * indication only, and `publishable` is false by construction — the type has
 * no way to say yes.
 */
export interface TierStratum {
  riskTier: RiskTier;
  tickets: number;
  actionMatch: RateWithInterval;
  containment: RateWithInterval;
  publishable: false;
}

export interface ReportMetrics {
  actionMatch: RateWithInterval;
  containment: RateWithInterval;
  strata: TierStratum[];
}

const TIER_ORDER: readonly RiskTier[] = ['low', 'medium', 'high'];

/** Score one ticket against its observed disposition. */
export function scoreTicket(ticket: ScoredTicket): {
  actionMatch: boolean;
  contained: boolean;
} {
  // Anything short of the automatic path means a person handled the ticket.
  const predictedEscalated = ticket.decision !== 'auto';
  return {
    actionMatch: predictedEscalated === ticket.observedEscalated,
    contained: !predictedEscalated,
  };
}

function rate(successes: number, total: number, label: string): RateWithInterval {
  if (!(total > 0)) {
    throw new Error(`${label} needs at least one observation`);
  }
  return {
    rate: successes / total,
    successes,
    total,
    interval: wilsonInterval(successes, total),
  };
}

/** Aggregate scored tickets into the published metrics plus tier strata. */
export function aggregateReport(scores: readonly ScoredTicket[]): ReportMetrics {
  if (scores.length === 0) {
    throw new Error('gold report needs at least one scored ticket');
  }

  let matched = 0;
  let contained = 0;
  const perTier = new Map<RiskTier, { tickets: number; matched: number; contained: number }>();
  for (const score of scores) {
    const result = scoreTicket(score);
    if (result.actionMatch) matched += 1;
    if (result.contained) contained += 1;
    let tier = perTier.get(score.riskTier);
    if (!tier) {
      tier = { tickets: 0, matched: 0, contained: 0 };
      perTier.set(score.riskTier, tier);
    }
    tier.tickets += 1;
    if (result.actionMatch) tier.matched += 1;
    if (result.contained) tier.contained += 1;
  }

  const strata = [...perTier.entries()]
    .sort(
      ([a], [b]) => TIER_ORDER.indexOf(a) - TIER_ORDER.indexOf(b),
    )
    .map(([riskTier, tier]): TierStratum => ({
      riskTier,
      tickets: tier.tickets,
      actionMatch: rate(tier.matched, tier.tickets, `stratum ${riskTier} action match`),
      containment: rate(tier.contained, tier.tickets, `stratum ${riskTier} containment`),
      publishable: false,
    }));

  return {
    actionMatch: rate(matched, scores.length, 'action match'),
    containment: rate(contained, scores.length, 'containment'),
    strata,
  };
}
