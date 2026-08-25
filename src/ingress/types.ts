/**
 * Intake seam for the ingress drivers (docs/v1-architecture.md, section 4.1).
 *
 * A driver turns one external event into a `NormalizedEvent` and hands it
 * to exactly one consumer function. The consumer owns everything after that
 * point: persistence, the coordinator call, partition ownership. The
 * drivers here are reference wiring, not production servers.
 */

import type { NormalizedEvent } from '../adapters/types.js';

/**
 * The intake seam. Receives the full `NormalizedEvent`, including
 * `eventId` when the source guarantees one (DEC-24). The driver never
 * adds, drops or transforms fields between normalize and this call.
 */
export type IntakeHandler = (event: NormalizedEvent) => void | Promise<void>;
