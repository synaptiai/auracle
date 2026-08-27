// Intake seam for the partition consumer (section 4.3). The architecture doc
// says "read the next ticket from its partition" without naming a source; the
// intake table (db/004_intake.sql) is that source. This module is an
// implementation detail, not a decision.
//
// DEC-27: tickets are routed to a partition by hash(ticket_id) % N at enqueue
// time, so a consumer polls only its own partitions with an index scan.
//
// V1 does not correct head-of-line delay inside a partition: the poll reads
// oldest first, so one slow ticket delays the ones behind it (V2 open item 7).
import type { Pool } from 'pg';

import { partitionOf } from './coordinator.js';

export interface IntakeTicket {
  ticketId: string;
  ticketText: string;
}

/**
 * Adds a ticket to the intake queue under its DEC-27 partition. Idempotent
 * on ticket_id: an at-least-once source (e.g. the IMAP daemon redelivering
 * mail that was never marked seen) may enqueue the same ticket twice while
 * the first copy still waits in the queue; the second insert does nothing.
 */
export async function enqueueTicket(
  pool: Pool,
  ticket: IntakeTicket,
  partitionCount: number,
): Promise<void> {
  await pool.query(
    'INSERT INTO intake (ticket_id, partition, ticket_text) VALUES ($1, $2, $3) ON CONFLICT (ticket_id) DO NOTHING',
    [ticket.ticketId, partitionOf(ticket.ticketId, partitionCount), ticket.ticketText],
  );
}

/** One polled ticket, in arrival order within its partition. */
export interface PolledTicket {
  ticketId: string;
  partition: number;
  ticketText: string;
}

/**
 * Reads up to `limit` tickets from the given partitions, oldest first across
 * each partition. In normal operation exactly one consumer owns each
 * partition (DEC-27), so no row locking is needed.
 */
export async function pollPartition(
  pool: Pool,
  partitions: readonly number[],
  limit: number,
): Promise<PolledTicket[]> {
  if (partitions.length === 0) return [];
  const rows = await pool.query(
    `SELECT ticket_id, partition, ticket_text
     FROM intake
     WHERE partition = ANY ($1)
     ORDER BY enqueued_at, ticket_id
     LIMIT $2`,
    [partitions, limit],
  );
  return rows.rows.map((row) => ({
    ticketId: row['ticket_id'] as string,
    partition: row['partition'] as number,
    ticketText: row['ticket_text'] as string,
  }));
}

/** Removes a ticket whose run reached an outcome. */
export async function ackTicket(pool: Pool, ticketId: string): Promise<void> {
  await pool.query('DELETE FROM intake WHERE ticket_id = $1', [ticketId]);
}
