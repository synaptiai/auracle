// What a fixture file has to look like, decided without reading one.
//
// Split from load.ts, where validation and file reading were interleaved. The
// rules are unchanged, and all three loaders now come through here:
// `validateTaxonomy`, `validateDocuments` and `validateGoldHalf` each take a
// parsed object, so `load.ts` is left with the read.
//
// `assert` and `isRecord` are exported because the digest module enforces
// DEC-31 with the same failure text. One `fixture validation failed:` prefix
// exists, and callers match on it.
import { createHash } from 'node:crypto';

import { RISK_TIERS } from '../domain/capabilities.js';
import {
  CLAIM_GRADES, DOC_KINDS, GOLD_SOURCES, INTENT_CAP,
} from '../domain/gold-types.js';
import type {
  Disposition, FixtureDocument, GoldFile, GoldSource, GoldSplit, GoldTicket, Taxonomy,
} from '../domain/gold-types.js';

export function assert(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(`fixture validation failed: ${message}`);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * What went wrong reading a file, without quoting what the file held.
 *
 * A filesystem fault names the path, which is the operator's own and safe. A
 * parse fault is reported by kind and position only: the position is what an
 * editor needs, and the surrounding text is the customer's. Node embeds a
 * window of the input in a JSON SyntaxError, so a trailing comma in a
 * hand-written half would otherwise put a body on stderr (DEC-18).
 */
export function describeReadFault(err: unknown): string {
  if (!(err instanceof Error)) return 'unknown fault';
  if (err instanceof SyntaxError) {
    const position = /at position (\d+)/.exec(err.message)?.[1];
    const line = /line (\d+) column (\d+)/.exec(err.message);
    const where = line !== null
      ? `line ${String(line[1])} column ${String(line[2])}`
      : position !== undefined ? `position ${position}` : 'an unreported position';
    return `the file is not valid JSON, at ${where} (content withheld, DEC-18)`;
  }
  return err.message;
}

/**
 * An identifier a fault message may carry.
 *
 * A synthetic identifier is generated and means nothing outside this
 * repository, so it is printed. A real one is a Message-ID: it embeds the
 * customer's domain and often a local part their system minted, and a fault
 * reaches a terminal and a CI log where DEC-18 says such a value may not go.
 * An operator matches the digest against their own file.
 *
 * Every fault that names a case goes through this. An earlier version applied
 * it at the two sites its author had in mind and claimed the class; the
 * validators reached from `loadGoldHalf` and from the corpus loader kept
 * printing the raw value, which is the commonest fault path of all.
 */
export function label(id: string, source: GoldSource): string {
  if (source === 'synthetic') return id;
  return `with id digest ${createHash('sha256').update(id).digest('hex').slice(0, 12)}`;
}

/**
 * Validate an unknown value as one half of the gold set.
 *
 * Split out of `loadGoldHalf` so the rules can be tested against a malformed
 * corpus without writing one to disk. Same shape as
 * `validateCalibrationArtifact`: the loader is a thin read around it.
 */
export function validateGoldHalf(raw: unknown, split: GoldSplit, fileName?: string): GoldFile {
  // Named fileName, not label: `label` is the redaction helper this function's
  // own ticket loop depends on, and shadowing it here would be silent.
  const name = fileName ?? `gold/${split}.json`;
  assert(isRecord(raw), `${name} is not an object`);
  assert(raw['split'] === split, `${name} declares split ${String(raw['split'])}`);
  const source = raw['source'];
  assert(
    typeof source === 'string' && (GOLD_SOURCES as readonly string[]).includes(source),
    `${name} declares source ${String(source)}, expected one of ${GOLD_SOURCES.join(', ')}`,
  );
  const tickets = raw['tickets'];
  assert(Array.isArray(tickets), `${name} tickets is not an array`);
  assert(tickets.length > 0, `${name} has no tickets`);
  for (const ticket of tickets) validateTicket(ticket, source as GoldSource);
  const file = raw as unknown as GoldFile;
  assert(file.count === file.tickets.length, `${name} count does not match its tickets`);
  assertConversations(file, name);
  return file;
}

/**
 * A case's per-claim ground truth (DEC-07).
 *
 * Optional, because a real-corpus record carries none. When present every
 * claim is checked: a supported claim names no grade, an unsupported one
 * names a known grade, and every claim cites a document. A draft with no
 * claim would give the fit a coverage of nothing over nothing.
 */
function validateClaims(ticket: Record<string, unknown>, id: string): void {
  const claims = ticket['claims'];
  if (claims === undefined) return;
  assert(Array.isArray(claims), `ticket ${id} has a claims field that is not an array`);
  assert(claims.length > 0, `ticket ${id} carries an empty claims array`);
  for (const [i, raw] of claims.entries()) {
    assert(
      typeof raw === 'object' && raw !== null && !Array.isArray(raw),
      `ticket ${id} claim ${i} is not an object`,
    );
    const claim = raw as Record<string, unknown>;
    assert(
      typeof claim['text'] === 'string' && claim['text'].length > 0,
      `ticket ${id} claim ${i} has no text`,
    );
    assert(
      typeof claim['doc_id'] === 'string' && claim['doc_id'].length > 0,
      `ticket ${id} claim ${i} cites no document`,
    );
    assert(
      typeof claim['supported'] === 'boolean',
      `ticket ${id} claim ${i} has no boolean supported flag`,
    );
    if (claim['supported'] === true) {
      assert(claim['grade'] === null, `ticket ${id} claim ${i} is supported and names a grade`);
    } else {
      assert(
        typeof claim['grade'] === 'string'
          && (CLAIM_GRADES as readonly string[]).includes(claim['grade']),
        `ticket ${id} claim ${i} is unsupported and names no known grade`,
      );
    }
  }
}

/**
 * Field-level checks shared by the synthetic gold set and any file that
 * reuses the GoldFile schema, such as the real-corpus exporter.
 *
 * Identifier-prefix rules are not checked here: they describe the shipped
 * corpus, and each consumer keeps its own. The provenance IS taken, because
 * every fault below names a case and a real identifier must be redacted
 * (DEC-18).
 */
export function validateTicketFields(
  ticket: Record<string, unknown>,
  /**
   * Required, for the reason `scoreDraft` states: a default lets a call site
   * forget it and leak a real identifier with every test still green.
   */
  source: GoldSource,
): void {
  const rawId = typeof ticket['ticket_id'] === 'string' ? ticket['ticket_id'] : '<missing>';
  const id = label(rawId, source);
  assert(typeof ticket['intent'] === 'string', `ticket ${id} has no intent`);
  assert(typeof ticket['queue'] === 'string' && ticket['queue'].length > 0, `ticket ${id} has no queue`);
  assert(typeof ticket['subject'] === 'string' && ticket['subject'].length > 0, `ticket ${id} has no subject`);
  assert(typeof ticket['body'] === 'string' && ticket['body'].length > 0, `ticket ${id} has no body`);
  validateClaims(ticket, id);
  const disposition = ticket['disposition'];
  assert(isRecord(disposition), `ticket ${id} has no disposition object`);
  assert(typeof disposition['escalated'] === 'boolean', `disposition.escalated is not boolean on ${id}`);
  assert(
    disposition['macro_applied'] === null || typeof disposition['macro_applied'] === 'string',
    `disposition.macro_applied is neither null nor string on ${id}`,
  );
  assert(typeof disposition['refund_issued'] === 'boolean', `disposition.refund_issued is not boolean on ${id}`);
  const minutes = disposition['first_reply_minutes'];
  assert(
    typeof minutes === 'number' && Number.isInteger(minutes) && minutes >= 0,
    `disposition.first_reply_minutes is not a non-negative integer on ${id}`,
  );
}

/**
 * Synthetic-corpus checks on top of the shared field rules.
 *
 * The conversation fields live here, not in `validateTicketFields`, for the
 * reason that function's own comment gives: the shared validator keeps only
 * what every consumer shares. The corpus loader checks the same two fields
 * with its own rules, because a corpus file is not a gold half and its
 * identifiers follow no prefix convention.
 */
function validateTicket(value: unknown, source: GoldSource): void {
  assert(isRecord(value), 'ticket is not an object');
  const rawId = value['ticket_id'];
  assert(typeof rawId === 'string' && rawId.length > 0, 'ticket has no ticket_id');
  // Redacted like every other fault that names a case. Cycle 2 threaded the
  // provenance into this function and applied it to what it delegates to,
  // leaving this function's own five messages raw — the same instance-not-
  // class slip the label() comment above describes.
  const id = label(rawId, source);
  // The SYN- prefixes describe the corpus this repository generates, so they
  // bind a half that claims to be it. An adopter's labelled history carries
  // their own identifiers; holding it to the generator's naming would refuse
  // every real half for a reason that says nothing about its correctness.
  if (source === 'synthetic') {
    assert(id.startsWith('SYN-'), 'ticket_id must start with SYN-');
  }
  assert(
    value['source'] === source,
    `ticket ${id} declares source ${String(value['source'])}, but its half declares ${source}`,
  );
  const conversationId = value['conversation_id'];
  assert(
    typeof conversationId === 'string' && conversationId.length > 0,
    `ticket ${id} names no conversation (DEC-35)`,
  );
  if (source === 'synthetic') {
    assert(
      conversationId.startsWith('CONV-SYN-'),
      `ticket ${id} conversation_id must start with CONV-SYN- (DEC-35)`,
    );
  }
  const turnNumber = value['turn_number'];
  assert(
    typeof turnNumber === 'number' && Number.isInteger(turnNumber) && turnNumber >= 1,
    `ticket ${id} turn_number is not a positive integer (DEC-38)`,
  );
  const reply = value['agent_reply'];
  assert(
    reply === undefined || (typeof reply === 'string' && reply.length > 0),
    `ticket ${id} agent_reply is present but empty`,
  );
  validateTicketFields(value, source);
}

/**
 * Checks that the cases of one half describe whole, well-formed
 * conversations: unique ticket ids, turns numbered 1..N with no gap and no
 * repeat, and one intent, queue and disposition per conversation.
 *
 * The last rule is what makes DEC-39 meaningful. A disposition belongs to the
 * thread, so a half that gave two turns of one thread different outcomes would
 * make "score the first turn" a different claim from case to case.
 */
function sameDisposition(a: Disposition, b: Disposition): boolean {
  return (
    a.escalated === b.escalated
    && a.macro_applied === b.macro_applied
    && a.refund_issued === b.refund_issued
    && a.first_reply_minutes === b.first_reply_minutes
  );
}

function assertConversations(file: GoldFile, name: string): void {
  const named = (id: string): string => label(id, file.source);
  const ids = new Set<string>();
  const byConversation = new Map<string, GoldTicket[]>();
  for (const ticket of file.tickets) {
    assert(
      !ids.has(ticket.ticket_id),
      `${name} repeats ticket ${label(ticket.ticket_id, file.source)}`,
    );
    ids.add(ticket.ticket_id);
    const conversationId = ticket.conversation_id ?? '';
    const existing = byConversation.get(conversationId);
    if (existing) existing.push(ticket);
    else byConversation.set(conversationId, [ticket]);
  }

  for (const [conversationId, turns] of byConversation) {
    const numbers = turns.map((turn) => turn.turn_number ?? 0).sort((a, b) => a - b);
    numbers.forEach((number, index) => {
      assert(
        number === index + 1,
        `conversation ${named(conversationId)} numbers its turns ${numbers.join(',')}, expected 1..${numbers.length}`,
      );
    });
    const first = turns.find((turn) => turn.turn_number === 1);
    assert(first !== undefined, `conversation ${named(conversationId)} has no first turn`);
    for (const turn of turns) {
      assert(
        turn.intent === first.intent && turn.queue === first.queue,
        `conversation ${named(conversationId)} changes intent or queue between turns`,
      );
      assert(
        sameDisposition(turn.disposition, first.disposition),
        `conversation ${named(conversationId)} changes its disposition between turns`,
      );
    }
    // Exactly the turns another turn follows carry a reply. The thread ends
    // without one, because the reply to the last turn is what a run would
    // produce. A missing reply on an earlier turn would silently drop the
    // agent half of the history the prompts read (DEC-37).
    //
    // This binds the generated corpus, where the reply is authored beside the
    // turn and its absence is a generator fault. It cannot bind real history:
    // whether an agent answered in writing is a fact about a mailbox, not a
    // rule a half can obey. A thread resolved by telephone records no reply,
    // and refusing it would state something false about the archive. The
    // export reports how much of each conversation it captured instead.
    if (file.source !== 'synthetic') continue;
    const lastNumber = Math.max(...numbers);
    for (const turn of turns) {
      const isLast = turn.turn_number === lastNumber;
      assert(
        (turn.agent_reply === undefined) === isLast,
        isLast
          ? `conversation ${named(conversationId)} records a reply to its last turn`
          : `conversation ${named(conversationId)} turn ${String(turn.turn_number)} has a later turn but no agent_reply`,
      );
    }
  }
}

/** Check that every referenced intent exists in the taxonomy. Callers that
 * need both corpora use this once instead of wiring loaders together. */
export function assertIntentsKnown(taxonomy: Taxonomy, documents: FixtureDocument[]): void {
  const known = new Set(taxonomy.intents.map((i) => i.id));
  for (const document of documents) {
    for (const intent of document.linked_intents) {
      assert(known.has(intent), `document ${document.doc_id} links unknown intent ${intent}`);
    }
  }
}

/**
 * The curated taxonomy, or a refusal (section 4.11).
 *
 * Takes a parsed object rather than a path, so the rules are testable
 * without a file on disk and the loader is left with the read alone.
 */
export function validateTaxonomy(raw: unknown): Taxonomy {
  assert(isRecord(raw), 'taxonomy.json is not an object');
  const intents = raw['intents'];
  assert(Array.isArray(intents), 'taxonomy.intents is not an array');
  assert(intents.length <= INTENT_CAP, `taxonomy has ${intents.length} intents, cap is ${INTENT_CAP}`);
  const seen = new Set<string>();
  for (const entry of intents) {
    assert(isRecord(entry), 'taxonomy intent is not an object');
    const id = entry['id'];
    const label = entry['label'];
    const tier = entry['risk_tier'];
    assert(typeof id === 'string' && id.length > 0, 'taxonomy intent has no id');
    assert(typeof label === 'string' && label.length > 0, `intent ${id} has no label`);
    assert(
      typeof tier === 'string' && (RISK_TIERS as readonly string[]).includes(tier),
      `intent ${id} has invalid risk_tier ${String(tier)}`,
    );
    assert(!seen.has(id), `duplicate intent id ${id}`);
    seen.add(id);
  }
  assert(seen.has('other'), "taxonomy is missing the 'other' group");
  assert(
    raw['intent_cap'] === INTENT_CAP,
    `taxonomy.intent_cap is ${String(raw['intent_cap'])}, expected ${INTENT_CAP}`,
  );
  return raw as unknown as Taxonomy;
}

/**
 * The retrieval corpus, or a refusal (DEC-22, DEC-23).
 *
 * Takes a parsed object, for the same reason `validateTaxonomy` does.
 */
export function validateDocuments(raw: unknown): FixtureDocument[] {
  assert(isRecord(raw), 'documents.json is not an object');
  const documents = raw['documents'];
  assert(Array.isArray(documents), 'documents.documents is not an array');
  assert(documents.length > 0, 'documents.json has no documents');
  const seen = new Set<string>();
  for (const entry of documents) {
    assert(isRecord(entry), 'document is not an object');
    const id = entry['doc_id'];
    assert(
      typeof id === 'string' && /^(DOC|RES)-SYN-/.test(id),
      `doc_id ${String(id)} must start with DOC-SYN- or RES-SYN-`,
    );
    assert(!seen.has(id), `duplicate doc_id ${id}`);
    seen.add(id);
    assert(
      typeof entry['kind'] === 'string' && (DOC_KINDS as readonly string[]).includes(entry['kind']),
      `document ${id} has invalid kind ${String(entry['kind'])}`,
    );
    // DEC-23: every document declares an owner and a review date.
    assert(typeof entry['owner'] === 'string' && entry['owner'].length > 0, `document ${id} has no owner`);
    const reviewBy = entry['review_by'];
    assert(typeof reviewBy === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(reviewBy), `document ${id} has no review_by date`);
    assert(!Number.isNaN(Date.parse(reviewBy)), `document ${id} review_by is not a valid date`);
    assert(typeof entry['title'] === 'string' && entry['title'].length > 0, `document ${id} has no title`);
    assert(typeof entry['body'] === 'string' && entry['body'].length > 0, `document ${id} has no body`);
    assert(typeof entry['url'] === 'string' && entry['url'].startsWith('https://'), `document ${id} url is not https`);
    assert(Array.isArray(entry['linked_intents']), `document ${id} linked_intents is not an array`);
    assert(entry['linked_intents'].length > 0, `document ${id} links no intents`);
  }
  return documents as unknown as FixtureDocument[];
}
