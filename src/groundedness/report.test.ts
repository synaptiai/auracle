// The report half of the coverage measurement (section 4.7, section 4.10,
// DEC-31).
//
// The fitting job consumes the fit half and refuses every other. Nothing could
// produce the other half's numbers, so DEC-31's "report from the half that
// fitted nothing" had a writer for one side and nothing for the other. These
// cases pin what this job measures, and that it never fits.
import { describe, expect, it } from 'vitest';

import { FakeProvider } from '../models/fake.js';
import { DEFAULT_JUDGE_PROMPT_VER, pinMismatch, runCoverageReportJob } from './report.js';
import { identityOf } from '../fixtures/load.js';
import type { GoldFile, GoldTicket } from '../fixtures/load.js';

function draft(id: string, supported: number, unsupported: number): GoldTicket {
  return {
    ticket_id: id,
    source: 'synthetic',
    intent: 'refund-request',
    queue: 'billing',
    disposition: { escalated: false, macro_applied: null, refund_issued: false, first_reply_minutes: 5 },
    subject: 'Subject',
    body: 'Body',
    claims: [
      ...Array.from({ length: supported }, (_, i) => ({
        text: `supported claim ${i}`, doc_id: 'DOC-SYN-002', supported: true, grade: null,
      })),
      ...Array.from({ length: unsupported }, (_, i) => ({
        text: `unsupported claim ${i}`, doc_id: 'DOC-SYN-002', supported: false,
        grade: 'absent' as const,
      })),
    ],
  };
}

function half(tickets: GoldTicket[], split: 'report' | 'fit' = 'report'): GoldFile {
  return { split, source: 'synthetic', count: tickets.length, tickets } as GoldFile;
}

/** A judge that answers every claim by its own label. */
function honestScript(tickets: GoldTicket[]): { text: string }[] {
  return tickets.flatMap((t) => (t.claims ?? []).map((c) => ({
    text: c.supported ? 'VERDICT: SUPPORTED' : 'VERDICT: UNSUPPORTED',
  })));
}

describe('runCoverageReportJob (DEC-31)', () => {
  it('measures the report half at thresholds it was given, and fits nothing', async () => {
    // Ten fully grounded drafts score 1.0; ten ungrounded score 1/3.
    const tickets = [
      ...Array.from({ length: 10 }, (_, i) => draft(`G-${i}`, 3, 0)),
      ...Array.from({ length: 10 }, (_, i) => draft(`U-${i}`, 1, 2)),
    ];
    const result = await runCoverageReportJob({
      provider: new FakeProvider(honestScript(tickets)),
      reportHalf: half(tickets),
      modelVer: 'test-stub',
      thresholds: { block: 0.5, review: 1 },
      retryDelayMs: 0,
    });

    expect(result.scoredDrafts).toBe(20);
    // Every draft at or above review is truly grounded here.
    expect(result.reviewPassed).toBe(10);
    expect(result.reviewPrecision).toBe(1);
    // Every draft below block truly carries an unsupported claim.
    expect(result.blockBelow).toBe(10);
    expect(result.blockNpv).toBe(1);
    // The intervals come from the same helper the fit uses.
    expect(result.reviewInterval?.lower).toBeGreaterThan(0.6);
    expect(result.blockInterval?.lower).toBeGreaterThan(0.6);
    // It reports. It never selects a threshold, so nothing here can be a fit.
    expect(Object.keys(result)).not.toContain('fittedReview');
  });

  // The mirror of the fitting job's own refusal. A number reported from the
  // half that chose the threshold is the selection effect DEC-31 removes.
  it('refuses the fit half (DEC-31)', async () => {
    const tickets = [draft('G-0', 3, 0), draft('U-0', 1, 2)];
    await expect(runCoverageReportJob({
      provider: new FakeProvider(honestScript(tickets)),
      reportHalf: half(tickets, 'fit'),
      modelVer: 'test-stub',
      thresholds: { block: 0.5, review: 1 },
      retryDelayMs: 0,
    })).rejects.toThrow(/report half only/);
  });

  it('needs a pinned model version (DEC-26)', async () => {
    const tickets = [draft('G-0', 3, 0)];
    await expect(runCoverageReportJob({
      provider: new FakeProvider([]),
      reportHalf: half(tickets),
      modelVer: '',
      thresholds: { block: 0.5, review: 1 },
      retryDelayMs: 0,
    })).rejects.toThrow(/modelVer/);
  });

  it('refuses a threshold pair the policy engine would refuse', async () => {
    const tickets = [draft('G-0', 3, 0)];
    await expect(runCoverageReportJob({
      provider: new FakeProvider([]),
      reportHalf: half(tickets),
      modelVer: 'test-stub',
      thresholds: { block: 0.9, review: 0.6 },
      retryDelayMs: 0,
    })).rejects.toThrow(/exceeds/);
  });
});

