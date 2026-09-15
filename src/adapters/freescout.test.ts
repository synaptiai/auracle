/**
 * FreeScout adapter, against a server that speaks the documented API over a
 * real socket.
 *
 * The server here is not FreeScout. It is the wire contract FreeScout's API
 * documentation states: the `X-FreeScout-API-Key` header, `201` with a
 * `Resource-ID` header on thread create, `embed=threads` on conversation
 * read, and `404` for a conversation that is gone. Every request in this
 * file crosses a TCP connection and every response is parsed from real HTTP,
 * so the client's own behaviour is exercised. What it cannot prove is that
 * FreeScout answers this way; that pass is a person opening the instance
 * `docker compose` brings up, and the pull request records it separately.
 *
 * A wire server rather than an injected fetch, because the failure this
 * guards against is a request built wrong. A stub function that receives the
 * arguments the adapter meant to send cannot see a header that never made it
 * onto the wire.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  FREESCOUT_TEST_API_KEY,
  FREESCOUT_TEST_USER_ID,
  FakeFreeScout,
  type StoredThread,
} from '../test-support/freescout-wire.js';

import {
  FREESCOUT_CAPABILITIES,
  FreeScoutEgressAdapter,
  assertTicketIdIsAddressable,
  composeDraftBody,
  formatDraftId,
  replyPartOf,
  freeScoutConfigFromEnv,
  parseDraftId,
} from './freescout.js';
import { SEED_THRESHOLDS, evaluatePolicyDetailed } from '../policy/policy.js';
import type { PolicyInput } from '../policy/policy.js';
import { AdapterCapabilityError, PermanentEgressError } from './types.js';
import type { DraftReply } from './types.js';

/** Synthetic throughout (DEC-18): no real address, name or account id. */
const PROVENANCE = {
  generatedBy: 'auracle',
  modelId: 'test/model-v1',
  promptVer: 'p-2026-01',
  generatedAt: '2026-01-02T03:04:05Z',
};

function reply(overrides: Partial<DraftReply> = {}): DraftReply {
  return {
    ticketExternalId: '41',
    body: 'Your order ships tomorrow.',
    disclosure: 'This reply was drafted by an automated assistant.',
    provenance: PROVENANCE,
    idemKey: 'refund:41:v1',
    ...overrides,
  };
}

let instance: FakeFreeScout;
let adapter: FreeScoutEgressAdapter;

beforeEach(async () => {
  instance = new FakeFreeScout();
  await instance.start();
  instance.conversations.set('41', []);
  adapter = new FreeScoutEgressAdapter({
    baseUrl: instance.baseUrl,
    apiKey: FREESCOUT_TEST_API_KEY,
    userId: FREESCOUT_TEST_USER_ID,
    timeoutMs: 5_000,
  });
});

afterEach(async () => {
  await instance.stop();
});

describe('the capability declaration (DEC-06)', () => {
  // The declaration is the whole point of the adapter, so it is pinned
  // value by value rather than as an object literal a careless edit could
  // rewrite wholesale.
  it('declares no idempotency key, because thread create takes none', () => {
    expect(adapter.capabilities.supportsIdempotencyKey).toBe(false);
  });

  it('declares no read-back, because no thread carries the outbox key', () => {
    expect(adapter.capabilities.supportsReadBack).toBe(false);
  });

  it('declares draft state, structured fields and threading as the API gives them', () => {
    expect(adapter.capabilities.supportsDraftState).toBe(true);
    expect(adapter.capabilities.supportsStructuredFields).toBe(false);
    expect(adapter.capabilities.supportsThreading).toBe(true);
  });

  it('is frozen, so no caller can widen a guarantee at runtime', () => {
    expect(Object.isFrozen(FREESCOUT_CAPABILITIES)).toBe(true);
  });
});

