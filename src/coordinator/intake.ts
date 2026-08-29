// Intake seam for the partition consumer (section 4.3). The architecture doc
// says "read the next ticket from its partition" without naming a source; the
// intake table (db/004_intake.sql) is that source. This module is an
// implementation detail, not a decision.
//
// DEC-36: a message is routed to a partition by hash(partition key) % N at
// enqueue time, so a consumer polls only its own partitions with an index
// scan. The partition key is the conversation id, so every turn of one
// conversation lands on one consumer and its runs never race.
//
// DEC-35: intake writes the conversation, the turn and the queue row in one
// transaction, so the queue seam stays wholly in the ledger (DEC-04).
//
// V1 does not correct head-of-line delay inside a partition: the poll reads
// oldest first, so one slow message delays the ones behind it (open item 7).
import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import type { ConversationLinkage } from '../adapters/types.js';
import { partitionOf } from './coordinator.js';

export interface IntakeTicket {
  ticketId: string;
  /**
   * Source identity of this message. A repeat of it deduplicates; a new one
   * enqueues. Never invented: the adapter supplies the message id, or its
   * own delivery id when the source names no message (DEC-24).
   */
  messageId: string;
  ticketText: string;
  /**
   * Who sent this message, when the source names anybody. Conversation
   * membership is checked against it (DEC-35), so an adapter that drops it
   * gives up that check.
   */
  customerAddress?: string | null;
  /** What the adapter knows about the conversation this message joins. */
  linkage?: ConversationLinkage | null;
}

/** What one enqueue resolved or created. */
export interface EnqueueResult {
  conversationId: string;
  turnNumber: number;
  partition: number;
  /** False when this exact message was already queued. */
  enqueued: boolean;
}

/**
 * True when `sender` may write into the conversation `conversationId`.
 *
 * The evidence that resolves a conversation is not authenticated. A mail
 * References header and a webhook ticket id both come from the sender, so
 * without this check a message that names a victim's Message-ID joins the
 * victim's conversation and db/010 persists its text there.
 *
 * The conversation decides, not the message. A conversation with no recorded
 * participant accepts anybody: it was opened before db/012, or by a source
 * that names no address, and refusing those would lock out real customers.
 *
 * A conversation that HAS a participant refuses an unnamed sender. Allowing a
 * null there was a bypass, not a courtesy: `fromAddress` is null whenever the
 * From header is missing or unparseable (src/adapters/mime.ts firstAddress),
 * so an attacker simply omitted it and opted out of the check message by
 * message.
 *
 * This is evidence, not authentication. A forged From still passes. It closes
 * the join that needed no forgery at all.
 */
async function senderMayJoin(
  client: PoolClient,
  conversationId: string,
  sender: string | null,
): Promise<boolean> {
  const row = await client.query<{ customer_address: string | null }>(
    'SELECT customer_address FROM conversation WHERE conversation_id = $1',
    [conversationId],
  );
  const known = row.rows[0]?.customer_address ?? null;
  if (known === null) return true;
  if (sender === null) return false;
  return known.toLowerCase() === sender.toLowerCase();
}

/**
 * Records the sender on a conversation that names nobody yet.
 *
 * Without this, a conversation with no participant accepts every sender for
 * ever, so it becomes a universal absorber: once one exists on a ticket, every
 * later sender the first conversation refuses is routed into it and their
 * messages mix. Claiming it on the first named sender bounds that to one
 * sender, and it also gives a conversation opened before db/012 a participant
 * as soon as one writes to it.
 *
 * Only ever fills a null. It never overwrites a recorded participant, so this
 * cannot be used to take a conversation over.
 */
async function claimConversation(
  client: PoolClient,
  conversationId: string,
  sender: string | null,
): Promise<void> {
  if (sender === null) return;
  await client.query(
    `UPDATE conversation SET customer_address = $2
      WHERE conversation_id = $1 AND customer_address IS NULL`,
    [conversationId, sender],
  );
}

/**
 * Resolves the conversation an inbound message joins, or null for a new one.
 *
 * Two steps, both through the ledger, because only the ledger knows which
 * turns exist. A reply chain resolves through `turn_message_idx`, which is
 * how a customer continues one problem on a fresh thread. Otherwise the
 * ticket resolves through `turn_ticket_idx`.
 *
 * Every candidate passes `senderMayJoin` before it is returned. A refused
 * candidate opens a new conversation instead of joining a stranger's.
 */
