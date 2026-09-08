// Every route, against a server with no database (issue #27).
//
// The deps are injected, so these cases drive the real router and the real
// surfaces while the ledger is a stub. What they prove is the routing, the
// two display rules reaching a rendered page, and the write's shape — the
// delegation itself is proved in `approve.test.ts`.
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { request } from 'node:http';
import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { allowedHosts } from './hosts.js';
import { createConsole } from './server.js';
import type { ConsoleDeps } from './server.js';

const RUN = '4f1c2b8e-9d3a-4e77-b0d1-6a5c8e2f1b34';

const CONVERSATION = '99999999-8888-4777-8666-555555555555';

/**
 * One drafted reply, its claims and their sources.
 *
 * Three claims on purpose: one the judge supported, one it refused, and one
 * with no verdict. Those are three different facts and the surface has to
 * draw them apart — a claim nobody judged is not a claim the judge refused.
 */
const EVIDENCE = {
  draftBody: 'We refunded the duplicate charge. Your bank decides when it lands.',
  claims: [
    {
      index: 0, text: 'We refunded the duplicate charge.',
      docId: 'SYN-DOC-01', supported: true,
    },
    {
      index: 1, text: 'Your bank decides when it lands.',
      docId: 'SYN-DOC-01', supported: false,
    },
    {
      index: 2, text: 'Your subscription is unchanged.',
      docId: 'SYN-DOC-99', supported: null,
    },
  ],
  documentsMalformed: false,
  documents: [
    {
      position: 1, docId: 'SYN-DOC-01', title: 'Refund policy', kind: 'document',
      owner: 'support', bodyUnchanged: true, titleAtRun: 'Refund policy',
    },
    // An id the journal holds that no document row answers for today.
    {
      position: 2, docId: 'SYN-DOC-99', title: null, kind: null, owner: null,
      bodyUnchanged: null, titleAtRun: 'Cancellation policy',
    },
  ],
};

function deps(overrides: Partial<ConsoleDeps> = {}): ConsoleDeps {
  return {
    listRuns: async () => [
      { runId: RUN, ticketId: 'SYN-1', state: 'resolved', promptVer: 'p1', reason: null, stepsUsed: 4 },
    ],
    readRun: async () => ({
      runId: RUN, ticketId: 'SYN-1', state: 'awaiting_approval', promptVer: 'p1',
      reason: 'policy_escalated', stepsUsed: 4,
      agreement: 0.89, coverage: 0.94, draftExternalId: 'D-1',
      agreementThreshold: 0.6, agreementDetail: '8 of 9 samples',
      coverageBlock: 0.7, coverageReview: 0.8,
      intentId: 'refund-request', decision: 'gated', policyReason: 'customer_visible',
      steps: [
        { stepId: 'classify', status: 'done', says: 'intent refund-request', awaitingOutcome: false, malformed: false },
        { stepId: 'retrieve', status: 'done', says: '3 documents', awaitingOutcome: false, malformed: false },
        // In flight or crashed, and the ledger cannot tell the two apart.
        { stepId: 'park', status: 'started', says: null, awaitingOutcome: true, malformed: false },
      ],
      conversationId: CONVERSATION,
      evidence: EVIDENCE,
    }),
    listApprovals: async () => [{
      runId: RUN, ticketId: 'SYN-1', state: 'awaiting_approval', promptVer: 'p1',
      reason: 'customer_visible', stepsUsed: 4,
      agreement: 0.89, coverage: 0.94, draftExternalId: 'D-1',
    }],
    readApprovalEvidence: async () => ({
      evidence: EVIDENCE,
      gates: {
        agreement: 0.89, coverage: 0.94, agreementThreshold: 0.6,
        agreementDetail: '8 of 9 samples', coverageBlock: 0.7, coverageReview: 0.8,
      },
    }),
    readConversation: async () => ({
      conversationId: CONVERSATION,
      primaryTicketId: 'SYN-1',
      state: 'open',
      participantNamed: true,
      turns: [
        {
          turnNumber: 1, ticketId: 'SYN-1',
          bodyText: 'There are two charges for the same month.',
          messageAbsence: null,
          replyText: 'We refunded the duplicate charge.',
          replyAbsence: null,
          runId: RUN, runState: 'resolved', runAttempts: 1,
        },
        {
          turnNumber: 2, ticketId: 'SYN-1',
          bodyText: null, messageAbsence: 'not_retained',
          replyText: null, replyAbsence: 'awaiting_approval',
          runId: null, runState: null, runAttempts: 0,
        },
      ],
    }),
    readDocument: async () => ({
      docId: 'SYN-DOC-01', kind: 'document', title: 'Refund policy',
      body: 'A charge is refundable inside fourteen days.',
      owner: 'support', reviewBy: '2030-01-01', fresh: true,
    }),
    readBands: async () => [
      {
        day: '2026-09-04', metric: 'abstain_rate',
        sample: { value: null, shortfall: 'no_runs' }, verdict: null, action: null,
        count: 0, baseline: null, history: [],
      },
      {
        day: '2026-09-04', metric: 'gate_pass_rate',
        sample: { value: 0, shortfall: null }, verdict: 'steady', action: 'in_band',
        count: 312, baseline: { mean: '0.781', sigma: '0.021', days: 30 },
        history: [0.78, 0.79, null, 0.77, 0.78],
      },
      // A shortfall carried alongside a value. Four of the six codes are this
      // shape, and a first version showed the shortfall only when the value
      // was null, so all four collapsed into a bare number.
      {
        day: '2026-09-04', metric: 'approval_edit_distance',
        // Distinctive on purpose. This was 7, which also appears in the
        // baseline mean and the history below, so asserting the page held a
        // 7 passed whatever the sample said.
        sample: { value: 4242, shortfall: 'thin_window' }, verdict: null, action: null,
        count: 12, baseline: null, history: [0.1, 0.2],
      },
    ],
    readLatency: async () => [
      {
        partition: 0,
        wait: [
          { label: 'p50', text: '0ms', share: 0 },
          { label: 'p95', text: '0ms', share: 0 },
          { label: 'p99', text: '0ms', share: 0 },
        ],
        service: [
          { label: 'p50', text: '40.4s', share: 0.1 },
          { label: 'p95', text: '3.0h', share: 1 },
          { label: 'p99', text: '3.4h', share: 1 },
        ],
        runs: 646,
        caveats: ['3 still running'],
      },
    ],
    approve: async () => 'approved',
    ...overrides,
  };
}

