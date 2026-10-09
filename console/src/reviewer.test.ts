// Who is making this request (DEC-45).
//
// The server asks one question of every request, read or write, before it
// builds any page: which active reviewer stands behind it. This suite is the
// answer's own, so `server.test.ts` can hold the server to using it.
//
// The requests are real. Every shape this module reads is Node's —
// `headersDistinct` keeps each line where `headers` folds or drops them, and
// header bytes arrive as Latin-1 text — and `fetch` will send neither a
// duplicated header nor raw bytes. So each case goes through `node:http`.
import { createServer, request } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';

import { reviewerResolver } from './reviewer.js';
import type { ActiveReviewer, ReviewerRefusal, ReviewerVerdict } from './reviewer.js';

/** The refusal the resolver answered with, or a failure naming what it said. */
function refusalOf(verdict: ReviewerVerdict): ReviewerRefusal {
  if (!('refusal' in verdict)) {
    throw new Error(`expected a refusal, and got ${JSON.stringify(verdict)}`);
  }
  return verdict.refusal;
}

/**
 * The request as Node hands it to the console, for one routed header list.
 *
 * `headers` is the flat list form, which is what lets a case send one header
 * twice and what lets it send bytes that are not text.
 */
async function requestWith(headers: readonly string[]): Promise<IncomingMessage> {
  return await new Promise<IncomingMessage>((resolve, reject) => {
    const server = createServer((req, res) => {
      res.writeHead(204).end();
      resolve(req);
      server.close();
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      const sent = request(
        {
          host: '127.0.0.1', port, path: '/', method: 'GET',
          headers: ['host', `127.0.0.1:${port}`, ...headers],
        },
        (res) => res.resume(),
      );
      sent.on('error', reject);
      sent.end();
    });
  });
}

/** The console's resolver, with a roster that holds whatever a case says. */
function resolverFor(
  options: { identityHeader?: string; devReviewer?: string; active?: ActiveReviewer },
): (req: IncomingMessage) => Promise<ReviewerVerdict> {
  return reviewerResolver({
    ...(options.identityHeader === undefined ? {} : { identityHeader: options.identityHeader }),
    ...(options.devReviewer === undefined ? {} : { devReviewer: options.devReviewer }),
    active: options.active ?? (async () => true),
  });
}

const HEADER = 'x-forwarded-user';

/** The resolver a case about the header itself needs: the header is named. */
function headerResolver(active?: ActiveReviewer): (req: IncomingMessage) => Promise<ReviewerVerdict> {
  return resolverFor({ identityHeader: HEADER, ...(active === undefined ? {} : { active }) });
}

