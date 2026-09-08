// Composer — docs/v1-architecture.md section 4.7, DEC-07, DEC-23, DEC-43.
//
// DEC-07: the composer must cite or abstain. Every claim in the draft names
// the retrieved span it comes from. A claim without a citation means the
// composer abstains. An abstain is a correct output, not an error. It is also
// the least expensive way to find a gap in the knowledge.
//
// DEC-43: what the composer writes is the reply a support person would send,
// not a list of assertions. It partitions its own output into sentences and
// labels each one. A claim cites a retrieved span. A courtesy sentence opens
// or closes the reply and states no fact. The draft is those sentences in
// order, so the text a customer reads is the text the gate scored.
//
// An earlier prompt asked for "one claim per line" and joined the lines. That
// contract could only ever produce a bag of sentences, and it did: a run
// drafted eight cited assertions with no opening, no closing, and nothing
// addressed to the person who wrote in.

import { UnreadableAnswerError } from '../models/provider.js';
import type { ChatMessage, ModelProvider } from '../models/provider.js';

import type { ConversationTurn } from '../coordinator/coordinator.js';
import { renderHistory } from '../coordinator/history.js';
import type { RetrievedDoc } from '../retriever/types.js';

/** One claim in the draft and the retrieved span that supports it. */
export interface CitedClaim {
  text: string;
  /** The docId of the retrieved document this claim cites. */
  docId: string;
}

/**
 * One sentence of the drafted reply, as the composer partitioned it (DEC-43).
 *
 * A `docId` names the retrieved document the sentence rests on. Null is a
 * courtesy sentence: it opens or closes the reply and asserts nothing about
 * the customer, the account, the policy or the outcome.
 *
 * Nothing here mechanically proves a courtesy sentence carries no fact, and
 * DEC-43 says so rather than implying otherwise. The controls are the parse
 * below, the console drawing every uncited sentence as uncited, and DEC-12
 * approval on every customer reply.
 */
export interface ReplySentence {
  text: string;
  docId: string | null;
}

export interface ComposerInput {
  question: string;
  /** Retrieved spans, best first (section 4.6). */
  docs: RetrievedDoc[];
  /**
   * DEC-37: earlier turns of this conversation, oldest first. Empty on a
   * first turn. The answer may refer to them, but every claim still cites a
   * retrieved document: history can never be a citation.
   */
  history?: readonly ConversationTurn[];
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
   * Every sentence of the draft in order, claims and courtesy alike (DEC-43).
   * Joined, these are `draft`. Empty when the composer abstains.
   *
   * `claims` is the cited subset of this list, in the same order, which is
   * what makes a verdict recorded by position into `claims` sound.
   */
  sentences: ReplySentence[];
  /**
   * DEC-23: the out-of-date documents among the retrieved set. The abstain
   * signal feeds the stale-document report, so a person sees which documents
   * need a review before a knowledge gap can close.
   */
  staleDocuments: RetrievedDoc[];
  /** DEC-25: integer micro-dollars for the run limits. Zero on a fast-path abstain. */
  costMicros: number;
  /** DEC-26: what the server reports it served. Null on a fast-path abstain. */
  servedModelVer: string | null;
}

/**
 * What the model is asked for (DEC-43).
 *
 * It writes the reply, not a list. The markers are the partition: the model
 * says which sentence rests on which document, and the parser holds it to
 * the shape rather than trusting the prose.
 */
