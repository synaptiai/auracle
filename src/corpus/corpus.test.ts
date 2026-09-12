// Tests for the real-corpus export (gap G4). All messages here are
// synthetic fixtures from src/adapters/fixtures.ts (DEC-18).

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ImapPoller } from '../ingress/imap-poller.js';
import type { NormalizedEvent } from '../adapters/types.js';
import { SIMPLE_TEXT_EMAIL } from '../adapters/fixtures.js';
import type { CorpusExportStats } from './corpus.js';
import {
  CORPUS_SOURCE,
  CORPUS_SPLIT,
  UNLABELED_INTENT,
  buildCorpusTickets,
  corpusHistoryItems,
  loadCorpusFile,
  validateCorpusFile,
} from './corpus.js';
import { conversationHistories } from '../fixtures/load.js';
import type { GoldTicket } from '../domain/gold-types.js';

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

/** A customer follow-up on the same thread, stated later than the agent reply. */
const LATE_FOLLOWUP_EMAIL = [
  'From: Dana Doe <dana.doe@example.test>',
  'To: support@acme.example',
  'Subject: Re: Order 4471 arrived damaged',
  'Date: Tue, 7 Jan 2025 10:00:00 +0000',
  'Message-ID: <order-4471-late@example.test>',
  'In-Reply-To: <order-4471-damaged@example.test>',
  'References: <order-4471-damaged@example.test>',
  '',
  'Still nothing. Can you check again?',
].join('\r\n');

/** An agent answer stated between the two customer turns. */
const AGENT_REPLY_EMAIL = [
  'From: Acme Support <support@acme.example>',
  'To: Dana Doe <dana.doe@example.test>',
  'Subject: Re: Order 4471 arrived damaged',
  'Date: Tue, 7 Jan 2025 09:00:00 +0000',
  'Message-ID: <order-4471-agent@example.test>',
  'In-Reply-To: <order-4471-damaged@example.test>',
  'References: <order-4471-damaged@example.test>',
  '',
  'We have shipped a replacement today.',
].join('\r\n');

