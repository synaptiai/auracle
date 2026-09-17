// The console's HTTP layer (issue #27).
//
// `node:http` and nothing else, following `src/ingress/webhook-server.ts`,
// which carries the same note: stdlib only, no framework. The console adds no
// runtime dependency to this repository, which is what lets DEC-11's boundary
// be stated as a package boundary rather than as a convention.
//
// Reads go through the query modules the jobs use — `readDays`, `readLatency`,
// `listRuns`, `listEscalations`, `readRunJournal`. The one write goes through
// `approveFromConsole`, which hands off to `approveRun`. This module issues no
// statement itself, and `select-only.test.ts` holds that.
//
// It ships one script, and no more. The state filter is a set of links and the
// theme toggle is a cookie set on a redirect, because a console that can send
// a customer reply is a poor place to widen the attack surface for the sake of
// two controls that work without one.
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

import { isRunId } from './approve.js';
import { escapeHtml } from './render.js';
import { CONSOLE_SCRIPT } from './script.js';
import {
  caseHref,
  narrowToRule,
  page,
  renderApprovals,
  renderBands,
  renderCase,
  renderDesignNotes,
  renderLatency,
  renderConversation,
  renderDocument,
  renderRunDetail,
  renderOutcome,
  renderRuns,
} from './surfaces.js';
import type { ConsoleApproveOutcome } from './approve.js';
import type {
  BandRow, CustomerRead, DocumentPage, LatencyRow, QueueTodayRead, QueueTodayView,
  RunDetail, RunRow, RunView, Shell,
  ThreadView, Theme,
} from './surfaces.js';
import { describeFault } from 'auracle/cli';
// The approval's own bound on a claimed name, so the rail names exactly who
// the ledger would record.
import { approverFrom, UNATTRIBUTED } from 'auracle/domain';
// A host, an origin and a claimed approver all arrive from the request, and
// JSON leaves several line breaks raw.
import { logLine } from 'auracle/format';

/**
 * Everything the console reads or writes, injected.
 *
 * The server takes functions rather than a pool, so a test drives every
 * surface without a database and the module cannot reach the ledger by any
 * route its caller did not hand it.
 */