describe('createDraft parks a draft over the network (DEC-11)', () => {
  it('posts a draft thread and returns an id naming the conversation', async () => {
    const parked = await adapter.createDraft(reply());

    const threads = instance.conversations.get('41') ?? [];
    expect(threads).toHaveLength(1);
    expect(threads[0]?.state).toBe('draft');
    expect(threads[0]?.type).toBe('message');
    expect(parked.draftExternalId).toBe(formatDraftId('41', String(threads[0]?.id)));
  });

  it('sends the API key and the documented request shape on the wire', async () => {
    await adapter.createDraft(reply());

    const request = instance.seen.at(-1);
    expect(request?.method).toBe('POST');
    expect(request?.url).toBe('/api/conversations/41/threads');
    expect(request?.apiKey).toBe(FREESCOUT_TEST_API_KEY);
    expect(request?.accept).toBe('application/json');
    expect(request?.contentType).toBe('application/json');
    expect(request?.body).toMatchObject({ type: 'message', user: FREESCOUT_TEST_USER_ID, state: 'draft' });
  });

  it('carries the disclosure and the provenance in the body (DEC-14, DEC-33)', async () => {
    await adapter.createDraft(reply());

    const body = (instance.conversations.get('41') ?? [])[0]?.body ?? '';
    expect(body).toContain('Your order ships tomorrow.');
    expect(body).toContain('This reply was drafted by an automated assistant.');
    expect(body).toContain('test/model-v1');
    expect(body).toContain('p-2026-01');
  });

  it('refuses a reply with no disclosure before it reaches the network (DEC-14)', async () => {
    await expect(adapter.createDraft(reply({ disclosure: '  ' }))).rejects.toThrow(
      /disclosure must not be empty/,
    );
    expect(instance.seen).toHaveLength(0);
  });

  it('refuses a reply with no idempotency key (DEC-24)', async () => {
    await expect(adapter.createDraft(reply({ idemKey: '' }))).rejects.toThrow(
      /idemKey must not be empty/,
    );
    expect(instance.seen).toHaveLength(0);
  });

  // A missing conversation never becomes present on a retry, and the queue's
  // attempt ceiling is sized for transient faults.
  it('treats an unknown conversation as permanent', async () => {
    await expect(adapter.createDraft(reply({ ticketExternalId: '999' }))).rejects.toThrow(
      PermanentEgressError,
    );
  });

  it('treats a refused payload as permanent and a server fault as transient', async () => {
    instance.createStatus = 422;
    const refused = await adapter.createDraft(reply()).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(PermanentEgressError);
    // A refused write keeps the helpdesk's reason: the relay escalates with it.
    expect((refused as Error).message).toContain('refused');

    instance.createStatus = 503;
    const transient = await adapter.createDraft(reply()).catch((error: unknown) => error);
    expect(transient).toBeInstanceOf(Error);
    expect(transient).not.toBeInstanceOf(PermanentEgressError);
  });

  // A 201 that names nothing leaves a draft in front of a person that no
  // later call can read or send. That is a failure, not a default id.
  it('fails when the create returns no Resource-ID header', async () => {
    instance.omitResourceId = true;
    await expect(adapter.createDraft(reply())).rejects.toThrow(/no Resource-ID header/);
  });

  // Two parks with one key make two drafts, because nothing enforces the
  // key. Pinned so the absent guarantee is visible in the suite, not only in
  // the header comment: this is the evidence for supportsIdempotencyKey.
  it('parks twice for one key, which is why it declares no idempotency support', async () => {
    await adapter.createDraft(reply());
    await adapter.createDraft(reply());
    expect(instance.conversations.get('41')).toHaveLength(2);
  });
});

