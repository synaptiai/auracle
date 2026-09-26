import { describe, expect, it } from 'vitest';

import { CLASSIFIER_K, classifyTicket, GATE_AGREEMENT } from './classifier.js';
import type { ClassifierTaxonomy } from './classifier.js';
import { FakeProvider } from '../models/fake.js';
import { UnreadableAnswerError } from '../models/provider.js';
import type { FakeStep, RecordedCall } from '../models/fake.js';

const TAXONOMY: ClassifierTaxonomy = {
  intents: [
    { id: 'refund-request', label: 'Refund request' },
    { id: 'payment-failure', label: 'Payment failure' },
    { id: 'general-question', label: 'General question' },
  ],
};

const PIN = { promptVer: 'classify-p1', modelVer: 'test-model' };

function chatCalls(calls: readonly RecordedCall[]): RecordedCall[] {
  return calls.filter((call) => call.kind === 'chat');
}

describe('classifyTicket (section 4.5, DEC-05)', () => {
  it('counts an unreadable sample against agreement instead of failing the ticket', async () => {
    // One truncated sample of nine is one sample. The denominator stays K
    // (section 4.5), so it counts against agreement exactly as a sample
    // naming no valid intent does. Failing the ticket would discard the eight
    // samples that answered.
    const script = [
      { finishReason: 'length' },
      ...Array.from({ length: 8 }, () => ({ text: 'refund-request' })),
    ];
    const result = await classifyTicket(new FakeProvider(script), {
      taxonomy: TAXONOMY,
      ticketText: 'I want a refund',
      ...PIN,
    });
    expect(result.intentId).toBe('refund-request');
    expect(result.agreement).toBeCloseTo(8 / 9, 6);
  });

  it('reads an empty answer as unreadable, not as a label outside the taxonomy', async () => {
    // The composer and the judge both raise on this string. Counting it as a
    // vote hid it from the attrition count the calibration ceiling reads.
    const script = [
      { text: '' },
      ...Array.from({ length: 8 }, () => ({ text: 'refund-request' })),
    ];
    const result = await classifyTicket(new FakeProvider(script), {
      taxonomy: TAXONOMY,
      ticketText: 'I want a refund',
      ...PIN,
    });
    expect(result.unreadableSamples).toBe(1);
    expect(result.agreement).toBeCloseTo(8 / 9, 6);
  });

  it('names the cause of the fault, not how often it happened', async () => {
    // Nine accounting faults are not a budget fault. Keying the shape on the
    // count reported these as 'truncated', and the runbook then sent an
    // operator to check the answer budget.
    const noCost = { finishReason: 'length', costUnknown: true, shape: 'no-cost' } as const;
    const script = Array.from({ length: 9 }, () => noCost);
    const caught = await classifyTicket(new FakeProvider(script), {
      taxonomy: TAXONOMY,
      ticketText: 'I want a refund',
      ...PIN,
    })
      .then(() => null)
      .catch((e: unknown) => e as UnreadableAnswerError);
    expect(caught).toBeInstanceOf(UnreadableAnswerError);
    expect(caught?.shape).toBe('no-cost');
  });

  it('calls a blank answer empty, not a budget fault', async () => {
    // 'truncated' sends an operator to raise the answer budget. A model that
    // answered nothing did not run out of budget.
    //
    // Eight blanks and one truncated sample, not nine blanks. With nine the
    // case proves nothing: no blank would enter the tally, the run would fall
    // to the `?? 'empty'` fallback, and the assertion would hold with the
    // counting deleted. The mix makes the tally the only thing that decides.
    const script = [
      ...Array.from({ length: 8 }, () => ({ text: '' })),
      { finishReason: 'length' } as const,
    ];
    const caught = await classifyTicket(new FakeProvider(script), {
      taxonomy: TAXONOMY, ticketText: 'I want a refund', ...PIN,
    }).then(() => null).catch((e: unknown) => e as UnreadableAnswerError);
    expect(caught?.shape).toBe('empty');
  });

  it('names the same cause however the provider ordered the samples', async () => {
    // The shape was read off a first-seen list, so one blank arriving before
    // eight truncated samples reported 'empty' and the same nine reordered
    // reported 'truncated'. The runbook sends an operator to a different
    // remedy for each, so the answer order chose the remedy.
    const blank = { text: '' } as const;
    const truncated = { finishReason: 'length' } as const;
    const shapeOf = async (script: readonly FakeStep[]) =>
      (await classifyTicket(new FakeProvider([...script]), {
        taxonomy: TAXONOMY, ticketText: 'I want a refund', ...PIN,
      }).then(() => null).catch((e: unknown) => e as UnreadableAnswerError))?.shape;

    const eightTruncated = Array.from({ length: 8 }, () => truncated);
    expect(await shapeOf([blank, ...eightTruncated])).toBe('truncated');
    expect(await shapeOf([...eightTruncated, blank])).toBe('truncated');

    // A tie is reachable, and counting alone left the ordering dependence
    // intact exactly there. Four of each, plus one sample naming no intent
    // this taxonomy holds so the run still faults with nothing to count.
    const tie = [
      ...Array.from({ length: 4 }, () => blank),
      ...Array.from({ length: 4 }, () => truncated),
      { text: 'not-an-intent' } as const,
    ];
    expect(await shapeOf(tie)).toBe('empty');
    expect(await shapeOf([...tie].reverse())).toBe('empty');
  });

  it('calls it a taxonomy fault only when every sample was readable', async () => {
    // Eight budget faults and one stray label is not a taxonomy fault, and
    // its own runbook row says the samples were readable.
    const script = [
      ...Array.from({ length: 8 }, () => ({ finishReason: 'length' })),
      { text: 'not-an-intent' },
    ];
    const mixed = await classifyTicket(new FakeProvider(script), {
      taxonomy: TAXONOMY, ticketText: 'I want a refund', ...PIN,
    }).then(() => null).catch((e: unknown) => e as UnreadableAnswerError);
    expect(mixed?.shape).toBe('truncated');

    const allReadable = await classifyTicket(
      new FakeProvider(Array.from({ length: 9 }, () => ({ text: 'not-an-intent' }))),
      { taxonomy: TAXONOMY, ticketText: 'I want a refund', ...PIN },
    ).then(() => null).catch((e: unknown) => e as UnreadableAnswerError);
    expect(allReadable?.shape).toBe('no-label');
  });

  it('allows each sample enough answer budget to reason and still answer', async () => {
    const provider = new FakeProvider(
      Array.from({ length: 9 }, () => ({ text: 'refund-request' })),
    );
    await classifyTicket(provider, {
      taxonomy: TAXONOMY,
      ticketText: 'I want a refund',
      ...PIN,
    });
    expect(chatCalls(provider.calls)).toHaveLength(9);
    for (const call of chatCalls(provider.calls)) {
      expect(call.maxOutputTokens ?? 0).toBeGreaterThanOrEqual(1024);
    }
  });

  it('samples exactly CLASSIFIER_K = 9 times', async () => {
    const provider = new FakeProvider(
      Array.from({ length: CLASSIFIER_K }, () => ({ text: 'refund-request' })),
    );

    await classifyTicket(provider, {
      taxonomy: TAXONOMY,
      ticketText: 'I want my money back',
      ...PIN,
    });

    const calls = chatCalls(provider.calls);
    expect(CLASSIFIER_K).toBe(9);
    expect(calls).toHaveLength(9);
  });

  it('sends the taxonomy labels and the ticket text on every call (DEC-26 pins included)', async () => {
    const provider = new FakeProvider(
      Array.from({ length: CLASSIFIER_K }, () => ({ text: 'payment-failure' })),
    );

    const result = await classifyTicket(provider, {
      taxonomy: TAXONOMY,
      ticketText: 'card declined',
      temperature: 0.4,
      ...PIN,
    });

    for (const call of chatCalls(provider.calls)) {
      const system = call.messages?.[0]?.content ?? '';
      expect(system).toContain('refund-request');
      expect(system).toContain('payment-failure');
      expect(system).toContain('general-question');
      expect(call.messages?.[1]?.content).toBe('card declined');
      // Section 4.5: every sample goes out at a temperature above zero.
      expect(call.temperature).toBe(0.4);
      expect(call.temperature).toBeGreaterThan(0);
      expect(call.promptVer).toBe(PIN.promptVer);
      expect(call.modelVer).toBe(PIN.modelVer);
    }
    expect(result.intentId).toBe('payment-failure');
  });

  it('throws at temperature 0 — assertion, not comment (section 4.5 warning)', async () => {
    const provider = new FakeProvider();
    await expect(
      classifyTicket(provider, {
        taxonomy: TAXONOMY,
        ticketText: 'anything',
        temperature: 0,
        ...PIN,
      }),
    ).rejects.toThrow(/temperature must be above zero/);
    expect(chatCalls(provider.calls)).toHaveLength(0);
  });

  it('throws at negative temperature too', async () => {
    const provider = new FakeProvider();
    await expect(
      classifyTicket(provider, {
        taxonomy: TAXONOMY,
        ticketText: 'anything',
        temperature: -0.5,
        ...PIN,
      }),
    ).rejects.toThrow(/temperature must be above zero/);
  });

  it('computes the modal intent and its fraction of K samples', async () => {
    // 5 refund, 3 payment, 1 general -> modal is refund at 5/9.
    const votes = [
      'refund-request',
      'payment-failure',
      'refund-request',
      'refund-request',
      'payment-failure',
      'general-question',
      'refund-request',
      'payment-failure',
      'refund-request',
    ];
    const provider = new FakeProvider(votes.map((text) => ({ text })));

    const result = await classifyTicket(provider, {
      taxonomy: TAXONOMY,
      ticketText: 'mixed signals',
      ...PIN,
    });

    expect(result.intentId).toBe('refund-request');
    expect(result.agreement).toBeCloseTo(5 / 9, 12);
    expect(result.agreement).toBeLessThan(GATE_AGREEMENT + 0.001);
  });

  it('breaks ties deterministically by first-seen order', async () => {
    // 4 payment first seen, then 4 refund: the tie resolves to payment.
    const votes = [
      'payment-failure',
      'refund-request',
      'payment-failure',
      'refund-request',
      'payment-failure',
      'refund-request',
      'payment-failure',
      'refund-request',
      'general-question',
    ];
    const provider = new FakeProvider(votes.map((text) => ({ text })));

    const result = await classifyTicket(provider, {
      taxonomy: TAXONOMY,
      ticketText: 'tie breaker',
      ...PIN,
    });

    expect(result.intentId).toBe('payment-failure');
    expect(result.agreement).toBeCloseTo(4 / 9, 12);
  });

  it('counts invalid labels against agreement instead of crashing', async () => {
    // 4 valid refund votes, 5 garbage replies: agreement is 4/9, not 4/4.
    const steps = Array.from({ length: 4 }, () => ({ text: 'refund-request' })).concat(
      Array.from({ length: 5 }, () => ({ text: 'i am not sure!!!' })),
    );
    const provider = new FakeProvider(steps);

    const result = await classifyTicket(provider, {
      taxonomy: TAXONOMY,
      ticketText: 'noisy model output',
      ...PIN,
    });

    expect(result.intentId).toBe('refund-request');
    expect(result.agreement).toBeCloseTo(4 / 9, 12);
  });

  it('matches ids case-insensitively and ignores surrounding whitespace', async () => {
    const provider = new FakeProvider(
      Array.from({ length: CLASSIFIER_K }, () => ({ text: '  Refund-Request \n' })),
    );

    const result = await classifyTicket(provider, {
      taxonomy: TAXONOMY,
      ticketText: 'refund please',
      ...PIN,
    });

    expect(result.intentId).toBe('refund-request');
    expect(result.agreement).toBe(1.0);
  });

  it('throws when every sample is an invalid label', async () => {
    const provider = new FakeProvider(
      Array.from({ length: CLASSIFIER_K }, () => ({ text: 'nonsense' })),
    );
    await expect(
      classifyTicket(provider, {
        taxonomy: TAXONOMY,
        ticketText: 'anything',
        ...PIN,
      }),
    ).rejects.toThrow(/no intent label in 9 classifier samples/);
  });

  it('rejects an empty taxonomy before any call', async () => {
    const provider = new FakeProvider();
    await expect(
      classifyTicket(provider, {
        taxonomy: { intents: [] },
        ticketText: 'anything',
        ...PIN,
      }),
    ).rejects.toThrow(/empty taxonomy/);
    expect(chatCalls(provider.calls)).toHaveLength(0);
  });

  it('takes the taxonomy as input, not hardcoded', async () => {
    const custom: ClassifierTaxonomy = {
      intents: [{ id: 'klingon-complaint', label: 'Klingon complaint' }],
    };
    const provider = new FakeProvider(
      Array.from({ length: CLASSIFIER_K }, () => ({ text: 'klingon-complaint' })),
    );

    const result = await classifyTicket(provider, {
      taxonomy: custom,
      ticketText: 'qatlh!',
      ...PIN,
    });

    expect(result.intentId).toBe('klingon-complaint');
    expect(result.agreement).toBe(1.0);
  });
});

