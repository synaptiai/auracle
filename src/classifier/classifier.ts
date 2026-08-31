/**
 * Classifier — docs/v1-architecture.md section 4.5, DEC-05, DEC-10, DEC-13.
 *
 * Samples the taxonomy labels CLASSIFIER_K times at a temperature above zero
 * and returns the modal intent with the agreement fraction. Section 4.5 makes
 * the above-zero temperature a code assertion, not a comment: at zero every
 * sample is identical, agreement is always 1.0, and the gate passes every
 * ticket. The assertion lives on the model port (assertSamplingTemperature)
 * and fires here, at the classifier call site.
 *
 * The taxonomy is an input. This module never hardcodes intents.
 */

import type { ModelProvider } from '../models/provider.js';

import type { ConversationTurn } from '../coordinator/coordinator.js';
import { renderPromptBody } from '../coordinator/history.js';
import { assertSamplingTemperature, UnreadableAnswerError } from '../models/provider.js';

/**
 * Answer budget for one classifier sample.
 *
 * The prompt asks for an intent id and nothing else, but the pinned model
 * reasons before it answers and the provider bills that reasoning against
 * this budget. Sending none left the provider's own cap to decide, which is
 * the one call site that stated no budget at all.
 */
const MAX_OUTPUT_TOKENS = 1024;

/** Section 4.5: nine samples at a temperature above zero. */
export const CLASSIFIER_K = 9;

/**
 * Seed value from section 4.5; calibration refits it per DEC-13. Defined once
 * in the policy engine (its consumer) and re-exported here as the classifier's
 * seed constant.
 */
export { GATE_AGREEMENT } from '../policy/policy.js';

/** Default sampling temperature. Any value above zero satisfies section 4.5. */
const DEFAULT_TEMPERATURE = 0.7;

/** One taxonomy entry. Matches fixtures/taxonomy.json minus fields this module ignores. */
export interface TaxonomyIntent {
  id: string;
  label: string;
}

/** The label set to sample against. An input, never hardcoded (section 4.5). */
export interface ClassifierTaxonomy {
  intents: readonly TaxonomyIntent[];
}

export interface ClassifyInput {
  taxonomy: ClassifierTaxonomy;
  ticketText: string;
  /**
   * DEC-37: earlier turns of this conversation, oldest first. Empty on a
   * first turn. Context only, and never evidence: the gates read retrieved
   * documents alone.
   */
  history?: readonly ConversationTurn[];
  /** DEC-26: the caller pins prompt and model versions. */
  promptVer: string;
  modelVer: string;
  /** Must be above zero (section 4.5). Enforced by assertion, not comment. */
  temperature?: number;
}

export interface Classification {
  /** The modal intent id across the K samples. */
  intentId: string;
  /** Fraction of the K samples that picked the modal intent. */
  agreement: number;
  /**
   * Samples that yielded no readable answer, out of K. A provider refusal
   * and an empty answer both count.
   *
   * They lower agreement, because the denominator is K and a sample that says
   * nothing is not a sample that agrees. At runtime that is fail-closed and
   * needs no more. A job that fits or publishes a number needs the count: a
   * correctly classified ticket whose samples truncated enters the fit with a
   * depressed agreement, and a threshold fitted on that is fitted on the
   * provider's budget rather than on the model's judgement.
   */
  unreadableSamples: number;
  /**
   * True when the provider reported no cost for a sample this run absorbed.
   *
   * The absorbed samples never reach a fault handler, so nothing else can
   * record their spend. Without this a run that swallowed eight truncated
   * samples reported them as free (DEC-25).
   */
  costUnknown: boolean;
}

