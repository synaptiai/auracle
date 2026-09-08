/**
 * An escalation reason, without whatever was interpolated into it.
 *
 * The `escalate` journal row's `reason` is not a closed vocabulary. The
 * coordinator writes one of its own `EscalationReason` values, but the relay
 * writes `delivery_unknown: <what the adapter threw>` and
 * `malformed_payload: <error text>`, and the consumer writes
 * `intake_abandoned after N attempts: <reason>`. The first of those ends in
 * `transport.sendMail`, and an SMTP rejection routinely quotes the recipient.
 *
 * So the head before the first colon is the part the system chose, and
 * everything after it is the part something else wrote.
 *
 * Here rather than in the console, and applied by the reader rather than by
 * the surface, because the reader is what every consumer goes through. The
 * console had its own copy and applied it correctly; that left the value
 * untrimmed for anything else that read a journal, which is a hazard sitting
 * one careless caller away rather than a leak.
 *
 * Idempotent: a trimmed value carries no colon, so trimming it again returns
 * it whole. That lets a caller apply it without knowing whether someone
 * already did.
 *
 * An operator who needs the whole text reads it with `pnpm run escalations`,
 * which is a command rather than an unauthenticated page.
 */
export function escalationHead(reason: string | null): string | null {
  if (reason === null) return null;
  const colon = reason.indexOf(':');
  if (colon === -1) return reason;
  // Named, so the page does not read as though the reason were simply short.
  return `${reason.slice(0, colon).trim()} (detail withheld)`;
}