/** A provenance block for a hand-built corpus file. */
function provenance(over: Partial<CorpusExportStats & { order_fallback_conversations: string[]; normalization_failures: number }> = {}) {
  return {
    threads: 1, turns: 1, orderFallbackThreads: 0, droppedSystemMessages: 0,
    droppedEmptyMessages: 0, droppedOrphanAgentMessages: 0, droppedDuplicateMessages: 0,
    droppedSubjectlessThreads: 0, droppedSubjectlessMessages: 0,
    order_fallback_conversations: [], normalization_failures: 0,
    ...over,
  };
}

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

    const { tickets } = buildCorpusTickets(events);
    expect(tickets).toHaveLength(2);
    const ticket = tickets[0]!;
    expect(ticket.ticket_id).toBe('order-4471-damaged@example.test');
    expect(ticket.conversation_id).toBe('order-4471-damaged@example.test');
    expect(ticket.turn_number).toBe(1);
    expect(ticket.source).toBe(CORPUS_SOURCE);
    expect(ticket.intent).toBe(UNLABELED_INTENT);
    expect(ticket.queue).toBe('general');
    expect(ticket.subject).toBe('Order 4471 arrived damaged');
    expect(ticket.body).toContain('crushed corner');
    // The reply is now its own turn, not text appended to the first one.
    expect(ticket.body).not.toContain('replacement arrived');
    expect(tickets[1]?.body).toContain('replacement arrived');
    expect(tickets[1]?.turn_number).toBe(2);
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
    const { tickets, stats } = buildCorpusTickets(events);
    const file = validateCorpusFile({
      split: CORPUS_SPLIT, source: CORPUS_SOURCE, count: tickets.length,
      provenance: provenance({ threads: stats.threads, turns: stats.turns }), tickets,
    });

    const dir = tmpDir();
    cleanupDirs.push(dir);
    const path = join(dir, 'history.json');
    writeFileSync(path, JSON.stringify(file));

    expect(loadCorpusFile(path)).toEqual(file);
  });

  it('drops a thread where nothing states a subject, and counts it', async () => {
    const noSubject = [
      'From: dana.doe@example.test',
      'To: support@acme.example',
      'Message-ID: <no-subject@example.test>',
      '',
      'Body without a subject header.',
    ].join('\r\n');
    const { events } = await collectEvents([{ sourceId: 'uid-9', rfc5322Text: noSubject }]);
    // Dropped, not thrown on. Throwing here discarded a whole mailbox export
    // over one message, which is the fault the offline jobs move their
    // directory checks ahead of the model loop to avoid.
    const { tickets, stats } = buildCorpusTickets(events);
    expect(tickets).toEqual([]);
    expect(stats.droppedSubjectlessThreads).toBe(1);
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
      conversation_id: 'C',
      turn_number: 1,
    };
    expect(() => validateCorpusFile({ split: 'fit', source: CORPUS_SOURCE, count: 1, provenance: provenance(), tickets: [good] }))
      .toThrow(/split/);
    expect(() => validateCorpusFile({ split: CORPUS_SPLIT, source: 'synthetic', count: 1, provenance: provenance(), tickets: [good] }))
      .toThrow(/source/);
    expect(() =>
      validateCorpusFile({
        split: CORPUS_SPLIT,
        source: CORPUS_SOURCE,
        count: 2,
        provenance: provenance(),
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

describe('corpusHistoryItems', () => {
  // The induction job clusters the exported history. A follow-up turn names
  // no topic of its own ("thanks, that worked"), so clustering one would
  // spend an intent of the 25-intent cap (DEC-10) on a cluster no person can
  // name. The taxonomy describes what a customer writes in first, so the job
  // reads first turns only.
  function ticket(id: string, turn: number | undefined): GoldTicket {
    const base: GoldTicket = {
      ticket_id: id,
      source: CORPUS_SOURCE,
      intent: UNLABELED_INTENT,
      queue: 'general',
      disposition: { escalated: false, macro_applied: null, refund_issued: false, first_reply_minutes: 0 },
      subject: `subject ${id}`,
      body: `body ${id}`,
    };
    return turn === undefined ? base : { ...base, conversation_id: 'CONV-1', turn_number: turn };
  }

  it('keeps first turns and drops later ones', () => {
    const items = corpusHistoryItems([ticket('a', 1), ticket('b', 2), ticket('c', 3), ticket('d', 1)]);
    expect(items.map((item) => item.id)).toEqual(['a', 'd']);
  });

  it('builds the same text the classifier reads', () => {
    expect(corpusHistoryItems([ticket('a', 1)])[0]?.text).toBe('subject a\n\nbody a');
  });

  // This pinned the inertness of the filter when it landed, one commit
  // before the export modelled turns. It no longer describes any production
  // path: validateCorpusFile requires a turn number, so a turn-less record
  // is refused before this function sees it. It stays as a unit-level pin on
  // the defensive branch of isFirstTurn, which the optional field keeps
  // reachable in the type.
  it('is a no-op on records that carry no turn number', () => {
    const folded = [ticket('a', undefined), ticket('b', undefined), ticket('c', undefined)];
    expect(corpusHistoryItems(folded).map((item) => item.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('buildCorpusTickets turn structure', () => {
  it('emits one record per customer turn, sharing a conversation and numbering from 1', async () => {
    const { events } = await collectEvents([
      { sourceId: '1', rfc5322Text: SIMPLE_TEXT_EMAIL },
      { sourceId: '2', rfc5322Text: LATE_FOLLOWUP_EMAIL },
    ]);
    const { tickets } = buildCorpusTickets(events);
    expect(tickets).toHaveLength(2);
    expect(new Set(tickets.map((t) => t.conversation_id)).size).toBe(1);
    expect(tickets.map((t) => t.turn_number)).toEqual([1, 2]);
    expect(tickets[0]?.body).toContain('crushed corner');
    expect(tickets[1]?.body).toContain('Still nothing');
  });

  // The falsification the issue names. Delivery reordered the thread: the
  // later-stated follow-up arrives first. Numbering by arrival would make it
  // turn 1, and the history the runtime sends would then quote a message the
  // customer had not written yet.
  it('orders turns by their stated time, not by delivery order', async () => {
    const { events } = await collectEvents([
      { sourceId: '2', rfc5322Text: LATE_FOLLOWUP_EMAIL },
      { sourceId: '1', rfc5322Text: SIMPLE_TEXT_EMAIL },
    ]);
    const { tickets, stats } = buildCorpusTickets(events);
    const byTurn = new Map(tickets.map((t) => [t.turn_number, t]));
    expect(byTurn.get(1)?.body).toContain('crushed corner');
    expect(byTurn.get(2)?.body).toContain('Still nothing');
    expect(stats.orderFallbackThreads).toBe(0);

    // And the consequence: turn 2 reads turn 1 as its history, never the reverse.
    const histories = conversationHistories(tickets);
    const laterId = byTurn.get(2)?.ticket_id ?? '';
    const rendered = histories.get(laterId) ?? [];
    expect(rendered).toHaveLength(1);
    expect(rendered[0]?.bodyText).toContain('crushed corner');
    expect(histories.get(byTurn.get(1)?.ticket_id ?? '')).toEqual([]);
  });

  it('attaches an agent reply to the turn it answered, by stated time', async () => {
    const { events } = await collectEvents([
      { sourceId: '1', rfc5322Text: SIMPLE_TEXT_EMAIL },
      { sourceId: '2', rfc5322Text: LATE_FOLLOWUP_EMAIL },
      { sourceId: '3', rfc5322Text: AGENT_REPLY_EMAIL },
    ]);
    const { tickets } = buildCorpusTickets(events, { agentAddresses: ['support@acme.example'] });
    const byTurn = new Map(tickets.map((t) => [t.turn_number, t]));
    // The agent wrote at 09:00, between the two customer turns, so it answers
    // turn 1. Arrival order would have hung it off turn 2.
    expect(byTurn.get(1)?.agent_reply).toContain('replacement');
    expect(byTurn.get(2)?.agent_reply).toBeUndefined();
    // A reply takes no turn number of its own (the ledger rule).
    expect(tickets.map((t) => t.turn_number)).toEqual([1, 2]);
  });

  it('falls back to delivery order when a message states no readable time, and counts it', async () => {
    const noDate = SIMPLE_TEXT_EMAIL.split('\r\n')
      .filter((line) => !line.startsWith('Date:'))
      .join('\r\n');
    const { events } = await collectEvents([
      { sourceId: '1', rfc5322Text: noDate },
      { sourceId: '2', rfc5322Text: LATE_FOLLOWUP_EMAIL },
    ]);
    const { tickets, stats } = buildCorpusTickets(events);
    expect(stats.orderFallbackThreads).toBe(1);
    expect(tickets.map((t) => t.turn_number)).toEqual([1, 2]);
    expect(tickets[0]?.body).toContain('crushed corner');
  });

  it('reports what it emitted and what it dropped', async () => {
    const { events } = await collectEvents([
      { sourceId: '1', rfc5322Text: SIMPLE_TEXT_EMAIL },
      { sourceId: '3', rfc5322Text: AGENT_REPLY_EMAIL },
    ]);
    const { stats } = buildCorpusTickets(events, { agentAddresses: ['support@acme.example'] });
    expect(stats).toMatchObject({
      threads: 1,
      turns: 1,
      orderFallbackThreads: 0,
      droppedSystemMessages: 0,
      droppedEmptyMessages: 0,
      droppedOrphanAgentMessages: 0,
      droppedDuplicateMessages: 0,
      droppedSubjectlessThreads: 0,
    });
  });

  it('drops an agent message that opens a thread, because no turn can carry it', async () => {
    const orphan = AGENT_REPLY_EMAIL.split('\r\n')
      .filter((line) => !line.startsWith('In-Reply-To:') && !line.startsWith('References:'))
      .join('\r\n');
    const { events } = await collectEvents([{ sourceId: '3', rfc5322Text: orphan }]);
    const { tickets, stats } = buildCorpusTickets(events, { agentAddresses: ['support@acme.example'] });
    expect(tickets).toEqual([]);
    expect(stats.droppedOrphanAgentMessages).toBe(1);
  });

  // Without a declared address the export cannot tell the two sides apart,
  // and it says so by recording every message as a customer turn rather than
  // guessing. An operator pointing at a plain inbox gets exactly today's
  // meaning.
  it('records every message as a customer turn when no agent address is declared', async () => {
    const { events } = await collectEvents([
      { sourceId: '1', rfc5322Text: SIMPLE_TEXT_EMAIL },
      { sourceId: '3', rfc5322Text: AGENT_REPLY_EMAIL },
    ]);
    const { tickets, stats } = buildCorpusTickets(events);
    expect(tickets.map((t) => t.turn_number)).toEqual([1, 2]);
    expect(tickets.every((t) => t.agent_reply === undefined)).toBe(true);
    expect(stats.droppedOrphanAgentMessages).toBe(0);
  });

  // M5: the previous fixture put the only agent message between turns 1 and
  // 2, where "the last emitted turn" and "the first emitted turn" are the
  // same record. Attaching to emitted[0] passed every case. Three turns
  // separate the two.
  it('attaches a reply to the turn it answered, not to the first turn', async () => {
    const third = LATE_FOLLOWUP_EMAIL
      .replace('Date: Tue, 7 Jan 2025 10:00:00 +0000', 'Date: Tue, 7 Jan 2025 12:00:00 +0000')
      .replace('<order-4471-late@example.test>', '<order-4471-third@example.test>')
      .replace('Still nothing. Can you check again?', 'Third message from the customer.');
    const replyToTurnTwo = AGENT_REPLY_EMAIL
      .replace('Date: Tue, 7 Jan 2025 09:00:00 +0000', 'Date: Tue, 7 Jan 2025 11:00:00 +0000')
      .replace('<order-4471-agent@example.test>', '<order-4471-agent2@example.test>')
      .replace('We have shipped a replacement today.', 'The replacement is on its way.');
    const { events } = await collectEvents([
      { sourceId: '1', rfc5322Text: SIMPLE_TEXT_EMAIL },
      { sourceId: '2', rfc5322Text: LATE_FOLLOWUP_EMAIL },
      { sourceId: '3', rfc5322Text: replyToTurnTwo },
      { sourceId: '4', rfc5322Text: third },
    ]);
    const { tickets } = buildCorpusTickets(events, { agentAddresses: ['support@acme.example'] });
    const byTurn = new Map(tickets.map((t) => [t.turn_number, t]));
    expect(byTurn.get(1)?.agent_reply).toBeUndefined();
    expect(byTurn.get(2)?.agent_reply).toContain('on its way');
    expect(byTurn.get(3)?.agent_reply).toBeUndefined();
  });

  // M7: no case used two agent messages, so removing the join was invisible.
  it('joins two replies that both precede the next customer turn', async () => {
    const second = AGENT_REPLY_EMAIL
      .replace('Date: Tue, 7 Jan 2025 09:00:00 +0000', 'Date: Tue, 7 Jan 2025 09:30:00 +0000')
      .replace('<order-4471-agent@example.test>', '<order-4471-agent-b@example.test>')
      .replace('We have shipped a replacement today.', 'It should arrive on Thursday.');
    const { events } = await collectEvents([
      { sourceId: '1', rfc5322Text: SIMPLE_TEXT_EMAIL },
      { sourceId: '2', rfc5322Text: AGENT_REPLY_EMAIL },
      { sourceId: '3', rfc5322Text: second },
    ]);
    const { tickets } = buildCorpusTickets(events, { agentAddresses: ['support@acme.example'] });
    const reply = tickets[0]?.agent_reply ?? '';
    expect(reply).toContain('replacement');
    expect(reply).toContain('Thursday');
    expect(reply.indexOf('replacement')).toBeLessThan(reply.indexOf('Thursday'));
  });

  // M1: droppedEmptyMessages was never observed non-zero, so a hardcoded 0
  // satisfied every assertion about it.
  it('drops a message with no body text and counts it', async () => {
    const empty = LATE_FOLLOWUP_EMAIL.replace('Still nothing. Can you check again?', '   ');
    const { events } = await collectEvents([
      { sourceId: '1', rfc5322Text: SIMPLE_TEXT_EMAIL },
      { sourceId: '2', rfc5322Text: empty },
    ]);
    const { tickets, stats } = buildCorpusTickets(events);
    expect(stats.droppedEmptyMessages).toBe(1);
    expect(tickets.map((t) => t.turn_number)).toEqual([1]);
  });

  // M2: mail ingress hardcodes author 'customer', so a system message is
  // unreachable through the poller. The port allows one, so the event is
  // built directly against the port's own shape.
  it('drops a message from neither party and counts it', async () => {
    const { events } = await collectEvents([{ sourceId: '1', rfc5322Text: SIMPLE_TEXT_EMAIL }]);
    const seed = events[0]!;
    const system: NormalizedEvent = {
      ...seed,
      sourceId: 'sys-1',
      message: {
        ...seed.message,
        messageId: '<bounce@example.test>',
        author: 'system',
        bodyText: 'Delivery Status Notification',
      },
    };
    const { tickets, stats } = buildCorpusTickets([seed, system]);
    expect(stats.droppedSystemMessages).toBe(1);
    expect(tickets).toHaveLength(1);
  });

  // A shared or archived mailbox holds an INBOX copy and a Sent copy of one
  // message. Before this the second copy became a bogus turn 2 and the whole
  // export then failed validation on the repeated id.
  it('drops a repeat delivery of one message and counts it', async () => {
    const { events } = await collectEvents([
      { sourceId: 'inbox-1', rfc5322Text: SIMPLE_TEXT_EMAIL },
      { sourceId: 'allmail-1', rfc5322Text: SIMPLE_TEXT_EMAIL },
    ]);
    const { tickets, stats } = buildCorpusTickets(events);
    expect(stats.droppedDuplicateMessages).toBe(1);
    expect(tickets.map((t) => t.turn_number)).toEqual([1]);
  });

  // A follow-up with no Subject header still belongs to its thread. Dropping
  // it, or aborting the export over it, both lose a real turn.
  it('lets a subjectless follow-up inherit the subject of its thread', async () => {
    const noSubject = LATE_FOLLOWUP_EMAIL
      .split('\r\n')
      .filter((line) => !line.startsWith('Subject:'))
      .join('\r\n');
    const { events } = await collectEvents([
      { sourceId: '1', rfc5322Text: SIMPLE_TEXT_EMAIL },
      { sourceId: '2', rfc5322Text: noSubject },
    ]);
    const { tickets, stats } = buildCorpusTickets(events);
    expect(tickets.map((t) => t.turn_number)).toEqual([1, 2]);
    expect(tickets[1]?.subject).toBe('Order 4471 arrived damaged');
    expect(stats.droppedSubjectlessThreads).toBe(0);
  });

  // A zone-less Date header is not NaN. Date.parse resolves it in the
  // exporter host's local zone, which is a property of the machine and not
  // of the message, so one mailbox would number its turns differently on two
  // hosts. It counts as unreadable and the thread falls back, reported.
  it('treats a Date with no zone as unreadable rather than trusting the host clock', async () => {
    const noZone = LATE_FOLLOWUP_EMAIL
      .replace('Date: Tue, 7 Jan 2025 10:00:00 +0000', 'Date: Tue, 7 Jan 2025 10:30:00');
    const { events } = await collectEvents([
      { sourceId: '1', rfc5322Text: SIMPLE_TEXT_EMAIL },
      { sourceId: '2', rfc5322Text: noZone },
    ]);
    const { tickets, stats } = buildCorpusTickets(events);
    expect(stats.orderFallbackThreads).toBe(1);
    expect(tickets[0]?.body).toContain('crushed corner');
  });

  // The earlier version of this case used '-0500 (EST)', which the numeric
  // branch matches — so the whole named-zone arm could be deleted and every
  // test still passed, while GMT- and EST-form headers would have silently
  // become unreadable in production. Each form below has no numeric offset.
  it.each(['GMT', 'UTC', 'EST', 'Z'])('reads a named zone: %s', async (zone) => {
    const named = LATE_FOLLOWUP_EMAIL
      .replace('Date: Tue, 7 Jan 2025 10:00:00 +0000', `Date: Tue, 7 Jan 2025 10:00:00 ${zone}`);
    const { events } = await collectEvents([
      { sourceId: '1', rfc5322Text: SIMPLE_TEXT_EMAIL },
      { sourceId: '2', rfc5322Text: named },
    ]);
    expect(buildCorpusTickets(events).stats.orderFallbackThreads).toBe(0);
  });

  it('reads a trailing zone comment and an offset with a colon', async () => {
    for (const form of ['-0500 (EST)', '+01:00']) {
      const header = LATE_FOLLOWUP_EMAIL
        .replace('Date: Tue, 7 Jan 2025 10:00:00 +0000', `Date: Tue, 7 Jan 2025 10:00:00 ${form}`);
      const { events } = await collectEvents([
        { sourceId: '1', rfc5322Text: SIMPLE_TEXT_EMAIL },
        { sourceId: '2', rfc5322Text: header },
      ]);
      expect(buildCorpusTickets(events).stats.orderFallbackThreads).toBe(0);
    }
  });

  // The offset lives inside a comment, so the date itself states no zone.
  // An unanchored search found it there and trusted a host-local parse, which
  // is the whole defect the zone rule exists to prevent.
  // The end anchor. Without it a zone name anywhere in the remainder
  // satisfies the test, and Date.parse then returns a valid instant for a
  // header whose zone is not the date's.
  it('requires the zone at the end of what remains, not anywhere in it', async () => {
    const trailing = LATE_FOLLOWUP_EMAIL.replace(
      'Date: Tue, 7 Jan 2025 10:00:00 +0000',
      'Date: Mon, 5 Jan 2026 10:00:00 GMT, 5 Jan',
    );
    const { events } = await collectEvents([
      { sourceId: '1', rfc5322Text: SIMPLE_TEXT_EMAIL },
      { sourceId: '2', rfc5322Text: trailing },
    ]);
    expect(buildCorpusTickets(events).stats.orderFallbackThreads).toBe(1);
  });

  it('does not mistake an offset inside a comment for a stated zone', async () => {
    const commentOnly = LATE_FOLLOWUP_EMAIL
      .replace('Date: Tue, 7 Jan 2025 10:00:00 +0000', 'Date: Tue, 7 Jan 2025 10:00:00 (GMT+0100)');
    const { events } = await collectEvents([
      { sourceId: '1', rfc5322Text: SIMPLE_TEXT_EMAIL },
      { sourceId: '2', rfc5322Text: commentOnly },
    ]);
    expect(buildCorpusTickets(events).stats.orderFallbackThreads).toBe(1);
  });

  // Every fixture threaded under one root, so `threads` could have been
  // hardcoded to 1, and a thread subject hoisted out of the loop would have
  // leaked into the next thread with nothing to catch it.
  it('keeps two threads apart, with their own subjects and turn numbering', async () => {
    const otherThread = [
      'From: Sam Roe <sam.roe@example.test>',
      'To: support@acme.example',
      'Subject: Cannot export my report',
      'Date: Wed, 8 Jan 2025 09:00:00 +0000',
      'Message-ID: <export-broken@example.test>',
      '',
      'The export button does nothing.',
    ].join('\r\n');
    const { events } = await collectEvents([
      { sourceId: '1', rfc5322Text: SIMPLE_TEXT_EMAIL },
      { sourceId: '2', rfc5322Text: LATE_FOLLOWUP_EMAIL },
      { sourceId: '3', rfc5322Text: otherThread },
    ]);
    const { tickets, stats } = buildCorpusTickets(events);
    expect(stats.threads).toBe(2);
    expect(new Set(tickets.map((t) => t.conversation_id)).size).toBe(2);
    const other = tickets.find((t) => t.body.includes('export button'));
    expect(other?.subject).toBe('Cannot export my report');
    expect(other?.turn_number).toBe(1);
  });

  // The dedup set is file wide, because the validator's uniqueness rule is.
  // The earlier version of this case added a References header to a copy, but
  // both events still landed under one root — so moving the set back inside
  // the thread loop left it green, and the only new behaviour of the hoist
  // was untested. These events are built with two genuinely different roots.
  it('drops a repeat delivery that arrives under a different thread root', async () => {
    const { events } = await collectEvents([{ sourceId: '1', rfc5322Text: SIMPLE_TEXT_EMAIL }]);
    const seed = events[0]!;
    const otherRoot: NormalizedEvent = {
      ...seed,
      sourceId: '2',
      ticket: { ...seed.ticket, ticketId: 'a-different-root@example.test' },
    };
    const { tickets, stats } = buildCorpusTickets([seed, otherRoot]);
    expect(stats.droppedDuplicateMessages).toBe(1);
    expect(tickets).toHaveLength(1);
  });

  // A message first seen under a thread that is then discarded used to claim
  // its id for good, so the surviving copy in a real thread was dropped as a
  // duplicate. A customer turn vanished, and the record showed only a
  // duplicate count.
  it('does not let a discarded thread claim a message id', async () => {
    const { events } = await collectEvents([{ sourceId: '1', rfc5322Text: SIMPLE_TEXT_EMAIL }]);
    const seed = events[0]!;
    // The same message under a thread whose every record is dropped: it
    // states no subject anywhere, so the thread produces nothing.
    const ghost: NormalizedEvent = {
      ...seed,
      sourceId: 'ghost',
      ticket: { ...seed.ticket, ticketId: 'ghost-root@example.test', subject: '' },
      message: { ...seed.message, subject: null },
    };
    const { tickets, stats } = buildCorpusTickets([ghost, seed]);
    expect(stats.droppedSubjectlessThreads).toBe(1);
    // The real thread still holds the customer's turn.
    expect(tickets.map((t) => t.body)).toEqual([seed.message.bodyText]);
  });

  it('names a fallback conversation only when the file holds it', async () => {
    const noZone = SIMPLE_TEXT_EMAIL
      .split('\r\n')
      .filter((line) => !line.startsWith('Subject:'))
      .map((l) => (l.startsWith('Date:') ? 'Date: Mon, 6 Jan 2025 10:04:00' : l))
      .join('\r\n');
    const { events } = await collectEvents([{ sourceId: '1', rfc5322Text: noZone }]);
    const { tickets, stats, orderFallbackConversations } = buildCorpusTickets(events);
    // The thread was ordered by the mailbox and then dropped entirely. Naming
    // it would send a labeller after a conversation the file does not hold.
    expect(tickets).toEqual([]);
    expect(orderFallbackConversations).toEqual([]);
    expect(stats.orderFallbackThreads).toBe(0);
  });

  it.each([
    ['a nested comment', 'Tue, 7 Jan 2025 10:00:00 +0100 (CET (Central European Time))', 0],
    ['a lowercase zone', 'Tue, 7 Jan 2025 10:00:00 gmt', 0],
    ['an unbalanced comment hiding a zone name', 'Tue, 7 Jan 2025 10:00:00 (sent via GMT', 1],
  ])('reads %s correctly', async (_name, date, fallbacks) => {
    const header = LATE_FOLLOWUP_EMAIL.replace('Date: Tue, 7 Jan 2025 10:00:00 +0000', `Date: ${date}`);
    const { events } = await collectEvents([
      { sourceId: '1', rfc5322Text: SIMPLE_TEXT_EMAIL },
      { sourceId: '2', rfc5322Text: header },
    ]);
    expect(buildCorpusTickets(events).stats.orderFallbackThreads).toBe(fallbacks);
  });

  // Cycle 2's nesting fix had no case: reverting depth counting to a single
  // reset left the suite green, because no fixture nested a comment.
  // The zone name sits after an INNER close paren. A strip that resets depth
  // to zero on any ')' leaves ' GMT' behind, so a date that states no zone at
  // all is accepted and parsed against the exporter host's clock. Nesting the
  // comment at the end of the header does not discriminate: both versions
  // then produce identical output, which is how the first version of this
  // case passed against the bug it was written for.
  it('does not let a nested comment leave a zone name behind', async () => {
    const nested = LATE_FOLLOWUP_EMAIL.replace(
      'Date: Tue, 7 Jan 2025 10:00:00 +0000',
      'Date: Tue, 7 Jan 2025 10:00:00 (a (b) GMT)',
    );
    const { events } = await collectEvents([
      { sourceId: '1', rfc5322Text: SIMPLE_TEXT_EMAIL },
      { sourceId: '2', rfc5322Text: nested },
    ]);
    expect(buildCorpusTickets(events).stats.orderFallbackThreads).toBe(1);
  });

  it('reads a readable date whose comment nests', async () => {
    const nested = LATE_FOLLOWUP_EMAIL.replace(
      'Date: Tue, 7 Jan 2025 10:00:00 +0000',
      'Date: Tue, 7 Jan 2025 11:00:00 +0100 (CET (Central European Time))',
    );
    const { events } = await collectEvents([
      { sourceId: '1', rfc5322Text: SIMPLE_TEXT_EMAIL },
      { sourceId: '2', rfc5322Text: nested },
    ]);
    expect(buildCorpusTickets(events).stats.orderFallbackThreads).toBe(0);
  });

  // A message this thread itself discarded used to claim its id, so the same
  // message positioned as a genuine reply elsewhere was dropped and that turn
  // lost its agent half (DEC-37).
  it('does not let a message its own thread discarded claim an id', async () => {
    const { events } = await collectEvents([
      { sourceId: '1', rfc5322Text: SIMPLE_TEXT_EMAIL },
      { sourceId: '2', rfc5322Text: AGENT_REPLY_EMAIL },
    ]);
    const [customer, agent] = events as [NormalizedEvent, NormalizedEvent];
    // Thread A opens with the agent message, which no turn can carry, and
    // then holds a customer turn — so the thread SURVIVES while that one
    // message is discarded. A thread that produced nothing exits before the
    // line under test, which is why the first version of this case passed
    // against the bug it was written for.
    const root = 'orphan-root@example.test';
    const orphanAgent: NormalizedEvent = {
      ...agent, sourceId: 'orphan-agent',
      ticket: { ...agent.ticket, ticketId: root },
    };
    const laterCustomer: NormalizedEvent = {
      ...customer, sourceId: 'orphan-customer',
      ticket: { ...customer.ticket, ticketId: root },
      message: {
        ...customer.message,
        messageId: '<other-customer@example.test>',
        sentAt: 'Tue, 7 Jan 2025 12:00:00 +0000',
      },
    };
    const { tickets, stats } = buildCorpusTickets(
      [orphanAgent, laterCustomer, customer, agent],
      { agentAddresses: ['support@acme.example'] },
    );
    expect(stats.droppedOrphanAgentMessages).toBe(1);
    // Thread B's turn keeps its reply: the discarded copy claimed no id.
    const withReply = tickets.find((t) => t.conversation_id !== root);
    expect(withReply?.agent_reply).toContain('replacement');
  });

  it('refuses a provenance block that disagrees with the records beside it', async () => {
    const { events } = await collectEvents([{ sourceId: '1', rfc5322Text: SIMPLE_TEXT_EMAIL }]);
    const { tickets } = buildCorpusTickets(events);
    const base = { split: CORPUS_SPLIT, source: CORPUS_SOURCE, count: tickets.length, tickets };
    expect(() => validateCorpusFile({ ...base, provenance: provenance({ turns: 999 }) }))
      .toThrow(/provenance.turns is 999/);
    expect(() => validateCorpusFile({ ...base, provenance: provenance({ threads: 4 }) }))
      .toThrow(/provenance.threads is 4/);
    expect(() => validateCorpusFile({
      ...base,
      provenance: { ...provenance(), orderFallbackThreads: 1, order_fallback_conversations: ['not-in-this-file'] },
    })).toThrow(/which the file does not hold/);
    expect(() => validateCorpusFile({
      ...base,
      provenance: { ...provenance(), order_fallback_conversations: ['x'] },
    })).toThrow(/different number of fallback conversations/);
  });

  it('names a repeated corpus ticket by digest, never in the clear', () => {
    const real: GoldTicket = {
      ticket_id: 'abc@customer-domain.example', source: CORPUS_SOURCE, intent: UNLABELED_INTENT,
      queue: 'general',
      disposition: { escalated: false, macro_applied: null, refund_issued: false, first_reply_minutes: 0 },
      subject: 's', body: 'b', conversation_id: 'abc@customer-domain.example', turn_number: 1,
    };
    const call = () => validateCorpusFile({
      split: CORPUS_SPLIT, source: CORPUS_SOURCE, count: 2,
      provenance: provenance({ turns: 2 }), tickets: [real, { ...real, turn_number: 2 }],
    });
    expect(call).toThrow(/id digest [0-9a-f]{12}/);
    expect(call).not.toThrow(/customer-domain\.example/);
  });

  it('names a corpus case by digest when a shared field rule fails', () => {
    const real = {
      ticket_id: 'abc@customer-domain.example', source: CORPUS_SOURCE, intent: UNLABELED_INTENT,
      queue: 'general',
      disposition: { escalated: false, macro_applied: null, refund_issued: false, first_reply_minutes: 0 },
      subject: 's', body: '', conversation_id: 'abc@customer-domain.example', turn_number: 1,
    };
    const call = () => validateCorpusFile({
      split: CORPUS_SPLIT, source: CORPUS_SOURCE, count: 1, provenance: provenance(), tickets: [real],
    });
    expect(call).toThrow(/has no body/);
    expect(call).not.toThrow(/customer-domain\.example/);
  });

  it('records which conversations the mailbox ordered, not the messages', async () => {
    const noZone = LATE_FOLLOWUP_EMAIL
      .replace('Date: Tue, 7 Jan 2025 10:00:00 +0000', 'Date: Tue, 7 Jan 2025 10:30:00');
    const { events } = await collectEvents([
      { sourceId: '1', rfc5322Text: SIMPLE_TEXT_EMAIL },
      { sourceId: '2', rfc5322Text: noZone },
    ]);
    const { orderFallbackConversations } = buildCorpusTickets(events);
    // Named, not just counted: a person labelling this file needs to know
    // which threads carry guessed turn numbers.
    expect(orderFallbackConversations).toEqual(['order-4471-damaged@example.test']);
  });

  // The sibling loader has this case; this one — which reads real mail by
  // construction — did not, so its guard was unproven.
  it('never quotes the corpus file when it cannot be parsed', () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const path = join(dir, 'history.json');
    writeFileSync(path, '{"split":"corpus","tickets":[{"body":"my card was declined"},]}');
    const call = () => loadCorpusFile(path);
    expect(call).toThrow(/not valid JSON/);
    expect(call).toThrow(/content withheld/);
    expect(call).not.toThrow(/card was declined/);
  });

  // The docblock claims one 60-message subjectless thread reports as one
  // thread and sixty messages. Every assertion read the thread counter, so
  // counting 1 per thread passed.
  it('counts the messages a subjectless thread discards, not just the thread', async () => {
    const bare = (n: number) => [
      'From: dana.doe@example.test',
      'To: support@acme.example',
      `Message-ID: <bare-${String(n)}@example.test>`,
      'References: <bare-root@example.test>',
      'Date: Mon, 6 Jan 2025 10:0' + String(n) + ':00 +0000',
      '',
      `Body ${String(n)} with no subject anywhere.`,
    ].join('\r\n');
    const { events } = await collectEvents([
      { sourceId: '1', rfc5322Text: bare(1) },
      { sourceId: '2', rfc5322Text: bare(2) },
      { sourceId: '3', rfc5322Text: bare(3) },
    ]);
    const { stats } = buildCorpusTickets(events);
    expect(stats.droppedSubjectlessThreads).toBe(1);
    expect(stats.droppedSubjectlessMessages).toBe(3);
  });

  // The sibling validator's identical rules are tested in fixtures.test.ts.
  // These, added by the same change to validateCorpusFile, had no case — and
  // two shipped claims lean on them: corpusHistoryItems' docblock, and the
  // runbook's "a corpus file written before the export modeled turns fails
  // to load. The message says a record names no conversation."
  describe('the rules validateCorpusFile adds', () => {
    function record(over: Record<string, unknown> = {}) {
      return {
        ticket_id: 'a@example.test', source: CORPUS_SOURCE, intent: UNLABELED_INTENT,
        queue: 'general',
        disposition: { escalated: false, macro_applied: null, refund_issued: false, first_reply_minutes: 0 },
        subject: 's', body: 'b', conversation_id: 'c@example.test', turn_number: 1,
        ...over,
      };
    }
    const file = (tickets: unknown[], over = {}) => ({
      split: CORPUS_SPLIT, source: CORPUS_SOURCE, count: tickets.length,
      provenance: provenance({ turns: tickets.length, ...over }), tickets,
    });

    it('refuses a record that names no conversation (DEC-35)', () => {
      const bare = record();
      delete (bare as Record<string, unknown>)['conversation_id'];
      expect(() => validateCorpusFile(file([bare]))).toThrow(/names no conversation \(DEC-35\)/);
    });

    it('refuses a turn number that is not a positive integer (DEC-39)', () => {
      expect(() => validateCorpusFile(file([record({ turn_number: 0 })])))
        .toThrow(/turn_number is not a positive integer/);
      expect(() => validateCorpusFile(file([record({ turn_number: 1.5 })])))
        .toThrow(/turn_number is not a positive integer/);
    });

    it('refuses turns that skip a number', () => {
      const two = [record(), record({ ticket_id: 'b@example.test', turn_number: 3 })];
      expect(() => validateCorpusFile(file(two))).toThrow(/numbers its turns/);
    });

    it('refuses an agent_reply that is present but empty', () => {
      expect(() => validateCorpusFile(file([record({ agent_reply: '' })])))
        .toThrow(/agent_reply is present but empty/);
    });

    it('accepts a well-formed two-turn conversation', () => {
      const two = [record({ agent_reply: 'We are looking into it.' }),
        record({ ticket_id: 'b@example.test', turn_number: 2 })];
      expect(validateCorpusFile(file(two, { threads: 1 })).tickets).toHaveLength(2);
    });
  });

  it('rejects a corpus whose records repeat a ticket id', () => {
    const one: GoldTicket = {
      ticket_id: 'dup', source: CORPUS_SOURCE, intent: UNLABELED_INTENT, queue: 'general',
      disposition: { escalated: false, macro_applied: null, refund_issued: false, first_reply_minutes: 0 },
      subject: 's', body: 'b', conversation_id: 'c', turn_number: 1,
    };
    expect(() => validateCorpusFile({
      split: CORPUS_SPLIT, source: CORPUS_SOURCE, count: 2,
      provenance: provenance(), tickets: [one, { ...one, turn_number: 2 }],
    })).toThrow(/repeats the ticket at index 1/);
  });
});