describe('readDraft reads the parked body back (section 4.10)', () => {
  it('returns the body the park wrote', async () => {
    const parked = await adapter.createDraft(reply());
    const read = await adapter.readDraft(parked.draftExternalId);
    expect(read?.body).toContain('Your order ships tomorrow.');
  });

  it('returns what a person edited, not what the park wrote', async () => {
    const parked = await adapter.createDraft(reply());
    const threads = instance.conversations.get('41') ?? [];
    (threads[0] as StoredThread).body = 'Your order ships on Friday.';

    const read = await adapter.readDraft(parked.draftExternalId);
    expect(read?.body).toBe('Your order ships on Friday.');
  });

  it('returns null for a draft the instance no longer holds', async () => {
    const parked = await adapter.createDraft(reply());
    instance.conversations.set('41', []);
    expect(await adapter.readDraft(parked.draftExternalId)).toBeNull();
  });

  it('returns null for a conversation that is gone', async () => {
    expect(await adapter.readDraft(formatDraftId('999', '1'))).toBeNull();
  });

  // A published thread is a sent message. Reading it as a draft would let an
  // approval measure the distance to text the customer already holds.
  it('returns null for a thread that has left the draft state', async () => {
    const parked = await adapter.createDraft(reply());
    const threads = instance.conversations.get('41') ?? [];
    (threads[0] as StoredThread).state = 'published';
    expect(await adapter.readDraft(parked.draftExternalId)).toBeNull();
  });
});

describe('sendDraft publishes the approved text', () => {
  it('posts a published thread carrying the draft body', async () => {
    const parked = await adapter.createDraft(reply());
    const sent = await adapter.sendDraft(parked.draftExternalId, 'refund:41:v1');

    const threads = instance.conversations.get('41') ?? [];
    expect(threads).toHaveLength(2);
    expect(threads[1]?.state).toBe('published');
    expect(threads[1]?.body).toContain('Your order ships tomorrow.');
    expect(sent.externalId).toBe(formatDraftId('41', String(threads[1]?.id)));
  });

  it('sends the edited body when a person changed the draft', async () => {
    const parked = await adapter.createDraft(reply());
    const threads = instance.conversations.get('41') ?? [];
    (threads[0] as StoredThread).body = 'Your order ships on Friday.';

    await adapter.sendDraft(parked.draftExternalId, 'refund:41:v1');
    expect(threads[1]?.body).toBe('Your order ships on Friday.');
  });

  // The parked draft is not published in place, because the API has no
  // endpoint that updates a thread. Pinned so nobody reads the send as a
  // state change it cannot perform.
  it('leaves the parked draft in place, because the API cannot publish one', async () => {
    const parked = await adapter.createDraft(reply());
    await adapter.sendDraft(parked.draftExternalId, 'refund:41:v1');
    expect((instance.conversations.get('41') ?? [])[0]?.state).toBe('draft');
  });

  it('refuses to send a draft the instance no longer holds', async () => {
    const parked = await adapter.createDraft(reply());
    instance.conversations.set('41', []);
    await expect(adapter.sendDraft(parked.draftExternalId, 'refund:41:v1')).rejects.toThrow(
      PermanentEgressError,
    );
  });

  it('refuses an empty idempotency key', async () => {
    const parked = await adapter.createDraft(reply());
    await expect(adapter.sendDraft(parked.draftExternalId, ' ')).rejects.toThrow(
      /idemKey must not be empty/,
    );
  });
});

describe('what the adapter refuses to fake (DEC-06, DEC-30)', () => {
  it('throws rather than apply an automatic internal write', async () => {
    await expect(adapter.performAction('refund', {}, 'k')).rejects.toThrow(AdapterCapabilityError);
  });

  it('throws rather than answer a delivery read-back', async () => {
    await expect(adapter.readBack({ idemKey: 'k' })).rejects.toThrow(AdapterCapabilityError);
  });

  it('names the capability in each refusal, so an operator reads the limit', async () => {
    await expect(adapter.performAction('refund', {}, 'k')).rejects.toThrow(
      /supportsIdempotencyKey is false/,
    );
    await expect(adapter.readBack({ idemKey: 'k' })).rejects.toThrow(/supportsReadBack is false/);
  });
});

