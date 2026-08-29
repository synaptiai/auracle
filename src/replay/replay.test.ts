import { describe, expect, it } from 'vitest';

import { CLASSIFIER_K } from '../classifier/classifier.js';
import { FakeProvider } from '../models/fake.js';
import type { ModelProvider, PinnedVersions, ChatRequest, ChatResult, EmbeddingRequest, EmbeddingResult } from '../models/provider.js';
import type { GoldFile, GoldTicket } from '../fixtures/load.js';
import { ReplayStubProvider } from './fake-model.js';
import { FALLBACK_QUEUE, fitRouteMap, fitRoutes, observedOutcome, runReplay, scoreTicket } from './replay.js';
import type { ReplayTaxonomy, RoutedTicket, RouteMap } from './replay.js';

const PINS = { promptVer: 'test-prompt', modelVer: 'test-model' };

const TAXONOMY: ReplayTaxonomy = {
  intents: [
    { id: 'alpha', label: 'Alpha things', risk_tier: 'low' },
    { id: 'beta', label: 'Beta things', risk_tier: 'medium' },
    { id: 'gamma-high', label: 'Gamma high', risk_tier: 'high' },
    { id: 'other', label: 'Other', risk_tier: 'low' },
  ],
};

let seq = 0;
function makeTicket(overrides: Partial<GoldTicket> = {}): GoldTicket {
  seq += 1;
  return {
    ticket_id: `SYN-${String(seq).padStart(6, '0')}`,
    source: 'synthetic',
    intent: 'unconstrained-label',
    queue: 'general',
    disposition: { escalated: false, macro_applied: null, refund_issued: false, first_reply_minutes: 10 },
    subject: `subject ${seq}`,
    body: `body ${seq}`,
    ...overrides,
  };
}

function goldFile(split: 'fit' | 'report', tickets: GoldTicket[]): GoldFile {
  return { split, source: 'synthetic', count: tickets.length, tickets };
}

/** Answers every sample with one fixed intent id. */
class ConstantProvider implements ModelProvider {
  constructor(private readonly intentId: string) {}
  async complete(call: ChatRequest & PinnedVersions): Promise<ChatResult> {
    return {
      text: this.intentId,
      costMicros: 0,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      servedModelVer: call.modelVer,
    };
  }
  async embed(_call: EmbeddingRequest & PinnedVersions): Promise<EmbeddingResult> {
    throw new Error('not used');
  }
}

function routed(ticket: GoldTicket, intentId: string, decision: RoutedTicket['decision']): RoutedTicket {
  return { ticket, intentId, decision };
}

describe('fitRouteMap', () => {
  it('picks the modal observed queue per predicted intent', () => {
    const routes = fitRouteMap([
      { intentId: 'alpha', queue: 'desk-a' },
      { intentId: 'alpha', queue: 'desk-a' },
      { intentId: 'alpha', queue: 'desk-b' },
      { intentId: 'beta', queue: 'desk-c' },
    ]);
    expect(routes.route('alpha')).toBe('desk-a');
    expect(routes.route('beta')).toBe('desk-c');
  });

  it('falls back to the shared fallback queue for unseen intents', () => {
    const routes: RouteMap = fitRouteMap([{ intentId: 'alpha', queue: 'desk-a' }]);
    expect(routes.route('never-seen')).toBe(FALLBACK_QUEUE);
  });
});

describe('scoreTicket scores dispositions, never intent labels (DEC-32)', () => {
  const routes = fitRouteMap([
    { intentId: 'alpha', queue: 'desk-a' },
    { intentId: 'alpha', queue: 'desk-a' },
    { intentId: 'alpha', queue: 'desk-b' },
  ]);

  it('counts a match when the predicted queue equals the OBSERVED queue', () => {
    // The gold `intent` label disagrees with everything here; the score must not care.
    const item = scoreTicket(routed(makeTicket({ intent: 'some-other-taxonomy-label', queue: 'desk-a' }), 'alpha', 'auto'), routes);
    expect(item.match).toBe(true);
    expect(item.predicted).toEqual({ kind: 'queue', queue: 'desk-a' });
    expect(item.observed).toEqual({ kind: 'queue', queue: 'desk-a' });
  });

  it('counts a miss when the observed queue differs from the predicted route', () => {
    const item = scoreTicket(routed(makeTicket({ queue: 'desk-z' }), 'alpha', 'auto'), routes);
    expect(item.match).toBe(false);
  });

  it('ignores the queue entirely once either side escalated to a person', () => {
    const item = scoreTicket(routed(makeTicket({ queue: 'desk-z', disposition: { escalated: true, macro_applied: null, refund_issued: false, first_reply_minutes: 5 } }), 'alpha', 'gated'), routes);
    expect(item.predicted).toEqual({ kind: 'escalate' });
    expect(item.observed).toEqual({ kind: 'escalate' });
    expect(item.match).toBe(true);
  });

  it('is invariant under arbitrary relabeling of the gold intent column', () => {
    const a = scoreTicket(routed(makeTicket({ intent: 'label-one', queue: 'desk-a' }), 'alpha', 'auto'), routes);
    const b = scoreTicket(routed(makeTicket({ intent: 'label-two-completely-different', queue: 'desk-a' }), 'alpha', 'auto'), routes);
    expect(a.match).toBe(b.match);
  });
});

