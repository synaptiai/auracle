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
    // The draft is the partition joined, which is why storing the sentences
    // and the draft separately would store the reply twice.
    expect(result.draft).toBe('Refunds post in five days. And no sooner.');
    expect(result.sentences).toEqual([
      { text: 'Refunds post in five days.', docId: 'doc-1' },
      { text: 'And no sooner.', docId: 'doc-1' },
    ]);
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

// DEC-43. The product is a reply a support person would send, not a list of
// assertions. The composer partitions its own output and the parser holds it
// to a reply's shape: one optional courtesy sentence, the claims, one
// optional courtesy sentence.
describe('the reply the composer drafts (DEC-43)', () => {
  const REPLY = [
    '[courtesy] Thanks for writing in, and sorry about the wait.',
    '[doc:doc-1] Refunds post within five business days of approval.',
    '[courtesy] If it has not arrived by then, reply here and we will chase it.',
  ].join('\n');

  it('opens and closes the reply, and joins the whole partition into the draft', async () => {
    const provider = new FakeProvider([{ text: REPLY }]);

    const result = await composeAnswer(
      { question: 'Where is my refund?', docs: [doc()] },
      deps(provider),
    );

    expect(result.abstained).toBe(false);
    // The sent text. A reader of this line is reading what a customer reads.
    expect(result.draft).toBe(
      'Thanks for writing in, and sorry about the wait. '
        + 'Refunds post within five business days of approval. '
        + 'If it has not arrived by then, reply here and we will chase it.',
    );
    expect(result.sentences).toEqual([
      { text: 'Thanks for writing in, and sorry about the wait.', docId: null },
      { text: 'Refunds post within five business days of approval.', docId: 'doc-1' },
      { text: 'If it has not arrived by then, reply here and we will chase it.', docId: null },
    ]);
  });

  // The coverage denominator, and the position a gate verdict is recorded
  // against. A courtesy sentence that entered either would change a published
  // number, and one that shifted the index would attribute a verdict to the
  // wrong sentence.
  it('keeps courtesy sentences out of the claims, in draft order', async () => {
    const provider = new FakeProvider([{ text: REPLY }]);

    const result = await composeAnswer(
      { question: 'Where is my refund?', docs: [doc()] },
      deps(provider),
    );

    expect(result.claims).toEqual([
      { text: 'Refunds post within five business days of approval.', docId: 'doc-1' },
    ]);
  });

  it('drafts a reply carrying no courtesy sentence at all', async () => {
    const provider = new FakeProvider([
      { text: '[doc:doc-1] Refunds post within five business days.' },
    ]);

    const result = await composeAnswer(
      { question: 'Where is my refund?', docs: [doc()] },
      deps(provider),
    );

    expect(result.abstained).toBe(false);
    expect(result.draft).toBe('Refunds post within five business days.');
    expect(result.sentences).toEqual([
      { text: 'Refunds post within five business days.', docId: 'doc-1' },
    ]);
  });

  // The shape rule, one refusal at a time. Each of these is a different
  // mistake, and a single case covering "malformed" would pass with any one
  // of the three checks deleted.
  const refusals: readonly (readonly [string, readonly string[]])[] = [
    [
      'a reply that cites nothing',
      ['[courtesy] Thanks for writing in.', '[courtesy] We will be in touch.'],
    ],
    [
      'a courtesy sentence between two claims',
      [
        '[doc:doc-1] Refunds post within five business days.',
        '[courtesy] Hope that helps.',
        '[doc:doc-1] And no sooner.',
      ],
    ],
    [
      'two courtesy sentences opening the reply',
      [
        '[courtesy] Hello.',
        '[courtesy] Thanks for writing in.',
        '[doc:doc-1] Refunds post within five business days.',
      ],
    ],
    [
      'two courtesy sentences closing the reply',
      [
        '[doc:doc-1] Refunds post within five business days.',
        '[courtesy] Hope that helps.',
        '[courtesy] Have a good day.',
      ],
    ],
  ];

  for (const [name, lines] of refusals) {
    it(`abstains rather than draft ${name}`, async () => {
      const provider = new FakeProvider([{ text: lines.join('\n') }]);

      const result = await composeAnswer(
        { question: 'Where is my refund?', docs: [doc()] },
        deps(provider),
      );

      expect(result.abstained, name).toBe(true);
      expect(result.draft, name).toBeNull();
      expect(result.claims, name).toEqual([]);
      expect(result.sentences, name).toEqual([]);
    });
  }

  // The same rule the citation markers obey. A marker with nothing after it
  // would put an empty sentence in the draft, and the draft is joined on a
  // space, so it would read as a double space a reviewer cannot explain.
  const empties: readonly (readonly [string, string])[] = [
    ['the marker alone', '[courtesy]'],
    ['trailing spaces after the marker', '[courtesy]    '],
    ['a tab after the marker', '[courtesy]\t'],
    ['a marker with no space', '[courtesy]text'],
  ];

  for (const [name, courtesy] of empties) {
    it(`abstains rather than draft an empty courtesy sentence: ${name}`, async () => {
      const provider = new FakeProvider([
        { text: [courtesy, '[doc:doc-1] Refunds post in five days.'].join('\n') },
      ]);

      const result = await composeAnswer(
        { question: 'Where is my refund?', docs: [doc()] },
        deps(provider),
      );

      expect(result.abstained, name).toBe(true);
    });
  }

  // The marker bounds a line. A line holds as many sentences as the model
  // writes into it, so a bound counted in lines is not the bound DEC-43
  // states — and the sentences past the first are uncited text in the reply.
  it('abstains on a courtesy line carrying more than one sentence', async () => {
    const provider = new FakeProvider([
      {
        text: [
          '[courtesy] Thanks for writing in. We have already refunded your charge.',
          '[doc:doc-1] Refunds post within five business days.',
        ].join('\n'),
      },
    ]);

    const result = await composeAnswer(
      { question: 'Where is my refund?', docs: [doc()] },
      deps(provider),
    );

    expect(result.abstained).toBe(true);
  });

  // The bound counts sentences, not punctuation. These are each one sentence
  // and every one of them is a courtesy sentence a support agent would write,
  // so refusing any of them would abstain on a well drafted reply.
  const oneSentence: readonly string[] = [
    'Thanks for writing in, and sorry about the wait.',
    'Hello, and thank you for reaching out.',
    'Reply here if that does not sort it and we will take another look.',
    'Happy to help with this!',
    'Can I check one thing with you?',
  ];

  for (const courtesy of oneSentence) {
    it(`drafts a reply opening with one sentence: ${courtesy}`, async () => {
      const provider = new FakeProvider([
        {
          text: [
            `[courtesy] ${courtesy}`,
            '[doc:doc-1] Refunds post within five business days.',
          ].join('\n'),
        },
      ]);

      const result = await composeAnswer(
        { question: 'Where is my refund?', docs: [doc()] },
        deps(provider),
      );

      expect(result.abstained, courtesy).toBe(false);
      expect(result.sentences[0], courtesy).toEqual({ text: courtesy, docId: null });
    });
  }

  it('asks the model for a reply rather than a list of claims', async () => {
    const provider = new FakeProvider([
      { text: '[doc:doc-1] Refunds post within five business days.' },
    ]);

    await composeAnswer({ question: 'Where is my refund?', docs: [doc()] }, deps(provider));

    const system = provider.calls[0]?.messages?.[0]?.content ?? '';
    expect(system).toContain('the reply you would send to the customer');
    expect(system).toContain('[courtesy]');
    // The instruction that produced the eight-assertion draft. Pinned as
    // absent, because a prompt that asks for a list gets one.
    expect(system).not.toContain('one claim per line');
  });

  // Found against the real model, not reasoned about. Asked without this, it
  // wrote `[courtesy]` on one line and the sentence on the next, twice in
  // three attempts. The parser reads that as a marker with no sentence, so a
  // reply the model had written well was thrown away as an abstain.
  it('tells the model to keep a marker and its sentence on one line', async () => {
    const provider = new FakeProvider([
      { text: '[doc:doc-1] Refunds post within five business days.' },
    ]);

    await composeAnswer({ question: 'Where is my refund?', docs: [doc()] }, deps(provider));

    const system = provider.calls[0]?.messages?.[0]?.content ?? '';
    expect(system).toContain('Put the marker and its sentence on one line');
    // A worked example of each marker, because the rule alone did not hold.
    expect(system).toContain('[courtesy] Thanks for writing in.');
    expect(system).toMatch(/\[doc:[^\]]+\] A charge is refundable/);
  });

  // The shape the model actually produced when the instruction was missing.
  // A marker alone is a marker with no sentence, and cite-or-abstain makes
  // that an abstain rather than a claim assembled from two lines.
  it('abstains on a marker whose sentence sits on the next line', async () => {
    const provider = new FakeProvider([
      {
        text: [
          '[courtesy]',
          'Hi, thanks for reaching out.',
          '[doc:doc-1] Refunds post within five business days.',
        ].join('\n'),
      },
    ]);

    const result = await composeAnswer(
      { question: 'Where is my refund?', docs: [doc()] },
      deps(provider),
    );

    expect(result.abstained).toBe(true);
  });
});
