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
import { assertSamplingTemperature } from '../models/provider.js';

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

  const counts = new Map<string, number>();
  for (let i = 0; i < CLASSIFIER_K; i++) {
    const result = await provider.complete({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: input.ticketText },
      ],
      temperature,
      promptVer: input.promptVer,
      modelVer: input.modelVer,
    });
    const label = normalizeLabel(result.text);
    if (!validIds.has(label)) continue;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  if (counts.size === 0) {
    throw new Error(
      `classifier produced no valid intent label in ${CLASSIFIER_K} samples`,
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
    intentId: modalId,
    // Denominator is K, not the valid-sample count: a garbage sample is not
    // evidence of anything, so it counts against agreement.
    agreement: modalCount / CLASSIFIER_K,
  };
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
