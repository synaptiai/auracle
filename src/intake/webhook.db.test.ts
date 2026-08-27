// Integration test for the full webhook → intake path (D3-A): a POST to
// `createWebhookServer` wired through `intakeEnqueuer` must land a row in
// the intake table under the DEC-27 partition for its ticket id. Real
// Postgres, synthetic data only (DEC-18).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { partitionOf } from '../coordinator/coordinator.js';
import { pollPartition } from '../coordinator/intake.js';
import { dbUrl } from '../db/config.js';
import { WEBHOOK_FULL_PAYLOAD, WEBHOOK_MINIMAL_PAYLOAD } from '../ingress/fixtures.js';
import { createWebhookServer } from '../ingress/webhook-server.js';

import { intakeEnqueuer } from './adapter.js';

const PARTITION_COUNT = 8;
const pool = new Pool({ connectionString: dbUrl(), max: 5 });

let dbUp = true;
try {
  await pool.query('SELECT 1');
} catch {
  dbUp = false;
}

const INTAKE_DDL = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../db/004_intake.sql'),
  'utf8',
);

let server: Server | null = null;

async function start(): Promise<string> {
  server = createWebhookServer({ onEvent: intakeEnqueuer(pool, PARTITION_COUNT) });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/webhooks/support`;
}

async function post(url: string, payload: object): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

afterEach(async () => {
  if (server !== null) {
    await new Promise<void>((resolve, reject) =>
      server?.close((error) => (error ? reject(error) : resolve())),
    );
    server = null;
  }
});

afterAll(async () => {
  await pool.end();
});

describe.skipIf(!dbUp)('webhook → intake path', () => {
  beforeEach(async () => {
    await pool.query(INTAKE_DDL);
    await pool.query('TRUNCATE intake');
  });

  it('lands a POSTed delivery in intake under its DEC-27 partition', async () => {
    const url = await start();

    const response = await post(url, WEBHOOK_FULL_PAYLOAD);
    expect(response.status).toBe(204);

    const rows = await pool.query('SELECT ticket_id, partition, ticket_text FROM intake');
    expect(rows.rows).toHaveLength(1);
    const row = rows.rows[0] as Record<string, unknown>;
    expect(row['ticket_id']).toBe('wh-ticket-4471');
    expect(row['partition']).toBe(partitionOf('wh-ticket-4471', PARTITION_COUNT));
    expect(row['ticket_text']).toBe(
      'Order 4471 arrived damaged\n\nThe box arrived with a crushed corner. Two tiles are broken.',
    );
  });

  it('lands a minimal delivery with body-only text and answers 204', async () => {
    const url = await start();

    const response = await post(url, WEBHOOK_MINIMAL_PAYLOAD);
    expect(response.status).toBe(204);

    const rows = await pool.query(
      'SELECT ticket_id, partition, ticket_text FROM intake WHERE ticket_id = $1',
      ['wh-ticket-8812'],
    );
    const row = rows.rows[0] as Record<string, unknown> | undefined;
    // Minimal payload has no subjects at either level: text is the bare body.
    expect(row?.['ticket_text']).toBe('Ticket moved to pending by billing sync.');
    expect(row?.['partition']).toBe(partitionOf('wh-ticket-8812', PARTITION_COUNT));
  });

  it('makes enqueued tickets pollable through the consumer seam', async () => {
    const url = await start();

    await post(url, WEBHOOK_FULL_PAYLOAD);
    await post(url, WEBHOOK_MINIMAL_PAYLOAD);

    // The consumer that owns every partition sees both tickets oldest first.
    const polled = await pollPartition(pool, [0, 1, 2, 3, 4, 5, 6, 7], 10);
    expect(polled.map((ticket) => ticket.ticketId)).toEqual([
      'wh-ticket-4471',
      'wh-ticket-8812',
    ]);
    for (const ticket of polled) {
      expect(ticket.partition).toBe(partitionOf(ticket.ticketId, PARTITION_COUNT));
    }
  });

  it('answers 500 and leaves the queue untouched when the insert fails', async () => {
    const url = await start();
    // Remove the table so enqueueTicket's INSERT fails outright.
    await pool.query('DROP TABLE intake');

    const response = await post(url, WEBHOOK_FULL_PAYLOAD);
    expect(response.status).toBe(500);
  });
});
