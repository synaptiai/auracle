// Composer — docs/v1-architecture.md section 4.7, DEC-07, DEC-23.
//
// DEC-07: the composer must cite or abstain. Every claim in the draft names
// the retrieved span it comes from. A claim without a citation means the
// composer abstains. An abstain is a correct output, not an error. It is also
// the least expensive way to find a gap in the knowledge.

import type { ChatMessage, ModelProvider } from '../models/provider.js';
import type { RetrievedDoc } from '../retriever/types.js';

/** One claim in the draft and the retrieved span that supports it. */
export interface CitedClaim {
  text: string;
  /** The docId of the retrieved document this claim cites. */
  docId: string;
}

export interface ComposerInput {
  question: string;
  /** Retrieved spans, best first (section 4.6). */
  docs: RetrievedDoc[];
}

export interface ComposerDeps {
  provider: ModelProvider;
  /** DEC-26: pinned prompt version, recorded on every call. */
  promptVer: string;
  /** DEC-26: pinned model version, echoed by the provider result. */
  modelVer: string;
}

export interface ComposerResult {
  /** True when the composer could not cite every claim (DEC-07). */
  abstained: boolean;
  /** The composed draft. Null when the composer abstains. */
  draft: string | null;
  /** Claim-to-span citations, in draft order. Empty when the composer abstains. */
  claims: CitedClaim[];
  /**
   * DEC-23: the out-of-date documents among the retrieved set. The abstain
   * signal feeds the stale-document report, so a person sees which documents
   * need a review before a knowledge gap can close.
   */
  staleDocuments: RetrievedDoc[];
  /** DEC-25: integer cents for the run limits. Zero on a fast-path abstain. */
  costCents: number;
  /** DEC-26: what the server reports it served. Null on a fast-path abstain. */
  servedModelVer: string | null;
}

const SYSTEM_PROMPT = [
  'You answer support tickets using only the documents given.',
  'Answer with one claim per line.',
  'Start each line with the marker [doc:<id>] naming the document the claim comes from.',
  'If you cannot cite every claim, reply with exactly ABSTAIN and nothing else.',
  'Never state a claim that no document supports.',
].join('\n');

/** Keeps a reply well inside a customer-sized draft. */
const MAX_OUTPUT_TOKENS = 512;

const ABSTAIN = 'ABSTAIN';

/**
 * Composes a cited draft or abstains. With no retrieved spans there is
 * nothing to cite, so it abstains without spending a model call.
 */
export async function composeAnswer(
  input: ComposerInput,
  deps: ComposerDeps,
): Promise<ComposerResult> {
  const staleDocuments = input.docs.filter((doc) => !doc.fresh);

  if (input.docs.length === 0) {
    return {
      abstained: true,
      draft: null,
      claims: [],
      staleDocuments,
      costCents: 0,
      servedModelVer: null,
    };
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: renderUserPrompt(input) },
  ];

  const completion = await deps.provider.complete({
    messages,
    temperature: 0,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    promptVer: deps.promptVer,
    modelVer: deps.modelVer,
  });

  const parsed = parseClaims(completion.text, input.docs);
  if (!parsed.ok) {
    return {
      abstained: true,
      draft: null,
      claims: [],
      staleDocuments,
      costCents: completion.costCents,
      servedModelVer: completion.servedModelVer,
    };
  }

  return {
    abstained: false,
    draft: parsed.claims.map((claim) => claim.text).join(' '),
    claims: parsed.claims,
    staleDocuments,
    costCents: completion.costCents,
    servedModelVer: completion.servedModelVer,
  };
}

function renderUserPrompt(input: ComposerInput): string {
  const docs = input.docs
    .map((doc) => `[doc:${doc.docId}] ${doc.title}\n${doc.body}`)
    .join('\n\n');
  return `Ticket:\n${input.question}\n\nDocuments:\n${docs}`;
}

type Parsed =
  | { ok: true; claims: CitedClaim[] }
  | { ok: false };

/**
 * DEC-07 as code: every non-empty line must be a claim with a marker that
 * resolves to a retrieved docId. One uncited line, one unknown docId, or an
 * explicit ABSTAIN fails the whole draft.
 */
function parseClaims(text: string, docs: RetrievedDoc[]): Parsed {
  if (text.trim().toUpperCase() === ABSTAIN) return { ok: false };

  const knownIds = new Set(docs.map((doc) => doc.docId));
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  if (lines.length === 0) return { ok: false };

  const claims: CitedClaim[] = [];
  for (const line of lines) {
    const match = /^\[doc:([^\]]+)\]\s+(.+)$/.exec(line.trim());
    if (match === null) return { ok: false };
    const { 1: docId, 2: claimText } = match;
    if (docId === undefined || claimText === undefined) return { ok: false };
    if (!knownIds.has(docId)) return { ok: false };
    claims.push({ text: claimText.trim(), docId });
  }
  return { ok: true, claims };
}