let open: Server | null = null;
afterEach(() => {
  open?.close();
  open = null;
});

let allowedPort = 0;

/**
 * The states the filter offers in these cases.
 *
 * A short list rather than the ledger's real one, so a case that asserts the
 * filter is asserting the router's handling of the set it was given rather
 * than restating `LEDGER_STATES` back to itself.
 */
const STATES = ['gated', 'awaiting_approval', 'resolved'] as const;

/** The ledger name the rail shows. Never a connection string. */
const LEDGER = 'localhost:5433/auracle';

/** A server whose allowlist is fixed to the port it ends up on. */
/** The allowlist `main.ts` would build for a console behind this proxy. */
function hostsFor(named: string, port: number): string[] {
  const previous = process.env['CONSOLE_ALLOWED_HOSTS'];
  process.env['CONSOLE_ALLOWED_HOSTS'] = named;
  try {
    return allowedHosts('0.0.0.0', port);
  } finally {
    if (previous === undefined) delete process.env['CONSOLE_ALLOWED_HOSTS'];
    else process.env['CONSOLE_ALLOWED_HOSTS'] = previous;
  }
}

async function startGuarded(
  d: ConsoleDeps,
  namedProxy?: string,
  identityHeader?: string,
): Promise<string> {
  const probe = createConsole(d, '.root{}', {
    allowedHosts: [], states: [...STATES], ledger: LEDGER,
  });
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  probe.close();
  const server = createConsole(d, '.root{}', {
    // Derived through `allowedHosts` when a proxy is named, so this harness
    // builds the same set `main.ts` would rather than restating it.
    allowedHosts: namedProxy === undefined
      ? [`127.0.0.1:${port}`, `localhost:${port}`]
      // Named, plus the loopback the test client actually connects over. The
      // exclusivity of the allowlist is `hosts.test.ts`'s subject; here the
      // point is that a proxy was named at all, which is what gates the
      // identity header.
      : [...hostsFor(namedProxy, port), `127.0.0.1:${port}`],
    ...(identityHeader === undefined ? {} : { identityHeader }),
    states: [...STATES],
    ledger: LEDGER,
  });
  open = server;
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  allowedPort = port;
  return `http://127.0.0.1:${port}`;
}

describe('the console routes', () => {
  it('serves all five surfaces', async () => {
    const base = await startGuarded(deps());
    for (const [path, marker] of [
      ['/', 'Runs'],
      [`/run/${RUN}`, 'Run detail'],
      ['/approvals', 'Approval queue'],
      ['/bands', 'Control bands'],
      ['/latency', 'Partition latency'],
    ] as const) {
      const res = await fetch(base + path);
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).toContain(marker);
    }
  });

  // DEC-05 as a display rule, checked on the rendered page rather than on the
  // function that builds it.
  it('shows the two gates apart on every page that shows them', async () => {
    const base = await startGuarded(deps());
    for (const path of [`/run/${RUN}`, '/approvals']) {
      const html = await (await fetch(base + path)).text();
      expect(html, path).toContain('0.89');
      expect(html, path).toContain('0.94');
      // A page-level check, and it sees only some blends. The mean renders
      // 0.915 and the product renders 0.837 at the three places these values
      // are shown — 0.8366 was the untruncated product and matched nothing.
      // The minimum and the maximum each equal an operand, so no page-wide
      // string check can see them; `render.test.ts` catches those with a
      // counted allowlist, where a minimum shows up as a second copy of a
      // value that is required to appear exactly once.
      for (const combined of ['0.915', '0.92', '0.837']) {
        expect(html, `${path} ${combined}`).not.toContain(combined);
      }
    }
  });

  it('renders a day that measured nothing as its shortfall, not as zero', async () => {
    const base = await startGuarded(deps());
    const html = await (await fetch(base + '/bands')).text();
    expect(html).toContain('no_runs');
    // The measured zero on the other metric is still a zero.
    expect(html).toContain('gate_pass_rate');
    // And a shortfall that carries a value shows both. Showing only the
    // number would make four codes indistinguishable from a clean reading.
    expect(html).toContain('thin_window');
    // Beside its own shortfall, not merely somewhere on the page.
    expect(html).toMatch(/data-shortfall="thin_window">4242\b/);
    // The day judged is named, so the page can be checked against the job.
    expect(html).toContain('2026-09-04');
  });

  it('answers 404 for an unknown run and an unknown page', async () => {
    const base = await startGuarded(deps({ readRun: async () => null }));
    expect((await fetch(`${base}/run/${RUN}`)).status).toBe(404);
    expect((await fetch(`${base}/nowhere`)).status).toBe(404);
  });

  it('posts an approval and redirects, so a refresh cannot repeat it', async () => {
    const approve = vi.fn().mockResolvedValue('approved');
    const base = await startGuarded(deps({ approve }));
    const res = await fetch(`${base}/approve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'same-origin',
      },
      body: new URLSearchParams({ runId: RUN }).toString(),
      redirect: 'manual',
    });
    expect(res.status).toBe(303);
    expect(approve).toHaveBeenCalledWith(RUN, undefined);
  });

  // The reply the customer receives is the draft the helpdesk holds: the
  // outbox payload for a draft-backed park is `{ draftExternalId }`, and the
  // relay sends that draft verbatim. A body posted here would be recorded as
  // the approved reply, feed the published approval-edit distance, and never
  // reach anyone. So a posted body is not merely ignored by the page — it
  // cannot reach `approveRun` through this route at all.
  it('ignores a reply body posted straight at the route', async () => {
    const approve = vi.fn().mockResolvedValue('approved');
    const base = await startGuarded(deps({ approve }));
    await fetch(`${base}/approve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'same-origin',
      },
      body: new URLSearchParams({
        runId: RUN, finalBody: 'never sent', approvedBy: 'not-from-a-form',
      }).toString(),
      redirect: 'manual',
    });
    // Two arguments and no more: the run id, and the approver a trusted proxy
    // named. Neither comes from the form. A body posted here would be
    // recorded as the approved reply while the relay sent the parked draft,
    // and an approver taken from a form is a name anyone can type.
    expect(approve).toHaveBeenCalledWith(RUN, undefined);
    expect(approve.mock.calls[0]).toHaveLength(2);
  });

  // And the page offers no way to type one.
  it('offers no reply box on the approval queue', async () => {
    const base = await startGuarded(deps());
    const html = await (await fetch(base + '/approvals')).text();
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('finalBody');
    // It says where the editing happens instead.
    expect(html).toContain('helpdesk');
  });

  // A malformed id is a path nobody has, not a fault. `run_id` is a `uuid`
  // column, so without a shape check Postgres raises and the route answers
  // 500 — spending a pool connection on an endpoint that authenticates
  // nobody, and contradicting its own 404 contract.
  it('answers 404 for an id that is not a run id, without reaching the ledger', async () => {
    const readRun = vi.fn();
    const base = await startGuarded(deps({ readRun }));
    // The last three are the discriminating ones: all hex-and-hyphen, at
    // least six characters, so a character-class check accepts them and the
    // `uuid` column still raises. The shape has to be a UUID.
    for (const bad of [
      'abc', 'not-a-uuid', '1', '%41',
      '------', 'deadbeefcafe', '4f1c2b8e-9d3a-4e77-b0d1-6a5c8e2f1b3',
    ]) {
      const res = await fetch(`${base}/run/${bad}`);
      expect(res.status).toBe(404);
    }
    expect(readRun).not.toHaveBeenCalled();
  });

  // What a person needs to decide, rather than an id and a button (DEC-12).
  it('shows the ticket, the state and the reason on the approval queue', async () => {
    const base = await startGuarded(deps());
    const html = await (await fetch(base + '/approvals')).text();
    expect(html).toContain('SYN-1');
    expect(html).toContain('awaiting_approval');
  });

  it('offers no approve form for a run with no parked draft', async () => {
    const base = await startGuarded(deps({
      listApprovals: async () => [{
        runId: RUN, ticketId: 'SYN-1', state: 'awaiting_approval', promptVer: 'p1',
        reason: null, stepsUsed: 4,
        agreement: 0.89, coverage: 0.94, draftExternalId: null,
      }],
    }));
    const html = await (await fetch(base + '/approvals')).text();
    expect(html).not.toContain('<form');
    expect(html).toContain('No draft is parked');
  });
});


