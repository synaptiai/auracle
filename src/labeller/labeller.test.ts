// The labeller, and the score that makes its labels readable (issue #26).
//
// DEC-41 requires two things of a threshold fitted for each intent: each case
// says what labelled it, and the artifact says how accurate that labeller
// was. The second is only possible because the generator assigns the true
// intent, so a case keeps `intent` beside `labelled_intent` and the two can
// be compared.
import { describe, expect, it } from 'vitest';

import { STUB_LABELLER_PIN, intentsFrom, labelWith, scoreLabeller, stubLabeller } from './labeller.js';
import { loadGoldSet } from '../fixtures/load.js';

describe('the stub labeller', () => {
  it('names itself, so a threshold can say what labelled its cases', () => {
    const labeller = stubLabeller([{ id: 'a', queue: 'q' }]);
    expect(labeller.kind).toBe('stub');
    expect(labeller.pin).toBe(STUB_LABELLER_PIN);
  });

  // The committed corpus is labelled by `scripts/generate-fixtures.mjs`,
  // which holds the same rule in JavaScript because it cannot import this
  // module. Duplication across that boundary is the pattern `mulberry32`
  // already follows, and this is the guard that keeps the two in step: the
  // module reproduces every label the generator wrote, or one of them drifted.
  it('reproduces every label in the committed corpus', () => {
    const { fit, report } = loadGoldSet();
    const cases = [...fit.tickets, ...report.tickets];
    expect(cases.length).toBeGreaterThan(8_000);

    const labeller = stubLabeller(intentsFrom(cases));
    let checked = 0;
    for (const ticket of cases) {
      expect(ticket.labelled_by).toBe(STUB_LABELLER_PIN);
      expect(labelWith(labeller, ticket)).toBe(ticket.labelled_intent);
      checked += 1;
    }
    expect(checked).toBe(cases.length);
  });

  // A classifier confuses an intent with its neighbours, not with an
  // unrelated one. A uniformly random error would give the fit a shape no
  // deployment produces.
  it('errs toward a sibling intent in the same queue', () => {
    const { fit } = loadGoldSet();
    const wrong = fit.tickets.filter((t) => t.intent !== t.labelled_intent);
    expect(wrong.length).toBeGreaterThan(100);
    // The intent's own queue, not the one the case was routed to. About one
    // case in seven goes to `general` whatever its intent, so the routed
    // queue would compare the wrong thing.
    const subject = new Map(intentsFrom(fit.tickets).map((i) => [i.id, i.queue]));
    for (const ticket of wrong) {
      expect(subject.get(ticket.labelled_intent!)).toBe(subject.get(ticket.intent));
    }
  });
});

describe('the labeller score', () => {
  // The number DEC-41 puts in the artifact.
  it('measures agreement against the generator ground truth', () => {
    const { fit } = loadGoldSet();
    const score = scoreLabeller(fit.tickets);
    expect(score.total).toBe(fit.tickets.length);
    expect(score.agreed).toBeLessThan(score.total);
    expect(score.agreement).toBeCloseTo(score.agreed / score.total, 10);
    // The stand-in targets 0.92, and a real corpus lands near it.
    expect(score.agreement).toBeGreaterThan(0.88);
    expect(score.agreement).toBeLessThan(0.96);
  });

  // A case with no label cannot be scored, and counting it as agreement
  // would report a labeller as more accurate than its own coverage.
  it('refuses to score a case that carries no label', () => {
    expect(() => scoreLabeller([{ intent: 'refund-request' } as never])).toThrow(
      /carries no label/,
    );
  });

  it('reports perfect agreement only when every label matches', () => {
    const perfect = [
      { intent: 'a', labelled_intent: 'a' },
      { intent: 'b', labelled_intent: 'b' },
    ] as never[];
    expect(scoreLabeller(perfect).agreement).toBe(1);
  });
});
