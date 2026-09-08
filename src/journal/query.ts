/**
 * Read-only step-journal queries for one run (sections 4.2 and 4.3, DEC-05).
 *
 * `step_journal` is the write-before-act record every step files before it
 * acts, and for as long as it stood nothing read it back. The escalation
 * query reads two keys off two of its rows; the control bands read two more.
 * Nobody read the run's own history, so the console's run detail could name a
 * run and its state and nothing the run actually did.
 *
 * What this answers: what the run journalled, what the two gates measured,
 * which thresholds those measurements were judged against, and which
 * documents the retriever returned.
 *
 * Two things the ledger cannot answer, stated here because a reader will
 * otherwise assume it can:
 *
 *   - There is no timestamp and no sequence column on `step_journal`, so per
 *     step duration is not recoverable and the order a run walked its steps
 *     is not stored. `STEP_ORDER` below is this module's own, not the
 *     ledger's. `src/coordinator/coordinator.db.test.ts` says the same of the
 *     alphabetical order that a bare ORDER BY gives.
 *   - `cost_micros` reads like a per-step cost and is not one. The
 *     coordinator writes the meter's running total at each step, so the value
 *     is the spend of the whole run up to that point. It is reported under a
 *     name that says so, because subtracting two of them to make a per-step
 *     figure is wrong whenever a step is missing.
 *
 * DEC-05 keeps the two gates independent. Agreement sits on the `classify`
 * row and coverage on the `gate` row, so the ledger never holds them in one
 * object, and this module never puts them in one either. There is no function
 * here that takes both and returns a number. That absence is the rule.
 *
 * DEC-21 keeps ranks out of the fusion and scores out of everything. Only the
 * fused list of ids is journalled, so a retrieved document carries the
 * position it was recorded at and nothing else. See `RetrievedDocument`.
 *
 * Every statement is a SELECT. The module never writes, so it is safe to run
 * against a live database. It reads document metadata, journal keys and two
 * measurements; it reads no draft text, no action payload and no fault
 * message, because each of those can carry a customer's own words or address
 * into an operator surface (DEC-18).
 */
import type { Pool, PoolClient } from 'pg';

import { agreementThresholdFor } from '../policy/policy.js';
import type { GateThresholds } from '../policy/policy.js';

/**
 * The order a run walks its steps, which is this module's own statement and
 * not a fact recovered from the ledger.
 *
 * `step_journal` carries no sequence column, so the only order a query can
 * impose is alphabetical by step id, and that order is not causal: it puts
 * `compose` before `gate` correctly and `escalate` second, before the step
 * that escalated. A console rendering that order would show an operator a
 * pipeline that never ran in that shape.
 *
 * Read off `src/coordinator/coordinator.ts`: classify, retrieve, compose and
 * gate in sequence, then `park` or `execute` (never both — they are the two
 * arms of the gate decision), and `escalate` last, because a run reaches it
 * from anywhere and it is always where the run stopped.
 *
 * Used for ordering only, never for filtering. A step id this list does not
 * hold is still returned, marked unrecognised and sorted last: a coordinator
 * that learns an eighth step must not have it silently disappear from the one
 * surface that exists to show what the run did.
 */
export const STEP_ORDER: readonly string[] = [
  'classify',
  'retrieve',
  'compose',
  'gate',
  'park',
  'execute',
  'escalate',
];

/**
 * What the `compose` step recorded about its own outcome.
 *
 * The draft itself is deliberately absent. It is the answer written for a
 * customer, and this surface has no reason to hold one (DEC-18).
 */
export interface ComposeRecord {
  /** DEC-07: an abstain is a determination, not a fault. */
  readonly abstained: boolean;
  /**
   * Claims the composer partitioned the draft into, or null when the row
   * recorded no count.
   *
   * Null, never zero. Zero claims is a real and rare outcome, and a row that
   * recorded nothing must not be reported as one: the count is the
   * groundedness denominator, so a fabricated zero says the coverage gate
   * judged an empty draft.
   */
  readonly claimCount: number | null;
  /**
   * Documents the composer cited that are past their review date (DEC-23),
   * or null when the row recorded no list.
   *
   * Null, never the empty list. An empty list is a clean bill of health —
   * every cited document is inside its review window — and inventing one from
   * a row that said nothing is the most flattering answer available about the
   * run the ledger knows least about.
   */
  readonly staleDocumentIds: readonly string[] | null;
  /** What answered the run's model calls: `stub` or `model` (issue #23). */
  readonly provider: string | null;
}

