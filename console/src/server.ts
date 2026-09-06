// The console's HTTP layer (issue #27).
//
// `node:http` and nothing else, following `src/ingress/webhook-server.ts`,
// which carries the same note: stdlib only, no framework. The console adds no
// runtime dependency to this repository, which is what lets DEC-11's boundary
// be stated as a package boundary rather than as a convention.
//
// Reads go through the query modules the jobs use — `readDays`, `readLatency`,
// `listRuns`, `listEscalations`. The one write goes through
// `approveFromConsole`, which hands off to `approveRun`. This module issues no
// statement itself, and `select-only.test.ts` holds that.
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';

import { isRunId } from './approve.js';
import { escapeHtml } from './render.js';
import {
  page,
  renderApprovals,
  renderBands,
  renderLatency,
  renderRunDetail,
  renderOutcome,
  renderRuns,
} from './surfaces.js';
import type { BandRow, LatencyRow, RunDetail, RunRow } from './surfaces.js';

/**
 * Everything the console reads or writes, injected.
 *
 * The server takes functions rather than a pool, so a test drives every
 * surface without a database and the module cannot reach the ledger by any
 * route its caller did not hand it.
 */
export interface ConsoleDeps {
  readonly listRuns: () => Promise<RunRow[]>;
  readonly readRun: (runId: string) => Promise<RunDetail | null>;
  readonly listApprovals: () => Promise<RunDetail[]>;
  readonly readBands: () => Promise<BandRow[]>;
  readonly readLatency: () => Promise<LatencyRow[]>;
  readonly approve: (runId: string) => Promise<string>;
}

const CSS_PATH = '/console.css';

/**
 * Refuses a request that did not come from this console's own pages.
 *
 * The approval sends a customer reply, and a sent reply cannot be recalled
 * (DEC-12, DEC-14). Two attacks reach it and neither is stopped by binding to
 * loopback, which an earlier version of this file claimed:
 *
 *   - **Cross-site request forgery.** Any page the operator has open can post
 *     a form-encoded body here. A reverse proxy that authenticates does not
 *     help: the operator's browser is authenticated, and it is the browser
 *     that is being used.
 *   - **DNS rebinding.** A name the attacker controls resolves to 127.0.0.1,
 *     and their page then holds a same-origin handle on this console — it can
 *     read a live run id off `/` and post it, so an unguessable UUID stops
 *     nothing. Checking `Host` is what closes that, because the browser sends
 *     the attacker's name.
 *
 * `Sec-Fetch-Site` is sent by every browser this console targets, and the two
 * methods read it differently.
 *
 * A GET may carry `none`, because that is what a browser sends when the
 * operator types the address or opens a bookmark. A POST may not: `none`
 * means a user-initiated navigation, and a form post is never one. Accepting
 * it there would take the one header value an attacker's page cannot produce
 * and hand it back. A POST also refuses a request carrying neither header,
 * because the write sends a customer reply and a missing signal is not
 * evidence of a same-origin one.
 */
