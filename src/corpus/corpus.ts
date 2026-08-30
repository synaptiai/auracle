// Real-corpus export (gap G4, phase 1 on real data).
//
// Reads the mailbox through the existing IMAP fetcher path (ImapPoller +
// ImapSmtpAdapter) and writes one corpus file in the GoldFile schema that
// scripts/generate-fixtures.mjs emits: the same ticket fields, validated by
// the same field checks. The synthetic loaders in src/fixtures/load.ts keep
// their DEC-18 guards untouched; this module applies its own source rule.
//
// The export never enters git: the whole corpus/ directory is gitignored
// and every record here is real customer text (DEC-18).
//
// Untagged history (DEC-02): the mailbox carries no intent labels and no
// outcome truth. Each exported ticket holds `intent: 'unlabeled'` and a
// placeholder disposition. A person fills both during the labeling step of
// the curation loop (docs/operations.md, "The real-corpus curation loop").

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { NormalizedEvent } from '../adapters/types.js';
import {
  describeReadFault,
  goldCaseText,
  isFirstTurn,
  validateTicketFields,
} from '../fixtures/load.js';
import type { GoldTicket } from '../fixtures/load.js';
import type { HistoryItem } from '../jobs/taxonomy-induction.js';

/** Source marker for exported mailbox history. */
export const CORPUS_SOURCE = 'imap';

/** Split marker for history that no person has labeled yet. */
export const CORPUS_SPLIT = 'corpus';

/** Intent placeholder until the labeling step replaces it. */
export const UNLABELED_INTENT = 'unlabeled';

/** What one export pass emitted, and what it could not represent. */
export interface CorpusExportStats {
  /** Threads that produced at least one record. */
  readonly threads: number;
  /** Records emitted, one per customer turn. */
  readonly turns: number;
  /**
   * Threads ordered by delivery order because a message stated no readable
   * time. Reported rather than hidden: a fallback thread states a turn order
   * that the mailbox, not the conversation, decided.
   */
  readonly orderFallbackThreads: number;
  /** Messages from neither party. The gold schema has no field for them. */
  readonly droppedSystemMessages: number;
  /** Messages carrying no body text. A record with an empty body fails validation. */
  readonly droppedEmptyMessages: number;
  /** Agent messages that precede every customer turn, so no turn can carry them. */
  readonly droppedOrphanAgentMessages: number;
  /**
   * Repeat deliveries of one message, by message id.
   *
   * A shared or archived mailbox holds an INBOX copy and a Sent or All-Mail
   * copy of the same message, and that is exactly the mailbox an export with
   * declared agent addresses points at. Without this the second copy became
   * a bogus extra turn and the whole export then failed validation.
   */
  readonly droppedDuplicateMessages: number;
  /**
   * Threads where no message carries a subject at all.
   *
   * Dropped and counted like any other record this schema cannot hold. An
   * earlier version threw, which discarded a whole mailbox export over one
   * message — the fault the offline jobs move their directory checks ahead of
   * the model loop to avoid.
   */
  readonly droppedSubjectlessThreads: number;
  /**
   * Messages discarded with those threads.
   *
   * The thread count alone cannot be reconciled against the message count an
   * export started from, and the runbook tells an operator to do exactly
   * that. One 60-message subjectless thread reports as one thread and sixty
   * messages.
   */
  readonly droppedSubjectlessMessages: number;
}

export interface CorpusExport {
  tickets: GoldTicket[];
  stats: CorpusExportStats;
  /** Conversations whose turn order the mailbox decided, not the messages. */
  orderFallbackConversations: string[];
}

export interface CorpusExportOptions {
  /**
   * Mail addresses that belong to the support side. A message from one of
   * them is an agent reply.
   *
   * The operator declares them, because the ingress adapter cannot. Mail
   * ingress marks every inbound message `author: 'customer'`, and it is right
   * to: the live path reads an inbox, and an inbound message there is a
   * customer writing in. An export reads whatever mailbox the operator points
   * it at, including a shared or archived one that holds both halves of the
   * thread. Nothing in the message itself says which side sent it, so the
   * operator says.
   *
   * Empty by default. Then no message is read as an agent reply, and the
   * export records the customer's half only, which is what an inbox holds.
   */
  readonly agentAddresses?: readonly string[];
}