/**
 * What the `park` step recorded, across all four shapes it writes.
 *
 * The coordinator files four distinct park rows and the status plus the
 * fields present tell them apart:
 *
 *   - `done` with an action payload and no handle: the DEC-34 ledger park. A
 *     gated internal write has nothing to park in the helpdesk, so it waits
 *     in the ledger for approval.
 *   - `parking` with a park key: the crash marker. It says a draft may exist
 *     in the customer's helpdesk that nobody can name, and
 *     `priorParkUnresolved` escalates every later run on the ticket while it
 *     stands.
 *   - `failed` with a park key: the adapter refused before it appended, which
 *     is why the coordinator overwrites the marker rather than leaving it —
 *     a marker left for a refusal poisons the ticket permanently.
 *   - `done` with a draft handle: the customer draft, parked in the target
 *     system and awaiting approval (DEC-11, DEC-12).
 *
 * Returned flat, with the status beside it. An enum here would fold the
 * status and the field presence into one value, and a fifth shape would then
 * have to be squeezed into one of four names or disappear.
 */
export interface ParkRecord {
  readonly actionClass: string | null;
  readonly delivery: string | null;
  /** The handle in the target system. Present on the customer draft alone. */
  readonly draftExternalId: string | null;
  /** DEC-24: the action-derived key. Present on the marker and the refusal. */
  readonly parkKey: string | null;
  /** DEC-38: the conversation turn, so approval derives this turn's key. */
  readonly turnNumber: number | null;
  /**
   * Whether a draft was recorded, rather than the draft.
   *
   * The parked text is what a customer will read and what the edit-distance
   * measurement compares against. It stays in the ledger (DEC-18).
   */
  readonly draftRecorded: boolean;
  /** Whether an action payload was recorded. The payload itself stays put. */
  readonly payloadRecorded: boolean;
  /**
   * Whether the refusal recorded a message, rather than the message.
   *
   * `src/adapters/imap-smtp.ts` builds a `PermanentEgressError` that names
   * both the expected recipient and the thread's From address, and the
   * coordinator journals that text verbatim. Returning it would put two
   * customer email addresses on an operator surface (DEC-18). The reason the
   * run stopped is `egress_refused` on the `escalate` row, which this module
   * does return.
   *
   * That last sentence is true of the coordinator's own escalations and not
   * of every value under the key. `escalationReason` is returned verbatim,
   * and the relay writes two interpolated strings into it:
   * `delivery_unknown: ${sendFailure}` (`src/relay/relay.ts:345`) and
   * `malformed_payload: ${errorText(error)}` (`src/relay/relay.ts:262`). The
   * first quotes whatever the adapter threw from `sendDraft`, and an SMTP
   * rejection routinely quotes the recipient. The consumer's
   * `intake_abandoned after N attempts: ${reason}` is a third.
   *
   * So the key is not a closed vocabulary and a reader must not treat it as
   * one. `src/escalations/query.ts` has returned the same value since before
   * this module existed, so the exposure is the ledger's rather than this
   * reader's; what belongs here is the accurate statement. The console trims
   * the interpolated tail before it renders the value — see `escalationHead`
   * in `console/src/render.ts`.
   */
  readonly failureRecorded: boolean;
}

