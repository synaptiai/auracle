// The offline gold report job (method 2, section 4.10, DEC-31).
//
// Scores the system on the REPORT half of the gold set only and writes the
// README numbers as a versioned artifact. The fit half's CASES are never read
// here. On the committed corpus this module opens the report half alone. On a
// real half it also opens the fit file, to prove the two disjoint (DEC-31) —
// but only through readHalfIdentity, which returns identifiers and whose type
// has no field that could carry a subject or a body. So a case-level leak
// still needs a code change and not an accident. Fitting happened upstream —
// the calibration job fits the threshold on the fit half — so every number
// this job publishes comes from cases no threshold ever saw (DEC-31).
//
// DEC-32 holds at scoring time too: each ticket is compared against its
// observable disposition (`escalated`), never against a gold intent label.
//
// Offline and on demand. Section 4.10 sets no cadence; rerun after a gate or
// model change that should move a published number.

import { classifyTicket } from '../classifier/classifier.js';
import { loadDotEnv } from '../config/env.js';
import {
  GOLD_SOURCES,
  REPORT_COUNT,
  assertHalvesDisjoint,
  goldCaseText,
  halfDigest,
  identityOf,
  isFirstTurn,
  loadGoldHalf,
  loadTaxonomy,
} from '../fixtures/load.js';
import { selectHalf } from '../fixtures/half-from-env.js';
import type { GoldFile, HalfIdentity } from '../fixtures/load.js';
import type { ModelProvider } from '../models/provider.js';
import { SEED_THRESHOLDS, evaluatePolicy } from '../policy/policy.js';
import type { AdapterCapabilities, ActionClass, GateThresholds, RiskTier } from '../policy/policy.js';
import { resolveThresholds } from '../calibration/resolve.js';
import type { CoverageProvenance, ThresholdProvenance } from '../calibration/resolve.js';
import {
  defaultGoldReportDir,
  assertGoldReportDirUsable,
  nextVersion,
  validateGoldReportArtifact,
  writeGoldReportArtifact,
} from './artifact.js';
import type { GoldReportArtifact } from './artifact.js';
import { aggregateReport } from './score.js';
import { startedAsCommand } from '../corpus/output-path.js';

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
  /**
   * The gate numbers this run applies, and where they came from. Defaults to
   * the documented seeds, which the artifact then records as such.
   */
  thresholds?: GateThresholds;
  provenance?: ThresholdProvenance;
  /**
   * Where the two coverage numbers came from. A separate option from
   * `provenance` above, and never merged with it: the artifact must let a
   * reader say which gate was fitted and which was seeded (DEC-05).
   */
  coverageProvenance?: CoverageProvenance;
  /**
   * Identifiers of the fit half, for the DEC-31 proof. Required when the
   * report half is not the shipped corpus; this job never opens the fit
   * half's cases.
   */
  fitIdentity?: HalfIdentity;
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

/**
 * The coverage half of the threshold record (DEC-05, section 4.7).
 *
 * Listed explicitly rather than derived from Object.keys: an optional field
 * added to GateThresholds later would be absent from SEED_THRESHOLDS, so a
 * derived list would silently stop covering it. The type below fails to
 * compile if a non-agreement field appears and is not named here.
 */
const COVERAGE_FIELDS = ['groundednessBlock', 'groundednessReview'] as const;

/**
 * The agreement half. `perIntent` joins it rather than the coverage list:
 * DEC-41 fits a threshold for each intent on the agreement gate alone, and
 * DEC-05 keeps the two gates independent, so a coverage rule must never read
 * it. Naming it here is the classification the guard below demands.
 */
type AgreementField = 'agreement' | 'perIntent';

type UncoveredThreshold = Exclude<
  keyof GateThresholds,
  AgreementField | (typeof COVERAGE_FIELDS)[number]
>;
// A new gate field must join COVERAGE_FIELDS or this alias stops being never.
const _everyThresholdIsChecked: UncoveredThreshold extends never ? true : never = true;
void _everyThresholdIsChecked;

/** Routing writes the queue field on the ticket; the write is never customer-visible. */
const ROUTING_ACTION: ActionClass = { isWrite: true, isCustomerVisible: false, isIrreversible: false };

/**
 * Run one gold report pass over the report half only.
 *
 * DEC-31 discipline, enforced in order:
 * 1. only the report half enters this function (the CLI loads report.json
 *    alone);
 * 2. the injected half must declare split 'report' and a provenance in the
 *    closed set. The committed corpus must carry exactly REPORT_COUNT
 *    tickets; any other half must instead carry the fit half's identifiers,
 *    and the two are proved disjoint;
 * 3. the artifact records split_used 'report', and the loader refuses any
 *    other value;
 * 4. DEC-39: only first turns are scored, and the artifact records that
 *    scope so a reader knows what population the number covers.
 */
