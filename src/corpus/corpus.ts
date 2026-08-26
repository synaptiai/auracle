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
// the curation loop (docs/operations.md, section 4).

import { readFileSync } from 'node:fs';

import type { NormalizedEvent } from '../adapters/types.js';
import { validateTicketFields } from '../fixtures/load.js';
import type { GoldTicket } from '../fixtures/load.js';

/** Source marker for exported mailbox history. */
export const CORPUS_SOURCE = 'imap';

/** Split marker for history that no person has labeled yet. */
export const CORPUS_SPLIT = 'corpus';

/** Intent placeholder until the labeling step replaces it. */
export const UNLABELED_INTENT = 'unlabeled';

/**
 * Folds normalized inbox events into one GoldTicket-shaped record per
 * thread. The adapter derives the ticket id from the thread root
 * (Message-ID chain), so messages of one conversation merge: the first
 * subject wins and later bodies append. Order follows first appearance.
 *
 * Throws when a merged record would carry an empty subject or body, so a
 * broken export aborts instead of writing a file the validators reject.
 */
export function buildCorpusTickets(events: readonly NormalizedEvent[]): GoldTicket[] {
  const threads = new Map<string, { subject: string; bodies: string[] }>();
  for (const event of events) {
    const existing = threads.get(event.ticket.ticketId);
    if (existing) {
      if (existing.subject.length === 0 && event.message.subject) {
        existing.subject = event.message.subject;
      }
      existing.bodies.push(event.message.bodyText);
    } else {
      threads.set(event.ticket.ticketId, {
        subject: event.ticket.subject,
        bodies: [event.message.bodyText],
      });
    }
  }

  return [...threads.entries()].map(([ticketId, thread]) => {
    const subject = thread.subject;
    const body = thread.bodies.join('\n\n');
    if (subject.length === 0) throw new Error(`corpus export: ticket ${ticketId} has an empty subject`);
    if (body.trim().length === 0) throw new Error(`corpus export: ticket ${ticketId} has an empty body`);
    // Queue falls back to 'general' because plain IMAP reports none
    // (supportsStructuredFields is false). Dispositions are placeholders:
    // untagged history has no outcome truth until a person labels it.
    return {
      ticket_id: ticketId,
      source: CORPUS_SOURCE,
      intent: UNLABELED_INTENT,
      queue: 'general',
      disposition: { escalated: false, macro_applied: null, refund_issued: false, first_reply_minutes: 0 },
      subject,
      body,
    };
  });
}

export interface CorpusFile {
  split: typeof CORPUS_SPLIT;
  source: typeof CORPUS_SOURCE;
  count: number;
  tickets: GoldTicket[];
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
  for (const ticket of tickets) {
    assert(isRecord(ticket), 'corpus ticket is not an object');
    const id = ticket['ticket_id'];
    assert(typeof id === 'string' && id.length > 0, 'corpus ticket has no ticket_id');
    assert(ticket['source'] === CORPUS_SOURCE, `corpus ticket ${id} does not declare source ${CORPUS_SOURCE}`);
    validateTicketFields(ticket);
  }
  const file = raw as unknown as CorpusFile;
  assert(file.count === file.tickets.length, 'corpus count does not match its tickets');
  return file;
}

/** Reads and validates a corpus file from disk for the induction job. */
export function loadCorpusFile(path: string): CorpusFile {
  return validateCorpusFile(JSON.parse(readFileSync(path, 'utf8')));
}