/** Whether this message is the support side answering, per the rules above. */
function isAgentMessage(event: NormalizedEvent, agentAddresses: ReadonlySet<string>): boolean {
  if (event.message.author === 'agent') return true;
  const from = event.message.fromAddress;
  return from !== null && agentAddresses.has(from.trim().toLowerCase());
}

/**
 * A Date header states a zone, or it states nothing this can use.
 *
 * RFC 5322 obsolete syntax permits a date with no zone, and such headers do
 * occur. `Date.parse` accepts one and resolves it in the EXPORTER HOST's
 * local zone, which is not a property of the message at all. Two hosts an
 * hour apart then number one mailbox's turns differently, and a zone-less
 * 10:30 sorts ahead of a stated 10:00 UTC with nothing reported.
 *
 * So a zone is required, and it must be the zone of the date rather than a
 * string that merely looks like one. A parenthesised comment is stripped
 * first: `10:00:00 (GMT+0100)` states no zone, and an unanchored search
 * would find the offset inside the comment and trust a host-local parse.
 * The test then anchors at the end of what remains.
 */
const ZONE = /(?:[+-]\d{4}|[+-]\d{2}:\d{2}|(?:\b|\d)(?:UTC|UT|GMT|Z|EST|EDT|CST|CDT|MST|MDT|PST|PDT))$/i;

/**
 * Remove RFC 5322 comments, which nest.
 *
 * A single non-nesting pass mis-handled both directions. `(CET (Central
 * European Time))` left a stray `)` and rejected a readable date, and an
 * unbalanced `(sent via GMT` left the name behind and accepted a date that
 * states no zone at all. Counting depth handles both, and an unclosed comment
 * consumes the rest of the string, which is what an unterminated comment
 * means.
 */
function stripComments(raw: string): string {
  let depth = 0;
  let out = '';
  for (const char of raw) {
    if (char === '(') depth += 1;
    else if (char === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0) out += char;
  }
  return out;
}

/**
 * Milliseconds a message states it was sent, or null when it states none
 * this can read.
 *
 * `sentAt` holds the raw Date header for mail ingress; the ledger parses it
 * at its own edge and so does this. A header with no usable zone is null,
 * not a host-local guess — see the zone rule above.
 */