// The two attacks a review reproduced against the first version of this
// server. Both returned success then: a cross-site POST was approved, and a
// request carrying an attacker's Host was answered.
//
// Neither is stopped by binding to loopback, which is what the runbook
// claimed. The approval sends a customer reply and a sent reply cannot be
// recalled (DEC-12, DEC-14), so these are the cases that matter most here.
describe('the console against a page it did not serve', () => {
  it('refuses a cross-site approval', async () => {
    const approve = vi.fn().mockResolvedValue('approved');
    const base = await startGuarded(deps({ approve }));
    const res = await fetch(`${base}/approve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'cross-site',
        origin: 'https://evil.example',
      },
      body: new URLSearchParams({ runId: RUN }).toString(),
      redirect: 'manual',
    });
    expect(res.status).toBe(403);
    // The point: no reply was sent.
    expect(approve).not.toHaveBeenCalled();
  });

  it('refuses a form post whose Origin is another site', async () => {
    const approve = vi.fn().mockResolvedValue('approved');
    const base = await startGuarded(deps({ approve }));
    const res = await fetch(`${base}/approve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://evil.example',
      },
      body: new URLSearchParams({ runId: RUN }).toString(),
      redirect: 'manual',
    });
    expect(res.status).toBe(403);
    expect(approve).not.toHaveBeenCalled();
  });

  // `none` is what a browser sends for a typed address or a bookmark. A form
  // post is never that, so the value that a cross-site page cannot forge must
  // not be the value that lets one through.
  it('refuses an approval that claims to be a typed address', async () => {
    const approve = vi.fn().mockResolvedValue('approved');
    const base = await startGuarded(deps({ approve }));
    const res = await fetch(`${base}/approve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'none',
      },
      body: new URLSearchParams({ runId: RUN }).toString(),
      redirect: 'manual',
    });
    expect(res.status).toBe(403);
    expect(approve).not.toHaveBeenCalled();
  });

  // And a post carrying no signal at all. A read gets the benefit of the
  // doubt, because a `curl` of the runs list harms nothing. The write does
  // not, because it sends a reply that cannot be recalled.
  it('refuses an approval that carries no origin signal at all', async () => {
    const approve = vi.fn().mockResolvedValue('approved');
    const base = await startGuarded(deps({ approve }));
    const res = await fetch(`${base}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ runId: RUN }).toString(),
      redirect: 'manual',
    });
    expect(res.status).toBe(403);
    expect(approve).not.toHaveBeenCalled();
    // The same client reading is answered, so the rule is about the write.
    expect((await fetch(base + '/')).status).toBe(200);
  });

  // The older browser path stays open: no `Sec-Fetch-Site`, and an `Origin`
  // this console answers to.
  it('accepts an approval whose Origin is its own', async () => {
    const approve = vi.fn().mockResolvedValue('approved');
    const base = await startGuarded(deps({ approve }));
    const res = await fetch(`${base}/approve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: base,
      },
      body: new URLSearchParams({ runId: RUN }).toString(),
      redirect: 'manual',
    });
    expect(res.status).toBe(303);
    expect(approve).toHaveBeenCalledWith(RUN, undefined);
  });

  // Framing is the way a foreign page reaches the write without forging any
  // header. It frames this console, lures the operator's click onto the real
  // Approve button, and the form that submits is the console's own: the
  // `Host` is allowed and `Sec-Fetch-Site` is genuinely `same-origin`, so
  // `sameOrigin` cannot tell the difference. Refusing the frame is what
  // stops it, and an unrecallable reply is what it costs (DEC-12, DEC-14).
  it('refuses to be framed, on a page and on the approval redirect', async () => {
    const approve = vi.fn().mockResolvedValue('approved');
    const base = await startGuarded(deps({ approve }));

    const pageRes = await fetch(base + '/approvals');
    expect(pageRes.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(pageRes.headers.get('x-frame-options')).toBe('DENY');
    // Live ledger rows are not for a cache, and the run id travels in the
    // path, so it is not for a referrer either.
    expect(pageRes.headers.get('cache-control')).toBe('no-store');
    expect(pageRes.headers.get('referrer-policy')).toBe('no-referrer');
    expect(pageRes.headers.get('x-content-type-options')).toBe('nosniff');

    // The 303 writes its own head, so it is asserted separately: a redirect
    // that dropped them would be the one response a frame could still use.
    const post = await fetch(`${base}/approve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'same-origin',
      },
      body: new URLSearchParams({ runId: RUN }).toString(),
      redirect: 'manual',
    });
    expect(post.status).toBe(303);
    expect(post.headers.get('x-frame-options')).toBe('DENY');
    expect(post.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });

  // DNS rebinding: the attacker's name resolves to loopback, so the browser
  // holds a same-origin handle and the unguessable run id stops nothing. The
  // Host header is what gives it away.
  it('refuses a request carrying a Host it does not answer to', async () => {
    await startGuarded(deps());
    // `fetch` refuses to set Host — it is a forbidden header there, and an
    // override is dropped in silence, so this case passed against a server
    // with no check at all. A rebinding attacker's browser sets it for them,
    // so the request has to be made the way the browser would.
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: allowedPort, path: '/', method: 'GET',
          headers: { host: 'attacker.example' } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  // A console behind an authenticating proxy answers the proxy and nobody
  // else. The allowlist used to add the proxy's name to the derived loopback
  // names rather than replacing them, so a request that reached the port
  // directly passed by claiming to be loopback — and the approval behind it
  // sends a customer reply that cannot be recalled (DEC-12, DEC-14).
  it('refuses a direct approval once the operator names a proxy', async () => {
    const approved: string[] = [];
    await startGuarded(
      deps({ approve: async (runId: string) => { approved.push(runId); return 'approved'; } }),
      // Named the way an operator names it, and turned into a host set by
      // `allowedHosts` itself, so this case fails if that list ever goes back
      // to adding the loopback names beside the proxy.
      'console.internal.example',
    );
    // Host set through `node:http`, because `fetch` drops it in silence and
    // the case would pass against a server with no check at all.
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: allowedPort, path: '/approve', method: 'POST',
          headers: {
            host: `localhost:${allowedPort}`,
            'sec-fetch-site': 'same-origin',
            'content-type': 'application/x-www-form-urlencoded',
          } },
        (res) => { res.resume(); resolve(res.statusCode ?? 0); },
      );
      req.on('error', reject);
      req.end(`runId=${RUN}`);
    });
    expect(status).toBe(403);
    expect(approved).toEqual([]);
  });

  it('serves its own host', async () => {
    const base = await startGuarded(deps());
    expect((await fetch(base + '/')).status).toBe(200);
    expect((await fetch(`http://localhost:${allowedPort}/`)).status).toBe(200);
  });
});

