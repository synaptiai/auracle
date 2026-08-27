/**
 * IMAP/SMTP duplex reference adapter (docs/v1-architecture.md, sections
 * 4.1 and 4.4). Obeys DEC-06: the adapter declares its capability, and
 * autonomy decreases to agree with what the capability guarantees. It
 * never fakes a guarantee.
 *
 * Ingress reads plain IMAP mail. Egress parks gated replies as drafts in
 * the Drafts mailbox (DEC-11) and sends them over SMTP after approval.
 * The declared capabilities are honest for that shape:
 *
 * - `supportsIdempotencyKey: false` — inbound mail carries no idempotency
 *   key and SMTP delivery accepts none. Under DEC-06 and section 4.4 every
 *   write action therefore goes to the approval path, whatever its risk
 *   tier or intent.
 * - `supportsDraftState: true` — a reply parks as an RFC 5322 draft in the
 *   Drafts mailbox; the appended UID is the draft's external id.
 * - `supportsReadBack: false` — presence in a Sent mailbox after an SMTP
 *   failure is a weak signal, so the adapter declares no read-back. An
 *   unknown delivery state means `delivery_unknown` and escalation
 *   (DEC-30).
 * - `supportsStructuredFields: false` — email is free text; ticket fields
 *   do not survive this transport as structure (section 4.9). Provenance
 *   and disclosure still ride along as free-form X-Auracle headers on each
 *   parked draft: any mail system passes arbitrary headers, and DEC-33
 *   wants the audit trail to travel with the message record even where no
 *   structured field round-trips.
 * - `supportsThreading: true` — Message-ID, In-Reply-To and References
 *   headers carry a real thread chain.
 */

import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import { createTransport } from 'nodemailer';
import { normalizeMime } from './mime.js';
import type {
  AdapterCapabilities,
  DeliveryState,
  DraftReadBack,
  DraftReply,
  EgressAdapter,
  IngressAdapter,
  IngressEvent,
  NormalizedEvent,
} from './types.js';
import { AdapterCapabilityError } from './types.js';

export const IMAP_SMTP_CAPABILITIES: Readonly<AdapterCapabilities> = Object.freeze({
  supportsIdempotencyKey: false,
  supportsReadBack: false,
  supportsDraftState: true,
  supportsStructuredFields: false,
  supportsThreading: true,
});

/**
 * Longest message id the adapter turns into a ticket id. A longer id
 * refuses instead of truncating: a truncated id can collide with another
 * thread sharing the prefix, and it never round-trips in the egress
 * lookup, so the reply could not be addressed (findThreadOriginator).
 */
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
    if (sanitized.length > MAX_MESSAGE_ID_LENGTH) {
      throw new Error(
        `message id of ${sanitized.length} characters exceeds the ${MAX_MESSAGE_ID_LENGTH}-character limit; ` +
          'a truncated ticket id could collide with another thread and never round-trips in the egress lookup',
      );
    }
    if (sanitized.length > 0) return sanitized;
  }
  const digest = createHash('sha256').update(sourceId).digest('hex');
  return `no-id-${digest.slice(0, 16)}`;
}

