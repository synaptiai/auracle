// Groundedness gate — docs/v1-architecture.md section 4.7, DEC-05, DEC-07.
//
// The second, independent gate (DEC-05). It splits the draft into single
// claims and tests each claim against the retrieved text. A claim that adds
// information the text does not contain is not grounded.
//
// This module returns the raw fraction of supported claims. The 0.70 block
// and 0.80 review thresholds are policy concerns (section 4.8) and live in
// src/policy/policy.ts — never here.

import type { ChatMessage, ModelProvider, PinnedVersions } from '../models/provider.js';

/** Model access and pinned versions for this component (DEC-16, DEC-26). */
export interface GroundednessDeps {
  provider: ModelProvider;
  versions: PinnedVersions;
}

export interface GroundednessInput {
  /** The composer's draft, on the automatic path only (section 4.7). */
  draft: string;
  /** Retrieved text spans the claims are tested against. */
  retrievedTexts: readonly string[];
}

export interface ClaimVerdict {
  claim: string;
  supported: boolean;
}

export interface GroundednessResult {
  /** Supported claims divided by total claims (section 4.7). Raw fraction, no verdict. */
  groundedness: number;
  claims: ClaimVerdict[];
  /** DEC-25: total model cost in integer cents across all calls. */
  costCents: number;
}

const SPLIT_SYSTEM = [
  'You split a support reply draft into its individual factual claims.',
  'Rules:',
  'One claim per line, prefixed with "- ".',
  'Keep the wording of the draft.',
  'Do not add information.',
  'Output nothing else.',
].join('\n');

const JUDGE_SYSTEM = [
  'You test one claim against retrieved text.',
  'If the retrieved text contains every piece of information in the claim,',
  'answer exactly "VERDICT: SUPPORTED".',
  'If the claim adds any information the text does not contain,',
  'answer exactly "VERDICT: UNSUPPORTED".',
  'Output nothing else.',
].join('\n');

/**
 * Splits the draft into single claims (section 4.7). One chat call; the
 * response is parsed line by line, so bullet and numbering prefixes are
 * stripped and blank lines dropped.
 */
export async function splitClaims(
  draft: string,
  deps: GroundednessDeps,
): Promise<string[]> {
  return (await splitStep(draft, deps)).claims;
}

/** One chat call that splits the draft; shared by the standalone export and the gate. */
async function splitStep(
  draft: string,
  deps: GroundednessDeps,
): Promise<{ claims: string[]; costCents: number }> {
  const result = await deps.provider.complete({
    messages: [
      { role: 'system', content: SPLIT_SYSTEM },
      { role: 'user', content: draft },
    ],
    temperature: 0,
    maxOutputTokens: 512,
    ...deps.versions,
  });
  return { claims: parseClaims(result.text), costCents: result.costCents };
}

/**
 * Tests one claim against the retrieved texts (section 4.7). Returns true
 * only when the model answers SUPPORTED. Malformed output fails closed:
 * an unparseable verdict counts as unsupported.
 */
export async function judgeClaim(
  claim: string,
  retrievedTexts: readonly string[],
  deps: GroundednessDeps,
): Promise<boolean> {
  if (retrievedTexts.length === 0) return false;
  const result = await deps.provider.complete({
    messages: judgeMessages(claim, retrievedTexts),
    temperature: 0,
    maxOutputTokens: 32,
    ...deps.versions,
  });
  return parseVerdict(result.text);
}

/**
 * Runs the full gate: split, then one verdict per claim, then the fraction.
 * Throws when the draft is empty or yields zero claims — the gate operates
 * on a non-empty draft by definition; an abstaining composer never reaches it.
 */
export async function checkGroundedness(
  input: GroundednessInput,
  deps: GroundednessDeps,
): Promise<GroundednessResult> {
  if (input.draft.trim() === '') {
    throw new Error('groundedness gate received an empty draft (section 4.7)');
  }

  const { claims: texts, costCents: splitCost } = await splitStep(input.draft, deps);
  if (texts.length === 0) {
    throw new Error('claim splitting produced zero claims for a non-empty draft');
  }
  let costCents = splitCost;

  // No retrieved text grounds nothing: every claim is unsupported without a
  // model call, so the fraction is 0 and the policy engine blocks.
  if (input.retrievedTexts.length === 0) {
    return {
      groundedness: 0,
      claims: texts.map((claim) => ({ claim, supported: false })),
      costCents,
    };
  }

  const claims: ClaimVerdict[] = [];
  for (const claim of texts) {
    const verdict = await deps.provider.complete({
      messages: judgeMessages(claim, input.retrievedTexts),
      temperature: 0,
      maxOutputTokens: 32,
      ...deps.versions,
    });
    costCents += verdict.costCents;
    claims.push({ claim, supported: parseVerdict(verdict.text) });
  }

  const supported = claims.filter((c) => c.supported).length;
  return { groundedness: supported / claims.length, claims, costCents };
}

function parseClaims(text: string): string[] {
  return text
    .split('\n')
    .map((line) =>
      line
        .trim()
        .replace(/^[-*•]\s*/, '')
        .replace(/^\d+[.)]\s*/, '')
        .trim(),
    )
    .filter((line) => line !== '');
}

function judgeMessages(claim: string, retrievedTexts: readonly string[]): ChatMessage[] {
  const passages = retrievedTexts.map((text, i) => `[${i + 1}] ${text}`).join('\n');
  return [
    { role: 'system', content: JUDGE_SYSTEM },
    { role: 'user', content: `Retrieved text:\n${passages}\n\nClaim: ${claim}` },
  ];
}

function parseVerdict(text: string): boolean {
  if (/^VERDICT:\s*UNSUPPORTED\b/im.test(text)) return false;
  if (/^VERDICT:\s*SUPPORTED\b/im.test(text)) return true;
  return false;
}