/** One journalled step, exactly as the ledger holds it. */
export interface JournalStep {
  readonly stepId: string;
  /**
   * Whether `STEP_ORDER` knows this step id. False means a step written by a
   * coordinator this module has not been told about, sorted last rather than
   * dropped.
   */
  readonly recognized: boolean;
  /**
   * The status the row carries. Deliberately not a closed union: the ledger
   * has no CHECK on this column, and `db/006` backfills `unknown` onto rows
   * that predate the NOT NULL, so a reader that typed it as a fixed set would
   * be describing a rule nothing enforces.
   */
  readonly status: string;
  readonly resultRecorded: boolean;
  /**
   * A result that is present and is not a JSON object.
   *
   * Nothing in the database constrains the shape, so a row like this is
   * possible and one of them must not cost the reader the whole run. Reported
   * under its own name so it reads as a ledger the console cannot interpret,
   * never as a step that recorded nothing.
   */
  readonly resultMalformed: boolean;
  /**
   * A row journalled before its step produced an outcome.
   *
   * `db/006` states why the column stays nullable: a step is journalled
   * before it acts, so between the entry and the outcome there is genuinely
   * no result. Whether the step is running now or died mid-flight is not
   * recoverable from stored data — nothing carries a heartbeat or a
   * timestamp — so this says only that the outcome is missing.
   */
  readonly awaitingOutcome: boolean;
  /** DEC-26 pins, or null where `db/006` backfilled `unrecorded`. */
  readonly promptVer: string | null;
  readonly modelVer: string | null;
  /**
   * The run's total spend when this row was last written, in micro-dollars.
   *
   * Cumulative, not this step's cost. See the module comment.
   */
  readonly runCostMicrosAtStep: number;
  /**
   * The response shape a fault was typed with, on a `failed` row.
   *
   * The shape is a constant this repository writes (`no-label`, `no-vector`
   * and the rest), so it carries nothing from a model answer. The message
   * beside it does, and is not returned.
   */
  readonly faultShape: string | null;
  /** The embedding pin, recorded on the `retrieve` row (DEC-26). */
  readonly embedModelVer: string | null;
  /** Present on a `compose` row that recorded an outcome. */
  readonly compose: ComposeRecord | null;
  /** Present on a `park` row. */
  readonly park: ParkRecord | null;
  /** DEC-24: the action-derived key, on an `execute` row. */
  readonly idemKey: string | null;
  /** The coordinator's EscalationReason, on an `escalate` row. */
  readonly escalationReason: string | null;
}

/**
 * The classifier's agreement, and the threshold it was judged against.
 *
 * One of the two independent gates (DEC-05). It shares no field and no
 * function with `CoverageReading`.
 */
export interface AgreementReading {
  readonly intentId: string;
  /** Fraction of the nine samples that agreed (section 4.5). */
  readonly agreement: number;
  /**
   * Samples nobody could read, or null when the row recorded none.
   *
   * Null rather than zero. The coordinator writes this key only when the
   * count is above zero, so an absent key means either that no sample was
   * unreadable or that the row predates the key, and stored data does not
   * separate the two. Reporting zero would assert the flattering one.
   */
  readonly unreadableSamples: number | null;
  /**
   * The scalar this agreement was actually compared against, or null.
   *
   * Not stored. The gate row journals the whole threshold set, and DEC-41
   * makes the operative number depend on the intent: a fitted per-intent
   * entry when one cleared the fit, the global value otherwise. The
   * precedence lives in `agreementThresholdFor`, which this module imports
   * and applies rather than re-encoding — a second copy of that order is free
   * to drift from the engine's, and then the console shows a threshold no run
   * was ever judged against.
   *
   * Null when it cannot be recovered: no classify row, no gate row, or a
   * journalled threshold set this module refuses. An absence renders as an
   * absence; it never falls back to a seed.
   */
  readonly threshold: number | null;
}

/**
 * The groundedness coverage, its verdict, and the thresholds journalled with
 * it (DEC-07).
 *
 * The other of the two independent gates (DEC-05).
 */
export interface CoverageReading {
  /** Fraction of claims the retrieved text supports (section 4.7). */
  readonly groundedness: number;
  /** `auto`, `gated` or `escalate`. */
  readonly decision: string;
  /**
   * Which rule decided, from the policy engine.
   *
   * `decision` alone is ambiguous: `gated` covers a rule that returns before
   * the agreement comparison is made and the groundedness review band, which
   * reaches that comparison and passes it.
   *
   * Null when a gate row recorded a verdict and no reason, which is what a
   * row written before the key existed looks like. Null rather than a word,
   * because every value this field can hold comes from `POLICY_REASONS` and a
   * sentinel would be a member of that set that the engine does not know: a
   * reader matching on the reason falls through silently on it. bands keeps
   * its unrecorded gates under a count of their own for the same reason.
   */
  readonly reason: string | null;
  /** Section 4.7: below this, no automatic write. Null when not journalled. */
  readonly blockThreshold: number | null;
  /** Section 4.7: below this, a person sees it. Null when not journalled. */
  readonly reviewThreshold: number | null;
}

