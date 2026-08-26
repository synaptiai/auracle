// Intake wiring (approved decision D3-A): the one place where an ingress
// driver's `NormalizedEvent` becomes an `IntakeTicket` and reaches the
// intake queue. The drivers stay pure — neither the webhook server nor the
// IMAP poller learns database details; only this module composes them with
// `enqueueTicket` (section 4.1 → section 4.3).
import type { Pool } from 'pg';

import type { NormalizedEvent } from '../adapters/types.js';
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
 */
export function toIntakeTicket(event: NormalizedEvent): IntakeTicket {
  const subject = event.message.subject ?? event.ticket.subject;
  return {
    ticketId: event.ticket.ticketId,
    ticketText:
      subject.length > 0 ? `${subject}\n\n${event.message.bodyText}` : event.message.bodyText,
  };
}

/**
 * The persistence half: builds the `IntakeHandler` a driver receives.
 * Each event is enqueued under its DEC-27 partition so a consumer can pick
 * it up by polling that partition alone.
 */
export function intakeEnqueuer(pool: Pool, partitionCount: number): IntakeHandler {
  return async (event) => {
    await enqueueTicket(pool, toIntakeTicket(event), partitionCount);
  };
}
