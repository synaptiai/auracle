/**
 * FreeScout egress adapter (sections 4.1, 4.4, 4.9). Obeys DEC-01, DEC-06,
 * DEC-11, DEC-14, DEC-18, DEC-24, DEC-30.
 *
 * FreeScout is a self-hosted helpdesk. It is the first egress target that both
 * reaches a real customer and holds a real agent draft, so it is the first
 * adapter whose capability declaration is checked against a running system
 * rather than against a fixture.
 *
 * The client opens one HTTPS request per operation and keeps nothing between
 * them. It holds no session and no pool, which is the same rule the mail
 * adapter follows.
 *
 * ## What the API gives, and what it does not
 *
 * `POST /api/conversations/{id}/threads` takes `state: "draft"` and returns
 * `201` with the new thread id in a `Resource-ID` header. That is the park
 * (DEC-11). `GET /api/conversations/{id}?embed=threads` returns each thread
 * with its `id`, `state` and `body`, which is the read of that same draft.
 *
 * The API has no endpoint that updates a thread. There is no way to publish
 * a parked draft in place. So the send posts a second thread carrying the
 * draft's current body with `state: "published"`, and the parked draft stays
 * where it is. A person removes it in the FreeScout UI. This is stated here
 * because a reader of `sendDraft` would otherwise expect the draft to change
 * state, and it does not.
 *
 * ## The capability declaration, and why each flag reads as it does
 *
 * - `supportsIdempotencyKey: false`. The API accepts no idempotency key on
 *   thread create, and its documentation claims uniqueness for nothing but a
 *   customer address and a user address. Two identical thread posts make two
 *   threads. DEC-06's rejected alternative names "a shim that removes
 *   duplicates", so this adapter does not build one, and the policy engine
 *   sends every write of this adapter to the approval path.
 * - `supportsReadBack: false`. `readBack` is keyed on the outbox idempotency
 *   key, and FreeScout stores no such field on a thread. Nothing in the API
 *   can answer "did the delivery for this key land". A guess would turn an
 *   unknown delivery into a claim, and DEC-30 forbids exactly that, so
 *   `readBack` throws instead. `readDraft` is a different port: it is keyed
 *   on the draft id the park returned, it reads draft state and never
 *   delivery state, so it works while `readBack` throws. The mail adapter
 *   splits the two the same way.
 * - `supportsDraftState: true`. `state: "draft"` is a first-class thread
 *   state, and the draft appears in the agent inbox (DEC-11).
 * - `supportsStructuredFields: false`. The thread create body has no field
 *   for provenance. Custom fields exist on a conversation, not on a thread,
 *   and a person defines them in each instance, so no adapter may assume
 *   one. Provenance therefore travels in the body text beside the
 *   disclosure, which is what DEC-33 asks of a channel with no structured
 *   field.
 * - `supportsThreading: true`. Every thread belongs to a conversation, and
 *   the conversation id is the stable ticket identity.
 *
 * That last flag carries an obligation. The conversation id is the ticket id,
 * and FreeScout addresses a thread to that conversation's customer, so the
 * ticket id is the addressing here. `createDraft` therefore checks the
 * conversation's customer against the participant the ledger recorded before
 * it parks anything (DEC-35). The mail adapter refuses the same delivery.
 *
 * Two false flags mean this adapter meets neither half of the automatic-send
 * floor. That is the honest reading of the API, not a limit of this code.
 *
 * ## What no test here establishes
 *
 * Every suite drives this client against the wire contract the API
 * documentation states, and a stock FreeScout install answers 404 to every
 * `/api/` route until a person installs the API module. So two things are
 * read off documentation and have never been observed:
 *
 * - That a published thread is delivered to the customer, rather than merely
 *   recorded. The relay resolves on the 201 and writes `status = 'sent'`, so
 *   a target that records without sending is a silent loss, and this adapter
 *   can never reconcile one.
 * - That the `text` a create posts comes back byte for byte as the `body` a
 *   read returns. `replyPartOf` splits on a literal separator line, so a
 *   target that rewrites the body loses the split and every approval-edit
 *   distance then includes the trailer.
 *
 * Check both against a real instance before trusting either.
 */
