/**
 * IMAP/SMTP reference adapter (docs/v1-architecture.md, section 4.1).
 *
 * Obeys DEC-06: the adapter declares its capability, and autonomy
 * decreases to agree with what the capability guarantees. It never fakes
 * a guarantee.
 *
 * The declared capabilities are honest for plain IMAP ingress plus SMTP
 * delivery:
 *
 * - `supportsIdempotencyKey: false` — inbound mail carries no
 *   idempotency key and SMTP delivery accepts none. Under DEC-06 and
 *   section 4.4 every write action therefore goes to the approval path,
 *   whatever its risk tier or intent.
 * - `supportsDraftState: false` — SMTP has no draft state to park a
 *   gated action in. The implementation provides none, so none is
 *   declared (DEC-11 cannot be satisfied by this adapter).
 * - `supportsReadBack: false` — SMTP returns no delivery-state read-back
 *   for the relay to reconcile. An unknown delivery state means
 *   `delivery_unknown` and escalation (DEC-30).
 * - `supportsStructuredFields: false` — email is free text; bug records
 *   do not survive this transport as structure.
 * - `supportsThreading: true` — Message-ID, In-Reply-To and References
 *   headers carry a real thread chain.
 */

import { createHash } from 'node:crypto';
import { normalizeMime } from './mime.js';
import type {
  AdapterCapabilities,
  DeliveryState,
  EgressAdapter,
  IngressAdapter,
  IngressEvent,
  NormalizedEvent,
} from './types.js';
import { AdapterCapabilityError } from './types.js';

export const IMAP_SMTP_CAPABILITIES: Readonly<AdapterCapabilities> = Object.freeze({
  supportsIdempotencyKey: false,
  supportsReadBack: false,
  supportsDraftState: false,
  supportsStructuredFields: false,
  supportsThreading: true,
});

/** Longest ticket id derived from a message id before truncation. */
const MAX_MESSAGE_ID_LENGTH = 200;

/**
 * Derive stable conversation identity. The thread root is the first
 * entry of References when present, then In-Reply-To, then the message's
 * own Message-ID. Messages that carry no ids at all fall back to a hash
 * of the adapter-assigned source identifier, which stays deterministic
 * across re-ingestion of the same event.
 */
export function deriveTicketId(
  threadRootMessageId: string | null,
  sourceId: string,
): string {
  if (threadRootMessageId !== null) {
    const sanitized = sanitizeTicketId(threadRootMessageId);
    if (sanitized.length > 0) return sanitized;
  }
  const digest = createHash('sha256').update(sourceId).digest('hex');
  return `no-id-${digest.slice(0, 16)}`;
}

function sanitizeTicketId(messageId: string): string {
  return messageId.replace(/\s+/g, '').slice(0, MAX_MESSAGE_ID_LENGTH);
}

export class ImapSmtpAdapter implements IngressAdapter {
  readonly name = 'imap-smtp';

  readonly capabilities: AdapterCapabilities = IMAP_SMTP_CAPABILITIES;

  normalize(event: IngressEvent): NormalizedEvent {
    if (typeof event.raw !== 'string') {
      throw new TypeError('imap-smtp ingress needs the RFC 5322 message text');
    }
    const email = normalizeMime(event.raw);

    // First References entry is the thread root; fall back through the
    // chain per deriveTicketId.
    const threadRoot =
      email.references[0] ??
      email.inReplyTo ??
      email.messageId ??
      null;

    return {
      ticket: {
        ticketId: deriveTicketId(threadRoot, event.sourceId),
        subject: email.subject ?? '',
        queue: null,
        status: 'open',
        customerAddress: email.fromAddress,
      },
      message: {
        messageId: email.messageId,
        inReplyTo: email.inReplyTo,
        references: email.references,
        author: 'customer',
        fromAddress: email.fromAddress,
        toAddresses: email.toAddresses,
        ccAddresses: email.ccAddresses,
        subject: email.subject,
        sentAt: email.sentAt,
        bodyText: email.bodyText,
        attachments: email.attachments,
      },
    };
  }
}

/**
 * SMTP-shaped egress adapter (section 4.4, DEC-06). Every egress method
 * declares what plain mail transport cannot do instead of faking it:
 *
 * - `createDraft`/`sendDraft` throw: there is no draft state to park a
 *   gated action in (supportsDraftState is false, so DEC-11 cannot be
 *   satisfied), and no send that honors an idempotency key.
 * - `performAction` throws: an automatic internal write needs the write
 *   to dedupe on the outbox key, and SMTP accepts none
 *   (supportsIdempotencyKey is false). The policy engine already routes
 *   every write of this adapter to the approval path; the throw is the
 *   declared second line of defence.
 * - `readBack` throws: SMTP returns no delivery state, so the relay must
 *   treat any failure as `delivery_unknown` and escalate (DEC-30).
 */
export class SmtpEgressAdapter implements EgressAdapter {
  readonly name = 'imap-smtp';

  readonly capabilities: AdapterCapabilities = IMAP_SMTP_CAPABILITIES;

  async createDraft(): Promise<{ readonly draftExternalId: string }> {
    throw new AdapterCapabilityError(
      'smtp cannot park drafts: supportsDraftState is false (DEC-11)',
    );
  }

  async sendDraft(): Promise<{ readonly externalId: string }> {
    throw new AdapterCapabilityError(
      'smtp cannot send drafts: supportsDraftState and supportsIdempotencyKey are false',
    );
  }

  async performAction(): Promise<{ readonly externalId: string }> {
    throw new AdapterCapabilityError(
      'smtp cannot apply automatic internal writes: supportsIdempotencyKey is false',
    );
  }

  async readBack(): Promise<DeliveryState> {
    throw new AdapterCapabilityError(
      'smtp cannot read delivery state back: supportsReadBack is false (DEC-30)',
    );
  }
}
