import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { WebhookAdapter } from '../adapters/webhook.js';
import type { NormalizedEvent } from '../adapters/types.js';
import {
  WEBHOOK_FULL_PAYLOAD,
  WEBHOOK_FULL_PAYLOAD_REDELIVERY,
  WEBHOOK_MINIMAL_PAYLOAD,
} from './fixtures.js';
import { expectEscaped, HOSTILE } from '../test-support/raw-log.js';
import { createWebhookServer, MAX_BODY_BYTES, SIGNATURE_HEADER } from './webhook-server.js';

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

async function start(
  onEvent: (event: NormalizedEvent) => void | Promise<void>,
  extra: { secret?: string; log?: (entry: Record<string, unknown>) => void } = {},
): Promise<string> {
  server = createWebhookServer({
    onEvent,
    // Quiet by default: the server logs an open-port warning at startup.
    log: extra.log ?? ((): void => {}),
    ...(extra.secret === undefined ? {} : { secret: extra.secret }),
  });
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
    // The event now carries the receipt id the server minted, so normalize
    // with that same id rather than a literal. The id is a receipt only: it
    // is not stable across redelivery, which is why intake prefers the
    // message id over it (DEC-24).
    const sourceId = received[0]!.sourceId;
    expect(sourceId).toMatch(/^wh-/);
    expect(received[0]).toEqual(
      adapter.normalize({ sourceId, raw: WEBHOOK_FULL_PAYLOAD }),
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

// Unauthenticated, this port lets any caller enqueue a ticket, which spends
// the adopter's model budget. The reference driver still runs open from a
// fresh checkout, so the check exists only when a shared key is configured,
// and the server says so at startup when one is not.
describe('webhook signature check', () => {
  const KEY = 'signing-key-used-only-by-this-suite';
  // The driver signs the raw body, so the tests must sign the same bytes.
  const FULL_BODY = JSON.stringify(WEBHOOK_FULL_PAYLOAD);
  const MINIMAL_BODY = JSON.stringify(WEBHOOK_MINIMAL_PAYLOAD);

  function sign(body: string, key = KEY): string {
    return createHmac('sha256', key).update(body).digest('hex');
  }

  function postSigned(url: string, body: string, signature: string | null): Promise<Response> {
    return fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(signature === null ? {} : { [SIGNATURE_HEADER]: signature }),
      },
      body,
    });
  }

  it('accepts a correctly signed delivery', async () => {
    const received: NormalizedEvent[] = [];
    const url = await start((event) => void received.push(event), { secret: KEY });

    const response = await postSigned(url, FULL_BODY, sign(FULL_BODY));

    expect(response.status).toBe(204);
    expect(received).toHaveLength(1);
  });

  it('refuses a delivery that carries no signature', async () => {
    const received: NormalizedEvent[] = [];
    const url = await start((event) => void received.push(event), { secret: KEY });

    const response = await postSigned(url, FULL_BODY, null);

    expect(response.status).toBe(401);
    // Nothing reached the intake seam, so nothing was enqueued or spent.
    expect(received).toHaveLength(0);
  });

  it('refuses a signature made with another key', async () => {
    const received: NormalizedEvent[] = [];
    const url = await start((event) => void received.push(event), { secret: KEY });

    const response = await postSigned(
      url,
      FULL_BODY,
      sign(FULL_BODY, 'a-different-signing-key'),
    );

    expect(response.status).toBe(401);
    expect(received).toHaveLength(0);
  });

  it('refuses a body that was altered after signing', async () => {
    const received: NormalizedEvent[] = [];
    const url = await start((event) => void received.push(event), { secret: KEY });

    const response = await postSigned(url, MINIMAL_BODY, sign(FULL_BODY));

    expect(response.status).toBe(401);
    expect(received).toHaveLength(0);
  });

  it('refuses a signature that is not hex of the expected length', async () => {
    const url = await start(() => {}, { secret: KEY });

    // timingSafeEqual throws on a length mismatch, so the length is checked
    // before the compare. A throw here would answer 500, not 401.
    for (const bogus of ['', 'zz', 'aa', 'not-hex-at-all']) {
      expect((await postSigned(url, FULL_BODY, bogus)).status).toBe(401);
    }
  });

  it('says at startup when it runs with no key configured', async () => {
    const entries: Record<string, unknown>[] = [];
    await start(() => {}, { log: (entry) => void entries.push(entry) });

    expect(entries.map((e) => e['event'])).toContain('webhook_unauthenticated');
  });
});

// The webhook's own log path, with a value from the request in it. Intake's
// fault quotes what it refused, as a Postgres constraint violation quotes the
// key it saw, so the message id the caller sent reaches the line.
describe('the webhook log', () => {
  it('escapes a value from the request, and the line parses back', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    try {
      server = createWebhookServer({
        onEvent: (event) => {
          throw new Error(`duplicate key: Key (message_id)=(${event.message.messageId ?? ''})`);
        },
      });
      await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      const body = JSON.stringify({
        ...WEBHOOK_FULL_PAYLOAD,
        message: { ...WEBHOOK_FULL_PAYLOAD.message, id: HOSTILE },
      });
      expect((await post(`http://127.0.0.1:${port}/webhooks/support`, body)).status).toBe(500);
    } finally {
      spy.mockRestore();
    }
    const carrier = expectEscaped(lines, HOSTILE);
    expect(carrier['event']).toBe('delivery_failed');
    expect(String(carrier['error'])).toContain(HOSTILE);
  });
});
