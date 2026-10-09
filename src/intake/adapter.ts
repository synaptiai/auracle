// Intake wiring (approved decision D3-A): the one place where an ingress
// driver's `NormalizedEvent` becomes an `IntakeTicket` and reaches the
// intake queue. The drivers stay pure — neither the webhook server nor the
// IMAP poller learns database details; only this module composes them with
// `enqueueTicket` (section 4.1 → section 4.3).
import type { Pool } from 'pg';

import { createHash } from 'node:crypto';

import type { NormalizedEvent } from '../adapters/types.js';
import { productForChannel, type ProductCatalogue } from '../config/products.js';
import { enqueueTicket } from '../coordinator/intake.js';
import type { IntakeTicket } from '../coordinator/intake.js';
import type { IntakeHandler } from '../ingress/types.js';

/**
 * The pure adapter half: `NormalizedEvent` → `IntakeTicket`.
 *
 * The queue text is subject + bodyText, separated by a blank line so the
 * classifier sees one document, not one concatenated string. The message
 * subject is preferred (it is the current turn's subject); the ticket
 * subject backs it up when the source leaves the message subject empty.
 *
 * The catalogue is a parameter rather than a module import, because the map
 * is deployment configuration: which channel serves which product is the
 * deployment's answer, and a test that wanted another answer would have to
 * edit a file the processes read.
 */
/**
 * A stable stand-in identity for a message the source did not name.
 *
 * Content, never delivery: the same message redelivered under a new UID must
 * hash the same, or it takes a second turn and DEC-38 derives a second key
 * for one request.
 */
function contentMessageId(message: NormalizedEvent['message']): string {
  const digest = createHash('sha256')
    .update(
      [
        message.fromAddress ?? '',
        message.sentAt ?? '',
        message.subject ?? '',
        message.bodyText,
      ].join('\u0000'),
    )
    .digest('hex');
  return `no-id-${digest.slice(0, 32)}`;
}

export function toIntakeTicket(
  event: NormalizedEvent,
  catalogue: ProductCatalogue,
): IntakeTicket {
  const subject = event.message.subject ?? event.ticket.subject;
  return {
    ticketId: event.ticket.ticketId,
    // DEC-47: the product of the channel this message arrived on, resolved
    // here so the queue row carries it and the run that answers inherits it.
    // The channel is the source's own queue field, which the helpdesk
    // reports and this seam must carry. Null when it names none, or names one
    // the catalogue does not serve.
    product: productForChannel(catalogue, event.ticket.queue),
    // The source's own message identity, so a repeat deduplicates and a new
    // message enqueues (DEC-24).
    //
    // A fallback to the adapter's delivery id, which for mail is the IMAP
    // UID, runs the action twice. The idempotency key does not stop that.
    // Under DEC-38 the key folds in the turn, and a re-enqueued message takes
    // a fresh turn number. A different key means the outbox insert succeeds
    // instead of landing superseded. A UIDVALIDITY change or a mailbox move
    // is enough to fire it.
    //
    // So the fallback is derived from the message itself, which survives a
    // redelivery under a new delivery id.
    messageId: event.message.messageId ?? contentMessageId(event.message),
    linkage: event.linkage,
    // DEC-35: conversation membership is checked against the sender, so this
    // must survive the seam. The message names it when the source does; the
    // ticket's own customer address stands in otherwise.
    customerAddress: event.message.fromAddress ?? event.ticket.customerAddress,
    ticketText:
      subject.length > 0 ? `${subject}\n\n${event.message.bodyText}` : event.message.bodyText,
  };
}

/**
 * The persistence half: builds the `IntakeHandler` a driver receives.
 * Each event is enqueued under its DEC-36 partition, which follows the
 * conversation, so a consumer picks it up by polling that partition alone.
 */
export function intakeEnqueuer(
  pool: Pool,
  partitionCount: number,
  catalogue: ProductCatalogue,
): IntakeHandler {
  return async (event) => {
    await enqueueTicket(pool, toIntakeTicket(event, catalogue), partitionCount);
  };
}