describe('the real policy path drives the prediction', () => {
  it('sends anything short of auto to a person', () => {
    // gamma-high is high risk: evaluatePolicy gates it before any gate values are read.
    const item = scoreTicket(
      routed(makeTicket({ queue: 'desk-a' }), 'gamma-high', 'gated'),
      fitRouteMap([{ intentId: 'gamma-high', queue: 'desk-a' }]),
    );
    expect(item.predicted).toEqual({ kind: 'escalate' });
  });
});

describe('runReplay wires classifier -> policy -> scoring over the split halves', () => {
  it('runs the full pipeline with a scripted provider', async () => {
    // Fit: one ticket, 9 agreeing 'alpha' samples -> route alpha -> desk-c.
    // Report ticket 1: 5 valid + 4 garbage -> agreement 5/9 < 0.6 -> escalate.
    // Report ticket 2: 6 valid + 3 garbage -> agreement 6/9 >= 0.6 -> queue.
    const votes = (
      Array.from({ length: CLASSIFIER_K }, () => 'alpha') as string[]
    ).concat(
      Array.from({ length: 5 }, () => 'alpha'),
      Array.from({ length: 4 }, () => 'gibberish'),
      Array.from({ length: 6 }, () => 'alpha'),
      Array.from({ length: 3 }, () => 'gibberish'),
    );
    const provider = new FakeProvider(votes.map((text) => ({ text })));

    const fit = goldFile('fit', [makeTicket({ queue: 'desk-c' })]);
    const report = goldFile('report', [
      makeTicket({ queue: 'desk-c', disposition: { escalated: true, macro_applied: null, refund_issued: false, first_reply_minutes: 20 } }),
      makeTicket({ queue: 'desk-c' }),
    ]);

    const result = await runReplay({ provider, taxonomy: TAXONOMY, pins: PINS, fit, report });

    expect(result.routeMap).toEqual({ alpha: 'desk-c' });
    expect(result.confusion).toEqual({
      'queue->queue': 1,
      'queue->escalate': 0,
      'escalate->queue': 0,
      'escalate->escalate': 1,
    });
    expect(result.matches).toBe(2);
    expect(result.actionMatchRate).toBe(1);
  });

  it('keeps the route map independent of the report half (DEC-31)', async () => {
    const fit = goldFile('fit', [makeTicket({ queue: 'desk-c' })]);
    const reportA = goldFile('report', [makeTicket({ queue: 'desk-z' })]);
    const reportB = goldFile('report', [
      makeTicket({ queue: 'desk-y', disposition: { escalated: true, macro_applied: null, refund_issued: false, first_reply_minutes: 99 } }),
      makeTicket({ queue: 'desk-c' }),
    ]);

    const withA = await runReplay({ provider: new ConstantProvider('alpha'), taxonomy: TAXONOMY, pins: PINS, fit, report: reportA });
    const withB = await runReplay({ provider: new ConstantProvider('alpha'), taxonomy: TAXONOMY, pins: PINS, fit, report: reportB });

    expect(withA.routeMap).toEqual(withB.routeMap);
    // Same fitted routes, but the halves differ, so the scored rates differ too.
    expect(withB.reportTickets).toBe(2);
    expect(withA.actionMatchRate).toBe(0);
    expect(withB.actionMatchRate).toBeCloseTo(0.5, 12);
  });

  // DEC-39: a later turn's disposition belongs to the whole conversation, so
  // it can neither fit a route nor score one. Both halves carry a turn 2 here
  // and neither reaches the model or the counts.
  it('excludes later turns from fitting and from scoring (DEC-39)', async () => {
    const provider = new ReplayStubProvider();
    const conversation = (id: string, overrides: Partial<GoldTicket>): GoldTicket[] => [
      makeTicket({ conversation_id: id, turn_number: 1, ...overrides }),
      makeTicket({ conversation_id: id, turn_number: 2, ...overrides, subject: 'LATER TURN subject', body: 'LATER TURN body' }),
    ];
    const fit = goldFile('fit', conversation('CONV-FIT-1', { queue: 'desk-c' }));
    const report = goldFile('report', conversation('CONV-REP-1', { queue: 'desk-c' }));

    const result = await runReplay({ provider, taxonomy: TAXONOMY, pins: PINS, fit, report });

    expect(result.fitTickets).toBe(1);
    expect(result.reportTickets).toBe(1);
    expect(JSON.stringify(provider.chatCalls)).not.toContain('LATER TURN');
    // Nine samples for the fit turn and nine for the report turn, and no more.
    expect(provider.chatCalls).toHaveLength(CLASSIFIER_K * 2);
  });

  it('feeds only fit-half text to the model during fitting (DEC-31)', async () => {
    const provider = new ReplayStubProvider();
    const fit = goldFile('fit', [makeTicket({ subject: 'FIT subject', body: 'FIT body' })]);

    await fitRoutes(provider, TAXONOMY, PINS, fit);

    const sentTexts = provider.chatCalls.map((call) => call.messages?.at(-1)?.content ?? '');
    expect(sentTexts.length).toBeGreaterThan(0);
    for (const text of sentTexts) {
      // The runtime composes subject and body this way and stores the result
      // in turn.body_text, so every offline job must send the same text.
      expect(text).toBe('FIT subject\n\nFIT body');
    }
  });
});

