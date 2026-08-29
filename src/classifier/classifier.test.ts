import { describe, expect, it } from 'vitest';

import { CLASSIFIER_K, classifyTicket, GATE_AGREEMENT } from './classifier.js';
import type { ClassifierTaxonomy } from './classifier.js';
import { FakeProvider } from '../models/fake.js';
import type { RecordedCall } from '../models/fake.js';

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

  it('returns agreement 9/9 when all samples agree', async () => {
    const provider = new FakeProvider(
      Array.from({ length: CLASSIFIER_K }, () => ({ text: 'refund-request' })),
    );

    const result = await classifyTicket(provider, {
      taxonomy: TAXONOMY,
      ticketText: 'give me a refund',
      ...PIN,
    });

    expect(result.intentId).toBe('refund-request');
    expect(result.agreement).toBe(1.0);
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
    ).rejects.toThrow(/no valid intent label/);
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