async function resolveConversation(
  client: PoolClient,
  ticketId: string,
  linkage: ConversationLinkage | null | undefined,
  sender: string | null,
): Promise<string | null> {
  // Offer every conversation this message could belong to, oldest first, and
  // take the first one the sender may join.
  //
  // There is deliberately NO short-circuit that returns a conversation because
  // it already holds this message id. That block existed and was removed: the
  // message id is caller-supplied on both ingress paths, so returning on it
  // without a membership check let a sender who reuses a known Message-ID
  // write into a stranger's conversation. On the mail path it costs one email
  // — set Message-ID to the victim's root and send no References, and both the
  // ticket id and the message id match. It was the one return path here that
  // skipped DEC-35, and it bought nothing: the scan below already resolves a
  // redelivery to the conversation that holds it, through the membership check
  // rather than around it.
  //
  // Offering only the oldest was the defect. A sender that the oldest refuses
  // never matched any of the others, so it opened a NEW conversation on every
  // message: history lost, rows unbounded, and the turns of one ticket
  // scattered across partitions. Worse, a redelivery of such a message minted
  // yet another conversation, and DEC-38 folds the conversation into the
  // idempotency key — so the key varied per delivery attempt, the outbox
  // UNIQUE(idem_key) stopped suppressing the repeat, and the action ran once
  // per redelivery.
  const candidates: string[] = [];
  const priorIds = linkage?.priorMessageIds ?? [];
  if (priorIds.length > 0) {
    const byMessage = await client.query<{ conversation_id: string }>(
      `SELECT DISTINCT conversation_id, min(created_at) AS first_seen FROM turn
        WHERE inbound_message_id = ANY ($1)
        GROUP BY conversation_id
        ORDER BY first_seen`,
      [[...priorIds]],
    );
    candidates.push(...byMessage.rows.map((row) => row.conversation_id));
  }

  const byTicket = await client.query<{ conversation_id: string }>(
    `SELECT conversation_id, min(created_at) AS first_seen FROM turn
      WHERE ticket_id = $1
      GROUP BY conversation_id
      ORDER BY first_seen`,
    [ticketId],
  );
  candidates.push(...byTicket.rows.map((row) => row.conversation_id));

  for (const candidate of new Set(candidates)) {
    if (await senderMayJoin(client, candidate, sender)) {
      await claimConversation(client, candidate, sender);
      return candidate;
    }
  }
  return null;
}

/**
 * Adds one inbound message to the queue, in the conversation it belongs to.
 *
 * One transaction writes the conversation row when none exists, takes the
 * next turn number under that row's lock, records the turn, and enqueues the
 * message. Concurrent messages of one conversation therefore serialize on
 * `conversation.turn_counter`.
 *
 * The epoch row is created here at 0, below any epoch a run carries. It used
 * to appear lazily on the first fenced write, so two first messages of one
 * ticket had nothing to serialize on. Creating it here gives them a lock,
 * and the first fenced write still raises the epoch above 0 (DEC-28).
 *
 * Idempotent on `(ticket_id, message_id)`: an at-least-once source may
 * redeliver one message, and the second insert does nothing.
 */
