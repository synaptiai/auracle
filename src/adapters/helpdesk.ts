/**
 * Helpdesk reference adapter (sections 4.1, 4.4, 4.9). Obeys DEC-01,
 * DEC-06, DEC-11, DEC-14, DEC-18, DEC-24, DEC-30.
 *
 * Models one full helpdesk integration: a REST-style API client that
 * honors idempotency keys on send, parks gated replies as drafts, applies
 * automatic internal writes to its ticket state, and serves GET read-back.
 * The client is fixture-backed (DEC-18): it keeps
 * its state in memory and seeds its tickets from synthetic fixtures.
 * It has no credentials and no network access, but the approval bridge
 * (DEC-11) and the relay's read-back reconcile path (DEC-30) run
 * against it end to end.
 *
 * Capabilities are declared honestly for that shape of system:
 *
 * - supportsIdempotencyKey: true. Sends dedupe on the outbox idem key.
 * - supportsReadBack: true. Delivery state is readable after a send.
 * - supportsDraftState: true. Gated actions park as drafts (DEC-11).
 * - supportsStructuredFields: true. Ticket fields survive the round trip.
 * - supportsThreading: true. Replies attach to a stable ticket identity.
 */
import type {
  AdapterCapabilities,
  DeliveryState,
  DraftReadBack,
  DraftReply,
  EgressAdapter,
  ReplyProvenance,
  Ticket,
  LedgerReply,
} from './types.js';
import { AdapterCapabilityError, requireNonEmpty } from './types.js';
import { COMPENSATION_ACTION_CLASS } from './types.js';
import { HELPDESK_FIXTURE_TICKETS } from './fixtures/helpdesk.js';

/** One parked reply as the helpdesk holds it. */
export interface HelpdeskDraftRecord {
  readonly draftExternalId: string;
  readonly ticketExternalId: string;
  readonly body: string;
  readonly disclosure: string;
  /**
   * Provenance metadata carried on the message record as structured fields
   * (DEC-33, section 4.9). This adapter permits structured fields, so it
   * stores them; an adapter that does not would drop them instead.
   */
  readonly provenance: ReplyProvenance;
  readonly status: 'draft' | 'sent';
}

interface StoredDelivery {
  readonly idemKey: string;
  /** Null when the delivery came from `performAction`, which sends no draft. */
  readonly draftExternalId: string | null;
  readonly externalId: string;
}

export class HelpdeskAdapter implements EgressAdapter, DraftReadBack {
  readonly name = 'helpdesk';

  readonly capabilities: AdapterCapabilities = Object.freeze({
    supportsIdempotencyKey: true,
    supportsReadBack: true,
    supportsDraftState: true,
    supportsStructuredFields: true,
    supportsThreading: true,
    supportsLedgerReply: false,
  });

  private seq = 0;

  private readonly tickets: Map<string, Ticket>;

  private readonly drafts = new Map<string, HelpdeskDraftRecord>();

  /** Keyed by the outbox idempotency key; one entry per real send. */
  private readonly deliveries = new Map<string, StoredDelivery>();

  /** Keyed by the park idempotency key; one entry per parked draft. */
  private readonly draftsByIdemKey = new Map<string, string>();

  constructor(seedTickets: readonly Ticket[] = HELPDESK_FIXTURE_TICKETS) {
    this.tickets = new Map(seedTickets.map((ticket) => [ticket.ticketId, ticket]));
  }

