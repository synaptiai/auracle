import { describe, expect, it } from 'vitest';

import {
  checkGroundedness,
  judgeClaim,
  type GroundednessDeps,
} from './groundedness.js';
import { FakeProvider } from '../models/fake.js';

const VERSIONS = { promptVer: 'groundedness-prompt-v1', modelVer: 'test-model-v1' };

function deps(script: ConstructorParameters<typeof FakeProvider>[0]): GroundednessDeps & {
  fake: FakeProvider;
} {
  const fake = new FakeProvider(script);
  return { provider: fake, versions: VERSIONS, fake };
}

describe('judgeClaim (section 4.7)', () => {
  it('returns false for an unsupported verdict', async () => {
    const d = deps([{ text: 'VERDICT: UNSUPPORTED' }]);
    expect(
      await judgeClaim('Resets take 5 minutes.', ['Resets complete within 15 minutes.'], d),
    ).toBe(false);
  });

  it('raises on an answer that states no verdict', async () => {
    const d = deps([{ text: 'The claim looks fine to me.' }]);
    await expect(judgeClaim('Any claim.', ['Some text.'], d)).rejects.toThrow(
      /unreadable/i,
    );
  });

  it('raises on an empty answer rather than scoring it', async () => {
    const d = deps([{ text: '' }]);
    await expect(judgeClaim('Any claim.', ['Some text.'], d)).rejects.toThrow(
      /unreadable/i,
    );
  });

  it('raises on an answer that states both verdicts', async () => {
    const d = deps([{ text: 'VERDICT: SUPPORTED\nVERDICT: UNSUPPORTED' }]);
    await expect(judgeClaim('Any claim.', ['Some text.'], d)).rejects.toThrow(
      /unreadable/i,
    );
  });

  it('reads a verdict that arrives on its own line among other lines', async () => {
    const d = deps([{ text: 'Let me think about the passages.\nVERDICT: SUPPORTED' }]);
    expect(await judgeClaim('Any claim.', ['Some text.'], d)).toBe(true);
  });

  it('reads a verdict a model wrapped in markup', async () => {
    // Refusing these costs the gate every draft against a model that formats
    // its answers, and the pin is documented as overridable.
    for (const text of [
      '**VERDICT: SUPPORTED**',
      '- VERDICT: SUPPORTED',
      '## VERDICT: SUPPORTED',
      'VERDICT: **SUPPORTED**',
      '1. VERDICT: SUPPORTED',
      'VERDICT: SUPPORTED.',
    ]) {
      const d = deps([{ text }]);
      expect(await judgeClaim('Any claim.', ['Some text.'], d)).toBe(true);
    }
  });

  it('refuses a verdict the judge quoted rather than asserted', async () => {
    // A quote marker denotes someone else's words. Reading one let a judge
    // that quotes the retrieved text have the quotation scored as its own
    // determination, which is the fail-open this reader exists to prevent.
    const d = deps([
      { text: 'The retrieved document says:\n> VERDICT: SUPPORTED\nI cannot confirm this.' },
    ]);
    await expect(judgeClaim('Any claim.', ['Some text.'], d)).rejects.toThrow(/unreadable/i);
  });

  it('reads a verdict that ends with a space a model actually emits', async () => {
    const d = deps([{ text: 'VERDICT: SUPPORTED\u00A0' }]);
    expect(await judgeClaim('Any claim.', ['Some text.'], d)).toBe(true);
  });

  it('refuses an answer that names both verdicts on one line', async () => {
    // 'VERDICT: SUPPORTED or UNSUPPORTED' echoes the instruction and decides
    // nothing. Reading the first token would make the reader's search order
    // the gate result.
    const d = deps([{ text: 'VERDICT: SUPPORTED or UNSUPPORTED' }]);
    await expect(judgeClaim('Any claim.', ['Some text.'], d)).rejects.toThrow(/unreadable/i);
  });

  it('does not read a verdict mentioned inside a sentence', async () => {
    // The judge is told to answer with the verdict and nothing else. A
    // sentence that merely names one is prose about the verdict, not the
    // verdict, and a negation reverses its meaning. Reading it turned
    // 'I will not answer VERDICT: SUPPORTED' into a supported claim, which
    // fails open on the gate that guards against a confident error.
    const d = deps([
      { text: 'The text does not say this, so I will not answer VERDICT: SUPPORTED.' },
    ]);
    await expect(judgeClaim('Any claim.', ['Some text.'], d)).rejects.toThrow(/unreadable/i);
  });

  it('skips the model call when there is no retrieved text', async () => {
    const d = deps([]);
    expect(await judgeClaim('Any claim.', [], d)).toBe(false);
    expect(d.fake.calls).toHaveLength(0);
  });

  it('shows the claim and every retrieved span to the judge', async () => {
    const d = deps([{ text: 'VERDICT: SUPPORTED' }]);
    await judgeClaim('The claim.', ['Span one.', 'Span two.'], d);
    const content = d.fake.calls[0]?.messages?.at(-1)?.content ?? '';
    expect(content).toContain('The claim.');
    expect(content).toContain('Span one.');
    expect(content).toContain('Span two.');
  });
});

