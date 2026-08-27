// Tests for the real-corpus export (gap G4). All messages here are
// synthetic fixtures from src/adapters/fixtures.ts (DEC-18).

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ImapPoller } from '../ingress/imap-poller.js';
import type { NormalizedEvent } from '../adapters/types.js';
import { SIMPLE_TEXT_EMAIL } from '../adapters/fixtures.js';
import {
  CORPUS_SOURCE,
  CORPUS_SPLIT,
  UNLABELED_INTENT,
  buildCorpusTickets,
  loadCorpusFile,
  validateCorpusFile,
} from './corpus.js';

const REPLY_EMAIL = [
  'From: Dana Doe <dana.doe@example.test>',
  'To: support@acme.example',
  'Subject: Re: Order 4471 arrived damaged',
  'Date: Tue, 7 Jan 2025 08:00:00 +0000',
  'Message-ID: <order-4471-reply@example.test>',
  'In-Reply-To: <order-4471-damaged@example.test>',
  'References: <order-4471-damaged@example.test>',
  '',
  'Thanks, the replacement arrived.',
].join('\r\n');

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'corpus-test-'));
}

let cleanupDirs: string[] = [];
afterEach(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
  cleanupDirs = [];
});

async function collectEvents(messages: { sourceId: string; rfc5322Text: string }[]) {
  const events: NormalizedEvent[] = [];
  const poller = new ImapPoller({
    fetchMessages: () => Promise.resolve(messages),
    onEvent: (event) => {
      events.push(event);
      return Promise.resolve();
    },
    onError: () => {},
  });
  const result = await poller.pollOnce();
  return { events, result };
}

describe('buildCorpusTickets', () => {
  it('merges one thread into a single ticket and keeps other threads apart', async () => {
    const { events } = await collectEvents([
      { sourceId: 'uid-1', rfc5322Text: SIMPLE_TEXT_EMAIL },
      { sourceId: 'uid-2', rfc5322Text: REPLY_EMAIL },
    ]);

    const tickets = buildCorpusTickets(events);
    expect(tickets).toHaveLength(1);
    const ticket = tickets[0]!;
    expect(ticket.ticket_id).toBe('order-4471-damaged@example.test');
    expect(ticket.source).toBe(CORPUS_SOURCE);
    expect(ticket.intent).toBe(UNLABELED_INTENT);
    expect(ticket.queue).toBe('general');
    expect(ticket.subject).toBe('Order 4471 arrived damaged');
    expect(ticket.body).toContain('crushed corner');
    expect(ticket.body).toContain('replacement arrived');
    expect(ticket.disposition).toEqual({
      escalated: false,
      macro_applied: null,
      refund_issued: false,
      first_reply_minutes: 0,
    });
  });

  it('round-trips through validateCorpusFile and loadCorpusFile', async () => {
    const { events } = await collectEvents([
      { sourceId: 'uid-1', rfc5322Text: SIMPLE_TEXT_EMAIL },
    ]);
    const tickets = buildCorpusTickets(events);
    const file = validateCorpusFile({ split: CORPUS_SPLIT, source: CORPUS_SOURCE, count: tickets.length, tickets });

    const dir = tmpDir();
    cleanupDirs.push(dir);
    const path = join(dir, 'history.json');
    writeFileSync(path, JSON.stringify(file));

    expect(loadCorpusFile(path)).toEqual(file);
  });

  it('rejects an empty subject instead of writing an invalid file', async () => {
    const noSubject = [
      'From: dana.doe@example.test',
      'To: support@acme.example',
      'Message-ID: <no-subject@example.test>',
      '',
      'Body without a subject header.',
    ].join('\r\n');
    const { events } = await collectEvents([{ sourceId: 'uid-9', rfc5322Text: noSubject }]);
    expect(() => buildCorpusTickets(events)).toThrow(/empty subject/);
  });

  it('rejects wrong split, wrong source and broken tickets', () => {
    const good = {
      ticket_id: '<a@example.test>',
      source: CORPUS_SOURCE,
      intent: UNLABELED_INTENT,
      queue: 'general',
      disposition: { escalated: false, macro_applied: null, refund_issued: false, first_reply_minutes: 0 },
      subject: 'S',
      body: 'B',
    };
    expect(() => validateCorpusFile({ split: 'fit', source: CORPUS_SOURCE, count: 1, tickets: [good] }))
      .toThrow(/split/);
    expect(() => validateCorpusFile({ split: CORPUS_SPLIT, source: 'synthetic', count: 1, tickets: [good] }))
      .toThrow(/source/);
    expect(() =>
      validateCorpusFile({
        split: CORPUS_SPLIT,
        source: CORPUS_SOURCE,
        count: 2,
        tickets: [good],
      }),
    ).toThrow(/count does not match/);
    expect(() =>
      validateCorpusFile({
        split: CORPUS_SPLIT,
        source: CORPUS_SOURCE,
        count: 1,
        tickets: [{ ...good, source: 'synthetic' }],
      }),
    ).toThrow(/does not declare source/);
    expect(() =>
      validateCorpusFile({
        split: CORPUS_SPLIT,
        source: CORPUS_SOURCE,
        count: 1,
        tickets: [{ ...good, subject: '' }],
      }),
    ).toThrow(/no subject/);
  });
});
