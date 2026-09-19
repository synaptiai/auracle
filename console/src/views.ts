// What a ledger row and a journal step say on a page (issue #27).
//
// Its own module for the reason `hosts.ts` and `ledger-name.ts` have one:
// `main.ts` runs `main()` when it is imported, so nothing defined there can
// be reached from a test. These three decide what an operator reads about a
// run, which is not a thing to leave unasserted.
//
// They map and nothing else. No statement is issued here, and every value
// comes from a reader in the root package.
import { CLASSIFIER_K } from 'auracle/domain';
import type { JournalStep, RunJournal } from 'auracle/ledger-read';

import { escalationHead } from './render.js';
import type { PartitionLatency } from 'auracle/ledger-read';

import type {
  ClaimView, DocumentView, EvidenceView, RunDetail, RunRow, SentenceView,
} from './surfaces.js';

export function toRow(item: {
  runId: string; ticketId: string; state: string; promptVer: string;
  reason: string | null; gateReason: string | null; intentId: string | null;
  coverage: number | null; createdAt: Date | null;
  costMicros: number; stepsUsed: number;
  /**
   * DEC-47: the product of the channel this run's message arrived on. Null
   * is a channel the map does not name, and the queue says so in words.
   */
  product: string | null;
}): RunRow {
  return {
    runId: item.runId,
    ticketId: item.ticketId,
    state: item.state,
    promptVer: item.promptVer,
    // Trimmed here, at the one boundary every surface reads through, so no
    // surface can render the untrimmed value by forgetting to ask.
    reason: escalationHead(item.reason),
    // Untrimmed, because it is not free text. The gate writes one of a
    // closed set of rule names, and a head of it would be a truncated rule.
    gateReason: item.gateReason,
    intentId: item.intentId,
    gateCoverage: item.coverage,
    createdAt: item.createdAt,
    stepsUsed: item.stepsUsed,
    product: item.product,
  };
}

/**
 * A waiting run as the queue and the run detail read it.
 *
 * Both gate values come from the same statement as the row, each beside its
 * own line, so the queue can group on them without a journal read per row
 * (issue #101). Null stays null: zero agreement says the samples disagreed
 * completely, which is a measurement rather than its absence.
 */
export function toDetail(
  item: Parameters<typeof toRow>[0] & {
    draftExternalId: string | null; payloadRecorded: boolean;
    actionClass: string | null; delivery: string | null;
    payload: Readonly<Record<string, unknown>> | null;
    agreement: number | null; agreementThreshold: number | null;
    coverageReviewThreshold: number | null; riskTier: string | null;
    approved: boolean;
  },
): RunDetail {
  return {
    ...toRow(item),
    agreement: item.agreement,
    coverage: item.coverage,
    agreementThreshold: item.agreementThreshold,
    coverageReviewThreshold: item.coverageReviewThreshold,
    riskTier: item.riskTier,
    draftExternalId: item.draftExternalId,
    payloadRecorded: item.payloadRecorded,
    actionClass: item.actionClass,
    delivery: item.delivery,
    payload: item.payload,
    approved: item.approved,
  };
}

/**
 * What one journal row recorded, in a line.
 *
 * The wording lives here rather than in the surfaces, because it is a reading
 * of the query module's shapes and it changes when those change. No line
 * carries a duration: `step_journal` has no timestamp, so no step has one.
 */
/**
 * What an agreement says about the classifier's samples.
 *
 * Agreement is a share of `CLASSIFIER_K` samples, so the count is derived from
 * it: `k / 9` for a whole `k` from 0 to 9. The journal carries any other value
 * as recorded, and a count rounded from one would state a sample count the
 * ledger does not hold. Such a value is stated in full, as the shortest text
 * that reads back as the same number.
 */
export function agreementDetail(agreement: number): string {
  const count = sampleCountOf(agreement);
  return count === null
    ? `recorded ${String(agreement)}, not a share of samples`
    : `${count} of ${CLASSIFIER_K} samples`;
}

/**
 * The samples that agreed, when the agreement is exactly `k / CLASSIFIER_K`.
 *
 * Exact, not near. The classifier writes that division, and the ledger's
 * round trip keeps the double, so the same division finds it again.
 */
function sampleCountOf(agreement: number): number | null {
  const whole = Math.round(agreement * CLASSIFIER_K);
  return whole >= 0 && whole <= CLASSIFIER_K && whole / CLASSIFIER_K === agreement ? whole : null;
}

