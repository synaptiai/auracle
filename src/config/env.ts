// Runtime configuration loading for every CLI/daemon entrypoint. Uses Node's
// native process.loadEnvFile: no dependency, and an explicit shell env always
// wins over a .env value.
import { existsSync } from 'node:fs';

/**
 * Loads `./.env` into the environment when the file exists. Variables already
 * set in the shell are never overwritten (process.loadEnvFile semantics).
 */
export function loadDotEnv(file = '.env'): void {
  if (existsSync(file)) process.loadEnvFile(file);
}

/**
 * A required string from the environment, refusing a value that is not one.
 *
 * Whitespace counts as absent. A password that is one space is a typo, and
 * an operator reading `IMAP_PASS is required` finds it faster than an
 * authentication failure from the far end.
 *
 * The value is returned verbatim. It is neither trimmed nor refused for
 * surrounding whitespace, which is where this parts company with
 * `requireNonEmpty` in `src/adapters/types.ts`.
 *
 * That one trims, and it is right to: it validates action data already in
 * memory, and its callers normalize. This one carries credentials.
 * `IMAP_PASS` may legitimately end in a space, and `process.loadEnvFile`
 * keeps whitespace inside quotes, so an operator can write one deliberately.
 * Trimming would send the wrong credential and report nothing.
 *
 * Refusing such a value instead was tried and reverted: there is no spelling
 * that survives the check, so the refusal made a working password
 * unexpressible and the message named an escape hatch that does not exist.
 * A whitespace-only value is still absent, because no credential is one
 * space.
 */
export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

/**
 * A positive integer from the environment, or the fallback when it is unset.
 *
 * Four entry points parsed one of these for themselves with three different
 * empty-string rules. `PARTITION_COUNT=` was fatal for the consumer and a
 * silent 8 for the webhook, so two daemons that must agree on the partition
 * count under DEC-36 could disagree, and one partition then had two owners.
 *
 * The rule here is that an empty value is a fault, not an absence. It is
 * what an unsubstituted template leaves behind, and the cost is asymmetric:
 * a refused start is loud and harmless, while two daemons disagreeing about
 * partition ownership corrupts the ledger quietly.
 *
 * The digits are matched before they are parsed, because `Number` is far
 * wider than the set of things anyone means to write here. `Number('0x10')`
 * is 16, `Number('1e3')` is 1000 and `Number('8.0')` is 8, and every one of
 * the four parsers accepted all three — `PARTITION_COUNT=0x10` silently
 * meant sixteen. `src/coordinator/arrival-signal.ts` had already found this
 * in its notification payload and fixed it the same way.
 */
export function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (raw.length === 0) {
    throw new Error(
      `${name} is set but empty; unset it to use the default of ${fallback}`,
    );
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a positive integer, got '${raw}'`);
  }
  const value = Number.parseInt(raw, 10);
  if (value <= 0 || !Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a positive integer, got '${raw}'`);
  }
  return value;
}

/**
 * The DEC-17 data guarantee, read from the environment.
 *
 * DEC-17 requires the guarantee to be configurable and documented; its
 * rejected alternative is forcing zero-retention on every request, so absence
 * means off. No entrypoint wired it, which left every customer message —
 * including the conversation history of DEC-37 — going out with data
 * collection permitted and no way for an adopter to change it but to edit
 * source. `AURACLE_ZDR_ONLY=1` turns it on.
 *
 * Returns an empty object when unset, so a caller spreads it and adds no key.
 */
export function dataGuaranteeOption(): { dataGuarantee?: { zdrOnly: true } } {
  return process.env['AURACLE_ZDR_ONLY'] === '1' ? { dataGuarantee: { zdrOnly: true } } : {};
}

/**
 * The chat model every entrypoint pins when `MODEL_VER` is unset (DEC-26).
 *
 * One place, so the runbook can state it and a test can bind the two. The
 * previous default was retired by the provider, and nothing failed until an
 * operator's first model call did. This model reasons before it answers, and
 * the provider bills that reasoning against the answer budget, so a caller
 * that expects a short answer must still allow room for it.
 */
export const DEFAULT_CHAT_MODEL_VER = 'z-ai/glm-5.3-flash';
