// Every route, against a server with no database (issue #27).
//
// The deps are injected, so these cases drive the real router and the real
// surfaces while the ledger is a stub. What they prove is the routing, the
// two display rules reaching a rendered page, and the write's shape — the
// delegation itself is proved in `approve.test.ts`.
import type { AddressInfo } from 'node:net';
import { connect } from 'node:net';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { request } from 'node:http';
import { createHash } from 'node:crypto';

import { COMPENSATION_ACTION_CLASS } from 'auracle/domain';
import { MAX_CLOSE_REASON_CHARS, MAX_SNOOZE_MS, MIN_SNOOZE_MS, replyDigest } from 'auracle/ledger-read';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { escapeHtml, renderGates } from './render.js';
import { whenSays } from './surfaces.js';

import { allowedHosts } from './hosts.js';
import { createConsole } from './server.js';
import { CONSOLE_SCRIPT } from './script.js';
import { UNDO_SAYS } from './surfaces.js';
import type { ReviewerRefusal, ReviewerVerdict } from './reviewer.js';
import { cachedDaily } from './daily-cache.js';
import type { ConsoleDeps } from './server.js';

const RUN = '4f1c2b8e-9d3a-4e77-b0d1-6a5c8e2f1b34';

const CONVERSATION = '99999999-8888-4777-8666-555555555555';

/** The message the waiting run answered, which an approver reads first. */
const REQUEST = {
  conversationId: CONVERSATION,
  turnNumber: 1,
  bodyText: 'There are two charges for the same month.',
  absence: null,
  // Nobody has saved an edit on this case, so the approval would send the
  // body the park journaled (DEC-44), and no approval has reached the turn.
  savedReplyText: null,
  approvedReplyText: null,
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
  // DEC-48: no snooze on the fixture rows unless a case is about one.
  snoozedUntil: null,
  // DEC-47: the product of the channel the message arrived on. Every fixture
  // row carries one unless a case is about the runs whose channel mapped to
  // none, which is what a null says.
  product: 'aurora',
  gateReason: 'customer_visible',
  intentId: 'refund-request',
  gateCoverage: 0.94,
  agreementThreshold: 0.6,
  coverageReviewThreshold: 0.8,
  riskTier: null,
  createdAt: new Date('2026-09-07T09:00:00.000Z'),
  payloadRecorded: false,
  actionClass: 'customer_reply',
  delivery: 'at_least_once',
  payload: null,
  approved: false,
} as const;

/**
 * One run waiting for a person, as the run detail and the case read it.
 *
 * The case reads the same view the run detail does, so a case about the case
 * page overrides this rather than restating it.
 */
const WAITING = {
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
};

/** The case page of the one waiting run. */
const CASE = `/case/${RUN}`;

/** A `readRun` answering the waiting run with some fields changed. */
function caseOf(over: Record<string, unknown>): ConsoleDeps['readRun'] {
  return async () => ({ ...WAITING, ...over }) as never;
}

/**
 * Whether the control a form carries is inside the form itself.
 *
 * The queue's own case reads one action; this reads any, so a second screen
 * that emits a button after its `</form>` fails here rather than in a browser.
 */
function buttonInForm(html: string, action: string): boolean {
  const open = html.indexOf(`<form method="post" action="${action}"`);
  const close = html.indexOf('</form>', open);
  const button = html.indexOf('type="submit"', open);
  return open >= 0 && close > open && button > open && button < close;
}

/**
 * Whether the batch's confirm button is inside the form it submits.
 *
 * Parsed, not matched: the defect this guards is an ordering one, and a
 * substring check for `<form` beside the button is true of both orders. The
 * walk counts open and close tags, so it reads the nesting a browser reads.
 */
function buttonOwnsItsForm(html: string): boolean {
  const open = html.indexOf('<form method="post" action="/confirm"');
  const close = html.indexOf('</form>', open);
  const button = html.indexOf('data-batch-confirm', open);
  return open >= 0 && close > open && button > open && button < close;
}

function deps(overrides: Partial<ConsoleDeps> = {}): ConsoleDeps {
  return {
    listRuns: async () => [
      { runId: RUN, ticketId: 'SYN-1', state: 'resolved', promptVer: 'p1', ...ROW, reason: null, stepsUsed: 4 },
    ],
    readRun: async () => WAITING,
    listApprovals: async () => [{
      runId: RUN, ticketId: 'SYN-1', state: 'awaiting_approval', promptVer: 'p1', ...ROW,
      reason: 'customer_visible', stepsUsed: 4,
      agreement: 0.89, coverage: 0.94, draftExternalId: 'D-1',
    }],
    readConversation: async () => ({
      conversationId: CONVERSATION,
      primaryTicketId: 'SYN-1',
      state: 'open',
      openedAt: new Date('2026-09-06T08:00:00.000Z'),
      participantNamed: true,
      turns: [
        {
          turnNumber: 1, ticketId: 'SYN-1',
          createdAt: new Date('2026-09-06T08:00:00.000Z'),
          bodyText: 'There are two charges for the same month.',
          messageAbsence: null,
          replyText: 'We refunded the duplicate charge.',
          replyAbsence: null,
          runId: RUN, runState: 'resolved', runAttempts: 1, outboxStatus: 'sent',
        },
        {
          turnNumber: 2, ticketId: 'SYN-1',
          createdAt: new Date('2026-09-07T14:32:00.000Z'),
          bodyText: null, messageAbsence: 'not_retained',
          replyText: null, replyAbsence: 'awaiting_approval',
          runId: RUN, runState: 'awaiting_approval', runAttempts: 1, outboxStatus: null,
        },
      ],
    }),
    // DEC-44: the console's second write, and the two reads its callout and
    // its refusal need. None of them reaches the ledger in these cases.
    saveReply: async () => 'saved',
    readCopy: async () => null,
    readDocumentBody: async () => null,
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
    // DEC-48: the case a reviewer finishes with no reply. The transaction,
    // the reason's rules and the hold are the core suite's subject; here the
    // harness answers that a case was closed.
    close: async () => 'closed',
    // DEC-48: the case a reviewer puts aside. The period's bounds and the
    // returner are the core suites' subject; here the harness answers that a
    // case was put aside.
    snooze: async () => 'snoozed',
    // DEC-51: the batch's way back. The window and the row lock are the core
    // suite's subject; here the harness answers that a case was taken back.
    undo: async () => ({ outcome: 'undone' }),
    // DEC-51: the window a page counts. The harness answers that a send is
    // held for the configured period, unless a case overrides it.
    readApprovalHold: async () => ({ held: true, remainingMs: 12_000, status: 'pending' }),
    // DEC-45: the gate resolves this before any page is built. The default is
    // an active reviewer, so a case about a surface is not also a case about
    // the gate; the gate's own cases override it.
    reviewerFor: async () => ({ reviewer: REVIEWER }),
    // DEC-46: the case hold. The default is an unheld case whose takes and
    // releases succeed, so a case about a surface is not also a case about
    // the hold; the hold's own cases override these.
    // DEC-47: the products this request's reviewer covers. Empty by default,
    // so the queue's order is the ledger's own and a case about the order
    // says which products it means.
    readReviewerProducts: async () => [],
    // DEC-47: what each product is called. The shipped catalogue's two, so a
    // case about a chip reads the label an operator would see.
    productLabels: new Map([['aurora', 'Aurora'], ['ledger', 'Ledger']]),
    readHold: async () => null,
    readHolds: async () => new Map(),
    takeHold: async () => ({ outcome: 'taken' }),
    releaseHold: async () => ({ outcome: 'released' }),
    handoverHold: async () => ({ outcome: 'handed_over' }),
    readQueueToday: async () => ({ day: '2026-09-14', arrived: 3, reachedQueue: 1 }),
    ...overrides,
  };
}

// Every server a test starts, closed after it. A test that starts several
// would otherwise leave all but the last one listening.
const opened: Server[] = [];
afterEach(() => {
  for (const server of opened.splice(0)) server.close();
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
/** DEC-45: the reviewer the gate resolves, unless a case says otherwise. */
const REVIEWER = 'synthetic-reviewer@example.test';

/**
 * DEC-46: the digest of the reply the page drew, as the approval form carries
 * it. Every console approval carries one — the route refuses a post without a
 * digest — and the approval's own comparison against the ledger is proved in
 * its database suite. Any 64 hex characters do here.
 */
const SHOWN = 'c'.repeat(64);

/**
 * DEC-51: the hold this harness's console applies to a batch. The default
 * period, so a case asserting the words the page promises reads the shipped
 * number rather than one this suite invented.
 */
const SEND_HOLD_MS = 12_000;

/**
 * A refusal from the gate, for a case about what the console does with one.
 *
 * The resolver's own cases live in `reviewer.test.ts`; here the gate only has
 * to refuse, log the reason it was given, and build no page.
 */
function refuses(
  detail: ReviewerRefusal['detail'],
  said = '',
  lines = 0,
): ReviewerVerdict {
  return { refusal: { detail, header: 'x-forwarded-user', said, lines } };
}

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
  readBack?: string,
  ledgerReply = false,
): Promise<string> {
  const probe = createConsole(d, '.root{}', {
    allowedHosts: [], readBack: null, states: [...STATES], ledger: LEDGER, ledgerReply,
    sendHoldMs: SEND_HOLD_MS,
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
    readBack: readBack ?? null,
    states: [...STATES],
    ledger: LEDGER,
    ledgerReply,
    sendHoldMs: SEND_HOLD_MS,
  });
  opened.push(server);
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  allowedPort = port;
  return `http://127.0.0.1:${port}`;
}

describe('the console routes', () => {
  it('serves every surface', async () => {
    const base = await startGuarded(deps());
    for (const [path, marker] of [
      ['/', 'Needs a person'],
      ['/runs', 'Runs'],
      [`/run/${RUN}`, 'Run detail'],
      [CASE, 'Why this is yours'],
      ['/bands', 'Control bands'],
      ['/latency', 'Partition latency'],
      ['/notes', 'Why the console works this way'],
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
    for (const path of [`/run/${RUN}`, CASE]) {
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
    expect((await fetch(`${base}${CASE}`)).status).toBe(404);
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
      body: new URLSearchParams({ shown: SHOWN, runId: RUN }).toString(),
      redirect: 'manual',
    });
    expect(res.status).toBe(303);
    expect(approve).toHaveBeenCalledWith(RUN, REVIEWER, SHOWN);
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
        runId: RUN, finalBody: 'never sent', approvedBy: 'not-from-a-form', shown: SHOWN,
      }).toString(),
      redirect: 'manual',
    });
    // Three arguments and no more: the run id, the reviewer the gate resolved
    // against the roster (DEC-45), and the digest of the reply this console
    // drew (DEC-46). Not one of them comes from the form's text. A body posted
    // here would be recorded as the approved reply while the relay sent the
    // parked draft, and a reviewer taken from a form is a name anyone can
    // type.
    expect(approve).toHaveBeenCalledWith(RUN, REVIEWER, SHOWN);
    expect(approve.mock.calls[0]).toHaveLength(3);
  });

  // And the page offers no way to type one.
  it('offers no reply box on the case', async () => {
    const base = await startGuarded(deps());
    const html = await (await fetch(base + CASE)).text();
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('finalBody');
    // It says where the editing happens instead.
    expect(html).toContain('helpdesk');
  });

  // A malformed id is a path nobody has, not a fault. `run_id` is a `uuid`
  // column, so without a shape check Postgres raises and the route answers
  // 500 — spending a pool connection on a page a reviewer was reading, and
  // contradicting the route's own 404 contract.
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
      for (const surface of ['/run/', '/case/']) {
        const res = await fetch(`${base}${surface}${bad}`);
        expect(res.status, `${surface}${bad}`).toBe(404);
      }
    }
    expect(readRun).not.toHaveBeenCalled();
  });

  // What a person needs to decide, rather than an id and a button (DEC-12).
  it('shows the ticket, the state and the reason on the case', async () => {
    const base = await startGuarded(deps());
    const html = await (await fetch(base + CASE)).text();
    expect(html).toContain('SYN-1');
    expect(html).toContain('awaiting_approval');
  });

  it('offers no approve form for a run that parked nothing at all', async () => {
    const base = await startGuarded(deps({
      readRun: caseOf({ reason: null, draftExternalId: null, payloadRecorded: false }),
    }));
    const html = await (await fetch(base + CASE)).text();
    // The approval, not "a form": since DEC-46 the case also carries the
    // take control, and a page with a hold bar has a form on it.
    expect(html).not.toContain('action="/approve"');
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
      body: new URLSearchParams({ shown: SHOWN, runId: RUN }).toString(),
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
        body: new URLSearchParams({ shown: SHOWN, runId: RUN }).toString(),
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
      body: new URLSearchParams({ shown: SHOWN, runId: RUN }).toString(),
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
      body: new URLSearchParams({ shown: SHOWN, runId: RUN }).toString(),
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
      body: new URLSearchParams({ shown: SHOWN, runId: RUN }).toString(),
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
      body: new URLSearchParams({ shown: SHOWN, runId: RUN }).toString(),
      redirect: 'manual',
    });
    expect(res.status).toBe(303);
    expect(approve).toHaveBeenCalledWith(RUN, REVIEWER, SHOWN);
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

    const pageRes = await fetch(base + '/');
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
      body: new URLSearchParams({ shown: SHOWN, runId: RUN }).toString(),
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
      const res = await fetch(base + '/runs');
      const html = await res.text();
      expect(res.status).toBe(500);
      expect(html).not.toContain('ada@customer.example');
      // Worded for any page, since some pages read no ledger at all.
      expect(html).toMatch(/Something failed while answering this page\. The console log names it [0-9a-f]{8}\./);
      // The operator can still find it, because they read the log already.
      expect(logged.join('\n')).toContain(secret);
    } finally {
      spy.mockRestore();
    }
  });

  // A conversation holds no approval, so a fault reading it fails the page
  // rather than drawing a thread the ledger could not answer for. The reader
  // throws on an outbox status outside its set, and this is where that lands.
  it('fails a conversation the reader cannot read, with a tag and no fault text', async () => {
    const secret = 'outbox status bounced is not one of pending, sent';
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
    try {
      const base = await startGuarded(deps({
        readConversation: async () => { throw new Error(secret); },
      }));
      const res = await fetch(`${base}/conversation/${CONVERSATION}`);
      const html = await res.text();
      expect(res.status).toBe(500);
      expect(html).not.toContain('bounced');
      expect(html).toMatch(/console log names it [0-9a-f]{8}/);
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
      await fetch(base + '/runs');
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
        body: `runId=${RUN}&shown=${SHOWN}`,
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

  // The log line stays bounded whatever the reviewer is. DEC-42 bounds a
  // name the ledger would keep at 256 characters, and the gate refuses a
  // value it would not keep, so a reviewer reaching this route is short by
  // construction. The prefix and the length hold the line short anyway: the
  // console's log is not the place to learn that an upstream bound moved.
  it('logs a bounded prefix and the length of the reviewer it recorded', async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
    try {
      const long = 'b'.repeat(200);
      const base = await startGuarded(deps({
        approve: async () => 'approved',
        reviewerFor: async () => ({ reviewer: long }),
      }));
      await fetch(base + '/approve', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'sec-fetch-site': 'same-origin',
        },
        body: `runId=${RUN}&shown=${SHOWN}`,
        redirect: 'manual' as const,
      });
      const line = logged.find((entry) => entry.includes('console_approved'));
      expect(line).toBeDefined();
      expect(line!.length).toBeLessThan(1_000);
      const record = JSON.parse(line!) as Record<string, unknown>;
      expect(record['reviewer']).toBe('b'.repeat(64));
      expect(record['reviewerLength']).toBe(200);
      // The ledger recorded the whole name, so the log names the whole one.
      expect(record['approvedBy']).toBe(long);
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
      // Ten code points, twenty UTF-16 units. DEC-42 keeps no emoji in a
      // name, so the gate would refuse this one; the case drives the log
      // itself, because the count is the console's own.
      const claim = String.fromCodePoint(0x1f600).repeat(10);
      const base = await startGuarded(deps({
        approve: async () => 'approved',
        reviewerFor: async () => ({ reviewer: claim }),
      }));
      await fetch(base + '/approve', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'sec-fetch-site': 'same-origin',
        },
        body: `runId=${RUN}&shown=${SHOWN}`,
        redirect: 'manual' as const,
      });
      const record = JSON.parse(logged.find((entry) => entry.includes('console_approved')) ?? '{}') as Record<string, unknown>;
      expect(record['reviewer']).toBe(claim);
      expect(record['reviewerLength']).toBe(10);
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

  // Nothing was recorded when the approval did not happen, so the log names
  // no recorded approver for it.
  // The log names the reviewer the gate resolved, and the name the ledger
  // recorded, which is that same name and only when the approval committed.
  // An approval that answered anything else wrote no approver to the ledger,
  // and the log must not read as though one were written.
  //
  // A claim and a record cannot differ here, which is what used to need its
  // own case: the gate refuses a value DEC-42 would reduce to
  // `unattributed`, so the reviewer reaching this route is always a name the
  // ledger keeps. `reviewer.test.ts` holds that refusal.
  it('names no recorded approver when the approval did not happen', async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
    try {
      const base = await startGuarded(deps({
        approve: async () => 'unknown_run',
        reviewerFor: async () => ({ reviewer: 'ops-oncall' }),
      }));
      await fetch(base + '/approve', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'sec-fetch-site': 'same-origin',
        },
        body: `runId=${RUN}&shown=${SHOWN}`,
        redirect: 'manual' as const,
      });
      const record = JSON.parse(logged.find((entry) => entry.includes('console_approved')) ?? '{}') as Record<string, unknown>;
      expect(record['outcome']).toBe('unknown_run');
      expect(record['reviewer']).toBe('ops-oncall');
      expect(record['approvedBy']).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  // The claimed approver comes from a header, as raw bytes. Bytes that decode
  // to NEL and the Unicode line separator must not break the approval line.
  // The reviewer is a name from outside this process, and JSON leaves NEL and
  // the Unicode line separator raw, so one record could read as two entries.
  // DEC-42 keeps no such character in a name, so the gate would answer 403
  // here and the case drives the log itself: this is the console's own bound
  // on its own line, not the gate's.
  it('keeps the approval record on one line whatever the name carried', async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
    try {
      const claim = 'ops' + String.fromCharCode(0x2028, 0x85) + 'mallory';
      const base = await startGuarded(deps({
        approve: async () => 'approved',
        reviewerFor: async () => ({ reviewer: claim }),
      }));
      await fetch(base + '/approve', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'sec-fetch-site': 'same-origin',
        },
        body: `runId=${RUN}&shown=${SHOWN}`,
        redirect: 'manual' as const,
      });
      const line = logged.find((entry) => entry.includes('console_approved'));
      expect(line).toBeDefined();
      for (const code of [0x85, 0x2028]) {
        expect(line, `U+${code.toString(16)}`).not.toContain(String.fromCharCode(code));
      }
      const record = JSON.parse(line ?? '{}') as Record<string, unknown>;
      expect(record['reviewer']).toBe(claim);
      expect(record['approvedBy']).toBe(claim);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the reply an approver reads before they send it', () => {
  // DEC-40 permits this console to approve a parked draft. It drew the button
  // above a reply the approver could not read, which is the defect this whole
  // surface exists to fix.
  it('shows the drafted reply on the case', async () => {
    const base = await startGuarded(deps());
    const html = await (await fetch(base + CASE)).text();
    expect(html).toContain('The reply, as the system drafted it');
    expect(html).toContain('We refunded the duplicate charge.');
  });

  it('shows the same reply on the run detail, from the same builder', async () => {
    const base = await startGuarded(deps());
    const detail = await (await fetch(`${base}/run/${RUN}`)).text();
    const decided = await (await fetch(base + CASE)).text();
    for (const claim of [
      'We refunded the duplicate charge.',
      'Your bank decides when it lands.',
      'Your subscription is unchanged.',
    ]) {
      expect(detail, 'run detail').toContain(claim);
      expect(decided, 'case').toContain(claim);
    }
  });

  // Three states, and each is a different fact. A claim nobody judged is not
  // a claim the judge refused, and drawing it as one would put a warning on a
  // run the ledger never questioned.
  it('marks a refused claim, and does not mark an unjudged one as refused', async () => {
    const base = await startGuarded(deps());
    const html = await (await fetch(base + CASE)).text();
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
    const html = await (await fetch(base + CASE)).text();
    expect(html).toContain('1 of 3 claims cite a document that does not support them');
    // 0.333 is what a recount of these marks would produce.
    expect(html).not.toContain('0.333');
    expect(html).not.toContain('0.667');
  });

  it('links each claim to the document it cites', async () => {
    const base = await startGuarded(deps());
    const html = await (await fetch(base + CASE)).text();
    expect(html).toContain('href="#src-SYN-DOC-01"');
    expect(html).toContain('id="src-SYN-DOC-01"');
    expect(html).toContain('The documents these claims cite');
    // And each source opens.
    expect(html).toContain('href="/document/SYN-DOC-01"');
  });

  it('says a cited document is gone rather than printing its id as a title', async () => {
    const base = await startGuarded(deps());
    const html = await (await fetch(base + CASE)).text();
    expect(html).toContain('no such document today');
  });

  // The relay sends the helpdesk copy, which a person may have edited since
  // (DEC-11). "as the system drafted it" is the honest heading, and the
  // warning beside the button says which copy goes out.
  it('does not claim the drafted reply is what will be sent', async () => {
    const base = await startGuarded(deps());
    const html = await (await fetch(base + CASE)).text();
    expect(html).not.toContain('The reply as it will be sent');
    expect(html).toContain('a person may have changed it since');
  });

  // Three cases, and this surface drew two. `approveRun` relays a ledger-only
  // park through its journalled payload (DEC-34), so such a run has always
  // been approvable — the console offered no button and a third of the queue
  // was a dead end on the page built to clear it.
  it('offers no approve button for a run that parked neither a draft nor a payload', async () => {
    const base = await startGuarded(deps({
      readRun: caseOf({ reason: 'irreversible', draftExternalId: null, payloadRecorded: false }),
    }));
    const html = await (await fetch(base + CASE)).text();
    expect(html).toContain('neither a helpdesk draft nor an action payload');
    expect(html).not.toContain('action="/approve"');
    // DEC-48: the close is still offered. This is the dead end the outcome
    // exists to end — nobody can approve it, and somebody has to finish it.
    expect(buttonInForm(html, '/close')).toBe(true);
    expect(html).toContain('Close, no reply');
  });

  // `compensate` is the class the policy engine judges irreversible, and a
  // seeded queue holds it. An earlier case used a class this system has no
  // name for, so the branch that matters was never exercised.
  it('approves a ledger-parked action, and names what it will perform (DEC-34)', async () => {
    const base = await startGuarded(deps({
      readRun: caseOf({ reason: null, gateReason: 'high_risk', policyReason: 'high_risk', draftExternalId: null, payloadRecorded: true, actionClass: 'route_ticket' }),
    }));
    const html = await (await fetch(base + CASE)).text();
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
        readRun: caseOf({ reason: null, gateReason: rule, policyReason: rule, draftExternalId: null, payloadRecorded: true, actionClass: 'compensate', delivery: 'at_most_once' }),
      }));
      const html = await (await fetch(base + CASE)).text();
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
      readRun: caseOf({ reason: null, gateReason: 'irreversible', policyReason: 'irreversible', draftExternalId: null, payloadRecorded: true, actionClass: 'compensate', delivery: 'at_most_once', payload: { amountMicros: 4200, ticket: 'SYN-1', reason: 'duplicate charge' } }),
    }));
    const html = await (await fetch(base + CASE)).text();
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
      readRun: caseOf({ reason: null, gateReason: 'irreversible', policyReason: 'irreversible', draftExternalId: null, payloadRecorded: true, actionClass: 'compensate', delivery: 'at_most_once', payload: null }),
    }));
    const html = await (await fetch(base + CASE)).text();
    expect(html).toContain('recorded no payload for it');
  });

  // A draft-backed park's act is the reply above it, so there is no payload
  // block to draw.
  it('draws no payload block for a run that parked a reply', async () => {
    const html = await (await fetch((await startGuarded(deps())) + CASE)).text();
    expect(html).not.toContain('What approving this performs');
  });

  // And the sentence is about the delivery rule, not about the class. A
  // reversible action delivered at least once gets neither claim.
  it('claims neither permanence nor at-most-once for a routing action', async () => {
    const base = await startGuarded(deps({
      readRun: caseOf({ reason: null, gateReason: 'irreversible', policyReason: 'irreversible', draftExternalId: null, payloadRecorded: true, actionClass: 'route_ticket', delivery: 'at_least_once' }),
    }));
    const html = await (await fetch(base + CASE)).text();
    expect(html).not.toContain('cannot be undone');
    expect(html).not.toContain('escalates rather than repeating');
  });

  // The warning is about the act, so the two acts do not share one. A reply
  // reaches a person who cannot unread it.
  it('warns that a sent reply cannot be recalled, on the draft path alone', async () => {
    const html = await (await fetch(
      (await startGuarded(deps())) + CASE,
    )).text();
    expect(html).toContain('Approve and send');
    expect(html).toContain('cannot be recalled');
    expect(html).not.toContain('No reply goes to a customer.');
  });

  // The queue is uncapped by design, so a journal read per row would be one
  // statement for every run of a list that has been 476 long. The case reads
  // one run's journal, and the queue reads none.
  it('reads no run on the queue, and reads the one run a case names', async () => {
    const readRun = vi.fn(async () => WAITING);
    const base = await startGuarded(deps({ readRun: readRun as never }));
    await fetch(base + '/');
    expect(readRun).not.toHaveBeenCalled();
    await fetch(base + CASE);
    expect(readRun.mock.calls).toEqual([[RUN]]);
  });
});

describe('the message a reply answers', () => {
  // The epic's first criterion, and the last of it to ship. An approver who
  // reads a reply, its claims and its sources still cannot tell whether it
  // answers the question — which is the shape of the defect this surface was
  // built to fix, one step along.
  it('shows the customer\'s message on the case', async () => {
    const base = await startGuarded(deps());
    const html = await (await fetch(base + CASE)).text();
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
    const html = await (await fetch(base + CASE)).text();
    expect(html).toContain(`/conversation/${CONVERSATION}`);
  });

  it('names a message nobody kept, rather than drawing a blank', async () => {
    const base = await startGuarded(deps({
      readRun: caseOf({ request: { ...REQUEST, bodyText: null, absence: 'not_retained' } }),
    }));
    const html = await (await fetch(base + CASE)).text();
    expect(html).toContain('the text of this message was not kept');
  });

  // A run that answered no turn is not a turn whose text nobody kept. Drawing
  // an absence about a turn that never existed would name a fact the ledger
  // does not hold.
  it('draws nothing at all for a run that answered no turn', async () => {
    const base = await startGuarded(deps({
      readRun: caseOf({ request: null }),
    }));
    const html = await (await fetch(base + CASE)).text();
    expect(html).not.toContain('The message this answers');
    expect(html).not.toContain('the text of this message was not kept');
    // The reply is still there.
    expect(html).toContain('The reply, as the system drafted it');
  });

  // The name said "from the same builder", and the suite injects the request
  // into `readRun` — so it could not check that. What it can check is that
  // both surfaces render the same message identically, which is the property
  // a reader cares about.
  it('renders the same message on both surfaces', async () => {
    const base = await startGuarded(deps());
    const detail = await (await fetch(`${base}/run/${RUN}`)).text();
    const decided = await (await fetch(base + CASE)).text();
    for (const html of [detail, decided]) {
      expect(html).toContain('The message this answers');
      expect(html).toContain('There are two charges for the same month.');
    }
  });
});