  /** Park one gated reply as a draft in the helpdesk (DEC-11). */
  async createDraft(reply: DraftReply): Promise<{ readonly draftExternalId: string }> {
    requireNonEmpty('reply.ticketExternalId', reply.ticketExternalId);
    requireNonEmpty('reply.body', reply.body);
    // The adapter refuses to hold a reply with no disclosure (DEC-12, DEC-14).
    requireNonEmpty('reply.disclosure', reply.disclosure);
    requireNonEmpty('reply.idemKey', reply.idemKey);
    if (!this.tickets.has(reply.ticketExternalId)) {
      throw new Error(`helpdesk has no ticket '${reply.ticketExternalId}'`);
    }

    // A repeat park returns the first draft: the customer must never see two.
    const parked = this.draftsByIdemKey.get(reply.idemKey);
    if (parked !== undefined) {
      return { draftExternalId: parked };
    }

    this.seq += 1;
    const draftExternalId = `hd-draft-${String(this.seq).padStart(4, '0')}`;
    this.drafts.set(draftExternalId, {
      draftExternalId,
      ticketExternalId: reply.ticketExternalId,
      body: reply.body,
      disclosure: reply.disclosure,
      provenance: { ...reply.provenance },
      status: 'draft',
    });
    this.draftsByIdemKey.set(reply.idemKey, draftExternalId);
    return { draftExternalId };
  }

  /**
   * Send one approved draft with the outbox idempotency key (section 4.4).
   * The key comes from the action semantics, so a repeat call returns the
   * first delivery and does not send again (DEC-24). A draft sends once;
   * a second send attempt throws instead of duplicating the message.
   */
  async sendDraft(draftExternalId: string, idemKey: string): Promise<{ readonly externalId: string }> {
    requireNonEmpty('draftExternalId', draftExternalId);
    requireNonEmpty('idemKey', idemKey);

    const known = this.deliveries.get(idemKey);
    if (known) {
      return { externalId: known.externalId };
    }

    const draft = this.drafts.get(draftExternalId);
    if (!draft) {
      throw new Error(`helpdesk has no draft '${draftExternalId}'`);
    }
    if (draft.status === 'sent') {
      throw new Error(`draft '${draftExternalId}' was already sent under another idempotency key`);
    }

    this.seq += 1;
    const delivery: StoredDelivery = {
      idemKey,
      draftExternalId,
      externalId: `hd-msg-${String(this.seq).padStart(4, '0')}`,
    };
    this.deliveries.set(idemKey, delivery);
    this.drafts.set(draftExternalId, { ...draft, status: 'sent' });
    return { externalId: delivery.externalId };
  }

  /**
   * This helpdesk sends the drafts it parks, so the ledger never holds the
   * reply and this path is closed (DEC-44).
   *
   * Its `sendDraft` publishes the parked copy, which is the DEC-40 path. Two
   * texts that may both send is what DEC-44 rejected by name, so an adapter
   * that can send its parked copy must not also send a body from the ledger.
   */
  async sendLedgerReply(
    _reply: LedgerReply,
    _idemKey: string,
  ): Promise<{ readonly externalId: string }> {
    throw new AdapterCapabilityError(
      'helpdesk cannot send a reply the ledger holds: supportsLedgerReply is false, and its own draft is what sends (DEC-44)',
    );
  }

