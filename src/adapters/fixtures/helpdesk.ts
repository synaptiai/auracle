/**
 * Synthetic tickets the fixture helpdesk already contains when it starts.
 * Every address and identifier is synthetic (DEC-18): domains use the
 * reserved .test and .example TLDs.
 */
import type { Ticket } from '../types.js';

export const HELPDESK_FIXTURE_TICKETS: readonly Ticket[] = [
  {
    ticketId: 'HD-1001',
    subject: 'Cannot sign in',
    queue: 'accounts',
    status: 'open',
    customerAddress: 'sam.carter@example.test',
  },
  {
    ticketId: 'HD-1002',
    subject: 'Refund request for an order',
    queue: 'billing',
    status: 'pending',
    customerAddress: 'leslie.nunez@example.test',
  },
  {
    ticketId: 'HD-1003',
    subject: 'Export stops at half',
    queue: 'technical',
    status: 'open',
    customerAddress: 'priya.rao@example.test',
  },
];