const SYSTEM_PROMPT = [
  'You are a support agent. You answer using only the documents given.',
  'Write the reply you would send to the customer, one sentence per line.',
  'Address the customer directly, in the present tense, in plain language.',
  'Start every sentence that states a fact with the marker [doc:<id>],',
  'naming the document that fact comes from.',
  'You may open the reply with one line marked [courtesy],',
  'and close it with one line marked [courtesy].',
  'A [courtesy] line greets the customer, thanks them, or invites them to reply.',
  'It states nothing about the customer, the account, the policy or the outcome.',
  'It is one sentence.',
  'Every other line states a fact and carries a [doc:<id>] marker.',
  // The marker and its sentence share a line, and the model has to be told
  // so. Asked without this, it wrote the marker on one line and the sentence
  // on the next, which the parser reads as a marker with no sentence — and a
  // reply the model wrote well was thrown away as an abstain.
  'Put the marker and its sentence on one line, like this:',
  '[courtesy] Thanks for writing in.',
  '[doc:SYN-DOC-01] A charge is refundable inside fourteen days.',
  'Leave no blank lines between them.',
  'If you cannot cite every fact you would state, reply with exactly ABSTAIN and nothing else.',
  'Never state a fact that no document supports.',
].join('\n');

/**
 * Answer budget for one compose call.
 *
 * Room for the reasoning the provider bills against this budget, and then a
 * customer-sized draft after it. The pinned default spent up to 610 tokens
 * reasoning about a far smaller judge prompt, and this prompt carries the
 * retrieved documents and the conversation history before the draft begins.
 */
const MAX_OUTPUT_TOKENS = 2048;

const ABSTAIN = 'ABSTAIN';

/**
 * A sentence ending with another sentence after it.
 *
 * Terminal punctuation, whitespace, then more text. A line ending on a full
 * stop does not match, and neither does a decimal or an ellipsis with no text
 * behind it.
 */
const SENTENCE_BOUNDARY = /[.!?]\s+\S/;

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
      sentences: [],
      staleDocuments,
      costMicros: 0,
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

  // An empty answer is not a decision to abstain. ABSTAIN is a determination
  // the model states; nothing at all is an exhausted budget or a dropped
  // completion, and recording it as an abstain reported a cite-or-abstain
  // verdict the model never gave (DEC-07, DEC-30).
  if (completion.text.trim() === '') {
    throw new UnreadableAnswerError(
      'the composer received an unreadable answer (empty); an abstain is a determination '
        + 'and an empty answer is not one (DEC-07)',
      'empty',
    );
  }

  const parsed = parseClaims(completion.text, input.docs);
  if (!parsed.ok) {
    return {
      abstained: true,
      draft: null,
      claims: [],
      sentences: [],
      staleDocuments,
      costMicros: completion.costMicros,
      servedModelVer: completion.servedModelVer,
    };
  }

  // DEC-43: the whole partition joined, courtesy sentences included. The text
  // a customer reads and the text the gate scores are the same string, which
  // is what a second call rewriting claims into prose would have broken.
  return {
    abstained: false,
    draft: parsed.sentences.map((sentence) => sentence.text).join(' '),
    claims: citedOf(parsed.sentences),
    sentences: parsed.sentences,
    staleDocuments,
    costMicros: completion.costMicros,
    servedModelVer: completion.servedModelVer,
  };
}

/**
 * The cited sentences, in draft order.
 *
 * The gate's coverage denominator and the position a verdict is recorded
 * against (section 4.7). Order is the draft's, so a verdict at index i is
 * about the i-th cited sentence however many courtesy sentences sit around
 * them.
 */
function citedOf(sentences: readonly ReplySentence[]): CitedClaim[] {
  const claims: CitedClaim[] = [];
  for (const sentence of sentences) {
    if (sentence.docId !== null) claims.push({ text: sentence.text, docId: sentence.docId });
  }
  return claims;
}

function renderUserPrompt(input: ComposerInput): string {
  const docs = input.docs
    .map((doc) => `[doc:${doc.docId}] ${doc.title}\n${doc.body}`)
    .join('\n\n');
  // History sits before the documents and is never cited: the parser accepts
  // a claim only when it names a retrieved doc id, so an answer resting on
  // history alone cannot pass.
  const rendered = renderHistory(input.history ?? []);
  const conversation =
    rendered.length > 0 ? `Earlier turns:\n${rendered}\n\n` : '';
  return `${conversation}Ticket:\n${input.question}\n\nDocuments:\n${docs}`;
}

