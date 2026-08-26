// The judge-triage job (method 3, section 4.10, DEC-09).
//
// A model selects which cases go to a person for review and records every
// selection with its provenance. It never gives a published number: DEC-09
// rejects the judge as the primary score because a judge shares the failure
// modes of the system it tests. The manifest this job writes carries counts
// and reasons only — no rate, interval or accuracy field survives validation
// (see src/triage/artifact.ts).
//
// Offline and on demand. Section 4.10 is explicit that method 3 earns its
// keep once real volume exists to triage; on the synthetic 770-case gold set
// this run is a demonstration of the mechanism, not a tool.

import { loadGoldSet, loadTaxonomy } from '../fixtures/load.js';
import { StubTriageJudge } from './select.js';
import type { CaseOrigin, TriageCase, TriageJudge } from './select.js';
import {
  defaultTriageDir,
  nextVersion,
  validateTriageArtifact,
  writeTriageArtifact,
} from './artifact.js';
import type { TriageArtifact } from './artifact.js';
import { pathToFileURL } from 'node:url';

export interface TriageRunOptions {
  /** Defaults to the deterministic offline stub judge over the fixture taxonomy. */
  judge?: TriageJudge;
  /**
   * Cases to triage. Defaults to both halves of the synthetic gold set
   * (770 cases). Inject live traffic here once it exists; the origin field
   * records where each case came from.
   */
  cases?: readonly TriageCase[];
  /** DEC-26 pins; default to the stub judge's pins when the stub runs. */
  prompt_ver?: string;
  model_ver?: string;
  /** Artifact directory override (tests). */
  artifactDir?: URL;
}

export interface TriageRunResult {
  artifact: TriageArtifact;
}

/** Load the default case source: both halves of the synthetic gold set. */
export function goldSetCases(): TriageCase[] {
  const gold = loadGoldSet();
  return [...halfToCases(gold.fit, 'fit'), ...halfToCases(gold.report, 'report')];
}

function halfToCases(
  half: { tickets: readonly { ticket_id: string; subject: string; body: string }[] },
  origin: CaseOrigin,
): TriageCase[] {
  return half.tickets.map((ticket) => ({
    ticketId: ticket.ticket_id,
    origin,
    subject: ticket.subject,
    body: ticket.body,
  }));
}

/**
 * Run one triage pass. Every reviewed case gets a verdict; selected cases
 * land in the manifest with their reason. Unselected cases are dropped —
 * the review queue needs the shortlist, not the long list.
 */
export async function runTriageJob(options: TriageRunOptions = {}): Promise<TriageRunResult> {
  const judge =
    options.judge ??
    new StubTriageJudge(
      new Map(loadTaxonomy().intents.map((intent) => [intent.id, intent.risk_tier])),
    );
  const cases = options.cases ?? goldSetCases();
  if (cases.length === 0) {
    throw new Error('triage received no cases');
  }

  const selections: TriageArtifact['selections'] = [];
  for (const testCase of cases) {
    const verdict = await judge.review(testCase);
    if (!verdict.selected) continue;
    if (verdict.reason.length === 0) {
      throw new Error(`judge selected ${testCase.ticketId} without a reason`);
    }
    selections.push({
      ticket_id: testCase.ticketId,
      origin: testCase.origin,
      reason: verdict.reason,
    });
  }

  const dir = options.artifactDir ?? defaultTriageDir();
  const version = await nextVersion(dir);
  const artifact = validateTriageArtifact({
    artifact: 'judge-triage',
    version,
    generated_at: new Date().toISOString(),
    method: 'judge-triage',
    role: 'selection',
    gold_source: 'synthetic',
    cases_reviewed: cases.length,
    cases_selected: selections.length,
    prompt_ver: options.prompt_ver ?? defaultPins(judge).prompt_ver,
    model_ver: options.model_ver ?? defaultPins(judge).model_ver,
    selections,
  });
  await writeTriageArtifact(artifact, dir);
  return { artifact };
}

function defaultPins(judge: TriageJudge): { prompt_ver: string; model_ver: string } {
  // Only the offline stub knows its own pins; any other judge needs the
  // caller to pin prompt and model versions (DEC-26).
  if ('pins' in judge) {
    return judge.pins as { prompt_ver: string; model_ver: string };
  }
  throw new Error('runTriageJob needs pinned prompt_ver and model_ver (DEC-26)');
}

// CLI entry: `npm run triage` executes dist/triage/run.js over the committed
// fixture corpus with the offline stub judge. No network, no database, no API
// key: deterministic and byte-for-byte reproducible (DEC-18).
async function main(): Promise<void> {
  const { artifact } = await runTriageJob();
  console.log(JSON.stringify(artifact, null, 2));
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
