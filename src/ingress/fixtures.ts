/**
 * Synthetic webhook payload fixtures for the ingress driver tests.
 *
 * Every address, id and domain here is synthetic (DEC-18). Domains use
 * the reserved .test and .example TLDs.
 */

/** Full delivery: every optional field present plus a source eventId. */
export const WEBHOOK_FULL_PAYLOAD = {
  eventId: 'evt-webhook-1001',
  ticket: {
    id: 'wh-ticket-4471',
    subject: 'Order 4471 arrived damaged',
    queue: 'shipping',
    status: 'open',
  },
  message: {
    id: 'wh-msg-90001',
    author: 'customer',
    from: 'dana.doe@example.test',
    body: 'The box arrived with a crushed corner. Two tiles are broken.',
    createdAt: '2025-01-06T10:04:00Z',
  },
} satisfies Record<string, unknown>;

/** Minimal delivery: only the required fields, no source eventId. */
export const WEBHOOK_MINIMAL_PAYLOAD = {
  ticket: { id: 'wh-ticket-8812', status: 'pending' },
  message: {
    id: 'wh-msg-90002',
    author: 'system',
    body: 'Ticket moved to pending by billing sync.',
    createdAt: '2025-01-07T09:30:00Z',
  },
} satisfies Record<string, unknown>;

/** Redelivery of WEBHOOK_FULL_PAYLOAD with the same source eventId. */
export const WEBHOOK_FULL_PAYLOAD_REDELIVERY = structuredClone(
  WEBHOOK_FULL_PAYLOAD,
);