function statedTime(event: NormalizedEvent): number | null {
  const raw = event.message.sentAt;
  if (raw === null) return null;
  if (!ZONE.test(stripComments(raw).trim())) return null;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Turns normalized inbox events into one GoldTicket-shaped record per turn.
 *
 * The adapter derives the ticket id from the thread root, so the messages of
 * one conversation group under it; that id becomes `conversation_id`, and
 * each message keeps its own identity as `ticket_id`.
 *
 * Order comes from each message's own stated time, never from delivery
 * order. A mailbox routinely delivers a thread out of order, and numbering by
 * arrival would render a message as history for one the customer wrote
 * earlier — a prompt describing a conversation that never happened. When a
 * message of a thread states no readable time the whole thread falls back to
 * delivery order, and the fallback is counted rather than hidden.
 *
 * An agent reply is recognised by its sender address, which the operator
 * declares (see CorpusExportOptions). A reply takes no turn number of its own. It hangs off the turn it
 * answered, exactly as `turn.approved_reply_text` does in the ledger, so the
 * inbound sequence DEC-38 keys on stays the inbound sequence. Two agent
 * messages before the next customer turn join, because both reached the
 * customer before that turn.
 *
 * A message this schema cannot represent is dropped and counted, never
 * thrown on: aborting a whole mailbox export over one attachment-only
 * message helps nobody, and a silent drop would overstate what the corpus
 * holds. Every counter in CorpusExportStats names something the corpus does
 * not contain, and the CLI prints all of them.
 */
export function buildCorpusTickets(
  events: readonly NormalizedEvent[],
  options: CorpusExportOptions = {},
): CorpusExport {
  const agentAddresses = new Set(
    (options.agentAddresses ?? []).map((address) => address.trim().toLowerCase()),
  );
  const threads = new Map<string, NormalizedEvent[]>();
  for (const event of events) {
    const existing = threads.get(event.ticket.ticketId);
    if (existing) existing.push(event);
    else threads.set(event.ticket.ticketId, [event]);
  }

  const tickets: GoldTicket[] = [];
  let threadCount = 0;
  let orderFallbackThreads = 0;
  const orderFallbackConversations: string[] = [];
  let droppedSystemMessages = 0;
  let droppedEmptyMessages = 0;
  let droppedOrphanAgentMessages = 0;
  let droppedDuplicateMessages = 0;
  let droppedSubjectlessThreads = 0;
  let droppedSubjectlessMessages = 0;

  // File wide, because validateCorpusFile enforces ticket_id uniqueness
  // across the whole file. A per-thread set let one Message-ID appear under
  // two thread roots — a forwarded copy, or a list that rewrote References —
  // and the export then died on the repeated id after fetching the whole
  // mailbox. Dedup and the invariant it serves now have one scope.
  const seenMessages = new Set<string>();
  for (const [conversationId, arrived] of threads) {
    const usable: NormalizedEvent[] = [];
    const threadSeen = new Set<string>();
    for (const event of arrived) {
      if (event.message.author === 'system') {
        droppedSystemMessages += 1;
        continue;
      }
      if (event.message.bodyText.trim().length === 0) {
        droppedEmptyMessages += 1;
        continue;
      }
      // One mailbox can deliver a message twice: an INBOX copy and a Sent or
      // All-Mail copy of the same mail. A second copy is not a second turn.
      const identity = event.message.messageId ?? event.sourceId;
      if (seenMessages.has(identity) || threadSeen.has(identity)) {
        droppedDuplicateMessages += 1;
        continue;
      }
      threadSeen.add(identity);
      usable.push(event);
    }
    if (usable.length === 0) continue;

    // One unreadable time makes the whole thread's ordering untrustworthy:
    // a mix of stated and assumed positions is not an order, it is a guess.
    const times = usable.map(statedTime);
    const guessedOrder = times.some((time) => time === null);
    const ordered = guessedOrder
      ? usable
      // Stable, so two messages stating one time keep their delivery order.
      : [...usable].sort((a, b) => (statedTime(a) ?? 0) - (statedTime(b) ?? 0));

    // A follow-up sent with no Subject header still belongs to its thread, so
    // it inherits the first subject the thread states rather than being
    // dropped. Only a thread where nothing states a subject has no record
    // this schema can hold, and that is dropped and counted like the rest.
    const threadSubject = ordered
      .map((event) => (event.message.subject ?? '').trim())
      .find((value) => value.length > 0);
    if (threadSubject === undefined) {
      droppedSubjectlessThreads += 1;
      droppedSubjectlessMessages += ordered.length;
      continue;
    }

    const emitted: GoldTicket[] = [];
    const kept: NormalizedEvent[] = [];
    for (const event of ordered) {
      if (isAgentMessage(event, agentAddresses)) {
        const answered = emitted[emitted.length - 1];
        if (answered === undefined) {
          // An agent message before any customer turn opens a thread this
          // schema cannot model: no turn exists for the reply to answer.
          droppedOrphanAgentMessages += 1;
          continue;
        }
        answered.agent_reply =
          answered.agent_reply === undefined
            ? event.message.bodyText
            : `${answered.agent_reply}\n\n${event.message.bodyText}`;
        kept.push(event);
        continue;
      }
      emitted.push({
        // The message's own identity, falling back to the adapter's delivery
        // id when the source states none (the rule intake already applies).
        ticket_id: event.message.messageId ?? event.sourceId,
        source: CORPUS_SOURCE,
        intent: UNLABELED_INTENT,
        // Queue falls back to 'general' because plain IMAP reports none
        // (supportsStructuredFields is false). Dispositions are placeholders:
        // untagged history has no outcome truth until a person labels it.
        queue: 'general',
        disposition: { escalated: false, macro_applied: null, refund_issued: false, first_reply_minutes: 0 },
        subject: (event.message.subject ?? '').trim().length > 0
          ? event.message.subject as string
          : threadSubject,
        body: event.message.bodyText,
        conversation_id: conversationId,
        turn_number: emitted.length + 1,
      });
      kept.push(event);
    }
    if (emitted.length === 0) continue;
    threadCount += 1;
    // Counted here, not where the order was decided. A thread dropped after
    // that point is not in the file, and naming it would send a labeller
    // looking for a conversation the corpus does not hold — while the count
    // it is compared against would never match.
    if (guessedOrder) {
      orderFallbackThreads += 1;
      orderFallbackConversations.push(conversationId);
    }
    // A message counts as seen once it is IN the file, not once its thread
    // survives. The earlier rule claimed ids for messages this thread itself
    // discarded — an agent message that opened a thread, say — so the same
    // message positioned as a genuine reply in another thread was dropped as
    // a duplicate, and that turn lost its agent half (DEC-37).
    for (const event of kept) seenMessages.add(event.message.messageId ?? event.sourceId);
    tickets.push(...emitted);
  }

  return {
    tickets,
    orderFallbackConversations,
    stats: {
      threads: threadCount,
      turns: tickets.length,
      orderFallbackThreads,
      droppedSystemMessages,
      droppedEmptyMessages,
      droppedOrphanAgentMessages,
      droppedDuplicateMessages,
      droppedSubjectlessThreads,
      droppedSubjectlessMessages,
    },
  };
}

/**
 * The history the taxonomy-induction job clusters, from exported records.
 *
 * First turns only. A later turn names no topic of its own — "thanks, that
 * worked" answers a thread rather than opening one — so clustering it would
 * spend one of the 25 intents (DEC-10) on a group no person can name, and
 * would push a real intent into `other`. The taxonomy describes what a
 * customer writes in first.
 *
 * `isFirstTurn` treats an absent `turn_number` as a first turn. That branch
 * is defensive only now: this filter landed one commit before the export
 * modelled turns, so it was a proved no-op on the records of the day, and
 * `validateCorpusFile` has required a turn number ever since. A corpus file
 * written before that change no longer loads at all.
 *
 * The text is `goldCaseText`, the one definition every job shares: an
 * induction run must read the same string the classifier will.
 */
export function corpusHistoryItems(tickets: readonly GoldTicket[]): HistoryItem[] {
  return tickets.filter(isFirstTurn).map((ticket) => ({
    id: ticket.ticket_id,
    text: goldCaseText(ticket),
  }));
}

export interface CorpusFile {
  split: typeof CORPUS_SPLIT;
  source: typeof CORPUS_SOURCE;
  count: number;
  /**
   * What the export emitted and what it could not represent.
   *
   * Carried in the file, not only printed. A thread that fell back to
   * delivery order holds turn numbers the mailbox decided rather than the
   * conversation, and a person labelling this file a week later has no other
   * way to know. The counts also let that person reconcile the file against
   * the mailbox it came from.
   */
  provenance: CorpusExportStats & {
    /** Conversations whose turn order the mailbox decided, not the messages. */
    order_fallback_conversations: string[];
    /** Messages the ingress adapter could not normalize at all. */
    normalization_failures: number;
  };
  tickets: GoldTicket[];
}

/**
 * A short, stable name for an identifier, for a message that must not carry
 * one.
 *
 * A corpus file holds real mail by construction, so its identifiers are
 * Message-IDs: they embed the customer's domain and often a local part their
 * system minted. A validation fault reaches a terminal and a CI log, where
 * DEC-18 says such a value may not go. An operator matches the digest against
 * their own file; the log cannot be read back to an address.
 */
export function idDigest(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 12);
}

