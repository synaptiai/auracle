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

import { conversationHistories, loadGoldSet, loadTaxonomy } from '../fixtures/load.js';
import type { GoldFile } from '../fixtures/load.js';
import { StubTriageJudge } from './select.js';
import type { CaseOrigin, TriageCase, TriageJudge } from './select.js';
import {
  defaultTriageDir,
  assertTriageDirUsable,
  nextVersion,
  validateTriageArtifact,
  writeTriageArtifact,
} from './artifact.js';
import type { TriageArtifact } from './artifact.js';
import { label } from '../fixtures/load.js';
import type { GoldSource } from '../fixtures/load.js';
import { startedAsCommand } from '../corpus/output-path.js';

export interface TriageRunOptions {
  /** Defaults to the deterministic offline stub judge over the fixture taxonomy. */
  judge?: TriageJudge;
  /**
   * Cases to triage. Defaults to both halves of the synthetic gold set
   * (770 cases). Inject live traffic here once it exists; the origin field
   * records where each case came from.
   */
  cases?: readonly TriageCase[];
  /**
   * Where the injected cases came from. Required with `cases`, because only
   * the caller knows: the default gold set is synthetic and says so.
   */
  goldSource?: GoldSource;
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

function halfToCases(half: GoldFile, origin: CaseOrigin): TriageCase[] {
  const histories = conversationHistories(half.tickets);
  return half.tickets.map((ticket) => ({
    ticketId: ticket.ticket_id,
    origin,
    subject: ticket.subject,
    body: ticket.body,
    history: histories.get(ticket.ticket_id) ?? [],
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
  // Injected cases carry no provenance of their own, and the default set is
  // the synthetic corpus. A caller that injects must SAY which it is: the
  // earlier default of 'real' let a caller injecting synthetic-derived cases
  // publish an artifact falsely claiming real provenance, and the doc above
  // called the field required while the code quietly filled it in.
  if (options.cases !== undefined && options.goldSource === undefined) {
    throw new Error(
      'runTriageJob needs goldSource with injected cases: only the caller knows '
        + 'where they came from, and the artifact states it (DEC-18)',
    );
  }
  const goldSource: GoldSource = options.goldSource ?? 'synthetic';
  if (cases.length === 0) {
    throw new Error('triage received no cases');
  }

  // Before the loop, not after it: the judge reviews every gold case, and a
  // stray file in the output directory used to throw that work away.
  const dir = options.artifactDir ?? defaultTriageDir();
  await assertTriageDirUsable(dir);

  const selections: TriageArtifact['selections'] = [];
  for (const testCase of cases) {
    const verdict = await judge.review(testCase);
    if (!verdict.selected) continue;
    if (verdict.reason.length === 0) {
      throw new Error(`judge selected ${label(testCase.ticketId, goldSource)} without a reason`);
    }
    selections.push({
      ticket_id: testCase.ticketId,
      origin: testCase.origin,
      reason: verdict.reason,
    });
  }

  const version = await nextVersion(dir);
  const artifact = validateTriageArtifact({
    artifact: 'judge-triage',
    version,
    generated_at: new Date().toISOString(),
    method: 'judge-triage',
    role: 'selection',
    gold_source: goldSource,
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

// CLI entry: `pnpm run triage` executes dist/triage/run.js over the committed
// fixture corpus with the offline stub judge. No network, no database, no API
// key: deterministic and byte-for-byte reproducible (DEC-18).
async function main(): Promise<void> {
  const { artifact } = await runTriageJob();
  console.log(summariseForStdout(artifact));
}

/**
 * What the command prints.
 *
 * `selections` carries a case id and a model-written reason. On the shipped
 * corpus both are synthetic and the full artifact is the useful output. A run
 * over real cases would put a customer's identifier and a sentence about
 * their problem into a terminal and a CI log, which DEC-18 forbids — and the
 * artifact is on disk under the gitignored `triage/` either way.
 */
export function summariseForStdout(artifact: TriageArtifact): string {
  if (artifact.gold_source === 'synthetic') return JSON.stringify(artifact, null, 2);
  return JSON.stringify(
    {
      artifact: artifact.artifact,
      version: artifact.version,
      gold_source: artifact.gold_source,
      cases_reviewed: artifact.cases_reviewed,
      cases_selected: artifact.cases_selected,
      selections: `withheld: ${String(artifact.selections.length)} selection(s) name real cases (DEC-18)`,
    },
    null,
    2,
  );
}

const invokedDirectly =
  startedAsCommand(import.meta.url, process.argv[1]);

if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
