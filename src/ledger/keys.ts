import { createHash } from 'node:crypto';

/**
 * Semantic idempotency key derivation (DEC-24, section 3.4).
 *
 * The key is a pure function of action semantics:
 *   action class + ticket id + semantic payload fields.
 *
 * Run identity (run_id, timestamps, epochs) is not part of the input type,
 * so two runs of the same action derive the same key by construction.
 */

/** Fields that describe run execution, never action semantics. */
const FORBIDDEN_PAYLOAD_KEYS = new Set([
  'run_id',
  'runId',
  'step_id',
  'stepId',
  'timestamp',
  'created_at',
  'createdAt',
  'epoch',
]);

export interface IdemKeyInput {
  /** Action class, e.g. 'refund' (DEC-29 uses the same field for delivery rules). */
  actionClass: string;
  /** Ticket the action applies to. */
  ticketId: string;
  /**
   * Semantic payload fields only. Callers must not pass run-identity fields;
   * derivation throws if it detects one, per the DEC-24 assertion rule.
   */
  payload: Record<string, unknown>;
}

/**
 * Deterministic JSON: object keys sorted recursively, arrays order-preserving.
 * Two payloads that differ only in key order canonicalize identically.
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
}

function assertNoRunIdentity(payload: Record<string, unknown>, path: string): void {
  for (const [key, value] of Object.entries(payload)) {
    const childPath = path.length === 0 ? key : `${path}.${key}`;
    if (FORBIDDEN_PAYLOAD_KEYS.has(key)) {
      throw new Error(
        `idem_key payload contains run-identity field '${childPath}' (DEC-24: keys derive from action semantics only)`,
      );
    }
    if (value !== null && typeof value === 'object') {
      assertNoRunIdentity(value as Record<string, unknown>, childPath);
    }
  }
}

/**
 * Derive the semantic idempotency key.
 *
 * Format: `<actionClass>:<ticketId>:<sha256-of-canonical-payload>`
 * The plain prefix keeps rows debuggable; uniqueness comes from the hash
 * and is enforced by the outbox UNIQUE(idem_key) constraint.
 */
export function deriveIdemKey(input: IdemKeyInput): string {
  assertNoRunIdentity(input.payload, '');
  const digest = createHash('sha256')
    .update(`${input.actionClass}\n${input.ticketId}\n${canonicalize(input.payload)}`)
    .digest('hex');
  return `${input.actionClass}:${input.ticketId}:${digest}`;
}