describe('the draft id names its conversation', () => {
  it('round-trips', () => {
    expect(parseDraftId(formatDraftId('41', '101'))).toEqual({
      conversationId: '41',
      threadId: '101',
    });
  });

  it('refuses a value that is not a FreeScout draft id', () => {
    for (const bad of ['', '41', '41:', ':101', '41:101:2']) {
      expect(() => parseDraftId(bad)).toThrow(/not a FreeScout draft id/);
    }
  });
});

describe('the body a draft carries', () => {
  it('places the reply first, then the disclosure, then the provenance', () => {
    const body = composeDraftBody('Reply text.', 'Automated assistant.', PROVENANCE);
    expect(body.indexOf('Reply text.')).toBeLessThan(body.indexOf('Automated assistant.'));
    expect(body.indexOf('Automated assistant.')).toBeLessThan(body.indexOf('generated-by:'));
  });

  // The approval-edit distance compares the journalled reply against the
  // read-back body. Returning the trailer too would count this adapter's own
  // text as a person's edit, and the C2 control band would move with the
  // disclosure wording rather than with what people change.
  it('strips the trailer again, so a read-back matches what the ledger holds', () => {
    const reply = 'Reply text.';
    expect(replyPartOf(composeDraftBody(reply, 'Automated assistant.', PROVENANCE))).toBe(reply);
  });

  it('returns a body with no trailer whole, rather than guess where one was', () => {
    expect(replyPartOf('A body a person rewrote entirely.')).toBe(
      'A body a person rewrote entirely.',
    );
  });

  it('reads back exactly what the park wrote, when nobody edited it', async () => {
    const parked = await adapter.createDraft(reply());
    expect((await adapter.readDraft(parked.draftExternalId))?.body).toBe(
      'Your order ships tomorrow.',
    );
  });

  it('sends the disclosure to the customer even though read-back hides it (DEC-14)', async () => {
    const parked = await adapter.createDraft(reply());
    await adapter.sendDraft(parked.draftExternalId, 'refund:41:v1');
    const published = (instance.conversations.get('41') ?? []).filter(
      (thread) => thread.state === 'published',
    );
    expect(published[0]?.body).toContain('This reply was drafted by an automated assistant.');
    expect(published[0]?.body).toContain('test/model-v1');
  });
});

// A conversation read that fails reaches the console's read-back log. The
// helpdesk's error page can quote request details or a customer, so the
// error names the status and not the body.
describe('a refused conversation read', () => {
  it('names the status and leaves the response body out', async () => {
    const parked = await adapter.createDraft(reply());
    instance.readStatus = 500;
    instance.readBody = 'debug: customer synthetic.person@example.invalid';
    const failure = await adapter.readDraft(parked.draftExternalId).catch((error: unknown) => error);
    expect((failure as Error).message).toContain('HTTP 500');
    expect((failure as Error).message).not.toContain('example.invalid');
  });
});

// The API key travels in a header of its own, which fetch keeps on a
// redirect to another origin. So a redirect is refused, and the key reaches
// only the base URL the operator named.
describe('a FreeScout request that is redirected', () => {
  it('refuses the redirect, and the key never reaches the other host', async () => {
    const keysSeen: (string | undefined)[] = [];
    const elsewhere = createServer((request, response) => {
      keysSeen.push(request.headers['x-freescout-api-key'] as string | undefined);
      response.end('{}');
    });
    await new Promise<void>((resolve) => elsewhere.listen(0, '127.0.0.1', resolve));
    const redirecting = createServer((_request, response) => {
      response.statusCode = 302;
      response.setHeader('Location', `http://127.0.0.1:${(elsewhere.address() as AddressInfo).port}/api/x`);
      response.end();
    });
    await new Promise<void>((resolve) => redirecting.listen(0, '127.0.0.1', resolve));
    try {
      const redirected = new FreeScoutEgressAdapter({
        baseUrl: `http://127.0.0.1:${(redirecting.address() as AddressInfo).port}`,
        apiKey: FREESCOUT_TEST_API_KEY,
        userId: FREESCOUT_TEST_USER_ID,
      });
      const failure = await redirected.readDraft(formatDraftId('41', '101')).catch((error: unknown) => error);
      // Named, and permanent: a base URL that redirects is a configuration
      // fault a retry finds again. The target is not quoted.
      expect(failure).toBeInstanceOf(PermanentEgressError);
      expect((failure as Error).message).toContain('HTTP 302');
      expect((failure as Error).message).toContain('FREESCOUT_BASE_URL');
      expect((failure as Error).message).not.toContain(String((elsewhere.address() as AddressInfo).port));
      expect(keysSeen).toEqual([]);
    } finally {
      redirecting.close();
      elsewhere.close();
    }
  });
});

