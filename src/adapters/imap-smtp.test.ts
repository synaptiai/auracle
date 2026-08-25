import { describe, expect, it } from 'vitest';
import {
  ALTERNATIVE_EMAIL,
  BASE64_EMAIL,
  FOLDED_HEADERS_EMAIL,
  HTML_ONLY_EMAIL,
  MIXED_ATTACHMENT_EMAIL,
  NO_IDS_EMAIL,
  QUOTED_PRINTABLE_EMAIL,
  SIMPLE_TEXT_EMAIL,
  THREAD_DEEP_REPLY_EMAIL,
  THREAD_REPLY_EMAIL,
  THREAD_ROOT_EMAIL,
} from './fixtures.js';
import { ImapSmtpAdapter, IMAP_SMTP_CAPABILITIES, SmtpEgressAdapter, deriveTicketId } from './imap-smtp.js';
import { AdapterCapabilityError } from './types.js';

const adapter = new ImapSmtpAdapter();

function normalize(raw: string, sourceId = 'imap-uid-1') {
  return adapter.normalize({ sourceId, raw });
}

describe('ImapSmtpAdapter capabilities', () => {
  it('declares the honest manifest (DEC-06)', () => {
    // Inbound mail carries no idempotency key and SMTP accepts none.
    // SMTP has no draft state and no delivery read-back. Email is free
    // text. Threading headers are real.
    expect(IMAP_SMTP_CAPABILITIES).toStrictEqual({
      supportsIdempotencyKey: false,
      supportsReadBack: false,
      supportsDraftState: false,
      supportsStructuredFields: false,
      supportsThreading: true,
    });
    expect(adapter.capabilities).toBe(IMAP_SMTP_CAPABILITIES);
  });
});

describe('SmtpEgressAdapter declares what it cannot do (DEC-06)', () => {
  const egress = new SmtpEgressAdapter();

  it('carries the same honest manifest as the ingress adapter', () => {
    expect(egress.capabilities).toBe(IMAP_SMTP_CAPABILITIES);
  });

  it('refuses to park or send drafts instead of faking draft state', async () => {
    await expect(egress.createDraft({
      ticketExternalId: 'T-1',
      body: 'text',
      disclosure: 'disclosure',
      provenance: {
        generatedBy: 'auracle',
        modelId: 'm',
        promptVer: 'p',
        generatedAt: '2026-01-01T00:00:00.000Z',
      },
    })).rejects.toThrow(AdapterCapabilityError);

    await expect(egress.sendDraft('draft-1', 'key')).rejects.toThrow(AdapterCapabilityError);
  });

  it('refuses automatic internal writes instead of faking one', async () => {
    await expect(
      egress.performAction('route_ticket', { queue: 'billing' }, 'route_ticket:T-1:k'),
    ).rejects.toThrow(AdapterCapabilityError);
  });

  it('refuses read-back so the relay escalates instead of guessing (DEC-30)', async () => {
    await expect(egress.readBack({ idemKey: 'key' })).rejects.toThrow(AdapterCapabilityError);
  });
});

