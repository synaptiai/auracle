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

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';

import type { IngressEvent } from '../adapters/types.js';
import { WebhookAdapter } from '../adapters/webhook.js';
import type { IntakeHandler } from './types.js';

/** Largest request body the driver reads before answering 413. */
export const MAX_BODY_BYTES = 1_048_576;

/** Header carrying the hex HMAC-SHA256 of the raw body. */
export const SIGNATURE_HEADER = 'x-auracle-signature';

/**
 * Verifies the body signature when a secret is configured.
 *
 * Unauthenticated, this endpoint lets anyone enqueue a ticket, which spends
 * the adopter's model budget, and lets anyone name a `ticket.id` that a
 * conversation already uses. `resolveConversation` checks the sender against
 * the conversation (db/012), so a forged id no longer joins a stranger's
 * thread; the spend and the unbounded queue growth remain.
 *
 * Absent secret means absent check, because a reference driver must still run
 * from a fresh checkout. `docs/operations.md` states the deployment rule: set
 * the secret, or put the driver behind something that authenticates.
 */
function signatureValid(secret: string, bodyText: string, provided: string | undefined): boolean {
  if (provided === undefined) return false;
  const expected = createHmac('sha256', secret).update(bodyText).digest();
  let supplied: Buffer;
  try {
    supplied = Buffer.from(provided, 'hex');
  } catch {
    return false;
  }
  // Length must match before timingSafeEqual, which throws on a mismatch.
  if (supplied.length !== expected.length) return false;
  return timingSafeEqual(supplied, expected);
}

export interface WebhookServerDeps {
  /** The intake seam. */
  onEvent: IntakeHandler;
  /** Injected for tests; defaults to the reference adapter. */
  adapter?: WebhookAdapter;
  /**
   * Where a failed delivery is recorded. Defaults to stderr.
   *
   * Not optional in effect: an intake throw is a lost customer message, and
   * the source is the only other party that knows it happened.
   */
  log?: (entry: Record<string, unknown>) => void;
  /**
   * Shared secret for the body signature. Absent means no check, and the
   * driver logs that it is running open.
   */
  secret?: string | undefined;
}

function defaultLog(entry: Record<string, unknown>): void {
  console.error(JSON.stringify(entry));
}

export function createWebhookServer(deps: WebhookServerDeps): Server {
  const adapter = deps.adapter ?? new WebhookAdapter();
  const log = deps.log ?? defaultLog;
  const secret = deps.secret;
  if (secret === undefined || secret.length === 0) {
    log({
      event: 'webhook_unauthenticated',
      at: new Date().toISOString(),
      detail:
        'no WEBHOOK_SECRET set: every caller that reaches this port can enqueue a ticket '
        + 'and spend the model budget. Set one, or place the driver behind an authenticating proxy.',
    });
  }
  return createServer((req, res) => {
    void handleDelivery(req, res, adapter, deps.onEvent, log, secret).catch((error: unknown) => {
      // Everything the intake seam throws lands here: a Postgres failure, a
      // constraint violation, a pool exhaustion. This used to discard the
      // error, so a source could retry, give up, and lose the ticket while
      // the daemon's own logs stayed clean.
      log({
        event: 'delivery_failed',
        at: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
      // The 4xx paths below already ended the response. Writing again throws
      // ERR_STREAM_WRITE_AFTER_END and turns a handled 500 into an unhandled
      // rejection.
      if (!res.writableEnded) {
        respondJson(res, 500, { error: 'internal error' });
      }
    });
  });
}

async function handleDelivery(
  req: IncomingMessage,
  res: ServerResponse,
  adapter: WebhookAdapter,
  onEvent: IntakeHandler,
  log: (entry: Record<string, unknown>) => void,
  secret: string | undefined,
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

  if (secret !== undefined && secret.length > 0) {
    const header = req.headers[SIGNATURE_HEADER];
    const provided = Array.isArray(header) ? header[0] : header;
    if (!signatureValid(secret, bodyText, provided)) {
      respondJson(res, 401, { error: 'bad or missing signature' });
      return;
    }
  }

  // Receipt label for logging and tracing only. It is not derived from the
  // payload and never used as a dedupe id (DEC-24).
  const event: IngressEvent = { sourceId: `wh-${randomUUID()}`, raw: bodyText };

  let normalized;
  try {
    normalized = adapter.normalize(event);
  } catch (error) {
    // Only the adapter's own validators answer 400. Any other throw class is
    // a fault on this side, and a 400 tells an at-least-once source not to
    // retry — so relabelling one as a bad payload drops the message and
    // blames the sender.
    if (error instanceof TypeError) {
      respondJson(res, 400, { error: error.message });
      return;
    }
    log({
      event: 'normalize_failed',
      at: new Date().toISOString(),
      sourceId: event.sourceId,
      error: error instanceof Error ? error.message : String(error),
    });
    respondJson(res, 500, { error: 'internal error' });
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