// The job read the committed synthetic report half whatever it was handed, so
// a pair fitted on a real corpus was measured against synthetic cases the fit
// had never seen — and nothing said so. It now refuses a half it cannot place
// opposite the fit half, exactly as the fitting job refuses one.
describe('the half this job will report on (DEC-31)', () => {
  const tickets = [
    ...Array.from({ length: 10 }, (_, i) => draft(`G-${i}`, 3, 0)),
    ...Array.from({ length: 10 }, (_, i) => draft(`U-${i}`, 1, 2)),
  ].map((t) => ({ ...t, source: 'real' as const }));

  function run(over: Record<string, unknown>) {
    return runCoverageReportJob({
      provider: new FakeProvider([]),
      modelVer: 'test-stub',
      thresholds: { block: 0.5, review: 1 },
      retryDelayMs: 0,
      ...over,
    } as Parameters<typeof runCoverageReportJob>[0]);
  }

  it('refuses a real half with no fit half to prove the split against', async () => {
    await expect(run({
      reportHalf: { split: 'report', source: 'real', count: tickets.length, tickets },
    })).rejects.toThrow(/fit half/);
  });

  it('refuses a real half that overlaps its fit half', async () => {
    await expect(run({
      reportHalf: { split: 'report', source: 'real', count: tickets.length, tickets },
      fitIdentity: identityOf({
        split: 'fit', source: 'real', count: tickets.length, tickets: tickets.map((t) => ({ ...t })),
      }),
    })).rejects.toThrow(/appears in both halves/);
  });

  it('refuses a half whose declared count is not what it carries', async () => {
    await expect(run({
      reportHalf: { split: 'report', source: 'synthetic', count: 99, tickets },
    })).rejects.toThrow(/declares 99 tickets but carries 20/);
  });
});

// An interval over zero trials is not a wide interval, it is no measurement.
// Passing a denominator of one to keep the type simple reported an interval of
// roughly [0, 0.79] for a band nobody entered, which reads as a result.
describe('a threshold band no draft reaches', () => {
  it('reports no interval rather than one over an invented trial', async () => {
    // Every draft carries an unsupported claim, so none reaches review at 1.0
    // and every one falls below block at 0.5.
    const tickets = Array.from({ length: 6 }, (_, i) => draft(`U-${i}`, 1, 2));
    const result = await runCoverageReportJob({
      provider: new FakeProvider(honestScript(tickets)),
      reportHalf: half(tickets),
      modelVer: 'test-stub',
      thresholds: { block: 0.5, review: 1 },
      retryDelayMs: 0,
    });
    expect(result.reviewPassed).toBe(0);
    expect(result.reviewInterval).toBeNull();
    // The band that IS entered still carries its interval.
    expect(result.blockBelow).toBe(6);
    expect(result.blockInterval).not.toBeNull();
  });
});

// The thresholds are the fit model's judgement of what coverage means. A model
// that reads claims more generously reaches the same numbers on easier
// evidence, so a pair measured under another pin describes a gate nothing ran.
describe('the pins a reported pair must be measured under (DEC-26)', () => {
  const fit = { version: 3, model_ver: 'z-ai/glm-5.3-flash', prompt_ver: DEFAULT_JUDGE_PROMPT_VER };

  it('accepts the pins the fit used', () => {
    expect(pinMismatch(fit, fit.model_ver, fit.prompt_ver)).toBeNull();
  });

  it('refuses a different model', () => {
    const fault = pinMismatch(fit, 'openai/gpt-4o-mini', fit.prompt_ver);
    expect(fault).toContain('model z-ai/glm-5.3-flash against openai/gpt-4o-mini');
    expect(fault).toContain('DEC-26');
  });

  // The prompt moves the judge's reading as surely as the model does, and the
  // artifact records it for that reason. Checking the model alone let a
  // rewritten judge prompt report on a pair it never produced.
  it('refuses a different judge prompt', () => {
    expect(pinMismatch(fit, fit.model_ver, 'ground-p2')).toContain('prompt ground-p1 against ground-p2');
  });

  it('names both when both differ', () => {
    const fault = pinMismatch(fit, 'openai/gpt-4o-mini', 'ground-p2');
    expect(fault).toContain('model');
    expect(fault).toContain('prompt');
  });
});