/**
 * One document the retriever returned, joined to the index for its metadata.
 *
 * Two things a reader has to know about this join:
 *
 *   - There is no foreign key from the journal to `document`, so an id can
 *     resolve to nothing. Such a row comes back with `resolved` false and its
 *     id intact, never dropped: an id the index no longer holds is a fact
 *     about the run, and silently shortening the list would hide it.
 *   - `document` rows are updated in place when a document is reindexed
 *     (`src/retriever/retriever.ts`), so the title, owner and review date
 *     below are today's, not the ones the run retrieved. Only the id is a
 *     historical fact.
 */
export interface RetrievedDocument {
  readonly docId: string;
  /**
   * Where the id sat in the journalled list, counting from one.
   *
   * A recorded position and nothing more. It is not a BM25 rank, not a vector
   * rank, and not a score: DEC-21 fuses ranks and discards the scores, and
   * `applyRerank` stands down below fifty candidates without recording that
   * it did. So the stored order is either the fused order or the reranker's,
   * and nothing stored says which. Naming this a rank would claim a channel
   * the ledger cannot name.
   */
  readonly position: number;
  /** Whether the id still resolves in the document index. */
  readonly resolved: boolean;
  readonly title: string | null;
  /** DEC-22: `document` or `canonical_resolution`. */
  readonly kind: string | null;
  /** DEC-23: who answers for the content. */
  readonly owner: string | null;
  /** DEC-23: the review date, as `YYYY-MM-DD`. */
  readonly reviewBy: string | null;
}

/** Everything one run journalled. */
export interface RunJournal {
  readonly runId: string;
  /** Every journalled row, in `STEP_ORDER`. */
  readonly steps: readonly JournalStep[];
  /** The agreement gate, or null when no classify row recorded a value. */
  readonly agreement: AgreementReading | null;
  /** The coverage gate, or null when no gate row recorded a verdict. */
  readonly coverage: CoverageReading | null;
  /**
   * The retrieved ids in recorded order, or null when the run journalled no
   * completed retrieval.
   *
   * Null and the empty list are different answers: null is a run that never
   * got as far as retrieving, and the empty list is a retrieval that found
   * nothing. Collapsing them would report a run stopped at classification as
   * a run whose index is empty.
   */
  readonly documents: readonly RetrievedDocument[] | null;
  /**
   * A completed retrieval whose recorded id list could not be read.
   *
   * Its own field, because `documents` has no value that could carry it.
   * Null there means the run never retrieved and the empty list means the
   * retrieval found nothing; a row that retrieved and recorded something
   * unreadable is a third fact, and a surface has to be able to say so.
   */
  readonly documentsMalformed: boolean;
}

/**
 * Every journalled row for one run.
 *
 * Keyed on `run_id`, which the primary key covers, so this reads one run's
 * rows and never scans the table. `step_journal` has no other index.
 *
 * Ordered by `STEP_ORDER` and not filtered by it: an unrecognised step sorts
 * last rather than vanishing. The result is passed through a type guard
 * rather than cast — the shape is not enforced by the database, and a value
 * that is not an object must cost that row its detail and nothing more.
 */
const SELECT_STEPS = `
  SELECT step_id,
         status,
         result IS NOT NULL                                     AS result_recorded,
         -- The guard bands/query.ts uses, applied to the whole document
         -- rather than to one key. Nothing here casts, so the statement
         -- cannot be failed by one bad row; this states at the statement
         -- which rows carry readable detail, and the isObject guard below is what
         -- decides. Two tests of one rule, and the redundancy is the point:
         -- the day a key IS read in SQL, the guard is already in place.
         CASE WHEN jsonb_typeof(result) = 'object' THEN result END AS result_object,
         prompt_ver,
         model_ver,
         cost_micros
    FROM step_journal
   WHERE run_id = $1
   ORDER BY array_position($2::text[], step_id) NULLS LAST, step_id`;

/**
 * The journalled ids, joined to today's index.
 *
 * `WITH ORDINALITY` over the id list, so the recorded order survives the join
 * and a duplicated id stays duplicated. A LEFT JOIN, so an id the index no
 * longer holds returns its position with null metadata instead of shortening
 * the list.
 *
 * `review_by` is rendered by the database. It is a `date`, and node-postgres
 * turns one into a JavaScript Date at the local midnight, so a console in a
 * timezone behind UTC would show the day before the stored one. `bands`
 * renders its day key the same way and for the same reason.
 */
