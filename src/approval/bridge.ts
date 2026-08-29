/**
 * Approval bridge (section 4.9). Obeys DEC-11, DEC-14, DEC-33.
 *
 * The bridge parks each gated action as a draft inside the target system
 * through the adapter the action came from (DEC-11). Adopters keep their
 * own helpdesk UI; this project adds no queue interface.
 *
 * Before a reply enters a draft state, the bridge enforces two independent
 * obligations on each customer reply:
 *
 * 1. A `disclosure` field that is not empty (DEC-14).
 * 2. Machine-readable provenance metadata (DEC-33).
 * 3. A park idempotency key that is not empty (DEC-24), so a retry after a
 *    crash returns the first draft instead of parking a second one.
 *
 * The bridge refuses a reply that lacks either item. Refusal happens before
 * any adapter call, so a refused reply never reaches the target system.
 */
import type { DraftReply, EgressAdapter } from '../adapters/types.js';

/** Thrown when a gated reply fails a section 4.9 obligation. */
export class ApprovalRefusalError extends Error {
  /** Each failed obligation, one entry per violation. */
  readonly reasons: readonly string[];

  constructor(reasons: readonly string[]) {
    super(`approval bridge refused the reply: ${reasons.join('; ')}`);
    this.name = 'ApprovalRefusalError';
    this.reasons = reasons;
  }
}

/**
 * Validate one gated customer reply against section 4.9. Returns every
 * violated obligation; an empty array means the reply may enter a draft
 * state. Pure function; it reads nothing and calls nothing.
 */
export function validateGatedReply(reply: DraftReply): readonly string[] {
  const reasons: string[] = [];

  if (typeof reply.disclosure !== 'string' || reply.disclosure.trim().length === 0) {
    reasons.push('disclosure must not be empty (DEC-14)');
  }

  if (typeof reply.idemKey !== 'string' || reply.idemKey.trim().length === 0) {
    reasons.push('idemKey must not be empty (DEC-24)');
  }

  reasons.push(...validateProvenance(reply.provenance));

  return reasons;
}

function validateProvenance(provenance: unknown): readonly string[] {
  if (typeof provenance !== 'object' || provenance === null) {
    return ['provenance metadata must be present and machine-readable (DEC-33)'];
  }

  const p = provenance as Record<string, unknown>;
  const reasons: string[] = [];
  for (const field of ['generatedBy', 'modelId', 'promptVer'] as const) {
    if (typeof p[field] !== 'string' || (p[field] as string).trim().length === 0) {
      reasons.push(`provenance.${field} must be a non-empty string (DEC-33)`);
    }
  }

  const generatedAt = p['generatedAt'];
  if (
    typeof generatedAt !== 'string'
    || generatedAt.trim().length === 0
    || Number.isNaN(Date.parse(generatedAt))
  ) {
    reasons.push('provenance.generatedAt must be an ISO 8601 timestamp (DEC-33)');
  }

  return reasons;
}

/**
 * Park one gated customer reply in the adapter's draft state (DEC-11).
 *
 * Runs the section 4.9 validation first. A refusal throws
 * `ApprovalRefusalError` and never calls the adapter, so nothing enters
 * the target system without disclosure and provenance.
 */
export async function parkGatedReply(
  adapter: EgressAdapter,
  reply: DraftReply,
): Promise<{ readonly draftExternalId: string }> {
  const reasons = validateGatedReply(reply);
  if (reasons.length > 0) {
    throw new ApprovalRefusalError(reasons);
  }

  return adapter.createDraft(reply);
}