describe('what a fault and a refusal tell the operator', () => {
  // Every other read on this console is held to one question: may a
  // customer's words reach an unauthenticated surface. The journal reader
  // withholds the draft and the fault message; an escalation reason is
  // trimmed at its first colon. The 500 page had no such trimming, and
  // `error.message` carries whatever a driver or an adapter was handed.
  it('puts a tag on the page and the reason in the log', async () => {
    const secret = 'ada@customer.example wrote this';
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
    try {
      const base = await startGuarded(deps({
        listRuns: async () => { throw new Error(secret); },
      }));
      const res = await fetch(base + '/');
      const html = await res.text();
      expect(res.status).toBe(500);
      expect(html).not.toContain('ada@customer.example');
      expect(html).toMatch(/console log names it [0-9a-f]{8}/);
      // The operator can still find it, because they read the log already.
      expect(logged.join('\n')).toContain(secret);
    } finally {
      spy.mockRestore();
    }
  });

  it('carries what caused a wrapped fault into the log', async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
    try {
      const base = await startGuarded(deps({
        listRuns: async () => {
          throw new Error('the ledger read failed', { cause: new Error('connection refused') });
        },
      }));
      await fetch(base + '/');
      expect(logged.join('\n')).toContain('connection refused');
    } finally {
      spy.mockRestore();
    }
  });

  // Refused, not failed. It used to reach the catch-all and answer 500 with
  // the bound's own sentence, which reports the console as broken by a
  // request it correctly declined.
  it('answers an oversized approval form with a refusal', async () => {
    const approved: string[] = [];
    const base = await startGuarded(deps({
      approve: async (runId: string) => { approved.push(runId); return 'approved'; },
    }));
    const res = await fetch(base + '/approve', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'same-origin',
      },
      body: `runId=${RUN}&pad=${'x'.repeat(70 * 1024)}`,
    });
    expect(res.status).toBe(413);
    expect(approved).toEqual([]);
  });

  // The one write this console makes was the only request it did not record.
  // The ledger journals that a run was approved and never which client asked,
  // and reaching this console is the whole access control.
  it('records the approval it made, and where it came from', async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
    try {
      const base = await startGuarded(deps({ approve: async () => 'approved' }));
      await fetch(base + '/approve', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'sec-fetch-site': 'same-origin',
        },
        body: `runId=${RUN}`,
        redirect: 'manual' as const,
      });
      const line = logged.find((entry) => entry.includes('console_approved'));
      expect(line).toBeDefined();
      const record = JSON.parse(line ?? '{}') as Record<string, unknown>;
      expect(record['runId']).toBe(RUN);
      expect(record['outcome']).toBe('approved');
      expect(record['from']).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the reply an approver reads before they send it', () => {
  // DEC-40 permits this console to approve a parked draft. It drew the button
  // above a reply the approver could not read, which is the defect this whole
  // surface exists to fix.
  it('shows the drafted reply on the approval queue', async () => {
    const base = await startGuarded(deps());
    const html = await (await fetch(base + '/approvals')).text();
    expect(html).toContain('The reply, as the system drafted it');
    expect(html).toContain('We refunded the duplicate charge.');
  });

  it('shows the same reply on the run detail, from the same builder', async () => {
    const base = await startGuarded(deps());
    const detail = await (await fetch(`${base}/run/${RUN}`)).text();
    const queue = await (await fetch(base + '/approvals')).text();
    for (const claim of [
      'We refunded the duplicate charge.',
      'Your bank decides when it lands.',
      'Your subscription is unchanged.',
    ]) {
      expect(detail, 'run detail').toContain(claim);
      expect(queue, 'approval queue').toContain(claim);
    }
  });

  // Three states, and each is a different fact. A claim nobody judged is not
  // a claim the judge refused, and drawing it as one would put a warning on a
  // run the ledger never questioned.
  it('marks a refused claim, and does not mark an unjudged one as refused', async () => {
    const base = await startGuarded(deps());
    const html = await (await fetch(base + '/approvals')).text();
    expect(html.match(/class="claim unsupported"/g) ?? []).toHaveLength(1);
    expect(html.match(/class="claim unread"/g) ?? []).toHaveLength(1);
    // The supported one carries no mark at all.
    expect(html.match(/class="claim"/g) ?? []).toHaveLength(1);
  });

  // Deliberately not a fraction. The gate row's coverage is what the policy
  // engine read, and a second number computed from these marks would be a
  // recount that can disagree with it.
  it('counts the claims to look at rather than recomputing coverage', async () => {
    const base = await startGuarded(deps());
    const html = await (await fetch(base + '/approvals')).text();
    expect(html).toContain('1 of 3 claims cite a document that does not support them');
    // 0.333 is what a recount of these marks would produce.
    expect(html).not.toContain('0.333');
    expect(html).not.toContain('0.667');
  });

  it('links each claim to the document it cites', async () => {
    const base = await startGuarded(deps());
    const html = await (await fetch(base + '/approvals')).text();
    expect(html).toContain('href="#src-SYN-DOC-01"');
    expect(html).toContain('id="src-SYN-DOC-01"');
    expect(html).toContain('The documents these claims cite');
    // And each source opens.
    expect(html).toContain('href="/document/SYN-DOC-01"');
  });

  it('says a cited document is gone rather than printing its id as a title', async () => {
    const base = await startGuarded(deps());
    const html = await (await fetch(base + '/approvals')).text();
    expect(html).toContain('no such document today');
  });

  // The relay sends the helpdesk copy, which a person may have edited since
  // (DEC-11). "as the system drafted it" is the honest heading, and the
  // warning beside the button says which copy goes out.
  it('does not claim the drafted reply is what will be sent', async () => {
    const base = await startGuarded(deps());
    const html = await (await fetch(base + '/approvals')).text();
    expect(html).not.toContain('The reply as it will be sent');
    expect(html).toContain('a person may have changed it since');
  });

  it('offers no approve button for a run with no parked draft', async () => {
    const base = await startGuarded(deps({
      listApprovals: async () => [{
        runId: RUN, ticketId: 'SYN-1', state: 'awaiting_approval', promptVer: 'p1',
        reason: 'irreversible', stepsUsed: 4,
        agreement: 0.89, coverage: 0.94, draftExternalId: null,
      }],
    }));
    const html = await (await fetch(base + '/approvals')).text();
    expect(html).toContain('No draft is parked');
    expect(html).not.toContain('>Approve<');
  });

  // The queue is uncapped by design, so a journal read per row would be one
  // statement for every run of a list that has been 476 long.
  it('reads the journal for the drawn selection alone', async () => {
    const read: string[] = [];
    const base = await startGuarded(deps({
      readApprovalEvidence: async (runId: string) => {
        read.push(runId);
        return {
          evidence: EVIDENCE,
          gates: {
            agreement: 0.89, coverage: 0.94, agreementThreshold: 0.6,
            agreementDetail: '8 of 9 samples', coverageBlock: 0.7, coverageReview: 0.8,
          },
        };
      },
    }));
    await fetch(base + '/approvals');
    expect(read).toHaveLength(1);
  });
});

