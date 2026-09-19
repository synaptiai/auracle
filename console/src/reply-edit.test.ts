// The callout's three edits (DEC-44), as pure text operations.
import { describe, expect, it } from 'vitest';

import {
  closestDocumentSentence,
  sentencesOf,
  withSentenceReplaced,
  withoutSentence,
} from './reply-edit.js';

const DOCUMENT = 'Refunds post to the original payment method. '
  + 'A duplicate charge is refunded within five business days. '
  + 'Contact billing about an invoice.';
const REPLY = 'Thanks for writing in. Your five day refund is on its way. '
  + 'Contact billing about your invoice.';

describe('sentencesOf', () => {
  it('splits a reply at sentence ends, which is how the composer joined it', () => {
    expect(sentencesOf(REPLY)).toEqual([
      'Thanks for writing in.',
      'Your five day refund is on its way.',
      'Contact billing about your invoice.',
    ]);
  });

  it('keeps a line break a person typed as part of the sentence it ends', () => {
    expect(sentencesOf('One line\nand the rest of it. A second one.')).toEqual([
      'One line\nand the rest of it.',
      'A second one.',
    ]);
  });

  it('reads text with no sentence end as one sentence', () => {
    expect(sentencesOf('  a reply with no full stop  ')).toEqual(['a reply with no full stop']);
  });

  it('reads nothing as no sentences rather than one empty one', () => {
    expect(sentencesOf('   \n ')).toEqual([]);
  });
});

describe('closestDocumentSentence', () => {
  it('picks the sentence sharing the most words with the claim', () => {
    expect(closestDocumentSentence(DOCUMENT, 'Your refund arrives in five days.')).toBe(
      'A duplicate charge is refunded within five business days.',
    );
  });

  it('reads a document that shares no word with the claim as no answer', () => {
    expect(closestDocumentSentence(DOCUMENT, 'When can I expect delivery?')).toBeNull();
  });

  // Words as written, stopwords included. A list of words to ignore would be
  // one more rule to keep, and the reviewer edits the suggestion anyway.
  it('counts a shared stopword as a shared word', () => {
    expect(closestDocumentSentence(DOCUMENT, 'Ship it to me.')).toBe(
      'Refunds post to the original payment method.',
    );
  });

  it('returns the earlier sentence when two share as many words', () => {
    const tied = 'Refund refund. Refund refund.';
    expect(closestDocumentSentence(tied, 'refund')).toBe('Refund refund.');
  });
});

// Synthetic text, and not ASCII-only: a customer reply may carry a name, a
// currency or a language this repository has never seen, and the split, the
// match and the splice all count characters (DEC-18 keeps the data invented).
describe('text that is not ASCII', () => {
  const accented = 'Votre remboursement arrive. Le délai d\u2019attente est de cinco días.';

  it('splits on the sentence ends a person typed', () => {
    expect(sentencesOf(accented)).toEqual([
      'Votre remboursement arrive.',
      'Le délai d\u2019attente est de cinco días.',
    ]);
  });

  it('replaces one sentence without touching the characters around it', () => {
    expect(withSentenceReplaced(accented, 'Le délai d\u2019attente est de cinco días.', 'Cinco días.'))
      .toBe('Votre remboursement arrive. Cinco días.');
  });

  it('removes one sentence and closes the gap with a single space', () => {
    expect(withoutSentence(accented, 'Votre remboursement arrive.'))
      .toBe('Le délai d\u2019attente est de cinco días.');
  });

  it('compares words by letter, so an accent is part of the word', () => {
    expect(closestDocumentSentence('Le délai est de cinco días. Rien ici.', 'cinco días'))
      .toBe('Le délai est de cinco días.');
  });
});

describe('withSentenceReplaced', () => {
  it('puts the replacement where the sentence stood and leaves the rest alone', () => {
    const replaced = withSentenceReplaced(
      REPLY,
      'Your five day refund is on its way.',
      'A duplicate charge is refunded within five business days.',
    );

    expect(replaced).toBe(
      'Thanks for writing in. A duplicate charge is refunded within five business days. '
        + 'Contact billing about your invoice.',
    );
  });

  it('reads a sentence the reply no longer holds as no edit', () => {
    expect(withSentenceReplaced(REPLY, 'A sentence nobody wrote.', 'anything')).toBeNull();
  });

  it('refuses an empty replacement, which would leave a hole', () => {
    expect(withSentenceReplaced(REPLY, 'Thanks for writing in.', '   ')).toBeNull();
  });
});

describe('withoutSentence', () => {
  it('closes the neighbours over the removed sentence', () => {
    expect(withoutSentence(REPLY, 'Your five day refund is on its way.')).toBe(
      'Thanks for writing in. Contact billing about your invoice.',
    );
  });

  it('removes the first sentence without leaving a leading space', () => {
    expect(withoutSentence('First. Second.', 'First.')).toBe('Second.');
  });

  it('reads a sentence the reply no longer holds as no edit', () => {
    expect(withoutSentence(REPLY, 'A sentence nobody wrote.')).toBeNull();
  });
});