function assert(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(`corpus validation failed: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates one parsed corpus file. Same schema keys as a gold half file;
 * `split: 'corpus'` marks pre-labeling history, so the gold-half loaders
 * refuse it until a person labels and splits it (DEC-31 discipline).
 */
export function validateCorpusFile(raw: unknown): CorpusFile {
  assert(isRecord(raw), 'corpus file is not an object');
  assert(raw['split'] === CORPUS_SPLIT, `corpus file declares split ${String(raw['split'])}`);
  assert(raw['source'] === CORPUS_SOURCE, `corpus file declares source ${String(raw['source'])}`);
  const tickets = raw['tickets'];
  assert(Array.isArray(tickets), 'corpus tickets is not an array');
  assert(tickets.length > 0, 'corpus file holds no tickets');
  const seen = new Set<string>();
  const byConversation = new Map<string, number[]>();
  for (const [index, ticket] of tickets.entries()) {
    assert(isRecord(ticket), `corpus ticket at index ${index} is not an object`);
    const id = ticket['ticket_id'];
    assert(typeof id === 'string' && id.length > 0, 'corpus ticket has no ticket_id');
    // A record now holds one turn, so two turns of one thread must not share
    // an identity. A source that states no Message-ID falls back to the
    // delivery id, and nothing outside this check would notice a collision.
    assert(!seen.has(id), `corpus file repeats the ticket at index ${index} (id digest ${idDigest(id)})`);
    seen.add(id);
    assert(
      ticket['source'] === CORPUS_SOURCE,
      `corpus ticket at index ${index} does not declare source ${CORPUS_SOURCE}`,
    );
    const conversationId = ticket['conversation_id'];
    assert(
      typeof conversationId === 'string' && conversationId.length > 0,
      `corpus ticket at index ${index} names no conversation (DEC-35)`,
    );
    const turnNumber = ticket['turn_number'];
    assert(
      typeof turnNumber === 'number' && Number.isInteger(turnNumber) && turnNumber >= 1,
      `corpus ticket at index ${index} turn_number is not a positive integer`,
    );
    const reply = ticket['agent_reply'];
    assert(
      reply === undefined || (typeof reply === 'string' && reply.length > 0),
      `corpus ticket at index ${index} agent_reply is present but empty`,
    );
    const turns = byConversation.get(conversationId);
    if (turns) turns.push(turnNumber);
    else byConversation.set(conversationId, [turnNumber]);
    // Real mail by construction, so every fault here names a case by digest.
    validateTicketFields(ticket, 'real');
  }
  // Turns numbered 1..N with no gap and no repeat. A gap would make a
  // rendered history quote a turn the file does not hold.
  for (const [conversationId, turns] of byConversation) {
    const sorted = [...turns].sort((a, b) => a - b);
    for (const [position, turn] of sorted.entries()) {
      assert(
        turn === position + 1,
        `corpus conversation ${idDigest(conversationId)} numbers its turns `
          + `${sorted.join(', ')}, expected 1..${sorted.length}`,
      );
    }
  }
  const provenance = raw['provenance'];
  assert(isRecord(provenance), 'corpus file states no provenance block');
  for (const field of [
    'threads', 'turns', 'orderFallbackThreads', 'droppedSystemMessages',
    'droppedEmptyMessages', 'droppedOrphanAgentMessages', 'droppedDuplicateMessages',
    'droppedSubjectlessThreads', 'droppedSubjectlessMessages', 'normalization_failures',
  ] as const) {
    const value = provenance[field];
    assert(
      typeof value === 'number' && Number.isInteger(value) && value >= 0,
      `corpus provenance.${field} is not a non-negative integer`,
    );
  }
  const fallbacks = provenance['order_fallback_conversations'];
  assert(
    Array.isArray(fallbacks) && fallbacks.every((id) => typeof id === 'string'),
    'corpus provenance.order_fallback_conversations is not an array of strings',
  );
  const file = raw as unknown as CorpusFile;
  assert(file.count === file.tickets.length, 'corpus count does not match its tickets');

  // The block is only worth carrying if it cannot disagree with the records
  // beside it. Typed-and-unchecked, a hand-edited file could declare no
  // fallbacks over a corpus where every thread was ordered by the mailbox,
  // and the person labelling it would never know.
  const conversations = new Set(
    file.tickets.map((ticket) => ticket.conversation_id).filter((id): id is string => id !== undefined),
  );
  assert(
    file.provenance.turns === file.tickets.length,
    `corpus provenance.turns is ${file.provenance.turns}, but the file holds ${file.tickets.length} records`,
  );
  assert(
    file.provenance.threads === conversations.size,
    `corpus provenance.threads is ${file.provenance.threads}, `
      + `but the file holds ${conversations.size} conversations`,
  );
  assert(
    file.provenance.order_fallback_conversations.length === file.provenance.orderFallbackThreads,
    'corpus provenance names a different number of fallback conversations than it counts',
  );
  for (const id of file.provenance.order_fallback_conversations) {
    assert(
      conversations.has(id),
      `corpus provenance names fallback conversation ${idDigest(id)}, which the file does not hold`,
    );
  }
  return file;
}

/** Reads and validates a corpus file from disk for the induction job. */
export function loadCorpusFile(path: string): CorpusFile {
  // A read or parse fault carries no path of its own: a directory gives
  // 'EISDIR: illegal operation on a directory, read', which names neither the
  // file nor the variable that pointed at it.
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err: unknown) {
    // Never the parse message: this file holds real mail by construction.
    throw new Error(`cannot read the corpus file at ${path}: ${describeReadFault(err)}`);
  }
  return validateCorpusFile(raw);
}