export function stepSays(step: JournalStep, journal: RunJournal): string | null {
  if (step.faultShape !== null) return `failed on a ${step.faultShape} answer`;
  switch (step.stepId) {
    case 'classify': {
      const read = journal.agreement;
      if (read === null) return null;
      const detail = agreementDetail(read.agreement);
      return sampleCountOf(read.agreement) === null
        ? `intent ${read.intentId} · agreement ${detail}`
        : `intent ${read.intentId} · ${detail} agreed`;
    }
    case 'retrieve': {
      const count = journal.documents?.length ?? null;
      const embed = step.embedModelVer === null ? '' : ` · embed ${step.embedModelVer}`;
      return count === null ? null : `${count} documents${embed}`;
    }
    case 'compose': {
      const composed = step.compose;
      if (composed === null) return null;
      if (composed.abstained) return `abstained · ${composed.provider ?? 'provider unrecorded'}`;
      const claims = composed.claimCount === null ? 'claims unrecorded' : `${composed.claimCount} claims`;
      return `${claims} · ${composed.provider ?? 'provider unrecorded'}`;
    }
    case 'gate': {
      const read = journal.coverage;
      return read === null ? null : `${read.decision} · ${read.reason ?? 'reason unrecorded'}`;
    }
    case 'park': {
      const parked = step.park;
      if (parked === null) return null;
      // The parked body and the action payload are recorded as present, never
      // shown. Both carry the composed reply, and this console authenticates
      // nobody; the operator edits the draft in the helpdesk, which is where
      // DEC-11 keeps it.
      // Four park rows exist, and reading only the two presence flags folded
      // the other two into `nothing recorded` — an absence asserted where the
      // ledger holds a measurement, which is the reverse of the rule every
      // other surface here follows.
      //
      // The crash marker records a park key and no body: a draft may exist in
      // the helpdesk that nobody can name, and that is what a person has to
      // reconcile. The refusal records the adapter's error, withheld because
      // it can quote a customer address, but its presence is not withheld.
      const held = parked.draftRecorded
        ? 'draft held in the helpdesk'
        : parked.payloadRecorded
          ? 'action payload recorded'
          : parked.failureRecorded
            ? 'the adapter refused before it appended'
            : parked.parkKey === null
              ? 'nothing recorded'
              : 'park key recorded, no draft named';
      return `${parked.actionClass ?? 'action unrecorded'} · ${parked.delivery ?? 'delivery unrecorded'} · ${held}`;
    }
    case 'execute':
      return step.idemKey === null ? null : `idempotency key ${step.idemKey}`;
    case 'close': {
      // DEC-48: the record of who finished the case, and why. The reason is
      // what the team reads afterwards, so it is drawn rather than counted —
      // and never invented: a row holding none says nothing.
      const closed = step.close;
      if (closed === null || closed.reason === null) return null;
      return `closed by ${closed.reviewer ?? 'nobody named'} · ${closed.reason}`;
    }
    case 'escalate':
      return escalationHead(step.escalationReason);
    default:
      return null;
  }
}

/**
 * The runs a partition's percentiles could not describe, named for a reader.
 *
 * Deliberately not `excluded` from `src/latency/run.ts`. That function prints
 * the ledger's own state names — `unmeasured`, `never_ran` — which is right
 * for a command an engineer runs and wrong for a console an operator reads.
 * The wording differs on purpose.
 *
 * What must not differ is the coverage. Six states exist and a seventh would
 * be invisible here, so `views.test.ts` holds this list against the fields
 * the query module exposes rather than against a copy of them.
 *
 * Folding these in as zeros would invent the most flattering possible number
 * about the runs the ledger knows least about.
 */
/**
 * How much of a latency track one percentile fills, given the widest value
 * on the surface. Null when the percentile was not measured.
 *
 * Four cases, and earlier versions collapsed two pairs of them. The floor
 * exists so a percentile far below the widest still draws a sliver rather
 * than vanishing. A measured zero draws an empty track and no sliver, because
 * a zero is a measurement and a sliver would call it a wait too small to name.
 * An unmeasured percentile has no share at all, so it draws no track: an
 * empty track would look like a measured zero. With no widest value above
 * zero there is no scale, so nothing fills; the caller never passes such a
 * maximum beside a measured value, and the guard only prevents a division by
 * zero.
 */