describe('the reviewer behind a request (DEC-45)', () => {
  // DEC-42. The operator names the header, because a console cannot guess
  // which of its request headers a proxy controls. Naming it is the
  // operator's statement that a proxy in front sets it.
  it('takes the header a trusted proxy set, once the operator names it', async () => {
    const req = await requestWith([HEADER, 'ops-oncall']);
    expect(await headerResolver()(req)).toEqual({ reviewer: 'ops-oncall' });
  });

  // Node reads header bytes as Latin-1. A proxy that sends UTF-8 bytes would
  // otherwise put a name like `SynthÃ¶tic` in the audit column, and the roster
  // would be asked about that name instead of the person's.
  it('reads a name a proxy sent as UTF-8 bytes as the name it sent', async () => {
    const req = await requestWith([HEADER, Buffer.from('Åsa Synthetic', 'utf8').toString('latin1')]);
    const asked: string[] = [];
    const reviewer = await headerResolver(async (identity) => {
      asked.push(identity);
      return true;
    })(req);
    expect(reviewer).toEqual({ reviewer: 'Åsa Synthetic' });
    // The roster sees the name, not the bytes Node read them as.
    expect(asked).toEqual(['Åsa Synthetic']);
  });

  // A byte that is not UTF-8 is Latin-1 text, and it stays as Node read it.
  it('reads a Latin-1 name unchanged', async () => {
    const req = await requestWith([HEADER, 'Åsa Synthetic']);
    expect(await headerResolver()(req)).toEqual({ reviewer: 'Åsa Synthetic' });
  });

  // The header is read only when the operator named it. A console cannot
  // guess which of its request headers a proxy controls, so a header nobody
  // named is a header any caller set.
  it('reads no header the operator did not name', async () => {
    const req = await requestWith([HEADER, 'ops-oncall']);
    // Nobody named a header, so there is no header to report either.
    expect(refusalOf(await resolverFor({})(req))).toEqual({
      detail: 'no_value', header: null, said: '', lines: 0,
    });
  });

  // The two have different fixes, so the log tells them apart: a header that
  // never arrived is the proxy's configuration, and one that arrived empty is
  // what the proxy sent.
  it('tells an absent header from one that arrived empty', async () => {
    expect(refusalOf(await headerResolver()(await requestWith([])))).toEqual({
      detail: 'no_value', header: HEADER, said: '', lines: 0,
    });
    expect(refusalOf(await headerResolver()(await requestWith([HEADER, ''])))).toEqual({
      detail: 'no_value', header: HEADER, said: '', lines: 1,
    });
  });

  // Two lines are two claims, and this console cannot say which one the proxy
  // meant. A proxy that sets this header once and does not strip an inbound
  // copy produces exactly that, which is the forgeable audit trail DEC-42
  // refuses.
  it('names nobody when the header arrived more than once', async () => {
    const req = await requestWith([HEADER, 'ops-oncall', HEADER, 'mallory']);
    // Node kept both, which is what makes the refusal above possible.
    expect(req.headersDistinct[HEADER]).toEqual(['ops-oncall', 'mallory']);
    // The log needs the count and what arrived: a proxy that appends rather
    // than replaces produces this on every request.
    expect(refusalOf(await headerResolver()(req))).toEqual({
      detail: 'repeated', header: HEADER, said: 'ops-oncall', lines: 2,
    });
  });

  // Node joins a repeated header only for some names. For others, such as
  // `From`, it keeps the first value and drops the rest without a sign. This
  // drives `claimedIdentity` directly, because the entry point refuses `from`
  // as a header a client sets — the folding rule is Node's, and it holds for
  // every name an operator can still choose.
  it('names nobody when a header Node keeps only once arrived twice', async () => {
    const req = await requestWith(['from', 'ops-oncall', 'from', 'mallory']);
    // The flat form survived; the folded one did not.
    expect(req.headersDistinct['from']).toEqual(['ops-oncall', 'mallory']);
    expect(req.headers['from']).toBe('ops-oncall');
    const resolver = resolverFor({ identityHeader: 'from' });
    expect(refusalOf(await resolver(req))).toEqual({
      detail: 'repeated', header: 'from', said: 'ops-oncall', lines: 2,
    });
  });

  // One line holding a comma cannot be read apart: it may be one name
  // containing a comma, or two a proxy folded together.
  it('names nobody when one value carries a comma', async () => {
    const req = await requestWith([HEADER, 'ops-oncall, mallory']);
    expect(refusalOf(await headerResolver()(req))).toEqual({
      detail: 'comma', header: HEADER, said: 'ops-oncall, mallory', lines: 1,
    });
  });

  // The roster decides, so a name it does not hold is nobody. A stranger who
  // reaches the port and sets the header the operator named is refused here.
  it('names nobody the roster does not hold, or no longer holds', async () => {
    const req = await requestWith([HEADER, 'mallory']);
    const stranger = await headerResolver(async (identity) => identity === 'ops-oncall')(req);
    expect(refusalOf(stranger)).toEqual({
      detail: 'not_on_roster', header: HEADER, said: 'mallory', lines: 1,
    });
    const held = await headerResolver(async (identity) => identity === 'mallory')(req);
    expect(held).toEqual({ reviewer: 'mallory' });
  });

  // The name the approval would record is the name the roster is asked about.
  // A value DEC-42 reduces to `unattributed` is not a reviewer: no approval
  // could ever record it, so the console does not serve on it.
  it('names nobody for a value the ledger would not keep', async () => {
    const long = await requestWith([HEADER, 'a'.repeat(257)]);
    expect(refusalOf(await headerResolver()(long))).toEqual({
      detail: 'refused_name', header: HEADER, said: 'a'.repeat(257), lines: 1,
    });
    // Node trims a field value, so a value of spaces arrives empty and is
    // refused as nothing rather than as a name. It arrived, so `lines` is 1.
    const blank = await requestWith([HEADER, '   ']);
    expect(refusalOf(await headerResolver()(blank))).toEqual({
      detail: 'no_value', header: HEADER, said: '', lines: 1,
    });
  });

  // A roster read that failed is not permission to serve. The caller refuses
  // the request, and the fault reaches it rather than being read as nobody.
  it('lets a roster fault through', async () => {
    const req = await requestWith([HEADER, 'ops-oncall']);
    const down = async (): Promise<boolean> => { throw new Error('connection terminated'); };
    await expect(headerResolver(down)(req)).rejects.toThrow('connection terminated');
  });

  // DEC-45: a console running from source on loopback may name its own
  // reviewer, so the surfaces can be worked on without a proxy in front.
  describe('the development reviewer', () => {
    it('stands in when the named header yields no identity', async () => {
      const resolver = resolverFor({ devReviewer: 'dev@example.test', identityHeader: HEADER });
      expect(await resolver(await requestWith([]))).toEqual({ reviewer: 'dev@example.test' });
    });

    // A console cannot be both, which `dev-reviewer.ts` refuses at startup.
    // The precedence is still stated here so the resolver's own answer is
    // pinned rather than inherited from an entry point nothing tests.
    it('yields to a header the operator named, when it is given both', async () => {
      const resolver = resolverFor({ devReviewer: 'dev@example.test', identityHeader: HEADER });
      expect(await resolver(await requestWith([HEADER, 'ops-oncall'])))
        .toEqual({ reviewer: 'ops-oncall' });
    });

    // A stand-in that is not on the roster is nobody, exactly like a header
    // that named a stranger.
    it('is refused when the roster does not hold it', async () => {
      const resolver = resolverFor({
        devReviewer: 'dev@example.test',
        active: async (identity) => identity === 'ops-oncall',
      });
      // The development name is named in the refusal, because the operator
      // is the one who set it and the fix is to add it to the roster.
      expect(refusalOf(await resolver(await requestWith([])))).toEqual({
        detail: 'not_on_roster', header: null, said: 'dev@example.test', lines: 0,
      });
    });
  });
});