describe('the evidence states that are not a list of claims', () => {
  const bare = {
    runId: RUN, ticketId: 'SYN-1', state: 'awaiting_approval', promptVer: 'p1',
    reason: 'customer_visible', stepsUsed: 4,
    agreement: 0.89, coverage: 0.94, draftExternalId: 'D-1',
  };

  async function queueWith(evidence: unknown): Promise<string> {
    const base = await startGuarded(deps({
      listApprovals: async () => [bare],
      readApprovalEvidence: async () => ({
        evidence,
        gates: {
          agreement: 0.89, coverage: 0.94, agreementThreshold: 0.6,
          agreementDetail: '8 of 9 samples', coverageBlock: 0.7, coverageReview: 0.8,
        },
      }) as never,
    }));
    return (await fetch(base + '/approvals')).text();
  }

  // An unmeasured count is never a zero. With no retrieval journalled the
  // denominator was invented from an absence, and every cited document was
  // labelled gone — a positive claim about an index nothing was compared to.
  it('does not invent a retrieved count from a retrieval it does not have', async () => {
    const html = await queueWith({
      draftBody: 'a reply', documentsMalformed: false, documents: null,
      claims: [{ index: 0, text: 'a claim', docId: 'SYN-DOC-01', supported: true }],
    });
    expect(html).toContain('no retrieval journalled');
    expect(html).not.toContain('of 0 retrieved');
    expect(html).not.toContain('no such document today');
  });

  it('separates a retrieval it could not read from one that never happened', async () => {
    const html = await queueWith({
      draftBody: 'a reply', documentsMalformed: true, documents: null,
      claims: [{ index: 0, text: 'a claim', docId: 'SYN-DOC-01', supported: true }],
    });
    expect(html).toContain('could not be read');
  });

  // Two different facts, and the more alarming one used to render as the
  // other: a reply citing a document the retriever never returned.
  it('separates a document that left the index from one never retrieved', async () => {
    const html = await queueWith({
      draftBody: 'a reply', documentsMalformed: false,
      documents: [{
        position: 1, docId: 'SYN-DOC-01', title: null, kind: null, owner: null,
        bodyUnchanged: null, titleAtRun: null,
      }],
      claims: [
        { index: 0, text: 'cites a gone document', docId: 'SYN-DOC-01', supported: true },
        { index: 1, text: 'cites one never retrieved', docId: 'SYN-DOC-77', supported: true },
      ],
    });
    expect(html).toContain('no such document today');
    expect(html).toContain('not among the documents this run retrieved');
    // The counts are two facts, so the fraction that could invert is gone.
    expect(html).toContain('2 cited · 1 retrieved');
  });

  // A recorded list with nothing in it. Drawing an empty prose block and then
  // saying every claim was accepted would vouch for a reply making no claims.
  it('names a claim list holding no claims, rather than vouching for it', async () => {
    const html = await queueWith({
      draftBody: 'a reply', documentsMalformed: false, documents: [], claims: [],
    });
    expect(html).toContain('claim list with no claims in it');
    expect(html).not.toContain('every claim of 0');
  });

  // Both counts, independently. A ladder reported the unread claims only when
  // nothing was refused, so a reply with one of each said nothing at all
  // about the claim nobody judged.
  it('reports a refused claim and an unjudged one in the same sentence', async () => {
    const html = await queueWith({
      draftBody: 'a reply', documentsMalformed: false, documents: [],
      claims: [
        { index: 0, text: 'accepted', docId: 'SYN-DOC-01', supported: true },
        { index: 1, text: 'refused', docId: 'SYN-DOC-01', supported: false },
        { index: 2, text: 'unjudged', docId: 'SYN-DOC-01', supported: null },
      ],
    });
    expect(html).toContain('1 of 3 claims cite a document that does not support them');
    expect(html).toContain('1 of 3 carry no recorded verdict');
  });
});