const SELECT_DOCUMENTS = `
  SELECT ids.ord                              AS position,
         ids.doc_id                           AS doc_id,
         d.doc_id IS NOT NULL                 AS resolved,
         d.title                              AS title,
         d.kind                               AS kind,
         d.owner                              AS owner,
         to_char(d.review_by, 'YYYY-MM-DD')   AS review_by
    FROM unnest($1::text[]) WITH ORDINALITY AS ids(doc_id, ord)
    LEFT JOIN document d ON d.doc_id = ids.doc_id
   ORDER BY ids.ord`;

/** A run id the ledger can be asked about. The column is `uuid`. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A number the journal recorded, or null when the key is absent or is not one. */
function numberAt(result: Record<string, unknown> | null, key: string): number | null {
  if (result === null) return null;
  const value = result[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A string the journal recorded, or null when the key is absent or is not one. */
function stringAt(result: Record<string, unknown> | null, key: string): string | null {
  if (result === null) return null;
  const value = result[key];
  return typeof value === 'string' ? value : null;
}

/** Whether the journal recorded the key at all, whatever it holds. */
function has(result: Record<string, unknown> | null, key: string): boolean {
  return result !== null && Object.hasOwn(result, key);
}

/**
 * A DEC-26 pin, or null for the placeholder `db/006` backfilled.
 *
 * `unrecorded` is not a version. Passing it through as one would let the
 * console display a pin that names no prompt and no model, which is the
 * opposite of what DEC-26 exists to guarantee.
 */
function pin(value: unknown): string | null {
  const text = typeof value === 'string' ? value : '';
  return text === '' || text === 'unrecorded' ? null : text;
}

/**
 * The threshold set journalled beside the coverage verdict, or null.
 *
 * Validated rather than trusted. `agreementThresholdFor` is total over a set
 * that `makeThresholds` built, and its fallback arm returns
 * `thresholds.agreement` unchecked; handed raw jsonb it would return
 * `undefined` or a string typed as a number, and the console would render a
 * threshold that was never compared against anything.
 *
 * Every fraction is checked here on the same terms the policy module states:
 * above zero and no greater than one. `perIntent` needs only to be an object,
 * because `agreementThresholdFor` already refuses a member that is not a
 * fraction and falls back to the global value.
 *
 * Exported and taking `unknown`, so the guard can be exercised against the
 * shapes a ledger can actually hold without a database standing by.
 */
export function readGateThresholds(raw: unknown): GateThresholds | null {
  if (!isObject(raw)) return null;
  const fraction = (key: string): number | null => {
    const value = raw[key];
    return typeof value === 'number' && value > 0 && value <= 1 ? value : null;
  };
  const agreement = fraction('agreement');
  const block = fraction('groundednessBlock');
  const review = fraction('groundednessReview');
  if (agreement === null || block === null || review === null) return null;
  const perIntent = raw['perIntent'];
  return {
    agreement,
    groundednessBlock: block,
    groundednessReview: review,
    ...(isObject(perIntent) ? { perIntent: perIntent as Record<string, number> } : {}),
  };
}

/**
 * The agreement threshold a run was judged against, from what the ledger
 * holds.
 *
 * Exported so the precedence can be exercised without a database, and because
 * it is the one piece of this module that is a rule rather than a read.
 *
 * The intent id is passed through unnormalised on purpose:
 * `agreementThresholdFor` normalises it itself, and normalising here would
 * re-encode half of the behaviour this module imports it to avoid.
 */
export function agreementThresholdFromJournal(
  intentId: string | null,
  thresholds: GateThresholds | null,
): number | null {
  if (intentId === null || thresholds === null) return null;
  return agreementThresholdFor({ intent: intentId, thresholds });
}

function toParkRecord(result: Record<string, unknown> | null): ParkRecord {
  return {
    actionClass: stringAt(result, 'actionClass'),
    delivery: stringAt(result, 'delivery'),
    draftExternalId: stringAt(result, 'draftExternalId'),
    parkKey: stringAt(result, 'parkKey'),
    turnNumber: numberAt(result, 'turnNumber'),
    draftRecorded: has(result, 'body'),
    payloadRecorded: has(result, 'payload'),
    failureRecorded: has(result, 'error'),
  };
}

/**
 * The compose outcome, from a row that recorded one.
 *
 * Two statuses, not one. `done` and `abstained` are both determinations the
 * composer reached (DEC-07), and the coordinator picks between them on the
 * abstain flag alone, so an allowlist of `done` would discard every abstain —
 * which is the outcome an operator most wants to see. A `failed` row is a
 * fault and lands nowhere near this.
 */
const COMPOSE_STATUSES: readonly string[] = ['done', 'abstained'];

function toComposeRecord(
  status: string,
  result: Record<string, unknown> | null,
): ComposeRecord | null {
  if (!COMPOSE_STATUSES.includes(status)) return null;
  const abstained = result === null ? undefined : result['abstained'];
  if (typeof abstained !== 'boolean') return null;
  const stale = result === null ? undefined : result['staleDocumentIds'];
  return {
    abstained,
    claimCount: numberAt(result, 'claimCount'),
    // Null, never a filtered list. A member that is not a string makes the
    // whole list unreadable, and dropping it would answer a malformed row
    // with a shorter clean bill of health — the flattering answer this
    // field's own contract refuses.
    staleDocumentIds:
      Array.isArray(stale) && stale.every((id) => typeof id === 'string')
        ? (stale as string[])
        : null,
    provider: stringAt(result, 'provider'),
  };
}

function toStep(row: Record<string, unknown>): JournalStep {
  const stepId = String(row['step_id']);
  const raw = row['result_object'];
  const result = isObject(raw) ? raw : null;
  const recorded = row['result_recorded'] === true;
  const status = String(row['status']);
  return {
    stepId,
    recognized: STEP_ORDER.includes(stepId),
    status,
    resultRecorded: recorded,
    // Recorded, and not an object. The SELECT already refused to hand it over.
    resultMalformed: recorded && result === null,
    awaitingOutcome: status === 'started' && !recorded,
    promptVer: pin(row['prompt_ver']),
    modelVer: pin(row['model_ver']),
    // `?? 0` is dead today: `db/006` set this column NOT NULL. It stays as the
  // reader's own floor, and the asymmetry it hides is stated rather than
  // fixed: that same migration backfilled the pre-constraint NULLs to 0, so a
  // row written before it reports a fabricated zero as measured spend. `pin()`
  // above maps the matching DEC-26 backfill (`'unrecorded'`) to null, because
  // that placeholder is distinguishable and this one is not — a real zero and
  // a backfilled zero are the same value in the column.
  runCostMicrosAtStep: Number(row['cost_micros'] ?? 0),
    // Only a failed row carries a fault. A `done` row holding the key would
    // be a shape nothing writes, and reading it as a fault would render a
    // finished step as a broken one.
    faultShape: status === 'failed' ? stringAt(result, 'shape') : null,
    embedModelVer: stepId === 'retrieve' ? stringAt(result, 'embed_model_ver') : null,
    compose: stepId === 'compose' ? toComposeRecord(status, result) : null,
    park: stepId === 'park' ? toParkRecord(result) : null,
    idemKey: stepId === 'execute' ? stringAt(result, 'idemKey') : null,
    escalationReason: stepId === 'escalate' ? stringAt(result, 'reason') : null,
  };
}

/**
 * The result of one step, only when that step recorded an outcome.
 *
 * The status test is the point. A `classify` row and a `gate` row that failed
 * both carry a non-null result holding a shape and a message and none of the
 * fields a reader wants. Admitting them on a non-null result alone renders a
 * live fault as a verdict: a classifier that answered unreadably would show
 * as an agreement, and a groundedness judge that did would show as a coverage
 * decision. `bands/query.ts` makes the same test for the same reason.
 *
 * An allowlist of one status, not a denylist of `failed`. A denylist fails
 * open: a status added later is admitted, and whatever it carries is read as
 * a verdict until somebody notices. The cost is that a row `db/006` backfilled
 * to `unknown` reports its measurements as unrecorded, which is the safe
 * direction — those rows also carry no DEC-26 pin, so nothing about them can
 * be attributed anyway.
 */
function doneResult(
  steps: readonly JournalStep[],
  rows: Map<string, Record<string, unknown> | null>,
  stepId: string,
): Record<string, unknown> | null {
  const step = steps.find((s) => s.stepId === stepId);
  if (step === undefined || step.status !== 'done') return null;
  return rows.get(stepId) ?? null;
}

/**
 * Everything one run journalled, or null when the ledger holds no row for it.
 *
 * Null means "no journalled step under this id", which is not quite "no such
 * run". This module reads `step_journal` alone and never joins `run`: the
 * console already has `readRun` in `src/escalations/query.ts`, and a second
 * copy of that join would be a second definition of what a run row is. So a
 * run inserted a moment ago, before its first step was journalled, answers
 * null here exactly as an id that names nothing does. The caller that knows
 * whether the run exists is the one that read the run row.
 *
 * Two statements, not one. The second reads the ids the first returned. They
 * are not atomic with respect to each other, and that costs nothing here:
 * `document` rows are mutable in place anyway, so the metadata is already
 * today's rather than the run's, which the type says.
 *
 * Read-only. Safe against a live database.
 */
export async function readRunJournal(
  pool: Pool | PoolClient,
  runId: string,
): Promise<RunJournal | null> {
  // The column is `uuid`, so a value that is not one makes the database
  // raise a syntax fault rather than answer. A console route takes this id
  // out of a URL, and an unparsable id there is a request for a run that
  // cannot exist — the same answer as an id that names nothing.
  if (!UUID.test(runId)) return null;

  const journal = await pool.query(SELECT_STEPS, [runId, STEP_ORDER]);
  const rows = journal.rows as unknown as Record<string, unknown>[];
  if (rows.length === 0) return null;

  const steps = rows.map(toStep);
  const byStep = new Map<string, Record<string, unknown> | null>();
  for (const row of rows) {
    const raw = row['result_object'];
    byStep.set(String(row['step_id']), isObject(raw) ? raw : null);
  }

  // The two gates, read from two rows and kept apart (DEC-05).
  const classified = doneResult(steps, byStep, 'classify');
  const gated = doneResult(steps, byStep, 'gate');

  const intentId = stringAt(classified, 'intentId');
  const agreementValue = numberAt(classified, 'agreement');
  const thresholds = readGateThresholds(gated === null ? null : gated['thresholds']);
  const agreement: AgreementReading | null =
    intentId === null || agreementValue === null
      ? null
      : {
          intentId,
          agreement: agreementValue,
          unreadableSamples: numberAt(classified, 'unreadableSamples'),
          threshold: agreementThresholdFromJournal(intentId, thresholds),
        };

  const groundedness = numberAt(gated, 'groundedness');
  const decision = stringAt(gated, 'decision');
  const coverage: CoverageReading | null =
    groundedness === null || decision === null
      ? null
      : {
          groundedness,
          decision,
          // A gate row written before the reason key existed has a decision
          // and no reason. Reported as an absence, never as a rule nobody named.
          reason: stringAt(gated, 'reason'),
          blockThreshold: thresholds?.groundednessBlock ?? null,
          reviewThreshold: thresholds?.groundednessReview ?? null,
        };

  // A retrieval that finished. A failed one carries a shape and no ids, and
  // reading it would report a fault as a search that returned nothing.
  const retrieved = doneResult(steps, byStep, 'retrieve');
  const rawIds = retrieved === null ? undefined : retrieved['docIds'];
  // Three states, not two. A completed retrieval whose `docIds` cannot be
  // read is neither a run that never retrieved nor a retrieval that found
  // nothing, and reporting it as either would name a fact the ledger does not
  // hold. It is reported under its own name, the way `resultMalformed` is.
  //
  // The list is taken whole or not at all. Filtering the members that are
  // strings would hand `SELECT_DOCUMENTS` a shorter list, and its
  // `WITH ORDINALITY` then numbers positions over that shorter list — so a
  // dropped member renders as a complete retrieval with the wrong positions.
  const readable = Array.isArray(rawIds) && rawIds.every((id) => typeof id === 'string');
  const documentsMalformed = retrieved !== null && !readable;
  let documents: RetrievedDocument[] | null = null;
  if (readable) {
    const docIds = rawIds as string[];
    documents =
      docIds.length === 0
        ? []
        : ((await pool.query(SELECT_DOCUMENTS, [docIds])).rows as unknown as Record<
            string,
            unknown
          >[]).map((row) => ({
            docId: String(row['doc_id']),
            position: Number(row['position']),
            resolved: row['resolved'] === true,
            title: (row['title'] as string | null) ?? null,
            kind: (row['kind'] as string | null) ?? null,
            owner: (row['owner'] as string | null) ?? null,
            reviewBy: (row['review_by'] as string | null) ?? null,
          }));
  }

  return { runId, steps, agreement, coverage, documents, documentsMalformed };
}