export async function enqueueTicket(
  pool: Pool,
  ticket: IntakeTicket,
  partitionCount: number,
): Promise<EnqueueResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      // The epoch row exists before anything locks it (DEC-28).
      await client.query(
        `INSERT INTO ticket_epoch (ticket_id, epoch) VALUES ($1, 0)
         ON CONFLICT (ticket_id) DO NOTHING`,
        [ticket.ticketId],
      );
      await client.query('SELECT epoch FROM ticket_epoch WHERE ticket_id = $1 FOR UPDATE', [
        ticket.ticketId,
      ]);

      const sender = ticket.customerAddress ?? null;
      let conversationId = await resolveConversation(
        client,
        ticket.ticketId,
        ticket.linkage,
        sender,
      );
      if (conversationId === null) {
        conversationId = randomUUID();
        await client.query(
          `INSERT INTO conversation (conversation_id, primary_ticket_id, customer_address)
           VALUES ($1, $2, $3)`,
          [conversationId, ticket.ticketId, sender],
        );
      }

      const partition = partitionOf(conversationId, partitionCount);

      // One message is one turn, for as long as the conversation remembers
      // it. The queue row is deleted at ack, so without this a redelivery
      // after ack would take a second turn number, and DEC-38 would then
      // derive a different idempotency key for the very same request.
      const recorded = await client.query<{ turn_number: number }>(
        `SELECT turn_number FROM turn
          WHERE conversation_id = $1 AND inbound_message_id = $2`,
        [conversationId, ticket.messageId],
      );
      const knownTurn = recorded.rows[0]?.turn_number;

      // Reserve a turn only for a message the conversation has not seen. The
      // counter is taken under the conversation row's lock, which serializes
      // concurrent messages of one conversation.
      let turnNumber = knownTurn;
      if (turnNumber === undefined) {
        const counter = await client.query<{ turn_counter: number }>(
          `UPDATE conversation SET turn_counter = turn_counter + 1
            WHERE conversation_id = $1
          RETURNING turn_counter - 1 AS turn_counter`,
          [conversationId],
        );
        turnNumber = counter.rows[0]!.turn_counter;
      }

      const inserted = await client.query(
        `INSERT INTO intake (ticket_id, message_id, partition, ticket_text,
                             conversation_id, turn_number)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (ticket_id, message_id) DO NOTHING`,
        [
          ticket.ticketId,
          ticket.messageId,
          partition,
          ticket.ticketText,
          conversationId,
          turnNumber,
        ],
      );

      if ((inserted.rowCount ?? 0) === 0) {
        // This exact message is already queued. Roll the reservation back so
        // the counter does not drift on a redelivery.
        await client.query('ROLLBACK');
        // client.query, never pool.query: this function holds the pool's only
        // client on a `max: 1` pool, which every daemon uses. Asking the pool
        // for a second one here waits for a client that this call is itself
        // holding, and the ingress wedges permanently on the first redelivery.
        const queued = await client.query<{ turn_number: number }>(
          'SELECT turn_number FROM intake WHERE ticket_id = $1 AND message_id = $2',
          [ticket.ticketId, ticket.messageId],
        );
        return {
          conversationId,
          turnNumber: queued.rows[0]?.turn_number ?? turnNumber,
          partition,
          enqueued: false,
        };
      }

      if (knownTurn === undefined) {
        // The text is recorded here because the queue row does not survive
        // the ack, and DEC-37 needs it for the prompts of every later turn.
        await client.query(
          `INSERT INTO turn (conversation_id, turn_number, ticket_id,
                             inbound_message_id, body_text)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            conversationId,
            turnNumber,
            ticket.ticketId,
            ticket.messageId,
            ticket.ticketText,
          ],
        );
      }

      await client.query('COMMIT');
      return { conversationId, turnNumber, partition, enqueued: true };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    client.release();
  }
}

/** One polled message, in arrival order within its partition. */
export interface PolledTicket {
  ticketId: string;
  /** Identity of this message; the ack deletes only the matching row. */
  messageId: string;
  partition: number;
  ticketText: string;
  /** DEC-35: the conversation this message belongs to. */
  conversationId: string | null;
  /** Turn number of this message within its conversation. */
  turnNumber: number | null;
  /**
   * DEC-35: the participant the conversation records. The egress checks the
   * recipient it resolves against this, so the addressing path and the
   * membership check cannot disagree.
   */
  customerAddress: string | null;
  /** Open item 7: arrival time, carried to the run row at pickup. */
  enqueuedAt: Date;
}

/**
 * Reads up to `limit` messages from the given partitions, oldest first across
 * each partition. In normal operation exactly one consumer owns each
 * partition (DEC-36), so no row locking is needed.
 *
 * The queue row names its own conversation and turn, set when it was
 * enqueued. A row written before db/008 has neither, so both fields are null
 * and the run behaves as a V1-era run.
 */
export async function pollPartition(
  pool: Pool,
  partitions: readonly number[],
  limit: number,
): Promise<PolledTicket[]> {
  if (partitions.length === 0) return [];
  const rows = await pool.query(
    `SELECT i.ticket_id, i.message_id, i.partition, i.ticket_text, i.enqueued_at,
            i.conversation_id, i.turn_number, c.customer_address
       FROM intake i
       LEFT JOIN conversation c ON c.conversation_id = i.conversation_id
      WHERE i.partition = ANY ($1)
      ORDER BY i.enqueued_at, i.ticket_id, i.message_id
      LIMIT $2`,
    [partitions, limit],
  );
  return rows.rows.map((row) => ({
    ticketId: row['ticket_id'] as string,
    messageId: row['message_id'] as string,
    partition: row['partition'] as number,
    ticketText: row['ticket_text'] as string,
    conversationId: (row['conversation_id'] as string | null) ?? null,
    turnNumber: (row['turn_number'] as number | null) ?? null,
    customerAddress: (row['customer_address'] as string | null) ?? null,
    enqueuedAt: row['enqueued_at'] as Date,
  }));
}

/**
 * Removes one message whose run reached an outcome.
 *
 * Keyed on the message, not the ticket: a ticket may hold several queued
 * messages, and acking the ticket would drop the ones not yet processed.
 */
export async function ackTicket(
  pool: Pool,
  ticketId: string,
  messageId: string,
): Promise<void> {
  const removed = await pool.query(
    'DELETE FROM intake WHERE ticket_id = $1 AND message_id = $2',
    [ticketId, messageId],
  );
  // A delete of zero rows is a distinct result, the same rule section 4.2
  // rule 2 applies to the outbox insert. The queue's own removal path was
  // exempt from it: a message id that does not match leaves the row in place,
  // the run completes and sends, and the consumer re-polls that row on every
  // scan forever. Nothing in the scan outcome distinguishes that from health.
  if (removed.rowCount === 0) {
    throw new Error(
      `ack removed no queue row for ticket ${ticketId} message ${messageId}; `
        + 'the message would be polled again on every scan',
    );
  }
}