export async function runGoldReportJob(
  options: GoldReportRunOptions,
): Promise<GoldReportRunResult> {
  const taxonomy = options.taxonomy ?? loadTaxonomy();
  const thresholds = options.thresholds ?? SEED_THRESHOLDS;
  const provenance: ThresholdProvenance = options.provenance ?? { source: 'seed' };
  // `thresholds` and `provenance` arrive as two independent options, so a
  // caller can pass a fitted number and no provenance. The artifact would
  // then publish a fitted gate labelled as the seed, past a validator whose
  // whole purpose is to keep the two apart (DEC-31).
  if (provenance.source === 'seed' && thresholds.agreement !== SEED_THRESHOLDS.agreement) {
    throw new Error(
      `gold report was given agreement ${thresholds.agreement} with no calibration provenance; `
        + `a seeded run publishes the section 4.5 seed ${SEED_THRESHOLDS.agreement}`,
    );
  }
  // The coverage pair gets the same treatment as the agreement number, and
  // gets it separately (DEC-05). A moved value is legitimate now that a job
  // fits one; what must never happen is a moved value the artifact does not
  // name. An earlier version refused every moved pair outright, because the
  // artifact recorded no coverage field at all. That refusal outlived its
  // reason: once the resolver read a fitted pair, `pnpm run gold-report`
  // stopped working on any machine holding a fit — including the machine that
  // has to regenerate the published numbers.
  const coverageProvenance: CoverageProvenance = options.coverageProvenance ?? { source: 'seed' };
  const movedCoverage = COVERAGE_FIELDS.filter(
    (field) => thresholds[field] !== SEED_THRESHOLDS[field],
  );
  if (coverageProvenance.source === 'seed' && movedCoverage.length > 0) {
    throw new Error(
      `gold report was given non-seed ${movedCoverage.join(' and ')} with no coverage `
        + 'provenance; a seeded run publishes the section 4.7 seeds '
        + `${SEED_THRESHOLDS.groundednessBlock} and ${SEED_THRESHOLDS.groundednessReview} `
        + '(DEC-05)',
    );
  }
  const reportHalf = options.reportHalf ?? loadGoldHalf('report');
  // DEC-39: replay scores first turns only. A later turn's disposition
  // reflects the whole conversation, not the decision being scored. The
  // committed report half holds 4100 cases and 3128 first turns, so `scope`
  // and `report_tickets` below are what a reader must go by.
  const firstTurns = reportHalf.tickets.filter(isFirstTurn);
  const promptVer = options.promptVer ?? DEFAULT_PROMPT_VER;
  const modelVer = options.modelVer;
  if (modelVer === undefined || modelVer.length === 0) {
    throw new Error('runGoldReportJob needs a pinned modelVer (DEC-26)');
  }

  assertReportHalf(reportHalf, options.fitIdentity);

  // Before the loop, not after it. The loop makes CLASSIFIER_K model calls
  // per report ticket, and the previous pass moved this check ahead of the
  // spend for calibration alone while its own documentation claimed all three
  // jobs did it. A gold-report directory is gitignored output that collects
  // operator files, so a stray 'v5 copy.json' cost the whole scoring run.
  const dir = options.artifactDir ?? defaultGoldReportDir();
  await assertGoldReportDirUsable(dir);

  const scores = [];
  // The published half records its attrition for the same reason the fit half
  // does. A truncated sample lowers agreement without being a judgement, and
  // a published number that was depressed that way must say so. The shipped
  // report scores through the offline stub, which cannot truncate, so this is
  // zero here and meaningful for an adopter scoring against a real model.
  let unreadableSamples = 0;
  for (const ticket of firstTurns) {
    const classification = await classifyTicket(options.provider, {
      taxonomy,
      ticketText: goldCaseText(ticket),
      promptVer,
      modelVer,
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    });
    unreadableSamples += classification.unreadableSamples;
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
      // DEC-41, as the coordinator does. A published number must come from
      // the gate the system runs, not from a narrower one.
      intent: classification.intentId,
      agreement: classification.agreement,
      groundedness: ROUTING_GROUNDEDNESS,
      thresholds,
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

  const version = await nextVersion(dir);
  const artifact = validateGoldReportArtifact({
    artifact: 'gold-report',
    version,
    generated_at: new Date().toISOString(),
    method: 'human-review',
    scored_by: scorerOf(options.provider),
    gold_source: reportHalf.source,
    split_used: 'report',
    scope: 'first_turn',
    report_tickets: firstTurns.length,
    unreadable_samples: unreadableSamples,
    prompt_ver: promptVer,
    model_ver: modelVer,
    gate_agreement: thresholds.agreement,
    gate_source: provenance.source === 'calibration' ? 'calibration' : 'seed',
    gate_calibration_version:
      provenance.source === 'calibration' ? provenance.version : null,
    gate_calibration_scope:
      provenance.source === 'calibration' ? provenance.scope : null,
    gate_calibration_gold_source:
      provenance.source === 'calibration' ? provenance.goldSource : null,
    // The coverage half of the record, built from its own provenance alone.
    // Nothing here reads `provenance` and nothing above reads this one.
    coverage_block: thresholds.groundednessBlock,
    coverage_review: thresholds.groundednessReview,
    coverage_source: coverageProvenance.source,
    coverage_fit_version:
      coverageProvenance.source === 'groundedness' ? coverageProvenance.version : null,
    coverage_fit_gold_source:
      coverageProvenance.source === 'groundedness' ? coverageProvenance.goldSource : null,
    report_half_digest:
      options.fitIdentity === undefined ? null : halfDigest(identityOf(reportHalf)),
    fit_half_digest: options.fitIdentity === undefined ? null : halfDigest(options.fitIdentity),
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

/**
 * Refuse a half this job must not publish from.
 *
 * The size rule describes the corpus this repository generates and publishes
 * every number from. An adopter publishing on their own labelled history
 * gets whatever size their sample gave them, and names the fit half's
 * identifiers so the split is proved. This job never opens the fit half's
 * cases, mirroring the guarantee the fitting jobs keep in the other
 * direction.
 */
function assertReportHalf(half: GoldFile, fitIdentity: HalfIdentity | undefined): void {
  // The production loader cross-checks these; the injection path must not
  // trust a declared count that disagrees with the array it will score.
  if (half.count !== half.tickets.length) {
    throw new Error(
      `report half declares ${half.count} tickets but carries ${half.tickets.length}`,
    );
  }
  // The loader checks this, and the injection path does not go through the
  // loader. A provenance nothing understands must not reach an artifact that
  // states it (DEC-18).
  if (!(GOLD_SOURCES as readonly string[]).includes(half.source)) {
    throw new Error(
      `gold report half declares source ${String(half.source)}, `
        + `expected one of ${GOLD_SOURCES.join(', ')} (DEC-18)`,
    );
  }
  if (half.split !== 'report') {
    throw new Error(
      `gold report consumes the report half only, got split '${half.split}' (DEC-31)`,
    );
  }
  if (half.source === 'synthetic') {
    // The committed corpus holds exactly REPORT_COUNT report tickets (DEC-31).
    // Fitting happens on the other half; publishing happens here and nowhere else.
    if (half.count !== REPORT_COUNT) {
      throw new Error(`report half holds ${half.count} tickets, expected ${REPORT_COUNT}`);
    }
  } else if (fitIdentity === undefined) {
    throw new Error(
      `a report half of source '${half.source}' needs the fit half's identifiers to prove `
        + 'the two are disjoint; the gold report never opens the fit half itself (DEC-31)',
    );
  }
  // Unconditional: see the note on the same check in calibration/run.ts. A
  // half read by path carries no cross-half guarantee, whatever it declares.
  if (fitIdentity !== undefined) {
    assertHalvesDisjoint(identityOf(half), fitIdentity);
  }
}

// CLI entry: `pnpm run gold-report` executes dist/goldreport/run.js over the
// committed fixture corpus with the offline stub model. No network, no
// database, no API key (DEC-18).
//
// GOLD_REPORT_PATH publishes from a labelled half held outside the
// repository instead; GOLD_FIT_PATH must then name the other half, whose
// identifiers alone prove the two disjoint (DEC-31). The artifact goes to
// stdout, so every progress line here goes to stderr.
//
// Reproducible from a clean checkout, which carries no calibration artifact:
// the run then scores through the documented seeds and the artifact records
// `gate_source: 'seed'`. It is NOT reproducible across machines that hold
// different artifacts, because the gate a number was scored through is part
// of that number. The artifact names its gate for exactly this reason, and
// `calibration/` is ignored so no fit travels with the repository.
async function main(): Promise<void> {
  loadDotEnv();
  const { ReplayStubProvider } = await import('../replay/fake-model.js');
  // The published numbers depend on the gate they were scored through, so the
  // job reads the same artifact the runtime reads and records which one.
  // stdout carries the artifact and nothing else, so the resolver's startup
  // line goes to stderr like every other progress line here. Its default sink
  // is stdout, which put a JSON object in front of the artifact and made the
  // command's output unparseable.
  const { thresholds, provenance, coverageProvenance } = await resolveThresholds({
    log: (entry) => { console.error(JSON.stringify(entry)); },
  });
  const selected = selectHalf('report');
  if (selected.half !== undefined) {
    console.error(
      `report half: ${String(selected.path)} (${selected.half.count} cases, `
        + `source ${selected.half.source})`,
    );
  }
  const { artifact } = await runGoldReportJob({
    provider: new ReplayStubProvider(),
    promptVer: 'classify-p1',
    modelVer: STUB_MODEL_VER,
    thresholds,
    provenance,
    coverageProvenance,
    ...(selected.half === undefined ? {} : { reportHalf: selected.half }),
    ...(selected.counterpart === undefined ? {} : { fitIdentity: selected.counterpart }),
  });
  console.log(JSON.stringify(artifact, null, 2));
}

const invokedDirectly =
  startedAsCommand(import.meta.url, process.argv[1]);

if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
