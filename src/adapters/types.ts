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

/**
 * Exact shape from section 4.1. Each flag is a guarantee the target system
 * gives, so an adapter must declare it honestly: a false flag is never a
 * soft claim.
 */
export interface AdapterCapabilities {
  supportsIdempotencyKey: boolean; // controls automatic writes
  supportsReadBack: boolean; // lets the relay reconcile
  supportsDraftState: boolean; // necessary for DEC-11
  supportsStructuredFields: boolean; // necessary for bug records
  supportsThreading: boolean;
}

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

/** Result of normalizing one inbound event. */
export interface NormalizedEvent {
  ticket: Ticket;
  message: Message;
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
  createDraft(reply: DraftReply): Promise<{ readonly draftExternalId: string }>;
  /**
   * Send one approved draft with the outbox idempotency key. A repeat call
   * with the same key returns the first delivery and must not send again.
   */
  sendDraft(draftExternalId: string, idemKey: string): Promise<{ readonly externalId: string }>;
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