export interface ConsoleDeps {
  /**
   * The runs page, restricted to `states`.
   *
   * The filter is a parameter rather than a client-side hide, because the
   * page is capped: hiding rows after the cap would show an operator the
   * gated runs that happen to fall inside the newest 200, and call it the
   * gated runs.
   */
  readonly listRuns: (states: readonly string[]) => Promise<RunRow[]>;
  readonly readRun: (runId: string) => Promise<RunView | null>;
  readonly listApprovals: () => Promise<RunDetail[]>;
  /**
   * Today's arrivals and how many reached the queue, for the UTC day.
   *
   * Two counts from the ledger, stated in the queue header. The console
   * derives no share from them (issue #101).
   */
  readonly readQueueToday: () => Promise<QueueTodayView>;
  readonly readBands: () => Promise<BandRow[]>;
  readonly readLatency: () => Promise<LatencyRow[]>;
  readonly readConversation: (conversationId: string) => Promise<ThreadView | null>;
  readonly readDocument: (docId: string) => Promise<DocumentPage | null>;
  /**
   * The approval, with the approver a trusted proxy named (DEC-42).
   *
   * A claim rather than an authentication, and the caller decides whether one
   * was supplied: `approveRun` bounds what it keeps and records
   * `unattributed` for anything else.
   */
  readonly approve: (runId: string, approvedBy: string | undefined) => Promise<ConsoleApproveOutcome['outcome']>;
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
 *
 * `style-src 'self' 'unsafe-inline'` and `script-src 'none'`. The surfaces
 * carry inline `style` attributes, which the design's colour-by-verdict needs
 * and which no directive can distinguish from an injected one — so the
 * stylesheet keeps its inline allowance and scripts get a hash instead.
 *
 * A hash rather than `'unsafe-inline'`, which would permit every inline
 * script including an injected one. This permits the one script this console
 * ships and refuses the rest, and it stops permitting that one the moment its
 * text changes without the hash changing with it.
 */
/**
 * The CSP source expression for the one inline script.
 *
 * Computed from the script rather than written down, because a hash written
 * down is a hash that drifts. The digest is over the script's exact text, as
 * the browser computes it over the element's contents.
 */
const SCRIPT_HASH = `sha256-${createHash('sha256').update(CONSOLE_SCRIPT, 'utf8').digest('base64')}`;

const SAFETY_HEADERS = {
  'content-security-policy':
    "frame-ancestors 'none'; default-src 'none'; style-src 'self' 'unsafe-inline'; "
    // The one script this console ships, pinned by the hash of its exact
    // text. Not `unsafe-inline`: that would permit any inline script,
    // including one injected into a page. A hash permits this text and
    // nothing else, and it stops permitting it the moment a character
    // changes — so an edit that forgets to rebuild fails loudly rather than
    // shipping unpinned.
    + `img-src 'self'; form-action 'self'; base-uri 'none'; script-src '${SCRIPT_HASH}'`,
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
} as const;

/**
 * A request value as a log field: its first 64 characters, and its length.
 * Both count characters, never UTF-16 units, so a value that is whole reads as
 * whole.
 *
 * The form takes 64 KiB and a header up to Node's limit, and anyone who reaches
 * the port may send either. The log says what arrived without copying it.
 */
const LOGGED_PREFIX = 64;
function logged(value: string): string {
  return Array.from(value).slice(0, LOGGED_PREFIX).join('');
}
function loggedLength(value: string): number {
  return Array.from(value).length;
}

function send(res: ServerResponse, status: number, body: string, type = 'text/html'): void {
  res.writeHead(status, { ...SAFETY_HEADERS, 'content-type': `${type}; charset=utf-8` });
  res.end(body);
}

/**
 * A page with no rail.
 *
 * Used for every refusal: a `Host` this console does not serve, a form past its
 * bound, and a run id of another shape. The rail names the ledger this console
 * is bound to and the reviewer, and a refused request is exactly the one that
 * should not be told.
 */
function bare(
  title: string,
  says: string,
  theme: Theme,
  link?: { readonly href: string; readonly text: string },
): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)} — Auracle console</title>`,
    '<link rel="stylesheet" href="/console.css">',
    `</head><body><div class="root" data-theme="${theme}"><div class="wrap">`,
    `<div class="hdt">${escapeHtml(title)}</div>`,
    `<p class="mut">${escapeHtml(says)}</p>`,
    link === undefined ? '' : `<p><a href="${escapeHtml(link.href)}">${escapeHtml(link.text)}</a></p>`,
    '</div></div></body></html>',
  ].join('');
}

/** The form post body, which is the only input this console takes. */
/**
 * A form larger than the bound.
 *
 * Its own type, because the route answers it and the catch-all does not. It
 * used to be a plain error, so an oversized body reached the 500 page: the
 * request was refused rather than failed, and the two say different things
 * to whoever sent it.
 */
class OversizedForm extends Error {
  constructor() {
    super('the approval form is larger than 64 KiB');
    this.name = 'OversizedForm';
  }
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    // A bound, because an operator console on an internal network is still a
    // socket anyone on it can post to.
    if (size > 64 * 1024) throw new OversizedForm();
    chunks.push(buf);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

const THEMES: readonly Theme[] = ['dark', 'light'];
const THEME_COOKIE = 'theme';
/** A year. The operator sets this once and it is not a session preference. */
const THEME_MAX_AGE = 31_536_000;

/**
 * The theme the operator chose, or the default.
 *
 * Parsed rather than pattern-matched. A cookie header holds several pairs and
 * a value may be quoted, so a substring test for `light` would also match a
 * cookie named `highlight` that some proxy set on the same host.
 */
export function readTheme(cookieHeader: string | undefined): Theme {
  for (const pair of (cookieHeader ?? '').split(';')) {
    const at = pair.indexOf('=');
    if (at === -1) continue;
    if (pair.slice(0, at).trim() !== THEME_COOKIE) continue;
    const value = pair.slice(at + 1).trim().replace(/^"|"$/g, '');
    if ((THEMES as readonly string[]).includes(value)) return value as Theme;
  }
  // Dark is the console's own default, and an unreadable cookie is not a
  // reason to answer differently than a first visit does.
  return 'dark';
}

/**
 * Where the theme toggle may return to.
 *
 * An allowlist, because the target arrives in a query parameter. Without it
 * `/theme?to=dark&back=https://elsewhere.example` is an open redirect on a
 * host an operator trusts, and the redirect would carry them off a console
 * that approves customer replies.
 */
