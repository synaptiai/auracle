/**
 * Replay evaluation, method 1: action match (section 4.10).
 *
 * Obeys DEC-09 (replay scores action match), DEC-20 (replay the history
 * before going live), DEC-31 (fit on one half, report on the other) and
 * DEC-32 (score the disposition, never the intent label) and DEC-39 (score
 * first turns only).
 *
 * DEC-32 is the core constraint. The gold tickets carry an `intent` field,
 * and this module never reads it. Intent labels come from the induction job,
 * and the induction job is the component under test. The score compares the
 * system's routing decision against what the history shows: the queue that
 * received the ticket and whether it escalated to a person.
 *
 * DEC-31 is a code-level split. `runReplay` fits the route map from the fit
 * half only and scores on the report half only. Nothing in the fit phase
 * touches the report tickets.
 *
 * DEC-39 narrows both phases to first turns. The reported counts follow that
 * population, so a half that carries later turns never claims them as scored.
 */

import { classifyTicket } from '../classifier/classifier.js';
import { SEED_THRESHOLDS, evaluatePolicy } from '../policy/policy.js';
import type { AdapterCapabilities, GateThresholds, RiskTier } from '../policy/policy.js';
import type { ModelProvider } from '../models/provider.js';
import { goldCaseText, isFirstTurn } from '../domain/gold-types.js';
import type { GoldFile, GoldTicket } from '../domain/gold-types.js';
/**
 * The replay needs the risk tier per intent; the classifier's own taxonomy
 * view drops it. This wider view is structurally satisfied by
 * fixtures/load.ts `Taxonomy`.
 */
export interface ReplayTaxonomy {
  intents: readonly { id: string; label: string; risk_tier: RiskTier }[];
}

/** Versions pinned on every model call (DEC-26). */
export interface ReplayPins {
  promptVer: string;
  modelVer: string;
}

/**
 * A routing decision makes no textual claim, so groundedness coverage has
 * nothing to cover. The gate passes at 1.0; no evidence is fabricated because
 * no claim exists. Section 4.10 limits action match to routing for exactly
 * this reason.
 */
const ROUTING_GROUNDEDNESS = 1.0;

/** Replay assumes a fully capable adapter; capability gating is not under test here (DEC-06). */
const FULL_CAPABILITIES: AdapterCapabilities = {
  supportsIdempotencyKey: true,
  supportsReadBack: true,
  supportsDraftState: true,
  supportsStructuredFields: true,
  supportsThreading: true,
  supportsLedgerReply: false,
};

/** Routing writes the queue field on the ticket; the write is never customer-visible. */
const ROUTING_ACTION = { isWrite: true, isCustomerVisible: false, isIrreversible: false } as const;

/** Queue used when a predicted intent has no fitted route. */
export const FALLBACK_QUEUE = 'general';

/**
 * Intent id to queue, fitted from observable dispositions only (DEC-32):
 * for each intent the classifier predicts, the modal queue that actually
 * received such tickets in the fit half.
 */
export interface RouteMap {
  readonly queues: ReadonlyMap<string, string>;
  route(intentId: string): string;
}

/**
 * Fit the route map from pairs of (predicted intent, observed queue).
 * The observed queue is a disposition. The gold `intent` label must not be
 * passed here — callers pass what the classifier predicted.
 */
export function fitRouteMap(pairs: readonly { intentId: string; queue: string }[]): RouteMap {
  const counts = new Map<string, Map<string, number>>();
  for (const pair of pairs) {
    let perIntent = counts.get(pair.intentId);
    if (!perIntent) {
      perIntent = new Map();
      counts.set(pair.intentId, perIntent);
    }
    perIntent.set(pair.queue, (perIntent.get(pair.queue) ?? 0) + 1);
  }

  const queues = new Map<string, string>();
  for (const [intentId, perQueue] of counts) {
    // Deterministic mode: highest count wins, ties keep first-seen order.
    let best = '';
    let bestCount = 0;
    for (const [queue, count] of perQueue) {
      if (count > bestCount) {
        best = queue;
        bestCount = count;
      }
    }
    queues.set(intentId, best);
  }

  return {
    queues,
    route(intentId: string): string {
      return queues.get(intentId) ?? FALLBACK_QUEUE;
    },
  };
}

/** What the replay predicts, or what the history observed, for one ticket. */
export type TicketOutcome =
  | { kind: 'queue'; queue: string }
  | { kind: 'escalate' };

/** One scored ticket in the report half. */
export interface ScoredTicket {
  ticketId: string;
  /** The classifier's modal intent. Reported for triage, never scored against. */
  intentId: string;
  decision: 'auto' | 'gated' | 'escalate';
  predicted: TicketOutcome;
  observed: TicketOutcome;
  match: boolean;
}

export interface ReplayReport {
  method: 'action-match';
  /** First-turn cases the route map was fitted on, not the size of the half (DEC-39). */
  fitTickets: number;
  /** First-turn cases scored, not the size of the half (DEC-39). */
  reportTickets: number;
  /** Fitted routes as a plain object, for the report output. */
  routeMap: Record<string, string>;
  fallbackQueue: string;
  /** Share of report-half tickets where the routing decision equals the observed disposition. */
  actionMatchRate: number;
  matches: number;
  confusion: {
    'queue->queue': number;
    'queue->escalate': number;
    'escalate->queue': number;
    'escalate->escalate': number;
  };
  /** Queue accuracy among tickets whose history shows a plain queue outcome. */
  queueMatchRateGivenQueue: number;
}

export interface RoutedTicket {
  ticket: GoldTicket;
  intentId: string;
  decision: 'auto' | 'gated' | 'escalate';
}