describe('MIME normalization into Ticket/Message', () => {
  it('normalizes a simple plain-text message', () => {
    const { ticket, message } = normalize(SIMPLE_TEXT_EMAIL);

    expect(ticket).toEqual({
      ticketId: 'order-4471-damaged@example.test',
      subject: 'Order 4471 arrived damaged',
      queue: null,
      status: 'open',
      customerAddress: 'dana.doe@example.test',
    });
    expect(message.messageId).toBe('order-4471-damaged@example.test');
    expect(message.author).toBe('customer');
    expect(message.toAddresses).toEqual(['support@acme.example']);
    expect(message.ccAddresses).toEqual([]);
    expect(message.sentAt).toBe('Mon, 6 Jan 2025 10:04:00 +0000');
    expect(message.bodyText).toBe(
      'The box arrived with a crushed corner.\nTwo tiles are broken. What can you do?',
    );
    expect(message.attachments).toEqual([]);
  });

  it('unfolds continuation header lines and splits addresses', () => {
    const { message } = normalize(FOLDED_HEADERS_EMAIL);

    expect(message.subject).toBe('Invoice 8812 question about the prorated charge');
    expect(message.fromAddress).toBe('dana.doe@example.test');
    expect(message.toAddresses).toEqual(['support@acme.example']);
    expect(message.ccAddresses).toEqual([
      'billing@acme.example',
      'dana.doe@example.test',
    ]);
  });

  it('decodes quoted-printable UTF-8 bodies and soft line breaks', () => {
    const { message } = normalize(QUOTED_PRINTABLE_EMAIL);

    expect(message.bodyText).toBe(
      'My espresso machine order #2231 has not arrived. The tracking page says delivered but nothing is here.',
    );
  });

  it('decodes RFC 2047 encoded words in Subject and From display names', () => {
    const { ticket, message } = normalize(QUOTED_PRINTABLE_EMAIL);

    expect(ticket.subject).toBe('Café order missing');
    expect(message.subject).toBe('Café order missing');
    // Display name decodes to text; the bare address is untouched.
    expect(message.fromAddress).toBe('renee.dupont@example.test');
  });

  it('leaves undecodable encoded words unchanged', () => {
    const raw = [
      'From: x@example.test',
      'To: support@acme.example',
      'Subject: =?x-unknown-charset?Q?mystery?= order',
      'Message-ID: <bad-charset@example.test>',
      '',
      'Body.',
    ].join('\r\n');
    const { message } = normalize(raw);
    expect(message.subject).toBe('=?x-unknown-charset?Q?mystery?= order');
  });

  it('decodes base64 transfer encoding', () => {
    const { message } = normalize(BASE64_EMAIL);

    expect(message.bodyText).toBe('Password reset link expired.');
  });

  it('prefers the text/plain leaf of multipart/alternative', () => {
    const { message } = normalize(ALTERNATIVE_EMAIL);

    expect(message.bodyText).toBe('Where is my refund for order 9981?');
  });

  it('falls back to stripped HTML when no text/plain part exists', () => {
    const { message } = normalize(HTML_ONLY_EMAIL);

    expect(message.bodyText).toBe(
      'The "Sign in" button sends me back\nto the login page. Account ID <ACME-77>.',
    );
  });

  it('extracts attachment metadata from multipart/mixed', () => {
    const { message } = normalize(MIXED_ATTACHMENT_EMAIL);

    expect(message.bodyText).toBe('Attached is the receipt. I was charged twice.');
    expect(message.attachments).toHaveLength(1);
    const attachment = message.attachments[0];
    expect(attachment?.filename).toBe('receipt-5512.pdf');
    expect(attachment?.contentType).toBe('application/pdf');
    expect(attachment?.sizeBytes).toBeGreaterThan(0);
  });
});

describe('ticket identity from threading headers', () => {
  it('keys root and replies onto the same ticket id', () => {
    const root = normalize(THREAD_ROOT_EMAIL);
    const reply = normalize(THREAD_REPLY_EMAIL, 'imap-uid-2');
    const deepReply = normalize(THREAD_DEEP_REPLY_EMAIL, 'imap-uid-3');

    const expectedId = 'thread-root@acme.example';
    expect(root.ticket.ticketId).toBe(expectedId);
    expect(reply.ticket.ticketId).toBe(expectedId);
    expect(deepReply.ticket.ticketId).toBe(expectedId);

    expect(reply.message.inReplyTo).toBe('thread-root@acme.example');
    expect(reply.message.references).toEqual(['thread-root@acme.example']);
    expect(deepReply.message.references).toEqual([
      'thread-root@acme.example',
      'thread-reply-1@acme.example',
      'thread-reply-2@acme.example',
    ]);
  });

  it('falls back to a deterministic hash of the source id without ids', () => {
    const first = normalize(NO_IDS_EMAIL, 'imap-uid-9');
    const reingested = normalize(NO_IDS_EMAIL, 'imap-uid-9');
    const otherEvent = normalize(NO_IDS_EMAIL, 'imap-uid-10');

    expect(first.message.messageId).toBeNull();
    expect(reingested.ticket.ticketId).toBe(first.ticket.ticketId);
    expect(otherEvent.ticket.ticketId).not.toBe(first.ticket.ticketId);
    expect(first.ticket.ticketId).toMatch(/^no-id-[0-9a-f]{16}$/);
  });

  it('derives stable ids through deriveTicketId directly', () => {
    expect(deriveTicketId('root@example.test', 'any-source')).toBe(
      'root@example.test',
    );
    expect(deriveTicketId(null, 'source-a')).toBe(deriveTicketId(null, 'source-a'));
  });
});
