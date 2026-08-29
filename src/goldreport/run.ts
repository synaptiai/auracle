// The offline gold report job (method 2, section 4.10, DEC-31).
//
// Scores the system on the REPORT half of the gold set only and writes the
// README numbers as a versioned artifact. The fit half is never read here:
// this module imports loadGoldHalf('report'), not loadGoldSet, so a fit-half
// leak needs a code change, not an accident. Fitting happened upstream — the
// calibration job fits the threshold on the fit half — so every number this
// job publishes comes from cases no threshold ever saw (DEC-31).
//
// DEC-32 holds at scoring time too: each ticket is compared against its
// observable disposition (`escalated`), never against a gold intent label.
//
// Offline and on demand. Section 4.10 sets no cadence; rerun after a gate or
// model change that should move a published number.

import { classifyTicket } from '../classifier/classifier.js';
import { loadDotEnv } from '../config/env.js';
import { REPORT_COUNT, goldCaseText, isFirstTurn, loadGoldHalf, loadTaxonomy } from '../fixtures/load.js';
import type { GoldFile } from '../fixtures/load.js';
import type { ModelProvider } from '../models/provider.js';
import { GATE_AGREEMENT, evaluatePolicy } from '../policy/policy.js';
import type { AdapterCapabilities, ActionClass, RiskTier } from '../policy/policy.js';
import { pathToFileURL } from 'node:url';
import {
  defaultGoldReportDir,
  nextVersion,
  validateGoldReportArtifact,
  writeGoldReportArtifact,
} from './artifact.js';
import type { GoldReportArtifact } from './artifact.js';
import { aggregateReport } from './score.js';

/**
 * The report needs the risk tier per intent; the classifier's own taxonomy
 * view drops it. Structurally satisfied by fixtures/load.ts `Taxonomy`.
 */
export interface GoldReportTaxonomy {
  intents: readonly { id: string; label: string; risk_tier: RiskTier }[];
}

export interface GoldReportRunOptions {
  provider: ModelProvider;
  /** Defaults to the committed taxonomy fixture. */
  taxonomy?: GoldReportTaxonomy;
  /**
   * Defaults to fixtures/gold/report.json. Injectable for tests. The runner
   * asserts the injected half really is the report split (DEC-31).
   */
  reportHalf?: GoldFile;
  promptVer?: string;
  modelVer?: string;
  temperature?: number;
  /** Artifact directory override (tests). */
  artifactDir?: URL;
}

const DEFAULT_PROMPT_VER = 'classify-p1';

export interface GoldReportRunResult {
  artifact: GoldReportArtifact;
}

/**
 * A routing decision makes no textual claim, so groundedness coverage has
 * nothing to cover; the gate passes at 1.0 (same reasoning as the replay).
 */
const ROUTING_GROUNDEDNESS = 1.0;

/** Replay assumes a fully capable adapter; capability gating is not under test here (DEC-06). */
const FULL_CAPABILITIES: AdapterCapabilities = {
  supportsIdempotencyKey: true,
  supportsReadBack: true,
  supportsDraftState: true,
  supportsStructuredFields: true,
  supportsThreading: true,
};

/** The model version the offline stub reports (src/replay/fake-model.ts). */
const STUB_MODEL_VER = 'replay-stub';

/**
 * Names the scorer for the artifact, which `method` does not.
 *
 * Section 4.10 calls method 2 "human review", so `method` names a slot and
 * cannot say who graded.
 *
 * Read from the provider, never from the pin. `provider` and `modelVer` are
 * independent options, so deriving this from the requested version let a stub
 * emit `scored_by: 'model'` — the exact false claim the field exists to stop.
 * A provider that declares nothing is a real one; only the stub says so.
 */
function scorerOf(provider: ModelProvider): 'stub' | 'model' {
  return provider.kind ?? 'model';
}

/** Routing writes the queue field on the ticket; the write is never customer-visible. */
const ROUTING_ACTION: ActionClass = { isWrite: true, isCustomerVisible: false, isIrreversible: false };

/**
 * Run one gold report pass over the report half only.
 *
 * DEC-31 discipline, enforced in order:
 * 1. only the report half enters this function (the CLI loads report.json
 *    alone);
 * 2. the injected half must declare split 'report' and source 'synthetic'
 *    and carry exactly REPORT_COUNT tickets;
 * 3. the artifact records split_used 'report', and the loader refuses any
 *    other value;
 * 4. DEC-39: only first turns are scored, and the artifact records that
 *    scope so a reader knows what population the number covers.
 */