describe('the conversation a responder reads', () => {
  it('draws each turn, and what the customer wrote', async () => {
    const base = await startGuarded(deps());
    const html = await (await fetch(`${base}/conversation/${CONVERSATION}`)).text();
    expect(html).toContain('There are two charges for the same month.');
    expect(html).toContain('the customer wrote');
    expect(html).toContain('the system replied');
  });

  // Six absences exist and each sends a responder somewhere different, so a
  // surface that rendered two alike would be worse than one that rendered
  // nothing.
  it('names an absence rather than drawing a blank turn', async () => {
    const base = await startGuarded(deps());
    const html = await (await fetch(`${base}/conversation/${CONVERSATION}`)).text();
    expect(html).toContain('the text of this message was not kept');
    expect(html).toContain('a reply is drafted and waiting for a person');
  });

  it('says a participant is named without naming them', async () => {
    const base = await startGuarded(deps());
    const html = await (await fetch(`${base}/conversation/${CONVERSATION}`)).text();
    expect(html).toContain('participant named');
    // Not an escaping claim: `ThreadView` carries no address at all, so no
    // input to this surface could produce one. The guard belongs where the
    // address is actually dropped, which is `readConversation`'s own mapping
    // in `main.ts`, and `conversation.db.test.ts` holds it there.
  });

  it('answers 404 for a conversation the ledger does not hold, and for a bad id', async () => {
    const base = await startGuarded(deps({ readConversation: async () => null }));
    expect((await fetch(`${base}/conversation/${CONVERSATION}`)).status).toBe(404);
    // Shape checked before the ledger is asked: the column is uuid.
    const asked: string[] = [];
    const guarded = await startGuarded(deps({
      readConversation: async (id: string) => { asked.push(id); return null; },
    }));
    expect((await fetch(`${guarded}/conversation/not-a-uuid`)).status).toBe(404);
    expect(asked).toEqual([]);
  });
});

describe('the document behind a citation', () => {
  it('shows what the document says today', async () => {
    const base = await startGuarded(deps());
    const html = await (await fetch(base + '/document/SYN-DOC-01')).text();
    expect(html).toContain('A charge is refundable inside fourteen days.');
    expect(html).toContain('rewritten in place on reindex');
  });

  // DEC-23. A claim resting on a document past its review date is a claim
  // resting on text nobody has checked.
  it('says whether the document is still inside its review window', async () => {
    const fresh = await startGuarded(deps());
    expect(await (await fetch(fresh + '/document/SYN-DOC-01')).text())
      .toContain('in review until 2030-01-01');
    const stale = await startGuarded(deps({
      readDocument: async () => ({
        docId: 'SYN-OLD', kind: 'document', title: 'Old policy', body: 'text',
        owner: 'support', reviewBy: '2020-01-01', fresh: false,
      }),
    }));
    expect(await (await fetch(stale + '/document/SYN-OLD')).text())
      .toContain('review date passed 2020-01-01');
  });

  it('answers 404 for a document the index no longer holds', async () => {
    const base = await startGuarded(deps({ readDocument: async () => null }));
    expect((await fetch(base + '/document/SYN-GONE')).status).toBe(404);
  });

  it('refuses an unbounded id rather than asking the ledger about it', async () => {
    const asked: string[] = [];
    const base = await startGuarded(deps({
      readDocument: async (id: string) => { asked.push(id); return null; },
    }));
    expect((await fetch(`${base}/document/${'x'.repeat(300)}`)).status).toBe(404);
    expect(asked).toEqual([]);
  });
});

describe('the one script this console ships', () => {
  // A hash permits this exact text and nothing else. `unsafe-inline` would
  // permit any inline script, including one injected into a page.
  it('is pinned by a hash of its own text, not by unsafe-inline', async () => {
    const base = await startGuarded(deps());
    const res = await fetch(base + '/approvals');
    const policy = res.headers.get('content-security-policy') ?? '';
    const declared = /script-src '([^']*)'/.exec(policy)?.[1] ?? '';
    // Scoped to scripts. `style-src` keeps `unsafe-inline`, because the
    // surfaces carry inline style attributes for colour-by-verdict, and a
    // stylesheet cannot execute.
    expect(declared).not.toContain('unsafe-inline');
    expect(declared).not.toContain('unsafe-eval');
    expect(declared).toMatch(/^sha256-/);

    const html = await res.text();
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
    expect(script.length).toBeGreaterThan(0);
    const digest = `sha256-${createHash('sha256').update(script, 'utf8').digest('base64')}`;
    // The browser computes this over the element's contents. If the two ever
    // disagree the script silently stops running, and the page keeps working
    // while its highlighting quietly does not.
    expect(digest).toBe(declared);
  });

  it('ships exactly one, on every surface', async () => {
    const base = await startGuarded(deps());
    for (const path of ['/', `/run/${RUN}`, '/approvals', '/bands', '/latency']) {
      const html = await (await fetch(base + path)).text();
      expect(html.split('<script>'), path).toHaveLength(2);
    }
  });
});

