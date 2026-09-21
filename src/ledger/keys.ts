import { createHash } from 'node:crypto';

/**
 * Semantic idempotency key derivation (DEC-24, DEC-38, section 3.4).
 *
 * The key is a pure function of action semantics:
 *   action class + ticket id + turn + semantic payload fields.
 *
 * Run identity (run_id, timestamps, epochs) is not part of the input type,
 * so two runs of the same action derive the same key by construction.
 *
 * DEC-38 adds the turn, because a customer who asks for a refund in turn one
 * and asks again in turn four has made two requests, not one. Without it the
 * second request collides with the first and is dropped as a replay. A retry
 * of one turn still derives one key, so DEC-24 holds.
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
   * DEC-38: the turn that requested the action. Absent for a caller with no
   * conversation, such as a V1-era run or a replay, whose keys then keep
   * their V1 form.
   */
  turnNumber?: number;
  /**
   * DEC-35: the conversation the turn belongs to.
   *
   * A turn is not identified by its number alone. Since db/012 refuses a join
   * by a different sender, one ticket can carry two conversations, and the
   * first turn of each is turn 1 — so `ticketId + turn` stopped being unique
   * and two senders derived one key. The second sender's action was then
   * dropped as a replay and the run landed superseded, with no reply sent and
   * nothing naming why.
   *
   * Stable across every retry of one turn, so it is conversation identity and
   * never run identity: DEC-24's rule still holds.
   */
  conversationId?: string | null;
  /**
   * DEC-49: which attempt of that turn this request is. The first run of a
   * turn is attempt 1, and a reviewer's send-back starts the next one.
   *
   * The attempt is action semantics: it describes what a person asked for,
   * and it never derives from the run's identity, so DEC-24 holds. It is not
   * a digest of the composed body either — a crash retry composes again, and
   * a document can pass its review date between the two retrievals, so the
   * retry would derive a second key and park a second draft (DEC-49).
   *
   * Absent and 1 derive one key, which is the key the turn derived before
   * this field existed. A park journaled before db/031 still matches the
   * approval that follows it.
   */
  attempt?: number;
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
 *
 * A caller with no turn derives the V1 key unchanged, so an existing outbox
 * row still matches the key a replay of that action produces.
 *
 * A caller that names a turn also names its conversation, because a turn
 * number is only unique inside one. Without it two conversations on one
 * ticket both derive the turn-1 key and the second is dropped as a replay.
 */
export function deriveIdemKey(input: IdemKeyInput): string {
  assertNoRunIdentity(input.payload, '');
  // DEC-49: the attempt rides inside the turn segment, and the first attempt
  // rides without a segment of its own. So attempt 1 of a turn derives the
  // key that turn derived before this field existed, and only a request a
  // person made separates the keys of one turn.
  const attempt =
    input.attempt === undefined || input.attempt === 1 ? '' : `\nattempt:${input.attempt}`;
  const turn =
    input.turnNumber === undefined
      ? ''
      : `\nconversation:${input.conversationId ?? ''}\nturn:${input.turnNumber}${attempt}`;
  const digest = createHash('sha256')
    .update(
      `${input.actionClass}\n${input.ticketId}${turn}\n${canonicalize(input.payload)}`,
    )
    .digest('hex');
  return `${input.actionClass}:${input.ticketId}:${digest}`;
}