type Parsed =
  | { ok: true; sentences: ReplySentence[] }
  | { ok: false };

/**
 * Reads the answer as a drafted reply or an abstain.
 *
 * DEC-07 as code: every sentence that states a fact carries a marker that
 * resolves to a retrieved docId. One uncited fact, one unknown docId, or an
 * explicit ABSTAIN fails the whole draft.
 *
 * DEC-43 as code: the shape is one optional courtesy sentence, then one or
 * more claims, then one optional courtesy sentence. Nothing else is a reply
 * this composer will draft.
 *
 * The bound is the point. A courtesy sentence is the one place an unciteable
 * fact can sit, so the parser confines that surface to the opening and the
 * closing — two sentences an approver reads on every reply — rather than
 * letting the model choose how many uncited lines the draft carries. A run
 * whose only lines are courtesy has cited nothing, and cite-or-abstain makes
 * that an abstain rather than a draft that says nothing.
 *
 * A line the reader cannot resolve is not an unreadable answer. Cite-or-abstain
 * is all or nothing, so a claim the composer could not cite is exactly the
 * rule firing, and an abstain is the determination it produces. The one answer
 * that determines nothing is the empty one, refused above before this runs.
 */
function parseClaims(text: string, docs: RetrievedDoc[]): Parsed {
  if (text.trim().toUpperCase() === ABSTAIN) return { ok: false };

  const knownIds = new Set(docs.map((doc) => doc.docId));
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  if (lines.length === 0) return { ok: false };

  const sentences: ReplySentence[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    // Tried first, and it cannot collide with a citation: a citation marker
    // starts `[doc:` and this one does not.
    const courtesy = /^\[courtesy\]\s+(.+)$/.exec(trimmed);
    if (courtesy !== null) {
      const { 1: courtesyText } = courtesy;
      if (courtesyText === undefined) return { ok: false };
      const text = courtesyText.trim();
      // One sentence, which is what DEC-43 bounds. The marker bounds a line,
      // and a line holds as many sentences as the model writes into it — so
      // `[courtesy] Thanks. We already refunded your charge.` passed a bound
      // that reads as one uncited sentence and delivered two, with a fact in
      // the second. The bound has to count what it says it counts.
      if (SENTENCE_BOUNDARY.test(text)) return { ok: false };
      sentences.push({ text, docId: null });
      continue;
    }
    const match = /^\[doc:([^\]]+)\]\s+(.+)$/.exec(trimmed);
    if (match === null) return { ok: false };
    const { 1: docId, 2: claimText } = match;
    if (docId === undefined || claimText === undefined) return { ok: false };
    // A citation naming a document that was not retrieved is a claim the
    // composer could not ground, which is the cite-or-abstain rule doing its
    // work rather than an unreadable answer.
    if (!knownIds.has(docId)) return { ok: false };
    sentences.push({ text: claimText.trim(), docId });
  }

  return isReplyShaped(sentences) ? { ok: true, sentences } : { ok: false };
}

/**
 * Whether the partition is a reply: courtesy?, claim+, courtesy? (DEC-43).
 *
 * Three separate refusals, and each one is a different mistake. A draft with
 * no claim cites nothing. A courtesy sentence between two claims is an
 * uncited sentence in the body of the answer, where a reader reads it as part
 * of the argument. More than one on either end is the model choosing how much
 * of the reply goes uncited, which is the choice this bound takes back.
 */
function isReplyShaped(sentences: readonly ReplySentence[]): boolean {
  const first = sentences.findIndex((sentence) => sentence.docId !== null);
  if (first === -1) return false;

  let last = first;
  for (let i = sentences.length - 1; i >= first; i -= 1) {
    if (sentences[i]?.docId !== null) {
      last = i;
      break;
    }
  }

  for (let i = first; i <= last; i += 1) {
    if (sentences[i]?.docId === null) return false;
  }

  return first <= 1 && sentences.length - 1 - last <= 1;
}