/**
 * DEC-39: the replay scores routing against an observable disposition, and a
 * later turn's disposition belongs to the whole conversation. Both phases
 * apply the filter, so a caller that fits routes on its own still gets it.
 */
function firstTurnsOf(half: GoldFile): GoldTicket[] {
  return half.tickets.filter(isFirstTurn);
}

async function classifyAndApplyPolicy(
  provider: ModelProvider,
  taxonomy: ReplayTaxonomy,
  pins: ReplayPins,
  ticket: GoldTicket,
  thresholds: GateThresholds,
): Promise<RoutedTicket> {
  const classification = await classifyTicket(provider, {
    taxonomy,
    ticketText: goldCaseText(ticket),
    ...pins,
  });
  const tier = taxonomy.intents.find((intent) => intent.id === classification.intentId)?.risk_tier;
  if (!tier) {
    throw new Error(`classified intent ${classification.intentId} is absent from the taxonomy`);
  }
  const decision = evaluatePolicy({
    riskTier: tier,
    // DEC-41, as the coordinator does. A replay scoring against a different
    // gate than the live path would measure the wrong system.
    intent: classification.intentId,
    agreement: classification.agreement,
    groundedness: ROUTING_GROUNDEDNESS,
    thresholds,
    capabilities: FULL_CAPABILITIES,
    action: ROUTING_ACTION,
  });
  return { ticket, intentId: classification.intentId, decision };
}

/** The observable disposition of a historical ticket, as section 4.10 defines it. */
export function observedOutcome(ticket: GoldTicket): TicketOutcome {
  return ticket.disposition.escalated ? { kind: 'escalate' } : { kind: 'queue', queue: ticket.queue };
}

function predictedOutcome(routed: RoutedTicket, routes: RouteMap): TicketOutcome {
  // Anything short of the automatic path means a person handled the ticket.
  if (routed.decision !== 'auto') return { kind: 'escalate' };
  return { kind: 'queue', queue: routes.route(routed.intentId) };
}

/**
 * Run the fit phase: classify every fit-half first turn once per CLASSIFIER_K
 * samples through the real classifier, then fit the route map from the
 * predicted intents against the observed queues. This function receives the
 * fit half and nothing else — the type system keeps the report half out.
 */
export async function fitRoutes(
  provider: ModelProvider,
  taxonomy: ReplayTaxonomy,
  pins: ReplayPins,
  fit: GoldFile,
  thresholds: GateThresholds = SEED_THRESHOLDS,
): Promise<RouteMap> {
  const pairs: { intentId: string; queue: string }[] = [];
  for (const ticket of firstTurnsOf(fit)) {
    const routed = await classifyAndApplyPolicy(provider, taxonomy, pins, ticket, thresholds);
    // DEC-32: the pair records the prediction and the OBSERVED queue only.
    pairs.push({ intentId: routed.intentId, queue: routed.ticket.queue });
  }
  return fitRouteMap(pairs);
}

/** Score one report-half ticket: predicted route versus observed disposition. */
export function scoreTicket(routed: RoutedTicket, routes: RouteMap): ScoredTicket {
  const predicted = predictedOutcome(routed, routes);
  const observed = observedOutcome(routed.ticket);
  const match =
    predicted.kind === observed.kind &&
    (predicted.kind !== 'queue' || observed.kind !== 'queue' || predicted.queue === observed.queue);
  return {
    ticketId: routed.ticket.ticket_id,
    intentId: routed.intentId,
    decision: routed.decision,
    predicted,
    observed,
    match,
  };
}

/**
 * Full replay over both halves. Fit reads the fit half only; the report half
 * is opened after the route map is frozen (DEC-31).
 */
export async function runReplay(input: {
  provider: ModelProvider;
  taxonomy: ReplayTaxonomy;
  pins: ReplayPins;
  fit: GoldFile;
  report: GoldFile;
  /** The gate numbers this run applies. Defaults to the documented seeds. */
  thresholds?: GateThresholds;
}): Promise<ReplayReport> {
  const { provider, taxonomy, pins, fit, report } = input;
  const thresholds = input.thresholds ?? SEED_THRESHOLDS;

  const routes = await fitRoutes(provider, taxonomy, pins, fit, thresholds);

  const scored: ScoredTicket[] = [];
  for (const ticket of firstTurnsOf(report)) {
    const routed = await classifyAndApplyPolicy(provider, taxonomy, pins, ticket, thresholds);
    scored.push(scoreTicket(routed, routes));
  }

  const confusion = {
    'queue->queue': 0,
    'queue->escalate': 0,
    'escalate->queue': 0,
    'escalate->escalate': 0,
  };
  let queueObserved = 0;
  let queueMatched = 0;
  for (const item of scored) {
    const key = `${item.predicted.kind}->${item.observed.kind}` as keyof typeof confusion;
    confusion[key] += 1;
    if (item.observed.kind === 'queue') {
      queueObserved += 1;
      if (item.predicted.kind === 'queue' && item.predicted.queue === item.observed.queue) {
        queueMatched += 1;
      }
    }
  }
  const matches = scored.filter((item) => item.match).length;

  return {
    method: 'action-match',
    fitTickets: firstTurnsOf(fit).length,
    reportTickets: scored.length,
    routeMap: Object.fromEntries(routes.queues),
    fallbackQueue: FALLBACK_QUEUE,
    actionMatchRate: scored.length === 0 ? 0 : matches / scored.length,
    matches,
    confusion,
    queueMatchRateGivenQueue: queueObserved === 0 ? 0 : queueMatched / queueObserved,
  };
}
