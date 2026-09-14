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

import { escapeHtml } from './render.js';

import { allowedHosts } from './hosts.js';
import { createConsole } from './server.js';
import type { ConsoleDeps } from './server.js';

const RUN = '4f1c2b8e-9d3a-4e77-b0d1-6a5c8e2f1b34';

const CONVERSATION = '99999999-8888-4777-8666-555555555555';

/** The message the drawn run answered, which an approver reads first. */
const REQUEST = {
  conversationId: CONVERSATION,
  turnNumber: 1,
  bodyText: 'There are two charges for the same month.',
  absence: null,
};

/**
 * One drafted reply, its claims and their sources.
 *
 * Three claims on purpose: one the judge supported, one it refused, and one
 * with no verdict. Those are three different facts and the surface has to
 * draw them apart — a claim nobody judged is not a claim the judge refused.
 */
const EVIDENCE = {
  draftBody: 'We refunded the duplicate charge. Your bank decides when it lands.',
  // No courtesy sentence in this one, so the partition is the claims. DEC-43
  // makes both ends optional, and this fixture is the reply that takes
  // neither.
  sentences: [
    {
      text: 'We refunded the duplicate charge.',
      docId: 'SYN-DOC-01', claimIndex: 0, supported: true,
    },
    {
      text: 'Your bank decides when it lands.',
      docId: 'SYN-DOC-01', claimIndex: 1, supported: false,
    },
    {
      text: 'Your subscription is unchanged.',
      docId: 'SYN-DOC-99', claimIndex: 2, supported: null,
    },
  ],
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

/**
 * The queue-row fields every run now carries, so a case states only what it
 * is about.
 *
 * A real date rather than null: the surfaces order by time and print an age,
 * and a fixture that never carried one would leave that unrendered in every
 * case here. A case about time overrides it.
 */
const ROW = {
  gateReason: 'customer_visible',
  intentId: 'refund-request',
  gateCoverage: 0.94,
  createdAt: new Date('2026-09-07T09:00:00.000Z'),
  payloadRecorded: false,
  actionClass: 'customer_reply',
  delivery: 'at_least_once',
  payload: null,
} as const;

function deps(overrides: Partial<ConsoleDeps> = {}): ConsoleDeps {
  return {
    listRuns: async () => [
      { runId: RUN, ticketId: 'SYN-1', state: 'resolved', promptVer: 'p1', ...ROW, reason: null, stepsUsed: 4 },
    ],
    readRun: async () => ({
      runId: RUN, ticketId: 'SYN-1', state: 'awaiting_approval', promptVer: 'p1', ...ROW,
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
      request: REQUEST,
    }),
    listApprovals: async () => [{
      runId: RUN, ticketId: 'SYN-1', state: 'awaiting_approval', promptVer: 'p1', ...ROW,
      reason: 'customer_visible', stepsUsed: 4,
      agreement: 0.89, coverage: 0.94, draftExternalId: 'D-1',
    }],
    readApprovalEvidence: async () => ({
      request: REQUEST,
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
      // exclusivity of the allowlist is `hosts.test.ts`'s subject. The hosts
      // do not gate the identity header; only `identityHeader` does.
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

  it('offers no approve form for a run that parked nothing at all', async () => {
    const base = await startGuarded(deps({
      listApprovals: async () => [{
        runId: RUN, ticketId: 'SYN-1', state: 'awaiting_approval', promptVer: 'p1', ...ROW,
        reason: null, stepsUsed: 4,
        agreement: 0.89, coverage: 0.94, draftExternalId: null, payloadRecorded: false,
      }],
    }));
    const html = await (await fetch(base + '/approvals')).text();
    expect(html).not.toContain('<form');
    expect(html).toContain('neither a helpdesk draft nor an action payload');
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

  // Two refusals share the event name, so each says which rule refused.
  it('names the rule when it refuses a request from another site', async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
    try {
      const base = await startGuarded(deps({ approve: vi.fn().mockResolvedValue('approved') }));
      await fetch(`${base}/approve`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'sec-fetch-site': 'cross-site',
          origin: 'https://evil.example',
        },
        body: new URLSearchParams({ runId: RUN }).toString(),
        redirect: 'manual',
      });
      const refused = logged
        .map((entry) => JSON.parse(entry) as Record<string, unknown>)
        .filter((entry) => entry['event'] === 'console_refused');
      expect(refused).toHaveLength(1);
      expect(refused[0]!['reason']).toBe('not_same_origin');
    } finally {
      spy.mockRestore();
    }
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

  // A run id of another shape is a request the console declines, not a
  // fault. It never reaches the approval, and the refusal is logged.
  it('refuses a run id of another shape without reaching the approval', async () => {
    const approved: string[] = [];
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
    try {
      const base = await startGuarded(
        deps({ approve: async (runId: string) => { approved.push(runId); return 'approved'; } }),
      );
      const res = await fetch(base + '/approve', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'sec-fetch-site': 'same-origin',
        },
        body: 'runId=abc',
        redirect: 'manual' as const,
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain('not a run id');
      expect(approved).toEqual([]);
      expect(logged.some((entry) => entry.includes('console_approved'))).toBe(false);
      const refused = logged
        .map((entry) => JSON.parse(entry) as Record<string, unknown>)
        .find((entry) => entry['event'] === 'console_refused' && entry['reason'] === 'not_a_run_id');
      expect(refused).toBeDefined();
    } finally {
      spy.mockRestore();
    }
  });

  // The form's run id reaches the refusal log. JSON leaves NEL and the Unicode
  // line separator raw, and some log readers break a line at either, so one
  // request could write what reads as a second entry.
  // The log names what arrived without copying it. The form takes 64 KiB and a
  // header up to Node's limit, and anyone who reaches the port may send either.
  it('logs a bounded prefix and the length of an oversized run id', async () => {
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
        body: 'runId=' + 'a'.repeat(10_000),
        redirect: 'manual' as const,
      });
      const line = logged.find((entry) => entry.includes('"reason":"not_a_run_id"'));
      expect(line).toBeDefined();
      expect(line!.length).toBeLessThan(1_000);
      const record = JSON.parse(line!) as Record<string, unknown>;
      expect(record['runId']).toBe('a'.repeat(64));
      expect(record['runIdLength']).toBe(10_000);
    } finally {
      spy.mockRestore();
    }
  });

  it('logs a bounded prefix and the length of an oversized claimed approver', async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
    try {
      const base = await startGuarded(deps({ approve: async () => 'approved' }), undefined, 'x-forwarded-user');
      await fetch(base + '/approve', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'sec-fetch-site': 'same-origin',
          'x-forwarded-user': 'b'.repeat(8_000),
        },
        body: `runId=${RUN}`,
        redirect: 'manual' as const,
      });
      const line = logged.find((entry) => entry.includes('console_approved'));
      expect(line).toBeDefined();
      expect(line!.length).toBeLessThan(1_000);
      const record = JSON.parse(line!) as Record<string, unknown>;
      expect(record['claimedBy']).toBe('b'.repeat(64));
      expect(record['claimedLength']).toBe(8_000);
      expect(record['approvedBy']).toBe('unattributed');
    } finally {
      spy.mockRestore();
    }
  });

  // The prefix and the length count the same unit: characters, not UTF-16
  // units, so a name of emoji reads as whole when it is whole.
  it('counts the logged prefix and the length in the same unit', async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
    try {
      const base = await startGuarded(deps({ approve: async () => 'approved' }), undefined, 'x-forwarded-user');
      const port = Number(new URL(base).port);
      const claim = String.fromCodePoint(0x1f600).repeat(10);
      const raw = Buffer.from(claim, 'utf8').toString('latin1');
      await new Promise<void>((resolve, reject) => {
        const req = request(
          {
            host: '127.0.0.1', port, path: '/approve', method: 'POST',
            headers: [
              'host', `127.0.0.1:${port}`,
              'sec-fetch-site', 'same-origin',
              'content-type', 'application/x-www-form-urlencoded',
              'x-forwarded-user', raw,
            ],
          },
          (res) => { res.resume(); res.on('end', resolve); },
        );
        req.on('error', reject);
        req.end(`runId=${RUN}`);
      });
      const record = JSON.parse(logged.find((entry) => entry.includes('console_approved')) ?? '{}') as Record<string, unknown>;
      expect(record['claimedBy']).toBe(claim);
      expect(record['claimedLength']).toBe(10);
      expect(record['approvedBy']).toBe(claim);
    } finally {
      spy.mockRestore();
    }
  });

  // A client that hangs up mid-body is not a console fault. It is refused and
  // named for what it is, never logged as a failed ledger read.
  it('names a client that hung up mid-body, and logs no console fault', async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
    try {
      const base = await startGuarded(deps({ approve: async () => 'approved' }));
      const port = Number(new URL(base).port);
      await new Promise<void>((resolve) => {
        const req = request({
          host: '127.0.0.1', port, path: '/approve', method: 'POST',
          headers: [
            'host', `127.0.0.1:${port}`,
            'sec-fetch-site', 'same-origin',
            'content-type', 'application/x-www-form-urlencoded',
            'content-length', '1000',
          ],
        });
        req.on('error', () => resolve());
        req.write('runId=abc');
        setTimeout(() => { req.destroy(); resolve(); }, 50);
      });
      await new Promise((r) => setTimeout(r, 150));
      const events = logged.map((entry) => JSON.parse(entry) as Record<string, unknown>);
      expect(events.some((e) => e['event'] === 'console_error')).toBe(false);
      const aborted = events.find((e) => e['event'] === 'console_refused' && e['reason'] === 'client_aborted');
      expect(aborted).toBeDefined();
      expect(aborted!['from']).toBe('127.0.0.1');
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps the refusal record on one line whatever the form carried', async () => {
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
        body: 'runId=r%C2%85%E2%80%A8%7B%22event%22%3A%22forged%22%7D',
        redirect: 'manual' as const,
      });
      const line = logged.find((entry) => entry.includes('"reason":"not_a_run_id"'));
      expect(line).toBeDefined();
      for (const code of [0x85, 0x2028]) {
        expect(line, `U+${code.toString(16)}`).not.toContain(String.fromCharCode(code));
      }
      const record = JSON.parse(line ?? '{}') as Record<string, unknown>;
      expect(record['runId']).toBe('r' + String.fromCharCode(0x85, 0x2028) + '{"event":"forged"}');
    } finally {
      spy.mockRestore();
    }
  });

  // The log names what was claimed and what the ledger records. They differ
  // when the claim is one the approval would not keep, and an incident reader
  // must not see a name the ledger never held.
  it('logs the claimed approver beside the one the ledger records', async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
    try {
      const base = await startGuarded(deps({ approve: async () => 'approved' }), undefined, 'x-forwarded-user');
      await fetch(base + '/approve', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'sec-fetch-site': 'same-origin',
          'x-forwarded-user': 'a'.repeat(257),
        },
        body: `runId=${RUN}`,
        redirect: 'manual' as const,
      });
      const line = logged.find((entry) => entry.includes('console_approved'));
      expect(line).toBeDefined();
      const record = JSON.parse(line ?? '{}') as Record<string, unknown>;
      expect(record['claimedBy']).toBe('a'.repeat(64));
      expect(record['claimedLength']).toBe(257);
      expect(record['approvedBy']).toBe('unattributed');
    } finally {
      spy.mockRestore();
    }
  });

  // Nothing was recorded when the approval did not happen, so the log names
  // no recorded approver for it.
  it('names no recorded approver when the approval did not happen', async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
    try {
      const base = await startGuarded(deps({ approve: async () => 'unknown_run' }), undefined, 'x-forwarded-user');
      await fetch(base + '/approve', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'sec-fetch-site': 'same-origin',
          'x-forwarded-user': 'ops-oncall',
        },
        body: `runId=${RUN}`,
        redirect: 'manual' as const,
      });
      const record = JSON.parse(logged.find((entry) => entry.includes('console_approved')) ?? '{}') as Record<string, unknown>;
      expect(record['outcome']).toBe('unknown_run');
      expect(record['claimedBy']).toBe('ops-oncall');
      expect(record['approvedBy']).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  // The claimed approver comes from a header, as raw bytes. Bytes that decode
  // to NEL and the Unicode line separator must not break the approval line.
  it('keeps the approval record on one line whatever the header carried', async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
    try {
      const base = await startGuarded(deps({ approve: async () => 'approved' }), undefined, 'x-forwarded-user');
      const port = Number(new URL(base).port);
      const claim = 'ops' + String.fromCharCode(0x2028, 0x85) + 'mallory';
      const raw = Buffer.from(claim, 'utf8').toString('latin1');
      await new Promise<void>((resolve, reject) => {
        const req = request(
          {
            host: '127.0.0.1', port, path: '/approve', method: 'POST',
            headers: [
              'host', `127.0.0.1:${port}`,
              'sec-fetch-site', 'same-origin',
              'content-type', 'application/x-www-form-urlencoded',
              'x-forwarded-user', raw,
            ],
          },
          (res) => { res.resume(); res.on('end', resolve); },
        );
        req.on('error', reject);
        req.end(`runId=${RUN}`);
      });
      const line = logged.find((entry) => entry.includes('console_approved'));
      expect(line).toBeDefined();
      for (const code of [0x85, 0x2028]) {
        expect(line, `U+${code.toString(16)}`).not.toContain(String.fromCharCode(code));
      }
      const record = JSON.parse(line ?? '{}') as Record<string, unknown>;
      expect(record['claimedBy']).toBe(claim);
      expect(record['approvedBy']).toBe('unattributed');
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

  // Three cases, and this surface drew two. `approveRun` relays a ledger-only
  // park through its journalled payload (DEC-34), so such a run has always
  // been approvable — the console offered no button and a third of the queue
  // was a dead end on the page built to clear it.
  it('offers no approve button for a run that parked neither a draft nor a payload', async () => {
    const base = await startGuarded(deps({
      listApprovals: async () => [{
        runId: RUN, ticketId: 'SYN-1', state: 'awaiting_approval', promptVer: 'p1', ...ROW,
        reason: 'irreversible', stepsUsed: 4,
        agreement: 0.89, coverage: 0.94, draftExternalId: null, payloadRecorded: false,
      }],
    }));
    const html = await (await fetch(base + '/approvals')).text();
    expect(html).toContain('neither a helpdesk draft nor an action payload');
    expect(html).not.toContain('<button');
  });

  // `compensate` is the class the policy engine judges irreversible, and a
  // seeded queue holds it. An earlier case used a class this system has no
  // name for, so the branch that matters was never exercised.
  it('approves a ledger-parked action, and names what it will perform (DEC-34)', async () => {
    const base = await startGuarded(deps({
      listApprovals: async () => [{
        runId: RUN, ticketId: 'SYN-1', state: 'awaiting_approval', promptVer: 'p1', ...ROW,
        reason: null, stepsUsed: 4, gateReason: 'high_risk',
        agreement: 0.89, coverage: 0.94,
        draftExternalId: null, payloadRecorded: true, actionClass: 'route_ticket',
      }],
    }));
    const html = await (await fetch(base + '/approvals')).text();
    expect(html).toContain('Approve and perform');
    expect(html).toContain('route_ticket');
    expect(html).toContain('No reply goes to a customer.');
    // Routing a ticket is not permanent, so this must not claim it is.
    expect(html).not.toContain('cannot be undone');
  });

  // The class DEC-34 exists for. An irreversible write parks in the ledger
  // like any other internal action, so it reaches the branch that used to
  // say only "no reply goes to a customer" — the one act on this console
  // that cannot be taken back, under the weaker of the two warnings.
  // Read from the action, not from which rule fired first.
  //
  // The engine tests idempotency, read-back, visibility, irreversibility and
  // risk in that order, so a compensation on an adapter with no idempotency
  // key stops at `no_idempotency` — and it is still the one action here that
  // cannot be taken back. A warning keyed on the gate rule would go silent on
  // exactly that run.
  const permanentRules = ['irreversible', 'no_idempotency', 'high_risk', 'no_read_back'];
  for (const rule of permanentRules) {
    it(`warns that a compensation cannot be undone, whichever rule stopped it: ${rule}`, async () => {
      const base = await startGuarded(deps({
        listApprovals: async () => [{
          runId: RUN, ticketId: 'SYN-1', state: 'awaiting_approval', promptVer: 'p1', ...ROW,
          reason: null, stepsUsed: 4, gateReason: rule,
          agreement: 0.89, coverage: 0.94,
          draftExternalId: null, payloadRecorded: true,
          actionClass: 'compensate', delivery: 'at_most_once',
        }],
      }));
      const html = await (await fetch(base + '/approvals')).text();
      expect(html, rule).toContain('compensate');
      expect(html, rule).toContain('cannot be undone');
      // DEC-30: at_most_once never retries, so an unconfirmed send escalates.
      expect(html, rule).toContain('escalates rather than repeating');
    });
  }

  // DEC-40 permits this console to approve because the approver reads what
  // they are approving. A ledger-only park has no drafted reply, so the
  // payload is the whole of the act — and the page named the action and
  // showed nothing of its content.
  it('shows the payload the approval will perform (DEC-34, DEC-40)', async () => {
    const base = await startGuarded(deps({
      listApprovals: async () => [{
        runId: RUN, ticketId: 'SYN-1', state: 'awaiting_approval', promptVer: 'p1', ...ROW,
        reason: null, stepsUsed: 4, gateReason: 'irreversible',
        agreement: 0.89, coverage: 0.94,
        draftExternalId: null, payloadRecorded: true,
        actionClass: 'compensate', delivery: 'at_most_once',
        payload: { amountMicros: 4200, ticket: 'SYN-1', reason: 'duplicate charge' },
      }],
    }));
    const html = await (await fetch(base + '/approvals')).text();
    expect(html).toContain('What approving this performs');
    // The amount an operator is about to move.
    expect(html).toContain('4200');
    expect(html).toContain('amountMicros');
    expect(html).toContain('duplicate charge');
  });

  // A park with a payload the reader refused, or none at all. Drawing an
  // empty block would vouch for an action with nothing behind it.
  it('says so when a parked action recorded no readable payload', async () => {
    const base = await startGuarded(deps({
      listApprovals: async () => [{
        runId: RUN, ticketId: 'SYN-1', state: 'awaiting_approval', promptVer: 'p1', ...ROW,
        reason: null, stepsUsed: 4, gateReason: 'irreversible',
        agreement: 0.89, coverage: 0.94,
        draftExternalId: null, payloadRecorded: true,
        actionClass: 'compensate', delivery: 'at_most_once', payload: null,
      }],
    }));
    const html = await (await fetch(base + '/approvals')).text();
    expect(html).toContain('recorded no payload for it');
  });

  // A draft-backed park's act is the reply above it, so there is no payload
  // block to draw.
  it('draws no payload block for a run that parked a reply', async () => {
    const html = await (await fetch((await startGuarded(deps())) + '/approvals')).text();
    expect(html).not.toContain('What approving this performs');
  });

  // And the sentence is about the delivery rule, not about the class. A
  // reversible action delivered at least once gets neither claim.
  it('claims neither permanence nor at-most-once for a routing action', async () => {
    const base = await startGuarded(deps({
      listApprovals: async () => [{
        runId: RUN, ticketId: 'SYN-1', state: 'awaiting_approval', promptVer: 'p1', ...ROW,
        reason: null, stepsUsed: 4, gateReason: 'irreversible',
        agreement: 0.89, coverage: 0.94,
        draftExternalId: null, payloadRecorded: true,
        actionClass: 'route_ticket', delivery: 'at_least_once',
      }],
    }));
    const html = await (await fetch(base + '/approvals')).text();
    expect(html).not.toContain('cannot be undone');
    expect(html).not.toContain('escalates rather than repeating');
  });

  // The warning is about the act, so the two acts do not share one. A reply
  // reaches a person who cannot unread it.
  it('warns that a sent reply cannot be recalled, on the draft path alone', async () => {
    const html = await (await fetch(
      (await startGuarded(deps())) + '/approvals',
    )).text();
    expect(html).toContain('Approve and send');
    expect(html).toContain('cannot be recalled');
    expect(html).not.toContain('No reply goes to a customer.');
  });

  // The queue is uncapped by design, so a journal read per row would be one
  // statement for every run of a list that has been 476 long.
  it('reads the journal for the drawn selection alone', async () => {
    const read: string[] = [];
    const base = await startGuarded(deps({
      readApprovalEvidence: async (runId: string) => {
        read.push(runId);
        return {
          request: REQUEST,
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

describe('the message a reply answers', () => {
  // The epic's first criterion, and the last of it to ship. An approver who
  // reads a reply, its claims and its sources still cannot tell whether it
  // answers the question — which is the shape of the defect this surface was
  // built to fix, one step along.
  it('shows the customer\'s message on the approval queue', async () => {
    const base = await startGuarded(deps());
    const html = await (await fetch(base + '/approvals')).text();
    expect(html).toContain('The message this answers');
    expect(html).toContain('There are two charges for the same month.');
    // Above the reply it answers, not below it.
    expect(html.indexOf('The message this answers'))
      .toBeLessThan(html.indexOf('The reply, as the system drafted it'));
  });

  it('shows it on the run detail too', async () => {
    const base = await startGuarded(deps());
    const html = await (await fetch(`${base}/run/${RUN}`)).text();
    expect(html).toContain('There are two charges for the same month.');
  });

  // A later turn is context this does not show.
  it('links the whole thread from beside the message', async () => {
    const base = await startGuarded(deps());
    const html = await (await fetch(base + '/approvals')).text();
    expect(html).toContain(`/conversation/${CONVERSATION}`);
  });

  it('names a message nobody kept, rather than drawing a blank', async () => {
    const base = await startGuarded(deps({
      readApprovalEvidence: async () => ({
        request: { ...REQUEST, bodyText: null, absence: 'not_retained' },
        evidence: EVIDENCE,
        gates: {
          agreement: 0.89, coverage: 0.94, agreementThreshold: 0.6,
          agreementDetail: '8 of 9 samples', coverageBlock: 0.7, coverageReview: 0.8,
        },
      }),
    }));
    const html = await (await fetch(base + '/approvals')).text();
    expect(html).toContain('the text of this message was not kept');
  });

  // A run that answered no turn is not a turn whose text nobody kept. Drawing
  // an absence about a turn that never existed would name a fact the ledger
  // does not hold.
  it('draws nothing at all for a run that answered no turn', async () => {
    const base = await startGuarded(deps({
      readApprovalEvidence: async () => ({
        request: null,
        evidence: EVIDENCE,
        gates: {
          agreement: 0.89, coverage: 0.94, agreementThreshold: 0.6,
          agreementDetail: '8 of 9 samples', coverageBlock: 0.7, coverageReview: 0.8,
        },
      }),
    }));
    const html = await (await fetch(base + '/approvals')).text();
    expect(html).not.toContain('The message this answers');
    expect(html).not.toContain('the text of this message was not kept');
    // The reply is still there.
    expect(html).toContain('The reply, as the system drafted it');
  });

  // The queue is uncapped, so a turn read per waiting row would be a
  // statement for every row of a list that has been 476 long.
  //
  // Six waiting runs, because the fixture above holds one — and a test with
  // one row passes whether the code reads once or once per row.
  it('reads the message for the drawn selection alone', async () => {
    const read: string[] = [];
    const queue = Array.from({ length: 6 }, (_, i) => ({
      runId: `0000000${i}-2222-4333-8444-555555555555`,
      ticketId: `SYN-${i}`, state: 'awaiting_approval', promptVer: 'p1', ...ROW,
      reason: 'customer_visible', stepsUsed: 4,
      agreement: 0.89, coverage: 0.94, draftExternalId: 'D-1',
    }));
    const base = await startGuarded(deps({
      listApprovals: async () => queue,
      readApprovalEvidence: async (runId: string) => {
        read.push(runId);
        return {
          request: REQUEST,
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
    // The one it drew, which is the head of the queue.
    expect(read[0]).toBe(queue[0]!.runId);
  });

  // The name said "from the same builder", and the suite injects the request
  // into `readRun` — so it could not check that. What it can check is that
  // both surfaces render the same message identically, which is the property
  // a reader cares about.
  it('renders the same message on both surfaces', async () => {
    const base = await startGuarded(deps());
    const detail = await (await fetch(`${base}/run/${RUN}`)).text();
    const queue = await (await fetch(base + '/approvals')).text();
    for (const html of [detail, queue]) {
      expect(html).toContain('The message this answers');
      expect(html).toContain('There are two charges for the same month.');
    }
  });
});

describe('the evidence states that are not a list of claims', () => {
  const bare = {
    runId: RUN, ticketId: 'SYN-1', state: 'awaiting_approval', promptVer: 'p1', ...ROW,
    reason: 'customer_visible', stepsUsed: 4,
    agreement: 0.89, coverage: 0.94, draftExternalId: 'D-1',
  };

  /**
   * The evidence a case describes, with the DEC-43 partition filled in from
   * its claims when the case does not state one.
   *
   * Every case here predates courtesy sentences and is about something else —
   * a document that left the index, a claim nobody judged. Restating a
   * partition in each one would bury what the case is actually asserting. A
   * case that is about courtesy sentences states `sentences` itself, and this
   * leaves it alone.
   */
  function withPartition(evidence: unknown): unknown {
    if (typeof evidence !== 'object' || evidence === null) return evidence;
    const row = evidence as Record<string, unknown>;
    if ('sentences' in row) return row;
    const claims = row['claims'];
    // Explicitly null, never absent. `EvidenceView.sentences` is nullable and
    // never optional, and leaving the key off handed the renderer `undefined`
    // — which passes a `=== null` guard and then dies on `.length`. A case
    // about a row with no partition could not be written until this was so.
    if (!Array.isArray(claims)) return { ...row, sentences: null };
    return {
      ...row,
      sentences: claims.map((claim: Record<string, unknown>) => ({
        text: claim['text'],
        docId: claim['docId'],
        claimIndex: claim['index'],
        supported: claim['supported'],
      })),
    };
  }

  async function queueWith(raw: unknown): Promise<string> {
    const evidence = withPartition(raw);
    const base = await startGuarded(deps({
      listApprovals: async () => [bare],
      readApprovalEvidence: async () => ({
        request: REQUEST,
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
      sentences: [{
        text: 'a claim', docId: 'SYN-DOC-01', claimIndex: 0, supported: true,
      }],
      claims: [{ index: 0, text: 'a claim', docId: 'SYN-DOC-01', supported: true }],
    });
    expect(html).toContain('no retrieval journalled');
    expect(html).not.toContain('of 0 retrieved');
    expect(html).not.toContain('no such document today');
  });

  it('separates a retrieval it could not read from one that never happened', async () => {
    const html = await queueWith({
      draftBody: 'a reply', documentsMalformed: true, documents: null,
      sentences: [{
        text: 'a claim', docId: 'SYN-DOC-01', claimIndex: 0, supported: true,
      }],
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
      draftBody: 'a reply', documentsMalformed: false, documents: [],
      sentences: [], claims: [],
    });
    expect(html).toContain('claim list with no claims in it');
    expect(html).not.toContain('every claim of 0');
  });

  // DEC-43. The reply opens and closes with sentences no document stands
  // behind, and this console has to draw them: they are part of what a
  // customer reads, and an approver deciding on the claims alone would approve
  // text nobody showed them.
  const COURTEOUS = {
    draftBody: 'Thanks for writing in. We refunded the duplicate charge. Reply here if it helps.',
    documentsMalformed: false,
    documents: [{
      position: 1, docId: 'SYN-DOC-01', title: 'Refund policy', kind: 'document',
      owner: 'support', bodyUnchanged: true, titleAtRun: 'Refund policy',
    }],
    sentences: [
      { text: 'Thanks for writing in.', docId: null, claimIndex: null, supported: null },
      {
        text: 'We refunded the duplicate charge.',
        docId: 'SYN-DOC-01', claimIndex: 0, supported: true,
      },
      { text: 'Reply here if it helps.', docId: null, claimIndex: null, supported: null },
    ],
    claims: [{
      index: 0, text: 'We refunded the duplicate charge.',
      docId: 'SYN-DOC-01', supported: true,
    }],
  };

  it('draws the courtesy sentences of the reply, marked as citing nothing (DEC-43)', async () => {
    const html = await queueWith(COURTEOUS);
    expect(html).toContain('<span class="courtesy">Thanks for writing in.</span>');
    expect(html).toContain('<span class="courtesy">Reply here if it helps.</span>');
  });

  // The whole reply, in the composer's order. Rendering the claims and
  // appending the courtesy sentences would put them in an order the composer
  // never chose, and the order is the reply.
  it('draws the reply in draft order, courtesy sentences in place', async () => {
    const html = await queueWith(COURTEOUS);
    const opening = html.indexOf('Thanks for writing in.');
    const claim = html.indexOf('We refunded the duplicate charge.');
    const closing = html.indexOf('Reply here if it helps.');
    expect(opening).toBeGreaterThan(-1);
    expect(opening).toBeLessThan(claim);
    expect(claim).toBeLessThan(closing);
  });

  // A citation marker on a sentence that cites nothing would point a reader
  // at a source the composer never named for it.
  it('gives a courtesy sentence no citation marker and no verdict mark', async () => {
    const html = await queueWith(COURTEOUS);
    const courtesy = /<span class="courtesy">Thanks for writing in\.<\/span>/.exec(html);
    expect(courtesy).not.toBeNull();
    // One citation marker on this reply, and it belongs to the one claim.
    expect(html.match(/class="cite"/g) ?? []).toHaveLength(1);
    expect(html).not.toContain('class="courtesy unsupported"');
  });

  // The summary is about the claims, and a reply whose claims all passed can
  // still carry sentences no document stands behind. Saying only that every
  // claim was accepted would describe part of the reply as though it were the
  // whole of it.
  it('says how much of the reply cites nothing, even when every claim passed', async () => {
    const html = await queueWith(COURTEOUS);
    expect(html).toContain('every claim of 1 carries a document the judge accepted');
    expect(html).toContain('2 further sentences open or close the reply and cite nothing');
  });

  // The verdict is recorded by position among the cited sentences. A reply
  // opening with a courtesy sentence must not shift the verdict onto the
  // sentence after it.
  it('numbers a citation by its position among the claims, not in the reply', async () => {
    const html = await queueWith(COURTEOUS);
    expect(html).toContain('id="claim-0"');
    expect(html).not.toContain('id="claim-1"');
    expect(html).toContain('>1</a>');
  });

  // Reachable in production: one unreadable member makes the whole partition
  // null while `park.draftBody` survives. The reply is still shown, and the
  // console says the citations are not available for it — which is a
  // different fact from the reply having none.
  it('shows a reply whose partition could not be read, and says so', async () => {
    const html = await queueWith({
      draftBody: 'We refunded the duplicate charge.',
      documentsMalformed: false, documents: [], sentences: null, claims: null,
    });
    expect(html).toContain('We refunded the duplicate charge.');
    expect(html).toContain('no claim list');
    // No citation markers, because no sentence here carries a source.
    expect(html).not.toContain('class="cite"');
    expect(html).not.toContain('No draft was recorded for this run.');
  });

  // The other half of that pair. A run that parked nothing and recorded no
  // partition composed no reply, and drawing an empty prose block would
  // vouch for one.
  it('names a run that recorded neither a draft nor a partition', async () => {
    const html = await queueWith({
      draftBody: null, documentsMalformed: false, documents: [],
      sentences: null, claims: null,
    });
    expect(html).toContain('This run composed no reply.');
  });

  // A reply whose every sentence cites nothing. Reachable from a row written
  // before DEC-43's parser, and it is the reply that most needs saying so:
  // the console drew it in muted italic and said nothing at all, so the
  // control DEC-43 names was the stylesheet alone.
  it('says a reply no document stands behind, rather than drawing it quietly', async () => {
    const html = await queueWith({
      draftBody: 'We have already refunded your payment. It cleared on Tuesday.',
      documentsMalformed: false, documents: [],
      sentences: [
        {
          text: 'We have already refunded your payment.',
          docId: null, claimIndex: null, supported: null,
        },
        { text: 'It cleared on Tuesday.', docId: null, claimIndex: null, supported: null },
      ],
      claims: [],
    });
    expect(html).toContain('We have already refunded your payment.');
    expect(html).toContain('no document stands behind any of them');
    // The reading that would have been a clean bill of health for it.
    expect(html).not.toContain('every claim of 0');
  });

  it('says the same of a one-sentence reply that cites nothing', async () => {
    const html = await queueWith({
      draftBody: 'We have already refunded your payment.',
      documentsMalformed: false, documents: [],
      sentences: [{
        text: 'We have already refunded your payment.',
        docId: null, claimIndex: null, supported: null,
      }],
      claims: [],
    });
    expect(html).toContain('This reply is one sentence, and no document stands behind it.');
  });

  // Singular, and only when there is one. A summary that always appended the
  // count would tell every ordinary reply that "0 further sentences open or
  // close the reply", which is a false statement about that reply.
  it('counts one courtesy sentence in the singular, and says nothing when there are none', async () => {
    const one = await queueWith({
      draftBody: 'a reply', documentsMalformed: false, documents: [],
      sentences: [
        { text: 'A charge is refundable.', docId: 'SYN-DOC-01', claimIndex: 0, supported: true },
        { text: 'Reply here if that helps.', docId: null, claimIndex: null, supported: null },
      ],
      claims: [{ index: 0, text: 'A charge is refundable.', docId: 'SYN-DOC-01', supported: true }],
    });
    expect(one).toContain('1 further sentence opens or closes the reply and cites nothing');

    const none = await queueWith({
      draftBody: 'a reply', documentsMalformed: false, documents: [],
      claims: [{ index: 0, text: 'A charge is refundable.', docId: 'SYN-DOC-01', supported: true }],
    });
    expect(none).toContain('every claim of 1 carries a document the judge accepted');
    expect(none).not.toContain('further sentence');
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

  // DEC-42. The operator names the header, because a console cannot guess
  // which of its request headers a proxy controls. Naming it is the
  // operator's statement that a proxy in front sets it.
  it('takes the header a trusted proxy set, once the operator names it', async () => {
    expect(await approveWith(
      { identityHeader: 'x-forwarded-user' },
      { 'x-forwarded-user': 'ops-oncall' },
    )).toEqual(['ops-oncall']);
  });

  // Node reads header bytes as Latin-1. A proxy that sends UTF-8 bytes would
  // otherwise put a name like `NystrÃ¶m` in the audit column.
  it('passes on a name a proxy sent as UTF-8 bytes as the name it sent', async () => {
    expect(await approveWith(
      { identityHeader: 'x-forwarded-user' },
      { 'x-forwarded-user': Buffer.from('Åsa Nyström', 'utf8').toString('latin1') },
    )).toEqual(['Åsa Nyström']);
  });

  // A byte that is not UTF-8 is Latin-1 text, and it stays as Node read it.
  it('passes on a Latin-1 name unchanged', async () => {
    expect(await approveWith(
      { identityHeader: 'x-forwarded-user' },
      { 'x-forwarded-user': 'Åsa Nyström' },
    )).toEqual(['Åsa Nyström']);
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

  // Node joins a repeated header only for some names. For others, such as
  // `From`, it keeps the first value and drops the rest without a sign. The
  // operator may name any header, so the second claim must still be seen.
  it('names nobody when a header Node keeps only once arrived twice', async () => {
    const calls: (string | undefined)[] = [];
    const base = await startGuarded(
      deps({
        approve: async (runId: string, approvedBy: string | undefined) => {
          calls.push(approvedBy);
          return 'approved';
        },
      }),
      undefined,
      'from',
    );
    const port = Number(new URL(base).port);
    await new Promise<void>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1', port, path: '/approve', method: 'POST',
          // The flat form, because the typed one allows `From` only once.
          headers: [
            'host', `127.0.0.1:${port}`,
            'sec-fetch-site', 'same-origin',
            'content-type', 'application/x-www-form-urlencoded',
            'from', 'ops-oncall',
            'from', 'mallory',
          ],
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
      runId: RUN, ticketId: 'SYN-1', state: 'awaiting_approval', promptVer: 'p1', ...ROW,
      reason: 'customer_visible', stepsUsed: 4,
      agreement: 0.89, coverage: 0.94, draftExternalId: 'D-1',
    },
    {
      runId: RUN_B, ticketId: 'SYN-2', state: 'awaiting_approval', promptVer: 'p1', ...ROW,
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

// Issue #63. The queue is a list a person triages, and it carried an opaque
// ticket id and a reason that could never hold a value.
describe('what a queue row tells the person working it', () => {
  function waiting(...over: readonly Partial<Record<string, unknown>>[]) {
    return over.map((row, i) => ({
      runId: `0000000${i}-1111-4111-8111-111111111111`,
      ticketId: `SYN-${i}`, state: 'awaiting_approval', promptVer: 'p1', ...ROW,
      reason: null, stepsUsed: 4, agreement: 0.89, coverage: 0.94,
      draftExternalId: 'D-1',
      ...row,
    }));
  }

  // The defect. `reason` reads the escalate row and a waiting run has not
  // escalated, so every row read "no reason journalled" while the gate row
  // held the answer.
  it('names the policy rule that made the run a person\'s, not the escalation reason', async () => {
    const base = await startGuarded(deps({
      listApprovals: async () => waiting({ reason: null, gateReason: 'high_risk' }),
    }));
    const html = await (await fetch(base + '/approvals')).text();
    expect(html).toContain('high_risk');
    expect(html).not.toContain('no reason journalled');
  });

  it('says what the ticket is about and how well the reply is covered', async () => {
    const base = await startGuarded(deps({
      listApprovals: async () => waiting({
        intentId: 'billing-dispute', gateCoverage: 0.4, gateReason: 'groundedness_review',
      }),
    }));
    const html = await (await fetch(base + '/approvals')).text();
    expect(html).toContain('billing-dispute');
    expect(html).toContain('coverage 0.40');
    expect(html).not.toContain('not read');
  });

  // DEC-05 and section 4.8. The gate row records `groundedness` whether or
  // not the engine compared it, and a customer reply is gated by DEC-12
  // before either threshold. Printing the number plain beside that rule told
  // a person a run had failed groundedness when it was never judged on it —
  // and on a seeded queue it said so about six runs in ten.
  it('marks a coverage the policy engine never read', async () => {
    for (const rule of [
      'customer_visible', 'high_risk', 'irreversible', 'no_idempotency', 'agreement',
    ]) {
      const base = await startGuarded(deps({
        listApprovals: async () => waiting({ gateCoverage: 0.4, gateReason: rule }),
      }));
      const html = await (await fetch(base + '/approvals')).text();
      expect(html, rule).toContain('coverage 0.40 (not read)');
    }
  });

  it('marks nothing when a threshold is what decided', async () => {
    for (const rule of ['groundedness_review', 'groundedness_block', 'auto']) {
      const base = await startGuarded(deps({
        listApprovals: async () => waiting({ gateCoverage: 0.4, gateReason: rule }),
      }));
      const html = await (await fetch(base + '/approvals')).text();
      expect(html, rule).not.toContain('not read');
    }
  });

  // One rule, one check. The coverage marker vetted this field against the
  // engine's vocabulary and the label beside it printed whatever the column
  // held — so a gate row carrying free text would put an unbounded foreign
  // string in a queue row, in a layout built for one word.
  //
  // Two rows, not one. With a single row `gateFilters` returns nothing at all,
  // so a one-row case asserts the chip is clean without ever rendering a chip
  // — it passes for the wrong reason.
  it('names a rule outside the engine\'s vocabulary as one, at every place it is drawn', async () => {
    const foreign = 'a'.repeat(400);
    const rows = [
      ...waiting({ gateReason: foreign, gateCoverage: 0.4 }),
      ...waiting({ gateReason: 'high_risk', gateCoverage: 0.9 }),
    ].map((row, i) => ({ ...row, runId: `0000000${i}-1111-4111-8111-111111111111` }));

    const base = await startGuarded(deps({
      listApprovals: async () => rows,
      listRuns: async () => rows,
    }));

    // Drawn, not linked. A chip's href has to carry the raw value or it
    // cannot filter on it; what must never carry it is the text a person
    // reads, which is the character right after a tag closes.
    const shown = (html: string): boolean => html.includes(`>${foreign}`);

    // The queue: the row, and the filter chip the one-row case never drew.
    const queue = await (await fetch(base + '/approvals')).text();
    expect(shown(queue)).toBe(false);
    expect(queue).toContain('a rule this console does not know');
    expect(queue).toContain('(not read)');

    // The narrowed header, which names the active rule.
    const narrowed = await (await fetch(
      base + '/approvals?rule=' + encodeURIComponent(foreign),
    )).text();
    expect(shown(narrowed)).toBe(false);

    // And the runs table, which merges the two reason vocabularies.
    const runs = await (await fetch(base + '/')).text();
    expect(shown(runs)).toBe(false);
  });

  // The header says the oldest is on this list, and nothing on it said how
  // old anything was.
  it('says how long each run has waited', async () => {
    const hoursAgo = new Date(Date.now() - 5 * 3_600_000);
    const base = await startGuarded(deps({
      listApprovals: async () => waiting({ createdAt: hoursAgo }),
    }));
    const html = await (await fetch(base + '/approvals')).text();
    expect(html).toContain('5h');
  });

  // A run the ledger could not date has an unknown age. Printing "just now"
  // would put the freshest label on the run least is known about.
  it('says an age it does not have is unrecorded, rather than now', async () => {
    const base = await startGuarded(deps({
      listApprovals: async () => waiting({ createdAt: null }),
    }));
    const html = await (await fetch(base + '/approvals')).text();
    expect(html).toContain('age unrecorded');
    expect(html).not.toContain('just now');
  });
});

describe('narrowing the queue to one gate rule', () => {
  function mixed() {
    const rows = [
      ['customer_visible', 'a'], ['customer_visible', 'b'],
      ['high_risk', 'c'], [null, 'd'],
    ] as const;
    return rows.map(([gateReason, id], i) => ({
      runId: `0000000${i}-1111-4111-8111-11111111111${i}`,
      ticketId: `SYN-${id}`, state: 'awaiting_approval', promptVer: 'p1', ...ROW,
      reason: null, gateReason, stepsUsed: 4,
      agreement: 0.89, coverage: 0.94, draftExternalId: 'D-1',
    }));
  }

  it('offers a chip per rule, with how many it holds', async () => {
    const base = await startGuarded(deps({ listApprovals: async () => mixed() }));
    const html = await (await fetch(base + '/approvals')).text();
    expect(html).toContain('rule=customer_visible');
    expect(html).toContain('rule=high_risk');
    // A run whose rule the ledger never recorded is still a run a person has
    // to work, so it is reachable rather than hidden.
    expect(html).toContain('rule=unruled');
  });

  it('shows only the runs carrying the chosen rule', async () => {
    const base = await startGuarded(deps({ listApprovals: async () => mixed() }));
    const html = await (await fetch(base + '/approvals?rule=high_risk')).text();
    expect(html).toContain('SYN-c');
    expect(html).not.toContain('SYN-a');
    expect(html).toContain('Waiting · 1');
  });

  // The badge counts the queue, not the view. A badge that fell because a
  // filter was on would report a queue that had emptied.
  it('counts everything waiting in the header, whatever the filter shows', async () => {
    const base = await startGuarded(deps({ listApprovals: async () => mixed() }));
    const html = await (await fetch(base + '/approvals?rule=high_risk')).text();
    expect(html).toContain('4 waiting');
  });

  // A rule nothing carries is not an error. It narrowed to nothing, which is
  // what was asked for, and the page says so rather than showing the queue.
  it('says nothing carries a rule nothing carries', async () => {
    const base = await startGuarded(deps({ listApprovals: async () => mixed() }));
    const html = await (await fetch(base + '/approvals?rule=no_idempotency')).text();
    expect(html).toContain('Nothing waiting carries that rule');
    expect(html).not.toContain('SYN-a');
  });

  // The stronger property, and the one that can fail. An earlier case
  // asserted the raw string was absent — which it is, because a rule nothing
  // carries never reaches an interpolation at all. That case passed with
  // every escape removed.
  //
  // What holds is that a rule from the query string is never echoed: not
  // raw, not escaped, not encoded. The page names only the rules the waiting
  // runs carry.
  it('never echoes a rule the query string invented', async () => {
    const base = await startGuarded(deps({ listApprovals: async () => mixed() }));
    for (const hostile of ['<script>alert(1)</script>', '"onmouseover="x', 'zzz-marker']) {
      const html = await (await fetch(
        base + '/approvals?rule=' + encodeURIComponent(hostile),
      )).text();
      expect(html, hostile).not.toContain(hostile);
      expect(html, hostile).not.toContain(escapeHtml(hostile));
      expect(html, hostile).not.toContain(encodeURIComponent(hostile));
      expect(html, hostile).toContain('Nothing waiting carries that rule');
    }
  });
});

describe('the time a run list is ordered by', () => {
  it('states when each run opened, and how long ago', async () => {
    const base = await startGuarded(deps({
      listRuns: async () => [{
        runId: RUN, ticketId: 'SYN-1', state: 'resolved', promptVer: 'p1', ...ROW,
        reason: null, stepsUsed: 4,
        createdAt: new Date('2026-09-07T09:00:00.000Z'),
      }],
    }));
    const html = await (await fetch(base + '/')).text();
    expect(html).toContain('2026-09-07 09:00Z');
    expect(html).toContain('Opened');
  });
});

// The runs list renders the same two reason fields the queue does, and the
// only case on that page asserted the timestamp. So the defect this whole
// change exists to remove could come back on the second surface unobserved.
describe('what the runs list tells an operator', () => {
  async function runsPage(over: Record<string, unknown>): Promise<string> {
    const base = await startGuarded(deps({
      listRuns: async () => [{
        runId: RUN, ticketId: 'SYN-1', state: 'awaiting_approval', promptVer: 'p1', ...ROW,
        reason: null, stepsUsed: 5, ...over,
      }],
    }));
    return (await fetch(base + '/')).text();
  }

  it('falls back to the gate rule when the run has not escalated', async () => {
    const html = await runsPage({ reason: null, gateReason: 'high_risk' });
    expect(html).toContain('high_risk');
  });

  // Both, because they answer different questions. An escalated run has a
  // reason and that is the one to show.
  it('shows the escalation reason when there is one', async () => {
    const html = await runsPage({ reason: 'composer_abstained', gateReason: 'high_risk' });
    expect(html).toContain('composer_abstained');
  });

  it('names what each run was about', async () => {
    const html = await runsPage({ intentId: 'billing-dispute' });
    expect(html).toContain('billing-dispute');
  });

  // The pin tells an operator pointed at a demo ledger that they are not
  // working real customer traffic.
  it('keeps the prompt pin, which is what marks a seeded run', async () => {
    const html = await runsPage({ promptVer: 'seed' });
    expect(html).toContain('seed');
  });
});

// DEC-40 inverted: the person reads a reply they are not sending. The route
// picks the run to read evidence for, and `renderApprovals` independently
// picks the run to draw — and the two must be the same run whatever the
// query string asks for.
describe('the run an approver reads, and the run the button posts', () => {
  const A = '0000000a-1111-4111-8111-111111111111';
  const B = '0000000b-1111-4111-8111-111111111111';

  function two() {
    return [
      { runId: A, ticketId: 'SYN-a', state: 'awaiting_approval', promptVer: 'p1', ...ROW,
        reason: null, gateReason: 'high_risk', stepsUsed: 4,
        agreement: 0.89, coverage: 0.94, draftExternalId: 'D-a' },
      { runId: B, ticketId: 'SYN-b', state: 'awaiting_approval', promptVer: 'p1', ...ROW,
        reason: null, gateReason: 'customer_visible', stepsUsed: 4,
        agreement: 0.89, coverage: 0.94, draftExternalId: 'D-b' },
    ];
  }

  it('reads and posts the same run when the filter excludes the one asked for', async () => {
    const readFor: string[] = [];
    const base = await startGuarded(deps({
      listApprovals: async () => two(),
      readApprovalEvidence: async (runId: string) => {
        readFor.push(runId);
        return {
          request: REQUEST,
          // The partition nulled so the draft body itself renders, which is
          // the text an approver reads.
          evidence: {
            ...EVIDENCE, sentences: null, claims: null,
            draftBody: `the reply of ${runId}`,
          },
          gates: {
            agreement: 0.89, coverage: 0.94, agreementThreshold: 0.6,
            agreementDetail: '8 of 9 samples', coverageBlock: 0.7, coverageReview: 0.8,
          },
        } as never;
      },
    }));
    // B carries customer_visible, so the high_risk filter excludes it.
    const html = await (await fetch(base + `/approvals?run=${B}&rule=high_risk`)).text();

    // Whichever run it fell back to, the evidence read and the form posted
    // name that same run. A page that read B and posted A would put a reply
    // in front of a person and send a different one.
    expect(readFor).toHaveLength(1);
    const posted = /name="runId" value="([^"]+)"/.exec(html)?.[1];
    expect(posted).toBe(readFor[0]);
    expect(html).toContain(`the reply of ${readFor[0]}`);
  });

  it('keeps the filter on every row it draws, so opening one does not clear it', async () => {
    const base = await startGuarded(deps({ listApprovals: async () => two() }));
    const html = await (await fetch(base + '/approvals?rule=high_risk')).text();
    expect(html).toContain(`href="/approvals?run=${A}&amp;rule=high_risk"`);
  });

  // An operator working one rule lost the filter on every approval and had
  // to reapply it. The filter travels on the form's action rather than as a
  // field, because this form's one field is the run id and that is what stops
  // a posted body being recorded as an approved reply.
  it('keeps the filter across an approval', async () => {
    const base = await startGuarded(deps({
      listApprovals: async () => two(),
      approve: async () => 'approved',
    }));
    const html = await (await fetch(base + '/approvals?rule=high_risk')).text();
    expect(html).toContain('action="/approve?rule=high_risk"');

    const posted = await fetch(base + '/approve?rule=high_risk', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'same-origin',
      },
      body: `runId=${A}`,
      redirect: 'manual',
    });
    expect(posted.status).toBe(303);
    expect(posted.headers.get('location')).toBe('/approvals?outcome=approved&rule=high_risk');
  });

  it('redirects without a filter when none was on', async () => {
    const base = await startGuarded(deps({
      listApprovals: async () => two(),
      approve: async () => 'approved',
    }));
    const posted = await fetch(base + '/approve', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'same-origin',
      },
      body: `runId=${A}`,
      redirect: 'manual',
    });
    expect(posted.headers.get('location')).toBe('/approvals?outcome=approved');
  });

  // The rail badge is the queue, not the view. A badge that fell because a
  // filter was on would report a queue that had emptied.
  it('keeps the rail badge counting the whole queue under a filter', async () => {
    const base = await startGuarded(deps({ listApprovals: async () => two() }));
    const html = await (await fetch(base + '/approvals?rule=high_risk')).text();
    expect(html).toContain('<span class="badge">2</span>');
  });

  // A filter that can only narrow to everything is not a filter.
  it('offers no filter bar when every waiting run carries one rule', async () => {
    const base = await startGuarded(deps({
      listApprovals: async () => two().map((run) => ({ ...run, gateReason: 'high_risk' })),
    }));
    const html = await (await fetch(base + '/approvals')).text();
    expect(html).not.toContain('class="seg"');
  });

  it('says which rule narrowed the list, in the words the chip uses', async () => {
    const base = await startGuarded(deps({
      listApprovals: async () => [
        ...two(),
        { runId: RUN, ticketId: 'SYN-c', state: 'awaiting_approval', promptVer: 'p1', ...ROW,
          reason: null, gateReason: null, stepsUsed: 4,
          agreement: 0.89, coverage: 0.94, draftExternalId: 'D-c' },
      ],
    }));
    const html = await (await fetch(base + '/approvals?rule=unruled')).text();
    expect(html).toContain('Waiting · 1 · no gate rule');
  });
});

// The gate panel, on the surface that decides an approval.
describe('what the gate panel says when a threshold decided nothing', () => {
  function oneWaiting(gateReason: string) {
    return [{
      runId: RUN, ticketId: 'SYN-1', state: 'awaiting_approval', promptVer: 'p1', ...ROW,
      reason: null, gateReason, stepsUsed: 4,
      agreement: 0.89, coverage: 0.94, draftExternalId: 'D-1',
    }];
  }

    // The panel draws each value against its thresholds, which reads as a
  // comparison that happened. The engine short-circuits, so on most of this
  // queue no comparison did — and the panel sat two inches under a row that
  // said the coverage was not read, contradicting it.
  const shortCircuits = ['customer_visible', 'high_risk', 'irreversible', 'no_idempotency'];
  for (const rule of shortCircuits) {
    it(`says the thresholds decided nothing on a ${rule} run`, async () => {
      const base = await startGuarded(deps({
        listApprovals: async () => oneWaiting(rule),
      }));
      const html = await (await fetch(base + '/approvals')).text();
      expect(html, rule).toContain('before it read');
      expect(html, rule).toContain(rule);
    });
  }

  it('says nothing of the kind when a threshold is what decided', async () => {
    const base = await startGuarded(deps({
      listApprovals: async () => oneWaiting('groundedness_review'),
    }));
    const html = await (await fetch(base + '/approvals')).text();
    expect(html).not.toContain('before it read');
  });
});

// The rail every surface shares (issue #100). Three groups in the reviewer
// design; a group with no surface behind it is left out rather than drawn as
// a heading over nothing.
describe('the rail', () => {
  /** The rail's markup, cut from a rendered page. */
  function railOf(html: string): string {
    const start = html.indexOf('<div class="rail">');
    const end = html.indexOf('<div class="main">');
    expect(start, 'the page draws a rail').toBeGreaterThanOrEqual(0);
    expect(end, 'the rail sits before the main column').toBeGreaterThan(start);
    return html.slice(start, end);
  }

  /** Each group's label and the link titles under it, in page order. */
  function groupsOf(rail: string): [string, string[]][] {
    const groups: [string, string[]][] = [];
    for (const part of rail.split('<div class="navgroup">').slice(1)) {
      const label = /^<div class="lbl">([^<]*)<\/div>/.exec(part)?.[1];
      expect(label, 'every group carries a label').toBeDefined();
      const titles = [...part.matchAll(/<span class="navlabel">([^<]*)<\/span>/g)]
        .map((m) => m[1]!);
      groups.push([label!, titles]);
    }
    return groups;
  }

  it('groups the surfaces as work and administration', async () => {
    const base = await startGuarded(deps());
    const rail = railOf(await (await fetch(base + '/bands')).text());
    expect(groupsOf(rail)).toEqual([
      ['Work', ['Approval queue']],
      ['Admin', ['Runs', 'Control bands', 'Partition latency']],
    ]);
  });

  it('names the product as a support console', async () => {
    const base = await startGuarded(deps());
    const rail = railOf(await (await fetch(base + '/bands')).text());
    expect(rail).toContain('support console');
    expect(rail).not.toContain('operator console');
  });

  // The label shrinks and the badge does not. Without the split a long title
  // wraps inside the rail, and a badge inside the label wraps with it.
  it('keeps the badge outside the label it counts', async () => {
    const base = await startGuarded(deps());
    const rail = railOf(await (await fetch(base + '/approvals')).text());
    expect(rail).toMatch(
      /<a href="\/approvals" class="on"><span class="navlabel">Approval queue<\/span><span class="badge">\d+<\/span><\/a>/,
    );
  });

  describe('the reviewer it names', () => {
    async function footWith(
      identityHeader: string | undefined,
      headers: Record<string, string>,
    ): Promise<string> {
      const base = await startGuarded(deps(), undefined, identityHeader);
      const html = await (await fetch(base + '/bands', { headers })).text();
      const rail = railOf(html);
      const foot = rail.indexOf('<div class="railfoot">');
      expect(foot, 'the rail has a foot').toBeGreaterThanOrEqual(0);
      return rail.slice(foot);
    }

    it('names the person a trusted proxy named, with their initials', async () => {
      const foot = await footWith('x-forwarded-user', { 'x-forwarded-user': 'Ida Lindqvist' });
      expect(foot).toContain('>Ida Lindqvist<');
      expect(foot).toContain('>IL<');
      expect(foot).not.toContain('no reviewer named');
    });

    // DEC-42: no header was named, so any header a caller sent is its own
    // claim and names nobody.
    it('names nobody when the operator named no header', async () => {
      const foot = await footWith(undefined, { 'x-forwarded-user': 'Ida Lindqvist' });
      expect(foot).toContain('no reviewer named');
      expect(foot).not.toContain('Ida Lindqvist');
    });

    it('names nobody when the proxy sent no name', async () => {
      const foot = await footWith('x-forwarded-user', {});
      expect(foot).toContain('no reviewer named');
    });

    // The rail must name the value the ledger would record. A name the
    // approval would store as `unattributed` is not a name to show.
    it('names nobody the ledger would not record', async () => {
      const foot = await footWith('x-forwarded-user', { 'x-forwarded-user': 'a'.repeat(257) });
      expect(foot).toContain('no reviewer named');
      expect(foot).not.toContain('a'.repeat(257));
    });

    it('names nobody when two names arrived as one', async () => {
      const foot = await footWith('x-forwarded-user', { 'x-forwarded-user': 'ops-oncall, mallory' });
      expect(foot).toContain('no reviewer named');
      expect(foot).not.toContain('mallory');
    });

    it('escapes the name it was handed', async () => {
      const foot = await footWith('x-forwarded-user', { 'x-forwarded-user': '<b>ida</b>' });
      expect(foot).toContain('&lt;b&gt;ida&lt;/b&gt;');
      expect(foot).not.toContain('<b>ida</b>');
    });

    // Node reads header bytes as Latin-1. A proxy that sends a name as UTF-8
    // bytes must still reach the rail, and the ledger, as the name it sent.
    it('reads a name a proxy sent as UTF-8 bytes', async () => {
      const utf8AsLatin1 = Buffer.from('Åsa Nyström', 'utf8').toString('latin1');
      expect(utf8AsLatin1).not.toBe('Åsa Nyström');
      const foot = await footWith('x-forwarded-user', { 'x-forwarded-user': utf8AsLatin1 });
      expect(foot).toContain('>Åsa Nyström<');
      expect(foot).toContain('>ÅN<');
    });

    // A header carries Latin-1, so an accented name reaches the rail whole.
    it('takes initials from the first two words of the name', async () => {
      const one = await footWith('x-forwarded-user', { 'x-forwarded-user': 'ops-oncall' });
      expect(one).toContain('>O<');
      const accented = await footWith('x-forwarded-user', { 'x-forwarded-user': 'Åsa Berg Nyström' });
      expect(accented).toContain('>ÅB<');
      expect(accented).toContain('>Åsa Berg Nyström<');
    });
  });
});