import { AdapterCapabilityError, PermanentEgressError, requireNonEmpty } from './types.js';
import type {
  AdapterCapabilities,
  DeliveryState,
  DraftReadBack,
  DraftReply,
  EgressAdapter,
  ReplyProvenance,
} from './types.js';

export const FREESCOUT_CAPABILITIES: Readonly<AdapterCapabilities> = Object.freeze({
  supportsIdempotencyKey: false,
  supportsReadBack: false,
  supportsDraftState: true,
  supportsStructuredFields: false,
  supportsThreading: true,
});

/** Everything one FreeScout instance needs. No value here is a default. */
export interface FreeScoutConfig {
  /** Instance root, for example `http://localhost:8088`. No trailing slash. */
  readonly baseUrl: string;
  /** Value of the `X-FreeScout-API-Key` header. */
  readonly apiKey: string;
  /**
   * FreeScout user id the thread is attributed to. The API requires it on a
   * thread of type `message`, and a wrong id is refused rather than guessed.
   */
  readonly userId: number;
  /** Request deadline in milliseconds. */
  readonly timeoutMs?: number;
}

/**
 * Reads one FreeScout configuration from the environment, or throws.
 *
 * Every value is required. A default base URL would let a misconfigured
 * process post a customer reply into whatever answers on that address.
 */
export function freeScoutConfigFromEnv(env: NodeJS.ProcessEnv = process.env): FreeScoutConfig {
  const baseUrl = requireBaseUrl(requireEnv(env, 'FREESCOUT_BASE_URL'));
  const apiKey = requireEnv(env, 'FREESCOUT_API_KEY');
  const rawUser = requireEnv(env, 'FREESCOUT_USER_ID');
  const userId = Number(rawUser);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error(`FREESCOUT_USER_ID must be a positive integer, got '${rawUser}'`);
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, userId };
}

/**
 * Refuses a base URL this adapter cannot use safely, or returns it.
 *
 * Neither refusal quotes the value. `fetch` refuses a URL that carries a user
 * name or password, and its error text quotes the whole URL, so the
 * credential would reach every log line a failed request writes.
 */
function requireBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('FREESCOUT_BASE_URL is not an http or https URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('FREESCOUT_BASE_URL is not an http or https URL');
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error(
      'FREESCOUT_BASE_URL carries a user name or password; the API key goes in FREESCOUT_API_KEY',
    );
  }
  return raw;
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is required for the FreeScout adapter`);
  }
  return value.trim();
}

/**
 * Identity of one parked draft, as this adapter names it.
 *
 * `readDraft` and `sendDraft` receive only the draft id, and both need the
 * conversation the thread belongs to. FreeScout has no endpoint that reads a
 * thread by its id alone, so the conversation id travels inside the id the
 * park returns.
 */
const DRAFT_ID_SEPARATOR = ':';

/**
 * Refuses a ticket id that cannot survive the round trip, or returns it.
 *
 * The park is checked before it happens, not when a later call fails to read
 * the id back. A colon-bearing ticket id used to park successfully and then
 * make every `readDraft` and `sendDraft` throw, which left a draft in front of
 * a person that nothing could send.
 */
export function assertTicketIdIsAddressable(ticketExternalId: string): string {
  if (ticketExternalId.includes(DRAFT_ID_SEPARATOR)) {
    throw new PermanentEgressError(
      `ticket id '${ticketExternalId}' contains '${DRAFT_ID_SEPARATOR}', which this adapter uses to `
        + 'join the conversation id to the thread id; the parked draft could never be read back',
    );
  }
  return ticketExternalId;
}

export function formatDraftId(conversationId: string, threadId: string): string {
  return `${conversationId}${DRAFT_ID_SEPARATOR}${threadId}`;
}

export function parseDraftId(draftExternalId: string): {
  readonly conversationId: string;
  readonly threadId: string;
} {
  const parts = draftExternalId.split(DRAFT_ID_SEPARATOR);
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    throw new Error(
      `draft id '${draftExternalId}' is not a FreeScout draft id of the form <conversation>:<thread>`,
    );
  }
  return { conversationId: parts[0] as string, threadId: parts[1] as string };
}

/** One thread as `embed=threads` returns it. */
interface FreeScoutThread {
  readonly id: number | string;
  readonly state?: string;
  readonly type?: string;
  readonly body?: string;
}

interface FreeScoutConversation {
  /** The customer FreeScout addresses a reply on this conversation to. */
  readonly customer?: { readonly email?: string };
  readonly _embedded?: { readonly threads?: readonly FreeScoutThread[] };
}

/**
 * The body a parked draft carries.
 *
 * The adapter declares no structured fields, so the disclosure (DEC-14) and
 * the provenance (DEC-33) travel as text under the reply. A person editing
 * the draft in FreeScout sees both, which is the point: the audit trail has
 * to reach the person who approves, not only the ledger.
 */
export const DRAFT_TRAILER_MARKER = '\n\n-- \n';

export function composeDraftBody(
  body: string,
  disclosure: string,
  provenance: ReplyProvenance,
): string {
  const trail = [
    `generated-by: ${provenance.generatedBy}`,
    `model: ${provenance.modelId}`,
    `prompt-version: ${provenance.promptVer}`,
    `generated-at: ${provenance.generatedAt}`,
  ].join('\n');
  return `${body}${DRAFT_TRAILER_MARKER}${disclosure}\n\n${trail}\n`;
}

/**
 * The reply part of a draft body, without the trailer this adapter appended.
 *
 * The approval-edit distance compares the body the ledger journalled against
 * the body read back (section 4.10). The journal holds the reply alone, so a
 * read-back that returned the trailer too would measure this adapter's own
 * decoration as a person's edit, and the C2 control band would move with the
 * disclosure text rather than with what people change.
 *
 * The split is on the first `-- ` separator line, and that is a guess with two
 * known failure modes. A person who ends their own edit with a signature
 * separator loses everything after it from the read-back, so the distance
 * understates their edit. A person who deletes the trailer has their whole
 * body counted, which overstates it.
 *
 * Neither can be repaired from the body alone: nothing in a FreeScout thread
 * records where the trailer began. Both understate or overstate one run's
 * distance rather than corrupt the ledger, and C2 reads a distribution over
 * many. A structured field would fix it, and this adapter has none.
 */
export function replyPartOf(draftBody: string): string {
  const at = draftBody.indexOf(DRAFT_TRAILER_MARKER);
  return at === -1 ? draftBody : draftBody.slice(0, at);
}

export class FreeScoutEgressAdapter implements EgressAdapter, DraftReadBack {
  readonly name = 'freescout';

  readonly capabilities: AdapterCapabilities = FREESCOUT_CAPABILITIES;

  constructor(private readonly config: FreeScoutConfig) {}

  /**
   * Park one gated reply as a FreeScout draft (DEC-11).
   *
   * The port says a repeat call with the same `idemKey` must return the
   * first draft. This adapter cannot honour that, because FreeScout stores
   * no key on a thread and offers no search over one. It declares
   * `supportsIdempotencyKey: false` for that reason, and the ledger is what
   * stops a second park: a retry that finds an unresolved prior park
   * escalates it to a person rather than call this again. Inventing a
   * client-side dedupe table here is the shim DEC-06 rejects.
   */
  async createDraft(reply: DraftReply): Promise<{ readonly draftExternalId: string }> {
    requireNonEmpty('reply.ticketExternalId', reply.ticketExternalId);
    requireNonEmpty('reply.body', reply.body);
    // The adapter refuses to hold a reply with no disclosure (DEC-12, DEC-14).
    requireNonEmpty('reply.disclosure', reply.disclosure);
    requireNonEmpty('reply.idemKey', reply.idemKey);
    assertTicketIdIsAddressable(reply.ticketExternalId);

    await this.assertRecipientAgrees(reply);

    const threadId = await this.postThread(
      reply.ticketExternalId,
      composeDraftBody(reply.body, reply.disclosure, reply.provenance),
      'draft',
    );
    return { draftExternalId: formatDraftId(reply.ticketExternalId, threadId) };
  }

  /**
   * Read one parked draft's current body (section 4.10).
   *
   * Null means FreeScout holds no such draft. The approval path treats that
   * as a refusal, never as an empty body: measuring an edit distance against
   * a draft that is gone would invent the number.
   *
   * A thread that exists but has left the draft state also reads as null.
   * Its body is then a sent message, and calling that a draft would let an
   * approval measure the distance to text the customer already has.
   */
  async readDraft(
    draftExternalId: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<{ readonly body: string } | null> {
    requireNonEmpty('draftExternalId', draftExternalId);
    const raw = await this.readRawDraftBody(draftExternalId, options?.signal);
    return raw === null ? null : { body: replyPartOf(raw) };
  }

  /**
   * Send one approved draft.
   *
   * FreeScout has no endpoint that publishes a thread in place, so the send
   * posts a published thread carrying the draft's current body. The body is
   * read here, at send time, not at approval time. So an edit made in the
   * FreeScout UI between the two reaches the customer, and the journalled
   * approval-edit distance then describes different text. The mail adapter
   * reads its draft at send time too; the window is the relay scan interval.
   *
   * The parked draft is not retired either, because the API cannot delete or
   * update a thread. It stays readable and re-sendable. Remove it in the UI
   * after the send.
   *
   * `idemKey` is accepted and not sent. The API takes no such field, and this
   * adapter says so in its capability declaration.
   *
   * So nothing at the target deduplicates, and the relay's post-send
   * `status = 'pending'` update is the only guard. It covers a second scan
   * after a completed send and nothing else. A crash between the post and
   * that update leaves the record pending, and the next scan posts a second
   * thread; two relay processes both read the row as pending and both post.
   * The mail adapter carries the same exposure for the same reason. It is the
   * cost of `supportsIdempotencyKey: false`, and it is why every write of this
   * adapter waits for a person.
   *
   * A draft that is gone is a permanent failure, not a transient one: a
   * retry finds the same absence and spends another pipeline run.
   */
  async sendDraft(
    draftExternalId: string,
    idemKey: string,
  ): Promise<{ readonly externalId: string }> {
    requireNonEmpty('draftExternalId', draftExternalId);
    requireNonEmpty('idemKey', idemKey);
    const { conversationId } = parseDraftId(draftExternalId);

    // The whole body, trailer included: the disclosure has to reach the
    // customer (DEC-14). `readDraft` strips it, because the approval measures
    // an edit distance and must not count this adapter's own text.
    const draft = await this.readRawDraftBody(draftExternalId);
    if (draft === null) {
      throw new PermanentEgressError(
        `freescout holds no draft '${draftExternalId}'; a retry would find the same absence`,
      );
    }

    const threadId = await this.postThread(conversationId, draft, 'published');
    return { externalId: formatDraftId(conversationId, threadId) };
  }

  /**
   * Automatic internal writes are not available through this adapter.
   *
   * The policy engine already routes every write of an adapter with no
   * idempotency key to the approval path, so this throw is the second line
   * of defence and never the first (DEC-06).
   */
  async performAction(
    _actionClass: string,
    _payload: Record<string, unknown>,
    _idemKey: string,
  ): Promise<{ readonly externalId: string }> {
    throw new AdapterCapabilityError(
      'freescout cannot apply automatic internal writes: supportsIdempotencyKey is false',
    );
  }

  /**
   * Delivery state cannot be read back through this adapter.
   *
   * The reference is the outbox idempotency key, and FreeScout records no
   * such key. Answering from a thread listing would be a guess, and DEC-30
   * requires an unknown delivery to escalate rather than resolve.
   */
  async readBack(_ref: { readonly idemKey: string }): Promise<DeliveryState> {
    throw new AdapterCapabilityError(
      'freescout cannot read delivery state back: supportsReadBack is false (DEC-30)',
    );
  }

  /**
   * Refuses a park whose conversation belongs to somebody else (DEC-35).
   *
   * The ticket id is the conversation id, and FreeScout addresses a thread to
   * that conversation's customer. So the ticket id is the addressing here,
   * even though this adapter resolves no address of its own. A message naming
   * another thread's id gets a new conversation (db/012) and keeps the forged
   * id as its ticket, which would otherwise send the reply to the person who
   * opened the original. The mail adapter refuses the same delivery, and it
   * has to be refused at the same point.
   *
   * An absent `expectedRecipient` means the ledger recorded no participant.
   * That is nothing to check against, not permission to address the reply
   * anywhere, so the park proceeds and the conversation decides. A
   * conversation with no customer address reads the same way.
   *
   * This covers the park and cannot cover the send. `sendDraft` receives a
   * draft id and an idempotency key, so the port hands it no participant to
   * compare against, and FreeScout resolves the recipient itself on the later
   * request. A conversation whose customer changes between the park and the
   * relay scan therefore delivers to the new one. The mail adapter does not
   * have that window, because its check and its addressing are one act: it
   * writes the checked address into the draft, and the send uses that. Closing
   * this needs a participant on the send, which is a port change.
   */
  private async assertRecipientAgrees(reply: DraftReply): Promise<void> {
    // Normalised on both sides. Trimming only the side that decides whether
    // to compare made a padded address refuse every park permanently, and
    // the webhook ingress passes an address through as the payload wrote it.
    const expected = normalizeAddress(reply.expectedRecipient);
    if (expected === null) return;

    const conversation = await this.getConversation(reply.ticketExternalId);
    if (conversation === null) {
      throw new PermanentEgressError(
        `freescout has no conversation '${reply.ticketExternalId}'; a retry would find the same absence`,
      );
    }
    const actual = normalizeAddress(conversation.customer?.email);
    if (actual === null) return;
    if (actual !== expected) {
      throw new PermanentEgressError(
        `refusing to park a reply: the conversation records ${expected} but freescout `
          + `conversation ${reply.ticketExternalId} belongs to ${actual}`,
      );
    }
  }

  /** The parked draft's body exactly as FreeScout holds it, or null. */
  private async readRawDraftBody(draftExternalId: string, signal?: AbortSignal): Promise<string | null> {
    const { conversationId, threadId } = parseDraftId(draftExternalId);
    const conversation = await this.getConversation(conversationId, signal);
    if (conversation === null) return null;
    const thread = (conversation._embedded?.threads ?? []).find(
      (candidate) => String(candidate.id) === threadId,
    );
    if (thread === undefined || thread.state !== 'draft') return null;
    return thread.body ?? '';
  }

  /** Creates one thread and returns the id FreeScout minted for it. */
  private async postThread(
    conversationId: string,
    text: string,
    state: 'draft' | 'published',
  ): Promise<string> {
    const response = await this.request(
      'POST',
      `/api/conversations/${encodeURIComponent(conversationId)}/threads`,
      { type: 'message', text, user: this.config.userId, imported: false, state },
    );

    if (response.status === 404) {
      await discardBody(response);
      throw new PermanentEgressError(
        `freescout has no conversation '${conversationId}'; a retry would find the same absence`,
      );
    }
    if (response.status !== 201) {
      throw await egressError(response, `create a ${state} thread on '${conversationId}'`);
    }

    // The id arrives in a header, not in the body. A create that answered 201
    // and named nothing would leave a thread in front of a person that no
    // later call can read or send, so this is a failure and not a default.
    const threadId = response.headers.get('resource-id');
    await discardBody(response);
    if (threadId === null || threadId.trim().length === 0) {
      throw new Error(
        `freescout created a ${state} thread on '${conversationId}' and returned no Resource-ID header`,
      );
    }
    return threadId.trim();
  }

  /** Reads one conversation with its threads, or null when it is gone. */
  private async getConversation(
    conversationId: string,
    signal?: AbortSignal,
  ): Promise<FreeScoutConversation | null> {
    const response = await this.request(
      'GET',
      `/api/conversations/${encodeURIComponent(conversationId)}?embed=threads`,
      undefined,
      signal,
    );
    if (response.status === 404) {
      await discardBody(response);
      return null;
    }
    if (!response.ok) {
      // The status alone. A helpdesk error page can quote request details or
      // a customer, and this message reaches the console's read-back log.
      throw await egressError(response, `read conversation '${conversationId}'`, { withBody: false });
    }
    // Parsed here rather than by `response.json()`, whose error quotes the
    // start of a body that is not JSON: a proxy page can name a customer.
    const text = await response.text();
    try {
      return JSON.parse(text) as FreeScoutConversation;
    } catch {
      throw new Error(
        `freescout answered HTTP ${response.status} to read conversation '${conversationId}' with a body that is not JSON`,
      );
    }
  }

  /**
   * One request, one connection. Nothing is kept between calls.
   *
   * A redirect is refused. The API key is a header of its own, and fetch keeps
   * such a header when it follows a redirect to another origin, so following
   * one would hand the key to whatever host the redirect named.
   */
  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    caller?: AbortSignal,
  ): Promise<Response> {
    const bound = AbortSignal.timeout(this.config.timeoutMs ?? 15_000);
    const signal = caller === undefined ? bound : AbortSignal.any([bound, caller]);
    const response = await fetch(`${this.config.baseUrl}${path}`, {
      method,
      signal,
      // Manual, so the redirect arrives as a response this adapter can name.
      // An error redirect surfaced only as "fetch failed", with the reason
      // hidden in a cause no log line reads.
      redirect: 'manual',
      headers: {
        'X-FreeScout-API-Key': this.config.apiKey,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status >= 300 && response.status < 400) {
      await discardBody(response);
      // Permanent: a base URL that redirects answers the same on a retry. The
      // target is not quoted, because it is the host the key would have met.
      throw new PermanentEgressError(
        `freescout answered HTTP ${response.status} with a redirect, which this adapter refuses so the `
          + 'API key stays on FREESCOUT_BASE_URL; set it to the address the helpdesk redirects to',
      );
    }
    return response;
  }
}

/**
 * Releases a response body nothing reads. An unread body holds its
 * connection until the response is collected.
 */
async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/**
 * Turns one refused response into an error of the right class.
 *
 * A rejected payload and a wrong key never clear on a retry, and the queue's
 * attempt ceiling is sized for transient faults, so those escalate on the
 * first occurrence. A 5xx is transient and stays an ordinary error.
 */
async function egressError(
  response: Response,
  what: string,
  options: { readonly withBody: boolean } = { withBody: true },
): Promise<Error> {
  // A body that is not quoted is released rather than left holding its
  // connection.
  let detail = '';
  if (options.withBody) detail = (await response.text().catch(() => '')).slice(0, 500);
  else await discardBody(response);
  const message = `freescout refused to ${what}: HTTP ${response.status} ${detail}`.trim();
  return response.status >= 400 && response.status < 500
    ? new PermanentEgressError(message)
    : new Error(message);
}

/** One address for comparison, or null when there is nothing to compare. */
function normalizeAddress(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length === 0 ? null : trimmed;
}

