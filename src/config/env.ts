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