describe('the evidence states that are not a list of claims', () => {
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

  async function caseWith(raw: unknown): Promise<string> {
    const evidence = withPartition(raw);
    const base = await startGuarded(deps({ readRun: caseOf({ evidence }) }));
    return (await fetch(base + CASE)).text();
  }

  // An unmeasured count is never a zero. With no retrieval journalled the
  // denominator was invented from an absence, and every cited document was
  // labelled gone — a positive claim about an index nothing was compared to.
  it('does not invent a retrieved count from a retrieval it does not have', async () => {
    const html = await caseWith({
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
    const html = await caseWith({
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
    const html = await caseWith({
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
    const html = await caseWith({
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
    const html = await caseWith(COURTEOUS);
    expect(html).toContain('<span class="courtesy">Thanks for writing in.</span>');
    expect(html).toContain('<span class="courtesy">Reply here if it helps.</span>');
  });

  // The whole reply, in the composer's order. Rendering the claims and
  // appending the courtesy sentences would put them in an order the composer
  // never chose, and the order is the reply.
  it('draws the reply in draft order, courtesy sentences in place', async () => {
    const html = await caseWith(COURTEOUS);
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
    const html = await caseWith(COURTEOUS);
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
    const html = await caseWith(COURTEOUS);
    expect(html).toContain('every claim of 1 carries a document the judge accepted');
    expect(html).toContain('2 further sentences open or close the reply and cite nothing');
  });

  // The verdict is recorded by position among the cited sentences. A reply
  // opening with a courtesy sentence must not shift the verdict onto the
  // sentence after it.
  it('numbers a citation by its position among the claims, not in the reply', async () => {
    const html = await caseWith(COURTEOUS);
    expect(html).toContain('id="claim-0"');
    expect(html).not.toContain('id="claim-1"');
    expect(html).toContain('>1</a>');
  });

  // Reachable in production: one unreadable member makes the whole partition
  // null while `park.draftBody` survives. The reply is still shown, and the
  // console says the citations are not available for it — which is a
  // different fact from the reply having none.
  it('shows a reply whose partition could not be read, and says so', async () => {
    const html = await caseWith({
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
    const html = await caseWith({
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
    const html = await caseWith({
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
    const html = await caseWith({
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
    const one = await caseWith({
      draftBody: 'a reply', documentsMalformed: false, documents: [],
      sentences: [
        { text: 'A charge is refundable.', docId: 'SYN-DOC-01', claimIndex: 0, supported: true },
        { text: 'Reply here if that helps.', docId: null, claimIndex: null, supported: null },
      ],
      claims: [{ index: 0, text: 'A charge is refundable.', docId: 'SYN-DOC-01', supported: true }],
    });
    expect(one).toContain('1 further sentence opens or closes the reply and cites nothing');

    const none = await caseWith({
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
    const html = await caseWith({
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
    expect(html).toContain('this turn waits for a person to approve it');
  });

  it('says a participant is named without naming them', async () => {
    const base = await startGuarded(deps());
    const html = await (await fetch(`${base}/conversation/${CONVERSATION}`)).text();
    expect(html).toContain('participant named');
    expect(html).not.toContain('no participant named');
    // Not an escaping claim: `ThreadView` carries no address at all, so no
    // input to this surface could produce one. The guard belongs where the
    // address is actually dropped, which is `readConversation`'s own mapping
    // in `main.ts`, and `conversation.db.test.ts` holds it there.
  });

  /** A turn of the thread below, with the fields each case changes. */
  function turnOf(n: number, over: Record<string, unknown>): Record<string, unknown> {
    return {
      turnNumber: n, ticketId: 'SYN-1',
      // A day and an hour apart per turn, so no two turns share a stamp and
      // none shares the conversation's own opening time.
      createdAt: new Date(Date.UTC(2026, 8, 1 + n, 8 + n, 10 + n)),
      bodyText: `Message ${n}.`, messageAbsence: null,
      replyText: null, replyAbsence: null,
      // Sent, so a resolved turn reads as delivered unless a case says not.
      runId: RUN, runState: 'resolved', runAttempts: 1, outboxStatus: 'sent',
      ...over,
    };
  }

  /** Each turn block of a page, keyed by the number it draws. */
  function turnBlocks(html: string): Map<number, string> {
    const blocks = new Map<number, string>();
    for (const part of html.split('<div class="turn">').slice(1)) {
      const n = /turn (\d+)</.exec(part);
      expect(n, 'a turn block names its number').not.toBeNull();
      blocks.set(Number(n![1]), part);
    }
    return blocks;
  }

  const THREAD = {
    conversationId: CONVERSATION,
    primaryTicketId: 'SYN-1',
    state: 'open',
    openedAt: new Date('2026-08-30T06:00:00.000Z'),
    participantNamed: false,
    turns: [
      turnOf(1, { replyAbsence: 'handled_automatically' }),
      turnOf(2, { replyText: 'We refunded the duplicate charge.' }),
      turnOf(3, { replyAbsence: 'approved_without_reply' }),
      // No outbox row on a run still working, a run with no turn joined or a
      // parked draft. An escalated run stopped before its send was known.
      turnOf(4, { replyAbsence: 'in_flight', runState: 'composed', outboxStatus: null }),
      turnOf(5, { replyAbsence: 'no_reply_sent', runState: 'escalated', outboxStatus: 'delivery_unknown' }),
      turnOf(6, { replyAbsence: 'not_retained', runId: null, runState: null, runAttempts: 0, outboxStatus: null }),
      turnOf(7, { replyAbsence: 'awaiting_approval', runState: 'awaiting_approval', outboxStatus: null }),
    ],
  };

  // The chip is read from what the ledger holds about the turn. A resolved
  // run a person approved is not an automatic answer, and a turn no run
  // joins is not either: calling them that would claim the system answered
  // alone where it did not.
  it('gives each turn an outcome chip read from what the ledger holds', async () => {
    const base = await startGuarded(deps({ readConversation: async () => THREAD as never }));
    const blocks = turnBlocks(await (await fetch(`${base}/conversation/${CONVERSATION}`)).text());
    expect([...blocks.keys()]).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const says = (n: number): string => /<span class="chip[^"]*"[^>]*>([^<]*)<\/span>/.exec(blocks.get(n)!)![1]!;
    expect(says(1)).toBe('auto-answered');
    expect(says(2)).toBe('approved');
    expect(says(3)).toBe('approved');
    expect(says(4)).toBe('in flight');
    // The relay's row joins a stopped run's state, so neither hides the other.
    expect(says(5)).toBe('escalated · delivery_unknown');
    expect(says(6)).toBe('no run');
    expect(says(7)).toBe('waiting for you');
    // Only the automatic turn is called automatic.
    for (const n of [2, 3, 4, 5, 6, 7]) expect(blocks.get(n)).not.toContain('auto-answered');
    expect(blocks.get(1)).toContain('color:var(--ok)');
    expect(blocks.get(4)).toContain('<span class="chip" style="color:var(--dim)">in flight</span>');
    expect(blocks.get(5)).toContain('<span class="chip" style="color:var(--hot)">escalated · delivery_unknown</span>');
    expect(blocks.get(7)).toContain('color:var(--warn)');
  });

  // DEC-48: a case a person closed with no reply. Its own chip and its own
  // sentence, because the two labels beside it are both wrong about this
  // turn: the system did not answer it, and nobody approved an action on it.
  it('draws a closed case as its own absence, in its own words', async () => {
    const base = await startGuarded(deps({
      readConversation: async () => ({
        ...THREAD,
        turns: [turnOf(1, { replyAbsence: 'closed_without_reply', runState: 'closed', outboxStatus: null })],
      }) as never,
    }));
    const blocks = turnBlocks(await (await fetch(`${base}/conversation/${CONVERSATION}`)).text());
    const block = blocks.get(1)!;
    expect(block).toContain('<span class="chip" style="color:var(--dim)">closed, no reply</span>');
    expect(block).toMatch(
      /<p class="absent">a person closed this case without replying to the customer<\/p>/,
    );
    // Not the two sentences that would each be untrue here.
    expect(block).not.toContain('no reply was sent to the customer');
    expect(block).not.toContain('approved an action here');
    expect(block).not.toContain('the system replied');
  });

  // DEC-48: a case a person put aside for a period. The state's own word
  // would be readable, but the chip would then say a case nobody has got to
  // yet, which is the opposite of what happened to it.
  it('draws a case a person put aside as its own absence', async () => {
    const base = await startGuarded(deps({
      readConversation: async () => ({
        ...THREAD,
        turns: [turnOf(1, { replyAbsence: 'put_aside', runState: 'snoozed', outboxStatus: null })],
      }) as never,
    }));
    const blocks = turnBlocks(await (await fetch(`${base}/conversation/${CONVERSATION}`)).text());
    const block = blocks.get(1)!;
    expect(block).toContain('<span class="chip" style="color:var(--dim)">put aside</span>');
    expect(block).toMatch(
      /<p class="absent">a person put this case aside until its period ends<\/p>/,
    );
    expect(block).not.toContain('in flight');
  });

  // A stopped run names its state. Only an escalation, or a row that confirms
  // nothing, asks a person to look, so only those draw hot.
  // `abandoned` is in the ledger's terminal set, though no writer sets it
  // today: the consumer files an abandonment as `escalated`. It stands here for
  // any stopped state that is not an escalation.
  it('draws a stopped run hot only when it escalated or its row confirms nothing', async () => {
    const base = await startGuarded(deps({
      readConversation: async () => ({
        ...THREAD,
        turns: [
          turnOf(1, { replyAbsence: 'no_reply_sent', runState: 'abandoned', outboxStatus: null }),
          turnOf(2, { replyAbsence: 'no_reply_sent', runState: 'abandoned', outboxStatus: 'fenced' }),
          turnOf(3, { replyAbsence: 'in_flight', runState: 'composed', outboxStatus: 'sent' }),
          turnOf(4, { replyText: 'We refunded the duplicate charge.', runState: 'abandoned', outboxStatus: null }),
          // With reply text the row still joins the state, and still draws hot.
          turnOf(5, { replyText: 'We refunded the duplicate charge.', runState: 'abandoned', outboxStatus: 'fenced' }),
          turnOf(6, { replyText: 'We refunded the duplicate charge.', runState: 'classified', outboxStatus: 'delivery_unknown' }),
        ],
      }) as never,
    }));
    const blocks = turnBlocks(await (await fetch(`${base}/conversation/${CONVERSATION}`)).text());
    expect(blocks.get(1)).toContain('<span class="chip" style="color:var(--dim)">abandoned</span>');
    expect(blocks.get(2)).toContain('<span class="chip" style="color:var(--hot)">abandoned · fenced</span>');
    // A retry still running, on a turn an earlier run already answered.
    expect(blocks.get(3)).toContain('<span class="chip" style="color:var(--dim)">in flight · sent</span>');
    expect(blocks.get(4)).toContain('<span class="chip" style="color:var(--dim)">approved · abandoned</span>');
    expect(blocks.get(4)).toContain('<div class="who">a person approved this reply</div>');
    expect(blocks.get(5)).toContain('<span class="chip" style="color:var(--hot)">approved · abandoned · fenced</span>');
    expect(blocks.get(6)).toContain('<span class="chip" style="color:var(--hot)">approved · classified · delivery_unknown</span>');
    expect(blocks.get(6)).toContain('<div class="who">approved, delivery not confirmed</div>');
  });

  // A retry of the same action loses the insert and stops superseded with no
  // row (section 4.2, rule 2). The row an earlier run holds is its outcome, so
  // the turn reads as that row says and not as a run that sent nothing.
  it('reads a superseded retry by the row an earlier run holds', async () => {
    const reply = 'We refunded the duplicate charge.';
    const base = await startGuarded(deps({
      readConversation: async () => ({
        ...THREAD,
        turns: [
          turnOf(1, { replyAbsence: 'no_reply_sent', runState: 'superseded', outboxStatus: 'sent' }),
          // A repeat approval supersedes before it writes, so the text is the
          // earlier approval's, and so is the row.
          turnOf(2, { replyText: reply, runState: 'superseded', outboxStatus: 'sent' }),
          // The relay refused this row before any send, so nothing went out.
          turnOf(3, { replyAbsence: 'no_reply_sent', runState: 'escalated', outboxStatus: 'malformed' }),
          // A retry that stopped, beside an earlier run's row the relay still holds.
          turnOf(4, { replyAbsence: 'no_reply_sent', runState: 'escalated', outboxStatus: 'pending' }),
          // The relay escalated this run's own send, which may have landed.
          turnOf(5, { replyAbsence: 'no_reply_sent', runState: 'escalated', outboxStatus: 'delivery_unknown' }),
        ],
      }) as never,
    }));
    const blocks = turnBlocks(await (await fetch(`${base}/conversation/${CONVERSATION}`)).text());
    expect(blocks.get(1)).toContain('<span class="chip" style="color:var(--dim)">superseded · sent</span>');
    // The chip and the sentence agree: the retry stopped, and the send went out.
    expect(blocks.get(1)).toContain(
      '<p class="absent">the run stopped; the action recorded on this turn was sent</p>',
    );
    // The row on a turn with no reply text is an action, not a customer reply.
    expect(blocks.get(1)).not.toContain('without sending');
    expect(blocks.get(1)).not.toMatch(/<p class="absent">[^<]*reply/);
    expect(blocks.get(2)).toContain('<span class="chip" style="color:var(--ok)">approved</span>');
    expect(blocks.get(2)).toContain('<div class="who">the system replied</div>');
    expect(blocks.get(3)).toContain('<p class="absent">the run stopped without sending a reply</p>');
    expect(blocks.get(4)).toContain('<p class="absent">the run stopped; the action recorded on this turn is still to be sent</p>');
    expect(blocks.get(5)).toContain('<p class="absent">the run stopped; nobody can confirm the action recorded on this turn</p>');
  });

  // A redelivered message parks a second run on a turn whose first reply went
  // out. The approval queue lists that run, so the turn says it waits and
  // opens it as a case. The heading still says what the customer has.
  it('says a turn waits when its newest run is parked, even after a sent reply', async () => {
    const base = await startGuarded(deps({
      readConversation: async () => ({
        ...THREAD,
        turns: [turnOf(1, { replyText: 'We refunded the duplicate charge.', runState: 'awaiting_approval', outboxStatus: 'sent' })],
      }) as never,
    }));
    const block = turnBlocks(await (await fetch(`${base}/conversation/${CONVERSATION}`)).text()).get(1)!;
    expect(block).toContain('<span class="chip" style="color:var(--warn)">waiting for you</span>');
    expect(block).toContain(`href="/case/${RUN}">open the case</a>`);
    expect(block).not.toContain('href="/run/');
    expect(block).toContain('<div class="who">the system replied</div>');
  });

  // A redelivered message can escalate while the relay still retries the
  // first run's send. The relay will still send, so the heading follows the
  // row and the chip names the escalation beside it.
  it('heads a pending row as pending when a later run escalated', async () => {
    const base = await startGuarded(deps({
      readConversation: async () => ({
        ...THREAD,
        turns: [turnOf(1, { replyText: 'We refunded the duplicate charge.', runState: 'escalated', outboxStatus: 'pending' })],
      }) as never,
    }));
    const block = turnBlocks(await (await fetch(`${base}/conversation/${CONVERSATION}`)).text()).get(1)!;
    expect(block).toContain('<span class="chip" style="color:var(--hot)">approved · escalated · pending</span>');
    expect(block).toContain('<div class="who">approved, send pending</div>');
  });

  // A retried turn says how many runs worked it, marked by a class so the
  // page keeps no inline style of its own for it.
  it('counts the runs that worked a turn only when there was more than one', async () => {
    const base = await startGuarded(deps({
      readConversation: async () => ({
        ...THREAD,
        turns: [turnOf(1, { replyAbsence: 'handled_automatically', runAttempts: 3 }), turnOf(2, { replyAbsence: 'handled_automatically' })],
      }) as never,
    }));
    const blocks = turnBlocks(await (await fetch(`${base}/conversation/${CONVERSATION}`)).text());
    expect(blocks.get(1)).toContain('<span class="m turnfact warn">3 attempts</span>');
    expect(blocks.get(2)).not.toContain('attempts');
  });

  // The stylesheet lays out these classes, and a test of the stylesheet alone
  // passes with none of them on the page.
  it('draws the thread in the classes its layout names', async () => {
    const base = await startGuarded(deps({ readConversation: async () => THREAD as never }));
    const html = await (await fetch(`${base}/conversation/${CONVERSATION}`)).text();
    expect(html).toContain('<div class="casehd">');
    expect(html).toContain(
      '<div class="m casemeta">conversation ' + CONVERSATION
        + ' · 7 turns · opened 2026-08-30 06:00Z · no participant named</div>',
    );
    expect(html).toContain('<div class="wrap turns"><div class="turn">');
    for (const block of turnBlocks(html).values()) {
      expect(block).toMatch(/^<div class="turnmeta">/);
      expect(block).toContain('<div class="turnbody">');
      expect(block).toContain('<span class="m turnfact">');
    }
  });

  it('draws a thread whose times the driver could not read', async () => {
    const base = await startGuarded(deps({
      readConversation: async () => ({
        ...THREAD,
        openedAt: new Date(Number.NaN),
        turns: [turnOf(1, { replyAbsence: 'handled_automatically', createdAt: new Date(Number.NaN) })],
      }) as never,
    }));
    const response = await fetch(`${base}/conversation/${CONVERSATION}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('· 1 turn · opened not a readable time ·');
    expect(turnBlocks(html).get(1)).toContain('<span class="m turnfact">not a readable time</span>');
  });

  // A waiting turn is approved on its case, and the run page has no approval
  // on it. Every other run opens as the record of what it did, named by its
  // state. A turn no run joins links nowhere.
  it('links a waiting turn to its case and every other run to its record', async () => {
    const base = await startGuarded(deps({ readConversation: async () => THREAD as never }));
    const html = await (await fetch(`${base}/conversation/${CONVERSATION}`)).text();
    const blocks = turnBlocks(html);
    expect(blocks.get(7)).toContain(`href="/case/${RUN}">open the case</a>`);
    expect(blocks.get(7)).not.toContain('href="/run/');
    for (const n of [1, 2, 3, 4, 5]) {
      expect(blocks.get(n), `turn ${n}`).toContain(`href="/run/${RUN}"`);
      expect(blocks.get(n), `turn ${n}`).not.toContain('href="/case/');
    }
    expect(blocks.get(4)).toContain(`href="/run/${RUN}">composed</a>`);
    expect(blocks.get(6)).not.toContain('href="/run/');
    expect(blocks.get(6)).not.toContain('href="/case/');
    expect(html).toContain('no participant named');
  });

  // The reply text is written as the approval resolves the run, before the
  // relay sends it. A relay that cannot confirm the send escalates the run
  // (DEC-30), so the text is on the turn and nobody knows the customer has it.
  it('does not call an approved reply sent when its run escalated afterwards', async () => {
    const base = await startGuarded(deps({
      readConversation: async () => ({
        ...THREAD,
        turns: [
          turnOf(1, { replyText: 'We refunded the duplicate charge.', runState: 'escalated', outboxStatus: 'delivery_unknown' }),
          turnOf(2, { replyText: 'We refunded the duplicate charge.' }),
        ],
      }) as never,
    }));
    const blocks = turnBlocks(await (await fetch(`${base}/conversation/${CONVERSATION}`)).text());
    expect(blocks.get(1)).toContain('>approved · escalated · delivery_unknown</span>');
    expect(blocks.get(1)).toContain('color:var(--hot)');
    expect(blocks.get(1)).toContain('approved, delivery not confirmed');
    expect(blocks.get(1)).not.toContain('the system replied');
    expect(blocks.get(2)).toContain('>approved</span>');
    expect(blocks.get(2)).toContain('the system replied');
    expect(blocks.get(2)).not.toContain('delivery not confirmed');
  });

  // The relay writes `sent` only after the adapter answers, and no update
  // rewrites a sent row, so the heading says the customer has the reply. Two
  // relays can still escalate the run after one of them sent, and that may
  // mean a second send, so the chip names the escalation.
  it('heads a recorded send as sent, and names a run that escalated after it', async () => {
    const base = await startGuarded(deps({
      readConversation: async () => ({
        ...THREAD,
        turns: [turnOf(1, { replyText: 'We refunded the duplicate charge.', runState: 'escalated', outboxStatus: 'sent' })],
      }) as never,
    }));
    const blocks = turnBlocks(await (await fetch(`${base}/conversation/${CONVERSATION}`)).text());
    expect(blocks.get(1)).toContain('<span class="chip" style="color:var(--hot)">approved · escalated · sent</span>');
    expect(blocks.get(1)).toContain('<div class="who">the system replied</div>');
  });

  // A resolved run commits its outbox row and does not deliver it. Only the
  // relay's own record of the send lets the page say the customer has the
  // reply, and only that record draws the success colour.
  it('says a reply reached the customer only when the relay recorded the send', async () => {
    const reply = 'We refunded the duplicate charge.';
    const base = await startGuarded(deps({
      readConversation: async () => ({
        ...THREAD,
        turns: [
          turnOf(1, { replyText: reply }),
          turnOf(2, { replyText: reply, outboxStatus: 'pending' }),
          turnOf(3, { replyText: reply, outboxStatus: 'fenced' }),
          turnOf(4, { replyText: reply, runId: null, runState: null, runAttempts: 0, outboxStatus: null }),
          turnOf(5, { replyAbsence: 'handled_automatically', outboxStatus: 'pending' }),
          // The relay fences a send without moving the run, so a resolved
          // run with a fenced row is what the ledger holds for one.
          turnOf(6, { replyAbsence: 'approved_without_reply', outboxStatus: 'fenced' }),
          // The relay refuses a malformed payload before any adapter call, and
          // escalates the run in the same transaction.
          turnOf(7, { replyText: reply, runState: 'escalated', outboxStatus: 'malformed' }),
          turnOf(8, { replyText: reply, runState: 'escalated', outboxStatus: 'delivery_unknown' }),
          // The chip and heading read the status alone when the run resolved.
          turnOf(9, { replyText: reply, outboxStatus: 'delivery_unknown' }),
        ],
      }) as never,
    }));
    const blocks = turnBlocks(await (await fetch(`${base}/conversation/${CONVERSATION}`)).text());
    const chipOf = (n: number): string => /<span class="chip"[^>]*>[^<]*<\/span>/.exec(blocks.get(n)!)![0];
    expect(chipOf(1)).toBe('<span class="chip" style="color:var(--ok)">approved</span>');
    expect(blocks.get(1)).toContain('the system replied');

    // A pending row may follow a send that timed out, so it claims no more
    // than the ledger holds.
    expect(chipOf(2)).toContain('>approved · pending<');
    expect(blocks.get(2)).toContain('<div class="who">approved, send pending</div>');

    // DEC-28: the relay can fence a row on a later scan, after a send that
    // timed out and may have landed. So a fenced row confirms nothing.
    expect(chipOf(3)).toBe('<span class="chip" style="color:var(--hot)">approved · fenced</span>');
    expect(blocks.get(3)).toContain('<div class="who">approved, delivery not confirmed</div>');
    expect(blocks.get(3)).not.toContain('never sent');

    // No run joins the turn, so no outbox row can say anything.
    expect(chipOf(4)).toContain('>approved<');
    expect(blocks.get(4)).toContain('a person approved this reply');

    expect(chipOf(5)).toContain('>auto-answered · pending<');
    expect(chipOf(6)).toBe('<span class="chip" style="color:var(--hot)">approved · fenced</span>');

    expect(chipOf(7)).toBe('<span class="chip" style="color:var(--hot)">approved · escalated · malformed</span>');
    expect(blocks.get(7)).toContain('approved, never sent');
    expect(chipOf(8)).toBe('<span class="chip" style="color:var(--hot)">approved · escalated · delivery_unknown</span>');
    expect(blocks.get(8)).toContain('approved, delivery not confirmed');
    expect(blocks.get(8)).not.toContain('never sent');
    expect(chipOf(9)).toBe('<span class="chip" style="color:var(--hot)">approved · delivery_unknown</span>');
    expect(blocks.get(9)).toContain('<div class="who">approved, delivery not confirmed</div>');

    for (const n of [2, 3, 4, 5, 6, 7, 8, 9]) {
      expect(chipOf(n), `turn ${n}`).not.toContain('var(--ok)');
      expect(blocks.get(n), `turn ${n}`).not.toContain('the system replied');
    }
  });

  // An absent reply is headed as the reply, never as one the system sent: the
  // sentence beneath says whether anything was.
  it('heads an absent reply without saying the system replied', async () => {
    const base = await startGuarded(deps({ readConversation: async () => THREAD as never }));
    const blocks = turnBlocks(await (await fetch(`${base}/conversation/${CONVERSATION}`)).text());
    for (const n of [1, 3, 4, 5, 6]) {
      expect(blocks.get(n), `turn ${n}`).toContain('<div class="who">the reply</div>');
      expect(blocks.get(n), `turn ${n}`).not.toContain('the system replied');
    }
  });

  it('prints each turn at its own time, in UTC', async () => {
    const base = await startGuarded(deps({ readConversation: async () => THREAD as never }));
    const blocks = turnBlocks(await (await fetch(`${base}/conversation/${CONVERSATION}`)).text());
    // Derived by hand from `turnOf`: day 1 + n of September, hour 8 + n,
    // minute 10 + n.
    expect(blocks.get(1)).toContain('2026-09-02 09:11Z');
    expect(blocks.get(2)).toContain('2026-09-03 10:12Z');
    expect(blocks.get(1)).not.toContain('2026-09-03 10:12Z');
    for (const block of blocks.values()) expect(block).not.toContain('2026-08-30 06:00Z');
  });

  // A waiting turn holds nothing the customer received. The label says it
  // waits for a person, and the absence stays a sentence in its own muted
  // element, never prose that reads as text the customer received.
  it('labels a waiting turn as waiting for a person', async () => {
    const base = await startGuarded(deps({ readConversation: async () => THREAD as never }));
    const blocks = turnBlocks(await (await fetch(`${base}/conversation/${CONVERSATION}`)).text());
    const waiting = blocks.get(7)!;
    expect(waiting).toContain('<div class="who">waiting for a person</div>');
    expect(waiting).not.toContain('the system replied');
    expect(waiting).toMatch(/<p class="absent waiting">this turn waits for a person to approve it<\/p>/);
    expect(blocks.get(2)).toContain('the system replied');
    expect(blocks.get(2)).not.toContain('waiting for a person</div>');
  });

  it('draws every absent half as a named sentence, and no empty block', async () => {
    const base = await startGuarded(deps({
      readConversation: async () => ({
        ...THREAD,
        turns: [
          turnOf(1, { bodyText: null, messageAbsence: 'not_retained', replyAbsence: 'handled_automatically' }),
          turnOf(2, { bodyText: '  ', messageAbsence: 'empty_message', replyAbsence: 'no_reply_sent', runState: 'abandoned', outboxStatus: null }),
          turnOf(3, { replyText: ' \n ' }),
        ],
      }) as never,
    }));
    const html = await (await fetch(`${base}/conversation/${CONVERSATION}`)).text();
    const blocks = turnBlocks(html);
    expect(blocks.get(1)).toMatch(/<p class="absent">the text of this message was not kept<\/p>/);
    expect(blocks.get(1)).toMatch(/<p class="absent">answered by an internal write; no reply was sent to the customer<\/p>/);
    expect(blocks.get(2)).toMatch(/<p class="absent">the customer sent no text<\/p>/);
    expect(blocks.get(2)).toMatch(/<p class="absent">the run stopped without sending a reply<\/p>/);
    expect(blocks.get(3)).toMatch(/<p class="absent">a person approved a reply that holds no text<\/p>/);
    expect(blocks.get(3)).not.toContain('class="prose"></div>');
    expect(html).not.toMatch(/<div class="prose">\s*<\/div>/);
  });

  // Every text on this page is ledger data a customer or an adapter chose,
  // and the run state now reaches a chip built from a template string. Each
  // one must arrive escaped, in every branch that draws it.
  it('escapes every ledger value it draws, in every turn branch', async () => {
    const hostile = '"><script>alert(1)</script>';
    const base = await startGuarded(deps({
      readConversation: async () => ({
        ...THREAD,
        conversationId: hostile,
        primaryTicketId: hostile,
        state: hostile,
        turns: [
          // No row, so the chip names the run state rather than a recorded send.
          turnOf(1, { ticketId: hostile, bodyText: hostile, replyText: hostile, runState: hostile, outboxStatus: null }),
          turnOf(2, { ticketId: hostile, replyAbsence: hostile, runState: hostile }),
          turnOf(3, { replyAbsence: 'no_reply_sent', runState: hostile, runAttempts: 3 }),
          turnOf(4, { replyText: 'Refunded.', outboxStatus: hostile }),
          turnOf(5, { replyAbsence: 'handled_automatically', outboxStatus: hostile }),
          turnOf(6, { replyAbsence: 'no_reply_sent', runState: 'escalated', outboxStatus: hostile }),
        ],
      }) as never,
    }));
    const html = await (await fetch(`${base}/conversation/${CONVERSATION}`)).text();
    expect(html).not.toContain(hostile);
    // The page's own script is the one tag of its kind.
    expect(html.split('<script>')).toHaveLength(2);
    const blocks = turnBlocks(html);
    expect(blocks.get(1)).toContain('approved · &quot;&gt;&lt;script&gt;');
    expect(blocks.get(2)).toContain('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(blocks.get(3)).toContain('&quot;&gt;&lt;script&gt;');
    expect(blocks.get(4)).toContain('approved · &quot;&gt;&lt;script&gt;');
    expect(blocks.get(4)).toContain('<div class="who">approved, delivery not confirmed</div>');
    expect(blocks.get(5)).toContain('auto-answered · &quot;&gt;&lt;script&gt;');
    // A status the core would refuse never reaches the sentence as text.
    expect(blocks.get(6)).toContain('<p class="absent">the run stopped; nobody can confirm the action recorded on this turn</p>');
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

describe('the design notes', () => {
  /** Each card of the page: its colour token, title and sentences. */
  function cardsOf(html: string): { token: string; title: string; says: string }[] {
    return [...html.matchAll(
      /<div class="designnote" style="border-left-color:var\(--([a-z]+)\)"><div class="designnotetitle">([^<]*)<\/div><div class="designnotesays">([^<]*)<\/div><\/div>/g,
    )].map((m) => ({ token: m[1]!, title: m[2]!, says: m[3]! }));
  }

  // The maintainer's decision on #104: only cards the console already makes
  // true ship now. Each of the other four ships with the issue that builds it.
  it('shows the cards the console makes true today, in order', async () => {
    const base = await startGuarded(deps());
    const html = await (await fetch(base + '/notes')).text();
    expect(cardsOf(html).map((c) => [c.token, c.title])).toEqual([
      ['warn', 'The gates stay apart, everywhere'],
      ['ok', 'An absence is still a sentence'],
      ['dim', 'The engineer surfaces sit under Admin'],
      // DEC-47: the product, which the console records and narrows by now.
      ['ok', 'Product is a first-class column'],
      // DEC-44: the reply a reviewer edits where it will be sent.
      ['accent', 'The reply is edited here, and sent from here'],
      // DEC-48: the case a reviewer finishes with no reply.
      ['accent', 'A case can end without a reply'],
      // DEC-46: the case hold, which the console keeps now.
      ['accent', 'A lock, because four people pull from one uncapped list'],
    ]);
    for (const unbuilt of [
      'The knowledge base is edited from inside the case',
    ]) {
      expect(html, unbuilt).not.toContain(unbuilt);
    }
  });

  // The second decision: a card states what the console does, and names no
  // code it replaced. The handoff's source lines named files and functions.
  it('names no replaced code on any card', async () => {
    const base = await startGuarded(deps());
    const html = await (await fetch(base + '/notes')).text();
    const cards = cardsOf(html);
    expect(cards).toHaveLength(7);
    for (const card of cards) {
      for (const source of ['was:', '.ts', 'approveControl', 'MESSAGE_ABSENCE', 'gateValue', 'Instrument']) {
        expect(card.says, `${card.title}: ${source}`).not.toContain(source);
        expect(card.title, `${card.title}: ${source}`).not.toContain(source);
      }
      expect(card.says.trim().length, card.title).toBeGreaterThan(0);
    }
    expect(html).not.toContain('was:');
  });

  // The words are pinned whole: a sentence added to a card is a new claim, and
  // it fails here until someone checks it against the console. The subtitle
  // promises a reason on every card, so it is pinned with them.
  it('ships each card in the words the console was checked against', async () => {
    const base = await startGuarded(deps());
    const html = await (await fetch(base + '/notes')).text();
    expect(html).toContain(
      '<div class="hdt">Design notes</div><div class="hds">Why the console works this way.'
        + ' Each card states a rule the console keeps, and the reason for it.</div>',
    );
    expect(cardsOf(html).map((c) => c.says)).toEqual([
      'No screen combines agreement and coverage into one score, because the system never computes one'
        + ' and could not act on it. A screen that shows both shows each value on its own.'
        + ' The queue group Both gates clean holds a case only when both values and both lines are recorded,'
        + ' and each value clears its own line.',
      'A turn with no message or no reply names why, in a sentence of its own.'
        + ' On a run or case page, a gate with no recorded value shows an em dash with a note that names the absence,'
        + ' and draws no bar.'
        + ' No screen renders an unmeasured value as zero, because a zero would read as a measurement.',
      'Runs, control bands and partition latency sit under Admin.'
        + ' They answer questions about the pipeline, and a person clearing a queue between'
        + ' two engineering tasks is not asking them.',
      'Each run records the product of the channel its message arrived on, and the console reads that'
        + ' value rather than inferring one from the message.'
        + ' Every queue row names the product it is for, and a run whose channel the map does not name says'
        + ' no product rather than drawing a blank.'
        + ' A chip per product carries the count read from every waiting run, so narrowing the queue never'
        + ' reports it as smaller than it is.'
        + ' The products a reviewer covers read first, and that order hides nothing: every waiting case is'
        + ' still on the page.',
      'On an adapter whose helpdesk cannot send the copy it parks, the ledger holds the reply.'
        + ' A reviewer edits it on the case, saves it, and reloads to find the text they saved.'
        + ' The sentences the system drafted stay beside the editor, each with the verdict it was given,'
        + ' and a claim the judge refused offers the words of the document it cites, its removal,'
        + ' or the answer the reviewer writes.'
        + ' What the approval sends is the text the ledger holds, with the disclosure and the provenance'
        + ' every customer reply carries.'
        + ' Where the helpdesk can send its own parked copy, the case says so and offers no editor:'
        + ' two texts that may both send is the one thing this console will not build.',
      'Some cases need no answer. A duplicate, a message from a machine, or a'
        + ' question somebody settled on the telephone.'
        + ' A reviewer closes such a case on its page, with a reason the team reads afterwards.'
        + ' The customer is sent nothing, and the conversation says the case was closed with no reply.',
      'The queue is not capped, so the same case can sit in front of four reviewers at once.'
        + ' A reviewer takes a case before working it, so the others see who holds it and the time left.'
        + ' The hold says who is working, and it refuses no write: any reviewer may still approve the case.'
        + ' A hold lapses on its own without activity, twenty minutes by default.'
        + ' Taking a second case releases the first, because a person reads one case at a time.',
    ]);
  });

  // Each claim, checked on the screens it describes rather than on the card.
  it('makes each card true of the console it describes', async () => {
    const base = await startGuarded(deps());
    // Card 1: the gate panel draws each gate under its own label and value,
    // and neither a mean nor a product appears.
    const both = renderGates({ agreement: 0.89, coverage: 0.94 });
    expect(both).toMatch(/Sample agreement<\/div>[^]*?<span class="big">0\.890<\/span>/);
    expect(both).toMatch(/Groundedness coverage<\/div>[^]*?<span class="big">0\.940<\/span>/);
    for (const combined of ['0.915', '0.837']) expect(both).not.toContain(combined);
    // The only figures on the panel are the two values: no blend of any kind.
    expect(both.match(/\d\.\d{3}/g)).toEqual(['0.890', '0.940']);
    // The queue row prints each value as its own token, and names the group.
    const queue = await (await fetch(base + '/')).text();
    // The fixture's rule gates before either threshold is read, so each value
    // carries that note beside it, still as a token of its own.
    // The whole line, so no score can join it unseen.
    expect(queue).toContain(
      // DEC-47 put the product beside the intent, so the row says which
      // product the case is for on the surface that orders by one.
      '<div class="m imeta">refund-request · Aurora · customer_visible · tier unrecorded'
        + ' · agreement 0.89 (not read) · coverage 0.94 (not read)</div>',
    );
    expect(queue).toContain('Both gates clean');
    // Card 2: on the panel a gate with no recorded value shows a dash and its
    // reason, draws no bar, and never a zero. The gate beside it keeps its bar.
    const one = renderGates({ agreement: 0.89, coverage: null, coverageAbsent: 'not recorded' });
    expect(one).toContain('<span class="big">—</span>');
    expect(one).toContain('<span class="m gateabsent">not recorded</span>');
    expect(one.match(/class="track"/g) ?? []).toHaveLength(1);
    expect(one).not.toContain('0.000');
    // The queue row draws nothing for an unrecorded gate, and never a zero.
    const unrecorded = await startGuarded(deps({
      listApprovals: async () => [{
        runId: RUN, ticketId: 'SYN-1', state: 'awaiting_approval', promptVer: 'p1', ...ROW,
        reason: 'customer_visible', stepsUsed: 4,
        agreement: null, draftExternalId: 'D-1',
      }] as never,
    }));
    const row = await (await fetch(unrecorded + '/')).text();
    expect(row).not.toContain(' · agreement');
    expect(row).toContain(' · coverage 0.94 (not read)');
    // A case with one gate unrecorded is not clean, whatever the other says.
    expect(row).not.toContain('Both gates clean');
    const noCoverage = await startGuarded(deps({
      listApprovals: async () => [{
        runId: RUN, ticketId: 'SYN-1', state: 'awaiting_approval', promptVer: 'p1', ...ROW,
        reason: 'customer_visible', stepsUsed: 4,
        agreement: 0.89, gateCoverage: null, draftExternalId: 'D-1',
      }] as never,
    }));
    const coverageRow = await (await fetch(noCoverage + '/')).text();
    expect(coverageRow).not.toContain(' · coverage');
    expect(coverageRow).toContain(' · agreement 0.89 (not read)');
    expect(coverageRow).not.toContain('Both gates clean');
    // A missing line keeps a case out of the group, whatever its values say.
    const noLine = await startGuarded(deps({
      listApprovals: async () => [{
        runId: RUN, ticketId: 'SYN-1', state: 'awaiting_approval', promptVer: 'p1', ...ROW,
        agreementThreshold: null, reason: 'customer_visible', stepsUsed: 4,
        agreement: 0.89, draftExternalId: 'D-1',
      }] as never,
    }));
    const lineRes = await fetch(noLine + '/');
    const lineQueue = await lineRes.text();
    expect(lineRes.status).toBe(200);
    expect(lineQueue).toContain(' · agreement 0.89 (not read)');
    expect(lineQueue).not.toContain('Both gates clean');
    // The run page draws a gate with no recorded value as the card says.
    const unread = await startGuarded(deps({ readRun: async () => ({ ...WAITING, coverage: null }) as never }));
    const runPage = await (await fetch(`${unread}/run/${RUN}`)).text();
    expect(runPage).toContain('<span class="big">—</span>');
    expect(runPage).toContain('<span class="m gateabsent">not recorded</span>');
    expect(runPage.match(/class="track"/g) ?? []).toHaveLength(1);
    expect(runPage).not.toContain('0.000');
    // The case page draws it the same way, with its own note.
    const casePage = await (await fetch(unread + CASE)).text();
    expect(casePage).toContain('<span class="big">—</span>');
    expect(casePage).toContain('<span class="m gateabsent">the journal holds no coverage for this run</span>');
    expect(casePage.match(/class="track"/g) ?? []).toHaveLength(1);
    expect(casePage).not.toContain('0.000');
    // The latency page draws no track for a percentile nobody measured, and a
    // track for one measured at zero.
    const latency = await startGuarded(deps({
      readLatency: async () => [{
        partition: 0,
        wait: [
          { label: 'p50', text: '-', share: null },
          { label: 'p95', text: '0ms', share: 0 },
          { label: 'p99', text: '0ms', share: 0 },
        ],
        service: [
          { label: 'p50', text: '40.4s', share: 0.1 },
          { label: 'p95', text: '3.0h', share: 1 },
          { label: 'p99', text: '3.4h', share: 1 },
        ],
        runs: 1, caveats: [],
      }],
    }));
    const latencyPage = await (await fetch(latency + '/latency')).text();
    expect(latencyPage).toContain('<span class="lbl">p50</span><span></span><span class="pv" style="color:var(--mut)">-</span>');
    expect(latencyPage.match(/class="track"/g) ?? []).toHaveLength(5);
    // Card 3: the Admin group of the rail holds all three surfaces.
    const notes = await (await fetch(base + '/notes')).text();
    // The group alone: its label, its links, and the close of its own element.
    const admin = /<div class="navgroup"><div class="lbl">Admin<\/div>((?:<a [^>]*>(?:(?!<\/a>).)*<\/a>)*)<\/div>/
      .exec(notes)?.[1];
    expect(admin).toBeDefined();
    for (const surface of ['Runs', 'Control bands', 'Partition latency']) {
      expect(admin, surface).toContain(`<span class="navlabel">${surface}</span>`);
    }
  });

  // The reply card (DEC-44), claimed on the screens it describes: the case
  // draws the editor and the callout where the adapter cannot send its parked
  // copy, and says the copy is what sends where it can.
  it('makes the reply card true of the console it describes', async () => {
    const capable = await startGuarded(deps(), undefined, undefined, true);
    const editing = await (await fetch(capable + CASE)).text();
    expect(editing).toContain('Your reply · editable here, sent from here');
    expect(editing).toContain('<textarea name="text"');
    expect(editing).toContain('The sentences the system drafted');
    expect(editing).toContain('Replace with what the document says');
    expect(editing).toContain('The disclosure and the provenance travel with it');

    const draftPath = await startGuarded(deps());
    const parked = await (await fetch(draftPath + CASE)).text();
    expect(parked).toContain('edited in the helpdesk, not here');
    expect(parked).not.toContain('<textarea');
  });

  // Card 4, claimed on the screens it describes (DEC-46). The queue is
  // uncapped and says which cases somebody has; the case page names the
  // holder, offers the approval anyway, and offers the way to move the hold
  // on. The card's "twenty minutes by default" is the console's own default,
  // held by `lifecycle.test.ts` beside the rest of the entry point's
  // configuration.
  it('makes the lock card true of the console it describes', async () => {
    const base = await startGuarded(deps({
      listApprovals: async () => [{
        runId: RUN, ticketId: 'SYN-1', state: 'awaiting_approval', promptVer: 'p1', ...ROW,
        reason: 'customer_visible', stepsUsed: 4, agreement: 0.89, draftExternalId: 'D-1',
      }] as never,
      readHolds: async () => new Map([[RUN, {
        reviewer: 'anna@example.test',
        takenAt: new Date(Date.now() - 4 * 60_000),
        lapsesAt: new Date(Date.now() + 16 * 60_000),
      }]]),
    }));
    // Four reviewers, one uncapped list, and the list says who has what.
    const queue = await (await fetch(base + '/')).text();
    expect(queue).toContain('This list is not capped, so the oldest is on it.');
    expect(queue).toContain('Held by someone else');
    expect(queue).toContain('held by anna@example.test · 4m');

    // The case names the holder and the time left, and the hold refuses no
    // write: the approval is drawn beside it, and the takeover with it.
    const readHold = async () => ({
      reviewer: 'anna@example.test',
      takenAt: new Date(Date.now() - 4 * 60_000),
      lapsesAt: new Date(Date.now() + 16 * 60_000),
    });
    const held = await startGuarded(deps({ readHold }));
    const heldCase = await (await fetch(held + CASE)).text();
    expect(heldCase).toContain('Held by anna@example.test');
    expect(heldCase).toContain('16 minutes left');
    expect(heldCase).toContain('Take it over');
    expect(heldCase).toContain('action="/approve');
    expect(heldCase).toContain('Approve and send');
  });

  // Card 6, claimed on the screens it describes (DEC-48). The case offers the
  // close and the reason it records, and the conversation names the absence
  // in its own words rather than borrowing the two beside it.
  it('makes the close card true of the console it describes', async () => {
    const base = await startGuarded(deps({
      readConversation: async () => ({
        conversationId: CONVERSATION,
        primaryTicketId: 'SYN-1',
        state: 'open',
        openedAt: new Date('2026-09-06T08:00:00.000Z'),
        participantNamed: true,
        turns: [{
          turnNumber: 1, ticketId: 'SYN-1',
          createdAt: new Date('2026-09-07T14:32:00.000Z'),
          bodyText: 'This is the same as my other ticket.',
          messageAbsence: null,
          replyText: null,
          replyAbsence: 'closed_without_reply',
          runId: RUN, runState: 'closed', runAttempts: 1, outboxStatus: null,
        }],
      }) as never,
    }));

    // The case offers the close, with the field the reason is written in.
    const html = await (await fetch(base + CASE)).text();
    expect(html).toContain('Close, no reply');
    expect(html).toMatch(/<input[^>]*name="reason"/);
    expect(html).toContain('The customer is sent nothing.');

    // The conversation says the case was closed with no reply, and not that
    // the system answered it or that a person approved an action on it.
    const thread = await (await fetch(`${base}/conversation/${CONVERSATION}`)).text();
    expect(thread).toContain('a person closed this case without replying to the customer');
    expect(thread).not.toContain('answered by an internal write');
    expect(thread).not.toContain('a person approved an action here');
  });

  // Card 5, claimed on the queue it describes (DEC-47). Every sentence of
  // the card is checked here: the row names the product, `no product` is
  // said rather than drawn, the chip count comes from every waiting run
  // while a filter is on, and the reviewer's own products read first without
  // hiding a case.
  it('makes the product card true of the console it describes', async () => {
    // Built here rather than through the queue harness below, which is
    // declared inside another describe. Each case carries its own time, so
    // the order this case reads is the order the card claims.
    const one = (
      runId: string,
      ticketId: string,
      product: string | null,
      createdAt: string,
    ) => ({
      runId, ticketId, state: 'awaiting_approval', promptVer: 'p1', ...ROW,
      reason: null, stepsUsed: 4, draftExternalId: 'D-1', coverage: null,
      agreement: 0.91, agreementThreshold: 0.8, gateCoverage: 0.86,
      coverageReviewThreshold: 0.8, product, createdAt: new Date(createdAt),
    });
    const runs = [
      one('11111111-1111-4111-8111-111111111111', 'SYN-AURORA', 'aurora', '2026-09-14T12:00:00Z'),
      one('22222222-2222-4222-8222-222222222222', 'SYN-LEDGER', 'ledger', '2026-09-14T11:00:00Z'),
      one('33333333-3333-4333-8333-333333333333', 'SYN-UNSCOPED', null, '2026-09-14T10:00:00Z'),
    ];
    const base = await startGuarded(deps({
      listApprovals: async () => runs,
      readReviewerProducts: async () => ['ledger'],
    }));

    // The value comes from the run, and the row states it — including the
    // null, which is a sentence rather than a gap.
    const queue = await (await fetch(base + '/')).text();
    expect(queue).toContain('refund-request · Aurora · customer_visible');
    expect(queue).toContain('refund-request · Ledger · customer_visible');
    expect(queue).toContain('refund-request · no product · customer_visible');
    // The reviewer's own product reads first, and nothing is hidden to do it.
    // The covered case leads though it is not the oldest, and the two the
    // reviewer does not cover keep their age order behind it.
    expect([...queue.matchAll(/SYN-(AURORA|LEDGER|UNSCOPED)/g)].map((m) => m[0])).toEqual([
      'SYN-LEDGER', 'SYN-UNSCOPED', 'SYN-AURORA',
    ]);
    for (const ticket of ['SYN-AURORA', 'SYN-LEDGER', 'SYN-UNSCOPED']) {
      expect(queue, ticket).toContain(ticket);
    }

    // Narrowed, the counts still come from every waiting run: the queue
    // reports one case shown and three waiting, never one of one.
    const narrowed = await (await fetch(base + '/?product=aurora')).text();
    expect(narrowed).toContain('Waiting · 1');
    expect(narrowed).toContain('<a href="/?product=ledger">Ledger<span class="dim"> 1</span></a>');
    expect(narrowed).toContain('<a href="/?product=__none__">no product<span class="dim"> 1</span></a>');
    // `all` offers the whole queue and is not the chip being shown. The mark
    // is on the product the view is narrowed to.
    expect(narrowed).toContain('<a href="/">all<span class="dim"> 3</span></a>');
    expect(narrowed).toContain('<a href="/?product=aurora" class="on">Aurora');
  });

  // The page draws from nothing but its own copy, so a ledger that cannot
  // answer still leaves it readable. Every reader the console holds is
  // refused and counted, a reader added later included.
  //
  // The reviewer is the one reader left. DEC-45 resolves it before any page
  // is built, and it is the roster's read rather than this page's, so it
  // answers while every other reader refuses.
  it('reads no ledger', async () => {
    const asked: string[] = [];
    const refusing = Object.fromEntries(
      Object.keys(deps())
        .filter((name) => name !== 'reviewerFor')
        .map((name) => [
          name,
          async (): Promise<never> => { asked.push(name); throw new Error(`${name} was asked`); },
        ]),
    );
    // A theme cookie, so the rail's reviewer block and the theme are drawn on
    // the way too, and neither reaches a reader.
    const base = await startGuarded({
      ...(refusing as unknown as ConsoleDeps),
      reviewerFor: async () => ({ reviewer: 'Ada Synthetic' }),
    });
    const res = await fetch(base + '/notes', { headers: { cookie: 'theme=light' } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Why the console works this way');
    expect(html).toContain('Ada Synthetic');
    expect(html).toContain('data-theme="light"');
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
    const res = await fetch(base + '/');
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

  // The bindings are pinned by their key names, because the hash test proves
  // the served text matches the policy but not that it binds the keys the
  // legend names.
  // Issue #105: no comment may claim the console ships no script. The claim
  // once sat in server.ts, and the runbook held it too.
  it('leaves no comment claiming the console ships no script', () => {
    for (const file of ['server.ts', 'surfaces.ts', 'script.ts', 'css.ts']) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
      expect(source, file).not.toContain('there is no script');
      expect(source, file).not.toContain('ships no script');
    }
    // The runbook's own phrasing, which `check-docs.py` also refuses. The
    // runbook never held the two phrasings above, so pinning them here would
    // prove nothing about it. Its prose is wrapped, so the phrase is read with
    // the whitespace collapsed, the same way the checker reads it.
    const runbook = readFileSync(new URL('../../docs/operations.md', import.meta.url), 'utf8')
      .replace(/\s+/g, ' ');
    expect(runbook).not.toContain('ships no JavaScript');
  });

  it('binds Escape to the case back link and c to the take', async () => {
    const base = await startGuarded(deps());
    const script = /<script>([\s\S]*?)<\/script>/.exec(await (await fetch(base + '/')).text())?.[1] ?? '';
    expect(script).toContain(".casehd a.back");
    expect(script).toContain("event.key === 'Escape'");
    expect(script).toContain("event.key === 'c'");
    expect(script).toContain('url.origin === window.location.origin');
    // The origin check is real, and Esc obeys the shared guard: the exact
    // lines, so weakening either fails here rather than only in a browser.
    expect(script).toContain('if (href !== null) {');
    expect(script).toContain("if (event.key === 'Escape' && back) {\n      if (inControl(event)) return;");
    // c takes the focused case (DEC-46). The take is a write, so the script
    // builds a form and submits it: no link writes on a GET, and the pinned
    // lines below are what keeps that true if the script is ever rewritten.
    expect(script).toContain("takeForm.method = 'post';");
    // The queue's filters ride with it (DEC-47): a take from a narrowed
    // queue returns to that queue, as the case page's own take does.
    expect(script).toContain("takeForm.action = '/take' + window.location.search;");
    expect(script).toContain('takeForm.submit();');
    expect(script).toContain('if (rowUrl.origin !== window.location.origin) return;');
    // c acts on the focused row alone, so it never chooses one for a reviewer.
    expect(script).toContain('if (at < 0) return;');
    // The j/k/c guard at its own site, so removing it is not hidden by the
    // same line serving Esc.
    expect(script).toContain('if (rows.length === 0) return;\n    if (inControl(event)) return;');
    // j and k move, and c joins them in the one key check. The movement line
    // names only j, because k is its other half.
    expect(script).toContain("event.key === 'j'");
    expect(script).toContain("event.key !== 'j' && event.key !== 'k' && event.key !== 'c'");
    // Enter stays unbound on purpose (#51): the focused anchor already opens.
    // Both spellings, so a quote reformat cannot hide a binding.
    expect(script).not.toContain("'Enter'");
    expect(script).not.toContain('"Enter"');
    expect(script).toContain('BUTTON: 1');
    expect(script).toContain("typing['SEL' + 'ECT'] = 1;");
    // No key acts while the reviewer types: the guard names every field.
    expect(script).toContain('INPUT: 1');
    expect(script).toContain('TEXTAREA: 1');
    expect(script).toContain('isContentEditable');
    // And the guard is applied to the keys, not only defined.
    expect(script).toContain('if (inControl(event)) return;');
    // The movement itself: j steps toward the bottom, k toward the top, and
    // the focused row comes into view. Swapping the two breaks this.
    expect(script).toContain("at = event.key === 'j' ? Math.min(rows.length - 1, at + 1) : Math.max(0, at - 1);");
    expect(script).toContain('rows[at].scrollIntoView({ block: \'nearest\' });');
    // Esc's consequence: it prevents the default and navigates, and the
    // protocol check keeps a javascript: or data: link inert.
    expect(script).toContain('event.preventDefault();\n          window.location.href = url.href;');
    expect(script).toContain("url.protocol === 'http:' || url.protocol === 'https:'");
  });

  it('ships exactly one, on every surface', async () => {
    const base = await startGuarded(deps());
    for (const path of ['/', '/runs', `/run/${RUN}`, '/bands', '/latency', '/notes', '/nowhere']) {
      const html = await (await fetch(base + path)).text();
      expect(html.split('<script>'), path).toHaveLength(2);
    }
  });
});

describe('who the ledger records as the approver', () => {
  // The header this console reads, and every shape a claim arrives in, is
  // `reviewer.test.ts`'s subject. What is left here is the wiring: the server
  // serves no page and makes no write without a reviewer, and the reviewer it
  // resolved is the one the approval records.

  // DEC-45. The console's one write takes the identity the gate resolved,
  // which the roster answered for and the ledger will record as `roster`.
  it('passes the reviewer the gate resolved to the approval', async () => {
    const calls: string[] = [];
    const base = await startGuarded(deps({
      approve: async (runId: string, approvedBy: string) => {
        calls.push(approvedBy);
        return 'approved';
      },
      reviewerFor: async () => ({ reviewer: 'Ida Lindqvist' }),
    }));
    await fetch(base + '/approve', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'same-origin',
      },
      body: `runId=${RUN}&shown=${SHOWN}`,
      redirect: 'manual',
    });
    expect(calls).toEqual(['Ida Lindqvist']);
  });

  // The form, never a typed name. A name anyone can type into a page is not
  // an audit trail, and the route reads only `runId` from the body.
  it('never takes the approver from the form', async () => {
    const calls: string[] = [];
    const base = await startGuarded(deps({
      approve: async (runId: string, approvedBy: string) => {
        calls.push(approvedBy);
        return 'approved';
      },
      reviewerFor: async () => ({ reviewer: 'Ida Lindqvist' }),
    }));
    await fetch(base + '/approve', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'same-origin',
      },
      body: new URLSearchParams({ shown: SHOWN, runId: RUN, approvedBy: 'typed-by-anyone' }).toString(),
      redirect: 'manual',
    });
    expect(calls).toEqual(['Ida Lindqvist']);
  });
});

describe('the gate every request passes (DEC-45)', () => {
  // The console holds no credential of its own, so what it serves is decided
  // by a roster and by a proxy the operator trusts. Before this gate, every page
  // was readable by anyone who could reach the port, and the rail named a
  // reviewer that any caller could claim.
  //
  // The gate runs before the route, so a surface that reads no ledger at all
  // is refused for the same reason a page is: what is refused is the request,
  // not the read.
  it('refuses every surface, and offers no theme cookie', async () => {
    const asked: string[] = [];
    const base = await startGuarded(deps({
      reviewerFor: async () => refuses('no_value'),
      listRuns: async () => { asked.push('listRuns'); return []; },
    }));
    for (const path of ['/', '/runs', '/bands', '/latency', '/notes', `/run/${RUN}`, '/console.css']) {
      const res = await fetch(base + path);
      expect(res.status, path).toBe(403);
      const html = await res.text();
      expect(html, path).toContain('without an active reviewer identity');
      // No page, and no rail on it: a refused request is the one that must
      // not be told which ledger this console is bound to.
      expect(html, path).not.toContain('class="rail"');
      expect(html, path).not.toContain('localhost:5433');
    }
    // The theme route writes a cookie, so it is refused before the write.
    const theme = await fetch(`${base}/theme?to=light`, { redirect: 'manual' });
    expect(theme.status).toBe(403);
    expect(theme.headers.get('set-cookie')).toBeNull();
    // And the write makes no approval.
    const approve = vi.fn().mockResolvedValue('approved');
    const writing = await startGuarded(deps({ reviewerFor: async () => refuses('no_value'), approve }));
    const post = await fetch(`${writing}/approve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'same-origin',
      },
      body: `runId=${RUN}`,
      redirect: 'manual',
    });
    expect(post.status).toBe(403);
    expect(approve).not.toHaveBeenCalled();
    // The gate is asked before the route, so no reader ran for any of them.
    expect(asked).toEqual([]);
  });

  // The refusal is an event, so an operator can tell a stranger from a
  // console that is refusing everyone. Four conditions reach one refusal
  // path, and each has a different fix, so the log names which it was and
  // what the request claimed — bounded, as every other logged value is.
  it('records why it refused, and what the request claimed', async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
    try {
      const base = await startGuarded(deps({
        reviewerFor: async () => refuses('repeated', 'ops-oncall', 2),
      }));
      const res = await fetch(base + '/bands');
      // No page, and no rail on it: read from the response, which is what
      // the refusal is about. Asserting this over the log said nothing —
      // a console that refused *and* served the page would pass.
      const html = await res.text();
      expect(res.status).toBe(403);
      expect(html).not.toContain('class="rail"');
      const record = logged
        .map((entry) => JSON.parse(entry) as Record<string, unknown>)
        .find((entry) => entry['event'] === 'console_refused');
      expect(record).toBeDefined();
      expect(record!['reason']).toBe('no_reviewer');
      expect(record!['detail']).toBe('repeated');
      expect(record!['header']).toBe('x-forwarded-user');
      expect(record!['claim']).toBe('ops-oncall');
      expect(record!['claimLength']).toBe(10);
      expect(record!['lines']).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });

  // The claimed value is a request value like any other, so the log takes a
  // bounded prefix of it and a length, and one record stays one line.
  it('keeps a hostile claim on one bounded line', async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
    try {
      const said = 'a'.repeat(64) + String.fromCharCode(0x2028, 0x85) + 'b'.repeat(8_000);
      const base = await startGuarded(deps({ reviewerFor: async () => refuses('comma', said, 1) }));
      await fetch(base + '/bands');
      const line = logged.find((entry) => entry.includes('"reason":"no_reviewer"'));
      expect(line).toBeDefined();
      expect(line!.length).toBeLessThan(1_000);
      for (const code of [0x85, 0x2028]) {
        expect(line, `U+${code.toString(16)}`).not.toContain(String.fromCharCode(code));
      }
      const record = JSON.parse(line!) as Record<string, unknown>;
      expect(record['detail']).toBe('comma');
      expect(record['claim']).toBe('a'.repeat(64));
      expect(record['claimLength']).toBe(said.length);
    } finally {
      spy.mockRestore();
    }
  });

  // A roster the console cannot read is not permission to serve. It draws
  // the same refusal as a stranger: the page says which of the two it was to
  // nobody, because that difference tells an unauthenticated caller whether
  // this ledger answers. The log carries it instead, and the operator reads
  // the log.
  it('refuses a request whose roster could not be read, and says so in the log', async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
    try {
      const base = await startGuarded(deps({
        reviewerFor: async () => { throw new Error('connection terminated'); },
      }));
      const res = await fetch(base + '/bands');
      expect(res.status).toBe(403);
      const html = await res.text();
      // The same words a stranger gets, and no page.
      expect(html).toContain('without an active reviewer identity');
      expect(html).not.toContain('could not read the reviewer roster');
      expect(html).not.toContain('class="rail"');
      // The fault text stays in the log, as every other fault on this console
      // does, and the record names the reason so an incident reader can tell
      // this refusal from one that found nobody.
      expect(html).not.toContain('connection terminated');
      const record = logged
        .map((entry) => JSON.parse(entry) as Record<string, unknown>)
        .find((entry) => entry['reason'] === 'reviewer_unread');
      expect(record).toBeDefined();
      expect(String(record!['error'])).toContain('connection terminated');
    } finally {
      spy.mockRestore();
    }
  });
});

// DEC-46, criterion 9. The approval form carries a digest of the reply the
// page drew, and the route refuses a post without one — so every console
// approval is an approval of a reply some page showed, and the ledger can
// refuse it when that reply has moved since.
describe('the shown-text guard (DEC-46)', () => {
  /** The reply the case fixture drew, which the digest is of. */
  const DRAFT = 'We refunded the duplicate charge. Your bank decides when it lands.';

  const post = (base: string, body: string) => fetch(base + '/approve', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'sec-fetch-site': 'same-origin',
    },
    body,
    redirect: 'manual',
  });

  it('carries the digest of the reply the case drew', async () => {
    const base = await startGuarded(deps());
    const html = await (await fetch(base + CASE)).text();
    expect(html).toContain(`name="shown" value="${replyDigest(DRAFT)}"`);
  });

  // Every shape but a SHA-256 in hex is a request this console did not
  // render. It is refused before the approval reads it, and the run id it
  // names never reaches the ledger.
  it('refuses a post that carries no digest, or one of another shape', async () => {
    const approved: string[] = [];
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
    try {
      const base = await startGuarded(deps({
        approve: async (runId: string) => { approved.push(runId); return 'approved'; },
      }));
      const bodies = [
        // Absent, empty, too short, too long, and uppercase: the digest is
        // written in hex by `replyDigest`, and nothing else is one.
        `runId=${RUN}`,
        `runId=${RUN}&shown=`,
        `runId=${RUN}&shown=abc123`,
        `runId=${RUN}&shown=${'c'.repeat(63)}`,
        `runId=${RUN}&shown=${'C'.repeat(64)}`,
      ];
      for (const body of bodies) {
        expect((await post(base, body)).status, body).toBe(400);
      }
      expect(approved).toEqual([]);
      expect(logged.filter((line) => line.includes('not_a_shown_digest'))).toHaveLength(bodies.length);
    } finally {
      spy.mockRestore();
    }
  });

  // The refusal the ledger sends back, in the words the case shows. The page
  // it lands on has just drawn the reply again, so the sentence says to read
  // it again rather than to retry.
  it('names the reply when the ledger refuses the approval', async () => {
    const base = await startGuarded(deps({ approve: async () => 'shown_changed' }));
    const html = await (await fetch(base + `${CASE}?outcome=shown_changed`)).text();
    expect(html).toContain('The reply changed since this page was drawn');
    expect(html).toContain('refused');
  });

  // And the other half of criterion 9: a case whose state changed is refused
  // with the state it moved to, so a reviewer reads which change happened
  // rather than that something did.
  it('names the state a case moved to', async () => {
    const base = await startGuarded(deps({ readRun: caseOf({ state: 'resolved' }) }));
    const html = await (await fetch(base + `${CASE}?outcome=not_awaiting_approval`)).text();
    expect(html).toContain('It is resolved now');
  });
});

describe('taking a case (DEC-46)', () => {
  /** A hold on one case, lapsing in `minutes` from now. */
  const holdFor = (reviewer: string, minutes: number) => ({
    reviewer,
    takenAt: new Date(Date.now() - 60_000),
    lapsesAt: new Date(Date.now() + minutes * 60_000),
  });

  // The bar has three states, and each says what the reviewer can do about
  // it. A free case is the plain take; the others are somebody's hold.
  it('offers a take on a free case', async () => {
    const base = await startGuarded(deps({ readHold: async () => null }));
    const html = await (await fetch(base + CASE)).text();
    expect(html).toContain('Nobody holds this case.');
    expect(html).toContain('Take this case');
    expect(html).toContain('action="/take"');
    // No takeover field: one press takes a free case.
    expect(html).not.toContain('name="over"');
  });

  // Criterion 1: the second reviewer is told who holds it, and the takeover
  // is a second press — the form carries `over`, so the page asks.
  it('names the holder, and asks before moving their hold', async () => {
    const base = await startGuarded(deps({
      readHold: async () => holdFor('anna@example.test', 8),
    }));
    const html = await (await fetch(base + CASE)).text();
    expect(html).toContain('Held by anna@example.test');
    expect(html).toContain('8 minutes left');
    expect(html).toContain('Take it over');
    expect(html).toContain('name="over"');
  });

  // Criterion 5 and 6: the holder sees their own hold and how long is left,
  // and can let it go.
  it('shows the holder their own hold, its remaining time, and the release', async () => {
    const base = await startGuarded(deps({
      readHold: async () => holdFor(REVIEWER, 1),
    }));
    const html = await (await fetch(base + CASE)).text();
    expect(html).toContain('Held by you');
    expect(html).toContain('1 minute left');
    expect(html).toContain('Release it');
    expect(html).toContain('name="release"');
  });

  // Criterion 5: the case shows the holder's remaining time, and the console
  // is what turns `lapses_at` into it. The figure rounds up, so a hold that
  // has 90 seconds on it never reads "1 minute left" and then ends early.
  it('says how long is left, rounding up so a minute is never early', async () => {
    const endsIn = (ms: number) => deps({
      readHold: async () => ({
        reviewer: REVIEWER,
        takenAt: new Date(Date.now() - 60_000),
        lapsesAt: new Date(Date.now() + ms),
      }),
    });
    const remaining = async (ms: number) =>
      (await (await fetch(await startGuarded(endsIn(ms)) + CASE)).text());

    // Ninety seconds, twenty-nine, and one already past: three answers, and
    // the last one is the only one that says a hold is nearly over. Twenty-
    // nine seconds is the input that tells the rule apart from rounding to
    // nearest: 0.483 minutes rounds to none, and the rule says one.
    expect(await remaining(90_000)).toContain('2 minutes left');
    expect(await remaining(29_000)).toContain('1 minute left');
    expect(await remaining(29_000)).not.toContain('less than a minute left');
    const past = await remaining(-1_000);
    expect(past).toContain('less than a minute left');
    expect(past).not.toContain('1 minute left');
  });

  // DEC-47: a take from a narrowed queue returns to that queue. The four
  // forms carry both filters on their action, the POST reads them off the
  // URL, and the 303 rebuilds the case with both — so the reviewer's next
  // click is "← Needs a person" back to the list they were working. The
  // approval had this case; the take did not, and a later edit dropping
  // `${filters}` from the four strings would have shipped green.
  it('returns a take to the queue the reviewer narrowed to', async () => {
    const base = await startGuarded(deps({ readHold: async () => null }));
    const narrowed = await (await fetch(
      base + `${CASE}?rule=customer_visible&product=aurora`,
    )).text();
    expect(narrowed).toContain('action="/take?rule=customer_visible&amp;product=aurora"');

    const posted = await fetch(base + '/take?rule=customer_visible&product=aurora', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'same-origin',
      },
      body: new URLSearchParams({ runId: RUN }).toString(),
      redirect: 'manual',
    });
    expect(posted.status).toBe(303);
    const location = posted.headers.get('location') ?? '';
    expect(location).toContain('rule=customer_visible');
    expect(location).toContain('product=aurora');

    const landed = await (await fetch(base + location)).text();
    expect(landed).toContain('href="/?rule=customer_visible&amp;product=aurora"');
  });

  // The case is not the place for a hold: a run that is not waiting is not
  // something anyone takes, and the bar says nothing about it.
  it('draws no hold bar on a case that is not waiting', async () => {
    const base = await startGuarded(deps({
      readRun: caseOf({ state: 'resolved' }),
      readHold: async () => holdFor('anna@example.test', 8),
    }));
    const html = await (await fetch(base + CASE)).text();
    expect(html).not.toContain('Held by anna@example.test');
    expect(html).not.toContain('action="/take"');
  });

  // The take itself: the request's reviewer, the run from the form, and the
  // answer drawn back on the case it names.
  it('takes the case for the request\'s reviewer, and says so', async () => {
    const calls: Array<[string, string, boolean]> = [];
    const base = await startGuarded(deps({
      // The state the answer describes: this reviewer holds it now, so the
      // page's own read has to agree with the sentence (DEC-46).
      readHold: async () => holdFor(REVIEWER, 20),
      takeHold: async (runId: string, reviewer: string, over: boolean) => {
        calls.push([runId, reviewer, over]);
        return { outcome: 'taken' };
      },
    }));
    const res = await fetch(base + '/take', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'same-origin',
      },
      body: `runId=${RUN}`,
      redirect: 'manual',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/case/${RUN}?taken=taken`);
    // The reviewer the gate resolved, never a name from the form.
    expect(calls).toEqual([[RUN, REVIEWER, false]]);
    expect((await (await fetch(base + `/case/${RUN}?taken=taken`)).text()))
      .toContain('You hold this case now.');
  });

  // Risk row "Takeover bookkeeping", at the console's edge: the takeover is
  // the confirmed press and nothing else. A free case takes with no `over`.
  it('takes over only when the form confirms it', async () => {
    const seen: boolean[] = [];
    const base = await startGuarded(deps({
      readHold: async () => holdFor('anna@example.test', 8),
      takeHold: async (_runId: string, _reviewer: string, over: boolean) => {
        seen.push(over);
        return { outcome: 'held_by_other', holder: holdFor('anna@example.test', 8) };
      },
    }));
    const post = (body: string) => fetch(base + '/take', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'same-origin',
      },
      body,
      redirect: 'manual',
    });
    expect((await post(`runId=${RUN}&over=1`)).status).toBe(303);
    expect((await post(`runId=${RUN}`)).status).toBe(303);
    expect(seen).toEqual([true, false]);
    // And the page says what happened, in the words a person reads: the
    // refusal names whoever has it now (criterion 6).
    expect((await (await fetch(base + `/case/${RUN}?taken=held_by_other`)).text()))
      .toContain('anna@example.test holds this case now.');
  });

  it('releases the case its holder asked to release', async () => {
    const released: Array<[string, string]> = [];
    const base = await startGuarded(deps({
      releaseHold: async (runId: string, reviewer: string) => {
        released.push([runId, reviewer]);
        return { outcome: 'released' };
      },
    }));
    const res = await fetch(base + '/take', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'same-origin',
      },
      body: `runId=${RUN}&release=1`,
      redirect: 'manual',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/case/${RUN}?taken=released`);
    expect(released).toEqual([[RUN, REVIEWER]]);
  });

  // Criterion 3: a handover moves the case to the teammate it names, and the
  // holder is the only person who can hand it anywhere.
  it('hands the case to the teammate the holder names', async () => {
    const handed: Array<[string, string, string]> = [];
    const base = await startGuarded(deps({
      // Before the handover the holder is the reviewer; the page the redirect
      // lands on reads the case after it, so it names the teammate.
      readHold: async () => holdFor('bo@example.test', 20),
      handoverHold: async (runId: string, reviewer: string, to: string) => {
        handed.push([runId, reviewer, to]);
        return { outcome: 'handed_over' };
      },
    }));
    const res = await fetch(base + '/take', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'same-origin',
      },
      body: `runId=${RUN}&handover=1&to=bo%40example.test`,
      redirect: 'manual',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/case/${RUN}?taken=handed_over`);
    expect(handed).toEqual([[RUN, REVIEWER, 'bo@example.test']]);
    expect((await (await fetch(base + `/case/${RUN}?taken=handed_over`)).text()))
      .toContain('The case is theirs now.');
  });

  // Criterion 4 of issue #110, in its own words: hand to a teammate moves the
  // reservation, and the customer sees nothing. The console half is the move
  // and the words around it; the ledger half — no outbox record, no state
  // change, no reply text, and both published reports reading the same before
  // and after — is `src/holds/holds.db.test.ts`, which owns the write.
  it('hands over a case, and reaches no customer', async () => {
    const handed: Array<[string, string, string]> = [];
    // The two writes that do reach a customer, spied rather than assumed.
    // Without them this case proves the routing and nothing about the
    // customer: the state it reads is the harness's own fixture.
    const approve = vi.fn();
    const saveReply = vi.fn();
    const base = await startGuarded(deps({
      // The page the redirect lands on reads the case after the move, so it
      // names the teammate.
      readHold: async () => holdFor('bo@example.test', 20),
      handoverHold: async (runId: string, reviewer: string, to: string) => {
        handed.push([runId, reviewer, to]);
        return { outcome: 'handed_over' };
      },
      approve,
      saveReply,
    }));
    const res = await fetch(base + '/take', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'same-origin',
      },
      body: `runId=${RUN}&handover=1&to=bo%40example.test`,
      redirect: 'manual',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/case/${RUN}?taken=handed_over`);
    expect(handed).toEqual([[RUN, REVIEWER, 'bo@example.test']]);

    // The page the redirect lands on names the teammate. The banner and the
    // case's own state are the older case's subject; what this one adds is
    // that the move happened and that nothing else did.
    const page = await (await fetch(base + `/case/${RUN}?taken=handed_over`)).text();
    expect(page).toContain('Held by bo@example.test');
    // And the move is the whole of what this route did. Neither write that
    // can reach a customer ran, so nothing was sent and nothing was saved.
    expect(approve).not.toHaveBeenCalled();
    expect(saveReply).not.toHaveBeenCalled();
  });

  // Criterion 6, at the strength it has: a refusal keeps what the reviewer
  // typed. Typing a colleague's identity twice to fix a typo is the failure
  // this prevents.
  it('keeps the identity it was given when the handover is refused', async () => {
    const base = await startGuarded(deps({
      readHold: async () => holdFor(REVIEWER, 8),
      handoverHold: async () => ({ outcome: 'not_a_reviewer' }),
    }));
    const res = await fetch(base + '/take', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'same-origin',
      },
      body: `runId=${RUN}&handover=1&to=typo%40example.test`,
      redirect: 'manual',
    });
    expect(res.headers.get('location')).toBe(
      `/case/${RUN}?taken=not_a_reviewer&to=typo%40example.test`,
    );
    const html = await (await fetch(base + res.headers.get('location')!)).text();
    expect(html).toContain('That identity is not an active reviewer');
    expect(html).toContain('value="typo@example.test"');
  });

  // Criterion 6, the half a refusal owes: a reviewer whose hold moved is told
  // who holds the case now. This is how the earlier holder learns of it at
  // their next action, and it must name the person — "somebody else holds
  // this" sends them looking for who.
  it('tells the reviewer who holds the case now, when their hold moved', async () => {
    const base = await startGuarded(deps({
      readHold: async () => holdFor('anna@example.test', 8),
      releaseHold: async () => ({
        outcome: 'held_by_other',
        holder: holdFor('anna@example.test', 8),
      }),
    }));
    const res = await fetch(base + '/take', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'same-origin',
      },
      body: `runId=${RUN}&release=1`,
      redirect: 'manual',
    });
    expect(res.status).toBe(303);
    const html = await (await fetch(base + res.headers.get('location')!)).text();
    expect(html).toContain('anna@example.test holds this case now.');
    // Criterion 6's other half: the case is not taken away from them. The
    // reply they were reading is still on the page, and so is the takeover.
    expect(html).toContain('We refunded the duplicate charge.');
    expect(html).toContain('Take it over');
  });

  // The same refusal for a handover. The case is somebody else's now, so the
  // handover field is gone with it and there is nowhere for the typed name to
  // go; what the page owes is whose case it is.
  it('names the holder who has the case when a handover no longer finds theirs', async () => {
    const base = await startGuarded(deps({
      readHold: async () => holdFor('anna@example.test', 8),
      handoverHold: async () => ({ outcome: 'not_yours' }),
    }));
    const res = await fetch(base + '/take', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'same-origin',
      },
      body: `runId=${RUN}&handover=1&to=bo%40example.test`,
      redirect: 'manual',
    });
    const html = await (await fetch(base + res.headers.get('location')!)).text();
    expect(html).toContain('anna@example.test holds this case now.');
    // And the page offers the one thing left to do about it.
    expect(html).toContain('Take it over');
  });

  // And when the read finds nobody, the page says that rather than repeating
  // a sentence about a holder who is gone. The hold moved twice, or it lapsed
  // in the instant between the refusal and this page.
  it('does not claim a holder the read no longer finds', async () => {
    const base = await startGuarded(deps({ readHold: async () => null }));
    const html = await (await fetch(base + `${CASE}?taken=held_by_other`)).text();
    expect(html).toContain('Nobody holds this case.');
    expect(html).toContain('The hold moved, and nobody holds this case now.');
    // No name, and no claim that somebody has it.
    expect(html).not.toContain('anna@example.test');
    expect(html).not.toContain('Somebody else holds this case');
  });

  // A holder who types their own identity into the handover field. The field
  // is free text, so this is a press a person can make, and the answer says
  // the case is still theirs rather than that it moved.
  it('says the case stayed theirs when the handover named the holder', async () => {
    const base = await startGuarded(deps({
      readHold: async () => holdFor(REVIEWER, 8),
      handoverHold: async () => ({ outcome: 'already_yours' }),
    }));
    const res = await fetch(base + '/take', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'same-origin',
      },
      body: `runId=${RUN}&handover=1&to=${encodeURIComponent(REVIEWER)}`,
      redirect: 'manual',
    });
    expect(res.status).toBe(303);
    const html = await (await fetch(base + res.headers.get('location')!)).text();
    expect(html).toContain('You already hold this case, so it did not move.');
    expect(html).not.toContain('The case is theirs now.');
  });

  // The outcome arrives on the query string, so a link can carry any text.
  // `taken` is read like `outcome` is: a value this console does not know is
  // its own fixed sentence, never echoed as the console's words — and never a
  // bare lookup, because `Object.prototype` answers `toString` with a
  // function and `escapeHtml` then throws on it.
  it('answers an unknown take outcome in its own words, and never throws', async () => {
    const base = await startGuarded(deps());
    for (const taken of ['toString', 'constructor', '__proto__', 'valueOf', 'hello world']) {
      const res = await fetch(base + `${CASE}?taken=${encodeURIComponent(taken)}`);
      expect(res.status, taken).toBe(200);
      const html = await res.text();
      expect(html, taken).not.toContain(taken);
      expect(html, taken).toContain('That is not an answer this console knows.');
    }
    // And a value it does know still draws its own sentence.
    const known = await (await fetch(base + `${CASE}?taken=released`)).text();
    expect(known).toContain('You released this case.');
  });

  // The hold read failed. The page must not answer for it: "Nobody holds this
  // case" is a fact this read did not establish, and the take form would rest
  // on it. The fault rides to the bar with the tag of its log line, as the
  // customer read does, and the approval is untouched beside it.
  it('says the hold was not read, rather than that nobody has it', async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
    try {
      const base = await startGuarded(deps({
        readHold: async () => { throw new Error('connection terminated'); },
      }));
      const res = await fetch(base + CASE);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('The hold on this case was not read');
      expect(html).not.toContain('Nobody holds this case.');
      expect(html).not.toContain('action="/take"');
      // A fault reading the hold says nothing about the approval.
      expect(html).toContain('action="/approve');
      const record = logged
        .map((entry) => JSON.parse(entry) as Record<string, unknown>)
        .find((entry) => entry['event'] === 'console_hold_unread');
      expect(record).toBeDefined();
      expect(html).toContain(String(record!['tag']));
      expect(String(record!['error'])).toContain('connection terminated');
    } finally {
      spy.mockRestore();
    }
  });

  // A take sentence must fit the hold this page read (DEC-46). The redirect
  // carries it, and a link can carry any value: `?taken=taken` on a page that
  // reloaded after the hold lapsed drew "You hold this case now" beside
  // "Nobody holds this case".
  it('drops a take sentence the hold it describes has moved past', async () => {
    const base = await startGuarded(deps({ readHold: async () => null }));
    const html = await (await fetch(base + `${CASE}?taken=taken`)).text();
    expect(html).not.toContain('You hold this case now.');
    expect(html).toContain('That is not an answer this console knows.');
  });

  // The two refusals about somebody else's hold are dropped when the hold is
  // the reader's own: "Somebody else holds this case" under "Held by you" is
  // the same contradiction as the stale take, on the outcomes that word a
  // holder other than the one this page read.
  it('drops a refusal about somebody else when the hold is the reader\'s', async () => {
    const base = await startGuarded(deps({ readHold: async () => holdFor(REVIEWER, 8) }));
    for (const taken of ['held_by_other', 'not_yours']) {
      const html = await (await fetch(base + `${CASE}?taken=${taken}`)).text();
      expect(html, taken).toContain('Held by you');
      expect(html, taken).not.toContain('Somebody else holds this case');
      expect(html, taken).toContain('That is not an answer this console knows.');
    }
  });

  // And the answer survives a case that left the queue: `not_waiting` is
  // exactly what a take of a case somebody else just resolved answers.
  it('draws the take\'s answer on a case that has left the queue', async () => {
    const base = await startGuarded(deps({ readRun: caseOf({ state: 'resolved' }) }));
    const html = await (await fetch(base + `${CASE}?taken=not_waiting`)).text();
    expect(html).toContain('This case is not waiting for a person, so nobody can take it.');
    expect(html).not.toContain('action="/take"');
  });

  // The exception: an outcome whose fit is the run's state alone is drawn
  // even when the hold read failed. A take of a case that just left the
  // queue answers `not_waiting`, and the reviewer is owed that answer.
  it('draws the state-only answer when the hold could not be read', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const base = await startGuarded(deps({
        readRun: caseOf({ state: 'resolved' }),
        readHold: async () => { throw new Error('connection terminated'); },
      }));
      const html = await (await fetch(base + `${CASE}?taken=not_waiting`)).text();
      expect(html).toContain('This case is not waiting for a person, so nobody can take it.');
      // Nothing is said about a hold: the case is nobody's to take, and this
      // page did not read who has it.
      expect(html).not.toContain('The hold on this case was not read');
      expect(html).not.toContain('Held by');
      // A sentence about a hold is still dropped: the read cannot check it.
      const other = await (await fetch(base + `${CASE}?taken=released`)).text();
      expect(other).not.toContain('You released this case.');
    } finally {
      spy.mockRestore();
    }
  });

  // A fault can arrive after the transaction committed and before this
  // process read the answer, so the page does not claim the take failed.
  it('does not claim the take failed when the fault may have arrived late', async () => {
    const base = await startGuarded(deps({
      takeHold: async () => { throw new Error('connection terminated'); },
    }));
    const res = await fetch(base + '/take', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'same-origin',
      },
      body: `runId=${RUN}`,
      redirect: 'manual',
    });
    expect(res.status).toBe(500);
    expect(await res.text()).toContain('may or may not have committed');
  });

  // A run id of another shape is a request this console declines, and it
  // never reaches the hold.
  it('refuses a run id that is not one, without reaching the hold', async () => {
    const taken: string[] = [];
    const base = await startGuarded(deps({
      takeHold: async (runId: string) => { taken.push(runId); return { outcome: 'taken' }; },
    }));
    const res = await fetch(base + '/take', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'same-origin',
      },
      body: 'runId=abc',
      redirect: 'manual',
    });
    expect(res.status).toBe(400);
    expect(taken).toEqual([]);
  });

  // The take is a write about a person, so the console records it, with the
  // action the form asked for.
  it('records the take, the takeover and the release it made', async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
    try {
      const base = await startGuarded(deps({
        readHold: async () => holdFor('anna@example.test', 8),
      }));
      for (const body of [`runId=${RUN}`, `runId=${RUN}&over=1`, `runId=${RUN}&release=1`]) {
        await fetch(base + '/take', {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'sec-fetch-site': 'same-origin',
          },
          body,
          redirect: 'manual',
        });
      }
      const records = logged
        .map((entry) => JSON.parse(entry) as Record<string, unknown>)
        .filter((entry) => entry['event'] === 'console_took');
      expect(records.map((entry) => entry['action'])).toEqual(['take', 'over', 'release']);
      expect(records.every((entry) => entry['reviewer'] === REVIEWER)).toBe(true);
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
    await fetch(base + '/runs');
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
    const res = await fetch(`${base}/runs?state=made_up`);
    expect(res.status).toBe(404);
    expect(reached).toBe(false);
  });

  it('offers every state as a link, including the ones holding nothing today', async () => {
    const base = await startGuarded(deps({ listRuns: async () => [] }));
    const html = await (await fetch(base + '/runs')).text();
    for (const state of STATES) expect(html, state).toContain(`/runs?state=${state}`);
  });

  // An empty page that says nothing reads as a console that failed.
  it('names the state when that state holds no run', async () => {
    const base = await startGuarded(deps({ listRuns: async () => [] }));
    const html = await (await fetch(`${base}/runs?state=gated`)).text();
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

  // HEAD is a read. Every read route answers it as it answers GET, with no
  // body; the theme route writes a cookie, so it answers GET alone.
  /** A raw HEAD exchange, so the bytes after the headers are the server's own. */
  async function rawHead(base: string, path: string): Promise<{ head: string; after: string }> {
    const { port } = new URL(base);
    const wire = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(port), '127.0.0.1', () => {
        socket.write(`HEAD ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
      });
      let data = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => { data += chunk; });
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
      // Its own bound, so a server that never closes fails here by name.
      socket.setTimeout(2000, () => socket.destroy(new Error(`HEAD ${path}: the server did not close`)));
    });
    const split = wire.indexOf('\r\n\r\n');
    if (split === -1) throw new Error(`HEAD ${path}: no end of headers in ${JSON.stringify(wire)}`);
    return { head: wire.slice(0, split), after: wire.slice(split + 4) };
  }

  it('answers HEAD on every read route, and not on the theme route', async () => {
    const base = await startGuarded(deps());
    for (const path of [
      '/', '/runs', `/run/${RUN}`, CASE, `/conversation/${CONVERSATION}`, '/document/SYN-DOC-01',
      '/bands', '/latency', '/notes', '/console.css',
    ]) {
      const get = await fetch(base + path);
      const head = await fetch(base + path, { method: 'HEAD' });
      expect(head.status, path).toBe(get.status);
      expect(get.status, path).toBe(200);
      // The same headers a GET carries, so a HEAD tells a client the truth.
      for (const header of ['content-type', 'content-security-policy', 'x-frame-options', 'cache-control']) {
        expect(head.headers.get(header), `${path} ${header}`).toBe(get.headers.get(header));
      }
      // On the wire, so the check does not rest on a client dropping a body.
      // Node drops one written through `send`; this catches a body written to
      // the socket some other way.
      const raw = await rawHead(base, path);
      expect(raw.head, path).toMatch(/^HTTP\/1\.1 200 /);
      expect(raw.after, path).toBe('');
    }
    // The redirects and the refusals answer HEAD as they answer GET.
    for (const [path, location] of [
      ['/?state=awaiting_approval', '/runs?state=awaiting_approval'],
      ['/approvals', '/'],
      [`/?run=${RUN}`, CASE],
    ] as const) {
      const res = await fetch(base + path, { method: 'HEAD', redirect: 'manual' });
      expect(res.status, path).toBe(303);
      expect(res.headers.get('location'), path).toBe(location);
    }
    expect((await fetch(base + '/nowhere', { method: 'HEAD' })).status).toBe(404);
    const theme = await fetch(`${base}/theme?to=light&back=%2Fnotes`, { method: 'HEAD', redirect: 'manual' });
    expect(theme.status).toBe(404);
    expect(theme.headers.get('set-cookie')).toBeNull();
  });

  // A read that fails under HEAD fails as it does under GET: a tagged 500, and
  // the fault on the log line.
  it('answers a failed HEAD read with the tagged fault, and logs it', async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => { logged.push(String(line)); });
    try {
      const base = await startGuarded(deps({ listRuns: async () => { throw new Error('the runs read failed'); } }));
      const res = await fetch(base + '/runs', { method: 'HEAD' });
      expect(res.status).toBe(500);
      expect(logged.join('\n')).toContain('the runs read failed');
      expect(logged.join('\n')).toMatch(/"tag":"[0-9a-f]{8}"/);
    } finally {
      spy.mockRestore();
    }
  });

  it('returns to the design notes after the theme changes there', async () => {
    const base = await startGuarded(deps());
    const res = await fetch(`${base}/theme?to=light&back=%2Fnotes`, { redirect: 'manual' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/notes');
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

  // A document id is whatever the corpus uses, and may carry a character a
  // path cannot. The page names its own path encoded, so the theme returns
  // to that document rather than to the queue.
  it('returns to a document whose id carries a question mark or a percent sign', async () => {
    const base = await startGuarded(deps());
    for (const docId of ['kb/a?id=1', '50%']) {
      const html = await (await fetch(`${base}/document/${encodeURIComponent(docId)}`)).text();
      const back = /href="\/theme\?to=light&amp;back=([^"]+)"/.exec(html)?.[1];
      const res = await fetch(`${base}/theme?to=light&back=${back}`, { redirect: 'manual' });
      expect(res.headers.get('location'), docId).toBe(`/document/${encodeURIComponent(docId)}`);
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

describe('the queue a reviewer lands on (issue #101)', () => {
  const waitingRun = (runId: string, ticketId: string, over: Record<string, unknown>) => ({
    runId, ticketId, state: 'awaiting_approval', promptVer: 'p1', ...ROW,
    riskTier: 'medium',
    reason: null, stepsUsed: 4, draftExternalId: 'D-1', coverage: null,
    agreement: 0.91, agreementThreshold: 0.8, gateCoverage: 0.86, coverageReviewThreshold: 0.8,
    ...over,
  });
  const queue = () => [
    waitingRun('11111111-1111-4111-8111-111111111111', 'SYN-REST', { gateCoverage: 0.5 }),
    waitingRun('22222222-2222-4222-8222-222222222222', 'SYN-CLEAN', {}),
    waitingRun('33333333-3333-4333-8333-333333333333', 'SYN-RISK', { gateReason: 'irreversible' }),
  ];

  // Issue #105. The legend names only the keys that act on this page: j and
  // k move, Enter follows the focused row natively, c opens it, and `a`
  // activates the batch confirm DEC-51 added.
  it('lists only the keys that act on it, and rows stay links', async () => {
    const base = await startGuarded(deps({ listApprovals: async () => queue() }));
    const html = await (await fetch(base + '/')).text();
    // The whole line, so a key can join it only by failing this test. `a` is
    // on it because DEC-51 gives the batch confirm a key, and the legend
    // names the keys that act.
    expect(html).toContain(
      '<div class="keys">j / k move · enter opens · c takes the case · a confirms the clean cases</div>',
    );
    // Above the rows, where an uncapped queue cannot push it under the fold.
    expect(html.indexOf('<div class="keys">')).toBeLessThan(html.indexOf('<div class="list">'));
    // Degraded, the keys lose nothing: every row is still an anchor.
    expect(html).toMatch(/<a class="item" href="\/case\//);
  });

  // DEC-47: a chip per product the queue holds, each with the count read
  // from every waiting run. The product rides beside the rule as a second
  // filter, and one closed set does not name the other.
  describe('the product the case is for (DEC-47)', () => {
    const scoped = () => [
      waitingRun('11111111-1111-4111-8111-111111111111', 'SYN-AURORA', { product: 'aurora' }),
      waitingRun('22222222-2222-4222-8222-222222222222', 'SYN-LEDGER', { product: 'ledger' }),
      waitingRun('33333333-3333-4333-8333-333333333333', 'SYN-UNSCOPED', { product: null }),
      waitingRun('44444444-4444-4444-8444-444444444444', 'SYN-AURORA-2', { product: 'aurora' }),
    ];

    it('offers a chip per product, with the count read from every waiting run', async () => {
      const base = await startGuarded(deps({ listApprovals: async () => scoped() }));
      const queue = await (await fetch(base + '/')).text();

      expect(queue).toContain('<span class="lbl">product</span>');
      // The whole chip, so a count from the narrowed view cannot pass.
      expect(queue).toContain('<a href="/?product=aurora">Aurora<span class="dim"> 2</span></a>');
      expect(queue).toContain('<a href="/?product=ledger">Ledger<span class="dim"> 1</span></a>');
      expect(queue).toContain('<a href="/?product=__none__">no product<span class="dim"> 1</span></a>');
      // `all` is the one being shown, so it is the chip that is marked.
      expect(queue).toContain('<a href="/" class="on">all<span class="dim"> 4</span></a>');
    });

    it('narrows to one product without moving the other counts', async () => {
      const base = await startGuarded(deps({ listApprovals: async () => scoped() }));
      const narrowed = await (await fetch(base + '/?product=aurora')).text();

      expect(narrowed).toContain('SYN-AURORA');
      expect(narrowed).toContain('SYN-AURORA-2');
      expect(narrowed).not.toContain('SYN-LEDGER');
      expect(narrowed).not.toContain('SYN-UNSCOPED');
      // Every count is still read from the whole queue, so a filter never
      // reports the queue as smaller than it is.
      expect(narrowed).toContain('<a href="/?product=ledger">Ledger<span class="dim"> 1</span></a>');
      expect(narrowed).toContain('<a href="/">all<span class="dim"> 4</span></a>');
      expect(narrowed).not.toContain('<a href="/" class="on">all');
      // The chip for the product being shown is marked.
      expect(narrowed).toContain('<a href="/?product=aurora" class="on">Aurora');
      // And the count in the list header is the narrowed one.
      expect(narrowed).toContain('Waiting · 2');
    });

    it('narrows to the runs whose channel mapped to no product', async () => {
      const base = await startGuarded(deps({ listApprovals: async () => scoped() }));
      const narrowed = await (await fetch(base + '/?product=__none__')).text();
      expect(narrowed).toContain('SYN-UNSCOPED');
      expect(narrowed).not.toContain('SYN-AURORA');
      expect(narrowed).not.toContain('SYN-LEDGER');
    });

    it('says which filter emptied the queue, and names both when both did', async () => {
      const base = await startGuarded(deps({ listApprovals: async () => scoped() }));
      const product = await (await fetch(base + '/?product=not-a-product')).text();
      expect(product).toContain('Nothing waiting is for that product.');

      // Both filters at once: the view is the intersection, and the sentence
      // names both so a reviewer knows which to clear.
      const both = await (await fetch(base + '/?rule=irreversible&product=aurora')).text();
      expect(both).toContain('Nothing waiting carries that rule for that product.');
    });

    it('applies both filters at once, and keeps both on the way to a case', async () => {
      const base = await startGuarded(deps({ listApprovals: async () => scoped() }));
      const both = await (await fetch(base + '/?product=aurora&rule=customer_visible')).text();
      expect(both).toContain('SYN-AURORA');
      expect(both).not.toContain('SYN-LEDGER');

      // The chosen filters ride on each row's link, so opening a case and
      // coming back does not lose them.
      expect(both).toContain(
        'href="/case/11111111-1111-4111-8111-111111111111?rule=customer_visible&amp;product=aurora"',
      );
      const opened = await (await fetch(
        base + '/case/11111111-1111-4111-8111-111111111111?rule=customer_visible&product=aurora',
      )).text();
      expect(opened).toContain(
        '<a class="back" href="/?rule=customer_visible&amp;product=aurora">← Needs a person</a>',
      );
    });

    // DEC-47: the catalogue's label is what a person reads, and the id is
    // what the ledger holds. A product the catalogue no longer declares
    // still has runs, and it is shown by its id rather than by a blank.
    it('shows the label the catalogue gives a product, and the id without one', async () => {
      const base = await startGuarded(deps({
        listApprovals: async () => [
          waitingRun('11111111-1111-4111-8111-111111111111', 'SYN-AURORA', { product: 'aurora' }),
          waitingRun('22222222-2222-4222-8222-222222222222', 'SYN-RETIRED', {
            product: 'retired-product',
          }),
        ],
      }));
      const queue = await (await fetch(base + '/')).text();
      // The chip, the row and the header all name the label.
      expect(queue).toContain('>Aurora<span class="dim"> 1</span></a>');
      expect(queue).toContain('refund-request · Aurora · customer_visible');
      // A product the catalogue does not hold is shown by its id: the ledger
      // records that value, and it is the name an operator would look up.
      expect(queue).toContain('>retired-product<span class="dim"> 1</span></a>');
      expect(queue).toContain('refund-request · retired-product · customer_visible');
    });

    // The column is `text` with no CHECK, so a row can carry the empty
    // string — a hand-written insert, a backfill, a caller that passed it.
    // It is an absence, and every surface says so rather than drawing a
    // blank beside a chip that clears the filter.
    it('reads an empty product as the absence it is', async () => {
      const base = await startGuarded(deps({
        listApprovals: async () => [
          waitingRun('11111111-1111-4111-8111-111111111111', 'SYN-EMPTY', { product: '' }),
          waitingRun('22222222-2222-4222-8222-222222222222', 'SYN-AURORA', { product: 'aurora' }),
        ],
      }));
      const queue = await (await fetch(base + '/')).text();
      expect(queue).toContain('refund-request · no product · customer_visible');
      expect(queue).toContain('>no product<span class="dim"> 1</span></a>');
      expect(queue).not.toContain(' ·  · ');

      // And it narrows with the runs that carry no product at all.
      const narrowed = await (await fetch(base + '/?product=__none__')).text();
      expect(narrowed).toContain('SYN-EMPTY');
      expect(narrowed).not.toContain('SYN-AURORA');
    });

    // A run whose channel the map does not name says so on the row rather
    // than drawing nothing, which would read as a product nobody chose.
    it('says no product on the row a product would be', async () => {
      const base = await startGuarded(deps({
        listApprovals: async () => [
          waitingRun('33333333-3333-4333-8333-333333333333', 'SYN-UNSCOPED', { product: null }),
        ],
      }));
      const queue = await (await fetch(base + '/')).text();
      expect(queue).toContain('refund-request · no product · customer_visible');
    });

    // The order is the reviewer's, and a fault reading it does not take the
    // queue away: the queue is the work. The page says which log line names
    // the fault, so a reviewer who declared products knows why the list is
    // not in their order.
    it('orders by the reviewer\'s products, and says so when it cannot read them', async () => {
      const listed = await startGuarded(deps({
        listApprovals: async () => scoped(),
        readReviewerProducts: async () => ['ledger'],
      }));
      const queue = await (await fetch(listed + '/')).text();
      // The ledger case is the newest of the four and still leads its group.
      const order = [...queue.matchAll(/SYN-(AURORA|LEDGER|UNSCOPED|AURORA-2)/g)]
        .map((match) => match[0]);
      expect(order[0]).toBe('SYN-LEDGER');

      const broken = await startGuarded(deps({
        listApprovals: async () => scoped(),
        readReviewerProducts: async () => {
          throw new Error('the roster read failed');
        },
      }));
      const response = await fetch(broken + '/');
      expect(response.status).toBe(200);
      const drawn = await response.text();
      expect(drawn).toContain('SYN-AURORA');
      expect(drawn).toContain('The products you cover were not read');
      expect(drawn).toMatch(/The console log names the fault [0-9a-f]{8}\./);
      // And it did not reorder on a preference it could not read.
      expect(drawn.match(/SYN-LEDGER/g)?.length).toBe(1);
    });
  });

  it('shows no keys where there is no queue to move through', async () => {
    const base = await startGuarded(deps({ listApprovals: async () => [] }));
    const html = await (await fetch(base + '/')).text();
    // By structure, not wording: no keys line at all.
    expect(html).not.toContain('<div class="keys">');
  });

  it('opens on "Needs a person", and keeps Runs one link away', async () => {
    const base = await startGuarded(deps({ listApprovals: async () => queue() }));
    const landing = await (await fetch(base + '/')).text();
    expect(landing).toContain('<title>Needs a person');
    const runs = await fetch(base + '/runs');
    expect(runs.status).toBe(200);
    expect(await runs.text()).toContain('<title>Runs');
    expect(landing).toMatch(/<a href="\/"[^>]*><span class="navlabel">Needs a person<\/span>/);
    expect(landing).toMatch(/<a href="\/runs"[^>]*><span class="navlabel">Runs<\/span>/);
  });

  // Links written before the queue moved still resolve, to the place they meant.
  it('sends an old runs link and an old queue link where they now live', async () => {
    const base = await startGuarded(deps());
    const state = await fetch(base + '/?state=resolved', { redirect: 'manual' });
    expect(state.status).toBe(303);
    expect(state.headers.get('location')).toBe('/runs?state=resolved');
    // A link to one run on the old queue now names its case, in one hop.
    const queueLink = await fetch(base + `/approvals?run=${RUN}&rule=customer_visible`, { redirect: 'manual' });
    expect(queueLink.status).toBe(303);
    expect(queueLink.headers.get('location')).toBe(`/case/${RUN}?rule=customer_visible`);
    const filtered = await fetch(base + '/approvals?rule=customer_visible', { redirect: 'manual' });
    expect(filtered.headers.get('location')).toBe('/?rule=customer_visible');
    // A redirect is a response like any other, and it refuses a frame too.
    expect(queueLink.headers.get('x-frame-options')).toBe('DENY');
    expect(state.headers.get('x-frame-options')).toBe('DENY');
    const bare = await fetch(base + '/approvals', { redirect: 'manual' });
    expect(bare.headers.get('location')).toBe('/');
  });

  it('puts irreversible or high-risk work first, then clean, then the rest', async () => {
    const base = await startGuarded(deps({ listApprovals: async () => queue() }));
    const html = await (await fetch(base + '/')).text();
    const risk = html.indexOf('Irreversible or high risk');
    const clean = html.indexOf('Both gates clean');
    const rest = html.indexOf('Everything else waiting');
    expect(risk).toBeGreaterThan(-1);
    expect(clean).toBeGreaterThan(risk);
    expect(rest).toBeGreaterThan(clean);
    expect(html.indexOf('SYN-RISK')).toBeGreaterThan(risk);
    expect(html.indexOf('SYN-RISK')).toBeLessThan(clean);
    expect(html.indexOf('SYN-CLEAN')).toBeGreaterThan(clean);
    expect(html.indexOf('SYN-CLEAN')).toBeLessThan(rest);
    expect(html.indexOf('SYN-REST', rest)).toBeGreaterThan(rest);
  });

  it('says under the clean group that the gates are never blended and decided nothing', async () => {
    const base = await startGuarded(deps({ listApprovals: async () => queue() }));
    const html = await (await fetch(base + '/')).text();
    // Pinned whole: the design notes repeat the clean rule, and the two must
    // not drift apart.
    expect(html).toContain(
      'Agreement and coverage are two independent gates, and this console never blends'
        + ' them into one score. Clean means both values and both lines are recorded, and each value'
        + ' clears its own line. Neither gate decided these cases. Another rule sent each one to a person,'
        + ' and its row names the rule.',
    );
  });

  it('draws no group that holds nothing', async () => {
    const base = await startGuarded(deps({
      listApprovals: async () => [waitingRun('22222222-2222-4222-8222-222222222222', 'SYN-CLEAN', {})],
    }));
    const html = await (await fetch(base + '/')).text();
    expect(html).toContain('Both gates clean');
    expect(html).not.toContain('Irreversible or high risk');
    expect(html).not.toContain('Everything else waiting');
  });

  // Two counts from the ledger, and no share: a live percentage beside the
  // published containment would read as the same number.
  it("states today's arrivals and how many reached the queue, and no share", async () => {
    const base = await startGuarded(deps({
      listApprovals: async () => queue(),
      readQueueToday: async () => ({ day: '2026-09-14', arrived: 4823, reachedQueue: 41 }),
    }));
    const html = await (await fetch(base + '/')).text();
    expect(html).toContain('4823 messages arrived today (UTC)');
    expect(html).toContain('41 reached this queue');
    const head = html.slice(html.indexOf('<title>'), html.indexOf('Irreversible or high risk'));
    expect(head).not.toMatch(/\d%/);
    expect(head).not.toMatch(/contain/i);
  });

  // DEC-05 on the page: no value that combines agreement 0.91 and coverage
  // 0.86 appears anywhere on it.
  it('shows no number that combines the two gates', async () => {
    const base = await startGuarded(deps({
      listApprovals: async () => [waitingRun('22222222-2222-4222-8222-222222222222', 'SYN-CLEAN', {})],
    }));
    const html = await (await fetch(base + '/')).text();
    for (const combined of ['0.885', '0.89', '0.783', '0.78']) {
      expect(html, combined).not.toContain(combined);
    }
  });

  // The queue is a list. Each row opens its case, in working order, and no
  // case is drawn beside the list (issue #102).
  it('links each row to its case in working order, and draws no case beside the list', async () => {
    const base = await startGuarded(deps({ listApprovals: async () => queue() }));
    const html = await (await fetch(base + '/')).text();
    const hrefs = [...html.matchAll(/class="item" href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual([
      '/case/33333333-3333-4333-8333-333333333333',
      '/case/22222222-2222-4222-8222-222222222222',
      '/case/11111111-1111-4111-8111-111111111111',
    ]);
    // DEC-51: the queue now carries one form — the batch confirm of the
    // clean group — and one checkbox per clean row. What it still does not
    // draw is a case: no reply text, no per-case approval form.
    expect(html).not.toContain('class="pane"');
    expect(html).not.toContain('The reply, as the system drafted it');
    expect(html).toContain('<form method="post" action="/confirm">');
    expect([...html.matchAll(/<form/g)]).toHaveLength(1);
    expect([...html.matchAll(/name="runId"/g)]).toHaveLength(1);
    expect([...html.matchAll(/type="checkbox"/g)]).toHaveLength(1);
    // The control owns its form. Emitted after the form opened, the button
    // had no owner and submitted nothing, and every other assertion here
    // passed: the button's text, the form's presence, and the row's checkbox
    // are all true of inert markup.
    expect(buttonOwnsItsForm(html)).toBe(true);
  });

  // A high-risk intent on a customer reply is gated as `customer_visible`.
  // The tier the gate recorded puts it first all the same.
  it('puts a reply first when the gate recorded its intent as high risk', async () => {
    const base = await startGuarded(deps({
      listApprovals: async () => [
        waitingRun('22222222-2222-4222-8222-222222222222', 'SYN-CLEAN', {}),
        waitingRun('44444444-4444-4444-8444-444444444444', 'SYN-TIER', { riskTier: 'high' }),
      ],
    }));
    const html = await (await fetch(base + '/')).text();
    const tier = html.indexOf('SYN-TIER');
    expect(tier).toBeGreaterThan(html.indexOf('Irreversible or high risk'));
    expect(tier).toBeLessThan(html.indexOf('Both gates clean'));
    // The row says why a customer_visible reply is first.
    expect(html.slice(tier, html.indexOf('</a>', tier))).toContain('customer_visible · high-risk intent');
  });

  // A rule that already names the risk is not followed by a second mention.
  it('names a high-risk intent once on a row the high-risk rule stopped', async () => {
    const base = await startGuarded(deps({
      listApprovals: async () => [
        waitingRun('55555555-5555-4555-8555-555555555555', 'SYN-RULE', { gateReason: 'high_risk', riskTier: 'high' }),
      ],
    }));
    const html = await (await fetch(base + '/')).text();
    const row = html.slice(html.indexOf('SYN-RULE'), html.indexOf('</a>', html.indexOf('SYN-RULE')));
    expect(row).toContain('high_risk');
    expect(row).not.toContain('high-risk intent');
  });

  // The counts are a header. A ledger fault reading them names itself and
  // leaves the queue a reviewer came to work.
  it('still draws the queue when the counts cannot be read', async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
    try {
      const base = await startGuarded(deps({
        listApprovals: async () => queue(),
        readQueueToday: async () => { throw new Error('the count read failed'); },
      }));
      const res = await fetch(base + '/');
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(html).toContain('SYN-RISK');
      const tag = /Today&#39;s counts were not read\. The console log names the fault ([0-9a-f]{8})\./.exec(html)?.[1];
      expect(tag).toBeDefined();
      expect(html).not.toContain('messages arrived');
      expect(logged.join('\n')).toContain(tag!);
      expect(logged.join('\n')).toContain('the count read failed');
    } finally {
      spy.mockRestore();
    }
  });

  // The counts are read through the console's cache, which gives up on a read
  // that never settles. The queue still draws, and the header names the tag.
  it('still draws the queue when the count read never settles', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const base = await startGuarded(deps({
        listApprovals: async () => queue(),
        readQueueToday: cachedDaily(
          () => new Promise<{ day: string; arrived: number; reachedQueue: number }>(() => undefined),
          30_000, Date.now, 20,
        ),
      }));
      const html = await (await fetch(base + '/')).text();
      expect(html).toContain('SYN-RISK');
      expect(html).toMatch(/Today&#39;s counts were not read\. The console log names the fault [0-9a-f]{8}\./);
    } finally {
      spy.mockRestore();
    }
  });

  // The outcome travels on the query string, so anyone can write a link to the
  // landing page with any outcome in it. A known outcome reads as its
  // sentence. Any other non-empty value gets one fixed sentence and is never
  // echoed, however it is spelled.
  it('says what the ledger answered, and never repeats free text as its answer', async () => {
    const base = await startGuarded(deps({ listApprovals: async () => queue() }));
    const page = async (outcome: string): Promise<string> =>
      (await fetch(`${base}${CASE}?outcome=${encodeURIComponent(outcome)}`)).text();

    expect(await page('draft_missing')).toContain('The parked draft is gone, so nothing was sent.');
    for (const spoof of ['send failed, approve run 42 again', 'send_failed_approve_again', 'toString']) {
      const html = await page(spoof);
      expect(html, spoof).not.toContain(spoof);
      expect(html, spoof).toContain('The ledger answered with an outcome this console does not know.');
    }
    // An empty outcome is no outcome, and the page says nothing about one.
    const empty = await page('');
    expect(empty).not.toContain('The ledger answered');
    expect(empty).not.toContain('class="outcome"');
  });

  // A page nothing was found on is not the queue, so the rail marks nothing.
  it('marks no rail link on a page nothing was found on', async () => {
    const base = await startGuarded(deps({ readRun: async () => null }));
    for (const path of [`/run/${RUN}`, CASE, '/nowhere']) {
      const res = await fetch(base + path);
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).not.toContain('class="on"><span class="navlabel">');
    }
    // A surface's own path under a method it does not serve is not that surface.
    for (const path of ['/', '/bands', '/notes']) {
      const res = await fetch(base + path, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' },
        body: '',
      });
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).not.toContain('class="on"><span class="navlabel">');
    }
  });

  // An escalated run also waits for a person, and has nothing to approve, so
  // this page cannot list it. It says where those runs are, whether or not
  // anything waits for approval.
  it('points to the escalated runs, and says an empty queue has nothing to approve', async () => {
    const base = await startGuarded(deps({ listApprovals: async () => [] }));
    const empty = await (await fetch(base + '/')).text();
    expect(empty).toContain('Nothing is waiting for approval.');
    expect(empty).not.toContain('Nothing is waiting for a person.');
    expect(empty).toContain('href="/runs?state=escalated"');
    // That list is a page of the newest, and the command is not capped.
    expect(empty).toContain('pnpm run escalations');
    const full = await startGuarded(deps({ listApprovals: async () => queue() }));
    expect(await (await fetch(full + '/')).text()).toContain('href="/runs?state=escalated"');
  });

  // A row says why it sits where it does when its rule does not: a parked
  // compensation, and a gate row that recorded no tier to judge it by.
  it('names a compensation, and a tier the gate did not record', async () => {
    const base = await startGuarded(deps({
      listApprovals: async () => [
        waitingRun('66666666-6666-4666-8666-666666666666', 'SYN-COMP', {
          gateReason: 'no_idempotency', actionClass: COMPENSATION_ACTION_CLASS, riskTier: 'low',
        }),
        waitingRun('77777777-7777-4777-8777-777777777777', 'SYN-OLD', { riskTier: null }),
        waitingRun('88888888-8888-4888-8888-888888888888', 'SYN-IRR', {
          gateReason: 'irreversible', actionClass: COMPENSATION_ACTION_CLASS, riskTier: 'low',
        }),
      ],
    }));
    const html = await (await fetch(base + '/')).text();
    const rowOf = (ticket: string): string =>
      html.slice(html.indexOf(ticket), html.indexOf('</a>', html.indexOf(ticket)));
    expect(rowOf('SYN-COMP')).toContain('no_idempotency · compensation');
    expect(rowOf('SYN-OLD')).toContain('tier unrecorded');
    // The rule already says it cannot be undone.
    expect(rowOf('SYN-IRR')).not.toContain('compensation');
    expect(rowOf('SYN-COMP')).not.toContain('tier unrecorded');
  });

  it('says so when a filter matches nothing', async () => {
    const base = await startGuarded(deps({ listApprovals: async () => queue() }));
    const html = await (await fetch(base + '/?rule=high_risk')).text();
    expect(html).toContain('Nothing waiting carries that rule.');
  });

  it('comes back to the case after an approval, with what the ledger answered', async () => {
    const base = await startGuarded(deps());
    const res = await fetch(base + '/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' },
      body: `runId=${RUN}&shown=${SHOWN}`,
      redirect: 'manual',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/case/${RUN}?outcome=approved`);
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
  // the list beside itself. It draws no case at all now.
  it('lists everything waiting and draws none of their cases', async () => {
    const base = await startGuarded(deps({ listApprovals: async () => waiting }));
    const html = await (await fetch(base + '/')).text();
    expect(html).toContain('SYN-1');
    expect(html).toContain('SYN-2');
    expect(html).not.toContain('D-1');
    expect(html).not.toContain('D-2');
    // The one control on the page is the batch confirm of the clean group
    // (DEC-51). What it does not draw is a case: no reply text, and no
    // control that sends one on its own.
    expect([...html.matchAll(/<form/g)]).toHaveLength(1);
    expect(html).toContain('Confirm all');
    expect(html).not.toContain('The reply, as the system drafted it');
  });

  // A link that named a run on the queue now opens that run's case.
  it('sends a link naming a run to its case, with the filter kept', async () => {
    const base = await startGuarded(deps({ listApprovals: async () => waiting }));
    const plain = await fetch(`${base}/?run=${RUN_B}`, { redirect: 'manual' });
    expect(plain.status).toBe(303);
    expect(plain.headers.get('location')).toBe(`/case/${RUN_B}`);
    const kept = await fetch(`${base}/?run=${RUN_B}&rule=customer_visible`, { redirect: 'manual' });
    expect(kept.headers.get('location')).toBe(`/case/${RUN_B}?rule=customer_visible`);
    expect(kept.headers.get('x-frame-options')).toBe('DENY');
  });

  // A value that is not a run id is never rebuilt into a path. The queue draws
  // as if no run were named.
  it('draws the queue for a named run it has not checked the shape of', async () => {
    const base = await startGuarded(deps({ listApprovals: async () => waiting }));
    const res = await fetch(`${base}/?run=${encodeURIComponent('<script>')}`, { redirect: 'manual' });
    expect(res.status).toBe(200);
    const html = await res.text();
    // The page ships exactly one script, the pinned one.
    expect(html.split('<script>')).toHaveLength(2);
    expect(html).toContain('SYN-1');
  });
});

// Criterion 4 (DEC-46). Four reviewers pull from one uncapped list, and
// nothing on it said which cases somebody was already reading. The queue now
// says who holds each of those, and for how long.
describe('the queue\'s held group (DEC-46)', () => {
  const RUN_B = '8a2d4c6e-1f3b-4a90-9c7e-2d5b8f0a1c34';

  function waiting(...runIds: readonly string[]) {
    return runIds.map((runId, i) => ({
      runId, ticketId: `SYN-${i}`, state: 'awaiting_approval', promptVer: 'p1', ...ROW,
      reason: 'customer_visible', stepsUsed: 4, agreement: 0.89, coverage: 0.94,
      draftExternalId: `D-${i}`,
    }));
  }

  /** A live hold, taken `minutes` ago, as the queue reader returns it. */
  const heldBy = (reviewer: string, minutes: number) => ({
    reviewer,
    takenAt: new Date(Date.now() - minutes * 60_000),
    lapsesAt: new Date(Date.now() + (20 - minutes) * 60_000),
  });

  /** The one row a case opened from this queue would open, as HTML. */
  const rowFor = (html: string, runId: string): string => {
    const at = html.indexOf(`href="/case/${runId}"`);
    return at === -1 ? '' : html.slice(at, html.indexOf('</a>', at));
  };

  it('names the holder and how long they have held it, in its own group', async () => {
    const base = await startGuarded(deps({
      listApprovals: async () => waiting(RUN),
      readHolds: async () => new Map([[RUN, heldBy('anna@example.test', 4)]]),
    }));
    const html = await (await fetch(base + '/')).text();
    expect(html).toContain('Held by someone else');
    expect(rowFor(html, RUN)).toContain('held by anna@example.test · 4m');
  });

  // The group is "held by someone else", and a case the reader holds is not.
  // It stays where its gate facts put it: it is theirs to work.
  it('keeps a case the reader holds in its own group', async () => {
    const base = await startGuarded(deps({
      listApprovals: async () => waiting(RUN, RUN_B),
      readHolds: async () => new Map([
        [RUN, heldBy(REVIEWER, 3)],
        [RUN_B, heldBy('anna@example.test', 4)],
      ]),
    }));
    const html = await (await fetch(base + '/')).text();
    expect(html).toContain('Held by someone else');
    // The reader's own case is drawn above the held group, so it is not in it.
    expect(html.indexOf('SYN-0')).toBeLessThan(html.indexOf('Held by someone else'));
    expect(rowFor(html, RUN_B)).toContain('held by anna@example.test');
    // And the reader's row claims no holder: the group is somebody else's.
    expect(rowFor(html, RUN)).not.toContain('held by');
  });

  it('names each holder on that holder\'s own row', async () => {
    const base = await startGuarded(deps({
      listApprovals: async () => waiting(RUN, RUN_B),
      readHolds: async () => new Map([
        [RUN, heldBy('anna@example.test', 4)],
        [RUN_B, heldBy('bo@example.test', 9)],
      ]),
    }));
    const html = await (await fetch(base + '/')).text();
    expect(rowFor(html, RUN)).toContain('held by anna@example.test · 4m');
    expect(rowFor(html, RUN)).not.toContain('bo@example.test');
    expect(rowFor(html, RUN_B)).toContain('held by bo@example.test · 9m');
  });

  // Criterion 4, risk row "Queue query count". The queue is uncapped and the
  // holds are read for the whole page at once: a read per row is one
  // statement behind every row, and a 476-row queue cost 476 of them.
  it('reads the holds for the whole page in one call', async () => {
    const ids = Array.from(
      { length: 30 },
      (_, i) => `0000000${String(i).padStart(2, '0')}-1111-4111-8111-111111111111`,
    );
    const calls: string[][] = [];
    const base = await startGuarded(deps({
      listApprovals: async () => waiting(...ids),
      readHolds: async (runIds: readonly string[]) => {
        calls.push([...runIds]);
        return new Map();
      },
    }));
    await (await fetch(base + '/')).text();
    expect(calls).toEqual([ids]);
  });

  // Failure mode "timeouts". The queue is the work, so a fault reading the
  // holds does not take it away. It draws without them and says so, because a
  // queue that quietly dropped the holders would read as a queue nobody has.
  it('draws the queue when the holds cannot be read, and says so', async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
    try {
      const base = await startGuarded(deps({
        listApprovals: async () => waiting(RUN),
        readHolds: async () => { throw new Error('connection terminated'); },
      }));
      const html = await (await fetch(base + '/')).text();
      expect(html).toContain('SYN-0');
      expect(html).not.toContain('Held by someone else');
      expect(html).not.toContain('held by');
      const record = logged
        .map((entry) => JSON.parse(entry) as Record<string, unknown>)
        .find((entry) => entry['event'] === 'console_holds_unread');
      expect(record).toBeDefined();
      expect(String(record!['error'])).toContain('connection terminated');
      // The page names the log line, as the counts' fault does.
      expect(html).toContain(String(record!['tag']));
    } finally {
      spy.mockRestore();
    }
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
    const html = await (await fetch(base + '/')).text();
    expect(html).toContain('high_risk');
    expect(html).not.toContain('no reason journalled');
  });

  it('says what the ticket is about and how well the reply is covered', async () => {
    const base = await startGuarded(deps({
      listApprovals: async () => waiting({
        intentId: 'billing-dispute', gateCoverage: 0.4, gateReason: 'groundedness_review',
      }),
    }));
    const html = await (await fetch(base + '/')).text();
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
      const html = await (await fetch(base + '/')).text();
      expect(html, rule).toContain('coverage 0.40 (not read)');
    }
  });

  it('marks nothing when a threshold is what decided', async () => {
    for (const rule of ['groundedness_review', 'groundedness_block', 'auto']) {
      const base = await startGuarded(deps({
        listApprovals: async () => waiting({ gateCoverage: 0.4, gateReason: rule }),
      }));
      const html = await (await fetch(base + '/')).text();
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
    const queue = await (await fetch(base + '/')).text();
    expect(shown(queue)).toBe(false);
    expect(queue).toContain('a rule this console does not know');
    expect(queue).toContain('(not read)');

    // The narrowed header, which names the active rule.
    const narrowed = await (await fetch(
      base + '/?rule=' + encodeURIComponent(foreign),
    )).text();
    expect(shown(narrowed)).toBe(false);

    // And the runs table, which merges the two reason vocabularies.
    const runs = await (await fetch(base + '/runs')).text();
    expect(shown(runs)).toBe(false);
  });

  // The header says the oldest is on this list, and nothing on it said how
  // old anything was.
  it('says how long each run has waited', async () => {
    const hoursAgo = new Date(Date.now() - 5 * 3_600_000);
    const base = await startGuarded(deps({
      listApprovals: async () => waiting({ createdAt: hoursAgo }),
    }));
    const html = await (await fetch(base + '/')).text();
    expect(html).toContain('5h');
  });

  // A run the ledger could not date has an unknown age. Printing "just now"
  // would put the freshest label on the run least is known about.
  it('says an age it does not have is unrecorded, rather than now', async () => {
    const base = await startGuarded(deps({
      listApprovals: async () => waiting({ createdAt: null }),
    }));
    const html = await (await fetch(base + '/')).text();
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
    const html = await (await fetch(base + '/')).text();
    expect(html).toContain('rule=customer_visible');
    expect(html).toContain('rule=high_risk');
    // A run whose rule the ledger never recorded is still a run a person has
    // to work, so it is reachable rather than hidden.
    expect(html).toContain('rule=unruled');
  });

  it('shows only the runs carrying the chosen rule', async () => {
    const base = await startGuarded(deps({ listApprovals: async () => mixed() }));
    const html = await (await fetch(base + '/?rule=high_risk')).text();
    expect(html).toContain('SYN-c');
    expect(html).not.toContain('SYN-a');
    expect(html).toContain('Waiting · 1');
  });

  // The badge counts the queue, not the view. A badge that fell because a
  // filter was on would report a queue that had emptied.
  it('counts everything waiting in the header, whatever the filter shows', async () => {
    const base = await startGuarded(deps({ listApprovals: async () => mixed() }));
    const html = await (await fetch(base + '/?rule=high_risk')).text();
    expect(html).toContain('4 waiting');
  });

  // A rule nothing carries is not an error. It narrowed to nothing, which is
  // what was asked for, and the page says so rather than showing the queue.
  it('says nothing carries a rule nothing carries', async () => {
    const base = await startGuarded(deps({ listApprovals: async () => mixed() }));
    const html = await (await fetch(base + '/?rule=no_idempotency')).text();
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
        base + '/?rule=' + encodeURIComponent(hostile),
      )).text();
      expect(html, hostile).not.toContain(hostile);
      expect(html, hostile).not.toContain(escapeHtml(hostile));
      expect(html, hostile).not.toContain(encodeURIComponent(hostile));
      expect(html, hostile).toContain('Nothing waiting carries that rule');
    }
  });

  // DEC-47 gives the queue a second filter, and a query string is a query
  // string: the product is never echoed either, not raw, not escaped, not
  // encoded. The page names only the products the waiting runs carry.
  it('never echoes a product the query string invented', async () => {
    const base = await startGuarded(deps({ listApprovals: async () => mixed() }));
    for (const hostile of ['<script>alert(1)</script>', '"onmouseover="x', 'zzz-marker']) {
      const html = await (await fetch(
        base + '/?product=' + encodeURIComponent(hostile),
      )).text();
      expect(html, hostile).not.toContain(hostile);
      expect(html, hostile).not.toContain(escapeHtml(hostile));
      expect(html, hostile).not.toContain(encodeURIComponent(hostile));
      expect(html, hostile).toContain('Nothing waiting is for that product.');
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
    const html = await (await fetch(base + '/runs')).text();
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
    return (await fetch(base + '/runs')).text();
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

  // DEC-40: the reply a person reads is the reply the button sends. The case
  // reads the run its path names and posts that run, whatever else the query
  // string carries.
  it('reads and posts the run its path names, and no other', async () => {
    const readFor: string[] = [];
    const base = await startGuarded(deps({
      listApprovals: async () => two(),
      readRun: async (runId: string) => {
        readFor.push(runId);
        return {
          ...WAITING, runId,
          // The partition nulled so the draft body itself renders, which is
          // the text an approver reads.
          evidence: { ...EVIDENCE, sentences: null, claims: null, draftBody: `the reply of ${runId}` },
        } as never;
      },
    }));
    const html = await (await fetch(base + `/case/${B}?run=${A}&rule=high_risk`)).text();
    expect(readFor).toEqual([B]);
    expect(/name="runId" value="([^"]+)"/.exec(html)?.[1]).toBe(B);
    expect(html).toContain(`the reply of ${B}`);
    expect(html).not.toContain(`the reply of ${A}`);
  });

  it('keeps the filter on every row it draws, so opening one does not clear it', async () => {
    const base = await startGuarded(deps({ listApprovals: async () => two() }));
    const html = await (await fetch(base + '/?rule=high_risk')).text();
    expect(html).toContain(`href="/case/${A}?rule=high_risk"`);
  });

  // An operator working one rule lost the filter on every approval and had
  // to reapply it. The filter travels on the form's action rather than as a
  // field, because this form's one field is the run id and that is what stops
  // a posted body being recorded as an approved reply.
  it('keeps the filter across an approval, and on the way back to the queue', async () => {
    const base = await startGuarded(deps({
      listApprovals: async () => two(),
      readRun: caseOf({ runId: A }),
      approve: async () => 'approved',
    }));
    const html = await (await fetch(base + `/case/${A}?rule=high_risk`)).text();
    expect(html).toContain('action="/approve?rule=high_risk"');
    expect(html).toContain('href="/?rule=high_risk"');

    const posted = await fetch(base + '/approve?rule=high_risk', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'same-origin',
      },
      body: `runId=${A}&shown=${SHOWN}`,
      redirect: 'manual',
    });
    expect(posted.status).toBe(303);
    expect(posted.headers.get('location')).toBe(`/case/${A}?outcome=approved&rule=high_risk`);
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
      body: `runId=${A}&shown=${SHOWN}`,
      redirect: 'manual',
    });
    expect(posted.headers.get('location')).toBe(`/case/${A}?outcome=approved`);
  });

  // The rail badge is the queue, not the view. A badge that fell because a
  // filter was on would report a queue that had emptied.
  it('keeps the rail badge counting the whole queue under a filter', async () => {
    const base = await startGuarded(deps({ listApprovals: async () => two() }));
    const html = await (await fetch(base + '/?rule=high_risk')).text();
    expect(html).toContain('<span class="badge">2</span>');
  });

  // A filter that can only narrow to everything is not a filter.
  it('offers no filter bar when every waiting run carries one rule', async () => {
    const base = await startGuarded(deps({
      listApprovals: async () => two().map((run) => ({ ...run, gateReason: 'high_risk' })),
    }));
    const html = await (await fetch(base + '/')).text();
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
    const html = await (await fetch(base + '/?rule=unruled')).text();
    expect(html).toContain('Waiting · 1 · no gate rule');
  });
});

