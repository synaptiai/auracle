/**
 * Action-class vocabulary shared by the coordinator, the relay and every
 * adapter (DEC-29: each class declares its delivery rule).
 *
 * These live with the port rather than with the relay, because an adapter
 * implements the port and must not depend on the process that drives it.
 */

/**
 * The only action class the relay routes through `sendDraft`. The approval
 * bridge parks that draft inside the target system and records its external
 * id in the payload before the record becomes relayable. Every other class
 * names an automatic internal write and goes through `performAction`.
 */
export const CUSTOMER_REPLY_ACTION_CLASS = 'customer_reply';

/**
 * Compensation of an irreversible action, such as a sent refund. It rides
 * `performAction` like every other internal write, but it always gates
 * (DEC-34) and its delivery rule is `at_most_once` (DEC-29): a duplicate
 * refund costs money, so an uncertain send escalates (DEC-30).
 */
export const COMPENSATION_ACTION_CLASS = 'compensate';

/**
 * Ingress and egress ports (docs/v1-architecture.md, sections 4.1, 4.4,
 * 4.9). Obeys DEC-01 (the port is the contract), DEC-06 (adapters declare
 * capability; autonomy decreases to agree).
 *
 * Ingress: an adapter changes each inbound event into a `Ticket` and a
 * `Message`. The policy engine reads `capabilities` (section 4.9). If
 * `supportsIdempotencyKey` is false, all write actions go to the approval
 * path regardless of risk tier or intent. The decrease in autonomy is
 * declared here, not discovered by an operator.
 */

// The shape from section 4.1, defined once in src/domain/capabilities.ts
// (DEC-06). Re-exported here so an adapter still imports the contract from
// the port it implements.
export type { AdapterCapabilities } from '../domain/capabilities.js';
import type { AdapterCapabilities } from '../domain/capabilities.js';

/** One file attached to an inbound message. */
export interface Attachment {
  filename: string | null;
  contentType: string;
  sizeBytes: number;
}

/** One inbound event as the source delivered it. */
export interface IngressEvent {
  /** Adapter-assigned opaque source identifier (IMAP UID, webhook delivery id). */
  readonly sourceId: string;
  /** Raw payload: RFC 5322 text for IMAP ingress, a JSON value for webhooks. */
  readonly raw: unknown;
}

/** A support ticket as the source system holds it. */
export interface Ticket {
  /**
   * Stable ticket identity in the source system. Sources without native
   * ticket ids (IMAP) get one derived deterministically by the adapter.
   */
  ticketId: string;
  subject: string;
  /** Queue or component that received the ticket, when the source reports one. */
  queue: string | null;
  status: 'open' | 'pending' | 'closed';
  /** Customer address when known, else null. */
  customerAddress: string | null;
}

/** One message in a ticket conversation. */
export interface Message {
  /** Stable message id in the source system, or null when it gives none. */
  messageId: string | null;
  /** Direct parent message id, or null when absent or unthreaded. */
  inReplyTo: string | null;
  /** Thread chain from root to parent; empty when the source does not thread. */
  references: readonly string[];
  /** Who produced the message. */
  author: 'customer' | 'agent' | 'system';
  fromAddress: string | null;
  toAddresses: readonly string[];
  ccAddresses: readonly string[];
  subject: string | null;
  /**
   * When the source accepted the message: ISO 8601 for webhooks, the raw
   * Date header value for email ingress. Parsed later at the ledger edge.
   */
  sentAt: string | null;
  bodyText: string;
  attachments: readonly Attachment[];
}

/**
 * What an adapter can say about the conversation an inbound message joins
 * (DEC-35). It offers evidence, never a conclusion: the ledger resolves the
 * conversation, because only the ledger knows which turns exist.
 *
 * An adapter that cannot detect linkage returns null. The ticket id still
 * groups the messages of one thread, so a null here means "no evidence
 * beyond the ticket", not "start a new conversation".
 */
export interface ConversationLinkage {
  /**
   * Ids of messages this one replies to, thread root first. Resolving any of
   * them to a recorded turn joins that conversation, which is how a customer
   * can continue one problem on a new thread.
   */
  readonly priorMessageIds: readonly string[];
}