  /**
   * Apply one automatic internal write to the fixture helpdesk state
   * (section 4.3 executing path, DEC-06). Supported action classes and
   * their effect on the ticket record:
   *
   * - `close_ticket`   -> status becomes 'closed'
   *   `route_ticket`   -> queue becomes payload.queue (non-empty string)
   *   `compensate`     -> records the compensating action (V2); ticket
   *                       fields stay untouched, payload.reason must be a
   *                       non-empty string naming why the prior write was
   *                       wrong
   *
   * Any other class throws instead of faking an effect (DEC-06). The key
   * comes from the action semantics (DEC-24), so a repeat call returns the
   * first delivery and never applies the action twice.
   */
  async performAction(
    actionClass: string,
    payload: Record<string, unknown>,
    idemKey: string,
  ): Promise<{ readonly externalId: string }> {
    requireNonEmpty('actionClass', actionClass);
    requireNonEmpty('idemKey', idemKey);

    const known = this.deliveries.get(idemKey);
    if (known) {
      return { externalId: known.externalId };
    }

    const ticketExternalId = payload['ticketExternalId'];
    if (typeof ticketExternalId !== 'string' || ticketExternalId.length === 0) {
      throw new TypeError(
        "helpdesk action payload field 'ticketExternalId' must be a non-empty string",
      );
    }
    const ticket = this.tickets.get(ticketExternalId);
    if (!ticket) {
      throw new Error(`helpdesk has no ticket '${ticketExternalId}'`);
    }

    let updated: Ticket;
    switch (actionClass) {
      case 'close_ticket':
        updated = { ...ticket, status: 'closed' };
        break;
      case 'route_ticket': {
        const queue = payload['queue'];
        if (typeof queue !== 'string' || queue.length === 0) {
          throw new TypeError(
            "helpdesk action payload field 'queue' must be a non-empty string",
          );
        }
        updated = { ...ticket, queue };
        break;
      }
      case COMPENSATION_ACTION_CLASS: {
        // V2: compensation of an irreversible action. The helpdesk API
        // records the compensating credit against the ticket; no ticket
        // field changes. The idempotency key above already dedupes, so a
        // replayed compensation never pays twice.
        const reason = payload['reason'];
        if (typeof reason !== 'string' || reason.length === 0) {
          throw new TypeError(
            "helpdesk action payload field 'reason' must be a non-empty string",
          );
        }
        updated = { ...ticket };
        break;
      }
      default:
        throw new AdapterCapabilityError(
          `helpdesk adapter cannot perform action class '${actionClass}'; `
            + 'it implements only close_ticket, route_ticket and compensate',
        );
    }
    this.tickets.set(ticketExternalId, updated);

    this.seq += 1;
    const externalId = `hd-act-${String(this.seq).padStart(4, '0')}`;
    this.deliveries.set(idemKey, { idemKey, draftExternalId: null, externalId });
    return { externalId };
  }

  /**
   * Read one delivery back by its idempotency key (DEC-30). `not_found`
   * is a result, not an error; the relay decides what happens next.
   */
  async readBack(ref: { readonly idemKey: string }): Promise<DeliveryState> {
    requireNonEmpty('ref.idemKey', ref.idemKey);
    const delivery = this.deliveries.get(ref.idemKey);
    return delivery ? { state: 'delivered', externalId: delivery.externalId } : { state: 'not_found' };
  }

  /** Read one draft back, as the operator UI renders it before approval. */
  getDraft(draftExternalId: string): HelpdeskDraftRecord | undefined {
    return this.drafts.get(draftExternalId);
  }

  /**
   * Read one parked draft's current body for the approval path
   * (section 4.10). Null means no such draft sits in the helpdesk. The
   * approval then refuses instead of recording a fabricated distance.
   */
  async readDraft(draftExternalId: string): Promise<{ readonly body: string } | null> {
    requireNonEmpty('draftExternalId', draftExternalId);
    const draft = this.drafts.get(draftExternalId);
    return draft === undefined ? null : { body: draft.body };
  }

  /**
   * Apply a person's edit to one parked draft, as the helpdesk UI does
   * (DEC-11: the person reviews in the helpdesk they already use). The
   * edit keeps disclosure, provenance and status. Unknown drafts, empty
   * bodies and already-sent drafts refuse: an edit after the send would
   * never reach the customer.
   */
  async editDraft(draftExternalId: string, body: string): Promise<void> {
    requireNonEmpty('draftExternalId', draftExternalId);
    requireNonEmpty('body', body);
    const draft = this.drafts.get(draftExternalId);
    if (!draft) {
      throw new Error(`helpdesk has no draft '${draftExternalId}'`);
    }
    if (draft.status === 'sent') {
      throw new Error(`draft '${draftExternalId}' was already sent; edits cannot reach the customer`);
    }
    this.drafts.set(draftExternalId, { ...draft, body });
  }

  /** Read one ticket's current fixture state, for tests and observability. */
  getTicket(ticketExternalId: string): Ticket | undefined {
    return this.tickets.get(ticketExternalId);
  }

  /** Every recorded send, for observability in tests and replay. */
  listDeliveries(): readonly StoredDelivery[] {
    return [...this.deliveries.values()];
  }
}

