import { describe, expect, it } from 'vitest';

import { FakeProvider, ONE_CENT_IN_MICROS } from '../models/fake.js';
import { UnreadableAnswerError } from '../models/provider.js';
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
    expect(result.costMicros).toBe(ONE_CENT_IN_MICROS);
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

  it('raises rather than abstaining when the model answers nothing', async () => {
    // An empty answer is not a decision to abstain. The model reasons before
    // it answers and the provider bills that reasoning against the answer
    // budget, so an exhausted budget returns nothing at all. Recording that as
    // an abstain reported a cite-or-abstain determination the model never made.
    const provider = new FakeProvider([{ text: '   ' }]);
    // Typed, not matched on message text: a ReferenceError naming the class
    // would satisfy a message match and prove nothing.
    await expect(
      composeAnswer({ question: 'Where is my refund?', docs: [doc()] }, deps(provider)),
    ).rejects.toBeInstanceOf(UnreadableAnswerError);
  });

  it('allows the model enough answer budget to reason and still draft', async () => {
    const provider = new FakeProvider([
      { text: '[doc:doc-1] Refunds post within five business days.' },
    ]);
    await composeAnswer({ question: 'Where is my refund?', docs: [doc()] }, deps(provider));
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.maxOutputTokens ?? 0).toBeGreaterThanOrEqual(2048);
  });

  it('abstains on prose, because cite-or-abstain is the rule that fired', async () => {
    // Not a fault. DEC-07 makes cite-or-abstain all or nothing, so a claim the
    // composer could not cite is the rule working. Only an empty answer
    // determines nothing, and that raises.
    const provider = new FakeProvider([{ text: 'I think the refund policy is five days.' }]);
    const result = await composeAnswer(
      { question: 'Where is my refund?', docs: [doc()] },
      deps(provider),
    );
    expect(result.abstained).toBe(true);
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
    expect(result.costMicros).toBe(0);
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

// The gate journals a verdict per claim by position, not by text, so the
// drafted reply is not stored a second time. `checkGroundedness` drops a
// blank claim before it judges, so a blank one here would shift every later
// index and attribute each verdict to the wrong claim.
describe('a claim is never blank, which is what lets a verdict be an index', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['trailing spaces after the marker', '[doc:doc-1]    '],
    ['a tab after the marker', '[doc:doc-1]\t'],
    ['the marker alone', '[doc:doc-1]'],
    ['a marker with no space', '[doc:doc-1]text'],
  ];

  for (const [name, text] of cases) {
    it(`abstains rather than compose an empty claim: ${name}`, async () => {
      const provider = new FakeProvider([{ text }]);
      const result = await composeAnswer(
        { question: 'Where is my refund?', docs: [doc()] },
        deps(provider),
      );
      // Either it refused outright, or every claim it made carries text.
      if (!result.abstained) {
        for (const claim of result.claims) {
          expect(claim.text.trim(), name).not.toBe('');
        }
      }
    });
  }

  it('composes claims whose text survives a trim, in draft order', async () => {
    const provider = new FakeProvider([
      { text: ['[doc:doc-1]   Refunds post in five days.', '[doc:doc-1] And no sooner.'].join('\n') },
    ]);
    const result = await composeAnswer(
      { question: 'Where is my refund?', docs: [doc()] },
      deps(provider),
    );
    expect(result.abstained).toBe(false);
    expect(result.claims.map((claim) => claim.text))
      .toEqual(['Refunds post in five days.', 'And no sooner.']);
    // The draft is the claims joined, which is why storing them twice would
    // store the reply twice.
    expect(result.draft).toBe('Refunds post in five days. And no sooner.');
  });
});

describe('conversation history in the prompt (DEC-37)', () => {
  it('offers earlier turns as context, ahead of the retrieved documents', async () => {
    const provider = new FakeProvider([
      { text: '[doc:d1] Resets take 15 minutes.' },
    ]);

    await composeAnswer(
      {
        question: 'Any update?',
        docs: [doc({ docId: 'd1', body: 'Resets take 15 minutes.' })],
        history: [{ turnNumber: 1, author: 'customer', bodyText: 'I cannot sign in.' }],
      },
      { provider, promptVer: 'p@1', modelVer: 'm@1' },
    );

    const prompt = provider.calls[0]?.messages?.at(-1)?.content ?? '';
    expect(prompt).toContain('I cannot sign in.');
    expect(prompt.indexOf('I cannot sign in.')).toBeLessThan(prompt.indexOf('Documents:'));
  });

  it('abstains on an answer that rests on history alone', async () => {
    // History is context, never evidence. A claim citing no retrieved doc
    // fails the parser, so the composer abstains (DEC-07).
    const provider = new FakeProvider([
      { text: 'You told me earlier that the tiles were broken.' },
    ]);

    const result = await composeAnswer(
      {
        question: 'Any update?',
        docs: [doc({ docId: 'd1', body: 'Resets take 15 minutes.' })],
        history: [{ turnNumber: 1, author: 'customer', bodyText: 'Tiles broken.' }],
      },
      { provider, promptVer: 'p@1', modelVer: 'm@1' },
    );

    expect(result.abstained).toBe(true);
    expect(result.draft).toBeNull();
  });
});