describe('conversation history in the prompt (DEC-37)', () => {
  function taxonomy() {
    return { intents: [{ id: 'refund', label: 'Refund', risk_tier: 'high' as const }] };
  }

  it('puts earlier turns before the latest message', async () => {
    const provider = new FakeProvider(
      Array.from({ length: 9 }, () => ({ text: 'refund' })),
    );

    await classifyTicket(provider, {
      taxonomy: taxonomy(),
      ticketText: 'It still does not work.',
      history: [{ turnNumber: 1, author: 'customer', bodyText: 'I want a refund.' }],
      promptVer: 'p@1',
      modelVer: 'm@1',
    });

    const prompt = provider.calls[0]?.messages?.at(-1)?.content ?? '';
    // Without the earlier turn, "it" names nothing the classifier can read.
    expect(prompt).toContain('I want a refund.');
    expect(prompt).toContain('It still does not work.');
    expect(prompt.indexOf('I want a refund.')).toBeLessThan(
      prompt.indexOf('It still does not work.'),
    );
  });

  it('sends the message alone on a first turn', async () => {
    const provider = new FakeProvider(
      Array.from({ length: 9 }, () => ({ text: 'refund' })),
    );

    await classifyTicket(provider, {
      taxonomy: taxonomy(),
      ticketText: 'I want a refund.',
      history: [],
      promptVer: 'p@1',
      modelVer: 'm@1',
    });

    expect(provider.calls[0]?.messages?.at(-1)?.content).toBe('I want a refund.');
  });
});