export async function classifyTicket(
  provider: ModelProvider,
  input: ClassifyInput,
): Promise<Classification> {
  const temperature = input.temperature ?? DEFAULT_TEMPERATURE;

  // Section 4.5 WARNING, as code: a temperature of zero collapses all samples
  // into one and reports false confidence.
  assertSamplingTemperature(temperature);

  if (input.taxonomy.intents.length === 0) {
    throw new Error('classifier received an empty taxonomy');
  }

  const systemPrompt = buildTaxonomyPrompt(input.taxonomy);
  const validIds = new Set(
    input.taxonomy.intents.map((intent) => normalizeLabel(intent.id)),
  );

  // DEC-37: the customer's earlier turns say what "it still does not work"
  // refers to. The label is about the whole conversation, not one message.
  const userPrompt = renderPromptBody(input.history ?? [], input.ticketText);

  const counts = new Map<string, number>();
  let unreadable = 0;
  let costUnknown = false;
  // Counted, not merely collected. A list read at its head named whichever
  // fault arrived first, so nine samples with one blank among eight truncated
  // reported 'empty' and the same nine reordered reported 'truncated' — and
  // the runbook sends an operator to a different remedy for each. The cause a
  // run reports must not depend on the order the provider answered in.
  const shapeCounts = new Map<string, number>();
  for (let i = 0; i < CLASSIFIER_K; i++) {
    let result;
    try {
      result = await provider.complete({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        promptVer: input.promptVer,
        modelVer: input.modelVer,
      });
    } catch (error) {
      // One unreadable sample is one sample, not a failed ticket. The
      // denominator stays K (section 4.5), so an unreadable sample counts
      // against agreement exactly as a sample naming no valid intent does.
      // Escalating the whole ticket on one truncated sample of nine would
      // throw away the eight that answered, and the gate is built to read a
      // disagreeing sample rather than to require all of them.
      //
      // Every sample unreadable still faults, below, because then nothing
      // was measured at all.
      if (error instanceof UnreadableAnswerError) {
        unreadable++;
        // Kept so the fault can name what actually happened rather than how
        // many samples failed.
        shapeCounts.set(error.shape, (shapeCounts.get(error.shape) ?? 0) + 1);
        // A sample this run absorbed rather than escalated on. It still cost
        // money, and when the provider reported no cost for it the run must
        // say so: eight absorbed samples recorded as free is the largest
        // understatement this system can make (DEC-25).
        costUnknown ||= error.costUnknown;
        continue;
      }
      throw error;
    }
    // An empty answer is not a label outside the taxonomy. The composer and
    // the coverage judge both raise on exactly this string; counting it as a
    // vote let a run whose every sample came back blank throw an untyped
    // error, which no caller could catch, and it under-reported the attrition
    // the calibration ceiling reads.
    if (result.text.trim() === '') {
      unreadable++;
      // Named, like every other cause. Falling through to the truncated
      // default sent an operator to raise the answer budget for a model that
      // answered nothing, and the vocabulary already held the right word.
      shapeCounts.set('empty', (shapeCounts.get('empty') ?? 0) + 1);
      continue;
    }
    const label = normalizeLabel(result.text);
    if (!validIds.has(label)) continue;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  if (counts.size === 0) {
    // No sample yielded a label, so agreement measures nothing. Typed
    // whatever the mix of causes: an earlier version typed only the
    // all-unreadable case, so eight truncated samples and one stray label
    // still threw an error no caller could catch, and that run went round
    // the queue's retry ceiling, which is sized for a transient fault and
    // not for one an answer budget reproduces on every pass (DEC-30).
    // The shape names the cause, not the count. Keying it on how many samples
    // failed reported nine accounting faults as a budget fault, and reported
    // a taxonomy fault when eight of nine were budget faults — each sending
    // an operator to the wrong place. A run is a taxonomy fault only when
    // every sample was readable and none named an intent this taxonomy holds.
    throw new UnreadableAnswerError(
      `no intent label in ${CLASSIFIER_K} classifier samples, ${unreadable} of them `
        + 'unreadable, so agreement measures nothing (section 4.5)',
      // Every path that counts an unreadable sample also names its shape, so
      // the fallback cannot fire; it exists because the map can be empty. It
      // names a shape the runbook lists rather than inventing one an operator
      // could not look up.
      unreadable === 0 ? 'no-label' : dominantShape(shapeCounts) ?? 'empty',
      0,
      costUnknown,
    );
  }

  // Deterministic mode: highest count wins, ties keep first-seen order.
  let modalId = '';
  let modalCount = 0;
  for (const [id, count] of counts) {
    if (count > modalCount) {
      modalId = id;
      modalCount = count;
    }
  }

  return {
    unreadableSamples: unreadable,
    costUnknown,
    intentId: modalId,
    // Denominator is K, not the valid-sample count: a garbage sample is not
    // evidence of anything, so it counts against agreement.
    agreement: modalCount / CLASSIFIER_K,
  };
}

// The shape the most samples reported. A run reports one cause, and reading a
// first-seen list at its head made that cause depend on the order the provider
// answered in: one blank among eight truncated samples reported 'empty', and
// the same nine reordered reported 'truncated'. The runbook names a different
// remedy for each, so the answer order decided where an operator was sent.
//
// A tie breaks on the shape's own name, never on arrival order. Counting alone
// left the ordering dependence intact wherever two causes drew level, which is
// reachable: four blank samples, four truncated ones and one sample naming no
// intent this taxonomy holds still faults, with the tally at four apiece.
function dominantShape(counts: Map<string, number>): string | undefined {
  let best: string | undefined;
  let bestCount = 0;
  for (const [shape, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== undefined && shape < best)) {
      best = shape;
      bestCount = count;
    }
  }
  return best;
}

function buildTaxonomyPrompt(taxonomy: ClassifierTaxonomy): string {
  const lines = [
    'Classify the support ticket into exactly one intent id.',
    'Reply with the intent id only.',
    'Intents:',
    ...taxonomy.intents.map((intent) => `- ${intent.id}: ${intent.label}`),
  ];
  return lines.join('\n');
}

function normalizeLabel(text: string): string {
  return text.trim().toLowerCase();
}