function safeReturn(back: string | null, surfaces: readonly string[]): string {
  if (back === null) return '/';
  if (surfaces.includes(back)) return back;
  // The queue and a case may carry the rule a person chose. Only that one
  // parameter survives, re-encoded, so nothing else in the value returns.
  const query = back.indexOf('?');
  if (query !== -1) {
    const rule = new URLSearchParams(back.slice(query + 1)).get('rule');
    const at = back.slice(0, query);
    if (at === '/') return rule === null ? '/' : `/?rule=${encodeURIComponent(rule)}`;
    if (at.startsWith('/case/')) {
      const id = decodeRunPath(at.slice('/case/'.length));
      return id !== null && isRunId(id) ? caseHref(id, rule) : '/';
    }
    return '/';
  }
  // Four paths are not fixed strings. Each is rebuilt from a value this
  // console has checked, so the redirect target is never the caller's text.
  for (const prefix of ['/run/', '/case/', '/conversation/'] as const) {
    if (back.startsWith(prefix)) {
      const id = decodeRunPath(back.slice(prefix.length));
      if (id !== null && isRunId(id)) return `${prefix}${encodeURIComponent(id)}`;
    }
  }
  if (back.startsWith('/document/')) {
    const docId = decodeRunPath(back.slice('/document/'.length));
    // A document id has no shape this console can check, so it is bounded and
    // re-encoded rather than trusted.
    if (docId !== null && docId.length > 0 && docId.length <= 200) {
      return `/document/${encodeURIComponent(docId)}`;
    }
  }
  return '/';
}

/**
 * The approver a trusted proxy named, or undefined (DEC-42).
 *
 * One condition: the operator named the header. A console cannot guess which
 * of its request headers a proxy controls, and naming one is the operator's
 * statement that a proxy in front sets it and strips any copy a client sent.
 * `identityHeader()` in `hosts.ts` says why the hosts no longer decide this.
 *
 * Undefined rather than a fallback string. `approverFrom` decides what an
 * unnamed approver records, and it has two callers: the approval records its
 * answer, and the rail names the same answer. A third place deciding would
 * eventually disagree with both.
 */
function claimedApprover(req: IncomingMessage, options: ConsoleOptions): string | undefined {
  const header = options.identityHeader;
  if (header === undefined) return undefined;
  // A repeated header is two claims, and this console cannot say which one
  // the proxy meant — so it names nobody rather than guessing. A proxy that
  // sets this header once and does not strip an inbound copy produces exactly
  // that, which is the forgeable audit trail DEC-42 refuses.
  //
  // Read from `headersDistinct`, which keeps every line. `headers` joins a
  // repeated `x-forwarded-user` with a comma, but for some names, such as
  // `From` and `Authorization`, it keeps the first value and drops the rest
  // without a sign. The operator may name any header.
  const values = req.headersDistinct[header.toLowerCase()];
  if (values === undefined || values.length !== 1) return undefined;
  const claimed = values[0]!;
  // A comma cannot appear in a principal this console will keep, because it
  // cannot tell one name containing a comma from two names a proxy folded
  // into one line.
  if (claimed === '' || claimed.includes(',')) return undefined;
  return headerText(claimed);
}

/**
 * A header value as the text its sender meant.
 *
 * Node reads header bytes as Latin-1, one character per byte. A proxy that
 * sends a name as UTF-8 then arrives as `NystrÃ¶m`, and that is what the
 * ledger would record. So bytes that decode as UTF-8 are read as UTF-8.
 *
 * Bytes that do not decode stay as Node read them, because they are Latin-1
 * text. A lone byte from 0xF5 to 0xFF, for example, never occurs in UTF-8.
 * Plain ASCII reads the same either way. A comma never appears inside a
 * UTF-8 sequence, so the check above sees every one.
 *
 * One trade-off remains. A Latin-1 name whose bytes also form valid UTF-8
 * reads as UTF-8: the Latin-1 pair 0xC3 0xA9 records as one letter. Such a
 * name needs a byte from 0xC2 to 0xF4 followed by one from 0x80 to 0xBF,
 * which Latin-1 names rarely hold.
 */
