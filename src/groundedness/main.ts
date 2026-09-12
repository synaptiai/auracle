// CLI for the groundedness fit. Run via:
//
//   pnpm run fit-groundedness
//
// Environment:
//   GROUNDEDNESS_MODEL_VER  required. The judge model the fit runs on.
//   GROUNDEDNESS_LIMIT      optional. A positive integer. Scores that many
//                           drafts instead of the whole half.
//   GROUNDEDNESS_RESUME     optional. The resume file, so an interrupted fit
//                           does not pay again for calls it already made.
//   GOLD_FIT_PATH           optional, with GOLD_REPORT_PATH. An adopter's own
//                           labelled halves, in place of the committed corpus.
//
// Needs OPENROUTER_API_KEY. One model call per claim, so a full fit half is
// roughly a thousand calls.
//
// Argv, printing and the exit code live here and nowhere else. `job.ts` holds
// the fit itself. Before the split they shared one file, and `scoring.ts`
// imported the scorer from it: importing the scorer loaded a command
// (issue #75).
//
// The job may refuse. Classes that do not separate produce a threshold any
// candidate would satisfy, and a refusal leaves section 6's caveat standing
// rather than replacing it with a number that measured nothing.
import { fileURLToPath } from 'node:url';

import { defaultGroundednessDir } from './artifact.js';
import { runGroundednessJob } from './job.js';
import { describeSpend } from './scoring.js';
import { loadDotEnv } from '../config/env.js';
import { runEntry } from '../cli/entry.js';
import { startedAsCommand } from '../corpus/output-path.js';
import { selectHalf } from '../fixtures/half-from-env.js';
import { openRouterFromEnv } from '../models/from-env.js';

async function main(): Promise<void> {
  loadDotEnv();
  const modelVer = process.env['GROUNDEDNESS_MODEL_VER'];
  if (!modelVer) {
    console.error('GROUNDEDNESS_MODEL_VER is not set.');
    process.exitCode = 1;
    return;
  }
  const rawLimit = process.env['GROUNDEDNESS_LIMIT'];
  const limit = rawLimit === undefined ? undefined : Number(rawLimit);
  if (rawLimit !== undefined && !(Number.isInteger(limit) && (limit as number) > 0)) {
    console.error(`GROUNDEDNESS_LIMIT must be a positive integer, got ${rawLimit}`);
    process.exitCode = 1;
    return;
  }

  const selected = selectHalf('fit');
  if (selected.half !== undefined) {
    console.log(
      `fit half: ${String(selected.path)} (${selected.half.count} cases, source ${selected.half.source})`,
    );
  }

  const { artifact } = await runGroundednessJob({
    provider: openRouterFromEnv(),
    modelVer,
    ...(selected.half === undefined ? {} : { fitHalf: selected.half }),
    ...(selected.counterpart === undefined ? {} : { reportIdentity: selected.counterpart }),
    resumeFile: process.env['GROUNDEDNESS_RESUME']
      ?? fileURLToPath(new URL('resume-fit.jsonl', defaultGroundednessDir())),
    ...(limit === undefined ? {} : { limit }),
  });
  console.log(
    `fitted coverage thresholds v${artifact.version} on ${artifact.fit_drafts} drafts `
      + `(${artifact.faulted_drafts} dropped unscored): `
      + `block ${artifact.block} (npv ${artifact.block_npv.toFixed(3)}), `
      + `review ${artifact.review} (precision ${artifact.review_precision.toFixed(3)}, `
      + `coverage ${artifact.review_coverage.toFixed(3)})`,
  );
  console.log(`  spend: ${describeSpend(artifact.cost_micros, artifact.cost_unknown)}`);
  for (const grade of artifact.by_grade) {
    console.log(`  ${grade.grade}: ${grade.drafts} drafts, mean coverage ${grade.mean_coverage.toFixed(3)}`);
  }
}

// The idiom the other entry points use. Without it this module runs on
// import, and the job it starts costs about a thousand model calls.
if (startedAsCommand(import.meta.url, process.argv[1])) {
  void runEntry(main);
}
