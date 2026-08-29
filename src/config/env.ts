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
