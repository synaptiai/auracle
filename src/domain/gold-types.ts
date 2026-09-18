// The gold corpus as a set of types, with no way to read one from disk.
//
// This module was the tail of src/fixtures/load.ts, which is the most-imported
// file in the repository. Eighteen production modules across eight directories
// reached it, and a module that wanted the word `Taxonomy` imported fixture
// file I/O to get it. Nothing here opens a file.
//
// Decisions described: DEC-18 (synthetic only), DEC-22 (documents and
// canonical resolutions), DEC-23 (owner and review_by), DEC-31 (one gold set
// split in two), DEC-35 (a case belongs to a conversation), DEC-39 (later
// turns exist and are not scored), section 4.11 (at most 25 intents).
//
// It loads no module at runtime. `RiskTier` arrives by re-export, because
// src/domain/capabilities.ts is its single declaration site and a second copy
// is what this directory exists to prevent. That module imports nothing
// either, so the rule holds through it: a type here drags no module behind it.
//
// The rule is about the emitted JavaScript, not the source lines. The two
// lines below are `import type` and `export type`, which TypeScript erases,
// so the compiled `gold-types.js` requires nothing. A value import or a
// value re-export would survive, and that is what is refused.
// `src/domain/capabilities.test.ts` holds it shut, parsing this file with
// the compiler rather than matching its lines.
export type { RiskTier } from './capabilities.js';
import type { RiskTier } from './capabilities.js';

export const FIT_COUNT = 4100;

export const REPORT_COUNT = 4100;

export const INTENT_CAP = 25;

/**
 * Where a gold half's cases came from (DEC-18).
 *
 * A closed set, so a half cannot name a provenance no reader understands and
 * no artifact can record one. 'synthetic' is the corpus this repository
 * ships and publishes every number from. 'real' is an adopter's own labelled
 * history, which lives outside the repository and never enters it.
 */
export const GOLD_SOURCES = ['synthetic', 'real'] as const;

export type GoldSource = (typeof GOLD_SOURCES)[number];

export const DOC_KINDS = ['document', 'canonical_resolution'] as const;

export type DocumentKind = (typeof DOC_KINDS)[number];

export interface Taxonomy {
  version: number;
  intent_cap: number;
  intents: TaxonomyIntent[];
}

export interface TaxonomyIntent {
  id: string;
  label: string;
  risk_tier: RiskTier;
}

export interface Disposition {
  escalated: boolean;
  macro_applied: string | null;
  refund_issued: boolean;
  first_reply_minutes: number;
}

/** DEC-07: one claim of a draft, and whether the cited document truly supports it. */
export interface GoldClaim {
  text: string;
  /** The document this claim is tested against. */
  doc_id: string;
  /** Ground truth, not a judge's verdict. */
  supported: boolean;
  /**
   * How hard the claim is to refuse, or null when it is supported.
   *
   * A fit that holds only on the easy grade has measured nothing about the
   * hard one, so the grade travels with the claim and the fitting job
   * reports coverage for each.
   */
  grade: ClaimGrade | null;
}

export const CLAIM_GRADES = ['off_topic', 'absent', 'unstated_detail'] as const;

export type ClaimGrade = (typeof CLAIM_GRADES)[number];

export interface GoldTicket {
  ticket_id: string;
  source: string;
  /** The true intent, assigned by the generator. Ground truth for scoring. */
  intent: string;
  /**
   * DEC-41: what produced this case's label.
   *
   * Never `human-review`. Section 5 calls the labelling the largest single
   * cost in the plan, and `method: "human-review"` in a gold report means a
   * person read the case. A model label written there would make one field
   * mean two things, and no reader could recover which.
   *
   * Optional on read, because a corpus written before DEC-41 carries neither
   * this field nor the label beside it.
   */
  labelled_by?: string;
  /**
   * The label that labeller produced, which is what a deployment would have.
   *
   * It differs from `intent` exactly where the labeller was wrong, and that
   * difference is the agreement rate the calibration artifact records.
   */
  labelled_intent?: string;
  queue: string;
  disposition: Disposition;
  subject: string;
  body: string;
  /**
   * DEC-35: the conversation this case belongs to. Every case carries one,
   * synthetic or real: the corpus export models turns and its validator
   * requires both fields. Optional in the type because the field arrived
   * after the schema did, and the validators are where it is required.
   */
  conversation_id?: string;
  /** DEC-39: the turn this case records, counting from 1. */
  turn_number?: number;
  /**
   * DEC-37: the agent reply that answered this turn, as the next turn's
   * prompt sees it. Absent on the last turn of a conversation, which no
   * recorded reply followed.
   *
   * This mirrors `turn.approved_reply_text` in the ledger: a reply takes no
   * turn number of its own, it hangs off the turn it answered.
   */
  agent_reply?: string;
  /**
   * DEC-07: per-claim ground truth for the groundedness fit. Every synthetic
   * case carries it; a real-corpus record does not, because nobody has
   * labelled its claims.
   */
  claims?: GoldClaim[];
}

