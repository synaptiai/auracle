// One construction of the model provider from the environment (issue #72).
//
// Six entry points built this for themselves. Two read OPENROUTER_BASE_URL
// and four did not, so an adopter pointing the system at a gateway or a
// proxy found that `load-docs` and the taxonomy job honoured it while the
// consumer, both groundedness jobs and calibration went straight to
// openrouter.ai — with the adopter's key, past whatever the gateway was
// there to enforce. The API-key preflight was written six times beside it.
//
// DEC-16 puts the models behind OpenRouter, and DEC-17 makes the data
// guarantee an adopter's choice. Both now have one place to be read.
import { dataGuaranteeOption } from '../config/env.js';
import type { OpenRouterConfig } from './openrouter.js';
import { OpenRouterProvider } from './openrouter.js';

/**
 * Builds the provider from `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL` and
 * the DEC-17 data guarantee.
 *
 * Throws when the key is absent. Every caller runs inside `runEntry`, which
 * prints the message and exits 1 — the same line and the same exit code the
 * six hand-written preflights produced, from one place.
 *
 * `overrides` is for what a caller genuinely knows and the environment does
 * not: `load-docs` passes the embedding price it resolved from
 * `EMBEDDINGS_USD_PER_MTOK`, because DEC-25 accounting needs it and no other
 * caller embeds. It is applied last, so a caller can also override the base
 * URL in a test.
 *
 * It does not call `loadDotEnv` for you. An entry point loads `./.env` once
 * at the top of `main`, and a second load inside a helper would be a second
 * place that decides which file a process reads.
 */
export function openRouterFromEnv(
  overrides: Partial<OpenRouterConfig> = {},
): OpenRouterProvider {
  const apiKey = process.env['OPENROUTER_API_KEY'];
  if (apiKey === undefined || apiKey.trim().length === 0) {
    // The wording the six copies used, kept exactly, so an operator who has
    // searched for this line before still finds it.
    throw new Error('OPENROUTER_API_KEY is not set.');
  }
  const baseUrl = process.env['OPENROUTER_BASE_URL'];
  return new OpenRouterProvider({
    apiKey,
    // Spread rather than assigned: `exactOptionalPropertyTypes` is on, so a
    // present `baseUrl: undefined` is not the same as an absent key, and the
    // provider's own default only applies to the absent one.
    ...(baseUrl !== undefined && baseUrl.length > 0 ? { baseUrl } : {}),
    ...dataGuaranteeOption(),
    ...overrides,
  });
}
