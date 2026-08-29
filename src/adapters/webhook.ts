import type {
  IngressAdapter,
  IngressEvent,
  Message,
  NormalizedEvent,
  Ticket,
} from './types.js';

/**
 * Webhook reference adapter (section 4.1, DEC-01). Obeys DEC-06.
 *
 * Accepts plain HTTP webhook payloads, delivered
 * through `IngressEvent.raw` (parsed JSON object or JSON text). Capabilities
 * are declared honestly for a bare webhook integration:
 *
 * - supportsIdempotencyKey: false. A webhook endpoint gives no write-side
 *   dedup guarantee, so the policy engine must route all write actions to
 *   approval (DEC-06: autonomy decreases to agree with the guarantee).
 * - supportsReadBack: false. There is no API to read state back, so the
 *   relay cannot reconcile deliveries.
 * - supportsDraftState: false. A webhook cannot render a draft in any
 *   operator UI (DEC-11 needs this; gated actions stay in the ledger).
 * - supportsStructuredFields: false. Payload fields are opaque JSON.
 * - supportsThreading: false. The event contract promises no thread ids.
 *
 * Normalization throws on events outside that contract; it never drops or
 * silently repairs one.
 */
export class WebhookAdapter implements IngressAdapter {
  readonly name = 'webhook';

  readonly capabilities = Object.freeze({
    supportsIdempotencyKey: false,
    supportsReadBack: false,
    supportsDraftState: false,
    supportsStructuredFields: false,
    supportsThreading: false,
  });

  normalize(event: IngressEvent): NormalizedEvent {
    const payload =
      typeof event.raw === 'string' ? parseJson(event.raw) : event.raw;
    const body = assertObject(payload, 'payload');

    const ticketRaw = assertObject(body.ticket, 'ticket');
    const messageRaw = assertObject(body.message, 'message');

    const fromAddress =
      messageRaw.from === undefined
        ? null
        : requireString(messageRaw.from, 'message.from');

    const ticket: Ticket = {
      ticketId: requireString(ticketRaw.id, 'ticket.id'),
      subject:
        ticketRaw.subject === undefined
          ? ''
          : requireString(ticketRaw.subject, 'ticket.subject'),
      queue:
        ticketRaw.queue === undefined
          ? null
          : requireString(ticketRaw.queue, 'ticket.queue'),
      status: parseStatus(ticketRaw.status),
      customerAddress: fromAddress,
    };

    const message: Message = {
      messageId: requireString(messageRaw.id, 'message.id'),
      inReplyTo: null,
      references: [],
      author: parseAuthor(messageRaw.author),
      fromAddress,
      toAddresses: [],
      ccAddresses: [],
      subject: ticket.subject,
      sentAt: requireTimestamp(messageRaw.createdAt, 'message.createdAt'),
      bodyText: requireString(messageRaw.body, 'message.body'),
      attachments: [],
    };

    // The webhook contract carries ticket-level grouping only: it declares
    // supportsThreading false, and the payload has no reply chain. The
    // ticket id already groups a thread, so there is no further evidence
    // and this adapter offers none (DEC-06).
    return {
      sourceId: event.sourceId,
      linkage: null,
      ticket,
      message,
      ...(typeof body.eventId === 'string' && body.eventId.length > 0
        ? { eventId: body.eventId }
        : {}),
    };
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new TypeError('webhook payload is not valid JSON');
  }
}

type UnknownRecord = Record<string, unknown>;

function assertObject(value: unknown, path: string): UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`webhook payload field '${path}' must be an object`);
  }
  return value as UnknownRecord;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(
      `webhook payload field '${path}' must be a non-empty string`,
    );
  }
  return value;
}

function requireTimestamp(value: unknown, path: string): string {
  const raw = requireString(value, path);
  if (Number.isNaN(Date.parse(raw))) {
    throw new TypeError(
      `webhook payload field '${path}' must be an ISO 8601 timestamp`,
    );
  }
  return raw;
}

function parseStatus(value: unknown): Ticket['status'] {
  if (value === 'open' || value === 'pending' || value === 'closed') {
    return value;
  }
  throw new TypeError(
    "webhook payload field 'ticket.status' must be 'open', 'pending' or 'closed'",
  );
}

function parseAuthor(value: unknown): Message['author'] {
  if (value === 'customer' || value === 'agent' || value === 'system') {
    return value;
  }
  throw new TypeError(
    "webhook payload field 'message.author' must be 'customer', 'agent' or 'system'",
  );
}