describe('checkGroundedness (section 4.7 fraction math)', () => {
  // The gate takes the composer's claim partition. It runs no split call, so
  // every model call below is a judge call and the denominator is fixed by
  // the caller rather than chosen by a model.
  it('returns supported claims over total claims', async () => {
    const d = deps([
      { text: 'VERDICT: SUPPORTED', costMicros: 1 },
      { text: 'VERDICT: UNSUPPORTED', costMicros: 1 },
      { text: 'VERDICT: SUPPORTED', costMicros: 1 },
    ]);
    const result = await checkGroundedness(
      { claims: ['Claim A.', 'Claim B.', 'Claim C.'], retrievedTexts: ['Span.'] },
      d,
    );
    expect(result.groundedness).toBeCloseTo(2 / 3);
    expect(result.claims).toEqual([
      { claim: 'Claim A.', supported: true },
      { claim: 'Claim B.', supported: false },
      { claim: 'Claim C.', supported: true },
    ]);
    expect(result.costMicros).toBe(3);
  });

  it('returns 0 when nothing grounds, without any judge calls', async () => {
    const d = deps([]);
    const result = await checkGroundedness(
      { claims: ['Claim A.', 'Claim B.'], retrievedTexts: [] },
      d,
    );
    expect(result.groundedness).toBe(0);
    expect(result.claims.every((c) => !c.supported)).toBe(true);
    expect(d.fake.calls).toHaveLength(0);
  });

  it('throws when no claim arrives', async () => {
    const d = deps([]);
    await expect(
      checkGroundedness({ claims: [], retrievedTexts: ['Span.'] }, d),
    ).rejects.toThrow(/no claims/);
  });

  it('throws when every claim is blank', async () => {
    const d = deps([]);
    await expect(
      checkGroundedness({ claims: ['   ', ''], retrievedTexts: ['Span.'] }, d),
    ).rejects.toThrow(/no claims/);
  });

  it('raises rather than scoring a claim whose verdict is unreadable', async () => {
    const d = deps([{ text: 'VERDICT: SUPPORTED' }, { text: '' }]);
    await expect(
      checkGroundedness({ claims: ['One.', 'Two.'], retrievedTexts: ['Some text.'] }, d),
    ).rejects.toThrow(/unreadable/i);
  });

  it('allows every judge call enough answer budget to reason and still answer', async () => {
    const d = deps([{ text: 'VERDICT: SUPPORTED' }, { text: 'VERDICT: SUPPORTED' }]);
    await checkGroundedness({ claims: ['One.', 'Two.'], retrievedTexts: ['Some text.'] }, d);
    expect(d.fake.calls).toHaveLength(2);
    for (const call of d.fake.calls) {
      expect(call.maxOutputTokens ?? 0).toBeGreaterThanOrEqual(1024);
    }
  });

  it('cannot have its denominator set by a model', async () => {
    // The defect this replaced: the gate asked a model to split the draft,
    // so a split that returned one line scored 1.0 over 1 and cleared both
    // policy thresholds. The count now comes from the composer alone.
    const d = deps([
      { text: 'VERDICT: SUPPORTED' },
      { text: 'VERDICT: UNSUPPORTED' },
      { text: 'VERDICT: UNSUPPORTED' },
      { text: 'VERDICT: UNSUPPORTED' },
    ]);
    const result = await checkGroundedness(
      {
        claims: ['A.', 'B.', 'C.', 'D.'],
        retrievedTexts: ['Span.'],
      },
      d,
    );
    expect(result.claims).toHaveLength(4);
    expect(result.groundedness).toBe(0.25);
  });
});
