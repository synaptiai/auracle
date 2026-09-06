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
      reason: 'customer_visible', stepsUsed: 4,
      agreement: 0.89, coverage: 0.94, draftExternalId: 'D-1',
    }),
    listApprovals: async () => [{
      runId: RUN, ticketId: 'SYN-1', state: 'awaiting_approval', promptVer: 'p1',
      reason: 'customer_visible', stepsUsed: 4,
      agreement: 0.89, coverage: 0.94, draftExternalId: 'D-1',
    }],
    readBands: async () => [
      { day: '2026-09-04', metric: 'abstain_rate', sample: { value: null, shortfall: 'no_runs' }, verdict: null },
      { day: '2026-09-04', metric: 'gate_pass_rate', sample: { value: 0, shortfall: null }, verdict: 'steady' },
      // A shortfall carried alongside a value. Four of the six codes are this
      // shape, and a first version showed the shortfall only when the value
      // was null, so all four collapsed into a bare number.
      { day: '2026-09-04', metric: 'approval_edit_distance', sample: { value: 7, shortfall: 'thin_window' }, verdict: null },
    ],
    readLatency: async () => [
      { partition: 0, waitP50: '0ms', waitP95: '0ms', serviceP50: '40.4s', serviceP95: '3.0h', runs: 646 },
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

/** A server whose allowlist is fixed to the port it ends up on. */
async function startGuarded(d: ConsoleDeps): Promise<string> {
  const probe = createConsole(d, '.root{}', { allowedHosts: [] });
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  probe.close();
  const server = createConsole(d, '.root{}', {
    allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
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
      // No mean, product or minimum of the two anywhere on the page.
      for (const combined of ['0.915', '0.92', '0.8366']) {
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
    expect(html).toContain('7');
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

  it('serves its own host', async () => {
    const base = await startGuarded(deps());
    expect((await fetch(base + '/')).status).toBe(200);
    expect((await fetch(`http://localhost:${allowedPort}/`)).status).toBe(200);
  });
});