describe('a conversation read that answers something other than JSON', () => {
  // A proxy or a debug page can answer 200 with HTML. Parsing it quoted the
  // start of the body in the error, and that error reaches the read-back log.
  it('names the status and quotes nothing from the body', async () => {
    const parked = await adapter.createDraft(reply());
    instance.readStatus = 200;
    instance.readBody = 'Synthetic Person, synthetic.person@example.invalid';
    const failure = await adapter.readDraft(parked.draftExternalId).catch((error: unknown) => error);
    expect((failure as Error).message).toContain('HTTP 200');
    expect((failure as Error).message).not.toContain('Synthetic');
  });
});

describe('a draft read the caller stops waiting for', () => {
  it('ends when the caller aborts, not at the adapter bound', async () => {
    const silent = createServer(() => undefined);
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    try {
      const slow = new FreeScoutEgressAdapter({
        baseUrl: `http://127.0.0.1:${(silent.address() as AddressInfo).port}`,
        apiKey: FREESCOUT_TEST_API_KEY,
        userId: FREESCOUT_TEST_USER_ID,
        timeoutMs: 10_000,
      });
      const controller = new AbortController();
      const started = Date.now();
      const read = slow.readDraft(formatDraftId('41', '101'), { signal: controller.signal });
      setTimeout(() => controller.abort(new Error('the console gave up')), 100);
      await expect(read).rejects.toThrow('the console gave up');
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      silent.closeAllConnections();
      silent.close();
    }
  });
});

describe('configuration comes from the environment and has no default', () => {
  it('reads a complete configuration', () => {
    const config = freeScoutConfigFromEnv({
      FREESCOUT_BASE_URL: 'http://localhost:8088/',
      FREESCOUT_API_KEY: FREESCOUT_TEST_API_KEY,
      FREESCOUT_USER_ID: '7',
    });
    expect(config).toEqual({ baseUrl: 'http://localhost:8088', apiKey: FREESCOUT_TEST_API_KEY, userId: 7 });
  });

  // A default base URL would let a misconfigured process post a customer
  // reply into whatever answers on that address.
  it('refuses every missing value rather than defaulting one', () => {
    const complete = {
      FREESCOUT_BASE_URL: 'http://localhost:8088',
      FREESCOUT_API_KEY: FREESCOUT_TEST_API_KEY,
      FREESCOUT_USER_ID: '7',
    };
    for (const name of Object.keys(complete)) {
      const partial = { ...complete, [name]: undefined };
      expect(() => freeScoutConfigFromEnv(partial), name).toThrow(new RegExp(name));
    }
  });

  // `fetch` refuses a URL carrying credentials, and its error text quotes the
  // whole URL. That text reached the console's read-back log on every
  // approval, so the configuration refuses it where the process starts.
  it('refuses a base URL that carries a user name or password, without echoing it', () => {
    for (const url of ['https://synthetic-user:synthetic-secret@helpdesk.invalid', 'https://synthetic-user@helpdesk.invalid']) {
      let message = '';
      try {
        freeScoutConfigFromEnv({ FREESCOUT_BASE_URL: url, FREESCOUT_API_KEY: FREESCOUT_TEST_API_KEY, FREESCOUT_USER_ID: '7' });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, url).toContain('FREESCOUT_BASE_URL');
      expect(message, url).not.toContain('synthetic-secret');
      expect(message, url).not.toContain('synthetic-user');
    }
  });

  it('refuses a base URL that is not http or https', () => {
    expect(() => freeScoutConfigFromEnv({
      FREESCOUT_BASE_URL: 'ftp://helpdesk.invalid', FREESCOUT_API_KEY: FREESCOUT_TEST_API_KEY, FREESCOUT_USER_ID: '7',
    })).toThrow(/^FREESCOUT_BASE_URL is not an http or https URL$/);
  });

  it('refuses a base URL that is not a URL, without echoing it', () => {
    expect(() => freeScoutConfigFromEnv({
      FREESCOUT_BASE_URL: 'helpdesk synthetic-secret', FREESCOUT_API_KEY: FREESCOUT_TEST_API_KEY, FREESCOUT_USER_ID: '7',
    })).toThrow(/^FREESCOUT_BASE_URL is not an http or https URL$/);
  });

  it('refuses a user id that is not a positive integer', () => {
    expect(() =>
      freeScoutConfigFromEnv({
        FREESCOUT_BASE_URL: 'http://localhost:8088',
        FREESCOUT_API_KEY: FREESCOUT_TEST_API_KEY,
        FREESCOUT_USER_ID: 'nine',
      }),
    ).toThrow(/positive integer/);
  });
});