/** Result of normalizing one inbound event. */
export interface NormalizedEvent {
  ticket: Ticket;
  message: Message;
  /**
   * The adapter's own identity for this delivery: an IMAP UID, or the id the
   * webhook server minted. Intake prefers the message id and falls back to
   * this, so a message with no id of its own still deduplicates (DEC-24).
   */
  sourceId: string;
  /** Conversation evidence, or null when the adapter has none (DEC-06). */
  linkage: ConversationLinkage | null;
  /**
   * Provider-native dedupe id, present only when the source guarantees it is
   * stable across redelivery. Absent otherwise; callers must not invent one
   * (cf. DEC-24: identity fields do not stand in for semantics).
   */
  eventId?: string;
}

/**
 * The ingress port (section 4.1). Implementations declare their capabilities
 * once, as a frozen value (DEC-06), and never drop or silently repair a
 * malformed event: normalize throws instead.
 */
export interface IngressAdapter {
  readonly name: string;
  readonly capabilities: AdapterCapabilities;
  normalize(event: IngressEvent): NormalizedEvent;
}

/**
 * Egress port (sections 4.4 and 4.9). Obeys DEC-01, DEC-06, DEC-11,
 * DEC-14, DEC-30.
 *
 * The approval bridge parks each gated action as a draft inside the target
 * system (section 4.9, DEC-11). After a person approves, the relay sends the
 * draft through the same adapter with the outbox `idem_key` (section 4.4).
 * The relay then reads the delivery state back and reconciles; when read-back
 * is not possible it escalates instead of retrying (DEC-30).
 */

/** Machine-readable provenance for generated text (DEC-33, section 4.9). */
export interface ReplyProvenance {
  /** The system that produced the text. */
  generatedBy: string;
  /** The model that produced the text. */
  modelId: string;
  /** Version of the prompt that produced the text. */
  promptVer: string;
  /** ISO 8601 timestamp of when the text was produced. */
  generatedAt: string;
}

/**
 * Provenance for a reply a person wrote (DEC-48, DEC-33).
 *
 * A reviewer who rewrites a reply from scratch replaces the model's text, so
 * the reply that reaches the customer names a person and no model and no
 * prompt. It is its own shape rather than a `ReplyProvenance` with empty
 * fields, because there is no model version to report: an empty string would
 * be a value the trailers and headers would print as a fact.
 */
export interface PersonProvenance {
  /** Who wrote the text. `person` is the value this repository writes. */
  generatedBy: string;
  /** ISO 8601 timestamp of when the text was written. */
  generatedAt: string;
}

/**
 * The provenance a customer reply carries (DEC-33, DEC-48).
 *
 * A reply the model drafted carries its model and prompt; one a person wrote
 * carries neither. Serialized onto the outbox record, into the text trailer
 * on a channel with no structured field, and into the adapter's headers.
 */
export type Provenance = ReplyProvenance | PersonProvenance;

/**
 * A reply the ledger holds, on its way to the customer (DEC-44).
 *
 * The same three parts a `DraftReply` carries, under a name that says where
 * they come from. `draftExternalId` is the parked copy's handle: it addresses
 * the ticket and the thread the reply posts on, and it is not read for its
 * body. Nothing here is read back from the target system — an adapter that
 * cannot send what it parked sends this instead.
 */
export interface LedgerReply {
  /** The parked copy's handle, which addresses the ticket. */
  readonly draftExternalId: string;
  /** The approved reply, as the ledger holds it. */
  readonly bodyText: string;
  /** The adopter's disclosure. Must not be empty (DEC-12, DEC-14). */
  readonly disclosure: string;
  /**
   * Machine-readable provenance, mandatory on every customer reply (DEC-33).
   *
   * Either shape: the ledger sends the draft's own provenance, and a reply a
   * person rewrote from scratch carries one that names no model (DEC-48).
   */
  readonly provenance: Provenance;
}