describe('who the ledger records as the approver', () => {
  async function approveWith(
    options: { identityHeader?: string; hosts?: string },
    headers: Record<string, string>,
  ): Promise<(string | undefined)[]> {
    const calls: (string | undefined)[] = [];
    const base = await startGuarded(
      deps({
        approve: async (runId: string, approvedBy: string | undefined) => {
          calls.push(approvedBy);
          return 'approved';
        },
      }),
      options.hosts,
      options.identityHeader,
    );
    await fetch(base + '/approve', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'same-origin',
        ...headers,
      },
      body: `runId=${RUN}`,
      redirect: 'manual',
    });
    return calls;
  }

  // DEC-42. Both conditions are necessary. The operator names the header,
  // because a console cannot guess which of its request headers a proxy
  // controls. And the operator names the hosts, because that is what says a
  // proxy is in front at all.
  it('takes the header a trusted proxy set, once the operator names it', async () => {
    expect(await approveWith(
      { identityHeader: 'x-forwarded-user' },
      { 'x-forwarded-user': 'ops-oncall' },
    )).toEqual(['ops-oncall']);
  });

  it('sends nothing when the operator named no header', async () => {
    expect(await approveWith({}, { 'x-forwarded-user': 'ops-oncall' })).toEqual([undefined]);
  });

  // The loopback case is `hosts.test.ts`'s subject, because the rule lives
  // in `identityHeader()`: this server reads whatever header its caller named,
  // and the caller is what decides whether a proxy is in front.

  // Node joins a repeated header with a comma; only `set-cookie` arrives as
  // an array. So two headers reached the ledger as one name, and a check for
  // an array was dead code. A proxy that appends rather than replaces makes
  // exactly this, which is the forgeable trail DEC-42 refuses.
  it('names nobody when the header arrived more than once', async () => {
    const calls: (string | undefined)[] = [];
    const base = await startGuarded(
      deps({
        approve: async (runId: string, approvedBy: string | undefined) => {
          calls.push(approvedBy);
          return 'approved';
        },
      }),
      undefined,
      'x-forwarded-user',
    );
    const port = Number(new URL(base).port);
    // Through `node:http`, because `fetch` will not send one header twice.
    await new Promise<void>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1', port, path: '/approve', method: 'POST',
          headers: {
            host: `127.0.0.1:${port}`,
            'sec-fetch-site': 'same-origin',
            'content-type': 'application/x-www-form-urlencoded',
            'x-forwarded-user': ['ops-oncall', 'mallory'],
          },
        },
        (res) => { res.resume(); res.on('end', resolve); },
      );
      req.on('error', reject);
      req.end(`runId=${RUN}`);
    });
    expect(calls).toEqual([undefined]);
  });

  it('names nobody when one value carries a comma, which it cannot read apart', async () => {
    expect(await approveWith(
      { identityHeader: 'x-forwarded-user' },
      { 'x-forwarded-user': 'ops-oncall, mallory' },
    )).toEqual([undefined]);
  });

  it('sends nothing when the named header is absent or empty', async () => {
    expect(await approveWith(
      { identityHeader: 'x-forwarded-user' },
      {},
    )).toEqual([undefined]);
    expect(await approveWith(
      { identityHeader: 'x-forwarded-user' },
      { 'x-forwarded-user': '' },
    )).toEqual([undefined]);
  });

  // The header, never the form. A name anyone can type into a page is not an
  // audit trail, and the route reads only `runId` from the body.
  it('never takes the approver from the form', async () => {
    const calls: (string | undefined)[] = [];
    const base = await startGuarded(
      deps({
        approve: async (runId: string, approvedBy: string | undefined) => {
          calls.push(approvedBy);
          return 'approved';
        },
      }),
      'console.internal.example',
      'x-forwarded-user',
    );
    await fetch(base + '/approve', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'same-origin',
        host: 'console.internal.example',
      },
      body: new URLSearchParams({ runId: RUN, approvedBy: 'typed-by-anyone' }).toString(),
      redirect: 'manual',
    });
    expect(calls).toEqual([undefined]);
  });
});

describe('the state filter', () => {
  // The filter is a query parameter rather than a client-side hide, and the
  // reason is the cap. `listRuns` reads at most a page, so hiding rows after
  // the read would show the gated runs that happen to fall inside the newest
  // 200 and label them the gated runs.
  it('asks the ledger for one state, rather than filtering a page after it', async () => {
    const asked: string[][] = [];
    const base = await startGuarded(deps({
      listRuns: async (states) => {
        asked.push([...states]);
        return [];
      },
    }));
    await fetch(`${base}/?state=gated`);
    expect(asked).toEqual([['gated']]);
  });

  it('asks for every state when no state is named', async () => {
    const asked: string[][] = [];
    const base = await startGuarded(deps({
      listRuns: async (states) => {
        asked.push([...states]);
        return [];
      },
    }));
    await fetch(base + '/');
    expect(asked).toEqual([[...STATES]]);
  });

  // Never widened to every state. Answering a question the operator did not
  // ask, under a heading saying they did, is the failure this refuses.
  it('answers 404 for a state the ledger has no such thing as', async () => {
    let reached = false;
    const base = await startGuarded(deps({
      listRuns: async () => {
        reached = true;
        return [];
      },
    }));
    const res = await fetch(`${base}/?state=made_up`);
    expect(res.status).toBe(404);
    expect(reached).toBe(false);
  });

  it('offers every state as a link, including the ones holding nothing today', async () => {
    const base = await startGuarded(deps({ listRuns: async () => [] }));
    const html = await (await fetch(base + '/')).text();
    for (const state of STATES) expect(html, state).toContain(`/?state=${state}`);
  });

  // An empty page that says nothing reads as a console that failed.
  it('names the state when that state holds no run', async () => {
    const base = await startGuarded(deps({ listRuns: async () => [] }));
    const html = await (await fetch(`${base}/?state=gated`)).text();
    expect(html).toContain('gated');
  });
});