/**
 * True when a case records a first turn (DEC-39).
 *
 * Replay scores routing against an observable disposition (DEC-32). A later
 * turn's disposition reflects the whole conversation, not the decision the
 * replay is scoring, so scoring it would credit or blame the wrong choice.
 * Those cases move to the online metrics instead; none is lost.
 *
 * The filter binds every job that scores a disposition: the replay and the
 * gold report. It does not bind the calibration job, which scores a
 * prediction against the case's own intent label. A later turn carries a
 * valid label, and section 6 requires the agreement threshold to be re-fitted
 * on multi-turn data.
 *
 * An absent `turn_number` counts as a first turn. That branch is defensive
 * only: the type leaves the field optional, and every validator that admits
 * a case to a gold half or a corpus file now requires it. A record reaching
 * this function without one has bypassed a validator.
 */
export function isFirstTurn(ticket: GoldTicket): boolean {
  return ticket.turn_number === undefined || ticket.turn_number === 1;
}

/**
 * The text one case presents to a model.
 *
 * The runtime composes it in `src/intake/adapter.ts`, stores it in
 * `turn.body_text`, and reads it back as history. An offline job that
 * composed it differently would classify a prompt the runtime never sends, so
 * this is the one definition and every job calls it.
 */
export function goldCaseText(ticket: GoldTicket): string {
  return `${ticket.subject}\n\n${ticket.body}`;
}

export type GoldSplit = 'fit' | 'report';

export interface GoldFile {
  split: GoldSplit;
  source: GoldSource;
  count: number;
  tickets: GoldTicket[];
}

export interface FixtureDocument {
  doc_id: string;
  kind: DocumentKind;
  title: string;
  body: string;
  url: string;
  owner: string;
  review_by: string;
  linked_intents: string[];
  /**
   * DEC-47: the products this document serves. An empty list means every
   * product, which is what a document nobody scoped serves.
   */
  products: string[];
}

/**
 * The identifiers of one half, and nothing else.
 *
 * DEC-31 needs the two halves proved disjoint, and only a caller naming both
 * can prove it. A fitting job must never open the report half's cases: the
 * structural guarantee that a report-half leak needs a code change is worth
 * more than any check. So this opens the file and validates it in full — an
 * identity taken from a file nobody validated would prove nothing — and
 * RETURNS identifiers alone. No subject and no body crosses to the caller,
 * and the returned shape has no field that could carry one. "The file is
 * never read" would be the wrong claim; this is the one that holds.
 */
export interface HalfIdentity {
  readonly split: GoldSplit;
  readonly source: GoldSource;
  readonly ticketIds: ReadonlySet<string>;
  readonly conversationIds: ReadonlySet<string>;
  /**
   * One digest per distinct claim sentence, never the sentence.
   *
   * A sentence is free text. On a real half it is the customer's own words or
   * an agent's words about their account, and a fault message reaches a
   * terminal and a CI log where DEC-18 forbids such a value. Unlike an
   * identifier there is no safe form to print, so this holds digests and the
   * sentence itself never leaves the file it was loaded from.
   */
  readonly claimDigests: ReadonlySet<string>;
  /** Drafts whose every claim is supported. */
  readonly groundedDrafts: number;
  /** Drafts carrying any claim at all, the denominator of the share above. */
  readonly draftsWithClaims: number;
}
