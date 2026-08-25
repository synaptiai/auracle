import { describe, expect, it } from 'vitest';

import {
  checkGroundedness,
  judgeClaim,
  splitClaims,
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

describe('splitClaims (section 4.7)', () => {
  it('strips bullet prefixes and blank lines', async () => {
    const d = deps([{ text: '- Password resets take 15 minutes.\n\n- The link expires after one hour.' }]);
    const claims = await splitClaims('draft', d);
    expect(claims).toEqual([
      'Password resets take 15 minutes.',
      'The link expires after one hour.',
    ]);
  });

  it('strips numbered list prefixes', async () => {
    const d = deps([{ text: '1. First claim.\n2) Second claim.' }]);
    const claims = await splitClaims('draft', d);
    expect(claims).toEqual(['First claim.', 'Second claim.']);
  });

  it('sends the draft to the model with the pinned versions (DEC-26)', async () => {
    const d = deps([{ text: '- One claim.' }]);
    await splitClaims('The draft text.', d);
    expect(d.fake.calls).toHaveLength(1);
    expect(d.fake.calls[0]?.kind).toBe('chat');
    expect(d.fake.calls[0]?.promptVer).toBe(VERSIONS.promptVer);
    expect(d.fake.calls[0]?.modelVer).toBe(VERSIONS.modelVer);
    expect(d.fake.calls[0]?.messages?.at(-1)?.content).toContain('The draft text.');
  });

  it('treats each non-empty line as a claim even without list formatting', async () => {
    const d = deps([{ text: 'First plain claim.\nSecond plain claim.' }]);
    expect(await splitClaims('draft', d)).toEqual([
      'First plain claim.',
      'Second plain claim.',
    ]);
  });
});

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
  it('returns supported claims over total claims', async () => {
    const d = deps([
      { text: '- Claim A.\n- Claim B.\n- Claim C.', costCents: 2 },
      { text: 'VERDICT: SUPPORTED', costCents: 1 },
      { text: 'VERDICT: UNSUPPORTED', costCents: 1 },
      { text: 'VERDICT: SUPPORTED', costCents: 1 },
    ]);
    const result = await checkGroundedness(
      { draft: 'draft', retrievedTexts: ['Span.'] },
      d,
    );
    expect(result.groundedness).toBeCloseTo(2 / 3);
    expect(result.claims).toEqual([
      { claim: 'Claim A.', supported: true },
      { claim: 'Claim B.', supported: false },
      { claim: 'Claim C.', supported: true },
    ]);
    expect(result.costCents).toBe(5);
  });

  it('returns 1.0 when every claim is supported', async () => {
    const d = deps([
      { text: '- Claim A.' },
      { text: 'VERDICT: SUPPORTED' },
    ]);
    const result = await checkGroundedness(
      { draft: 'draft', retrievedTexts: ['Span.'] },
      d,
    );
    expect(result.groundedness).toBe(1);
  });

  it('returns 0 when nothing grounds, without any judge calls', async () => {
    const d = deps([{ text: '- Claim A.\n- Claim B.' }]);
    const result = await checkGroundedness({ draft: 'draft', retrievedTexts: [] }, d);
    expect(result.groundedness).toBe(0);
    expect(result.claims.every((c) => !c.supported)).toBe(true);
    expect(d.fake.calls).toHaveLength(1);
  });

  it('makes exactly one judge call per claim', async () => {
    const d = deps([
      { text: '- Claim A.\n- Claim B.' },
      { text: 'VERDICT: SUPPORTED' },
      { text: 'VERDICT: SUPPORTED' },
    ]);
    await checkGroundedness({ draft: 'draft', retrievedTexts: ['Span.'] }, d);
    expect(d.fake.calls).toHaveLength(3);
  });

  it('throws on an empty draft', async () => {
    const d = deps([]);
    await expect(
      checkGroundedness({ draft: '   ', retrievedTexts: ['Span.'] }, d),
    ).rejects.toThrow(/empty draft/);
  });

  it('throws when a non-empty draft yields zero claims', async () => {
    const d = deps([{ text: '\n \n' }]);
    await expect(
      checkGroundedness({ draft: 'draft', retrievedTexts: ['Span.'] }, d),
    ).rejects.toThrow(/zero claims/);
  });
});
