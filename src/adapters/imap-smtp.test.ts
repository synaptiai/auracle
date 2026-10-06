import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';

import { describe, expect, it, vi } from 'vitest';
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
  IMAP_LOGOUT_GRACE_MS,
  IDEM_KEY_HEADER,
  IMAP_MARK_SEEN_BUDGET_MS,
  IMAP_OPERATION_TIMEOUT_MS,
  IMAP_SMTP_CAPABILITIES,
  SmtpEgressAdapter,
  buildDraftMessage,
  deriveTicketId,
  findDraftByIdemKey,
  findThreadOriginator,
  imapSmtpConfigFromEnv,
  readDraftSource,
} from './imap-smtp.js';
import type { FetchMessageObject, MailboxObject } from 'imapflow';

import type { ImapReadClient } from './imap-smtp.js';
import { AdapterCapabilityError, NothingSentError, PermanentEgressError } from './types.js';

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
      supportsLedgerReply: false,
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

  it('declares no internal class, so a consumer refuses one at startup', () => {
    expect(egress.performs.size).toBe(0);
  });

  it('refuses automatic internal writes instead of faking one', async () => {
    await expect(
      egress.performAction('route_ticket', { queue: 'billing' }, 'route_ticket:T-1:k'),
    ).rejects.toThrow(AdapterCapabilityError);
  });

  it('refuses read-back so the relay escalates instead of guessing (DEC-30)', async () => {
    await expect(egress.readBack({ idemKey: 'key' })).rejects.toThrow(AdapterCapabilityError);
  });

  // DEC-44, and the maintainer ruling of 2026-09-14: mail keeps the DEC-40
  // draft path. Any mail client can send any message from any mailbox, so no
  // mailbox holds a copy the helpdesk cannot send, and the console offers no
  // editor on this channel.
  it('declares no ledger reply, because any mailbox can send the parked copy', async () => {
    expect(egress.capabilities.supportsLedgerReply).toBe(false);
    await expect(
      egress.sendLedgerReply(
        {
          draftExternalId: '7',
          bodyText: 'a reply',
          disclosure: 'drafted by an automated assistant',
          provenance: {
            generatedBy: 'auracle',
            modelId: 'test/model-v1',
            promptVer: 'p-2026-01',
            generatedAt: '2026-01-02T03:04:05Z',
          },
        },
        'key',
      ),
    ).rejects.toThrow(AdapterCapabilityError);
  });
});

/** A parked draft as the fake IMAP server holds it. Synthetic (DEC-18). */
const PARKED_SOURCE = 'From: support@example.invalid\r\nTo: customer@example.invalid\r\n'
  + 'Message-ID: <draft-7@example.invalid>\r\nSubject: Re: synthetic\r\n\r\nYour refund is on its way.\r\n';

/** The same draft with nobody to send it to. */
const UNADDRESSED_SOURCE = 'From: support@example.invalid\r\n'
  + 'Message-ID: <draft-7@example.invalid>\r\nSubject: Re: synthetic\r\n\r\nYour refund is on its way.\r\n';

type Reaction =
  | 'answer' | 'reset' | 'stall' | 'nothing' | 'refuse' | 'other-uid' | 'bodiless' | 'unaddressed'
  | 'bad-credentials' | 'try-later' | 'throttled' | 'select-later' | 'long-refusal';

/**
 * An IMAP server that speaks just enough of the protocol for ImapFlow, holds
 * one draft under UID 7, and reacts to the named commands as told: it resets
 * the connection or stops answering. Synthetic throughout (DEC-18).
 */
