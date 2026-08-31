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

import { UnreadableAnswerError } from '../models/provider.js';
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
 * Answer budget for one judging call.
 *
 * A reasoning model spends its reasoning inside this budget, so a budget
 * sized for the verdict alone buys no verdict at all. The pinned default
 * spent between 46 and 610 tokens reasoning about one judge prompt, and at
 * 32 tokens it returned an empty answer every time. This leaves room for the
 * measured tail and the verdict after it.
 */
const JUDGE_MAX_OUTPUT_TOKENS = 1024;

/** What the judge said, or that it said nothing this module can read. */
type Verdict = 'supported' | 'unsupported' | 'unreadable';

/**
 * The judge answered, and the answer carries no verdict.
 *
 * Typed so the caller can tell a fault from a transient failure. The queue's
 * attempt ceiling is sized for a transient fault, and this one is not: the
 * judge runs at temperature 0, so the same prompt reproduces the same
 * unreadable answer on every retry. `PermanentEgressError` models the same
 * shape for the egress path.
 */
export class UnreadableVerdictError extends UnreadableAnswerError {
  constructor(message: string, shape: 'empty' | 'no-verdict' | 'conflicting') {
    super(message, shape);
    this.name = 'UnreadableVerdictError';
  }
}

/**
 * Tests one claim against the retrieved texts (section 4.7). Returns true
 * only when the model answers SUPPORTED. An answer this module cannot read
 * raises, because an unreadable answer is not a verdict.
 *
 * Exported for the tests that drive one claim at a time. It has no production
 * caller and it discards `costMicros`, so a production caller would lose the
 * spend (DEC-25). Use `checkGroundedness`, which accumulates. Kept rather than
 * folded into the tests because rewriting nine passing cases at this stage
 * carries more risk than the hazard it removes.
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
    maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS,
    ...deps.versions,
  });
  return readVerdict(result.text);
}

/**
 * Turns one judge answer into a verdict, or raises.
 *
 * An unreadable answer is not a verdict. Scoring it as unsupported turned a
 * truncated call into a coverage number, so a budget too small for the model
 * blocked every draft and reported a confident fraction while measuring
 * nothing. An unknown outcome escalates here, as it does for an unknown
 * delivery (DEC-30).
 */
function readVerdict(text: string): boolean {
  const verdict = parseVerdict(text);
  if (verdict === 'unreadable') {
    const shape = shapeOf(text);
    throw new UnreadableVerdictError(
      `groundedness judge returned an unreadable answer (${shape}); a claim carries no `
        + 'verdict and this gate never scores one it could not read (section 4.7)',
      shape,
    );
  }
  return verdict === 'supported';
}

/** Names the way an answer failed, so a budget fault reads unlike a chatty model. */
function shapeOf(text: string): 'empty' | 'no-verdict' | 'conflicting' {
  if (text.trim() === '') return 'empty';
  return verdictsIn(text).size > 1 ? 'conflicting' : 'no-verdict';
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
      maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS,
      ...deps.versions,
    });
    costMicros += verdict.costMicros;
    claims.push({ claim, supported: readVerdict(verdict.text) });
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

/**
 * Reads the verdict out of one answer.
 *
 * The verdict must open a line. A model that reasons aloud puts its verdict
 * on its own line, so lines around it are read past. A verdict named inside
 * a sentence is prose about the verdict and not the verdict: the answer
 * 'I will not answer VERDICT: SUPPORTED' states the opposite of the token it
 * contains, and reading it failed open on the gate that guards a confident
 * error.
 *
 * Two distinct verdicts are unreadable rather than the first one found. An
 * answer that says both decides nothing, and returning either would turn the
 * reader's search order into a gate result.
 */
function parseVerdict(text: string): Verdict {
  const found = verdictsIn(text);
  if (found.size !== 1) return 'unreadable';
  return [...found][0]!;
}

/**
 * The verdict line.
 *
 * The line may carry the markup a model reaches for — a bullet, a heading, a
 * number, bold around either half — because refusing those costs the gate
 * every draft against a model that formats its answers, and the pin is
 * documented as overridable.
 *
 * It may not carry a quote marker. A judge that quotes the retrieved text or
 * its own instructions would have the quotation read as its determination,
 * and the claim scored grounded on a line the judge did not assert. That is
 * the failure this reader exists to prevent, so the one markup character that
 * denotes someone else's words stays out.
 *
 * It may not carry prose either. The leading anchor is what rejects 'I will
 * not answer VERDICT: SUPPORTED', which an unanchored reader accepted as a
 * supported claim. The trailing anchor rejects 'VERDICT: SUPPORTED or
 * UNSUPPORTED', which names both and decides neither. The trailing class
 * admits the spaces a model actually emits, including a non-breaking one.
 */
function verdictsIn(text: string): Set<Verdict> {
  const found = new Set<Verdict>();
  // Constructed per call: a /g expression carries lastIndex, and while
  // matchAll clones its argument, a future caller reaching for exec or test
  // would inherit the position this one left.
  const line = /^[ \t*#\-\d.)]*\**VERDICT:[ \t]*\**(UN)?SUPPORTED\**[ \t.\u00A0]*$/gim;
  for (const match of text.matchAll(line)) {
    found.add(match[1] === undefined ? 'supported' : 'unsupported');
  }
  return found;
}