// AC of issue #24: with no idempotency key declared, every write action of
// this adapter reaches the approval path. Asserted against the real engine
// and the adapter's real declaration, so a widened flag breaks it here.
describe('the policy engine routes every write of this adapter to a person (DEC-06)', () => {
  const thresholds = SEED_THRESHOLDS;

  // Perfect evidence, so nothing but the capability rules can gate.
  function input(action: PolicyInput['action'], riskTier: PolicyInput['riskTier'] = 'low'): PolicyInput {
    return {
      riskTier,
      agreement: 1,
      groundedness: 1,
      thresholds,
      capabilities: FREESCOUT_CAPABILITIES,
      action,
    };
  }

  it('gates every write, at every risk tier, with the best evidence there is', () => {
    for (const riskTier of ['low', 'medium', 'high'] as const) {
      for (const isCustomerVisible of [false, true]) {
        for (const isIrreversible of [false, true]) {
          const outcome = evaluatePolicyDetailed(
            input({ isWrite: true, isCustomerVisible, isIrreversible }, riskTier),
          );
          expect(outcome.decision, `${riskTier}/${isCustomerVisible}/${isIrreversible}`).toBe(
            'gated',
          );
        }
      }
    }
  });

  it('names the missing idempotency key as the reason for a plain write', () => {
    const outcome = evaluatePolicyDetailed(
      input({ isWrite: true, isCustomerVisible: false, isIrreversible: false }),
    );
    expect(outcome.reason).toBe('no_idempotency');
  });

  // The read-back rule cannot be seen through this adapter, because the
  // idempotency rule returns first. It is proved in src/policy/policy.test.ts
  // against a capability set no shipped adapter has.
  it('leaves a read-only action alone: the rules are about writes', () => {
    const outcome = evaluatePolicyDetailed(
      input({ isWrite: false, isCustomerVisible: false, isIrreversible: false }),
    );
    expect(outcome.decision).toBe('auto');
  });
});