export function percentileShare(ms: number | null, max: number): number | null {
  if (ms === null) return null;
  if (ms === 0 || max <= 0) return 0;
  return Math.max(0.02, ms / max);
}

export function latencyCaveats(p: PartitionLatency): string[] {
  const pairs: readonly (readonly [number, string])[] = [
    [p.wait.unmeasured, 'no arrival time'],
    [p.wait.unordered, 'pickup before arrival'],
    [p.service.unfinished, 'still running'],
    [p.service.unstamped, 'no finish time'],
    [p.service.unordered, 'finish before start'],
    [p.service.neverRan, 'never ran'],
  ];
  return pairs.filter(([count]) => count > 0).map(([count, says]) => `${count} ${says}`);
}

/**
 * The draft, its claims and the documents behind them.
 *
 * Assembled here so one builder decides it. The case and the run
 * detail both draw this, and two assemblies of the same evidence would
 * eventually disagree about a run.
 *
 * The verdicts arrive keyed by position into the cited sentences, because the
 * partition joined is the draft and storing their text twice would put the
 * whole reply in the ledger a second time. This is where position becomes
 * meaning again, and a verdict naming a claim that does not exist is dropped
 * rather than attached to the wrong one.
 *
 * The position is counted over the cited sentences alone (DEC-43). A courtesy
 * sentence takes no verdict and advances no index, so a reply that opens with
 * one does not shift every verdict onto the following claim.
 */
export function evidenceOf(journal: RunJournal): EvidenceView {
  const park = journal.steps.find((step) => step.park !== null)?.park ?? null;
  const compose = journal.steps.find((step) => step.compose !== null)?.compose ?? null;
  const verdicts = journal.coverage?.claimVerdicts ?? null;

  // Counted over the cited sentences, in draft order. `claimIndex` is what
  // the citation marker numbers and what the gate recorded a verdict against;
  // it is not the sentence's position in the reply.
  let claimIndex = -1;
  const sentences: SentenceView[] | null =
    compose?.sentences == null
      ? null
      : compose.sentences.map((sentence) => {
        if (sentence.docId === null) {
          return { text: sentence.text, docId: null, claimIndex: null, supported: null };
        }
        claimIndex += 1;
        return {
          text: sentence.text,
          docId: sentence.docId,
          claimIndex,
          // Null, never false. A claim nobody judged and a claim the judge
          // refused are different facts, and only the second is a warning.
          //
          // Ambiguity is an absence, not a first-wins. `verdictsOf` permits a
          // list holding one index twice, and taking the first would render a
          // refused claim as accepted on the strength of the entry that
          // happened to come first.
          supported: verdictFor(verdicts, claimIndex),
        };
      });

  // Derived from the partition rather than mapped from `compose.claims`
  // again, so the two can never number the same reply differently.
  const claims: ClaimView[] | null =
    sentences === null
      ? null
      : sentences.flatMap((sentence) =>
        sentence.docId === null || sentence.claimIndex === null
          ? []
          : [{
            index: sentence.claimIndex,
            text: sentence.text,
            docId: sentence.docId,
            supported: sentence.supported,
          }]);

  const documents: DocumentView[] | null =
    journal.documents === null
      ? null
      : journal.documents.map((doc) => ({
        position: doc.position,
        docId: doc.docId,
        title: doc.resolved ? doc.title : null,
        kind: doc.kind,
        owner: doc.owner,
        bodyUnchanged: doc.bodyUnchanged,
        titleAtRun: doc.titleAtRun,
      }));

  return {
    draftBody: park?.draftBody ?? null,
    sentences,
    claims,
    documents,
    documentsMalformed: journal.documentsMalformed,
  };
}

/**
 * The judge's verdict for one claim, or null when the journal does not say.
 *
 * Two entries naming one claim is not a verdict. The reader permits such a
 * list, and picking either would be this console deciding which one the judge
 * meant — on the question an approver came to the page to read.
 */
function verdictFor(
  verdicts: readonly { readonly claimIndex: number; readonly supported: boolean }[] | null,
  index: number,
): boolean | null {
  if (verdicts === null) return null;
  const found = verdicts.filter((verdict) => verdict.claimIndex === index);
  return found.length === 1 ? found[0]!.supported : null;
}
