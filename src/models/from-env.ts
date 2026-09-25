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
 * `EMBEDDINGS_USD_PER_MTOK`, for a gateway whose embedding answer carries no
 * cost (DEC-25). Every other caller gets `EMBEDDINGS_USD_PER_MTOK` through
 * `embeddingPriceFromEnv()`, applied here: OpenRouter reports the cost of an
 * embedding call itself, and the variable serves any other gateway. Overrides
 * are applied last, so a caller can also override the base URL in a test.
 *
 * It does not call `loadDotEnv` for you. An entry point loads `./.env` once
 * at the top of `main`, and a second load inside a helper would be a second
 * place that decides which file a process reads.
 */
export function openRouterFromEnv(
  overrides: Partial<OpenRouterConfig> = {},
): OpenRouterProvider {
  const rawKey = process.env['OPENROUTER_API_KEY'];
  if (rawKey === undefined || rawKey.trim().length === 0) {
    // The wording the six copies used, kept exactly, so an operator who has
    // searched for this line before still finds it.
    throw new Error('OPENROUTER_API_KEY is not set.');
  }
  // Trimmed: a key read from a secret file often ends in a newline. fetch
  // trims the header it sends, so a gateway echoes the trimmed key, and the
  // error scrub must look for the key as it was sent.
  const apiKey = rawKey.trim();
  // A control character inside the key cannot be sent in a header, and
  // fetch's refusal quotes the header whole. Refused here, without the key.
  if ([...apiKey].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)) {
    throw new Error('OPENROUTER_API_KEY holds a control character, such as a line break inside it. Set it to the key alone.');
  }
  const baseUrl = process.env['OPENROUTER_BASE_URL'];
  if (baseUrl !== undefined && baseUrl.length > 0) refuseCredentialsInUrl(baseUrl);
  return new OpenRouterProvider({
    apiKey,
    // Spread rather than assigned: `exactOptionalPropertyTypes` is on, so a
    // present `baseUrl: undefined` is not the same as an absent key, and the
    // provider's own default only applies to the absent one.
    ...(baseUrl !== undefined && baseUrl.length > 0 ? { baseUrl } : {}),
    ...dataGuaranteeOption(),
    // After the key check, so a missing key stays the first error an
    // operator reads. Every process that embeds reads the price this way.
    ...embeddingPriceFromEnv(),
    ...overrides,
  });
}

/**
 * Refuses a base URL that carries a user name or a password. fetch refuses
 * such a URL with an error that quotes it whole, and that error would reach
 * the ledger and the log with the password in it.
 */
function refuseCredentialsInUrl(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error('OPENROUTER_BASE_URL is not a URL.');
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new Error(
      'OPENROUTER_BASE_URL carries credentials. Remove them from the URL: the provider sends OPENROUTER_API_KEY in a header.',
    );
  }
}

/**
 * The embedding price an adopter set in `EMBEDDINGS_USD_PER_MTOK`, as a
 * provider override, or no override when it is unset or blank. For a gateway
 * whose embedding answer carries no cost (DEC-25): the provider then refuses
 * the answer and names this variable. `openRouterFromEnv` applies it, and
 * `load-docs` reads it here too, so the variable has one reading.
 *
 * Throws on a value that is not a finite number of zero or more, so a
 * mistyped price never records a cost of nothing.
 */
export function embeddingPriceFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Pick<OpenRouterConfig, 'embeddingsUsdPerMTok'> | Record<string, never> {
  const raw = env['EMBEDDINGS_USD_PER_MTOK'];
  if (raw === undefined || raw.trim().length === 0) return {};
  const price = Number(raw);
  if (!Number.isFinite(price) || price < 0) {
    throw new Error(`EMBEDDINGS_USD_PER_MTOK must be a number of zero or more, got "${raw}"`);
  }
  return { embeddingsUsdPerMTok: price };
}
