/**
 * Webhook ingress driver (docs/v1-architecture.md, sections 4.1 and 1.1
 * "Intake"). Reference driver: stdlib `node:http` only, no framework,
 * no production hardening.
 *
 * One POST is one webhook delivery. The server reads the JSON body, runs
 * it through `WebhookAdapter.normalize` and hands the resulting
 * Ticket+Message to the intake seam. Normalization failures answer 400 so
 * the source can tell a bad payload from a temporary fault. An intake
 * handler that rejects answers 500, so an at-least-once source redelivers.
 *
 * DEC-24 / NormalizedEvent.eventId rules: the only dedupe id in the
 * normalized event is the `eventId` field of the source payload, passed
 * through unchanged. A delivery without one stays without one; the driver
 * invents nothing. The per-request identifier generated here feeds only
 * `IngressEvent.sourceId` (an opaque receipt label), never a dedupe id.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';

import type { IngressEvent } from '../adapters/types.js';
import { WebhookAdapter } from '../adapters/webhook.js';
import type { IntakeHandler } from './types.js';

/** Largest request body the driver reads before answering 413. */
export const MAX_BODY_BYTES = 1_048_576;

export interface WebhookServerDeps {
  /** The intake seam. */
  onEvent: IntakeHandler;
  /** Injected for tests; defaults to the reference adapter. */
  adapter?: WebhookAdapter;
}

export function createWebhookServer(deps: WebhookServerDeps): Server {
  const adapter = deps.adapter ?? new WebhookAdapter();
  return createServer((req, res) => {
    void handleDelivery(req, res, adapter, deps.onEvent).catch(() => {
      respondJson(res, 500, { error: 'internal error' });
    });
  });
}

async function handleDelivery(
  req: IncomingMessage,
  res: ServerResponse,
  adapter: WebhookAdapter,
  onEvent: IntakeHandler,
): Promise<void> {
  if (req.method !== 'POST') {
    respondJson(res, 405, { error: 'webhook deliveries are POST only' });
    return;
  }

  let bodyText: string;
  try {
    bodyText = await readBody(req);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      respondJson(res, 413, { error: 'body exceeds MAX_BODY_BYTES' });
    } else {
      respondJson(res, 400, { error: 'could not read body' });
    }
    return;
  }

  // Receipt label for logging and tracing only. It is not derived from the
  // payload and never used as a dedupe id (DEC-24).
  const event: IngressEvent = { sourceId: `wh-${randomUUID()}`, raw: bodyText };

  let normalized;
  try {
    normalized = adapter.normalize(event);
  } catch (error) {
    const message = error instanceof TypeError ? error.message : 'malformed payload';
    respondJson(res, 400, { error: message });
    return;
  }

  await onEvent(normalized);
  res.statusCode = 204;
  res.end();
}

class BodyTooLargeError extends Error {}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Discard the rest but keep draining, so the source can still read
        // the 413 response on a clean connection.
        tooLarge = true;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () =>
      tooLarge ? reject(new BodyTooLargeError()) : resolve(Buffer.concat(chunks).toString('utf8')),
    );
    req.on('error', reject);
  });
}

function respondJson(res: ServerResponse, status: number, body: object): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}