function sanitizeTicketId(messageId: string): string {
  return messageId.replace(/\s+/g, '');
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

/** Connection settings for one mail account the egress side operates. */
export interface ImapSmtpEgressConfig {
  readonly imap: {
    readonly host: string;
    readonly port: number;
    readonly secure: boolean;
    readonly user: string;
    readonly pass: string;
  };
  readonly smtp: {
    readonly host: string;
    readonly port: number;
    readonly secure: boolean;
  };
  /** The support address replies are sent from. */
  readonly fromAddress: string;
  /** IMAP mailbox gated replies park in (DEC-11). */
  readonly draftsMailbox: string;
}

/**
 * Reads the egress configuration from the environment. The IMAP variables
 * are shared with the ingress poller; SMTP and identity are egress-only.
 *
 * Required: IMAP_HOST, IMAP_PORT, IMAP_USER, IMAP_PASS, SMTP_HOST,
 * SMTP_PORT, EMAIL_FROM_ADDRESS.
 * Optional: IMAP_SECURE (default false), SMTP_SECURE (default true),
 * IMAP_DRAFTS_MAILBOX (default 'Drafts').
 */
export function imapSmtpConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ImapSmtpEgressConfig {
  const required = (name: string): string => {
    const value = env[name];
    if (value === undefined || value === '') {
      throw new Error(`missing required env var ${name} for RELAY_ADAPTER=imap-smtp`);
    }
    return value;
  };
  const flag = (name: string, fallback: boolean): boolean => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    throw new Error(`${name} must be 'true' or 'false', got '${raw}'`);
  };
  const port = (name: string): number => {
    const value = Number(required(name));
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer`);
    }
    return value;
  };

  return {
    imap: {
      host: required('IMAP_HOST'),
      port: port('IMAP_PORT'),
      secure: flag('IMAP_SECURE', false),
      user: required('IMAP_USER'),
      pass: required('IMAP_PASS'),
    },
    smtp: {
      host: required('SMTP_HOST'),
      port: port('SMTP_PORT'),
      secure: flag('SMTP_SECURE', true),
    },
    fromAddress: required('EMAIL_FROM_ADDRESS'),
    draftsMailbox: env['IMAP_DRAFTS_MAILBOX'] ?? 'Drafts',
  };
}

function requireNonEmpty(field: string, value: string | null | undefined): void {
  if (value === undefined || value === null || value.trim() === '') {
    throw new Error(`${field} must not be empty`);
  }
}

/** One header line with CR/LF stripped so a value cannot smuggle headers. */
function headerLine(name: string, rawValue: string): string {
  const value = rawValue.replace(/[\r\n]+/g, ' ').trim();
  return `${name}: ${value}`;
}

/** RFC 2047 base64 encoding for non-ASCII unstructured header values. */
function encodeHeaderValue(value: string): string {
  const safe = value.replace(/[\r\n]+/g, ' ').trim();
  if (/^[\x20-\x7e]*$/.test(safe)) return safe;
  return `=?UTF-8?B?${Buffer.from(safe, 'utf8').toString('base64')}?=`;
}

function wrapBase64(value: Buffer): string {
  const encoded = value.toString('base64');
  return encoded.replace(/(.{76})/g, '$1\r\n');
}

/** Inputs for building one outgoing RFC 5322 reply. */
export interface OutgoingReply {
  readonly fromAddress: string;
  readonly toAddress: string;
  readonly subject: string;
  /** Message-ID this reply answers, or null when unthreaded. */
  readonly inReplyTo: string | null;
  /** Thread chain from root to parent; empty when unthreaded. */
  readonly references: readonly string[];
  readonly body: string;
  readonly disclosure?: string;
  readonly provenance?: DraftReply['provenance'];
}

/**
 * Builds the RFC 5322 text of one reply. Pure so tests can pin the wire
 * format without a mailbox: ASCII-safe headers, a UTF-8 base64 body, real
 * threading headers, and X-Auracle provenance/disclosure headers (DEC-33).
 */
export function buildDraftMessage(reply: OutgoingReply): Buffer {
  requireNonEmpty('reply.fromAddress', reply.fromAddress);
  requireNonEmpty('reply.toAddress', reply.toAddress);
  requireNonEmpty('reply.body', reply.body);

  const domain = reply.fromAddress.includes('@')
    ? reply.fromAddress.split('@')[1]!
    : 'auracle.local';
  const lines = [
    headerLine('From', reply.fromAddress),
    headerLine('To', reply.toAddress),
    // RFC 5322 section 3.6: every message carries a Date. Park time is
    // composition time, and nodemailer sends raw content verbatim, so
    // nothing else would add one.
    `Date: ${new Date().toUTCString()}`,
    `Subject: ${encodeHeaderValue(reply.subject)}`,
    `Message-ID: <${randomUUID()}@${domain}>`,
  ];
  if (reply.inReplyTo !== null && reply.inReplyTo !== '') {
    lines.push(`In-Reply-To: <${reply.inReplyTo}>`);
  }
  if (reply.references.length > 0) {
    lines.push(`References: ${reply.references.map((id) => `<${id}>`).join(' ')}`);
  }
  if (reply.provenance) {
    lines.push(
      headerLine('X-Auracle-Generated-By', reply.provenance.generatedBy),
      headerLine('X-Auracle-Model', reply.provenance.modelId),
      headerLine('X-Auracle-Prompt-Version', reply.provenance.promptVer),
      headerLine('X-Auracle-Generated-At', reply.provenance.generatedAt),
    );
  }
  if (reply.disclosure !== undefined && reply.disclosure.trim() !== '') {
    // Operators write the disclosure and it may be non-ASCII, so it takes
    // the same RFC 2047 encoding as the subject; ASCII stays byte-identical.
    lines.push(`X-Auracle-Disclosure: ${encodeHeaderValue(reply.disclosure)}`);
  }
  lines.push(
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(Buffer.from(reply.body, 'utf8')),
  );
  return Buffer.from(lines.join('\r\n'), 'utf8');
}

/** The originator of the thread a ticket answers, read from the mailbox. */
interface ThreadOriginator {
  readonly fromAddress: string;
  readonly subject: string;
  readonly messageId: string;
  readonly references: readonly string[];
}

/**
 * Finds the customer side of a thread inside INBOX. The adapter derives
 * ticket ids from message ids (deriveTicketId), so the id reverses into a
 * mailbox lookup: search for the message whose Message-ID is exactly the
 * ticket id and answer its author. SEARCH HEADER matches substrings
 * (RFC 3501) and servers deviate on ordering, so every candidate is
 * verified against the parsed Message-ID and a non-exact match is
 * skipped: a mis-addressed reply is the worst failure mode of an email
 * egress, so the lookup fails closed.
 */
async function findThreadOriginator(
  client: ImapFlow,
  ticketId: string,
): Promise<ThreadOriginator> {
  if (ticketId.startsWith('no-id-')) {
    throw new Error(
      `email ticket '${ticketId}' carries no message id, so the reply cannot be addressed`,
    );
  }
  await client.mailboxOpen('INBOX');
  const matches = await client.search({ header: { 'message-id': ticketId } }, { uid: true });
  const candidates = matches !== false ? matches : [];
  for (const uid of candidates) {
    const fetched = await client.fetchOne(String(uid), { source: true }, { uid: true });
    const source = fetched !== false ? fetched.source : undefined;
    if (!source) continue;
    const parsed = normalizeMime(source.toString());
    if (parsed.messageId !== ticketId) continue; // substring hit, not this thread
    if (parsed.fromAddress === null) {
      throw new Error(`message '${ticketId}' has no From address to reply to`);
    }
    return {
      fromAddress: parsed.fromAddress,
      subject: parsed.subject ?? '',
      messageId: parsed.messageId,
      references: parsed.references,
    };
  }
  throw new Error(
    `no message in INBOX carries message-id '${ticketId}', so the reply cannot be addressed`,
  );
}

/** Creates the drafts mailbox when it does not exist yet; a no-op when it does. */
async function ensureMailbox(client: ImapFlow, path: string): Promise<void> {
  await client.mailboxCreate(path).catch(() => undefined);
}

/**
 * Full-duplex egress over one mail account (section 4.4, DEC-06, DEC-11).
 *
 * - `createDraft` appends the approved-pending reply as an RFC 5322 draft
 *   to the Drafts mailbox and returns the appended UID (DEC-11). The
 *   recipient comes from the thread itself: the adapter looks up the
 *   message whose Message-ID is the ticket id and answers its author.
 * - `sendDraft` fetches the draft by UID and sends it verbatim over SMTP.
 *   SMTP accepts no idempotency key, so a repeat call would send again;
 *   that limit is declared (`supportsIdempotencyKey: false`) instead of
 *   faked, and the relay never re-sends a record it already marked sent.
 * - `performAction` throws: an automatic internal write needs the write to
 *   dedupe on the outbox key, and SMTP accepts none. The policy engine
 *   already routes every write of this adapter to the approval path; the
 *   throw is the declared second line of defence.
 * - `readBack` throws: Sent-folder presence after an SMTP failure is a
 *   weak signal, so delivery state stays unknown and the relay escalates
 *   (DEC-30).
 * - `readDraft` reads one parked draft's current body from Drafts for the
 *   approval path (section 4.10). It reads draft state, not delivery
 *   state, so it never conflicts with the DEC-30 limit above.
 */
export class SmtpEgressAdapter implements EgressAdapter, DraftReadBack {
  readonly name = 'imap-smtp';

  readonly capabilities: AdapterCapabilities = IMAP_SMTP_CAPABILITIES;

  constructor(private readonly config: ImapSmtpEgressConfig) {}

  async createDraft(reply: DraftReply): Promise<{ readonly draftExternalId: string }> {
    requireNonEmpty('reply.ticketExternalId', reply.ticketExternalId);
    requireNonEmpty('reply.body', reply.body);
    // The adapter refuses to hold a reply with no disclosure (DEC-14).
    requireNonEmpty('reply.disclosure', reply.disclosure);

    return this.withImap(async (client) => {
      const thread = await findThreadOriginator(client, reply.ticketExternalId);
      const subject = /^re:/i.test(thread.subject)
        ? thread.subject
        : `Re: ${thread.subject}`;
      const raw = buildDraftMessage({
        fromAddress: this.config.fromAddress,
        toAddress: thread.fromAddress,
        subject,
        inReplyTo: thread.messageId,
        references: [...thread.references, thread.messageId],
        body: reply.body,
        disclosure: reply.disclosure,
        provenance: reply.provenance,
      });

      await ensureMailbox(client, this.config.draftsMailbox);
      const appended = await client.append(this.config.draftsMailbox, raw, ['\\Draft']);
      if (!appended || typeof appended.uid !== 'number') {
        throw new Error(
          `IMAP server returned no UID for the appended draft in '${this.config.draftsMailbox}' (UIDPLUS missing), so the draft cannot be referenced`,
        );
      }
      return { draftExternalId: String(appended.uid) };
    });
  }

  async sendDraft(draftExternalId: string, idemKey: string): Promise<{ readonly externalId: string }> {
    requireNonEmpty('draftExternalId', draftExternalId);
    requireNonEmpty('idemKey', idemKey);

    return this.withImap(async (client) => {
      await client.mailboxOpen(this.config.draftsMailbox);
      const fetched = await client.fetchOne(draftExternalId, { source: true }, { uid: true });
      const source = fetched !== false ? fetched.source : undefined;
      if (source === undefined || source === null) {
        throw new Error(
          `no draft with UID '${draftExternalId}' in '${this.config.draftsMailbox}'`,
        );
      }
      const parsed = normalizeMime(source.toString());
      if (parsed.toAddresses.length === 0) {
        throw new Error(`draft '${draftExternalId}' has no To address to send to`);
      }

      const transport = createTransport({
        host: this.config.smtp.host,
        port: this.config.smtp.port,
        secure: this.config.smtp.secure,
      });
      const info = await transport.sendMail({
        envelope: {
          from: parsed.fromAddress ?? this.config.fromAddress,
          to: [...parsed.toAddresses],
        },
        raw: source,
      });

      // Mark the parked draft seen: an operator scanning Drafts sees which
      // replies went out. Best effort only — the send already happened.
      await client
        .messageFlagsAdd(draftExternalId, ['\\Seen'], { uid: true })
        .catch(() => false);

      // Nodemailer generates no messageId for raw sends, so the external
      // id is the draft's own Message-ID (always set by buildDraftMessage);
      // the chain ends in a non-empty draftExternalId, never undefined.
      const externalId: string =
        parsed.messageId ?? info.messageId ?? draftExternalId;
      return { externalId };
    });
  }

  /**
   * Read one parked draft's current body from the Drafts mailbox for the
   * approval path (section 4.10). Null means no such draft sits there:
   * someone deleted it, so the approval refuses instead of fabricating
   * the edit distance. This reads draft state only; delivery read-back
   * stays forbidden (DEC-30), which is why `readBack` still throws.
   */
  async readDraft(draftExternalId: string): Promise<{ readonly body: string } | null> {
    requireNonEmpty('draftExternalId', draftExternalId);

    return this.withImap(async (client) => {
      await client.mailboxOpen(this.config.draftsMailbox);
      const fetched = await client.fetchOne(draftExternalId, { source: true }, { uid: true });
      const source = fetched !== false ? fetched.source : undefined;
      if (source === undefined || source === null) {
        return null;
      }
      return { body: normalizeMime(source.toString()).bodyText };
    });
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

  /** One fresh connection per operation: no pooling, no idle state. */
  private async withImap<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = new ImapFlow({
      host: this.config.imap.host,
      port: this.config.imap.port,
      secure: this.config.imap.secure,
      auth: { user: this.config.imap.user, pass: this.config.imap.pass },
      logger: false,
    });
    try {
      await client.connect();
      return await fn(client);
    } finally {
      try {
        await client.logout();
      } catch {
        client.close();
      }
    }
  }
}