// The gate panel, on the surface that decides an approval.
describe('what the gate panel says when a threshold decided nothing', () => {
  // The panel draws each value against its thresholds, which reads as a
  // comparison that happened. The engine short-circuits, so on most of this
  // queue no comparison did — and the panel sat under a row that said the
  // coverage was not read, contradicting it.
  const shortCircuits = ['customer_visible', 'high_risk', 'irreversible', 'no_idempotency'];
  for (const rule of shortCircuits) {
    it(`says the thresholds decided nothing on a ${rule} case`, async () => {
      const base = await startGuarded(deps({
        readRun: caseOf({ gateReason: rule, policyReason: rule }),
      }));
      const html = await (await fetch(base + CASE)).text();
      expect(html, rule).toContain('before it read');
      expect(html, rule).toContain(rule);
    });
  }

  it('says nothing of the kind when a threshold is what decided', async () => {
    const base = await startGuarded(deps({
      readRun: caseOf({ gateReason: 'groundedness_review', policyReason: 'groundedness_review' }),
    }));
    const html = await (await fetch(base + CASE)).text();
    expect(html).not.toContain('before it read');
  });
});

// The case a reviewer decides on (issue #102). One page per run, holding the
// customer's words, the reply and its documents, why it reached a person, the
// two gates, the steps and the approval.
describe('the case a reviewer decides on (issue #102)', () => {
  /** The markup of the card whose label is `label`, up to the next card. */
  function cardOf(html: string, label: string): string {
    const start = html.indexOf(label);
    expect(start, label).toBeGreaterThan(-1);
    // Up to the next card, or the action bar after the last one.
    const ends = [html.indexOf('<div class="card', start + 1), html.indexOf('class="actionbar"', start)]
      .filter((i) => i !== -1);
    return html.slice(start, ends.length === 0 ? undefined : Math.min(...ends));
  }

  // Issue #105. Esc leaves the case by the same link a click does.
  it('says Esc returns to the queue, beside the link it follows', async () => {
    const base = await startGuarded(deps());
    const html = await (await fetch(base + CASE)).text();
    // The hint sits right beside the link it follows, as the page renders it.
    expect(html).toContain('<div class="backrow"><a class="back" href="/">← Needs a person</a><span class="backkey">esc returns to the queue</span></div>');
    // The rule form too: Esc keeps the queue filter the reviewer chose.
    const ruled = await (await fetch(`${base}${CASE}?rule=customer_visible`)).text();
    expect(ruled).toContain('<div class="backrow"><a class="back" href="/?rule=customer_visible">← Needs a person</a><span class="backkey">esc returns to the queue</span></div>');
  });

  it('heads the case with its ticket, its turn, its intent, its run and a way back', async () => {
    const base = await startGuarded(deps());
    const html = await (await fetch(base + CASE + '?rule=customer_visible')).text();
    expect(html).toContain('<title>Case SYN-1');
    const head = html.slice(html.indexOf('class="casehd"'), html.indexOf('class="case"'));
    expect(head).toContain('href="/?rule=customer_visible"');
    expect(head).toContain('SYN-1');
    expect(head).toContain('turn 1');
    expect(head).toContain('refund-request');
    expect(head).toContain(RUN);
  });

  // The reason is the journal's, never a sentence the page assumes. On a
  // FreeScout ledger every reply stops on the idempotency rule first.
  it('names the policy rule the journal recorded, and not the one a reply usually carries', async () => {
    const base = await startGuarded(deps({
      readRun: caseOf({ gateReason: 'customer_visible', policyReason: 'no_idempotency' }),
    }));
    const why = cardOf(await (await fetch(base + CASE)).text(), 'Why this is yours');
    expect(why).toContain('no_idempotency');
    expect(why).toContain('cannot tell a repeated send from a new one');
    expect(why).not.toContain('customer_visible');
  });

  it('says so when the journal recorded no rule, or one this console does not know', async () => {
    const none = await startGuarded(deps({ readRun: caseOf({ policyReason: null }) }));
    expect(cardOf(await (await fetch(none + CASE)).text(), 'Why this is yours'))
      .toContain('The journal recorded no policy rule for this run.');
    const unknown = await startGuarded(deps({ readRun: caseOf({ policyReason: 'mystery_rule' }) }));
    const why = cardOf(await (await fetch(unknown + CASE)).text(), 'Why this is yours');
    expect(why).toContain('a rule this console does not know');
    expect(why).not.toContain('mystery_rule');
  });

  // The delivery contract, in words, for the act the approval performs.
  it('says how the approved act is delivered', async () => {
    const once = await startGuarded(deps({ readRun: caseOf({ delivery: 'at_most_once' }) }));
    expect(cardOf(await (await fetch(once + CASE)).text(), 'Why this is yours'))
      .toContain('sent at most once');
    const again = await startGuarded(deps({ readRun: caseOf({ delivery: 'at_least_once' }) }));
    expect(cardOf(await (await fetch(again + CASE)).text(), 'Why this is yours'))
      .toContain('may be sent again');
    const unrecorded = await startGuarded(deps({ readRun: caseOf({ delivery: null }) }));
    expect(cardOf(await (await fetch(unrecorded + CASE)).text(), 'Why this is yours'))
      .toContain('The park recorded no delivery rule.');
  });

  // DEC-05: two rows, each value on its own line against its own marks.
  it('draws agreement and coverage as two rows, and no value made of both', async () => {
    const base = await startGuarded(deps());
    const gates = cardOf(await (await fetch(base + CASE)).text(), 'The two gates');
    expect(gates).toContain('class="gates rows"');
    expect(gates.match(/class="gate"/g) ?? []).toHaveLength(2);
    expect(gates.match(/0\.890/g) ?? []).toHaveLength(1);
    expect(gates.match(/0\.940/g) ?? []).toHaveLength(1);
    expect(gates.indexOf('Sample agreement')).toBeLessThan(gates.indexOf('Groundedness coverage'));
  });

  // A dash alone reads as a value nobody bothered to print. The reason is on
  // the page, not in a tooltip.
  it('shows an unread gate as a dash with its reason in words', async () => {
    const base = await startGuarded(deps({ readRun: caseOf({ agreement: null, coverage: null }) }));
    const gates = cardOf(await (await fetch(base + CASE)).text(), 'The two gates');
    expect(gates.match(/<span class="big">—<\/span>/g) ?? []).toHaveLength(2);
    expect(gates).toContain('the journal holds no agreement for this run');
    expect(gates).toContain('the journal holds no coverage for this run');
  });

  it('draws the steps as a timeline, and no step carries a duration', async () => {
    const base = await startGuarded(deps());
    const walked = cardOf(await (await fetch(base + CASE)).text(), 'How the run walked');
    expect(walked).toContain('class="tl"');
    for (const step of ['classify', 'retrieve', 'park']) expect(walked).toContain(step);
    expect(walked).not.toMatch(/\d\s?(ms|s|sec|min)\b/);
  });

  // The ledger holds a turn, when the conversation opened, its state and
  // whether a participant is named. It holds no name, plan or history.
  it('shows what the ledger holds about the customer, and names what it does not', async () => {
    const base = await startGuarded(deps());
    const card = cardOf(await (await fetch(base + CASE)).text(), 'This customer');
    expect(card).toContain('turn 1 of 2');
    expect(card).toContain('2026-09-06');
    expect(card).toContain('open');
    expect(card).toContain('a participant is named');
    expect(card).toContain(`href="/conversation/${CONVERSATION}"`);
    expect(card).toContain('The ledger holds no name, plan, tenure or account history for this customer.');
    for (const invented of ['plan:', 'tenure:', 'refunds in', 'case count']) {
      expect(card.toLowerCase()).not.toContain(invented);
    }
  });

  // An approval redirects here, and the page renders after the read's own
  // fault handling. A time the driver could not turn into a date would have
  // thrown there and hidden whether the approval committed.
  it('draws the outcome of an approval when the conversation time is unreadable', async () => {
    const base = await startGuarded(deps({
      readRun: caseOf({ state: 'resolved', approved: true }),
      readConversation: async () => ({
        conversationId: CONVERSATION, primaryTicketId: 'SYN-1', state: 'open',
        openedAt: new Date(Number.NaN), participantNamed: true, turns: [],
      }),
    }));
    const res = await fetch(`${base}${CASE}?outcome=approved`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Approved. The relay performs it next.');
    expect(html).toContain('not a readable time');
  });

  // The same on a case still waiting, which is where a refused approval
  // lands. Its header prints an age, and an age of an unreadable time would
  // have thrown there.
  it('draws a refusal on a waiting case whose own time is unreadable', async () => {
    const base = await startGuarded(deps({ readRun: caseOf({ createdAt: new Date(Number.NaN) }) }));
    const res = await fetch(`${base}${CASE}?outcome=draft_missing`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('The parked draft is gone, so nothing was sent.');
    expect(html).toContain('waiting age unreadable');
  });

  // A run recorded before the turn was stored carries a conversation and no
  // request. It still has a customer, and the case reads that conversation.
  it('reads the conversation a run carries when it recorded no request', async () => {
    const readConversation = vi.fn(async () => (await deps().readConversation(CONVERSATION)));
    const base = await startGuarded(deps({
      readRun: caseOf({ request: null, conversationId: CONVERSATION }),
      readConversation: readConversation as never,
    }));
    const card = cardOf(await (await fetch(base + CASE)).text(), 'This customer');
    expect(readConversation.mock.calls).toEqual([[CONVERSATION]]);
    expect(card).toContain('this run answered no turn of 2');
  });

  // A fault reading the customer does not take the case away. The approval
  // lands here with its outcome, and a 500 would hide whether it committed.
  it('still draws the case and its outcome when the customer read fails', async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => { logged.push(String(line)); });
    try {
      const base = await startGuarded(deps({
        readRun: caseOf({ state: 'resolved', approved: true }),
        readConversation: async () => { throw new Error('the conversation read failed'); },
      }));
      const res = await fetch(base + CASE + '?outcome=approved');
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(html).toContain('data-outcome="approved"');
      const tag = /The customer was not read\. The console log names the fault ([0-9a-f]{8})\./.exec(html)?.[1];
      expect(tag).toBeDefined();
      expect(html).not.toContain('The ledger holds no conversation under this id.');
      expect(logged.join('\n')).toContain(tag!);
      expect(logged.join('\n')).toContain('console_customer_unread');
    } finally {
      spy.mockRestore();
    }
  });

  it('says the ledger holds nothing about a customer when the run answered no conversation', async () => {
    const readConversation = vi.fn();
    const base = await startGuarded(deps({
      readRun: caseOf({ request: null, conversationId: null }),
      readConversation,
    }));
    const card = cardOf(await (await fetch(base + CASE)).text(), 'This customer');
    expect(card).toContain('This run answered no conversation, so the ledger holds nothing about its customer.');
    expect(readConversation).not.toHaveBeenCalled();
  });

  it('says so when the conversation the run names is no longer in the ledger', async () => {
    const base = await startGuarded(deps({ readConversation: async () => null }));
    const card = cardOf(await (await fetch(base + CASE)).text(), 'This customer');
    expect(card).toContain('The ledger holds no conversation under this id.');
  });

  // Colour alone cannot be read by everyone. Each sentence says in a word what
  // the judge made of it (DEC-43 for the courtesy word).
  it('tells accepted, refused, unjudged and courtesy sentences apart in words', async () => {
    const base = await startGuarded(deps({
      readRun: caseOf({
        evidence: {
          ...EVIDENCE,
          sentences: [
            { text: 'Thanks for writing in.', docId: null, claimIndex: null, supported: null },
            ...EVIDENCE.sentences,
          ],
        },
      }),
    }));
    const html = await (await fetch(base + CASE)).text();
    const reply = cardOf(html, 'The reply, as the system drafted it');
    const words = [...reply.matchAll(/<span class="vw [a-z]+">([a-z ]+)<\/span>/g)].map((m) => m[1]);
    expect(words).toEqual(['courtesy', 'accepted', 'refused', 'not judged']);
  });

  // Three states, never two. A document the run's digest still matches says
  // so, as plainly as one that moved.
  it('flags each cited document as unchanged, changed or not compared', async () => {
    const base = await startGuarded(deps({
      readRun: caseOf({
        evidence: {
          ...EVIDENCE,
          sentences: [
            { text: 'One.', docId: 'SYN-DOC-A', claimIndex: 0, supported: true },
            { text: 'Two.', docId: 'SYN-DOC-B', claimIndex: 1, supported: true },
            { text: 'Three.', docId: 'SYN-DOC-C', claimIndex: 2, supported: true },
          ],
          claims: [
            { index: 0, text: 'One.', docId: 'SYN-DOC-A', supported: true },
            { index: 1, text: 'Two.', docId: 'SYN-DOC-B', supported: true },
            { index: 2, text: 'Three.', docId: 'SYN-DOC-C', supported: true },
          ],
          documents: [
            { position: 1, docId: 'SYN-DOC-A', title: 'A', kind: 'document', owner: 'support', bodyUnchanged: true, titleAtRun: 'A' },
            { position: 2, docId: 'SYN-DOC-B', title: 'B', kind: 'document', owner: 'support', bodyUnchanged: false, titleAtRun: 'B' },
            { position: 3, docId: 'SYN-DOC-C', title: 'C', kind: 'document', owner: 'support', bodyUnchanged: null, titleAtRun: 'C' },
          ],
        },
      }),
    }));
    const html = await (await fetch(base + CASE)).text();
    const rowOf = (docId: string): string => {
      const start = html.indexOf(`id="src-${docId}"`);
      return html.slice(start, html.indexOf('</div>', start));
    };
    const flags = ['unchanged', 'changed since this run read it', 'not compared'];
    const flagsIn = (row: string): string[] => flags.filter((flag) => row.includes(`>${flag}<`));
    expect(flagsIn(rowOf('SYN-DOC-A'))).toEqual(['unchanged']);
    expect(flagsIn(rowOf('SYN-DOC-B'))).toEqual(['changed since this run read it']);
    expect(flagsIn(rowOf('SYN-DOC-C'))).toEqual(['not compared']);
  });

  // The action bar sits at the foot of the case and carries today's wording.
  it('approves from a bar at the foot of the case, with the warning worded as before', async () => {
    const base = await startGuarded(deps());
    const html = await (await fetch(base + CASE)).text();
    const bar = html.slice(
      html.indexOf('class="actionbar"'),
      html.indexOf('class="closebar"'),
    );
    expect(bar).toContain('Approve and send');
    expect(bar).toContain('a sent reply cannot be recalled');
    expect(bar).toContain(`name="runId" value="${RUN}"`);
    // One submit in the approval's own bar. The close beside it is a second
    // form with a submit of its own (DEC-48), and the slice above stops where
    // that one starts.
    expect(bar).not.toBe('');
    expect(bar.match(/type="submit"/g) ?? []).toHaveLength(1);
  });

  it('carries the at-most-once and cannot-be-undone warnings for a compensation', async () => {
    const base = await startGuarded(deps({
      readRun: caseOf({
        gateReason: 'irreversible', policyReason: 'irreversible', draftExternalId: null,
        payloadRecorded: true, actionClass: 'compensate', delivery: 'at_most_once',
        payload: { amountMicros: 4200 },
      }),
    }));
    const html = await (await fetch(base + CASE)).text();
    const bar = html.slice(html.indexOf('class="actionbar"'));
    expect(bar).toContain('Approve and perform');
    expect(bar).toContain('This action cannot be undone once it runs.');
    expect(bar).toContain('escalates rather than repeating');
    // The payload is read in the case, not squeezed into the bar.
    expect(bar).not.toContain('What approving this performs');
    expect(html).toContain('What approving this performs');
  });

  // A parked action has no draft to read back, so the bar makes no claim
  // about one, whatever the console reads back through.
  it('says nothing about reading a draft back on a parked action', async () => {
    const base = await startGuarded(deps({
      readRun: caseOf({
        gateReason: 'irreversible', policyReason: 'irreversible', draftExternalId: null,
        payloadRecorded: true, actionClass: 'compensate', delivery: 'at_most_once', payload: { amountMicros: 4200 },
      }),
    }), undefined, 'freescout');
    const html = await (await fetch(base + CASE)).text();
    expect(html).not.toContain('reads the helpdesk draft back');
    expect(html).not.toContain('reads no draft back');
  });

  // A rule arrives on the query string. It reaches the page only encoded.
  it('encodes a hostile rule on the back link and the approval form', async () => {
    const base = await startGuarded(deps());
    const hostile = '"><script>alert(1)</script>';
    const html = await (await fetch(`${base}${CASE}?rule=${encodeURIComponent(hostile)}`)).text();
    expect(html).not.toContain(hostile);
    expect(html.split('<script>')).toHaveLength(2);
    expect(html).toContain(`action="/approve?rule=${encodeURIComponent(hostile)}"`);
    expect(html).toContain(`href="/?rule=${encodeURIComponent(hostile)}"`);
  });

  // DEC-47: an approval from a narrowed queue returns to that queue. The
  // filters ride on the form's action, the POST reads them off the URL, and
  // the 303 rebuilds the case with both — so the reviewer's next click is
  // "← Needs a person" back to the list they were working.
  it('returns an approval to the queue the reviewer narrowed to', async () => {
    const base = await startGuarded(deps());
    const narrowed = await (await fetch(base + `${CASE}?rule=customer_visible&product=aurora`)).text();
    expect(narrowed).toContain('action="/approve?rule=customer_visible&amp;product=aurora"');

    // The digest the page drew, as a browser posts it: the approval refuses
    // a request without one.
    const shown = /name="shown" value="([0-9a-f]{64})"/.exec(narrowed)?.[1] ?? '';
    expect(shown).not.toBe('');
    const posted = await fetch(base + '/approve?rule=customer_visible&product=aurora', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        // The console's own form, as a browser sends it.
        'sec-fetch-site': 'same-origin',
      },
      body: new URLSearchParams({ runId: RUN, shown }).toString(),
      redirect: 'manual',
    });
    expect(posted.status).toBe(303);
    const location = posted.headers.get('location') ?? '';
    expect(location).toContain('rule=customer_visible');
    expect(location).toContain('product=aurora');

    // And the case it lands on carries both back to the queue.
    const landed = await (await fetch(base + location)).text();
    expect(landed).toContain('href="/?rule=customer_visible&amp;product=aurora"');
  });

  // A product arrives the same way (DEC-47) and reaches the page only
  // encoded. It rides on the same links the rule does, so the two cases fail
  // together or not at all.
  it('encodes a hostile product on the back link and the row links', async () => {
    const base = await startGuarded(deps());
    const hostile = '"><script>alert(1)</script>';
    const html = await (await fetch(`${base}${CASE}?product=${encodeURIComponent(hostile)}`)).text();
    expect(html).not.toContain(hostile);
    expect(html.split('<script>')).toHaveLength(2);
    expect(html).toContain(`href="/?product=${encodeURIComponent(hostile)}"`);
  });

  // The header states the case's age only while it waits. A resolved case
  // says when it opened instead, and names its ticket once.
  it('says a case waits only while it does', async () => {
    const waiting = await startGuarded(deps());
    const head = (html: string): string => html.slice(html.indexOf('class="casehd"'), html.indexOf('class="case"'));
    expect(head(await (await fetch(waiting + CASE)).text())).toMatch(/waiting \d+d/);
    const resolved = await startGuarded(deps({ readRun: caseOf({ state: 'resolved' }) }));
    const done = head(await (await fetch(resolved + CASE)).text());
    expect(done).not.toContain('waiting');
    expect(done).toContain('opened 2026-09-07 09:00Z');
    expect(done.match(/SYN-1/g) ?? []).toHaveLength(1);
  });

  // The approval's outcome travels on the query string, so a link can carry
  // any of them. An outcome the run's state contradicts is not the ledger's
  // answer, and gets the sentence an unknown outcome gets.
  it('shows an outcome only on a run whose state it fits', async () => {
    const at = async (state: string | null, outcome: string, approved = false): Promise<string> => {
      const base = await startGuarded(deps({
        readRun: state === null ? async () => null : caseOf({ state, approved }),
      }));
      return (await fetch(`${base}${CASE}?outcome=${outcome}`)).text();
    };
    const fits = (html: string, outcome: string): boolean => html.includes(`data-outcome="${outcome}"`);
    // An approval records an approver, and nothing else does. The relay can
    // escalate an approved run whose send it cannot confirm, and the
    // approval is still the ledger's answer.
    expect(fits(await at('resolved', 'approved', true), 'approved')).toBe(true);
    const escalated = await at('escalated', 'approved', true);
    expect(fits(escalated, 'approved')).toBe(true);
    // Worded for what the relay did since: an escalated run's send was not
    // confirmed, so the page does not promise the relay will perform it.
    expect(escalated).toContain('Approved. The relay escalated the run, so a person has it now.');
    expect(escalated).not.toContain('The relay performs it next.');
    // Any other state an approved run could be written into reads as the
    // approval itself, never as a raw state token.
    const other = await at('superseded', 'approved', true);
    expect(other).toContain('data-outcome="approved">Approved.</p>');
    expect(other).not.toContain('The relay performs it next.');
    expect(other).not.toContain('superseded</p>');
    for (const state of ['resolved', 'escalated', 'abandoned', 'awaiting_approval', null]) {
      const html = await at(state, 'approved', false);
      expect(fits(html, 'approved'), String(state)).toBe(false);
      expect(html, String(state)).toContain('The ledger answered with an outcome this console does not know.');
    }
    // A run the ledger holds is not unknown, and an unknown one is nothing else.
    expect(fits(await at(null, 'unknown_run'), 'unknown_run')).toBe(true);
    expect(fits(await at('awaiting_approval', 'unknown_run'), 'unknown_run')).toBe(false);
    expect(fits(await at(null, 'draft_missing'), 'draft_missing')).toBe(false);
    // A run that still waits is waiting for approval.
    expect(fits(await at('awaiting_approval', 'not_awaiting_approval'), 'not_awaiting_approval')).toBe(false);
    expect(fits(await at('resolved', 'not_awaiting_approval'), 'not_awaiting_approval')).toBe(true);
    // A refused read or a gone draft leaves the run waiting.
    for (const refusal of ['draft_missing', 'read_back_failed']) {
      expect(fits(await at('awaiting_approval', refusal), refusal), refusal).toBe(true);
      expect(fits(await at('resolved', refusal), refusal), refusal).toBe(false);
    }
  });

  // An approval performs a reply or an action. The sentence fits both.
  it('words an approval for a reply and for an action alike', async () => {
    const base = await startGuarded(deps({
      readRun: caseOf({ state: 'resolved', approved: true, draftExternalId: null, payloadRecorded: true }),
    }));
    const html = await (await fetch(`${base}${CASE}?outcome=approved`)).text();
    expect(html).toContain('Approved. The relay performs it next.');
    expect(html).not.toContain('The reply is queued');
  });

  // A case that no longer waits does not say what approving it would do.
  it('says what approving does while the case waits', async () => {
    const reply = await startGuarded(deps());
    expect(cardOf(await (await fetch(reply + CASE)).text(), 'Why this is yours'))
      .toContain('Approving sends the helpdesk draft to the customer.');
    const action = await startGuarded(deps({
      readRun: caseOf({ draftExternalId: null, payloadRecorded: true, actionClass: 'route_ticket' }),
    }));
    expect(cardOf(await (await fetch(action + CASE)).text(), 'Why this is yours'))
      .toContain('Approving performs route_ticket through the adapter.');
  });

  it('says nothing about what approving does on a case that no longer waits', async () => {
    const base = await startGuarded(deps({ readRun: caseOf({ state: 'resolved' }) }));
    const why = cardOf(await (await fetch(base + CASE)).text(), 'Why this is yours');
    expect(why).not.toContain('Approving sends');
    expect(why).toContain('customer_visible');
  });

  it('names a delivery rule it does not know', async () => {
    const base = await startGuarded(deps({ readRun: caseOf({ delivery: 'whenever' }) }));
    const why = cardOf(await (await fetch(base + CASE)).text(), 'Why this is yours');
    expect(why).toContain('The park recorded a delivery rule this console does not know.');
    expect(why).not.toContain('whenever');
  });

  // An approval of a run the ledger does not hold comes back to a case that
  // does not exist. The page still says what the ledger answered.
  it('says what the ledger answered on a case it cannot find', async () => {
    const base = await startGuarded(deps({ readRun: async () => null }));
    const res = await fetch(`${base}${CASE}?outcome=unknown_run`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('That run is not in the ledger.');
  });

  // The approval redirects here. A fault reading the run leaves the page
  // without a state to check the outcome against, so it shows no outcome and
  // says where the approval's answer is recorded.
  it('names the fault and where the approval was recorded when the run read fails', async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => { logged.push(String(line)); });
    try {
      const base = await startGuarded(deps({ readRun: async () => { throw new Error('the run read failed'); } }));
      const res = await fetch(`${base}${CASE}?outcome=approved`);
      const html = await res.text();
      expect(res.status).toBe(500);
      const tag = /The run was not read\. The console log names the fault ([0-9a-f]{8})\./.exec(html)?.[1];
      expect(tag).toBeDefined();
      // Named both ways: an approval that faulted wrote the other line.
      expect(html).toContain('console_approved');
      expect(html).toContain('console_approve_failed');
      expect(html).not.toContain('data-outcome');
      expect(html).not.toContain('Something failed while answering this page');
      const line = logged.find((entry) => entry.includes('console_case_unread'));
      expect(line).toContain(tag!);
      expect(line).toContain(RUN);
    } finally {
      spy.mockRestore();
    }
  });

  // A case is the reviewer's work, so the rail marks the queue it came from.
  it('marks Needs a person in the rail on a case', async () => {
    const base = await startGuarded(deps());
    const html = await (await fetch(base + CASE)).text();
    expect(html).toMatch(/<a href="\/" class="on"><span class="navlabel">Needs a person<\/span>/);
  });

  // A fault during an approval may come after the commit. The page does not
  // say the console was only reading.
  it('says an approval that faulted may have committed, and records which', async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => { logged.push(String(line)); });
    try {
      const base = await startGuarded(
        deps({ approve: async () => { throw new Error('connection terminated'); } }),
      );
      const res = await fetch(base + '/approve?rule=high_risk', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'sec-fetch-site': 'same-origin',
        },
        body: `runId=${RUN}&shown=${SHOWN}`,
        redirect: 'manual',
      });
      const html = await res.text();
      expect(res.status).toBe(500);
      expect(html).toContain('may or may not have committed');
      expect(html).toContain(`href="/case/${RUN}?rule=high_risk"`);
      expect(html).not.toContain('Something failed while answering this page');
      // The log line an incident reader needs: which run, which reviewer,
      // where the request came from, and the tag the page showed.
      const tag = /names it ([0-9a-f]{8})\./.exec(html)?.[1];
      const record = JSON.parse(logged.find((entry) => entry.includes('console_approve_failed')) ?? '{}') as Record<string, unknown>;
      expect(record['tag']).toBe(tag);
      expect(record['runId']).toBe(RUN);
      expect(record['reviewer']).toBe(REVIEWER);
      expect(record['from']).toBe('127.0.0.1');
      expect(record['host']).toBe(`127.0.0.1:${allowedPort}`);
      expect(String(record['error'])).toContain('connection terminated');
    } finally {
      spy.mockRestore();
    }
  });

  // A case that has left the queue still opens, and offers nothing to press.
  it('says a case is no longer waiting, and offers no approval', async () => {
    const base = await startGuarded(deps({ readRun: caseOf({ state: 'resolved' }) }));
    const html = await (await fetch(base + CASE)).text();
    expect(html).toContain('This run is resolved, so there is nothing here to approve.');
    expect(html).not.toContain('<form');
  });

  // Whether the approval measures a person's edit depends on the console's
  // configuration, and the case says which.
  it('says whether approving reads the draft back', async () => {
    const withReadBack = await startGuarded(deps(), undefined, 'freescout');
    expect(await (await fetch(withReadBack + CASE)).text())
      .toContain('Approving reads the helpdesk draft back through freescout first, and records how far a person edited it.');
    const without = await startGuarded(deps());
    expect(await (await fetch(without + CASE)).text())
      .toContain('This console reads no draft back, so an approval here records no edit distance.');
  });

  // A refusal never wears the success style.
  it('draws a refusal as a refusal, and only an approval as a success', async () => {
    const base = await startGuarded(deps());
    const at = async (outcome: string): Promise<string> =>
      (await fetch(`${base}${CASE}?outcome=${outcome}`)).text();
    const resolved = await startGuarded(deps({ readRun: caseOf({ state: 'resolved', approved: true }) }));
    const approved = await (await fetch(`${resolved}${CASE}?outcome=approved`)).text();
    expect(approved).toContain('<p class="outcome ok" data-outcome="approved">');
    for (const refusal of ['draft_missing', 'read_back_failed', 'stale_epoch', 'superseded']) {
      const html = await at(refusal);
      expect(html, refusal).toContain(`<p class="outcome refused" data-outcome="${refusal}">`);
      expect(html, refusal).not.toContain('outcome ok');
    }
    expect(await at('draft_missing')).toContain('The parked draft is gone, so nothing was sent.');
    // One word for both paths: on the draft path the copy read back is the
    // parked draft, and where the ledger holds the reply it is a copy nobody
    // can send. The sentence names the fault class, and the log names which.
    expect(await at('read_back_failed'))
      .toContain('The helpdesk copy could not be read back, so nothing was sent.');
    // DEC-44: a permanent read-back fault has its own sentence, because the
    // next step is not a retry.
    expect(await at('read_back_not_a_note'))
      .toContain('is not one this console can compare');
  });

  it('carries a failed read-back through the approval to the case', async () => {
    const base = await startGuarded(deps({ approve: async () => 'read_back_failed' }));
    const res = await fetch(base + '/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' },
      body: `runId=${RUN}&shown=${SHOWN}`,
      redirect: 'manual',
    });
    expect(res.headers.get('location')).toBe(`/case/${RUN}?outcome=read_back_failed`);
  });

  it('returns the theme toggle to the case it was pressed on, with its rule', async () => {
    const base = await startGuarded(deps());
    const res = await fetch(`${base}/theme?to=light&back=${encodeURIComponent(CASE)}`, { redirect: 'manual' });
    expect(res.headers.get('location')).toBe(CASE);
    const html = await (await fetch(`${base}${CASE}?rule=high_risk`)).text();
    const back = /href="\/theme\?to=light&amp;back=([^"]+)"/.exec(html)?.[1];
    expect(decodeURIComponent(back ?? '')).toBe(`${CASE}?rule=high_risk`);
    const kept = await fetch(`${base}/theme?to=light&back=${back}`, { redirect: 'manual' });
    expect(kept.headers.get('location')).toBe(`${CASE}?rule=high_risk`);
    const queue = await fetch(`${base}/theme?to=light&back=${encodeURIComponent('/?rule=high_risk')}`, { redirect: 'manual' });
    expect(queue.headers.get('location')).toBe('/?rule=high_risk');
    for (const bad of [`${CASE}?rule=%0d%0aX:1`, '/case/not-a-run?rule=a', '/?rule=a&next=//evil.example']) {
      const res2 = await fetch(`${base}/theme?to=light&back=${encodeURIComponent(bad)}`, { redirect: 'manual' });
      expect(res2.headers.get('location'), bad).toMatch(/^\/(case\/[0-9a-f-]{36})?(\?rule=[^\r\n]*)?$/);
      expect(res2.headers.get('location'), bad).not.toContain('evil');
    }
  });

  // The queue's theme link keeps the filter a person chose, and only one that
  // something waiting carries. An invented rule is never written back out.
  it('keeps the queue filter on its theme link only when something carries it', async () => {
    const base = await startGuarded(deps());
    const backOf = async (query: string): Promise<string> => {
      const html = await (await fetch(`${base}/${query}`)).text();
      return decodeURIComponent(/href="\/theme\?to=light&amp;back=([^"]+)"/.exec(html)?.[1] ?? '');
    };
    expect(await backOf('?rule=customer_visible')).toBe('/?rule=customer_visible');
    expect(await backOf('?rule=invented')).toBe('/');
    expect(await backOf('')).toBe('/');
  });

  // An old queue link carrying something that is not a run id is not rebuilt
  // into a case path. It reaches the queue with its query.
  it('sends an old queue link naming no run id to the queue', async () => {
    const base = await startGuarded(deps());
    const res = await fetch(`${base}/approvals?run=not-a-run&rule=high_risk`, { redirect: 'manual' });
    expect(res.headers.get('location')).toBe('/?run=not-a-run&rule=high_risk');
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
      ['Work', ['Needs a person']],
      ['Admin', ['Runs', 'Control bands', 'Partition latency', 'Design notes']],
    ]);
  });

  it('marks Design notes in the rail on its own page', async () => {
    const base = await startGuarded(deps());
    const rail = railOf(await (await fetch(base + '/notes')).text());
    expect(rail).toContain('<a href="/notes" class="on"><span class="navlabel">Design notes</span>');
    expect(rail.match(/class="on"/g)).toHaveLength(1);
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
    const rail = railOf(await (await fetch(base + '/')).text());
    expect(rail).toMatch(
      /<a href="\/" class="on"><span class="navlabel">Needs a person<\/span><span class="badge">\d+<\/span><\/a>/,
    );
  });

  describe('the reviewer it names', () => {
    /** The rail's foot, for a request the gate resolved to this reviewer. */
    async function footFor(reviewer: string): Promise<string> {
      const base = await startGuarded(deps({ reviewerFor: async () => ({ reviewer }) }));
      const html = await (await fetch(base + '/bands')).text();
      const rail = railOf(html);
      const foot = rail.indexOf('<div class="railfoot">');
      expect(foot, 'the rail has a foot').toBeGreaterThanOrEqual(0);
      return rail.slice(foot);
    }

    it('names the reviewer this request resolved to, with their initials', async () => {
      const foot = await footFor('Ida Lindqvist');
      expect(foot).toContain('>Ida Lindqvist<');
      expect(foot).toContain('>IL<');
    });

    // The name on the rail is one the roster holds and is active, because
    // that is the only kind the gate lets through (DEC-45). Where the name
    // came from is the ledger's record, not the rail's.
    it('says what every name here has in common: the roster holds it', async () => {
      expect(await footFor('Ida Lindqvist')).toContain('on the reviewer roster');
    });

    // The name is rendered, so it is escaped like every other value a surface
    // did not write itself.
    it('escapes the name it was handed', async () => {
      const foot = await footFor('<b>ida</b>');
      expect(foot).toContain('&lt;b&gt;ida&lt;/b&gt;');
      expect(foot).not.toContain('<b>ida</b>');
    });

    it('takes initials from the first two words of the name', async () => {
      const one = await footFor('ops-oncall');
      expect(one).toContain('>O<');
      const accented = await footFor('Åsa Berg Nyström');
      expect(accented).toContain('>ÅB<');
      expect(accented).toContain('>Åsa Berg Nyström<');
    });
  });
});