// DEC-35. The conversation id is the ticket id, and FreeScout addresses a
// thread to that conversation's customer, so the ticket id is the addressing
// here. A forged thread root gets a new conversation (db/012) and keeps the
// forged id, which would otherwise send the reply to whoever opened the
// original. The mail adapter refuses the same delivery.
describe('the reply goes to the participant the ledger recorded (DEC-35)', () => {
  it('parks when the conversation belongs to the expected participant', async () => {
    instance.customers.set('41', 'buyer@example.test');
    const parked = await adapter.createDraft(reply({ expectedRecipient: 'buyer@example.test' }));
    expect(parked.draftExternalId).toMatch(/^41:/);
  });

  it('matches the address without regard to case', async () => {
    instance.customers.set('41', 'Buyer@Example.Test');
    await expect(
      adapter.createDraft(reply({ expectedRecipient: 'buyer@example.test' })),
    ).resolves.toBeDefined();
  });

  // Trimming only the side that decides whether to compare made a padded
  // address refuse every park permanently, and the webhook ingress passes an
  // address through as the payload wrote it.
  it('matches an address padded on either side', async () => {
    instance.customers.set('41', ' buyer@example.test ');
    await expect(
      adapter.createDraft(reply({ expectedRecipient: 'buyer@example.test ' })),
    ).resolves.toBeDefined();
  });

  it('refuses to park when the conversation belongs to somebody else', async () => {
    instance.customers.set('41', 'someone-else@example.test');
    await expect(
      adapter.createDraft(reply({ expectedRecipient: 'buyer@example.test' })),
    ).rejects.toThrow(PermanentEgressError);
    expect(instance.conversations.get('41')).toHaveLength(0);
  });

  it('names both addresses in the refusal', async () => {
    instance.customers.set('41', 'someone-else@example.test');
    await expect(
      adapter.createDraft(reply({ expectedRecipient: 'buyer@example.test' })),
    ).rejects.toThrow(/records buyer@example.test but .* belongs to someone-else@example.test/);
  });

  // Absent means the ledger recorded no participant. That is nothing to check
  // against, not permission to address the reply anywhere.
  it('parks when the ledger recorded no participant', async () => {
    instance.customers.set('41', 'buyer@example.test');
    await expect(adapter.createDraft(reply({ expectedRecipient: null }))).resolves.toBeDefined();
    await expect(adapter.createDraft(reply())).resolves.toBeDefined();
  });

  it('parks when the conversation reports no customer address', async () => {
    await expect(
      adapter.createDraft(reply({ expectedRecipient: 'buyer@example.test' })),
    ).resolves.toBeDefined();
  });

  it('refuses a conversation that is gone rather than park blind', async () => {
    await expect(
      adapter.createDraft(
        reply({ ticketExternalId: '999', expectedRecipient: 'buyer@example.test' }),
      ),
    ).rejects.toThrow(PermanentEgressError);
  });
});

describe('a ticket id that could not survive the round trip', () => {
  // The park is checked before it happens. A colon-bearing ticket id used to
  // park successfully and then make every later read and send throw, leaving
  // a draft in front of a person that nothing could send.
  it('refuses to park against a ticket id containing the separator', async () => {
    instance.conversations.set('4:1', []);
    await expect(adapter.createDraft(reply({ ticketExternalId: '4:1' }))).rejects.toThrow(
      PermanentEgressError,
    );
    expect(instance.conversations.get('4:1')).toHaveLength(0);
  });

  it('names the separator and the reason in the refusal', () => {
    expect(() => assertTicketIdIsAddressable('4:1')).toThrow(/could never be read back/);
    expect(assertTicketIdIsAddressable('41')).toBe('41');
  });
});

describe('the trailer split is a guess, and each guess fails a stated way', () => {
  // Documented, not repaired: nothing in a FreeScout thread records where the
  // trailer began. Each case moves one run's distance and neither corrupts
  // the ledger, and C2 reads a distribution over many runs.
  it('understates the edit when a person ends their own reply with a separator', async () => {
    const parked = await adapter.createDraft(reply());
    const { conversationId, threadId } = parseDraftId(parked.draftExternalId);
    instance.editThread(conversationId, threadId, 'Kind regards,\n\n-- \nA person\n');

    expect((await adapter.readDraft(parked.draftExternalId))?.body).toBe('Kind regards,');
  });

  it('counts the whole body when a person removes the trailer', async () => {
    const parked = await adapter.createDraft(reply());
    const { conversationId, threadId } = parseDraftId(parked.draftExternalId);
    instance.editThread(conversationId, threadId, 'A reply with no trailer at all.');

    expect((await adapter.readDraft(parked.draftExternalId))?.body).toBe(
      'A reply with no trailer at all.',
    );
  });
});