function sameOrigin(req: IncomingMessage, allowedHosts: ReadonlySet<string>): boolean {
  const host = (req.headers.host ?? '').toLowerCase();
  if (!allowedHosts.has(host)) return false;
  const writes = req.method !== 'GET' && req.method !== 'HEAD';
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined) {
    if (site === 'same-origin') return true;
    return site === 'none' && !writes;
  }
  // No Sec-Fetch-Site: fall back to Origin, which a cross-site form post
  // still carries.
  const origin = req.headers.origin;
  // Absent both, a read is a client that is not a browser and the `Host`
  // check above is what stands. A write gets no such benefit: an operator
  // approving from a script sends the header the browser would.
  if (origin === undefined) return !writes;
  try {
    // The scheme is checked, but only to a web origin. Pinning it to `http:`
    // would refuse every approval behind the TLS reverse proxy the runbook
    // recommends, because the browser then sends `https://` — the console
    // cannot know its own scheme, since the proxy terminates the TLS. So the
    // host allowlist stays the discriminator, and this rejects the origins
    // that are not pages at all: `file:`, `data:` and the rest.
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return allowedHosts.has(parsed.host.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Headers every response carries.
 *
 * `frame-ancestors` and `X-Frame-Options` are the ones that matter. The
 * same-origin check cannot see a clickjacking attempt: a page that frames
 * this console and lures the operator's click onto the real Approve button
 * submits the console's own form, so the `Host` is allowed and
 * `Sec-Fetch-Site` is genuinely `same-origin`. Both checks pass and a
 * customer reply leaves (DEC-12, DEC-14). Refusing the frame is what stops
 * it.
 *
 * The rest are cheap: pages render live ledger rows, so they are not for a
 * cache, and the run id travels in the path, so it is not for a referrer.
 */
const SAFETY_HEADERS = {
  'content-security-policy': "frame-ancestors 'none'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
} as const;

function send(res: ServerResponse, status: number, body: string, type = 'text/html'): void {
  res.writeHead(status, { ...SAFETY_HEADERS, 'content-type': `${type}; charset=utf-8` });
  res.end(body);
}

/** The form post body, which is the only input this console takes. */
async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    // A bound, because an operator console on an internal network is still a
    // socket anyone on it can post to.
    if (size > 64 * 1024) throw new Error('the approval form is larger than 64 KiB');
    chunks.push(buf);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

export interface ConsoleOptions {
  /**
   * The `Host` values this console answers to. Every other one is refused,
   * which is what closes DNS rebinding.
   */
  readonly allowedHosts: readonly string[];
}

export function createConsole(
  deps: ConsoleDeps,
  css: string,
  options: ConsoleOptions,
): Server {
  const allowed = new Set(options.allowedHosts.map((h) => h.toLowerCase()));
  return createServer((req, res) => {
    if (!sameOrigin(req, allowed)) {
      // Named, because the commonest cause is a proxy whose name nobody put
      // in `CONSOLE_ALLOWED_HOSTS`. Without the refused `Host` on record the
      // console looks healthy and answers nothing, which is the one failure
      // an operator cannot diagnose from the page.
      console.error(JSON.stringify({
        event: 'console_refused',
        method: req.method ?? null,
        host: req.headers.host ?? null,
        secFetchSite: req.headers['sec-fetch-site'] ?? null,
        origin: req.headers.origin ?? null,
      }));
      send(res, 403, page('Refused', '<p class="mut">This request did not come from the console.</p>'));
      return;
    }
    void route(deps, css, req, res).catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ event: 'console_error', error: reason }));
      // The message reaches the operator as well, because this console has
      // one user and authenticates nobody: anyone who can read the fault can
      // already approve a reply, so withholding it protects nothing and costs
      // the operator the only diagnosis the page can give them.
      send(res, 500, page('Error', `<p class="mut">${escapeHtml(reason)}</p>`));
    });
  });
}

async function route(
  deps: ConsoleDeps,
  css: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://console.invalid');
  const path = url.pathname;

  if (req.method === 'GET' && path === CSS_PATH) {
    send(res, 200, css, 'text/css');
    return;
  }
  if (req.method === 'GET' && path === '/') {
    send(res, 200, page('Runs', renderRuns(await deps.listRuns())));
    return;
  }
  if (req.method === 'GET' && path.startsWith('/run/')) {
    let runId: string;
    try {
      runId = decodeURIComponent(path.slice('/run/'.length));
    } catch {
      // A malformed percent-escape is a path nobody has, not a fault of ours.
      send(res, 404, page('Run', '<p class="mut">No such run.</p>'));
      return;
    }
    // Checked before it reaches the ledger. `run_id` is a `uuid` column, so
    // an id of another shape makes Postgres raise rather than match nothing:
    // `/run/abc` answered 500 where this route promises 404, and spent a pool
    // connection to do it.
    if (!isRunId(runId)) {
      send(res, 404, page('Run', '<p class="mut">No such run.</p>'));
      return;
    }
    const run = await deps.readRun(runId);
    if (run === null) {
      send(res, 404, page('Run', '<p class="mut">No such run.</p>'));
      return;
    }
    send(res, 200, page('Run detail', renderRunDetail(run)));
    return;
  }
  if (req.method === 'GET' && path === '/approvals') {
    // The outcome of the approval just posted. Without it an operator sees a
    // reloaded queue and cannot tell an approval that landed from one that
    // did not — `draft_missing` and every other refusal read as success.
    const outcome = url.searchParams.get('outcome');
    send(res, 200, page(
      'Approval queue',
      (outcome === null ? '' : renderOutcome(outcome))
        + renderApprovals(await deps.listApprovals()),
    ));
    return;
  }
  if (req.method === 'GET' && path === '/bands') {
    send(res, 200, page('Control bands', renderBands(await deps.readBands())));
    return;
  }
  if (req.method === 'GET' && path === '/latency') {
    send(res, 200, page('Partition latency', renderLatency(await deps.readLatency())));
    return;
  }
  if (req.method === 'POST' && path === '/approve') {
    const form = await readForm(req);
    const runId = form.get('runId') ?? '';
    // The run id is the whole request. Any other field is ignored, because
    // the relay sends the parked draft verbatim and a body posted here would
    // be recorded as the approved reply without ever reaching the customer.
    const outcome = await deps.approve(runId);
    // See other, so a refresh cannot post the approval twice.
    res.writeHead(303, {
      ...SAFETY_HEADERS,
      location: `/approvals?outcome=${encodeURIComponent(outcome)}`,
    });
    res.end();
    return;
  }
  send(res, 404, page('Not found', '<p class="mut">No such page.</p>'));
}