/** A gated customer reply before it enters the target system. */
export interface DraftReply {
  /** `ticketId` of the ticket this reply answers. */
  ticketExternalId: string;
  body: string;
  /** Human-readable disclosure. Must not be empty (DEC-12, DEC-14). */
  disclosure: string;
  /**
   * Machine-readable provenance metadata. Mandatory on each customer reply
   * (DEC-33): it travels on the message record and into adapter headers
   * where the adapter permits structured fields (section 4.9).
   */
  provenance: ReplyProvenance;
  /**
   * DEC-35: the participant the ledger recorded for this conversation.
   *
   * An adapter that resolves the recipient from the ticket id must agree with
   * it. db/012 refuses a conversation join by a different sender, but the
   * ticket id is still the forged thread root, so a mail adapter would look
   * that root up and address the reply to the victim who wrote it. The
   * membership check and the addressing path have to agree about what a
   * ticket id proves.
   *
   * Absent when the ledger recorded no participant, which is not a licence to
   * address the reply anywhere: it means there is nothing to check against.
   */
  expectedRecipient?: string | null;
  /**
   * DEC-24 semantic key for the park itself, derived from the action and the
   * ticket, never from the run.
   *
   * `createDraft` reaches the target system before the ledger can record
   * what it made. A crash in that window used to leave a draft nobody could
   * name, and the retry parked a second one in front of the customer. The
   * key lets the adapter recognise the repeat and return the first draft.
   */
  idemKey: string;
}

/**
 * What a read-back learns about one delivery. `not_found` is a result, not
 * an error: the relay turns it into `delivery_unknown` and escalates.
 */
export type DeliveryState =
  | { readonly state: 'delivered'; readonly externalId: string }
  | { readonly state: 'not_found' };

/**
 * The egress port. Implementations declare their capabilities once, as a
 * frozen value (DEC-06), and refuse replies whose `disclosure` is empty
 * (DEC-14).
 */
export interface EgressAdapter {
  readonly name: string;
  readonly capabilities: AdapterCapabilities;
  /** Park one gated reply as a draft inside the target system (DEC-11). */
  /**
   * Park one gated reply as a draft (DEC-11). A repeat call carrying the
   * same `reply.idemKey` returns the first draft and must not create a
   * second one: the customer must never see two.
   */
  createDraft(reply: DraftReply): Promise<{ readonly draftExternalId: string }>;
  /**
   * Send one approved draft with the outbox idempotency key.
   *
   * An adapter declaring `supportsIdempotencyKey` must return the first
   * delivery on a repeat call and must not send again. An adapter declaring
   * it false cannot honour that (SMTP accepts no key), so the relay's own
   * `status = 'pending'` guard is what prevents a second send there.
   */
  sendDraft(draftExternalId: string, idemKey: string): Promise<{ readonly externalId: string }>;
  /**
   * Send the reply the ledger holds (DEC-44).
   *
   * For an adapter that declares `supportsLedgerReply`. Its helpdesk cannot
   * send the copy it parks, so the approved text comes from the ledger,
   * together with the disclosure and provenance the adapter attaches to any
   * customer reply (DEC-14, DEC-33). `draftExternalId` addresses the ticket,
   * exactly as it addresses the park: on this path it names the parked copy
   * that is read back and never sent.
   *
   * An adapter whose helpdesk can send its parked copy must throw
   * `AdapterCapabilityError` instead, and the relay branches on the
   * declaration before it calls: two texts that may both send is the failure
   * DEC-44 rejected by name.
   */
  sendLedgerReply(reply: LedgerReply, idemKey: string): Promise<{ readonly externalId: string }>;
  /**
   * Apply one automatic internal write (section 4.3, executing path). The
   * relay calls this for every action class that is not a customer reply;
   * `payload` holds the semantic fields of the action and names its target
   * ticket under `ticketExternalId`. A repeat call with the same key
   * returns the first delivery and must not apply the action again.
   *
   * An adapter whose capabilities cannot guarantee an automatic write must
   * throw `AdapterCapabilityError` instead of faking the action (DEC-06).
   * The policy engine already routes every write of such an adapter to the
   * approval path, so the throw is a second line of defence, never the
   * first.
   */
  performAction(
    actionClass: string,
    payload: Record<string, unknown>,
    idemKey: string,
  ): Promise<{ readonly externalId: string }>;
  /** Read one delivery's state back so the relay can reconcile (DEC-30). */
  readBack(ref: { readonly idemKey: string }): Promise<DeliveryState>;
}

