// Groundedness gate — docs/v1-architecture.md section 4.7, DEC-05, DEC-07.
//
// The second, independent gate (DEC-05). It tests each claim against the
// retrieved text. A claim that adds information the text does not contain is
// not grounded.
//
// The claims come from the composer, which already proved every one of them
// carries a citation to a retrieved span (DEC-07). This gate used to re-split
// the draft with its own model call, which made the denominator of the
// coverage fraction model-controlled: a split that returned one line scored
// 1.0 and cleared both policy thresholds. Taking the composer's partition
// removes that, drops a model call, and keeps the claim boundaries the
// composer validated.
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
  /**
   * The composer's claims, in draft order. Each one is already cited to a
   * retrieved span (section 4.7). The gate never re-derives them, so the
   * denominator of the fraction is not a model's choice.
   */
  claims: readonly string[];
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
  /** DEC-25: total model cost in integer micro-dollars across all calls. */
  costMicros: number;
}

const JUDGE_SYSTEM = [
  'You test one claim against retrieved text.',
  'If the retrieved text contains every piece of information in the claim,',
  'answer exactly "VERDICT: SUPPORTED".',
  'If the claim adds any information the text does not contain,',
  'answer exactly "VERDICT: UNSUPPORTED".',
  'Output nothing else.',
].join('\n');

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
 * Runs the full gate: one verdict per composed claim, then the fraction.
 * Throws when no claim arrives — the gate operates on a composed draft by
 * definition, and an abstaining composer never reaches it.
 */
export async function checkGroundedness(
  input: GroundednessInput,
  deps: GroundednessDeps,
): Promise<GroundednessResult> {
  const texts = input.claims.filter((claim) => claim.trim() !== '');
  if (texts.length === 0) {
    throw new Error(
      'groundedness gate received no claims (section 4.7); an abstaining composer never reaches it',
    );
  }
  let costMicros = 0;

  // No retrieved text grounds nothing: every claim is unsupported without a
  // model call, so the fraction is 0 and the policy engine blocks.
  if (input.retrievedTexts.length === 0) {
    return {
      groundedness: 0,
      claims: texts.map((claim) => ({ claim, supported: false })),
      costMicros,
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
    costMicros += verdict.costMicros;
    claims.push({ claim, supported: parseVerdict(verdict.text) });
  }

  const supported = claims.filter((c) => c.supported).length;
  return { groundedness: supported / claims.length, claims, costMicros };
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
