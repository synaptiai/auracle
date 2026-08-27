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
import {
  ImapSmtpAdapter,
  IMAP_SMTP_CAPABILITIES,
  SmtpEgressAdapter,
  buildDraftMessage,
  deriveTicketId,
  imapSmtpConfigFromEnv,
} from './imap-smtp.js';
import { AdapterCapabilityError } from './types.js';

const adapter = new ImapSmtpAdapter();

function normalize(raw: string, sourceId = 'imap-uid-1') {
  return adapter.normalize({ sourceId, raw });
}

describe('ImapSmtpAdapter capabilities', () => {
  it('declares the honest manifest (DEC-06)', () => {
    // Inbound mail carries no idempotency key and SMTP accepts none.
    // Replies park in the Drafts mailbox, so draft state is real. There
    // is no delivery read-back: Sent-folder presence after an SMTP
    // failure is a weak signal (DEC-30). Email is free text. Threading
    // headers are real.
    expect(IMAP_SMTP_CAPABILITIES).toStrictEqual({
      supportsIdempotencyKey: false,
      supportsReadBack: false,
      supportsDraftState: true,
      supportsStructuredFields: false,
      supportsThreading: true,
    });
    expect(adapter.capabilities).toBe(IMAP_SMTP_CAPABILITIES);
  });
});

