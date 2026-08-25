import { describe, expect, it } from 'vitest';

import { FakeProvider } from '../models/fake.js';
import type { RetrievedDoc } from '../retriever/types.js';
import { composeAnswer } from './composer.js';

function doc(overrides: Partial<RetrievedDoc> = {}): RetrievedDoc {
  return {
    docId: 'doc-1',
    kind: 'document',
    title: 'Refund policy',
    body: 'Refunds post within five business days of approval.',
    owner: 'support-docs',
    reviewBy: '2999-01-01',
    fresh: true,
    ...overrides,
  };
}

function deps(provider: FakeProvider) {
  return { provider, promptVer: 'composer-prompt-1', modelVer: 'test-model-1' };
}

describe('composeAnswer (section 4.7, DEC-07)', () => {
  it('returns a cited draft when every line carries a resolvable marker', async () => {
    const docs = [
      doc(),
      doc({ docId: 'doc-2', title: 'Shipping', body: 'Ships in two days.' }),
    ];
    const provider = new FakeProvider([
      {
        text: [
          '[doc:doc-1] Refunds post within five business days.',
          '[doc:doc-2] Orders ship within two days.',
        ].join('\n'),
      },
    ]);

    const result = await composeAnswer({ question: 'Where is my refund?', docs }, deps(provider));

    expect(result.abstained).toBe(false);
    expect(result.draft).toBe(
      'Refunds post within five business days. Orders ship within two days.',
    );
    expect(result.claims).toEqual([
      { text: 'Refunds post within five business days.', docId: 'doc-1' },
      { text: 'Orders ship within two days.', docId: 'doc-2' },
    ]);
    expect(result.costCents).toBe(1);
    expect(result.servedModelVer).toBe('test-model-1');
  });

  it('abstains when one claim lacks a citation (cite-or-abstain is all or nothing)', async () => {
    const provider = new FakeProvider([
      {
        text: [
          '[doc:doc-1] Refunds post within five business days.',
          'Free shipping on everything.',
        ].join('\n'),
      },
    ]);

    const result = await composeAnswer(
      { question: 'Where is my refund?', docs: [doc()] },
      deps(provider),
    );

    expect(result.abstained).toBe(true);
    expect(result.draft).toBeNull();
    expect(result.claims).toEqual([]);
  });

  it('abstains when the model replies ABSTAIN', async () => {
    const stale = doc({
      docId: 'stale-1',
      title: 'Old refund policy',
      fresh: false,
      reviewBy: '2020-01-01',
    });
    const provider = new FakeProvider([{ text: 'ABSTAIN' }]);

    const result = await composeAnswer(
      { question: 'Where is my refund?', docs: [stale] },
      deps(provider),
    );

    expect(result.abstained).toBe(true);
    expect(result.draft).toBeNull();
    // DEC-23: the abstain signal reports the documents that need a review.
    expect(result.staleDocuments.map((d) => d.docId)).toEqual(['stale-1']);
  });

  it('abstains when a citation names an unknown docId', async () => {
    const provider = new FakeProvider([{ text: '[doc:nope] Refunds take a day.' }]);

    const result = await composeAnswer(
      { question: 'Where is my refund?', docs: [doc()] },
      deps(provider),
    );

    expect(result.abstained).toBe(true);
    expect(result.claims).toEqual([]);
  });

  it('abstains without spending a model call when nothing was retrieved', async () => {
    const provider = new FakeProvider([]);

    const result = await composeAnswer({ question: 'Anything?', docs: [] }, deps(provider));

    expect(result.abstained).toBe(true);
    expect(result.staleDocuments).toEqual([]);
    expect(result.costCents).toBe(0);
    expect(result.servedModelVer).toBeNull();
    // No script entry was consumed because no call happened.
    expect(provider.calls).toHaveLength(0);
  });

  it('pins prompt and model versions on the model call (DEC-26)', async () => {
    const provider = new FakeProvider([{ text: '[doc:doc-1] Refunds post in five days.' }]);

    await composeAnswer({ question: 'q', docs: [doc()] }, deps(provider));

    expect(provider.calls[0]?.promptVer).toBe('composer-prompt-1');
    expect(provider.calls[0]?.modelVer).toBe('test-model-1');
  });
});