async function fakeImap(reactions: Readonly<Record<string, Reaction>> = {}): Promise<{
  server: Server;
  port: number;
  opened: () => number;
  closed: () => number;
  openedAt: () => readonly number[];
  logoutAt: () => readonly number[];
  storeAt: () => readonly number[];
}> {
  let opens = 0;
  let closes = 0;
  const openedAt: number[] = [];
  const logoutAt: number[] = [];
  const storeAt: number[] = [];
  const server = createServer((sock: Socket) => {
    opens += 1;
    openedAt.push(Date.now());
    sock.on('error', () => undefined);
    sock.on('close', () => { closes += 1; });
    sock.write('* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN UIDPLUS] ready\r\n');
    let buffered = '';
    sock.on('data', (chunk) => {
      buffered += chunk.toString();
      let end: number;
      while ((end = buffered.indexOf('\r\n')) !== -1) {
        const [tag, verb, sub] = buffered.slice(0, end).split(' ');
        buffered = buffered.slice(end + 2);
        const upper = (verb ?? '').toUpperCase();
        const command = upper === 'UID' ? `UID ${(sub ?? '').toUpperCase()}` : upper;
        if (command === 'LOGOUT') logoutAt.push(Date.now());
        if (command === 'UID STORE') storeAt.push(Date.now());
        const reaction = reactions[command] ?? 'answer';
        if (reaction === 'reset') {
          sock.resetAndDestroy();
          return;
        }
        if (reaction === 'stall') continue;
        if (reaction === 'nothing') {
          sock.write(`${tag} OK\r\n`);
          continue;
        }
        if (reaction === 'refuse') {
          sock.write(`${tag} NO refused\r\n`);
          continue;
        }
        if (reaction === 'other-uid') {
          // An unsolicited flag update for another message, then the draft.
          sock.write(`* 2 FETCH (UID 9 FLAGS (\\Seen))\r\n* 1 FETCH (UID 7 BODY[] {${Buffer.byteLength(PARKED_SOURCE)}}\r\n${PARKED_SOURCE})\r\n${tag} OK fetched\r\n`);
          continue;
        }
        // RFC 5530 response codes: a refusal of the credentials, and one that
        // asks the client to try again later.
        if (reaction === 'bad-credentials') {
          sock.write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
          continue;
        }
        if (reaction === 'try-later') {
          sock.write(`${tag} NO [UNAVAILABLE] Temporary authentication failure\r\n`);
          continue;
        }
        // Microsoft 365's throttle reply, which imapflow marks ETHROTTLE.
        if (reaction === 'throttled') {
          sock.write(`${tag} BAD Request is throttled. Suggested Backoff Time: 20 milliseconds\r\n`);
          continue;
        }
        if (reaction === 'select-later') {
          sock.write(`${tag} NO [UNAVAILABLE] backend down, try later\r\n`);
          continue;
        }
        if (reaction === 'long-refusal') {
          sock.write(`${tag} NO ${'x'.repeat(300)}\r\n`);
          continue;
        }
        if (reaction === 'unaddressed') {
          sock.write(`* 1 FETCH (UID 7 BODY[] {${Buffer.byteLength(UNADDRESSED_SOURCE)}}\r\n${UNADDRESSED_SOURCE})\r\n${tag} OK fetched\r\n`);
          continue;
        }
        if (reaction === 'bodiless') {
          // The draft's row, without the body that was asked for.
          sock.write(`* 1 FETCH (UID 7 FLAGS ())\r\n${tag} OK fetched\r\n`);
          continue;
        }
        if (command === 'CAPABILITY') sock.write(`* CAPABILITY IMAP4rev1 AUTH=PLAIN UIDPLUS\r\n${tag} OK done\r\n`);
        else if (command === 'SELECT') {
          sock.write(`* 1 EXISTS\r\n* OK [UIDVALIDITY 1] v\r\n* OK [UIDNEXT 8] n\r\n${tag} OK [READ-WRITE] selected\r\n`);
        } else if (command === 'UID FETCH') {
          sock.write(`* 1 FETCH (UID 7 BODY[] {${Buffer.byteLength(PARKED_SOURCE)}}\r\n${PARKED_SOURCE})\r\n${tag} OK fetched\r\n`);
        } else if (command === 'LOGOUT') {
          sock.write(`* BYE\r\n${tag} OK\r\n`);
          sock.end();
        } else sock.write(`${tag} OK\r\n`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server, port: (server.address() as AddressInfo).port,
    opened: () => opens, closed: () => closes,
    openedAt: () => openedAt, logoutAt: () => logoutAt, storeAt: () => storeAt,
  };
}

/** An SMTP server that accepts every message and counts them. Synthetic (DEC-18). */
async function fakeSmtp(): Promise<{ server: Server; port: number; accepted: () => number }> {
  let accepted = 0;
  const server = createServer((sock: Socket) => {
    sock.on('error', () => undefined);
    sock.write('220 synthetic ESMTP\r\n');
    let data = false;
    let buffered = '';
    sock.on('data', (chunk) => {
      buffered += chunk.toString();
      let end: number;
      while ((end = buffered.indexOf('\r\n')) !== -1) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        if (data) {
          if (line === '.') {
            data = false;
            accepted += 1;
            sock.write('250 queued\r\n');
          }
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO') sock.write('250-synthetic\r\n250 8BITMIME\r\n');
        else if (verb === 'DATA') {
          data = true;
          sock.write('354 go\r\n');
        } else if (verb === 'QUIT') {
          sock.write('221 bye\r\n');
          sock.end();
        } else sock.write('250 ok\r\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port, accepted: () => accepted };
}

function egressOn(port: number, timeoutMs?: number, smtpPort = 1): SmtpEgressAdapter {
  return new SmtpEgressAdapter({
    imap: { host: '127.0.0.1', port, secure: false, user: 'synthetic-user', pass: 'synthetic-pass' },
    smtp: { host: '127.0.0.1', port: smtpPort, secure: false },
    fromAddress: 'support@example.invalid',
    draftsMailbox: 'Drafts',
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

describe('the IMAP connection a draft read opens (issue #102)', () => {
  // ImapFlow reports a dropped connection as an 'error' event. With no
  // listener Node rethrows it outside every promise, and the long-running
  // console that reads drafts back died with it.
  it('rejects when the connection resets mid-read, and the process stays up', async () => {
    const { server, port } = await fakeImap({ SELECT: 'reset' });
    try {
      await expect(egressOn(port).readDraft('7')).rejects.toThrow();
    } finally {
      server.close();
    }
  });

  // The operation is done once its result is in hand. A connection that
  // drops while it logs out does not take that result away.
  it('keeps a read that finished when the connection resets on logout', async () => {
    const { server, port } = await fakeImap({ LOGOUT: 'reset' });
    try {
      await expect(egressOn(port, 2_000).readDraft('7')).resolves.toEqual({ body: 'Your refund is on its way.' });
    } finally {
      server.close();
    }
  });

  // A server that never answers ends the read at the adapter's own bound,
  // not at ImapFlow's five-minute socket default.
  it('gives up on a server that accepts and never greets, within its bound', async () => {
    const server = createServer((sock) => { sock.on('error', () => undefined); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const started = Date.now();
    try {
      await expect(egressOn(port, 300).readDraft('7')).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      server.close();
    }
  });

  // A server that greets, logs in and then stops answering holds an idle
  // socket. The bound covers that wait as well as the greeting.
  it('gives up on a server that stops answering after login, within its bound', async () => {
    const { server, port } = await fakeImap({ SELECT: 'stall' });
    const started = Date.now();
    try {
      await expect(egressOn(port, 300).readDraft('7')).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      server.close();
    }
  });

  // A caller that stopped waiting says so, and the connection closes then,
  // rather than at the adapter's bound. The console gives up long before it.
  it('closes the connection when the caller aborts the read', async () => {
    const { server, port, closed } = await fakeImap({ SELECT: 'stall' });
    const controller = new AbortController();
    try {
      const started = Date.now();
      const read = egressOn(port, 10_000).readDraft('7', { signal: controller.signal });
      setTimeout(() => controller.abort(new Error('the console gave up')), 200);
      await expect(read).rejects.toThrow('the console gave up');
      expect(Date.now() - started).toBeLessThan(5_000);
      for (let i = 0; i < 50 && closed() === 0; i += 1) await new Promise((r) => setTimeout(r, 20));
      expect(closed()).toBe(1);
    } finally {
      server.close();
    }
  });

  // A caller that already stopped waiting gets no connection opened for it.
  it('opens no connection for a read whose caller has already aborted', async () => {
    const { server, port, opened } = await fakeImap();
    try {
      const controller = new AbortController();
      controller.abort(new Error('the console gave up'));
      await expect(egressOn(port, 2_000).readDraft('7', { signal: controller.signal }))
        .rejects.toThrow('the console gave up');
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(opened()).toBe(0);
    } finally {
      server.close();
    }
  });

  // The body is in hand once it is fetched. Logging out is tidying, so a
  // server slow to answer LOGOUT does not hold the read.
  it('waits only a short grace for the logout, whatever the bound', async () => {
    const { server, port, closed } = await fakeImap({ LOGOUT: 'stall' });
    const started = Date.now();
    try {
      await expect(egressOn(port, 10_000).readDraft('7')).resolves.toEqual({ body: 'Your refund is on its way.' });
      const took = Date.now() - started;
      expect(took).toBeGreaterThanOrEqual(IMAP_LOGOUT_GRACE_MS - 50);
      expect(took).toBeLessThan(IMAP_LOGOUT_GRACE_MS + 1_500);
      // Closed when the grace ran out, not left for the socket bound.
      for (let i = 0; i < 50 && closed() === 0; i += 1) await new Promise((r) => setTimeout(r, 20));
      expect(closed()).toBe(1);
    } finally {
      server.close();
    }
  });

  // Nothing runs behind a finished operation, so the next one opens its
  // connection at once. A console giving each read four seconds is never kept
  // waiting by the last read's logout.
  it('opens the next connection without waiting behind a stalled logout', async () => {
    const imap = await fakeImap({ LOGOUT: 'stall' });
    try {
      const adapter = egressOn(imap.port, 10_000);
      await expect(adapter.readDraft('7')).resolves.toEqual({ body: 'Your refund is on its way.' });
      const firstReturned = Date.now();
      await expect(adapter.readDraft('7')).resolves.toEqual({ body: 'Your refund is on its way.' });
      // The second connection opens as soon as the first read returns: no
      // queue holds it back behind anything the first one left running.
      const [, secondOpened] = imap.openedAt();
      // Well under the logout grace, which is what a queue would add.
      expect(secondOpened! - firstReturned).toBeLessThan(IMAP_LOGOUT_GRACE_MS * 0.6);
    } finally {
      imap.server.close();
    }
  });

  // A draft that is not there never sends on a retry. The FreeScout adapter
  // says the same of a missing draft. It does not prove that nothing reached
  // the customer: a person can send the draft from a mail client, which moves
  // it out of Drafts. So it is not reported as a send that sent nothing (#159).
  it('refuses a missing draft as permanent, and never as a send that sent nothing', async () => {
    const { server, port } = await fakeImap({ 'UID FETCH': 'nothing' });
    try {
      const failure = await egressOn(port, 2_000).sendDraft('7', 'refund:41:v1').catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(PermanentEgressError);
      expect(failure).not.toBeInstanceOf(NothingSentError);
      expect((failure as Error).message).toBe("no draft with UID '7' in 'Drafts'");
    } finally {
      server.close();
    }
  });

  // The SMTP bounds, which the send path sets from the same configuration as
  // the IMAP ones. A send runs inside the relay's transaction, so a server
  // that stops answering mid-send holds the run's row lock for as long as
  // this takes: left unset, nodemailer's own defaults allow ten minutes.
  it('bounds a send to a server that never answers, rather than waiting', async () => {
    const imap = await fakeImap();
    // Accepts the connection and says nothing: no greeting, ever.
    const silent = createServer((sock: Socket) => {
      sock.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const port = (silent.address() as AddressInfo).port;
    try {
      const started = Date.now();
      const failure = await egressOn(imap.port, 1_000, port)
        .sendDraft('7', 'refund:41:v1')
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      // Bounded by the configuration and not by nodemailer's ten-minute
      // default, which would hold the relay's transaction for the same span.
      expect(Date.now() - started).toBeLessThan(IMAP_OPERATION_TIMEOUT_MS);
    } finally {
      silent.close();
      imap.server.close();
    }
  });

  // SMTP has no read-back, so a send reported as failed is escalated as an
  // unknown delivery. A send that completed stays a send, whatever the IMAP
  // connection does while the draft is marked seen afterwards. And it returns
  // at once: the relay records the send only when this returns, and a relay
  // killed in between would send the reply again.
  it('reports a completed send as sent at once when marking the draft seen stalls', async () => {
    const imap = await fakeImap({ 'UID STORE': 'stall' });
    const smtp = await fakeSmtp();
    try {
      const sent = await egressOn(imap.port, 10_000, smtp.port).sendDraft('7', 'refund:41:v1');
      const returned = Date.now();
      // Anchored to the server, not to a wall-clock limit: a send that waited
      // for marking would return a whole budget after the STORE arrived.
      for (let i = 0; i < 200 && imap.storeAt().length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
      const [stored] = imap.storeAt();
      expect(returned - stored!).toBeLessThan(IMAP_MARK_SEEN_BUDGET_MS / 2);
      // The mark-seen connection it left still closes within its own budget.
      for (let i = 0; i < 200 && imap.closed() < 2; i += 1) await new Promise((r) => setTimeout(r, 25));
      expect(imap.closed()).toBe(2);
      // The draft's own Message-ID, which the MIME reader strips of its brackets.
      expect(sent).toEqual({ externalId: 'draft-7@example.invalid' });
      expect(smtp.accepted()).toBe(1);
    } finally {
      imap.server.close();
      smtp.server.close();
    }
  });

  it('names a draft it could not mark seen, and still reports the send', async () => {
    // Best effort, so it never fails the send. A refusal on every send would
    // otherwise leave Drafts showing no reply as sent, with no line saying why.
    const imap = await fakeImap({ 'UID STORE': 'refuse' });
    const smtp = await fakeSmtp();
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    try {
      const sent = await egressOn(imap.port, 10_000, smtp.port).sendDraft('7', 'refund:41:v1');
      expect(sent).toEqual({ externalId: 'draft-7@example.invalid' });
      for (let i = 0; i < 200 && lines.length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
      expect(lines.map((line) => JSON.parse(line) as Record<string, unknown>)).toEqual([
        expect.objectContaining({
          event: 'draft_mark_seen_failed',
          draft: '7',
          error: 'the server refused the STORE',
        }),
      ]);
    } finally {
      spy.mockRestore();
      imap.server.close();
      smtp.server.close();
    }
  });

  it('names a mark that failed on the wire, and still reports the send', async () => {
    // A connection reset rejects rather than answering false, so this is the
    // other branch of the same rule.
    const imap = await fakeImap({ 'UID STORE': 'reset' });
    const smtp = await fakeSmtp();
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    try {
      const sent = await egressOn(imap.port, 10_000, smtp.port).sendDraft('7', 'refund:41:v1');
      expect(sent).toEqual({ externalId: 'draft-7@example.invalid' });
      for (let i = 0; i < 200 && lines.length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
      const entries = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(entries).toEqual([
        expect.objectContaining({ event: 'draft_mark_seen_failed', draft: '7' }),
      ]);
    } finally {
      spy.mockRestore();
      imap.server.close();
      smtp.server.close();
    }
  });

  it('sends the draft from its own row, past an unsolicited one', async () => {
    const imap = await fakeImap({ 'UID FETCH': 'other-uid' });
    const smtp = await fakeSmtp();
    try {
      const sent = await egressOn(imap.port, 10_000, smtp.port).sendDraft('7', 'refund:41:v1');
      expect(sent).toEqual({ externalId: 'draft-7@example.invalid' });
      expect(smtp.accepted()).toBe(1);
    } finally {
      imap.server.close();
      smtp.server.close();
    }
  });

  it('sends nothing when the draft row comes without its body, and says so', async () => {
    // Read as a missing draft this escalates as gone. It is a short answer,
    // and SMTP must not see a message.
    const imap = await fakeImap({ 'UID FETCH': 'bodiless' });
    const smtp = await fakeSmtp();
    try {
      const error = await egressOn(imap.port, 10_000, smtp.port)
        .sendDraft('7', 'refund:41:v1')
        .catch((caught: unknown) => caught);
      // Transient and unsent: the relay leaves the record for the next scan.
      expect(error).toBeInstanceOf(NothingSentError);
      expect((error as NothingSentError).permanent).toBe(false);
      expect((error as Error).message).toMatch(/^no SMTP send was attempted: .*without its body; the draft could not be read$/);
      expect(smtp.accepted()).toBe(0);
    } finally {
      imap.server.close();
      smtp.server.close();
    }
  });

  // Issue #159. A draft that names nobody could never have been sent, by this
  // relay or from a mail client, so nothing reached a recipient on any attempt.
  it('reports a draft with no To address as a permanent send that sent nothing', async () => {
    const imap = await fakeImap({ 'UID FETCH': 'unaddressed' });
    const smtp = await fakeSmtp();
    try {
      const error = await egressOn(imap.port, 10_000, smtp.port)
        .sendDraft('7', 'refund:41:v1')
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(NothingSentError);
      expect((error as NothingSentError).permanent).toBe(true);
      expect((error as Error).message).toBe("no SMTP send was attempted: draft '7' has no To address to send to");
      expect(smtp.accepted()).toBe(0);
    } finally {
      imap.server.close();
      smtp.server.close();
    }
  });

  // A refused login reads nothing, so it proves nothing about an earlier
  // attempt: a relay that stopped after SMTP, or a person sending from a mail
  // client, leaves no trace the relay can see. So it is a plain fault, and
  // DEC-30 escalates it as an unknown delivery.
  it('does not report a refused login as a send that sent nothing', async () => {
    for (const reaction of ['bad-credentials', 'refuse'] as const) {
      const imap = await fakeImap({ LOGIN: reaction, AUTHENTICATE: reaction });
      const smtp = await fakeSmtp();
      try {
        const error = await egressOn(imap.port, 10_000, smtp.port)
          .sendDraft('7', 'refund:41:v1')
          .catch((caught: unknown) => caught);
        expect(error, reaction).toBeInstanceOf(Error);
        expect(error, reaction).not.toBeInstanceOf(NothingSentError);
        expect((error as Error).message, reaction).toBe(
          reaction === 'refuse'
            ? 'the IMAP server refused the login: refused'
            : 'the IMAP server refused the login: Invalid credentials',
        );
        expect(smtp.accepted(), reaction).toBe(0);
      } finally {
        imap.server.close();
        smtp.server.close();
      }
    }
  });

  // RFC 5530: [UNAVAILABLE] asks the client to try again later, and nothing
  // was read, so nothing was sent on this attempt. The record waits.
  it('reports a login refused for now as a transient send that sent nothing', async () => {
    const imap = await fakeImap({ LOGIN: 'try-later', AUTHENTICATE: 'try-later' });
    const smtp = await fakeSmtp();
    try {
      const error = await egressOn(imap.port, 10_000, smtp.port)
        .sendDraft('7', 'refund:41:v1')
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(NothingSentError);
      expect((error as NothingSentError).permanent).toBe(false);
      expect((error as Error).message).toBe(
        'no SMTP send was attempted: the IMAP server refused the login for now: Temporary authentication failure',
      );
      expect(smtp.accepted()).toBe(0);
    } finally {
      imap.server.close();
      smtp.server.close();
    }
  });

  // A refusal that asks for a later try waits, whatever the command. A
  // throttle, RFC 5530's UNAVAILABLE on SELECT, and a connection reset during
  // LOGIN each read nothing and say nothing about the draft.
  it('reports a throttle, a try-later and a reset as a transient send that sent nothing', async () => {
    for (const reactions of [
      { LOGIN: 'throttled', AUTHENTICATE: 'throttled' },
      { SELECT: 'throttled' },
      { SELECT: 'select-later' },
      // imapflow sets no response code on a refused FETCH; the reply holds it.
      { 'UID FETCH': 'select-later' },
      { LOGIN: 'reset', AUTHENTICATE: 'reset' },
    ] as const) {
      const label = JSON.stringify(reactions);
      const imap = await fakeImap(reactions);
      const smtp = await fakeSmtp();
      try {
        const error = await egressOn(imap.port, 10_000, smtp.port)
          .sendDraft('7', 'refund:41:v1')
          .catch((caught: unknown) => caught);
        expect(error, label).toBeInstanceOf(NothingSentError);
        expect((error as NothingSentError).permanent, label).toBe(false);
        expect(smtp.accepted(), label).toBe(0);
      } finally {
        imap.server.close();
        smtp.server.close();
      }
    }
  });

  // A server that says goodbye between its greeting and LOGIN, as one that is
  // shutting down does. imapflow then raises a login failure with no code, and
  // nothing was read. It records the goodbye, and the adapter reads that.
  it('reports a goodbye before the login as a transient send that sent nothing', async () => {
    const closing = createServer((sock: Socket) => {
      sock.on('error', () => undefined);
      sock.write('* OK ready\r\n');
      let buffered = '';
      sock.on('data', (chunk) => {
        buffered += chunk.toString();
        let end: number;
        while ((end = buffered.indexOf('\r\n')) !== -1) {
          const [tag, verb] = buffered.slice(0, end).split(' ');
          buffered = buffered.slice(end + 2);
          if ((verb ?? '').toUpperCase() === 'CAPABILITY') {
            sock.write(`* CAPABILITY IMAP4rev1\r\n* BYE server shutting down\r\n${tag} OK done\r\n`);
          } else sock.write(`${tag} NO nope\r\n`);
        }
      });
    });
    await new Promise<void>((resolve) => closing.listen(0, '127.0.0.1', resolve));
    const smtp = await fakeSmtp();
    try {
      const error = await egressOn((closing.address() as AddressInfo).port, 3_000, smtp.port)
        .sendDraft('7', 'refund:41:v1')
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(NothingSentError);
      expect((error as NothingSentError).permanent).toBe(false);
      expect((error as Error).message).toBe(
        'no SMTP send was attempted: the IMAP server closed the session: server shutting down',
      );
      expect(smtp.accepted()).toBe(0);
    } finally {
      closing.close();
      smtp.server.close();
    }
  });

  // The server's text reaches the journal and the console, so it is bounded.
  it('bounds the server text a refusal carries', async () => {
    const imap = await fakeImap({ SELECT: 'long-refusal', LIST: 'long-refusal' });
    const smtp = await fakeSmtp();
    try {
      const error = await egressOn(imap.port, 10_000, smtp.port)
        .sendDraft('7', 'refund:41:v1')
        .catch((caught: unknown) => caught);
      expect((error as Error).message).toBe(`the IMAP server refused the draft read: ${'x'.repeat(200)}…`);
    } finally {
      imap.server.close();
      smtp.server.close();
    }
  });

  // A Drafts mailbox the server refuses to open may be gone, and imapflow only
  // says so when its own LIST answers. Either way the draft may have gone out
  // first, so a refusal proves nothing. The end-to-end suite covers a mailbox
  // that LIST shows is missing.
  it('does not report a refused Drafts mailbox as a send that sent nothing', async () => {
    const imap = await fakeImap({ SELECT: 'refuse', LIST: 'refuse' });
    const smtp = await fakeSmtp();
    try {
      const error = await egressOn(imap.port, 10_000, smtp.port)
        .sendDraft('7', 'refund:41:v1')
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(NothingSentError);
      expect((error as Error).message).toBe('the IMAP server refused the draft read: refused');
      expect(smtp.accepted()).toBe(0);
    } finally {
      imap.server.close();
      smtp.server.close();
    }
  });

  // An argument no retry can change. The caller sent nothing anywhere.
  it('reports an invalid draft id or key as a permanent send that sent nothing', async () => {
    const adapter = egressOn(1);
    for (const [id, key] of [['42:1007', 'k'], ['7', ' '], ['', 'k']] as const) {
      const error = await adapter.sendDraft(id, key).catch((caught: unknown) => caught);
      expect(error, `${id} ${key}`).toBeInstanceOf(NothingSentError);
      expect((error as NothingSentError).permanent, `${id} ${key}`).toBe(true);
    }
  });

  // A draft id this adapter minted is a UID, which is a number. IMAP reads
  // `42:1007` as a range, so a FreeScout id would fetch an unrelated draft.
  it('refuses a draft id that is not a UID, before it connects, and never retries it', async () => {
    const adapter = egressOn(1);
    for (const id of ['42:1007', '1,2', '*', 'SYN-DRAFT-1', ' 7']) {
      await expect(adapter.readDraft(id), id).rejects.toThrow(/not a UID/);
      await expect(adapter.readDraft(id), id).rejects.toBeInstanceOf(PermanentEgressError);
      await expect(adapter.sendDraft(id, 'k'), id).rejects.toThrow(/not a UID/);
    }
  });

  // The console gives a read-back four seconds (`READ_BACK_GIVE_UP_MS` in
  // console/src/read-back.ts, pinned by its own suite). The logout grace must
  // leave most of that for connecting and reading, so a stalled logout cannot
  // turn a read into a refusal.
  it('leaves most of the console read-back for the read itself', () => {
    const consoleReadBackMs = 4_000;
    expect(IMAP_LOGOUT_GRACE_MS * 2).toBeLessThanOrEqual(consoleReadBackMs / 2);
    expect(IMAP_MARK_SEEN_BUDGET_MS).toBeLessThan(IMAP_OPERATION_TIMEOUT_MS);
  });
});

describe('draft message construction', () => {
  const provenance = {
    generatedBy: 'auracle',
    modelId: 'm',
    promptVer: 'p',
    generatedAt: '2026-01-01T00:00:00.000Z',
  };

  type Outgoing = Parameters<typeof buildDraftMessage>[0];
  // exactOptionalPropertyTypes forbids an explicit undefined on an optional
  // property, but several cases prove the builder omits a header when the
  // value is absent. The overrides accept undefined; the result is pinned
  // back to the builder's own parameter type.
  type ReplyOverrides = { [K in keyof Outgoing]?: Outgoing[K] | undefined };

  function reply(overrides: ReplyOverrides = {}): Outgoing {
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
    } as Outgoing;
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

  it('omits the header when no park key is given', async () => {
    const raw = buildDraftMessage(reply({ idemKey: undefined })).toString();
    expect(raw).not.toContain('X-Auracle-Idem-Key');
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

describe('conversation linkage (DEC-35)', () => {
  function mail(headers: string): string {
    return (
      `${headers}\r\n`
      + 'From: dana.doe@example.test\r\n'
      + 'To: support@acme.example\r\n'
      + 'Subject: Re: broken tiles\r\n'
      + '\r\n'
      + 'Still broken.\r\n'
    );
  }

  it('offers the reply chain, thread root first', () => {
    const event = normalize(
      mail(
        'Message-ID: <m3@example.test>\r\n'
        + 'References: <root@example.test> <m2@example.test>\r\n'
        + 'In-Reply-To: <m2@example.test>',
      ),
    );

    // Root first, so the ledger meets the oldest recorded turn first.
    expect(event.linkage?.priorMessageIds[0]).toBe('root@example.test');
    expect(event.linkage?.priorMessageIds).toContain('m2@example.test');
  });

  it('offers nothing for a mail that opens a thread', () => {
    const event = normalize(mail('Message-ID: <first@example.test>'));

    // Null means no evidence beyond the ticket, not a new conversation: the
    // ticket id still groups the thread.
    expect(event.linkage).toBeNull();
  });

  it('carries the delivery id, so a mail with no Message-ID still has one', () => {
    const event = normalize(mail('Subject: no id of its own'), 'imap-uid-77');

    expect(event.sourceId).toBe('imap-uid-77');
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

/** One untagged FETCH row the scripted reader yields. */
interface ScriptedRow {
  readonly uid?: number;
  readonly source?: string;
  readonly headers?: string;
}

/**
 * A mailbox reader whose answers are scripted. `selected: false` is the
 * mailbox imapflow 2 has lost: a SEARCH script may say `undefined`, and the
 * fetch yields nothing while `mailbox` reads false. Synthetic (DEC-18).
 */
function reader(script: {
  readonly search?: number[] | false | undefined;
  readonly rows?: readonly ScriptedRow[];
  readonly selected?: boolean;
  readonly onFetch?: () => void;
}): ImapReadClient {
  const selected = script.selected ?? true;
  const rows = script.rows ?? [];
  return {
    get mailbox() {
      return selected ? ({ path: 'INBOX' } as unknown as MailboxObject) : false;
    },
    mailboxOpen: async () => ({}),
    search: (async () => ('search' in script ? script.search : [])) as ImapReadClient['search'],
    fetch: async function* () {
      script.onFetch?.();
      if (!selected) return;
      for (const row of rows) {
        yield {
          seq: 1,
          uid: row.uid as number,
          ...(row.source === undefined ? {} : { source: Buffer.from(row.source) }),
          ...(row.headers === undefined ? {} : { headers: Buffer.from(row.headers) }),
        } as FetchMessageObject;
      }
    },
  };
}

// findThreadOriginator resolves the recipient of every parked reply, so which
// error it raises decides whether a ticket retries or escalates. imapflow
// answers short — `false`, `undefined`, a row without a body — rather than
// throwing, and reading that as an empty result makes a transient fault
// indistinguishable from a thread root that is really gone.
describe('findThreadOriginator separates a short answer from an empty one', () => {
  const TICKET_ID = 'thread-root@acme.example';
  const UID = 7;

  async function retryable(client: ImapReadClient, pattern: RegExp): Promise<void> {
    const error = await findThreadOriginator(client, TICKET_ID).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PermanentEgressError);
    expect((error as Error).message).toMatch(pattern);
  }

  it('addresses the reply from the row for its UID, past an unsolicited one', async () => {
    // imapflow returns every untagged FETCH, and a flag update for another
    // message can arrive first.
    const found = await findThreadOriginator(
      reader({ search: [UID], rows: [{ uid: 9 }, { uid: UID, source: THREAD_ROOT_EMAIL }] }),
      TICKET_ID,
    );
    expect(found.messageId).toBe(TICKET_ID);
  });

  it('raises a retryable error when the FETCH answers the UID without its body', async () => {
    // The SEARCH just listed this UID, so the root is there. Skipping it would
    // escalate the ticket as unaddressable on one short answer.
    await retryable(reader({ search: [UID], rows: [{ uid: UID }] }), /without its body/);
  });

  it('raises a retryable error when the FETCH returns no row for a listed UID', async () => {
    await retryable(reader({ search: [UID], rows: [] }), new RegExp(`no row for uid ${UID}`));
  });

  it('raises a retryable error when no mailbox was selected for the SEARCH', async () => {
    // A connection that closed after the SELECT leaves no mailbox, and the
    // next attempt opens a fresh one. Nothing says the thread root is gone.
    await retryable(reader({ search: undefined }), /no mailbox selected/);
  });

  it('raises a retryable error when the mailbox was lost during the FETCH', async () => {
    await retryable(reader({ search: [UID], selected: false }), /no mailbox selected/);
  });

  it('raises a retryable error when the server refuses the SEARCH', async () => {
    // A PermanentEgressError here escalates the ticket on the first fault and
    // skips the intake attempt ceiling, so one window of IMAP faults would
    // escalate every ticket parking during it.
    await retryable(reader({ search: false }), /refused the header SEARCH/);
  });

  it('escalates when the search genuinely finds nothing', async () => {
    // Archived, moved or deleted: a later scan does not find it either, so a
    // person has to reconcile it and a retry only spends the budget.
    await expect(findThreadOriginator(reader({ search: [] }), TICKET_ID)).rejects.toThrow(
      PermanentEgressError,
    );
  });

  it('escalates a ticket id that was never a message id', async () => {
    // A content digest never reverses into an addressable Message-ID.
    await expect(findThreadOriginator(reader({}), 'no-id-abc123')).rejects.toThrow(
      PermanentEgressError,
    );
  });

  it('escalates when the thread root carries no From address', async () => {
    await expect(
      findThreadOriginator(
        reader({ search: [UID], rows: [{ uid: UID, source: NO_FROM_THREAD_ROOT }] }),
        TICKET_ID,
      ),
    ).rejects.toThrow(PermanentEgressError);
  });
});

// The repeat-park guard is the whole defence against a second draft in front
// of the customer. An answer that is not a list of UIDs is not "no draft".
describe('findDraftByIdemKey refuses a lookup that did not run', () => {
  const MAILBOX = 'Drafts';
  const KEY = 'park-key-1';
  const keyed = (key: string) => `${IDEM_KEY_HEADER}: ${key}\r\n\r\n`;
  const noFetch = () => {
    throw new Error('the guard fetched after a search that did not run');
  };

  it('fails the park when the server refuses the SEARCH', async () => {
    await expect(
      findDraftByIdemKey(reader({ search: false, onFetch: noFetch }), MAILBOX, KEY),
    ).rejects.toThrow(/refused a header SEARCH/);
  });

  it('fails the park when no mailbox was selected for the SEARCH', async () => {
    // Read as "no draft exists", this appends a second draft.
    await expect(
      findDraftByIdemKey(reader({ search: undefined, onFetch: noFetch }), MAILBOX, KEY),
    ).rejects.toThrow(/no mailbox selected/);
  });

  it('fails the park when the mailbox was lost during the candidate FETCH', async () => {
    // The fetch then yields nothing, which would read as no draft.
    await expect(
      findDraftByIdemKey(reader({ search: [4], selected: false }), MAILBOX, KEY),
    ).rejects.toThrow(/no mailbox selected/);
  });

  it('fails the park when a matching draft comes back without a usable UID', async () => {
    // imapflow drops a UID it cannot parse. Math.min over it is NaN, and the
    // park would report a draft under "NaN" and append nothing.
    await expect(
      findDraftByIdemKey(reader({ search: [4], rows: [{ headers: keyed(KEY) }] }), MAILBOX, KEY),
    ).rejects.toThrow(/without a usable UID/);
  });

  it('fails the park when a candidate comes back without its headers', async () => {
    // That row could be the first draft. Skipping it appends a second.
    await expect(
      findDraftByIdemKey(reader({ search: [4], rows: [{ uid: 4 }] }), MAILBOX, KEY),
    ).rejects.toThrow(/without its headers/);
  });

  it('fails the park when the candidate FETCH returns no row at all', async () => {
    // The SEARCH just listed a candidate, so nothing is not an answer.
    await expect(
      findDraftByIdemKey(reader({ search: [4], rows: [] }), MAILBOX, KEY),
    ).rejects.toThrow(/no row for the 1 candidate/);
  });

  it('finds the lowest verified draft among the candidates', async () => {
    const candidates = reader({
      search: [12, 5, 9],
      rows: [
        { uid: 12, headers: keyed(KEY) },
        { uid: 5, headers: keyed(`${KEY}-longer`) },
        { uid: 9, headers: keyed(KEY) },
      ],
    });
    // 5 matched the substring SEARCH only, so 9 is the first real draft.
    await expect(findDraftByIdemKey(candidates, MAILBOX, KEY)).resolves.toBe('9');
  });

  it('finds no draft when the search answers no UID', async () => {
    await expect(
      findDraftByIdemKey(reader({ search: [], onFetch: noFetch }), MAILBOX, KEY),
    ).resolves.toBeNull();
  });
});

// A send and an approval read the parked draft by UID. A draft that is gone
// reads as missing. A short answer says nothing about it.
describe('readDraftSource separates a missing draft from a short answer', () => {
  const MAILBOX = 'Drafts';

  async function fault(client: ImapReadClient, pattern: RegExp): Promise<void> {
    const error = await readDraftSource(client, MAILBOX, '3').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PermanentEgressError);
    expect((error as Error).message).toMatch(pattern);
  }

  it('returns the source of a draft that is there', async () => {
    const source = await readDraftSource(
      reader({ rows: [{ uid: 3, source: THREAD_ROOT_EMAIL }] }),
      MAILBOX,
      '3',
    );
    expect(source?.toString()).toBe(THREAD_ROOT_EMAIL);
  });

  it('reads the row for its own UID, past an unsolicited one', async () => {
    // imapflow returns every untagged FETCH, and a flag update for another
    // draft can arrive first.
    const source = await readDraftSource(
      reader({ rows: [{ uid: 9, source: 'another draft' }, { uid: 3, source: THREAD_ROOT_EMAIL }] }),
      MAILBOX,
      '3',
    );
    expect(source?.toString()).toBe(THREAD_ROOT_EMAIL);
  });

  it('refuses an id that is not one UID, before it fetches', async () => {
    // A range or `*` would fetch a draft nobody parked, and `007` names the
    // UID 7 by another spelling.
    for (const id of ['42:1007', '*', '007']) {
      let fetched = false;
      const spy = reader({ onFetch: () => { fetched = true; } });
      await expect(readDraftSource(spy, MAILBOX, id)).rejects.toThrow(/is not a UID/);
      expect(fetched).toBe(false);
    }
  });

  it('raises an error, not a missing draft, when the row for its UID has no body', async () => {
    await fault(reader({ rows: [{ uid: 3 }] }), /without its body/);
  });

  it('raises an error, not a missing draft, when the mailbox was lost', async () => {
    await fault(reader({ selected: false }), /no mailbox selected/);
  });

  it('returns null when the server holds no such draft', async () => {
    // Another message's flag update is not this draft.
    await expect(readDraftSource(reader({ rows: [{ uid: 9 }] }), MAILBOX, '3')).resolves.toBeNull();
  });
});

const NO_FROM_THREAD_ROOT = [
  'To: support@acme.example',
  'Subject: Order 4471 arrived damaged',
  `Message-ID: <thread-root@acme.example>`,
  '',
  'The box arrived with a crushed corner.',
].join('\r\n');