// DEC-44: the reply is edited where it will be sent. The console draws an
// editor only where the adapter cannot send the copy it parks, and every
// control it draws writes the reply the ledger holds.
describe('DEC-44: the console edits the reply the ledger holds', () => {
  /** A console whose adapter cannot send the copy it parks. */
  async function capable(over: Partial<ConsoleDeps> = {}): Promise<string> {
    return startGuarded(deps(over), undefined, undefined, true);
  }

  /** The digest of the reply this harness's page draws (DEC-46). */
  const DRAWN = createHash('sha256').update(EVIDENCE.draftBody).digest('hex');

  async function postEdit(
    base: string,
    fields: Record<string, string>,
  ): Promise<Response> {
    return fetch(`${base}/edit`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        // Same-origin, as a form this console served is.
        'sec-fetch-site': 'same-origin',
        origin: base,
      },
      body: new URLSearchParams(fields).toString(),
      redirect: 'manual',
    });
  }

  it('draws the editor, the sentence preview and the callout', async () => {
    const base = await capable();
    const html = await (await fetch(base + CASE)).text();

    // The card, titled as the design handoff titles it, holding the reply
    // the ledger would send.
    expect(html).toContain('Your reply · editable here, sent from here');
    expect(html).toContain('the ledger holds this reply');
    expect(html).toContain('<textarea name="text"');
    expect(html).toContain(EVIDENCE.draftBody);

    // Criterion 2: every sentence the system drafted stays visible beside the
    // editor, each with the judge's verdict on it.
    for (const verdict of ['accepted', 'refused', 'unread']) {
      expect(html).toContain(verdict);
    }
    expect(html).toContain('The sentences the system drafted');

    // Criterion 3: the callout's own words, for the one claim that was
    // refused, and no callout for the claim nobody judged.
    expect(html).toContain('Replace with what the document says');
    expect(html).toContain('Delete the sentence');
    expect(html).toContain('Write the missing answer →');
    expect(html).toContain('Sentence 2 cites SYN-DOC-01');
  });

  it('says what this approval sends, and where the copy stands', async () => {
    // The read-back is named, because this case is about the words the two
    // facts produce together: the ledger holding the reply, and the console
    // reading the copy back.
    const base = await startGuarded(deps(), undefined, 'freescout', true);
    const html = await (await fetch(base + CASE)).text();

    // The words above the button, for the adapter whose ledger holds the
    // reply: no instruction to edit a copy somewhere else.
    expect(html).toContain('This sends the reply above, exactly as the ledger holds it');
    expect(html).toContain('a person who edited it since is asked which text to send');
    expect(html).not.toContain('edit it there');
    expect(html).toContain('compares it with the reply the ledger holds');
  });

  it('opens the field for an answer on the sentence the link names', async () => {
    const base = await capable();
    const closed = await (await fetch(base + CASE)).text();
    // The third way out is a link on a case with no filter, and the separator
    // is the one the URL needs: `&write=` after no query is a path with an
    // ampersand in it, and reaches no route at all.
    const href = /<a class="btn" href="([^"]*write=[^"]*)"/.exec(closed)?.[1];
    expect(href).toBeDefined();
    const sentence = 'Your bank decides when it lands.';
    expect(href).toBe(`${CASE}?write=${encodeURIComponent(sentence)}`);

    const opened = await (await fetch(base + href!)).text();
    expect(opened).toContain('The answer, in your words');
    expect(opened).toContain('<input type="text" id="answer" name="answer"');
    // The other two ways out are still there, and the field replaces neither.
    expect(opened).toContain('Replace with what the document says');
    expect(opened).toContain('Delete the sentence');
  });

  it('keeps the filters on the link it opens the field with', async () => {
    const base = await capable();
    const closed = await (await fetch(`${base}${CASE}?rule=customer_visible&product=Aurora`)).text();
    const href = /<a class="btn" href="([^"]*write=[^"]*)"/.exec(closed)?.[1];

    expect(href).toContain('/case/');
    expect(href).toContain('rule=customer_visible');
    expect(href).toContain('product=Aurora');
    // Escaped in the attribute and decoded by the browser, so the separator
    // reads `&amp;` here and `&` in the request.
    expect(href).toContain('&amp;write=');
  });

  // A ledger-only park carries a body and a payload, and its record routes to
  // `performAction`: nothing a reviewer typed there would send. The card says
  // so rather than offering an editor whose text goes nowhere.
  it('offers no editor on a park that carries no reply', async () => {
    const base = await capable({
      readRun: caseOf({ draftExternalId: null, payloadRecorded: true }) as never,
    });
    const html = await (await fetch(base + CASE)).text();

    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('Your reply · editable here, sent from here');
    // And no sentence about editing a parked copy elsewhere: there is none.
    expect(html).not.toContain('edited in the helpdesk, not here');
  });

  // The page and the approval must read one text. Where the adapter keeps the
  // draft path, that text is the parked body even when a turn holds a saved
  // reply — a page carrying the saved reply's digest would have every
  // approval refused, and the console's own edit route is closed there.
  it('digests the text the approval compares, not a reply it ignores', async () => {
    const parkedOnly = createHash('sha256').update(EVIDENCE.draftBody).digest('hex');
    const draftPath = await startGuarded(deps({
      readRun: caseOf({ request: { ...REQUEST, savedReplyText: 'A saved reply nobody sends.' } }) as never,
    }));
    const html = await (await fetch(draftPath + CASE)).text();

    expect(html).toContain(`name="shown" value="${parkedOnly}"`);
    expect(html).not.toContain('<textarea');
  });

  it('says the reply is edited in the helpdesk when its adapter sends the parked copy', async () => {
    const base = await startGuarded(deps());
    const html = await (await fetch(base + CASE)).text();

    expect(html).toContain('edited in the helpdesk, not here');
    expect(html).toContain('the console cannot write into it');
    expect(html).not.toContain('<textarea');
  });

  // Criterion 1's reload half: the text a reviewer saved is the text the page
  // draws, in the editor and in the form the approval carries.
  it('draws the reply a reviewer saved, and digests that one', async () => {
    const saved = 'A reply a reviewer saved a moment ago.';
    const base = await capable({
      readRun: caseOf({ request: { ...REQUEST, savedReplyText: saved } }) as never,
    });
    const html = await (await fetch(base + CASE)).text();

    expect(html).toContain(`<textarea name="text" rows="12" spellcheck="false">${saved}</textarea>`);
    expect(html).toContain(
      `name="shown" value="${createHash('sha256').update(saved).digest('hex')}"`,
    );
  });

  it('saves what a reviewer typed, and returns to the case', async () => {
    const saveReply = vi.fn().mockResolvedValue('saved');
    const base = await capable({ saveReply });

    const res = await postEdit(base, {
      runId: RUN, shown: DRAWN, edit: 'text', text: 'A reply a person wrote.',
    });

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${CASE}?edit=saved`);
    expect(saveReply).toHaveBeenCalledWith(RUN, 'A reply a person wrote.', DRAWN);
  });

  /**
   * One form as the page renders it: its action, and the fields it carries.
   *
   * The whole point of this helper is that the test clicks what the page
   * drew. Posting fields by hand let the replace button ship broken: the
   * route wanted a `docId` no form ever carried, and every hand-written test
   * supplied it.
   */
  function formFor(html: string, label: string): { action: string; fields: Record<string, string> } {
    const form = new RegExp(
      `<form method="post" action="([^"]*)">((?:<input[^>]*>)*)<button[^>]*>${label}</button>`,
    ).exec(html);
    expect(form, `no form renders ${label}`).not.toBeNull();
    const fields: Record<string, string> = {};
    for (const input of form![2]!.matchAll(/name="([^"]*)" value="([^"]*)"/g)) {
      fields[input[1]!] = decodeHtml(input[2]!);
    }
    return { action: decodeHtml(form![1]!), fields };
  }

  /** The entities `escapeHtml` writes, read back as a browser would. */
  function decodeHtml(value: string): string {
    return value
      .replaceAll('&amp;', '&')
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&#39;', "'")
      .replaceAll('&quot;', '"');
  }

  it('acts on every callout control the page renders, as it renders it', async () => {
    for (const [label, expected] of [
      ['Replace with what the document says',
        'We refunded the duplicate charge. Your bank posts it in five days.'],
      ['Delete the sentence', 'We refunded the duplicate charge.'],
    ] as const) {
      const saveReply = vi.fn().mockResolvedValue('saved');
      const base = await capable({
        saveReply,
        readDocumentBody: async () =>
          'A charge is refundable inside fourteen days. Your bank posts it in five days.',
      });
      const page = await (await fetch(base + CASE)).text();
      const form = formFor(page, label);

      const res = await postEdit(base, form.fields);

      expect(res.status, label).toBe(303);
      expect(res.headers.get('location'), label).toBe(`${CASE}?edit=saved`);
      expect(saveReply, label).toHaveBeenCalledWith(RUN, expected, DRAWN);
    }
  });

  it('removes the sentence a reviewer dropped, and saves the rest', async () => {
    const saveReply = vi.fn().mockResolvedValue('saved');
    const base = await capable({ saveReply });

    await postEdit(base, {
      runId: RUN, shown: DRAWN, edit: 'delete', sentence: 'Your bank decides when it lands.',
    });

    expect(saveReply).toHaveBeenCalledWith(RUN, 'We refunded the duplicate charge.', DRAWN);
  });

  it('puts what the cited document says in place of a refused sentence', async () => {
    const saveReply = vi.fn().mockResolvedValue('saved');
    const base = await capable({
      saveReply,
      readDocumentBody: async () =>
        'A charge is refundable inside fourteen days. Your bank posts it in five days.',
    });

    await postEdit(base, {
      runId: RUN, shown: DRAWN, edit: 'replace',
      sentence: 'Your bank decides when it lands.',
    });

    // The document's own sentence, chosen by the words the two share, and
    // nothing else: no model runs in this console.
    expect(saveReply).toHaveBeenCalledWith(
      RUN,
      'We refunded the duplicate charge. Your bank posts it in five days.',
      DRAWN,
    );
  });

  it('refuses to replace a sentence when the document shares no word with it', async () => {
    const saveReply = vi.fn().mockResolvedValue('saved');
    const base = await capable({ saveReply, readDocumentBody: async () => 'Nothing here at all.' });

    const res = await postEdit(base, {
      runId: RUN, shown: DRAWN, edit: 'replace',
      sentence: 'Your bank decides when it lands.', docId: 'SYN-DOC-01',
    });

    // A refusal with its own reason, and nothing saved: the reviewer is told
    // which way out is left rather than left with a sentence that vanished.
    expect(res.headers.get('location')).toBe(`${CASE}?edit=not_an_edit&why=no_wording`);
    expect(saveReply).not.toHaveBeenCalled();
  });

  // Every code a refused callout redirects with has a sentence the page
  // looks up. A code the page does not know would answer "That is not an
  // answer this console knows" to a reviewer whose document simply shared no
  // word — and the redirect drops what they had typed.
  it('words the reason a callout edit did not apply', async () => {
    const saveReply = vi.fn().mockResolvedValue('saved');
    const cases: readonly (readonly [Record<string, string>, string])[] = [
      [
        { edit: 'replace', sentence: 'A sentence no claim of this run makes.' },
        'The reply no longer holds that sentence',
      ],
      [
        { edit: 'write', sentence: 'Your bank decides when it lands.', answer: '   ' },
        'The answer was empty',
      ],
      [
        { edit: 'delete', sentence: 'A sentence nobody wrote.' },
        'The reply no longer holds that sentence',
      ],
    ];
    for (const [fields, expected] of cases) {
      const base = await capable({
        saveReply,
        readDocumentBody: async () => null,
      });
      const res = await postEdit(base, { runId: RUN, shown: DRAWN, ...fields });
      const location = res.headers.get('location')!;
      const page = await (await fetch(new URL(location, base))).text();

      expect(page, JSON.stringify(fields)).toContain(expected);
      expect(page).not.toContain('not an answer this console knows');
      expect(saveReply).not.toHaveBeenCalled();
      saveReply.mockClear();
    }
  });

  it('words the document that shares no word with the sentence', async () => {
    const saveReply = vi.fn().mockResolvedValue('saved');
    const base = await capable({ saveReply, readDocumentBody: async () => 'Nothing here at all.' });

    const res = await postEdit(base, {
      runId: RUN, shown: DRAWN, edit: 'replace',
      sentence: 'Your bank decides when it lands.',
    });
    const page = await (await fetch(new URL(res.headers.get('location')!, base))).text();

    expect(page).toContain('shares no word with it');
    expect(saveReply).not.toHaveBeenCalled();
  });

  it('writes the answer a reviewer typed in place of the refused sentence', async () => {
    const saveReply = vi.fn().mockResolvedValue('saved');
    const base = await capable({ saveReply });

    await postEdit(base, {
      runId: RUN, shown: DRAWN, edit: 'write',
      sentence: 'Your bank decides when it lands.',
      answer: 'Your bank posts refunds in five business days.',
    });

    expect(saveReply).toHaveBeenCalledWith(
      RUN,
      'We refunded the duplicate charge. Your bank posts refunds in five business days.',
      DRAWN,
    );
  });

  it('refuses an edit of a sentence the reply no longer holds', async () => {
    const saveReply = vi.fn().mockResolvedValue('saved');
    const base = await capable({ saveReply });

    const res = await postEdit(base, {
      runId: RUN, shown: DRAWN, edit: 'delete', sentence: 'A sentence nobody wrote.',
    });

    expect(res.headers.get('location')).toBe(`${CASE}?edit=not_an_edit&why=no_sentence`);
    expect(saveReply).not.toHaveBeenCalled();
  });

  it('refuses a save with no digest of the page that posted it', async () => {
    const saveReply = vi.fn().mockResolvedValue('saved');
    const base = await capable({ saveReply });

    const res = await postEdit(base, { runId: RUN, edit: 'text', text: 'a reply' });

    expect(res.status).toBe(400);
    expect(saveReply).not.toHaveBeenCalled();
  });

  // The card draws no editor for a park that carries no reply. A card is not
  // what refuses a request, and text saved here is text no path sends.
  it('refuses an edit on a run whose park carries no reply', async () => {
    const saveReply = vi.fn().mockResolvedValue('saved');
    const base = await capable({
      saveReply,
      readRun: caseOf({ draftExternalId: null, payloadRecorded: true }) as never,
    });

    const res = await postEdit(base, {
      runId: RUN, shown: DRAWN, edit: 'text', text: 'A reply a person wrote.',
    });

    expect(res.status).toBe(400);
    expect(saveReply).not.toHaveBeenCalled();
  });

  it('refuses an edit on a console whose adapter sends its own parked copy', async () => {
    const saveReply = vi.fn().mockResolvedValue('saved');
    const base = await startGuarded(deps({ saveReply }));

    const res = await postEdit(base, {
      runId: RUN, shown: DRAWN, edit: 'text', text: 'A reply a person wrote.',
    });

    expect(res.status).toBe(400);
    expect(saveReply).not.toHaveBeenCalled();
  });

  it('draws both texts for a refusal about the copy, and the choice between them', async () => {
    const base = await capable({ readCopy: async () => 'Your bank posts it in five minutes.' });
    const html = await (await fetch(`${base}${CASE}?outcome=copy_changed`)).text();

    expect(html).toContain('The reply the ledger holds');
    expect(html).toContain(EVIDENCE.draftBody);
    expect(html).toContain('The copy the helpdesk holds');
    expect(html).toContain('Your bank posts it in five minutes.');
    // Choosing the copy is a save, so the choice travels as one.
    expect(html).toContain('Send the helpdesk copy');
    expect(html).toContain('name="edit" value="text"');
  });

  // The refusal's sentence promises two texts. A copy a person deleted since
  // leaves one of them missing, and the page says which rather than drawing
  // the promise with nothing under it.
  it('says the copy is gone when the helpdesk holds none', async () => {
    const base = await capable({ readCopy: async () => null });
    const html = await (await fetch(`${base}${CASE}?outcome=copy_changed`)).text();

    expect(html).toContain('The helpdesk holds no copy of this reply now');
    expect(html).not.toContain('The copy the helpdesk holds');
  });

  // An outcome the run contradicts is a sentence somebody wrote, and the
  // query string is a place anyone can put one. Both DEC-44 refusals commit
  // nothing, so they are true of a waiting run and of no other.
  // A case that has left the queue sends what the approval recorded (DEC-37).
  // Drawing the turn's saved reply there would show text the customer never
  // received, and offering an editor over it would invite a write nothing
  // sends.
  it('draws what the approval sent, and offers no editor, once the case is done', async () => {
    const base = await capable({
      readRun: caseOf({
        state: 'resolved',
        approved: true,
        request: {
          ...REQUEST,
          savedReplyText: 'What a reviewer was working on.',
          approvedReplyText: 'What the approval sent.',
        },
      }) as never,
    });
    const html = await (await fetch(base + CASE)).text();

    expect(html).toContain('The reply the approval sent');
    expect(html).toContain('What the approval sent.');
    expect(html).not.toContain('What a reviewer was working on.');
    expect(html).not.toContain('<textarea');
  });

  // DEC-14's refusal is a dead end on a capable adapter, and its sentence has
  // to say which way out exists: the whole stack reads the flag, so the whole
  // stack rolls back together.
  it('names the way out of a reply the ledger cannot disclose', async () => {
    const base = await capable();
    const html = await (await fetch(`${base}${CASE}?outcome=no_disclosure`)).text();

    expect(html).toContain('carries no disclosure');
    expect(html).toContain('Set FREESCOUT_INTERNAL_NOTE=false for the console, the relay and the consumer');
  });

  it('refuses to draw a refusal the run contradicts', async () => {
    const base = await capable({ readCopy: async () => 'The copy as a person left it.' });
    const resolved = await startGuarded(deps({
      readRun: caseOf({ state: 'resolved', approved: true }) as never,
    }), undefined, undefined, true);
    for (const outcome of ['copy_changed', 'no_disclosure']) {
      const waiting = await (await fetch(`${base}${CASE}?outcome=${outcome}`)).text();
      expect(waiting, outcome).toContain('data-outcome');

      const sent = await (await fetch(`${resolved}${CASE}?outcome=${outcome}`)).text();
      expect(sent, outcome).not.toContain('data-outcome');
      expect(sent, outcome).toContain('this console does not know');
    }
  });

  /** The digest the page carries for one text (DEC-46). */
  function digestOf(text: string): string {
    return createHash('sha256').update(text).digest('hex');
  }

  // The reviewer's own text is sendable. The copy is in a helpdesk this
  // system cannot write into, so nothing a reviewer does here would make the
  // two texts agree: without a control of its own, the refusal's second
  // branch would be a dead end and every press above it would refuse again.
  it('offers the second half of the choice, carrying the digest of the copy it drew', async () => {
    const copy = 'Your bank posts it in five minutes.';
    const base = await capable({ readCopy: async () => copy });
    const html = await (await fetch(`${base}${CASE}?outcome=copy_changed`)).text();

    expect(html).toContain('Send the reply above');
    // The route the form posts to, read off the page: a control that posts
    // nowhere is the defect the replace button shipped with.
    expect(html).toContain(`<form method="post" action="/approve">`);
    // The digest the form carries is of the text drawn above it, which is
    // what makes the acknowledgement a decision about text somebody read.
    expect(html).toContain(`name="ack" value="${digestOf(copy)}"`);
  });

  // Posted as the page renders it, never as the test believes it should be:
  // a control nothing can use passed 339 cases in this suite while the
  // replace button wanted a field no form drew.
  it('approves with the acknowledgement the rendered form carries', async () => {
    const copy = 'Your bank posts it in five minutes.';
    const approve = vi.fn().mockResolvedValue('approved');
    const base = await capable({ readCopy: async () => copy, approve });
    const html = await (await fetch(`${base}${CASE}?outcome=copy_changed`)).text();

    // The form whose button sends the ledger's reply, found by that button,
    // and the action the page names. A form that posts to the wrong route
    // fails here rather than passing on a URL this test chose.
    const rendered = [...html.matchAll(/<form method="post" action="([^"]*)">(.*?)<\/form>/gs)]
      .find(([, , body]) => body!.includes('Send the reply above'));
    expect(rendered).toBeDefined();
    const fields: Record<string, string> = {};
    for (const [, name, value] of rendered![2]!.matchAll(/name="([^"]+)" value="([^"]*)"/g)) {
      fields[name!] = value!;
    }

    const res = await fetch(`${base}${rendered![1]}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'same-origin',
        origin: base,
      },
      body: new URLSearchParams(fields).toString(),
      redirect: 'manual',
    });

    expect(res.status).toBe(303);
    expect(approve).toHaveBeenCalledWith(RUN, REVIEWER, fields['shown'], fields['ack']);
    expect(fields['ack']).toBe(digestOf(copy));
  });

  it('refuses an acknowledgement that is not a digest', async () => {
    const approve = vi.fn().mockResolvedValue('approved');
    const base = await capable({ approve });

    const res = await fetch(`${base}/approve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'same-origin',
        origin: base,
      },
      body: new URLSearchParams({ runId: RUN, shown: DRAWN, ack: 'yes' }).toString(),
      redirect: 'manual',
    });

    expect(res.status).toBe(400);
    expect(approve).not.toHaveBeenCalled();
  });

  // A copy a person cleared holds no text, and the console's only control for
  // a copy saves it as the reply — which `saveReply` refuses for an empty
  // reply. So the page says there is nothing to choose rather than drawing a
  // button that cannot work.
  it('says a cleared copy leaves nothing to choose between', async () => {
    const base = await capable({ readCopy: async () => '   ' });
    const html = await (await fetch(`${base}${CASE}?outcome=copy_changed`)).text();

    expect(html).toContain('holds no text now, so there is nothing to choose between');
    expect(html).not.toContain('Send the helpdesk copy');
    expect(html).not.toContain('name="ack"');
  });

  // The refusal's sentence is drawn with the copy block, and the promise it
  // makes is about what is under it. A run with no parked handle reads no
  // copy at all, so the page must not promise two texts.
  it('does not promise two texts on a refusal it cannot show one of', async () => {
    const base = await capable({
      readRun: caseOf({ draftExternalId: null, payloadRecorded: true }) as never,
      readCopy: async () => null,
    });
    const html = await (await fetch(`${base}${CASE}?outcome=copy_changed`)).text();

    expect(html).toContain('The copy in the helpdesk was edited after this reply was parked');
    expect(html).not.toContain('Both texts are below');
  });

  // A run the gate escalated sent nothing, and a second run on the turn can
  // write a reply after a send. Neither is "the reply the approval sent", and
  // the card that says so draws the approval's own record (DEC-37).
  it('claims no send for a run that sent nothing', async () => {
    const base = await capable({
      readRun: caseOf({
        state: 'escalated',
        approved: false,
        request: { ...REQUEST, savedReplyText: 'What a reviewer was working on.' },
      }) as never,
    });
    const html = await (await fetch(base + CASE)).text();

    expect(html).not.toContain('The reply the approval sent');
    expect(html).not.toContain('What a reviewer was working on.');
    expect(html).toContain('The reply, as the system drafted it');
    // And the parked thread is named as what it is here: a copy nobody can
    // send from this console, not the draft a relay publishes.
    expect(html).toContain('helpdesk copy D-1');
  });

  // `saveReply` refuses a run with no turn, so an editor over one would take
  // a reviewer's text and keep none of it.
  it('offers no editor on a run whose park names no turn', async () => {
    const base = await capable({ readRun: caseOf({ request: null }) as never });
    const html = await (await fetch(base + CASE)).text();

    expect(html).not.toContain('<textarea');
    // The reply is still drawn, as the sentences a judge ruled on rather than
    // as an editor: nothing here writes it.
    expect(html).toContain('We refunded the duplicate charge.');
  });

  // The words the context column draws come off the act, which read the
  // adapter's declaration. Worded separately, the card said the helpdesk
  // draft sends on the adapter where the ledger holds the reply and the
  // parked copy is a note nobody can send.
  it('says in the context column what the action bar says', async () => {
    const capableHtml = await (await fetch((await capable()) + CASE)).text();
    expect(capableHtml).toContain('Approving sends the reply the ledger holds.');

    const draftPath = await (await fetch((await startGuarded(deps())) + CASE)).text();
    expect(draftPath).toContain('Approving sends the helpdesk draft to the customer.');
  });

  // A read that failed is not a write that may have committed. The 500 used
  // to say the save might have landed about a fault that never reached one.
  it('says nothing was saved when the failure was a read', async () => {
    const base = await capable({
      readRun: async () => { throw new Error('the ledger did not answer'); },
    });

    const res = await postEdit(base, {
      runId: RUN, shown: DRAWN, edit: 'text', text: 'A reply a person wrote.',
    });

    expect(res.status).toBe(500);
    expect(await res.text()).toContain('nothing was saved');
  });

  // The save's sentence claims the approval sends the text just saved, which
  // is false on an adapter whose helpdesk copy sends. A save cannot happen
  // there today, and a flag flipped after one would leave a link saying so.
  it('refuses a claim about a save on an adapter whose copy sends', async () => {
    const base = await startGuarded(deps({
      readRun: caseOf({
        request: { ...REQUEST, savedReplyText: 'A reply that was saved.' },
      }) as never,
    }));

    const html = await (await fetch(`${base}${CASE}?edit=saved`)).text();

    expect(html).not.toContain('Saved. The approval sends this text.');
    expect(html).toContain('That is not an answer this console knows.');
  });

  // Four refusals this route made and no case reached: an oversized form, a
  // run id of the wrong shape, an edit word this console does not know, and
  // the two reasons the callout's first button can find no wording to quote.
  // Each is a request this console declines rather than a fault, and the
  // answer each gives is its own.
  it('refuses an edit form larger than the console accepts', async () => {
    const saveReply = vi.fn().mockResolvedValue('saved');
    const base = await capable({ saveReply });

    const res = await fetch(`${base}/edit`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'same-origin',
        origin: base,
      },
      body: `runId=${RUN}&shown=${DRAWN}&edit=text&text=${'x'.repeat(70 * 1024)}`,
    });

    expect(res.status).toBe(413);
    expect(await res.text()).toContain('The edit is larger than this console accepts.');
    expect(saveReply).not.toHaveBeenCalled();
  });

  it('refuses an edit whose run id is not a run id', async () => {
    const saveReply = vi.fn();
    const base = await capable({ saveReply });

    const res = await postEdit(base, { runId: 'not-a-run', shown: DRAWN, edit: 'text', text: 'x' });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain('That is not a run id, so nothing was saved.');
    expect(saveReply).not.toHaveBeenCalled();
  });

  it('refuses an edit this console does not know', async () => {
    const saveReply = vi.fn();
    const base = await capable({ saveReply });

    const res = await postEdit(base, {
      runId: RUN, shown: DRAWN, edit: 'summarise', sentence: 'Your bank decides when it lands.',
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain('That is not an edit this console knows.');
    expect(saveReply).not.toHaveBeenCalled();
  });

  // Two facts leave the first button with no wording to offer: the document
  // the sentence cites is not in the index, or it is too large to quote from.
  // The answer travels as a code, and the page words it.
  it('says which reason left a document unquoted', async () => {
    const sentence = 'Your bank decides when it lands.';

    const missing = await capable({ readDocumentBody: async () => null });
    expect((await postEdit(missing, {
      runId: RUN, shown: DRAWN, edit: 'replace', sentence,
    })).headers.get('location')).toBe(`${CASE}?edit=not_an_edit&why=no_document`);

    const huge = await capable({ readDocumentBody: async () => 'x'.repeat(200_001) });
    expect((await postEdit(huge, {
      runId: RUN, shown: DRAWN, edit: 'replace', sentence,
    })).headers.get('location')).toBe(`${CASE}?edit=not_an_edit&why=document_too_large`);

    const page = await (await fetch(`${huge}${CASE}?edit=not_an_edit&why=document_too_large`))
      .text();
    expect(page).toContain('too large for this console to quote');
  });

  it('says so when the copy a refusal names cannot be read', async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
    try {
      const base = await capable({
        readCopy: async () => { throw new Error('the helpdesk did not answer'); },
      });
      const html = await (await fetch(`${base}${CASE}?outcome=copy_changed`)).text();

      // The page names the failure and the tag of the line that holds the
      // fault, exactly as a failed read-back does.
      expect(html).toContain('The copy in the helpdesk could not be read');
      const tag = /names the fault ([0-9a-f]{8})/.exec(html)?.[1];
      expect(tag).toBeDefined();
      expect(logged.some((line) => line.includes('console_copy_unread') && line.includes(tag!)))
        .toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('DEC-51: the batch confirm and its undo', () => {
  const CLEAN_A = '22222222-2222-4222-8222-222222222222';
  const CLEAN_B = '44444444-4444-4444-8444-444444444444';
  const FIRST_REPLY = 'We refunded the duplicate charge.';
  const SECOND_REPLY = 'Your subscription is unchanged, and the bank posts within five minutes.';

  const cleanRun = (runId: string, ticketId: string, reply: string, approved = false) => ({
    runId, ticketId, state: 'awaiting_approval', promptVer: 'p1', ...ROW,
    riskTier: 'medium', reason: null, stepsUsed: 4, draftExternalId: 'D-1',
    coverage: null, agreement: 0.91, agreementThreshold: 0.8,
    gateCoverage: 0.86, coverageReviewThreshold: 0.8, approved,
    evidence: { ...EVIDENCE, draftBody: reply },
    request: { ...REQUEST, savedReplyText: reply },
  });

  /** Both cases, and a reader that answers each by id. */
  function batchDeps(over: Partial<ConsoleDeps> = {}): Partial<ConsoleDeps> {
    const runs: Record<string, unknown> = {
      [CLEAN_A]: cleanRun(CLEAN_A, 'SYN-A', FIRST_REPLY),
      [CLEAN_B]: cleanRun(CLEAN_B, 'SYN-B', SECOND_REPLY),
    };
    return {
      readRun: (async (runId: string) => runs[runId] ?? null) as ConsoleDeps['readRun'],
      ...over,
    };
  }

  function digestOf(text: string): string {
    return createHash('sha256').update(text).digest('hex');
  }

  async function post(base: string, path: string, fields: Record<string, string | string[]>): Promise<Response> {
    const body = new URLSearchParams();
    for (const [name, value] of Object.entries(fields)) {
      for (const one of Array.isArray(value) ? value : [value]) body.append(name, one);
    }
    return fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'same-origin',
        origin: base,
      },
      body: body.toString(),
      redirect: 'manual',
    });
  }

  it('draws each reply in full before anything sends, with its own digest', async () => {
    // A capable console: the ledger holds the reply, so a send is held and
    // the screen promises the window the undo needs.
    const base = await startGuarded(deps(batchDeps()), undefined, undefined, true);

    const page = await post(base, '/confirm', { runId: [CLEAN_A, CLEAN_B] });
    expect(page.status).toBe(200);
    const html = await page.text();

    // Criterion 1: the confirm shows each reply in full.
    expect(html).toContain(FIRST_REPLY);
    expect(html).toContain(SECOND_REPLY);
    // And each case carries the digest of the text drawn above it (DEC-46),
    // which is what makes a changed case refuse rather than send.
    expect(html).toContain(`name="shown" value="${digestOf(FIRST_REPLY)}"`);
    expect(html).toContain(`name="shown" value="${digestOf(SECOND_REPLY)}"`);
    expect(html).toContain('Confirm 2 · send each reply');
    // The button is inside the form it submits. Emitted outside, it has no
    // form owner and the whole screen is inert — the defect the queue's own
    // case found, which the second screen could have shipped again.
    expect(buttonInForm(html, '/confirm/apply')).toBe(true);
    // Nothing was approved by drawing the page.
    expect(html).toContain('12 seconds');
  });

  // DEC-51 and DEC-40: a reply on the draft path is never held, so that
  // console must not promise a window or an undo it cannot offer.
  it('promises no window on a console whose parked copy is what sends', async () => {
    const base = await startGuarded(deps(batchDeps()));

    const page = await (await post(base, '/confirm', { runId: [CLEAN_A] })).text();

    expect(page).toContain('nothing is held here, so there is no undo');
    expect(page).not.toContain('holds each one for');
  });

  it('approves each case with its digest and the hold, and offers the undo', async () => {
    const approve = vi.fn().mockResolvedValue('approved');
    const base = await startGuarded(deps(batchDeps({ approve })), undefined, undefined, true);

    const res = await post(base, '/confirm/apply', {
      runId: [CLEAN_A, CLEAN_B],
      shown: [digestOf(FIRST_REPLY), digestOf(SECOND_REPLY)],
    });

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(approve).toHaveBeenCalledWith(CLEAN_A, REVIEWER, digestOf(FIRST_REPLY));
    expect(approve).toHaveBeenCalledWith(CLEAN_B, REVIEWER, digestOf(SECOND_REPLY));
    // The handoff's own words, where they are true: the ledger holds the two
    // records pending, so nothing has been sent, and the panel says so.
    expect(html).toContain('2 replies approved.');
    expect(html).toContain('The relay has sent none of them yet');
    expect(html).toContain('Nothing clean is waiting.');
    expect(html).toContain('Undo · 12s');
    // The undo carries the runs it approved, and nothing else.
    const undoForm = /<form method="post" action="\/undo">(.*?)<\/form>/s.exec(html)?.[1];
    // Read, not merely present: the ids below are the assertion, and a form
    // that drew no field at all once passed a bare `toBeDefined` here.
    expect(undoForm).toBeTypeOf('string');
    expect([...undoForm!.matchAll(/name="runId" value="([^"]+)"/g)].map((m) => m[1]))
      .toEqual([CLEAN_A, CLEAN_B]);
  });

  it('undoes the runs the panel names, and says what came back', async () => {
    const approve = vi.fn().mockResolvedValue('approved');
    const undo = vi.fn().mockResolvedValue({ outcome: 'undone' });
    const base = await startGuarded(deps(batchDeps({ approve, undo })), undefined, undefined, true);

    const res = await post(base, '/undo', { runId: [CLEAN_A, CLEAN_B] });

    expect(res.status).toBe(200);
    expect(undo.mock.calls).toEqual([[CLEAN_A, REVIEWER], [CLEAN_B, REVIEWER]]);
    expect(await res.text()).toContain('2 replies were taken back');
  });

  // One case that can no longer be undone does not stop the others, and its
  // answer is drawn in the undo's own words.
  it('draws a refusal per case, in the sentence that case has', async () => {
    const undo = vi.fn()
      .mockResolvedValueOnce({ outcome: 'undone' })
      .mockResolvedValueOnce({ outcome: 'window_passed' });
    const base = await startGuarded(deps(batchDeps({ undo })), undefined, undefined, true);

    const html = await (await post(base, '/undo', { runId: [CLEAN_A, CLEAN_B] })).text();

    expect(html).toContain('One reply was taken back');
    expect(html).toContain('The hold period has passed');
  });

  // A case whose reply moved since the page was drawn refuses while its
  // neighbours send. A batch that reported both sent would be a lie.
  it('sends what it can and names the case that refused', async () => {
    const approve = vi.fn()
      .mockResolvedValueOnce('approved')
      .mockResolvedValueOnce('shown_changed');
    const base = await startGuarded(deps(batchDeps({ approve })), undefined, undefined, true);

    const html = await (await post(base, '/confirm/apply', {
      runId: [CLEAN_A, CLEAN_B],
      shown: [digestOf(FIRST_REPLY), digestOf(SECOND_REPLY)],
    })).text();

    expect(html).toContain('1 reply approved.');
    expect(html).not.toContain('Nothing clean is waiting.');
    expect(html).toContain('The reply changed since this page was drawn');
  });

  // Criterion 1's last clause, and the handoff's own words: a primary control
  // acting on zero objects is a defect. The button is drawn only where the
  // clean group has rows, so a queue whose clean cases are gone draws none.
  // SEC-8: a single approval holds its send too, and the case it approved is
  // where a reviewer looks for the way back. Before this bar, that page said
  // "Approved. The relay performs it next." while the relay was waiting.
  it('offers the undo on the case a single approval just resolved', async () => {
    const readApprovalHold = vi
      .fn()
      .mockResolvedValue({ held: true, remainingMs: 9_400, status: 'pending' });
    const base = await startGuarded(deps(resolvedCase({ readApprovalHold })), undefined, undefined, true);

    const html = await (await fetch(`${base}/case/${RUN}?outcome=approved`)).text();

    expect(readApprovalHold).toHaveBeenCalledWith(RUN);
    expect(html).toContain('This reply is held · 9s');
    expect(html).toContain('Undo · 9s');
    expect(html).toContain(`name="runId" value="${RUN}"`);
    // The window is the one left, read from the ledger, and not the twelve
    // seconds the console is configured with.
    expect(html).not.toContain('Undo · 12s');
  });

  // Not held is an answer: a case whose window has passed draws the outcome
  // and nothing else, and no control that would refuse.
  it('offers no undo on a case whose window has passed', async () => {
    const base = await startGuarded(
      deps(resolvedCase({
        readApprovalHold: async () => ({ held: false, remainingMs: 0, status: 'sent' }),
      })),
      undefined, undefined, true,
    );

    const html = await (await fetch(`${base}/case/${RUN}?outcome=approved`)).text();

    // The rendered control, not the words: the page's one inline script holds
    // the countdown's own 'Undo · ' and its [data-undo-seconds] selector, so
    // a document-wide check for either is true of every page this console
    // serves. The form's action is in the markup alone.
    expect(html).not.toContain('This reply is held');
    expect(html).not.toContain('action="/undo"');
  });

  // A fault reading the window is its own answer. A page that drew neither
  // the bar nor a word about it would read as a case with no way back.
  it('says the window on the case was not read, rather than that none is held', async () => {
    const base = await startGuarded(
      deps(resolvedCase({
        readApprovalHold: async () => { throw new Error('the ledger is unreachable'); },
      })),
      undefined, undefined, true,
    );

    const html = await (await fetch(`${base}/case/${RUN}?outcome=approved`)).text();

    expect(html).toContain('The hold on this approval was not read');
    expect(html).toContain('The console log names the fault');
  });

  it('offers no confirm button when no clean case is waiting', async () => {
    const base = await startGuarded(deps({
      // Every case here is held by somebody else, so the clean group is empty.
      listApprovals: async () => [
        { ...cleanRun(CLEAN_A, 'SYN-A', FIRST_REPLY), runId: CLEAN_B },
      ],
      readHolds: async () => new Map([[CLEAN_B, {
        reviewer: 'sam@example.test',
        takenAt: new Date(Date.now() - 60_000),
        lapsesAt: new Date(Date.now() + 1_140_000),
      }]]),
    }));
    const html = await (await fetch(base + '/')).text();

    expect(html).toContain('Held by someone else');
    expect(html).not.toContain('Confirm all');
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain('action="/confirm"');
  });

  /**
   * The one waiting run as the case page reads it after its approval: the
   * same fixture the case's own suite uses, left the queue and approved.
   */
  function resolvedCase(over: Partial<ConsoleDeps> = {}): Partial<ConsoleDeps> {
    return {
      ...batchDeps({
        readRun: caseOf({ runId: RUN, ticketId: 'SYN-1', state: 'resolved', approved: true }),
      }),
      ...over,
    };
  }

  // T-11: the cases a batch leaves out. A page that drew four rows for five
  // ticked boxes would send a smaller batch than the reviewer asked for and
  // say nothing about it.
  it('names each case a batch left out, and why', async () => {
    const approve = vi.fn().mockResolvedValue('approved');
    const missing = '55555555-5555-4555-8555-555555555555';
    const wordless = '66666666-6666-4666-8666-666666666666';
    const unreadable = '77777777-7777-4777-8777-777777777777';
    const base = await startGuarded(
      deps(batchDeps({
        approve,
        readRun: (async (runId: string) => {
          if (runId === CLEAN_A) return cleanRun(CLEAN_A, 'SYN-A', FIRST_REPLY);
          if (runId === missing) return null;
          if (runId === unreadable) throw new Error('the ledger is unreachable');
          // A run the console can read, holding no reply it can send: a
          // turn nobody edited and a park whose draft body is absent.
          return {
            ...cleanRun(wordless, 'SYN-W', FIRST_REPLY),
            request: { ...REQUEST, savedReplyText: null },
            evidence: { ...EVIDENCE, draftBody: null },
          };
        }) as ConsoleDeps['readRun'],
      })),
      undefined, undefined, true,
    );

    const html = await (await post(base, '/confirm', {
      runId: [CLEAN_A, missing, wordless, unreadable],
    })).text();

    expect(html).toContain('Confirm 1 · send each reply');
    expect(html).toContain(`${missing.slice(0, 8)}: the ledger does not hold this case`);
    expect(html).toContain(`${wordless.slice(0, 8)}: this case holds no reply this console can send`);
    expect(html).toContain(`${unreadable.slice(0, 8)}: this case could not be read`);
    // And the batch that remains is the one case that could be drawn.
    expect(approve).not.toHaveBeenCalled();
  });

  // Every picked case unreadable is its own refusal, with its own sentence:
  // "nothing was sent" would be true, and saying the cases hold no reply
  // would state a fact nobody established.
  it('refuses a batch whose every case could not be read', async () => {
    const approve = vi.fn();
    const base = await startGuarded(
      deps(batchDeps({
        approve,
        readRun: (async () => { throw new Error('the ledger is unreachable'); }) as ConsoleDeps['readRun'],
      })),
      undefined, undefined, true,
    );

    const res = await post(base, '/confirm', { runId: [CLEAN_A] });

    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('None of those cases could be read, so nothing was sent.');
    expect(html).toContain('Open the queue to pick the cases again.');
  });

  // A run the result page could not read is drawn as its own callout rather
  // than with a sentence about a state nobody read. This route takes its run
  // ids off the form and reads each run once, to fit the outcome: the read
  // here is that one.
  it('names a run the result page could not read', async () => {
    const approve = vi.fn()
      .mockResolvedValueOnce('approved')
      .mockResolvedValueOnce('shown_changed');
    const runs: Record<string, unknown> = {
      [CLEAN_A]: cleanRun(CLEAN_A, 'SYN-A', FIRST_REPLY),
      [CLEAN_B]: cleanRun(CLEAN_B, 'SYN-B', SECOND_REPLY),
    };
    const base = await startGuarded(
      deps(batchDeps({
        approve,
        readRun: (async (runId: string) => {
          if (runId === CLEAN_B) throw new Error('the ledger stopped answering');
          return runs[runId] ?? null;
        }) as ConsoleDeps['readRun'],
      })),
      undefined, undefined, true,
    );

    const html = await (await post(base, '/confirm/apply', {
      runId: [CLEAN_A, CLEAN_B],
      shown: [digestOf(FIRST_REPLY), digestOf(SECOND_REPLY)],
    })).text();

    // The refused case's run could not be read, so its callout draws no
    // sentence about a state nobody read, and the page names the fault
    // instead. A sentence here would be the fallback wording for an outcome
    // the console cannot fit.
    expect(html).not.toContain('The reply changed since this page was drawn');
    expect(html).toContain(`${CLEAN_B.slice(0, 8)}: the run could not be read, so this console`);
    expect(html).toContain('what became of it. The console log holds the fault.');
    // And the fault did not stop the page: the panel is drawn, with the
    // count of what was approved.
    expect(html).toContain('1 reply approved.');
  });

  // T-2: the panel counts the window the ledger holds, not the period the
  // console is configured with. Both are 12 000 ms in the default harness, so
  // this case moves the ledger's answer away from it.
  // T-10: the countdown is a contract between the markup and the page's one
  // inline script. Renaming the attribute on either side stops the countdown
  // silently, and nothing asserted it.
  it('pins the countdown to the attribute the script reads', async () => {
    const approve = vi.fn().mockResolvedValue('approved');
    const base = await startGuarded(deps(batchDeps({ approve })), undefined, undefined, true);

    const html = await (await post(base, '/confirm/apply', {
      runId: [CLEAN_A],
      shown: [digestOf(FIRST_REPLY)],
    })).text();

    // The markup carries the window, and the script reads that attribute.
    expect(html).toContain('data-undo-seconds="12"');
    expect(CONSOLE_SCRIPT).toContain('[data-undo-seconds]');
    expect(CONSOLE_SCRIPT).toContain("getAttribute('data-undo-seconds')");
    // The note the script writes into is on the page, hidden until it does.
    expect(html).toContain('data-undo-note hidden');
    expect(CONSOLE_SCRIPT).toContain('[data-undo-note]');
    // The queue's key handler and the button it activates, the same way.
    const queue = await (await fetch(`${base}/`)).text();
    expect(queue).toContain('data-batch-confirm');
    expect(CONSOLE_SCRIPT).toContain('[data-batch-confirm]');
  });

  it('counts the window the ledger holds, not the period that was set', async () => {
    const approve = vi.fn().mockResolvedValue('approved');
    const base = await startGuarded(
      deps(batchDeps({
        approve,
        readApprovalHold: async () => ({ held: true, remainingMs: 9_400, status: 'pending' }),
      })),
      undefined, undefined, true,
    );

    const html = await (await post(base, '/confirm/apply', {
      runId: [CLEAN_A],
      shown: [digestOf(FIRST_REPLY)],
    })).text();

    expect(html).toContain('Undo · 9s');
    expect(html).not.toContain('Undo · 12s');
    // And the panel says what the ledger holds: a pending record is not sent.
    expect(html).toContain('1 reply approved.');
    expect(html).toContain('The relay has sent none of them yet');
  });

  // The handoff's own words, and only where the ledger backs them: a batch
  // whose records the ledger reports sent draws them.
  it('calls the replies sent only where the ledger says they were', async () => {
    const approve = vi.fn().mockResolvedValue('approved');
    const base = await startGuarded(
      deps(batchDeps({
        approve,
        readApprovalHold: async () => ({ held: false, remainingMs: 0, status: 'sent' }),
      })),
      undefined, undefined, true,
    );

    const html = await (await post(base, '/confirm/apply', {
      runId: [CLEAN_A, CLEAN_B],
      shown: [digestOf(FIRST_REPLY), digestOf(SECOND_REPLY)],
    })).text();

    expect(html).toContain('2 replies sent.');
    // With every window closed and nothing left to take back.
    expect(html).toContain('These sends were not held, so there is nothing to undo.');
  });

  // A ready window and a sent record in one batch: the panel says both.
  it('says how many of a mixed batch the relay has sent', async () => {
    const approve = vi.fn().mockResolvedValue('approved');
    const readApprovalHold = vi.fn(async (runId: string) => (runId === CLEAN_A
      ? { held: false, remainingMs: 0, status: 'sent' }
      : { held: true, remainingMs: 5_000, status: 'pending' }));
    const base = await startGuarded(
      deps(batchDeps({ approve, readApprovalHold })), undefined, undefined, true,
    );

    const html = await (await post(base, '/confirm/apply', {
      runId: [CLEAN_A, CLEAN_B],
      shown: [digestOf(FIRST_REPLY), digestOf(SECOND_REPLY)],
    })).text();

    expect(html).toContain('2 replies approved.');
    expect(html).toContain('The relay has sent 1 of them');
    expect(html).toContain('Undo · 5s');
  });

  // A hold this console could not read is not a window that is absent: the
  // undo is still drawn, without a countdown this page did not earn, and the
  // sentence names the log line rather than claiming nothing is held.
  it('draws the undo without a countdown when a window could not be read', async () => {
    const approve = vi.fn().mockResolvedValue('approved');
    const base = await startGuarded(
      deps(batchDeps({
        approve,
        readApprovalHold: async () => { throw new Error('the ledger is unreachable'); },
      })),
      undefined, undefined, true,
    );

    const html = await (await post(base, '/confirm/apply', {
      runId: [CLEAN_A],
      shown: [digestOf(FIRST_REPLY)],
    })).text();

    expect(html).toContain('The window on at least one of these cases was not read');
    expect(html).toContain('The console log names the fault');
    // The way back is still offered, and it promises no window.
    expect(html).toContain('action="/undo"');
    expect(html).toContain('>Undo</button>');
    // The attribute with a value, which is the markup: the page's one inline
    // script names the bare attribute in its selector on every page it serves.
    expect(html).not.toContain('data-undo-seconds="');
    expect(html).not.toContain('These sends were not held');
  });

  // A case whose approval faulted is offered to the undo too: the fault can
  // arrive after the approval committed, and that case is the one that may
  // hold a live send.
  it('offers the undo for a case whose approval faulted', async () => {
    const approve = vi.fn()
      .mockResolvedValueOnce('approved')
      .mockRejectedValueOnce(new Error('the ledger stopped answering'));
    const base = await startGuarded(deps(batchDeps({ approve })), undefined, undefined, true);

    const html = await (await post(base, '/confirm/apply', {
      runId: [CLEAN_A, CLEAN_B],
      shown: [digestOf(FIRST_REPLY), digestOf(SECOND_REPLY)],
    })).text();

    // The fault says what it knows, and points at the case.
    expect(html).toContain('this case could not be approved, and this console cannot say whether it was');
    expect(html).toContain('Open the case to read whether a reply is held.');
    const undoForm = /<form method="post" action="\/undo">(.*?)<\/form>/s.exec(html)?.[1];
    expect([...undoForm!.matchAll(/name="runId" value="([^"]+)"/g)].map((m) => m[1]))
      .toEqual([CLEAN_A, CLEAN_B]);
  });

  // Every refusal the ledger can give is drawn in its own sentence, and every
  // one of them says nothing was undone. A map entry the page never reaches
  // is a sentence a reviewer never reads — and until this case, three of the
  // six were in that state.
  it('draws every undo answer the ledger can give, in its own words', async () => {
    // The literal each sentence must be, spelled here rather than read from
    // the table the renderer writes from: a case that asserts the same
    // constant proves the routing and not the words, and a table entry
    // rewritten into nonsense would pass it.
    const SAYS = {
      unknown_run: 'That run is not in the ledger.',
      nothing_to_undo: 'That case holds no approval to undo.',
      busy: 'Another write holds that case, so nothing was undone. Try again in a moment.',
      already_sent: 'The reply was sent, so there is nothing to undo.',
    } as const;
    for (const [outcome, says] of Object.entries(SAYS) as [keyof typeof SAYS, string][]) {
      const undo = vi.fn().mockResolvedValue({ outcome });
      const base = await startGuarded(deps(batchDeps({ undo })), undefined, undefined, true);

      const html = await (await post(base, '/undo', { runId: [CLEAN_A] })).text();

      // The sentence, attached to the case it answers about: a swap between
      // two cases would pass a check that only asked whether both appear.
      expect(html, outcome).toContain(`${CLEAN_A.slice(0, 8)}: ${says}`);
      expect(UNDO_SAYS[outcome], outcome).toBe(says);
      // The panel is drawn as a refusal, not as a success.
      expect(html, outcome).toContain('Nothing was undone.');
      expect(html, outcome).not.toContain('was taken back');
    }
  });

  // T4: the way back is a form like any other, so the batch it does not read
  // is refused before any case is touched — and the page says where to go.
  it('refuses an undo batch it does not read, and undoes nothing', async () => {
    const undo = vi.fn();
    const base = await startGuarded(deps(batchDeps({ undo })), undefined, undefined, true);

    for (const fields of [
      {},
      { runId: ['not-a-run-id'] },
      { runId: Array.from({ length: 51 }, () => CLEAN_A) },
    ]) {
      const res = await post(base, '/undo', fields);
      expect(res.status, JSON.stringify(fields).slice(0, 40)).toBe(400);
      expect(await res.text()).toContain('Open the queue to pick the cases again.');
    }
    expect(undo).not.toHaveBeenCalled();
  });

  // T4, the screen's half: the confirmation page carries its own bound, and a
  // batch past it never reaches a reply.
  it('refuses a confirmation batch it does not read, and sends nothing', async () => {
    const approve = vi.fn();
    const base = await startGuarded(deps(batchDeps({ approve })), undefined, undefined, true);

    for (const fields of [
      {},
      { runId: Array.from({ length: 51 }, () => CLEAN_A) },
    ]) {
      const res = await post(base, '/confirm', fields);
      expect(res.status, JSON.stringify(fields).slice(0, 40)).toBe(400);
      expect(await res.text()).toContain('Open the queue to pick the cases again.');
    }
    expect(approve).not.toHaveBeenCalled();
  });

  // A body past the bound is refused before the route reads a field, and the
  // page says what was not done. The three sentences differ: an oversized
  // confirmation did not send, an oversized undo did not undo.
  it('refuses an oversized batch form, and names what was not done', async () => {
    const approve = vi.fn();
    const undo = vi.fn();
    const base = await startGuarded(
      deps(batchDeps({ approve, undo })), undefined, undefined, true,
    );

    // Every route that reads a batch, not only the one that draws a screen:
    // the bound is the body's, and a route that reached a write before it
    // would make the refusal a lie.
    for (const [path, form] of [
      ['/confirm', 'confirmation'],
      ['/confirm/apply', 'confirmation'],
      ['/undo', 'undo'],
    ]) {
      const body = new URLSearchParams();
      body.append('runId', CLEAN_A);
      body.append('pad', 'x'.repeat(70_000));

      const res = await fetch(base + path, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'sec-fetch-site': 'same-origin',
          origin: base,
        },
        body: body.toString(),
        redirect: 'manual',
      });

      expect(res.status, path).toBe(413);
      const html = await res.text();
      expect(html, path).toContain(`The ${form} form is larger than this console accepts.`);
      expect(html, path).toContain('Nothing was changed.');
      // And the way on, which every refusal carries.
      expect(html, path).toContain('Open the queue to pick the cases again.');
    }
    expect(approve).not.toHaveBeenCalled();
    expect(undo).not.toHaveBeenCalled();
  });

  it('refuses a batch this console does not read, and sends nothing', async () => {
    const approve = vi.fn();
    const base = await startGuarded(deps(batchDeps({ approve })));

    for (const fields of [
      {},
      { runId: ['not-a-run-id'] },
      { runId: [CLEAN_A], shown: [] },
      { runId: Array.from({ length: 51 }, () => CLEAN_A), shown: Array.from({ length: 51 }, () => SHOWN) },
    ]) {
      const res = await post(base, '/confirm/apply', fields);
      expect(res.status, JSON.stringify(fields).slice(0, 40)).toBe(400);
    }
    expect(approve).not.toHaveBeenCalled();
  });
});

describe('DEC-48: the console closes a case with no reply', () => {
  /** The digest of the reply this harness's page draws (DEC-46). */
  const DRAWN = createHash('sha256').update(EVIDENCE.draftBody).digest('hex');

  async function postClose(base: string, fields: Record<string, string>): Promise<Response> {
    return fetch(`${base}/close`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'same-origin',
        origin: base,
      },
      body: new URLSearchParams(fields).toString(),
      redirect: 'manual',
    });
  }

  it('offers the close on a waiting case, with the reason field inside its own form', async () => {
    const base = await startGuarded(deps());
    const html = await (await fetch(base + CASE)).text();

    expect(buttonInForm(html, '/close')).toBe(true);
    // The button the handoff names, and the field the record needs.
    expect(html).toContain('Close, no reply');
    expect(html).toMatch(/<input[^>]*name="reason"/);
    // DEC-46: the digest of the reply this page drew, so a close from a page
    // drawn against other text refuses.
    expect(html).toContain(`name="shown" value="${DRAWN}"`);
    // What closing does, and what it does not: nothing is sent.
    expect(html).toContain('The customer is sent nothing.');
  });

  it('closes the case and lands on the page that says so', async () => {
    const close = vi.fn(async () => 'closed' as const);
    // The state the ledger holds once the close committed. The page reads the
    // run it landed on, and the sentence it draws is checked against it.
    const base = await startGuarded(deps({ close, readRun: caseOf({ state: 'closed' }) }));
    const res = await postClose(base, { runId: RUN, shown: DRAWN, reason: 'Duplicate of T-4471.' });

    // See other, so a refresh cannot close a second time.
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${CASE}?closed=closed`);
    // The identity is the one the gate resolved, and the digest is the page's.
    expect(close).toHaveBeenCalledWith(RUN, REVIEWER, 'Duplicate of T-4471.', DRAWN);

    const after = await (await fetch(`${base}${CASE}?closed=closed`, {
      headers: { 'sec-fetch-site': 'same-origin' },
    })).text();
    expect(after).toContain('The case is closed with no reply.');
  });

  it('draws a closed case as finished, with no approval left on it', async () => {
    const base = await startGuarded(deps({
      readRun: caseOf({ state: 'closed', approved: false }),
    }));
    const html = await (await fetch(base + CASE)).text();

    expect(html).toContain('<span class="chip" style="color:var(--dim)">closed</span>');
    expect(html).toContain('This run is closed, so there is nothing here to approve.');
    // No way to approve or close a case that has left the queue, and no form
    // offering one.
    expect(buttonInForm(html, '/approve')).toBe(false);
    expect(buttonInForm(html, '/close')).toBe(false);
  });

  it('writes nothing for a request this console did not render', async () => {
    const close = vi.fn(async () => 'closed' as const);
    const base = await startGuarded(deps({ close }));

    // No digest: a request that never came from this page.
    const noDigest = await postClose(base, { runId: RUN, reason: 'Duplicate.' });
    expect(noDigest.status).toBe(400);
    expect(await noDigest.text()).toContain('will not close the case');
    // A digest of another shape, which is the same answer.
    const badDigest = await postClose(base, { runId: RUN, shown: 'x'.repeat(64), reason: 'D.' });
    expect(badDigest.status).toBe(400);
    // A run id of another shape, refused before the ledger is asked.
    const badRun = await postClose(base, { runId: 'not-a-run', shown: DRAWN, reason: 'D.' });
    expect(badRun.status).toBe(400);
    expect(await badRun.text()).toContain('nothing was closed');

    expect(close).not.toHaveBeenCalled();
  });

  it('draws each answer the ledger gives about a close, in its own words', async () => {
    // The console does not judge the reason: the core refuses an empty one and
    // one past its bound, before any write, and answers with a code. Each
    // sentence is drawn beside the case whose state that answer describes.
    const answers = [
      ['closed', 'The case is closed with no reply.', { state: 'closed' }],
      ['empty_reason', 'A close records the reason, and that one was empty', {}],
      ['reason_too_long', 'That reason is longer than a close records', {}],
      ['shown_changed', 'The reply changed since this page was drawn, so nothing was closed.', {}],
      ['not_awaiting_approval', 'That run is not waiting for approval. It is resolved now, so nothing was closed.', { state: 'resolved' }],
      ['unknown_run', 'That run is not in the ledger.', null],
    ] as const;
    for (const [outcome, said, over] of answers) {
      const base = await startGuarded(deps(
        over === null
          ? { readRun: async () => null }
          : { readRun: caseOf(over as Record<string, unknown>) },
      ));
      const html = await (await fetch(`${base}${CASE}?closed=${outcome}`, {
        headers: { 'sec-fetch-site': 'same-origin' },
      })).text();
      expect(html, outcome).toContain(said);
    }
  });

  it('draws the sentence a close that lost a race is given', async () => {
    // A second close on one case answers `not_awaiting_approval` with the
    // state the first one left — `closed`. The page reads a closed case, so
    // the sentence is true of it and is drawn.
    const base = await startGuarded(deps({ readRun: caseOf({ state: 'closed' }) }));
    const html = await (await fetch(`${base}${CASE}?closed=not_awaiting_approval`, {
      headers: { 'sec-fetch-site': 'same-origin' },
    })).text();
    // The state is named, so a page showing a closed case cannot read as
    // "this case is still open".
    expect(html).toContain(
      'That run is not waiting for approval. It is closed now, so nothing was closed.',
    );
  });

  it('draws every outcome the ledger can answer, each against a case that fits it', async () => {
    // The whole table, so a row added without a reachable state fails here
    // rather than on a page nobody looked at.
    for (const [outcome, run] of [
      ['closed', { state: 'closed' }],
      ['empty_reason', {}],
      ['reason_too_long', {}],
      ['unprintable_reason', {}],
      ['shown_changed', {}],
      ['stale_epoch', {}],
      ['not_awaiting_approval', { state: 'resolved' }],
    ] as const) {
      const base = await startGuarded(deps({ readRun: caseOf(run as Record<string, unknown>) }));
      const html = await (await fetch(`${base}${CASE}?closed=${outcome}`, {
        headers: { 'sec-fetch-site': 'same-origin' },
      })).text();
      expect(html, outcome).toContain(`data-close="${outcome}"`);
      expect(html, outcome).not.toContain('That is not an answer this console knows.');
    }
  });

  it('refuses to draw a close outcome the case contradicts', async () => {
    // Every outcome is checked against the state the page read, so a link
    // anyone can send cannot make the console say a waiting case was closed.
    // The waiting run is the harness's own: `closed` claims a state it is not
    // in, and `not_awaiting_approval` claims one it is.
    for (const outcome of ['closed', 'not_awaiting_approval']) {
      const base = await startGuarded(deps());
      const html = await (await fetch(`${base}${CASE}?closed=${outcome}`, {
        headers: { 'sec-fetch-site': 'same-origin' },
      })).text();
      expect(html, outcome).toContain('That is not an answer this console knows.');
      expect(html, outcome).not.toContain('data-close=');
    }

    // A name this console does not know is never echoed, nor is one inherited
    // from the prototype: `?closed=toString` resolved a function and threw on
    // an older version of this page.
    for (const outcome of ['toString', 'because']) {
      const base = await startGuarded(deps());
      const html = await (await fetch(`${base}${CASE}?closed=${outcome}`, {
        headers: { 'sec-fetch-site': 'same-origin' },
      })).text();
      expect(html, outcome).toContain('That is not an answer this console knows.');
      expect(html, outcome).not.toContain(`data-close="${outcome}"`);
    }
  });

  // The reason is a reviewer's own text, and it can quote a customer. It
  // reaches the case page's timeline through `stepSays`, so it goes through
  // the same escape as every other ledger value this console draws.
  it('draws a hostile reason as text, never as markup', async () => {
    const hostile = '"><script>alert(1)</script>';
    const base = await startGuarded(deps({
      readRun: caseOf({
        state: 'closed',
        steps: [{
          stepId: 'close', status: 'done', awaitingOutcome: false, malformed: false,
          says: `closed by anna@example.test · ${hostile}`,
        }],
      }),
    }));
    const html = await (await fetch(base + CASE)).text();
    expect(html).not.toContain(hostile);
    expect(html).toContain('closed by anna@example.test · &quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    // The one script this console ships, and no second one from the reason.
    expect(html.split('<script>')).toHaveLength(2);
  });

  it('refuses a close form larger than the console accepts', async () => {
    const close = vi.fn(async () => 'closed' as const);
    const base = await startGuarded(deps({ close }));

    const res = await fetch(`${base}/close`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'same-origin',
        origin: base,
      },
      body: `runId=${RUN}&shown=${DRAWN}&reason=${'x'.repeat(70 * 1024)}`,
    });

    expect(res.status).toBe(413);
    expect(await res.text()).toContain('The close is larger than this console accepts.');
    expect(close).not.toHaveBeenCalled();
  });

  it('answers a failed close without claiming it did not commit', async () => {
    // The write was reached and its answer never read, so the page says the
    // close may have committed rather than denying it. A fault before the
    // call is impossible here: every check this route makes returns first.
    const close = vi.fn(async () => { throw new Error('the pool is gone'); });
    const base = await startGuarded(deps({ close }));
    const res = await postClose(base, { runId: RUN, shown: DRAWN, reason: 'Duplicate.' });

    expect(close).toHaveBeenCalled();
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toContain('may or may not have committed');
    expect(body).not.toContain('nothing was closed');
  });

  it('returns a close to the queue the reviewer narrowed to', async () => {
    const close = vi.fn(async () => 'closed' as const);
    const base = await startGuarded(deps({ close }));
    // The filters ride on the action, never in a field (DEC-47), as the
    // approval's do.
    const res = await fetch(`${base}/close?rule=customer_visible&product=aurora`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'same-origin',
        origin: base,
      },
      body: new URLSearchParams({ runId: RUN, shown: DRAWN, reason: 'Duplicate.' }).toString(),
      redirect: 'manual',
    });
    expect(res.headers.get('location')).toBe(
      `${CASE}?closed=closed&rule=customer_visible&product=aurora`,
    );
  });

  it('bounds the reason in the form, so the field cannot post one the ledger refuses', async () => {
    const base = await startGuarded(deps());
    const html = await (await fetch(base + CASE)).text();
    expect(html).toContain(`maxlength="${MAX_CLOSE_REASON_CHARS}"`);
  });
});

describe('DEC-48: the console puts a case aside', () => {
  /** The digest of the reply this harness's page draws (DEC-46). */
  const DRAWN = createHash('sha256').update(EVIDENCE.draftBody).digest('hex');

  async function postSnooze(base: string, fields: Record<string, string>): Promise<Response> {
    return fetch(`${base}/snooze`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'same-origin',
        origin: base,
      },
      body: new URLSearchParams(fields).toString(),
      redirect: 'manual',
    });
  }

  it('offers the snooze on a waiting case, with the period inside its own form', async () => {
    const base = await startGuarded(deps());
    const html = await (await fetch(base + CASE)).text();

    expect(buttonInForm(html, '/snooze')).toBe(true);
    expect(html).toContain('Snooze');
    // The period is a number of minutes, bounded by the ledger's own bounds.
    expect(html).toMatch(/<input[^>]*name="minutes"[^>]*type="number"/);
    expect(html).toContain(`min="${Math.round(MIN_SNOOZE_MS / 60_000)}"`);
    expect(html).toContain(`max="${Math.round(MAX_SNOOZE_MS / 60_000)}"`);
    // And the sentence says what putting it aside does: nothing is sent.
    expect(html).toContain('Nothing is sent.');
  });

  // A case that is already aside offers no second snooze, and a case that has
  // left the queue offers none at all.
  it('offers the snooze only where a case is waiting', async () => {
    for (const state of ['snoozed', 'closed', 'resolved']) {
      const base = await startGuarded(deps({ readRun: caseOf({ state }) }));
      const html = await (await fetch(base + CASE)).text();
      expect(buttonInForm(html, '/snooze'), state).toBe(false);
    }
  });

  it('says when a snoozed case comes back', async () => {
    const due = new Date('2026-09-21T09:00:00.000Z');
    const base = await startGuarded(deps({
      readRun: caseOf({ state: 'snoozed', snoozedUntil: due }),
    }));
    const html = await (await fetch(base + CASE)).text();
    expect(html).toContain('This run is snoozed, so there is nothing here to approve.');
    expect(html).toContain(`It returns to the queue at ${whenSays(due)}.`);
  });

  it('puts the case aside, and lands on the page that says so', async () => {
    const snooze = vi.fn(async () => 'snoozed' as const);
    const base = await startGuarded(deps({ snooze, readRun: caseOf({ state: 'snoozed' }) }));
    const res = await postSnooze(base, { runId: RUN, shown: DRAWN, minutes: '180' });

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${CASE}?snoozed=snoozed`);
    // The period travels in milliseconds, from the hours the form posts.
    expect(snooze).toHaveBeenCalledWith(RUN, REVIEWER, 180 * 60_000, DRAWN);

    const after = await (await fetch(`${base}${CASE}?snoozed=snoozed`, {
      headers: { 'sec-fetch-site': 'same-origin' },
    })).text();
    expect(after).toContain('The case is put aside.');
  });

  it('passes a period that is not a number to the ledger, which refuses it', async () => {
    // The bounds live in the write and not in the form, so the console hands
    // over what it read rather than deciding for itself. A field that is not
    // a number travels as a value no integer can be, and the ledger answers
    // out of range: nothing is put aside, and the page says so.
    const snooze = vi.fn(async () => 'period_out_of_range' as const);
    const base = await startGuarded(deps({ snooze }));

    const res = await postSnooze(base, { runId: RUN, shown: DRAWN, minutes: 'abc' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${CASE}?snoozed=period_out_of_range`);
    expect(snooze).toHaveBeenCalledWith(RUN, REVIEWER, Number.POSITIVE_INFINITY, DRAWN);

    const after = await (await fetch(`${base}${CASE}?snoozed=period_out_of_range`, {
      headers: { 'sec-fetch-site': 'same-origin' },
    })).text();
    expect(after).toContain('A snooze lasts between a minute and 30 days');
  });

  it('returns a snooze to the queue the reviewer narrowed to', async () => {
    const snooze = vi.fn(async () => 'snoozed' as const);
    const base = await startGuarded(deps({ snooze, readRun: caseOf({ state: 'snoozed' }) }));
    const res = await fetch(`${base}/snooze?rule=customer_visible&product=aurora`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'same-origin',
        origin: base,
      },
      body: new URLSearchParams({ runId: RUN, shown: DRAWN, minutes: '120' }).toString(),
      redirect: 'manual',
    });
    expect(res.headers.get('location')).toBe(
      `${CASE}?snoozed=snoozed&rule=customer_visible&product=aurora`,
    );
  });

  it('writes nothing for a request this console did not render', async () => {
    const snooze = vi.fn(async () => 'snoozed' as const);
    const base = await startGuarded(deps({ snooze }));

    const noDigest = await postSnooze(base, { runId: RUN, minutes: '120' });
    expect(noDigest.status).toBe(400);
    expect(await noDigest.text()).toContain('will not put the case aside');
    const badRun = await postSnooze(base, { runId: 'not-a-run', shown: DRAWN, minutes: '120' });
    expect(badRun.status).toBe(400);
    expect(await badRun.text()).toContain('nothing was put aside');
    const oversized = await fetch(`${base}/snooze`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'same-origin',
        origin: base,
      },
      body: `runId=${RUN}&shown=${DRAWN}&minutes=${'9'.repeat(70 * 1024)}`,
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.text()).toContain('The snooze form is larger than this console accepts.');

    expect(snooze).not.toHaveBeenCalled();
  });

  it('answers a failed snooze without claiming it did not commit', async () => {
    const snooze = vi.fn(async () => { throw new Error('the pool is gone'); });
    const base = await startGuarded(deps({ snooze }));
    const res = await postSnooze(base, { runId: RUN, shown: DRAWN, minutes: '120' });

    expect(snooze).toHaveBeenCalled();
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toContain('may or may not have committed');
    expect(body).not.toContain('nothing was put aside');
  });

  // Every outcome the ledger can answer, each against a case that fits it.
  it('draws every snooze answer, and refuses one the case contradicts', async () => {
    for (const [outcome, state] of [
      ['snoozed', 'snoozed'],
      ['period_out_of_range', 'awaiting_approval'],
      ['shown_changed', 'awaiting_approval'],
      ['stale_epoch', 'awaiting_approval'],
      ['not_awaiting_approval', 'resolved'],
    ] as const) {
      const base = await startGuarded(deps({ readRun: caseOf({ state }) }));
      const html = await (await fetch(`${base}${CASE}?snoozed=${outcome}`, {
        headers: { 'sec-fetch-site': 'same-origin' },
      })).text();
      expect(html, outcome).toContain(`data-snooze="${outcome}"`);
    }

    // The bounds in that sentence are the ledger's own, in the units it
    // enforces. A ceiling divided by the wrong unit told a reviewer that a
    // month was 720 days.
    const refused = await startGuarded(deps({ readRun: caseOf({ state: 'awaiting_approval' }) }));
    const refusedHtml = await (await fetch(`${refused}${CASE}?snoozed=period_out_of_range`, {
      headers: { 'sec-fetch-site': 'same-origin' },
    })).text();
    expect(refusedHtml).toContain(
      'A snooze lasts between a minute and 30 days, so nothing was put aside.',
    );

    // A waiting case was not put aside, so that sentence is not drawn on it.
    const waiting = await startGuarded(deps());
    const html = await (await fetch(`${waiting}${CASE}?snoozed=snoozed`, {
      headers: { 'sec-fetch-site': 'same-origin' },
    })).text();
    expect(html).not.toContain('The case is put aside.');

    // And a name this console does not know is never echoed, nor one
    // inherited from the prototype.
    for (const outcome of ['toString', 'because']) {
      const base = await startGuarded(deps());
      const page = await (await fetch(`${base}${CASE}?snoozed=${outcome}`, {
        headers: { 'sec-fetch-site': 'same-origin' },
      })).text();
      expect(page, outcome).toContain('That is not an answer this console knows.');
      expect(page, outcome).not.toContain(`data-snooze="${outcome}"`);
    }
  });
});