describe('observedOutcome reads the disposition fields only', () => {
  it('maps an escalation disposition to the escalate outcome', () => {
    const escalated = observedOutcome(makeTicket({ queue: 'desk-a', disposition: { escalated: true, macro_applied: null, refund_issued: false, first_reply_minutes: 7 } }));
    expect(escalated).toEqual({ kind: 'escalate' });
  });

  it('maps a plain history row to its queue', () => {
    expect(observedOutcome(makeTicket({ queue: 'desk-b' }))).toEqual({ kind: 'queue', queue: 'desk-b' });
  });
});

describe('end-to-end over the committed synthetic corpus', () => {
  it('produces a full action-match report offline', async () => {
    const { loadGoldSet, loadTaxonomy } = await import('../fixtures/load.js');
    const taxonomy = loadTaxonomy();
    const gold = loadGoldSet();

    const report = await runReplay({
      provider: new ReplayStubProvider(),
      taxonomy,
      pins: PINS,
      fit: gold.fit,
      report: gold.report,
    });

    // DEC-39: the counts name the scored first turns, not the size of a half.
    // Counted straight off turn_number, not through isFirstTurn, so a filter
    // that stopped filtering cannot satisfy both sides of the assertion.
    const openers = (tickets: readonly GoldTicket[]): number =>
      tickets.filter((ticket) => ticket.turn_number === 1).length;
    expect(report.method).toBe('action-match');
    expect(report.fitTickets).toBe(openers(gold.fit.tickets));
    expect(report.reportTickets).toBe(openers(gold.report.tickets));
    // The corpus carries later turns, so the filter must have removed some.
    expect(report.reportTickets).toBeGreaterThan(0);
    expect(report.reportTickets).toBeLessThan(gold.report.tickets.length);
    // Every fitted route names a queue; every key is something the stub model can predict.
    expect(Object.keys(report.routeMap).length).toBeGreaterThan(0);
    for (const queue of Object.values(report.routeMap)) {
      expect(typeof queue).toBe('string');
      expect(queue.length).toBeGreaterThan(0);
    }
    expect(report.actionMatchRate).toBeGreaterThanOrEqual(0);
    expect(report.actionMatchRate).toBeLessThanOrEqual(1);
    const confusionTotal =
      report.confusion['queue->queue'] +
      report.confusion['queue->escalate'] +
      report.confusion['escalate->queue'] +
      report.confusion['escalate->escalate'];
    expect(confusionTotal).toBe(report.reportTickets);
  });
});
