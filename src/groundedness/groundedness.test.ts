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
  it('returns true for a supported verdict', async () => {
    const d = deps([{ text: 'VERDICT: SUPPORTED' }]);
    expect(
      await judgeClaim('Resets take 15 minutes.', ['Resets complete within 15 minutes.'], d),
    ).toBe(true);
  });

  it('returns false for an unsupported verdict', async () => {
    const d = deps([{ text: 'VERDICT: UNSUPPORTED' }]);
    expect(
      await judgeClaim('Resets take 5 minutes.', ['Resets complete within 15 minutes.'], d),
    ).toBe(false);
  });

  it('fails closed on malformed output', async () => {
    const d = deps([{ text: 'The claim looks fine to me.' }]);
    expect(await judgeClaim('Any claim.', ['Some text.'], d)).toBe(false);
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

  it('returns 1.0 when every claim is supported', async () => {
    const d = deps([{ text: 'VERDICT: SUPPORTED' }]);
    const result = await checkGroundedness(
      { claims: ['Claim A.'], retrievedTexts: ['Span.'] },
      d,
    );
    expect(result.groundedness).toBe(1);
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

  it('makes exactly one judge call per claim and no split call', async () => {
    const d = deps([{ text: 'VERDICT: SUPPORTED' }, { text: 'VERDICT: SUPPORTED' }]);
    await checkGroundedness(
      { claims: ['Claim A.', 'Claim B.'], retrievedTexts: ['Span.'] },
      d,
    );
    expect(d.fake.calls).toHaveLength(2);
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
