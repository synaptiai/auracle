/**
 * Replay CLI (section 4.10, DEC-09, DEC-20, DEC-31, DEC-32).
 *
 * Runs the action-match replay over the committed synthetic fixture corpus
 * with the offline stub model and prints the report as JSON on stdout.
 * No network, no database: the fixture corpus is the entire input (DEC-18).
 *
 * Run via `pnpm run replay` (executes the built dist/replay/cli.js).
 */

import { loadGoldSet, loadTaxonomy } from '../fixtures/load.js';
import { loadDotEnv } from '../config/env.js';
import { ReplayStubProvider } from './fake-model.js';
import { runReplay } from './replay.js';

const PINS = { promptVer: 'classify-p1', modelVer: 'replay-stub' };

async function main(): Promise<void> {
  loadDotEnv();
  const taxonomy = loadTaxonomy();
  const gold = loadGoldSet();
  const report = await runReplay({
    provider: new ReplayStubProvider(),
    taxonomy,
    pins: PINS,
    fit: gold.fit,
    report: gold.report,
  });
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