function headerText(value: string): string {
  const bytes = Buffer.from(value, 'latin1');
  if (bytes.every((byte) => byte < 0x80)) return value;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return value;
  }
}

/** A percent-escape that does not decode is a path nobody has, not a fault. */
function decodeRunPath(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

export interface ConsoleOptions {
  /**
   * The header a trusted proxy sets to name the approver (DEC-42).
   *
   * Undefined unless `CONSOLE_IDENTITY_HEADER` names it. Naming it is the
   * operator's statement that a trusted proxy sets this header and strips any
   * copy a client sent. The hosts do not decide this; `identityHeader()` in
   * `hosts.ts` says why.
   */
  readonly identityHeader?: string;
  /**
   * The `Host` values this console answers to. Every other one is refused,
   * which is what closes DNS rebinding.
   */
  readonly allowedHosts: readonly string[];
  /**
   * Every state a run may sit in, which is also the filter's vocabulary.
   *
   * Passed in rather than imported, so this module keeps its property of
   * reaching nothing: the closed set lives in `src/escalations/query.ts` and
   * the entry point hands it over.
   */
  readonly states: readonly string[];
  /** Which ledger this console is bound to, for the rail. No credentials. */
  readonly ledger: string;
  /**
   * The adapter an approval reads the draft back through, or null when the
   * console reads none (section 4.10). A case says which.
   */
  readonly readBack: string | null;
}

export function createConsole(
  deps: ConsoleDeps,
  css: string,
  options: ConsoleOptions,
): Server {
  const allowed = new Set(options.allowedHosts.map((h) => h.toLowerCase()));
  return createServer((req, res) => {
    const theme = readTheme(req.headers.cookie);
    if (!sameOrigin(req, allowed)) {
      // Named, because the commonest cause is a proxy whose name nobody put
      // in `CONSOLE_ALLOWED_HOSTS`. Without the refused `Host` on record the
      // console looks healthy and answers nothing, which is the one failure
      // an operator cannot diagnose from the page.
      console.error(logLine({
        event: 'console_refused',
        reason: 'not_same_origin',
        method: req.method ?? null,
        host: req.headers.host ?? null,
        secFetchSite: req.headers['sec-fetch-site'] ?? null,
        origin: req.headers.origin ?? null,
      }));
      send(res, 403, bare('Refused', 'This request did not come from the console.', theme));
      return;
    }
    void route(deps, css, options, theme, req, res).catch((error: unknown) => {
      const reason = describeFault(error);
      // A tag rather than the text. An earlier version put the message on the
      // page, arguing that anyone who can read a fault can already approve a
      // reply. That answers whether an operator may see it and not whether a
      // customer's words may reach an unauthenticated surface, which is the
      // question every other read on this console is held to: the journal
      // reader withholds the draft, the payload and the fault message, and an
      // escalation reason is trimmed at its first colon. This path had no
      // such trimming, and `error.message` is an open vocabulary — a driver
      // fault or an adapter's rejection carries whatever it was handed.
      //
      // So the operator gets a tag and the log gets the text. They read the
      // log already; the refused-request line above is written for them.
      const tag = randomUUID().slice(0, 8);
      console.error(logLine({ event: 'console_error', tag, error: reason }));
      send(
        res,
        500,
        bare('Error', `Something failed while answering this page. The console log names it ${tag}.`, theme),
      );
    });
  });
}

/**
 * The reviewer the rail names: the approver this request would record, or
 * null when it would record nobody (DEC-42).
 *
 * Read through the approval's own bound rather than restated, so the rail can
 * never show a name the ledger would store as `unattributed`.
 */
function reviewerFor(req: IncomingMessage, options: ConsoleOptions): string | null {
  const recorded = approverFrom(claimedApprover(req, options));
  return recorded === UNATTRIBUTED ? null : recorded;
}

/** The shell for a surface, given what this request knows. */
function shellFor(
  options: ConsoleOptions,
  theme: Theme,
  path: string,
  approvals: number | null,
  reviewer: string | null,
): Shell {
  return { theme, path, approvals, ledger: options.ledger, reviewer };
}

async function route(
  deps: ConsoleDeps,
  css: string,
  options: ConsoleOptions,
  theme: Theme,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let url;
  try {
    url = new URL(req.url ?? '/', 'http://console.invalid');
  } catch {
    // Node refuses most malformed targets before the handler. One that gets
    // here is a bad request, and answering 500 would report the console as
    // broken by a request it correctly declined to understand.
    send(res, 400, bare('Refused', 'That address is not one this console can read.', theme));
    return;
  }
  const path = url.pathname;
  // HEAD is a read like GET, and `sameOrigin` already treats it as one. Node
  // drops the body of a HEAD answer, so every read route serves both. The
  // theme route stays GET alone, because it writes a cookie.
  const reads = req.method === 'GET' || req.method === 'HEAD';
  const surfaces = ['/', '/runs', '/bands', '/latency', '/notes'];
  const reviewer = reviewerFor(req, options);
  const shell = (at: string, approvals: number | null = null): Shell =>
    shellFor(options, theme, at, approvals, reviewer);

  if (reads && path === CSS_PATH) {
    send(res, 200, css, 'text/css');
    return;
  }

  if (req.method === 'GET' && path === '/theme') {
    const to = url.searchParams.get('to');
    if (to === null || !(THEMES as readonly string[]).includes(to)) {
      send(res, 404, page('Not found', nothingFound(), shell(path)));
      return;
    }
    // `SameSite=Strict` and `HttpOnly`: nothing on this console reads the
    // cookie from its one script, and a cross-site navigation has no business
    // changing what the operator sees.
    //
    // Not `Secure`. The console cannot know its own scheme — the runbook puts
    // it behind a proxy that terminates the TLS — and a `Secure` cookie on a
    // plain-http loopback console is one the browser silently drops, which
    // would leave the toggle looking broken rather than looking off.
    res.writeHead(303, {
      ...SAFETY_HEADERS,
      'set-cookie':
        `${THEME_COOKIE}=${to}; Path=/; Max-Age=${THEME_MAX_AGE}; SameSite=Strict; HttpOnly`,
      location: safeReturn(url.searchParams.get('back'), surfaces),
    });
    res.end();
    return;
  }

  // Where the runs list and the queue lived before the queue became the
  // landing page. A bookmark or a pasted link still reaches the page it meant,
  // with its query intact, rather than a different surface under its old path.
  if (reads && path === '/' && url.searchParams.has('state')) {
    res.writeHead(303, { ...SAFETY_HEADERS, location: `/runs${url.search}` });
    res.end();
    return;
  }
  // The old queue's link to one run named it in the query string. It now
  // names that run's case, in one hop rather than through the queue.
  if (reads && path === '/approvals') {
    res.writeHead(303, { ...SAFETY_HEADERS, location: queueRedirect(url.searchParams) ?? `/${url.search}` });
    res.end();
    return;
  }

  if (reads && path === '/runs') {
    const wanted = url.searchParams.get('state');
    // A state outside the ledger's own vocabulary is a page nobody has. It
    // is not silently widened to every state: that would answer a question
    // the operator did not ask, under a heading saying they did.
    if (wanted !== null && !options.states.includes(wanted)) {
      send(res, 404, page('Not found', nothingFound(), shell('/runs')));
      return;
    }
    const states = wanted === null ? options.states : [wanted];
    const runs = await deps.listRuns(states);
    send(res, 200, page('Runs', renderRuns({
      runs,
      filter: { states: options.states, active: wanted },
      limit: RUNS_PAGE,
    }), shell('/runs')));
    return;
  }

  if (reads && path.startsWith('/run/')) {
    const runId = decodeRunPath(path.slice('/run/'.length));
    // Checked before it reaches the ledger. `run_id` is a `uuid` column, so
    // an id of another shape makes Postgres raise rather than match nothing:
    // `/run/abc` answered 500 where this route promises 404, and spent a pool
    // connection to do it.
    if (runId === null || !isRunId(runId)) {
      send(res, 404, page('Run', nothingFound(), shell(path)));
      return;
    }
    const run = await deps.readRun(runId);
    if (run === null) {
      send(res, 404, page('Run', nothingFound(), shell(path)));
      return;
    }
    send(res, 200, page('Run detail', renderRunDetail(run), shell(`/run/${runId}`)));
    return;
  }

  if (reads && path === '/') {
    // A link that named a run on the queue, from before each case had a page
    // of its own. It opens that case. A value that is not a run id is never
    // rebuilt into a path, and the queue draws as if none were named.
    const toCase = queueRedirect(url.searchParams);
    if (toCase !== null) {
      res.writeHead(303, { ...SAFETY_HEADERS, location: toCase });
      res.end();
      return;
    }
    const waiting = await deps.listApprovals();
    // Which gate rule the queue is narrowed to. Compared against what is
    // actually waiting rather than validated against a list: a value nothing
    // carries narrows to an empty queue, which is what it asked for and says
    // so, and it never reaches a statement in any case.
    const rule = url.searchParams.get('rule');
    // The counts are a header over the work, so a fault reading them does not
    // take the queue away. It is logged under a tag the page names, the way
    // a page fault is, and the text stays in the log.
    let today: QueueTodayRead;
    try {
      today = { counts: await deps.readQueueToday() };
    } catch (error) {
      const tag = randomUUID().slice(0, 8);
      console.error(logLine({ event: 'console_counts_unread', tag, error: describeFault(error) }));
      today = { unreadTag: tag };
    }
    send(res, 200, page(
      'Needs a person',
      renderApprovals(waiting, rule, today),
      // Everything waiting, never the narrowed view. A rail badge that fell
      // because a filter was on would report a queue that had emptied.
      // The theme returns with the rule only when something waiting carries
      // it. A rule the query string invented is never written back out.
      {
        ...shell('/', waiting.length),
        back: rule === null || narrowToRule(waiting, rule).length === 0 ? '/' : `/?rule=${encodeURIComponent(rule)}`,
      },
    ));
    return;
  }

  if (reads && path.startsWith('/case/')) {
    const runId = decodeRunPath(path.slice('/case/'.length));
    // Shape first, as the run route does: `run_id` is a `uuid` column, and an
    // id of another shape would make Postgres raise rather than match nothing.
    const outcome = url.searchParams.get('outcome') ?? '';
    const rule = url.searchParams.get('rule');
    if (runId === null || !isRunId(runId)) {
      send(res, 404, page('Case', nothingFound(), shell(NOT_A_SURFACE)));
      return;
    }
    // Any state, not only a waiting one. The approval comes back here with
    // its outcome, and by then the run has left the queue.
    let run;
    try {
      run = await deps.readRun(runId);
    } catch (error) {
      // The approval redirects here, and the catch-all would answer that
      // something failed, with no word on the approval. With no
      // state to check the outcome against, the page shows none. It says the
      // approval's answer is on the log line the approval wrote.
      const tag = randomUUID().slice(0, 8);
      console.error(logLine({ event: 'console_case_unread', tag, runId, error: describeFault(error) }));
      send(res, 500, bare(
        'Error',
        `The run was not read. The console log names the fault ${tag}. An approval posted just before`
          + ' this is recorded on its console_approved or console_approve_failed log line.',
        theme,
      ));
      return;
    }
    if (run === null) {
      // An approval of a run the ledger does not hold lands here, and its
      // answer is still the ledger's to give.
      send(res, 404, page(
        'Case',
        (outcome === '' ? '' : renderOutcome(outcome, null)) + nothingFound(),
        shell(NOT_A_SURFACE),
      ));
      return;
    }
    const conversationId = run.request?.conversationId ?? run.conversationId;
    let customer: CustomerRead;
    if (conversationId === null) {
      customer = { kind: 'none' };
    } else {
      // A fault reading the customer does not take the case away. The
      // approval lands here, and a 500 would hide whether it committed.
      try {
        const thread = await deps.readConversation(conversationId);
        customer = thread === null ? { kind: 'missing' } : { kind: 'thread', thread };
      } catch (error) {
        const tag = randomUUID().slice(0, 8);
        console.error(logLine({ event: 'console_customer_unread', tag, runId, error: describeFault(error) }));
        customer = { kind: 'unread', tag };
      }
    }
    send(res, 200, page(
      `Case ${run.ticketId}`,
      renderCase({ ...run, customer }, { outcome, rule, readBack: options.readBack }),
      { ...shell(`/case/${runId}`), back: caseHref(runId, rule) },
    ));
    return;
  }

  if (reads && path.startsWith('/conversation/')) {
    const id = decodeRunPath(path.slice('/conversation/'.length));
    // Shape first, as the run route does: the column is uuid, and a driver
    // exception is not an answer a surface can render.
    if (id === null || !isRunId(id)) {
      send(res, 404, page('Conversation', nothingFound(), shell(path)));
      return;
    }
    const thread = await deps.readConversation(id);
    if (thread === null) {
      send(res, 404, page('Conversation', nothingFound(), shell(path)));
      return;
    }
    send(res, 200, page(
      'Conversation',
      renderConversation(thread),
      shell(`/conversation/${id}`),
    ));
    return;
  }

  if (reads && path.startsWith('/document/')) {
    const docId = decodeRunPath(path.slice('/document/'.length));
    // No shape check: a document id is whatever the adopter's corpus uses,
    // and the query parameterises it. The length bound is this route's own,
    // because a path is not a place to accept an unbounded string.
    if (docId === null || docId.length === 0 || docId.length > 200) {
      send(res, 404, page('Evidence base', nothingFound(), shell(path)));
      return;
    }
    const doc = await deps.readDocument(docId);
    if (doc === null) {
      // A run journals the ids it retrieved, and a document can leave the
      // index afterwards. So this is the document being gone, not the run
      // having been wrong, and the page says which.
      send(res, 404, page('Evidence base', nothingFound(), shell(path)));
      return;
    }
    // Encoded, as the theme toggle rebuilds it. A corpus id can carry a `?` or
    // a `%`, and a raw one turned the way back into the queue.
    send(res, 200, page('Evidence base', renderDocument(doc), shell(`/document/${encodeURIComponent(docId)}`)));
    return;
  }

  if (reads && path === '/bands') {
    send(res, 200, page('Control bands', renderBands(await deps.readBands()), shell('/bands')));
    return;
  }

  if (reads && path === '/latency') {
    send(res, 200, page(
      'Partition latency',
      renderLatency(await deps.readLatency()),
      shell('/latency'),
    ));
    return;
  }

  if (reads && path === '/notes') {
    send(res, 200, page('Design notes', renderDesignNotes(), shell('/notes')));
    return;
  }

  if (req.method === 'POST' && path === '/approve') {
    // Read before the body, and used by every line this route logs. A client
    // that hangs up destroys its socket, and a later read of the address may
    // find nothing.
    const from = req.socket.remoteAddress ?? null;
    let form;
    try {
      form = await readForm(req);
    } catch (error) {
      // Checked first: leaving the read loop past the bound destroys the stream
      // too, and that is a refusal of the sender, not a hang-up.
      if (!(error instanceof OversizedForm)) {
        if (req.destroyed || req.readableAborted) {
          // The client hung up mid-body. Nobody is left to answer, and it is not
          // a console fault, so it is named and not sent to the fault handler.
          console.error(logLine({
            event: 'console_refused',
            reason: 'client_aborted',
            host: req.headers.host ?? null,
            from,
          }));
          return;
        }
        throw error;
      }
      // Refused, not failed. The stream is destroyed rather than drained,
      // because reading the rest of a body already past the bound is work
      // done on behalf of whoever sent it.
      req.destroy();
      send(res, 413, bare('Refused', 'The approval form is larger than this console accepts.', theme));
      return;
    }
    const runId = (form.get('runId') ?? '').trim();
    // A run id of another shape is a request this console declines, not a
    // fault, so it never reaches the approval. `approveFromConsole` would throw
    // on it, and the page would blame the ledger for a request that never got
    // there. The GET routes answer the same input with a refusal too.
    if (!isRunId(runId)) {
      console.error(logLine({
        event: 'console_refused',
        reason: 'not_a_run_id',
        runId: logged(runId),
        runIdLength: loggedLength(runId),
        host: req.headers.host ?? null,
        from,
      }));
      send(res, 400, bare('Refused', 'That is not a run id, so nothing was approved.', theme));
      return;
    }
    // The run id is the whole request. Any other field is ignored, because
    // the relay sends the parked draft verbatim and a body posted here would
    // be recorded as the approved reply without ever reaching the customer.
    // DEC-42: who approved, when a trusted proxy named them.
    //
    // Read only when the operator named the header a trusted proxy sets.
    // Anyone reaching the port can set a header, so with no header named this
    // sends nothing and the approval records `unattributed` — a forgeable
    // audit trail is worse than none.
    const claimed = claimedApprover(req, options);
    let outcome;
    try {
      outcome = await deps.approve(runId, claimed);
    } catch (error) {
      // The one request that writes. A fault here can come after the
      // transaction committed, so the page does not say the console was only
      // reading. It sends the operator to the case, whose state answers it.
      const tag = randomUUID().slice(0, 8);
      // The line an incident reader needs, because the approved line below is
      // never written: which run, who was claimed, and where it came from.
      console.error(logLine({
        event: 'console_approve_failed',
        tag,
        runId,
        claimedBy: claimed === undefined ? null : logged(claimed),
        claimedLength: claimed === undefined ? null : loggedLength(claimed),
        host: req.headers.host ?? null,
        from,
        error: describeFault(error),
      }));
      send(res, 500, bare(
        'Error',
        `Something failed during the approval, and it may or may not have committed. The console log names it ${tag}.`,
        theme,
        { href: caseHref(runId, url.searchParams.get('rule')), text: 'Open the case to see its state.' },
      ));
      return;
    }
    // The one write this console makes, and until now the only request it did
    // not record. The ledger journals that a run was approved; it does not
    // journal which client asked, and this console authenticates nobody, so
    // reaching it is the whole access control. Without this line an incident
    // has no console-side evidence separating the operator from anyone else
    // who could reach the port.
    console.error(logLine({
      event: 'console_approved',
      runId,
      outcome,
      // What was claimed, and what the ledger records. They differ when the
      // approval would not keep the claim, and an incident reader must not
      // see a name the ledger never held.
      claimedBy: claimed === undefined ? null : logged(claimed),
      claimedLength: claimed === undefined ? null : loggedLength(claimed),
      approvedBy: outcome === 'approved' ? approverFrom(claimed) : null,
      host: req.headers.host ?? null,
      from,
    }));
    // See other, so a refresh cannot post the approval twice. It lands on the
    // case it approved, where the outcome is read beside the reply it concerns.
    //
    // The filter comes back with it. An operator working one gate rule lost
    // the filter on every approval and had to reapply it, which on a queue of
    // several hundred is the work the filter exists to save.
    // Off the URL, never off the form. The comment above says every field but
    // the run id is ignored, and that stance is what stops a body posted here
    // from being recorded as an approved reply — so the filter travels on the
    // action's query string instead of becoming a second field.
    const keptRule = url.searchParams.get('rule');
    res.writeHead(303, {
      ...SAFETY_HEADERS,
      location: `/case/${encodeURIComponent(runId)}?outcome=${encodeURIComponent(outcome)}`
        + (keptRule === null || keptRule === '' ? '' : `&rule=${encodeURIComponent(keptRule)}`),
    });
    res.end();
    return;
  }

  // A path no rail link names. A method this console does not serve on a
  // surface's own path, such as a POST to `/`, is not that surface, and the
  // rail must not mark it as the page being read.
  send(res, 404, page('Not found', nothingFound(), shell(NOT_A_SURFACE)));
}

/**
 * Where a queue link naming a run now goes, or null when it names none.
 *
 * The id is checked for shape and rebuilt, so the redirect target is never
 * the caller's text. The chosen rule rides along for the way back.
 */
function queueRedirect(params: URLSearchParams): string | null {
  const run = params.get('run');
  if (run === null || !isRunId(run)) return null;
  return caseHref(run, params.get('rule'));
}

/**
 * The rail path of a page that is no surface. The theme toggle's return
 * refuses it and falls back to `/`, as it does any path it does not know.
 */
const NOT_A_SURFACE = '/not-found';

/**
 * The cap the runs statement applies.
 *
 * Named here as well as in the entry point, because the footer says the list
 * is a page rather than the ledger, and that sentence is only true if the two
 * agree.
 */
export const RUNS_PAGE = 200;

function nothingFound(): string {
  return '<div class="wrap"><p class="mut">No such page.</p></div>';
}