describe('SmtpEgressAdapter declares what it cannot do (DEC-06)', () => {
  const egress = new SmtpEgressAdapter({
    imap: { host: 'imap.example.test', port: 143, secure: false, user: 'u', pass: 'p' },
    smtp: { host: 'smtp.example.test', port: 25, secure: false },
    fromAddress: 'support@acme.example',
    draftsMailbox: 'Drafts',
  });

  it('carries the same honest manifest as the ingress adapter', () => {
    expect(egress.capabilities).toBe(IMAP_SMTP_CAPABILITIES);
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

describe('draft message construction', () => {
  const provenance = {
    generatedBy: 'auracle',
    modelId: 'm',
    promptVer: 'p',
    generatedAt: '2026-01-01T00:00:00.000Z',
  };

  function reply(overrides: Partial<Parameters<typeof buildDraftMessage>[0]> = {}) {
    return {
      fromAddress: 'support@acme.example',
      toAddress: 'dana.doe@example.test',
      subject: 'Re: Order 4471 arrived damaged',
      inReplyTo: 'order-4471-damaged@example.test',
      references: ['thread-root@acme.example'],
      body: 'We are sorry. Here is what to do.',
      disclosure: 'Drafted by an automated assistant.',
      provenance,
      ...overrides,
    };
  }

  it('builds ASCII headers, threading headers and a base64 UTF-8 body', () => {
    const raw = buildDraftMessage(reply()).toString('utf8');
    const lines = raw.split('\r\n');

    expect(lines[0]).toBe('From: support@acme.example');
    expect(lines[1]).toBe('To: dana.doe@example.test');
    // RFC 5322 section 3.6: every message carries a Date. nodemailer sends
    // raw content verbatim, so the draft itself must carry one.
    expect(lines[2]).toMatch(/^Date: [A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/);
    expect(lines[3]).toBe('Subject: Re: Order 4471 arrived damaged');
    expect(lines[4]).toMatch(/^Message-ID: <[0-9a-f-]+@acme\.example>$/);
    expect(lines).toContain('In-Reply-To: <order-4471-damaged@example.test>');
    expect(lines).toContain('References: <thread-root@acme.example>');
    expect(lines).toContain('Content-Type: text/plain; charset=utf-8');
    expect(lines).toContain('Content-Transfer-Encoding: base64');

    // The base64 body decodes back to the exact reply text.
    const separator = lines.indexOf('');
    const encoded = lines.slice(separator + 1).join('');
    expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe(
      'We are sorry. Here is what to do.',
    );
  });

  it('carries disclosure and provenance as X-Auracle headers (DEC-33)', () => {
    const raw = buildDraftMessage(reply()).toString('utf8');

    expect(raw).toContain('X-Auracle-Disclosure: Drafted by an automated assistant.');
    expect(raw).toContain('X-Auracle-Generated-By: auracle');
    expect(raw).toContain('X-Auracle-Model: m');
    expect(raw).toContain('X-Auracle-Prompt-Version: p');
    expect(raw).toContain('X-Auracle-Generated-At: 2026-01-01T00:00:00.000Z');
  });

  it('encodes non-ASCII subjects as RFC 2047 words and drops them otherwise', () => {
    const ascii = buildDraftMessage(reply({ subject: 'Re: plain' })).toString();
    expect(ascii).toContain('Subject: Re: plain\r\n');

    const unicode = buildDraftMessage(reply({ subject: 'Re: Café order missing' }));
    const match = /=\?UTF-8\?B\?(.+?)\?=/.exec(unicode.toString());
    expect(match).not.toBeNull();
    expect(Buffer.from(match![1]!, 'base64').toString('utf8')).toBe(
      'Re: Café order missing',
    );
  });

  it('encodes a non-ASCII disclosure as an RFC 2047 word, ASCII verbatim', () => {
    const ascii = buildDraftMessage(reply({ disclosure: 'Drafted by an automated assistant.' }));
    expect(ascii.toString()).toContain(
      'X-Auracle-Disclosure: Drafted by an automated assistant.',
    );

    const unicode = buildDraftMessage(
      reply({ disclosure: 'Automatisch verfasst und von einer Person geprüft.' }),
    ).toString();
    const match = /X-Auracle-Disclosure: =\?UTF-8\?B\?(.+?)\?=\r?\n/.exec(unicode);
    expect(match).not.toBeNull();
    expect(Buffer.from(match![1]!, 'base64').toString('utf8')).toBe(
      'Automatisch verfasst und von einer Person geprüft.',
    );
  });

  it('strips CR/LF from header values so a value cannot smuggle headers', () => {
    const hostile = buildDraftMessage(
      reply({
        toAddress: 'dana.doe@example.test\r\nBcc: attacker@evil.example',
        disclosure: 'fine\r\nX-Evil: yes',
      }),
    ).toString();

    // Newlines collapse to spaces: every injected header becomes part of
    // the same physical line.
    expect(hostile).not.toMatch(/\r\n(Bcc|X-Evil):/);
    expect(hostile).toContain('To: dana.doe@example.test Bcc: attacker@evil.example');
    expect(hostile).toContain('X-Auracle-Disclosure: fine X-Evil: yes');
  });

  it('omits optional headers when no thread or metadata is present', () => {
    const raw = buildDraftMessage(
      reply({ inReplyTo: null, references: [], disclosure: undefined, provenance: undefined }),
    ).toString('utf8');

    expect(raw).not.toContain('In-Reply-To:');
    expect(raw).not.toContain('References:');
    expect(raw).not.toContain('X-Auracle-');
  });

  it('refuses empty core fields instead of building an unsendable message', () => {
    expect(() => buildDraftMessage(reply({ fromAddress: '' }))).toThrow('fromAddress');
    expect(() => buildDraftMessage(reply({ toAddress: '  ' }))).toThrow('toAddress');
    expect(() => buildDraftMessage(reply({ body: '' }))).toThrow('body');
  });
});

describe('imapSmtpConfigFromEnv', () => {
  function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
    return {
      IMAP_HOST: 'imap.example.test',
      IMAP_PORT: '143',
      IMAP_USER: 'support@acme.example',
      IMAP_PASS: 'pass',
      SMTP_HOST: 'smtp.example.test',
      SMTP_PORT: '587',
      EMAIL_FROM_ADDRESS: 'support@acme.example',
      ...overrides,
    };
  }

  it('reads required vars and applies documented defaults', () => {
    expect(imapSmtpConfigFromEnv(env())).toEqual({
      imap: { host: 'imap.example.test', port: 143, secure: false, user: 'support@acme.example', pass: 'pass' },
      smtp: { host: 'smtp.example.test', port: 587, secure: true },
      fromAddress: 'support@acme.example',
      draftsMailbox: 'Drafts',
    });
  });

  it('honors the optional overrides', () => {
    const config = imapSmtpConfigFromEnv(env({
      IMAP_SECURE: 'true',
      SMTP_SECURE: 'false',
      IMAP_DRAFTS_MAILBOX: 'INBOX/Drafts',
    }));
    expect(config.imap.secure).toBe(true);
    expect(config.smtp.secure).toBe(false);
    expect(config.draftsMailbox).toBe('INBOX/Drafts');
  });

  it('throws naming the first missing variable', () => {
    const partial = env({ SMTP_HOST: undefined });
    expect(() => imapSmtpConfigFromEnv(partial)).toThrow('SMTP_HOST');
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

  it('refuses ids over 200 characters instead of truncating them', () => {
    // A truncated id could collide with another thread sharing the prefix
    // and never round-trips in the egress thread lookup, so derivation
    // refuses loudly rather than producing an unanswerable ticket.
    const overLong = 'a'.repeat(201) + '@example.test';
    expect(() => deriveTicketId(overLong, 'src')).toThrow(
      /exceeds the 200-character limit/,
    );

    const raw = [
      'From: x@example.test',
      'To: support@acme.example',
      'Subject: pathological id',
      `Message-ID: <${overLong}>`,
      '',
      'Body.',
    ].join('\r\n');
    expect(() => normalize(raw)).toThrow(/exceeds the 200-character limit/);
  });

  it('accepts a message id of exactly 200 characters', () => {
    const exact = 'b'.repeat(200);
    expect(deriveTicketId(exact, 'src')).toBe(exact);
  });
});
