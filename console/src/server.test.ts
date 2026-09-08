// Every route, against a server with no database (issue #27).
//
// The deps are injected, so these cases drive the real router and the real
// surfaces while the ledger is a stub. What they prove is the routing, the
// two display rules reaching a rendered page, and the write's shape — the
// delegation itself is proved in `approve.test.ts`.
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { request } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { allowedHosts } from './hosts.js';
import { createConsole } from './server.js';
import type { ConsoleDeps } from './server.js';

const RUN = '4f1c2b8e-9d3a-4e77-b0d1-6a5c8e2f1b34';

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
      documents: [
        { position: 1, docId: 'SYN-DOC-01', title: 'Refund policy', kind: 'document', owner: 'support' },
        // An id the journal holds that no document row answers for today.
        { position: 2, docId: 'SYN-DOC-99', title: null, kind: null, owner: null },
      ],
    }),
    listApprovals: async () => [{
      runId: RUN, ticketId: 'SYN-1', state: 'awaiting_approval', promptVer: 'p1',
      reason: 'customer_visible', stepsUsed: 4,
      agreement: 0.89, coverage: 0.94, draftExternalId: 'D-1',
    }],
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

async function startGuarded(d: ConsoleDeps, namedProxy?: string): Promise<string> {
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
      : hostsFor(namedProxy, port),
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
    expect(approve).toHaveBeenCalledWith(RUN);
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
      body: new URLSearchParams({ runId: RUN, finalBody: 'never sent' }).toString(),
      redirect: 'manual',
    });
    expect(approve).toHaveBeenCalledWith(RUN);
    expect(approve.mock.calls[0]).toHaveLength(1);
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
    expect(approve).toHaveBeenCalledWith(RUN);
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
    expect(html).not.toContain('<script>');
    expect(html).toContain('D-1');
  });
});
