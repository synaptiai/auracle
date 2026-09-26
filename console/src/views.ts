// What a ledger row and a journal step say on a page (issue #27).
//
// Its own module for the reason `hosts.ts` and `ledger-name.ts` have one:
// `main.ts` runs `main()` when it is imported, so nothing defined there can
// be reached from a test. These three decide what an operator reads about a
// run, which is not a thing to leave unasserted.
//
// They map and nothing else. No statement is issued here, and every value
// comes from a reader in the root package.
import { CLASSIFIER_K, CUSTOMER_REPLY_ACTION_CLASS } from 'auracle/domain';
import { replyDigest, verdictAt } from 'auracle/ledger-read';
import type { JournalStep, RunJournal } from 'auracle/ledger-read';

import { escalationHead, parksAnAction } from './render.js';
import type { PartitionLatency } from 'auracle/ledger-read';

import type {
  ClaimView, DocumentView, EvidenceView, RunDetail, RunRow, SentenceView,
} from './surfaces.js';

export function toRow(item: {
  runId: string; ticketId: string; state: string; promptVer: string;
  reason: string | null; gateReason: string | null; intentId: string | null;
  coverage: number | null; createdAt: Date | null;
  /** DEC-48: the moment a snooze is due back, or null. */
  snoozedUntil: Date | null;
  /**
   * DEC-49: the moment a reviewer sent this run back, or null.
   *
   * Read so a surface can tell a run a person rejected from one that reached
   * `superseded` another way. The state alone cannot say it.
   */
  sentBackAt: Date | null;
  /** DEC-49: whether the attempt this run is on was sent back. */
  attemptRejected: boolean;
  /** DEC-49: whether the turn already holds a reply that went out or will. */
  turnClosed: boolean;
  /** DEC-48: whether a person wrote the reply this run holds. */
  replyRewritten: boolean;
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
    snoozedUntil: item.snoozedUntil,
    sentBackAt: item.sentBackAt,
    attemptRejected: item.attemptRejected,
    turnClosed: item.turnClosed,
    // DEC-48: read from the same statement as the row. A rewritten reply has
    // no coverage of its own, and every surface that says so reads this.
    replyRewritten: item.replyRewritten,
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

/**
 * #123: the draft a park step names, or null. A handle names a draft only as a
 * non-empty string on a park that finished, as the conversation reader and the
 * queue read it, and as the approval requires.
 */
function draftOf(step: JournalStep): string | null {
  const handle = step.park?.draftExternalId ?? null;
  return step.status === 'done' && handle !== null && handle !== '' ? handle : null;
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
      // shown. Both carry composed text, and this console authenticates
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
      //
      // #123: the handle names a draft, and the body does not. An internal
      // write parks in the ledger alone and journals its rationale as a body
      // too (DEC-34), so a body beside a payload is an action, not a draft.
      const draft = draftOf(step);
      const held = draft !== null
        ? 'draft held in the helpdesk'
        : parksAnAction(parked.payload !== null, parked.actionClass, draft)
          ? 'action payload recorded'
          // A reply parked in the ledger alone records a payload too, and
          // holds no draft: it is a reply, not an action. A payload of a
          // shape no action takes is named as what it is.
          : parked.payloadRecorded
            ? (parked.actionClass === CUSTOMER_REPLY_ACTION_CLASS
              ? 'reply recorded in the ledger, no draft named'
              : 'payload recorded in a shape no action takes')
            : parked.draftRecorded
            ? 'text recorded, no draft named'
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
    case 'send_back': {
      // DEC-49: the note a reviewer wrote when they sent the case back. It is
      // the instruction the attempt under it was walked with, so a reviewer
      // reading the new reply can see what was asked for — and never
      // invented: a row holding no note says nothing.
      const sentBack = step.sendBack;
      if (sentBack === null) return null;
      // DEC-50: a published document asked for the attempt, and the document
      // is what the next attempt reads instead of a note.
      if (sentBack.note === null && sentBack.documentTitle !== null) {
        return `attempted again by ${sentBack.reviewer ?? 'nobody named'} · after publishing ${sentBack.documentTitle}`;
      }
      if (sentBack.note === null) return null;
      return `sent back by ${sentBack.reviewer ?? 'nobody named'} · ${sentBack.note}`;
    }
    case 'supersede': {
      // #122: why the run stopped with nothing sent. The reason is the one
      // the ledger recorded, worded for a reader, and never invented. The
      // past tense, because it says what held when the run stopped: an undo
      // inside a held send can open the turn again later.
      const why = step.supersede;
      if (why === null || why.reason === null) return null;
      if (why.reason === 'turn_answered' && why.answeredBy !== null) {
        return `superseded · the turn was answered by run ${why.answeredBy.slice(0, 8)}`;
      }
      if (why.reason === 'reply_waiting' && why.waitingRun !== null) {
        return `superseded · run ${why.waitingRun.slice(0, 8)} already held the turn's reply`;
      }
      if (why.reason === 'draft_parked' && why.parkedBy !== null) {
        return `superseded · run ${why.parkedBy.slice(0, 8)} had parked the turn's draft`;
      }
      if (why.reason === 'attempt_rejected') return 'superseded · a reviewer sent this attempt back';
      return `superseded · ${why.reason}`;
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
    // DEC-48: the runs a reviewer put aside. Its own line, because the count
    // is the wait the distribution leaves out rather than a fault.
    [p.service.snoozed, 'snoozed'],
    // DEC-49: and the attempts a reviewer rejected, whose duration is the
    // time a person spent reading the case.
    [p.service.rejected, 'sent back'],
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
/**
 * The coverage a page may report for a run (DEC-48).
 *
 * The gate judged the draft. A run whose reply a person wrote from scratch
 * reports no coverage: not the number, and not either line it was measured
 * against. This view is what the page draws, so a page reading the journal
 * directly would put the draft's verdict beside the person's words — which
 * the case page did until the runtime pass caught it.
 *
 * The journal read stays the record. `journal.coverage` is untouched, and
 * this decides only what a surface may say about the reply on screen.
 */
export function coverageForPage(journal: RunJournal): {
  readonly coverage: number | null;
  readonly block: number | null;
  readonly review: number | null;
} {
  if (journal.rewrite !== null) return { coverage: null, block: null, review: null };
  return {
    coverage: journal.coverage?.groundedness ?? null,
    block: journal.coverage?.blockThreshold ?? null,
    review: journal.coverage?.reviewThreshold ?? null,
  };
}

export function evidenceOf(journal: RunJournal): EvidenceView {
  const parkStep = journal.steps.find((step) => step.park !== null);
  const park = parkStep?.park ?? null;
  const compose = journal.steps.find((step) => step.compose !== null)?.compose ?? null;
  // DEC-48: the gate judged the draft and no page may draw its verdicts on a
  // reply a person wrote. The sentences and their sources stay — they are the
  // citations the reviewer kept — and only the judgment about them goes. A
  // callout here would offer to repair a sentence that is no longer sent.
  const verdicts = journal.rewrite === null
    ? (journal.coverage?.claimVerdicts ?? null)
    : null;

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
          supported: verdictAt(verdicts, claimIndex),
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
    // #123: only an internal write parks a payload (DEC-34).
    // The payload read as an object, as the queue and the reader read it.
    parkedAction: parksAnAction(
      (park?.payload ?? null) !== null, park?.actionClass ?? null,
      parkStep === undefined ? null : draftOf(parkStep),
    ),
    sentences,
    claims,
    documents,
    documentsMalformed: journal.documentsMalformed,
    // DEC-48. Read from the journal this builder already holds, so the block
    // and the verdicts above cannot disagree about which reply is on screen.
    replyRewritten: journal.rewrite !== null,
    // Whether the draft the block draws is the reply the rewrite replaced.
    // The journal records the digest of what it replaced, so a save between
    // the park and the rewrite is visible here: the reply that person replaced
    // was their own text, and the block says what it draws rather than
    // claiming to be what the rewrite displaced.
    draftReplaced: journal.rewrite !== null
      && journal.rewrite.cleared !== null
      && park?.draftBody != null
      && journal.rewrite.cleared === replyDigest(park.draftBody),
  };
}