export async function runGoldReportJob(
  options: GoldReportRunOptions,
): Promise<GoldReportRunResult> {
  const taxonomy = options.taxonomy ?? loadTaxonomy();
  const reportHalf = options.reportHalf ?? loadGoldHalf('report');
  // DEC-39: replay scores first turns only. A later turn's disposition
  // reflects the whole conversation, not the decision being scored. The
  // committed report half holds 385 cases and 287 first turns, so `scope`
  // and `report_tickets` below are what a reader must go by.
  const firstTurns = reportHalf.tickets.filter(isFirstTurn);
  const promptVer = options.promptVer ?? DEFAULT_PROMPT_VER;
  const modelVer = options.modelVer;
  if (modelVer === undefined || modelVer.length === 0) {
    throw new Error('runGoldReportJob needs a pinned modelVer (DEC-26)');
  }

  assertReportHalf(reportHalf);

  const scores = [];
  for (const ticket of firstTurns) {
    const classification = await classifyTicket(options.provider, {
      taxonomy,
      ticketText: goldCaseText(ticket),
      promptVer,
      modelVer,
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    });
    const tier = taxonomy.intents.find(
      (intent) => intent.id === classification.intentId,
    )?.risk_tier;
    if (!tier) {
      throw new Error(
        `classified intent ${classification.intentId} is absent from the taxonomy`,
      );
    }
    const decision = evaluatePolicy({
      riskTier: tier,
      agreement: classification.agreement,
      groundedness: ROUTING_GROUNDEDNESS,
      capabilities: FULL_CAPABILITIES,
      action: ROUTING_ACTION,
    });
    scores.push({
      ticketId: ticket.ticket_id,
      riskTier: tier,
      decision,
      observedEscalated: ticket.disposition.escalated,
    });
  }

  const metrics = aggregateReport(scores);

  const dir = options.artifactDir ?? defaultGoldReportDir();
  const version = await nextVersion(dir);
  const artifact = validateGoldReportArtifact({
    artifact: 'gold-report',
    version,
    generated_at: new Date().toISOString(),
    method: 'human-review',
    scored_by: scorerOf(options.provider),
    gold_source: 'synthetic',
    split_used: 'report',
    scope: 'first_turn',
    report_tickets: firstTurns.length,
    prompt_ver: promptVer,
    model_ver: modelVer,
    gate_agreement: GATE_AGREEMENT,
    action_match: metrics.actionMatch,
    containment: metrics.containment,
    strata: metrics.strata.map((stratum) => ({
      risk_tier: stratum.riskTier,
      tickets: stratum.tickets,
      action_match: stratum.actionMatch,
      containment: stratum.containment,
      publishable: false,
    })),
  });
  await writeGoldReportArtifact(artifact, dir);
  return { artifact };
}

function assertReportHalf(half: GoldFile): void {
  // The production loader cross-checks these; the injection path must not
  // trust a declared count that disagrees with the array it will score.
  if (half.count !== half.tickets.length) {
    throw new Error(
      `report half declares ${half.count} tickets but carries ${half.tickets.length}`,
    );
  }
  if (half.split !== 'report') {
    throw new Error(
      `gold report consumes the report half only, got split '${half.split}' (DEC-31)`,
    );
  }
  if (half.source !== 'synthetic') {
    throw new Error('gold report runs on synthetic gold data only (DEC-18)');
  }
  // The committed corpus holds exactly 385 report tickets (DEC-31). Fitting
  // happens on the other 385; publishing happens here and nowhere else.
  if (half.count !== REPORT_COUNT) {
    throw new Error(`report half holds ${half.count} tickets, expected ${REPORT_COUNT}`);
  }
}

// CLI entry: `pnpm run gold-report` executes dist/goldreport/run.js over the
// committed fixture corpus with the offline stub model. No network, no
// database, no API key: deterministic and byte-for-byte reproducible (DEC-18).
async function main(): Promise<void> {
  loadDotEnv();
  const { ReplayStubProvider } = await import('../replay/fake-model.js');
  const { artifact } = await runGoldReportJob({
    provider: new ReplayStubProvider(),
    promptVer: 'classify-p1',
    modelVer: STUB_MODEL_VER,
  });
  console.log(JSON.stringify(artifact, null, 2));
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