/**
 * Narrow read port for the approval path (section 4.10). An adapter whose
 * capabilities include `supportsDraftState` implements it against the same
 * draft state `createDraft` parks in (DEC-11). The approval entrypoint uses
 * it to measure what a person actually edited before approving.
 */
export interface DraftReadBack {
  /**
   * Read one parked draft's current body. Null means the target system
   * holds no such draft: it was deleted or never parked. The caller must
   * treat null as a refusal, never as an empty body.
   *
   * `signal` says the caller stopped waiting. An adapter that holds a
   * connection for the read closes it then, rather than at its own bound.
   */
  readDraft(
    draftExternalId: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<{ readonly body: string } | null>;
}

/**
 * Thrown when an adapter is asked to do what its declared capabilities say
 * it cannot (DEC-06). The throw states the limit; it never stands in for a
 * delivery.
 */
export class AdapterCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterCapabilityError';
  }
}

/**
 * Rejects an empty or whitespace-only field, and returns it trimmed.
 *
 * Each adapter used to carry its own copy, and the three had drifted into
 * disagreeing. `helpdesk.ts` took `(value, field)`, threw a `TypeError`, did
 * not trim and returned the value; `freescout.ts` took `(field, value)`, threw
 * an `Error`, trimmed and returned nothing; `imap-smtp.ts` took a third
 * signature again. Both parameters were `string`, so a line copied from one
 * adapter into another compiled, and the field name is never empty, so the
 * swapped call always passed. An empty `idemKey` could reach the outbox that
 * way, and DEC-24 is the guarantee that key carries.
 *
 * Two positions, two guards, and what each one actually catches:
 *
 * `field` accepts a string *literal type*. `Literal<T>` resolves to `never`
 * when `T` widens to `string`, so passing a `string`-typed variable there
 * fails to build — which is the swap, because a value is always a variable.
 * A `const`-declared name or a literal union still compiles there; the guard
 * is aimed at the swap, not at forbidding every indirection.
 *
 * `value` stays `string | null | undefined` rather than `unknown`. Widening it
 * would have surrendered the position's own guard: `requireNonEmpty('reply.body',
 * reply)` — the whole object — and `requireNonEmpty('x', 42)` both compiled
 * under `unknown`, and neither did before this was one function. The null and
 * undefined arms are what `imap-smtp.ts` needed from its own copy.
 *
 * A branded type was tried for `field` first and does not work: an optional
 * brand still accepts a plain string, so the swap compiled. Measured, not
 * assumed.
 *
 * The trimmed return is the function's contract, and every call site today
 * discards it. Read that as validation, not as normalization: after this
 * throws or does not, the caller keeps using its own value. Nothing downstream
 * depends on the trim, and the places where a padded value would matter
 * normalize on their own — `deriveIdemKey` in `src/ledger/keys.ts` hashes the
 * action data, and `sanitizeTicketId` in `src/adapters/mime.ts` strips
 * whitespace from a Message-ID. A caller that wants the canonical form has to
 * take the return value.
 *
 * Whitespace counts as empty. One adapter accepted a single space and two
 * rejected it, which is the kind of disagreement a shared validator exists to
 * end.
 */
type Literal<T extends string> = string extends T ? never : T;

export function requireNonEmpty<F extends string>(
  field: Literal<F>,
  value: string | null | undefined,
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    // A `TypeError`, not an `AdapterCapabilityError`. The latter means the
    // adapter was asked to do what its declared capabilities forbid (DEC-06),
    // and `helpdesk.ts` and `imap-smtp.ts` both raise it for exactly that.
    // An empty field is an invalid argument, which is a different fault, and
    // blurring the two would cost a distinction the callers rely on.
    throw new TypeError(`${field} must not be empty`);
  }
  return value.trim();
}

/**
 * An egress failure that a retry can never clear.
 *
 * A refused recipient, a payload the target will always reject: repeating it
 * spends a full pipeline run and files an orphan run row each time, and the
 * queue's attempt ceiling is sized for transient faults. The coordinator
 * escalates this class on the first occurrence instead.
 */
export class PermanentEgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentEgressError';
  }
}
