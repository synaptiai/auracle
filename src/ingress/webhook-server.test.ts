import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { WebhookAdapter } from '../adapters/webhook.js';
import type { NormalizedEvent } from '../adapters/types.js';
import {
  WEBHOOK_FULL_PAYLOAD,
  WEBHOOK_FULL_PAYLOAD_REDELIVERY,
  WEBHOOK_MINIMAL_PAYLOAD,
} from './fixtures.js';
import { createWebhookServer, MAX_BODY_BYTES } from './webhook-server.js';

const adapter = new WebhookAdapter();

let server: Server | null = null;
afterEach(async () => {
  if (server !== null) {
    await new Promise<void>((resolve, reject) =>
      server?.close((error) => (error ? reject(error) : resolve())),
    );
    server = null;
  }
});

async function start(onEvent: (event: NormalizedEvent) => void | Promise<void>): Promise<string> {
  server = createWebhookServer({ onEvent });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/webhooks/support`;
}

function post(url: string, body: string): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

describe('webhook ingress driver', () => {
  it('hands a normalized Ticket and Message to the intake seam', async () => {
    const received: NormalizedEvent[] = [];
    const url = await start((event) => void received.push(event));

    const response = await post(url, JSON.stringify(WEBHOOK_FULL_PAYLOAD));

    expect(response.status).toBe(204);
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(
      adapter.normalize({ sourceId: 'irrelevant', raw: WEBHOOK_FULL_PAYLOAD }),
    );
    expect(received[0]?.ticket).toEqual({
      ticketId: 'wh-ticket-4471',
      subject: 'Order 4471 arrived damaged',
      queue: 'shipping',
      status: 'open',
      customerAddress: 'dana.doe@example.test',
    });
    expect(received[0]?.message.messageId).toBe('wh-msg-90001');
    expect(received[0]?.eventId).toBe('evt-webhook-1001');
  });

  it('never invents an eventId when the source gives none (DEC-24)', async () => {
    const received: NormalizedEvent[] = [];
    const url = await start((event) => void received.push(event));

    await post(url, JSON.stringify(WEBHOOK_MINIMAL_PAYLOAD));
    await post(url, JSON.stringify(WEBHOOK_MINIMAL_PAYLOAD));

    expect(received).toHaveLength(2);
    for (const event of received) {
      expect(event.eventId).toBeUndefined();
    }
  });

  it('passes a redelivered eventId through unchanged', async () => {
    const received: NormalizedEvent[] = [];
    const url = await start((event) => void received.push(event));

    await post(url, JSON.stringify(WEBHOOK_FULL_PAYLOAD));
    await post(url, JSON.stringify(WEBHOOK_FULL_PAYLOAD_REDELIVERY));

    expect(received.map((event) => event.eventId)).toEqual([
      'evt-webhook-1001',
      'evt-webhook-1001',
    ]);
  });

  it('answers 400 when the payload is not valid JSON', async () => {
    const url = await start(() => {});

    const response = await post(url, '{not json');

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('JSON');
  });

  it('answers 400 and skips the seam when normalize rejects the payload', async () => {
    const received: NormalizedEvent[] = [];
    const url = await start((event) => void received.push(event));

    const bad = structuredClone(WEBHOOK_FULL_PAYLOAD) as typeof WEBHOOK_FULL_PAYLOAD & {
      ticket: { status: string };
    };
    bad.ticket.status = 'done';
    const response = await post(url, JSON.stringify(bad));

    expect(response.status).toBe(400);
    expect(received).toHaveLength(0);
  });

  it('answers 405 for non-POST requests', async () => {
    const url = await start(() => {});

    const response = await fetch(url);

    expect(response.status).toBe(405);
  });

  it('answers 500 when the intake handler rejects, so at-least-once sources retry', async () => {
    const url = await start(() => Promise.reject(new Error('intake down')));

    const response = await post(url, JSON.stringify(WEBHOOK_MINIMAL_PAYLOAD));

    expect(response.status).toBe(500);
  });

  it('answers 413 when the body exceeds MAX_BODY_BYTES', async () => {
    const url = await start(() => {});

    const oversized = 'x'.repeat(MAX_BODY_BYTES + 1);
    const response = await post(url, `{"pad":"${oversized}"}`);

    expect(response.status).toBe(413);
  });

  it('awaits the intake handler before answering 204', async () => {
    let resolved = false;
    const url = await start(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            resolved = true;
            resolve();
          }, 10);
        }),
    );

    const response = await post(url, JSON.stringify(WEBHOOK_MINIMAL_PAYLOAD));

    expect(response.status).toBe(204);
    expect(resolved).toBe(true);
  });
});