describe('the theme', () => {
  it('is dark with no cookie, and the page says which it rendered', async () => {
    const base = await startGuarded(deps());
    const html = await (await fetch(base + '/')).text();
    expect(html).toContain('data-theme="dark"');
  });

  it('is light when the cookie says so', async () => {
    const base = await startGuarded(deps());
    const html = await (await fetch(base + '/', {
      headers: { cookie: 'theme=light' },
    })).text();
    expect(html).toContain('data-theme="light"');
  });

  // A cookie header holds several pairs, and a substring test for `light`
  // would also match a cookie some proxy named `highlight` on the same host.
  it('reads its own cookie and not one whose name merely ends the same way', async () => {
    const base = await startGuarded(deps());
    const html = await (await fetch(base + '/', {
      headers: { cookie: 'highlight=light; other=1' },
    })).text();
    expect(html).toContain('data-theme="dark"');
  });

  it('sets the cookie and returns to the surface the operator was reading', async () => {
    const base = await startGuarded(deps());
    const res = await fetch(`${base}/theme?to=light&back=%2Fbands`, { redirect: 'manual' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/bands');
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('theme=light');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('HttpOnly');
  });

  // Without the allowlist this is an open redirect on a host an operator
  // trusts, and it would carry them off a console that approves replies.
  it('refuses to return anywhere but its own surfaces', async () => {
    const base = await startGuarded(deps());
    for (const back of [
      'https://evil.example',
      '//evil.example',
      '/../../etc',
      'javascript:alert(1)',
    ]) {
      const res = await fetch(
        `${base}/theme?to=dark&back=${encodeURIComponent(back)}`,
        { redirect: 'manual' },
      );
      expect(res.headers.get('location'), back).toBe('/');
    }
  });

  it('returns to a run detail, which is the one surface that is not a fixed path', async () => {
    const base = await startGuarded(deps());
    const res = await fetch(
      `${base}/theme?to=dark&back=${encodeURIComponent(`/run/${RUN}`)}`,
      { redirect: 'manual' },
    );
    expect(res.headers.get('location')).toBe(`/run/${RUN}`);
  });

  it('answers 404 for a theme it does not have, rather than setting it', async () => {
    const base = await startGuarded(deps());
    const res = await fetch(`${base}/theme?to=neon`, { redirect: 'manual' });
    expect(res.status).toBe(404);
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});

describe('what a refused request is told', () => {
  // The rail names the ledger this console is bound to. A refused request is
  // exactly the one that should not be told which database it reached.
  it('names no ledger and draws no rail', async () => {
    await startGuarded(deps());
    // Through `request`, not `fetch`. Host is a forbidden header there and an
    // override is dropped in silence, so the same case written with `fetch`
    // asserts a 200 page against the allowed host and passes while proving
    // nothing — which is the trap the rebinding case above already names.
    const { status, body } = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const req = request(
          { host: '127.0.0.1', port: allowedPort, path: '/', method: 'GET',
            headers: { host: 'attacker.example' } },
          (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => { text += chunk; });
            res.on('end', () => { resolve({ status: res.statusCode ?? 0, body: text }); });
          },
        );
        req.on('error', reject);
        req.end();
      },
    );
    expect(status).toBe(403);
    expect(body).not.toContain(LEDGER);
    expect(body).not.toContain('class="rail"');
  });
});

describe('the approval queue', () => {
  const RUN_B = '8a2d4c6e-1f3b-4a90-9c7e-2d5b8f0a1c34';
  const waiting = [
    {
      runId: RUN, ticketId: 'SYN-1', state: 'awaiting_approval', promptVer: 'p1',
      reason: 'customer_visible', stepsUsed: 4,
      agreement: 0.89, coverage: 0.94, draftExternalId: 'D-1',
    },
    {
      runId: RUN_B, ticketId: 'SYN-2', state: 'awaiting_approval', promptVer: 'p1',
      reason: 'customer_visible', stepsUsed: 4,
      agreement: 0.71, coverage: 0.83, draftExternalId: 'D-2',
    },
  ];

  // The queue is uncapped on purpose, and a card for every row of it made the
  // page as long as the backlog: a 476-run queue rendered 8 MB that repeated
  // the list beside itself.
  it('lists everything waiting and draws one of them', async () => {
    const base = await startGuarded(deps({ listApprovals: async () => waiting }));
    const html = await (await fetch(base + '/approvals')).text();
    // Both are on the list.
    expect(html).toContain('SYN-1');
    expect(html).toContain('SYN-2');
    // Only the first has a card, so only its draft handle and its own
    // Approve button are on the page.
    expect(html).toContain('D-1');
    expect(html).not.toContain('D-2');
    expect(html.match(/type="submit"/g)).toHaveLength(1);
  });

  it('draws the run the query string names', async () => {
    const base = await startGuarded(deps({ listApprovals: async () => waiting }));
    const html = await (await fetch(`${base}/approvals?run=${RUN_B}`)).text();
    expect(html).toContain('D-2');
    expect(html).not.toContain('D-1');
    // And the list marks the one being shown, rather than marking whichever
    // row happens to be first. Asserted as the mark on that row's own link,
    // so a version that marked every row would fail the count below.
    expect(html).toContain(`class="item on" href="/approvals?run=${RUN_B}"`);
    expect(html.match(/class="item on"/g)).toHaveLength(1);
  });

  // A stale link is still an operator who came here to work the queue.
  it('falls back to the head of the queue for a run that is not waiting', async () => {
    const base = await startGuarded(deps({ listApprovals: async () => waiting }));
    const gone = '00000000-0000-4000-8000-000000000000';
    const html = await (await fetch(`${base}/approvals?run=${gone}`)).text();
    expect(html).toContain('D-1');
  });

  it('never compares a run id it has not checked the shape of', async () => {
    const base = await startGuarded(deps({ listApprovals: async () => waiting }));
    const res = await fetch(`${base}/approvals?run=${encodeURIComponent('<script>')}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // The page ships exactly one script, and it is the pinned one. So this
    // asks that the query string did not add a second, rather than that the
    // page has none — which stopped being true when the console gained its
    // claim-to-source highlighting.
    expect(html.split('<script>')).toHaveLength(2);
    // The value never reaches the page: `selected` is null unless it has the
    // shape of a run id, and it is only ever compared. So the escaping claim
    // this case used to make was a claim about a value nothing rendered — and
    // its assertion named a substring the input did not contain either way.
    // What is worth holding is that the comparison happened and drew the head
    // of the queue rather than an empty pane.
    expect(html).toContain('SYN-1');
    expect(html).toContain('D-1');
  });
});
