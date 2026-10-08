// The console's HTTP layer (issue #27).
//
// `node:http` and nothing else, following `src/ingress/webhook-server.ts`,
// which carries the same note: stdlib only, no framework. The console adds no
// runtime dependency to this repository, which is what lets DEC-11's boundary
// be stated as a package boundary rather than as a convention.
//
// Reads go through the query modules the jobs use — `readDays`, `readLatency`,
// `listRuns`, `listEscalations`, `readRunJournal`. The writes go through
// `approveFromConsole`, which hands off to `approveRun`, and the case holds
// (DEC-46). This module issues no statement itself, and
// `select-only.test.ts` holds that.
//
// It ships one script, and no more. The state filter is a set of links and the
// theme toggle is a cookie set on a redirect, because a console that can send
// a customer reply is a poor place to widen the attack surface for the sake of
// two controls that work without one.
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

import { CUSTOMER_REPLY_ACTION_CLASS } from 'auracle/domain';

import { isRunId } from './approve.js';
import { closestDocumentSentence, withSentenceReplaced, withoutSentence } from './reply-edit.js';
import { escapeHtml, isolated, parksAnAction } from './render.js';
import { CONSOLE_SCRIPT } from './script.js';
import {
  caseHref,
  filtersQuery,
  narrowToProduct,
  narrowToRule,
  typedText,
  queueHref,
  page,
  renderApprovals,
  renderBands,
  renderCase,
  renderDesignNotes,
  renderLatency,
  renderConversation,
  renderDocument,
  renderKnowledge,
  renderRouting,
  renderTeam,
  renderRunDetail,
  renderConfirm,
  renderConfirmResult,
  renderOutcome,
  renderPublishRefused,
  renderRuns,
  renderCloseOutcome,
  renderRewriteOutcome,
  renderSendBackOutcome,
  renderSnoozeOutcome,
  renderUndoResult,
  replyTextOf,
} from './surfaces.js';
import type { ConsoleApproveOutcome, ConsoleSaveOutcome } from './approve.js';
import { confirmBatch, isFault, undoBatch, MAX_BATCH } from './confirm.js';
import { QUEUE_SORTS, groupQueue, workOrder } from './queue.js';
import type { QueueSort } from './queue.js';
import type { BatchOutcome } from './confirm.js';
import type { ConfirmCase, OutcomeRun } from './surfaces.js';
import type {
  BandRow, CaseGapRead, CaseHoldRead, CaseRerunsRead, CaseSendHoldRead, ComposerFields, CopyRead,
  CustomerRead, DocumentPage,
  KnowledgeRead, LatencyRow, RoutingRead, TeamRead,
  QueueHold, QueueHoldsRead, QueueTodayRead, QueueTodayView,
  RunDetail, RunRow, RunView, Shell,
  ThreadView, Theme,
} from './surfaces.js';
import { describeFault } from 'auracle/cli';
// A host, an origin and a reviewer identity all arrive from the request, and
// JSON leaves several line breaks raw.
import { logLine } from 'auracle/format';
import type { ReviewerFor } from './reviewer.js';
import { copyHoldsText, replyDigest } from 'auracle/ledger-read';
import type {
  ApprovalHold, CaseGap, CaseRerun, CloseOutcome, HandoverOutcome, Hold, KnowledgeReport, PublishOutcome,
  ReleaseOutcome, RoutingReport, TeamReport,
  RewriteOutcome,
  SendBackOutcome, SnoozeOutcome, TakeOutcome,
  UndoOutcome,
} from 'auracle/ledger-read';

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
   * DEC-50: the knowledge screen's figures, over the gap window before now.
   *
   * One read, so the cards and the lists describe one snapshot of the ledger.
   */
  readonly readKnowledge: () => Promise<KnowledgeReport>;
  /**
   * DEC-50: whether a gap blocks the case this run belongs to, read by the
   * definition the knowledge screen counts with. Null when no run of the case
   * reached a person with a draft or an abstention.
   */
  readonly readCaseGap: (runId: string) => Promise<CaseGap | null>;
  /**
   * Issue #112: the team screen's figures, from one snapshot of the ledger.
   * Time on support is the hold history DEC-46 records.
   */
  readonly readTeam: () => Promise<TeamReport>;
  /**
   * Issue #112: what each product may do without a person, from the gate
   * record the gate step keeps for each product and intent, for the
   * taxonomy's intents.
   */
  readonly readRouting: () => Promise<RoutingReport>;
  /** DEC-46: how long a take holds a case, so the routing screen can say it. */
  readonly holdLapseMs: number;
  /**
   * DEC-50: the documents published from this run, each with what became of
   * the new attempt it asked for, read by the verdict the consumer acts on.
   */
  readonly readCaseReruns: (runId: string) => Promise<readonly CaseRerun[]>;
  /**
   * DEC-50: a document a reviewer writes from a case. The core owns every
   * rule: the products, the identifier check, the review date, the DEC-46
   * guard, and the re-run it asks for. This hands it the form and draws the
   * answer, so a refusal comes back with its reason.
   */
  readonly publish: (
    runId: string,
    reviewer: string,
    fields: ComposerFields,
    shown: string,
  ) => Promise<PublishOutcome>;
  /**
   * The approval, with the reviewer this request resolved to (DEC-45), the
   * digest of the reply the page drew (DEC-46), and the reviewer's decision
   * about a helpdesk copy a person edited (DEC-44).
   *
   * The identity has already passed the roster, so it is never undefined
   * here: the gate refuses a request before this call when no reviewer
   * stands behind it. `approveRun` bounds what it keeps all the same.
   *
   * The acknowledgement is absent on every approval that is not choosing
   * between two texts, which is nearly all of them.
   */
  readonly approve: (
    runId: string,
    approvedBy: string,
    shown: string,
    copyAcknowledged?: string,
  ) => Promise<ConsoleApproveOutcome['outcome']>;
  /**
   * DEC-44: the reviewer's text, saved as the reply this case holds.
   *
   * The console's second write. `shown` is the digest of the reply the page
   * drew, exactly as the approval's is, and the save is refused when the
   * ledger's reply has moved since: the guard is DEC-46's, applied one step
   * earlier.
   */
  /**
   * DEC-51: the way back inside a hold. The core owns the transaction, the
   * row lock and the window; this route reads a form and draws the answer.
   */
  readonly undo: (runId: string, reviewer: string) => Promise<UndoOutcome>;
  /**
   * DEC-51: whether an approval's send is still held, and for how long. The
   * pages count the window that is left rather than the period that was set.
   */
  readonly readApprovalHold: (runId: string) => Promise<ApprovalHold | null>;
  readonly saveReply: (
    runId: string,
    text: string,
    shown: string,
    reviewer: string,
  ) => Promise<ConsoleSaveOutcome['outcome']>;
  /**
   * DEC-48: the case a reviewer finishes with no reply.
   *
   * The console's fourth write, and the only one that ends a case without
   * sending anything. The reason, its bound, the DEC-46 guard and the journal
   * row are the core's; this hands it the form and draws the answer.
   */
  readonly close: (
    runId: string,
    reviewer: string,
    reason: string,
    shown: string,
  ) => Promise<CloseOutcome['outcome']>;
  /**
   * DEC-48: the case a reviewer puts aside for a period.
   *
   * The console's fifth write. The period's bounds, the DEC-46 guard and the
   * journal row are the core's; this hands it the form and draws the answer.
   */
  readonly snooze: (
    runId: string,
    reviewer: string,
    periodMs: number,
    shown: string,
  ) => Promise<SnoozeOutcome['outcome']>;
  /**
   * DEC-48: the reply a reviewer writes from scratch, in place of the draft.
   *
   * The console's sixth write. The guard, the turn it writes on and the
   * journal row are the core's; this hands it the field and draws the answer.
   */
  readonly rewrite: (
    runId: string,
    reviewer: string,
    text: string,
    shown: string,
  ) => Promise<RewriteOutcome['outcome']>;
  /**
   * DEC-49: the case a reviewer sends back for a new attempt.
   *
   * The console's seventh write, and the only one that starts no run itself:
   * it ends the rejected one and records the note, and the consumer that owns
   * the conversation's partition starts the next attempt on its scan. The
   * conditions, the bound and the journal row are the core's; this hands it
   * the form and draws the answer.
   */
  readonly sendBack: (
    runId: string,
    reviewer: string,
    note: string,
    shown: string,
  ) => Promise<SendBackOutcome['outcome']>;
  /**
   * The copy the helpdesk holds for one parked draft (DEC-44), read when an
   * approval refused because a person edited it. Null when there is nothing
   * to read, which the page says in words.
   */
  readonly readCopy: (draftExternalId: string) => Promise<string | null>;
  /**
   * The document one cited claim rests on, read for the callout's first
   * button (DEC-44). Null when the ledger holds no such document.
   */
  readonly readDocumentBody: (docId: string) => Promise<string | null>;
  /**
   * The reviewer behind this request, or the reason there is none (DEC-45).
   *
   * Resolved before any page is built, reads included. A throw is a fault in
   * the roster read, and the request is refused exactly like one that named
   * nobody: the console serves nothing it cannot attribute.
   */
  readonly reviewerFor: ReviewerFor;
  /** The live hold on a case, or null (DEC-46). Read before the page. */
  readonly readHold: (runId: string) => Promise<Hold | null>;
  /**
   * DEC-47: the products the named reviewer covers, for the queue's order.
   *
   * One statement, read once per queue page. Empty means no declared focus,
   * which orders the queue as it always was. A throw is a fault in the
   * roster read: the queue draws and says which log line names it.
   */
  readonly readReviewerProducts: (reviewer: string) => Promise<readonly string[]>;
  /**
   * DEC-47: the label each product is shown by, from the catalogue the
   * process read at startup. A plain map, not a read: the file is read once,
   * and nothing here touches the ledger.
   */
  readonly productLabels: ReadonlyMap<string, string>;
  /**
   * The live holds on a list of cases, in one statement (DEC-46).
   *
   * The queue is uncapped, so a read per row is one statement behind every
   * row. A case whose hold lapsed is simply not in the map.
   */
  readonly readHolds: (runIds: readonly string[]) => Promise<Map<string, Hold>>;
  /**
   * Takes a case for this request's reviewer, or takes it over from the
   * reviewer who holds it. `over` is the confirmation the page asks for.
   */
  readonly takeHold: (
    runId: string,
    reviewer: string,
    over: boolean,
  ) => Promise<TakeOutcome>;
  /** Lets go of a case this reviewer holds. */
  readonly releaseHold: (
    runId: string,
    reviewer: string,
  ) => Promise<ReleaseOutcome>;
  /** Moves a case this reviewer holds to the teammate it names (DEC-46). */
  readonly handoverHold: (
    runId: string,
    reviewer: string,
    to: string,
  ) => Promise<HandoverOutcome>;
}

const CSS_PATH = '/console.css';

/**
 * The shape of the reply digest the approval form carries (DEC-46).
 *
 * A SHA-256 in hex, and nothing else. A value of another shape is a request
 * this console did not render, refused before the approval reads it — so a
 * long or strange string never reaches a comparison, and never reaches the
 * log whole either.
 */
const SHOWN_DIGEST = /^[0-9a-f]{64}$/;

/**
 * The longest document body the callout scans for the sentence it quotes.
 *
 * The id is the run's own, so no request chooses which document is read. The
 * bound is here because this read happens inside a request: a corpus is
 * adopter-written, and a body this console would not quote a sentence from is
 * not one worth splitting into sentences on the way to a page.
 */
const MAX_CITED_DOCUMENT_CHARS = 200_000;

/**
 * The queue filters a URL carries (DEC-47).
 *
 * Read as they arrive and compared against what is waiting, never validated
 * against a list: a value nothing carries narrows to an empty queue, which
 * is what it asked for. Neither value reaches a statement.
 */
function queueFilters(url: URL): { rule: string | null; product: string | null } {
  return {
    rule: url.searchParams.get('rule'),
    product: url.searchParams.get('product'),
  };
}

/**
 * Where the theme toggle returns: the queue with only the filters that still
 * narrow something (DEC-47).
 *
 * A filter that matched nothing when the page was drawn must not be written
 * back into a link, or a reviewer returns to an empty queue they did not
 * choose. Both filters are kept independently, so clearing one does not
 * clear the other.
 */
function queueBack(
  waiting: readonly RunDetail[],
  filters: { rule: string | null; product: string | null },
): string {
  const keepRule = filters.rule !== null && narrowToRule(waiting, filters.rule).length > 0;
  const keepProduct = filters.product !== null
    && narrowToProduct(waiting, filters.product).length > 0;
  return queueHref(keepRule ? filters.rule : null, keepProduct ? filters.product : null);
}

/**
 * The cases a reviewer could start, in the order their queue draws them
 * (issue #154).
 *
 * The queue page's own reads, narrowed by the same filters and ordered by the
 * same sort, so "Take next case" and a case's position agree with the list
 * the reviewer was reading. The holds and the products it reads may fail as
 * the queue's may. Without the holds no case is set aside as somebody's, and
 * the take itself still refuses one that is held. Without the products the
 * order is the ledger's own.
 *
 * `own` names the cases this reviewer holds, which take next passes over.
 */
async function readWorkOrder(
  deps: ConsoleDeps,
  reviewer: string,
  filters: { rule: string | null; product: string | null },
  sort: QueueSort,
): Promise<{
  order: RunDetail[];
  own: ReadonlySet<string>;
  /** How many cases the filters showed, held or not. */
  shown: number;
  /** How many of those this reviewer holds. */
  ownShown: number;
  holdsUnread: string | null;
  productsUnread: string | null;
}> {
  const waiting = await deps.listApprovals();
  let holds = new Map<string, Hold>();
  let holdsUnread: string | null = null;
  try {
    holds = await deps.readHolds(waiting.map((run) => run.runId));
  } catch (error) {
    holdsUnread = randomUUID().slice(0, 8);
    console.error(logLine({ event: 'console_holds_unread', tag: holdsUnread, error: describeFault(error) }));
  }
  let mine: readonly string[] = [];
  let productsUnread: string | null = null;
  try {
    mine = await deps.readReviewerProducts(reviewer);
  } catch (error) {
    productsUnread = randomUUID().slice(0, 8);
    console.error(logLine({ event: 'console_products_unread', tag: productsUnread, error: describeFault(error) }));
  }
  const covered = new Set(mine);
  const shown = narrowToProduct(narrowToRule(waiting, filters.rule), filters.product);
  const sections = groupQueue(
    shown,
    (run) => { const hold = holds.get(run.runId); return hold !== undefined && hold.reviewer !== reviewer; },
    (run) => run.product !== null && covered.has(run.product),
    sort,
  );
  const own = new Set([...holds].filter(([, hold]) => hold.reviewer === reviewer).map(([runId]) => runId));
  return {
    order: workOrder(sections),
    own,
    shown: shown.length,
    ownShown: shown.filter((run) => own.has(run.runId)).length,
    holdsUnread,
    productsUnread,
  };
}

/**
 * How many free cases take next tries before it says none was free.
 *
 * A bound, so a queue whose every case a teammate takes between the read and
 * the press costs a bounded number of transactions. Each refusal is a case
 * somebody took a moment ago, so a press that loses this many races in a row
 * is told the truth: nothing it tried was free.
 */
const TAKE_NEXT_TRIES = 10;

/**
 * How long the queue waits for the knowledge badge (issue #154).
 *
 * The badge is a count beside the work, and the queue is the work. So the
 * count is read alongside the queue's own reads, and a count that has not
 * come by then is left out rather than holding the page back.
 */
const BADGE_WAIT_MS = 500;

/** The gap count, or null when it failed or did not come within the wait. */
function gapCountWithin(deps: ConsoleDeps, ms: number): Promise<number | null> {
  const tag = randomUUID().slice(0, 8);
  const counted = deps.readKnowledge().then(
    (report) => report.gaps.length,
    (error: unknown) => {
      console.error(logLine({ event: 'console_gaps_unread', tag, error: describeFault(error) }));
      return null;
    },
  );
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      console.error(logLine({ event: 'console_gaps_late', tag, waitedMs: ms }));
      resolve(null);
    }, ms);
  });
  return Promise.race([counted, late]).finally(() => clearTimeout(timer));
}

/**
 * What a request that named no reviewer is told, by both refusals.
 *
 * One sentence rather than two. A page that distinguished a roster that could
 * not be read from a request that named nobody would tell an unauthenticated
 * caller whether this ledger answered, from a console that otherwise names
 * neither its ledger nor its reviewer to anyone it refuses. The log carries
 * the distinction; the operator reads the log.
 */
const NO_REVIEWER = 'This console serves nothing without an active reviewer identity.';

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
    `<div class="hdt">${isolated(title)}</div>`,
    `<p class="mut">${isolated(says)}</p>`,
    link === undefined ? '' : `<p><a href="${escapeHtml(link.href)}">${escapeHtml(link.text)}</a></p>`,
    '</div></div></body></html>',
  ].join('');
}

/**
 * The queue a reviewer came from, as the refusals' own link back to it.
 *
 * The filters ride on it (DEC-47), as they do on every other way back: a
 * reviewer who narrowed the queue and posted a batch it refused returns to
 * the queue they were reading, not to the whole of it.
 */
function backToQueue(url: URL): { readonly href: string; readonly text: string } {
  return {
    href: queueHref(url.searchParams.get('rule'), url.searchParams.get('product')),
    text: 'Open the queue to pick the cases again.',
  };
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
/**
 * The form on a write route, or the refusal that route answers with.
 *
 * Null means the response is already sent: a client that hung up mid-body, or
 * a body past the bound. The three batch routes share this, and each names
 * its own form in the refusal.
 */
async function formOrRefusal(
  req: IncomingMessage,
  res: ServerResponse,
  theme: Theme,
  what: string,
  /**
   * Where a reader goes next. A refusal is a page like any other, and one
   * that names no way on leaves a reviewer at a dead end with a form they
   * cannot resend: the browser's own back button returns to a form whose
   * POST they have already made.
   */
  link: { readonly href: string; readonly text: string },
): Promise<URLSearchParams | null> {
  const from = req.socket.remoteAddress ?? null;
  try {
    return await readForm(req);
  } catch (error) {
    if (!(error instanceof OversizedForm)) {
      if (req.destroyed || req.readableAborted) {
        console.error(logLine({
          event: 'console_refused',
          reason: 'client_aborted',
          host: req.headers.host ?? null,
          from,
        }));
        return null;
      }
      throw error;
    }
    // Refused, not failed. The stream is destroyed rather than drained,
    // because reading the rest of a body past the bound is work done for
    // whoever sent it.
    req.destroy();
    send(res, 413, bare(
      'Refused',
      // Not "nothing was sent": this route reads a form before it knows
      // which act it was for, and an undo page that said "sent" would state
      // the opposite of what it was asked to do.
      `The ${what} form is larger than this console accepts. Nothing was changed.`,
      theme,
      link,
    ));
    return null;
  }
}

/**
 * The cases a confirmation names, each with the reply the approval would send
 * (DEC-51).
 *
 * A refusal is a reason code and a sentence, so the route draws what this
 * console knows rather than what a request said. A case whose reply the page
 * cannot read is left out of the batch rather than guessed at: a row nothing
 * can show is a row nobody read.
 */
async function confirmCases(
  deps: ConsoleDeps,
  picked: readonly string[],
  options: ConsoleOptions,
  url: URL,
): Promise<{
  refusal: string | null;
  says: string;
  cases: ConfirmCase[];
  /** The picked cases the batch left out, each with the reason it says. */
  dropped: { runId: string; says: string }[];
  /** How many were left out because they could not be read at all. */
  unread: number;
}> {
  if (picked.length === 0) {
    return {
      refusal: 'no_cases',
      says: 'That request names no case, so nothing was sent. Go back to the queue and pick one.',
      cases: [],
      dropped: [],
      unread: 0,
    };
  }
  if (picked.length > MAX_BATCH) {
    return {
      refusal: 'too_many_cases',
      says: `This console confirms at most ${MAX_BATCH} cases at once, and that request names`
        + ` ${picked.length}. Nothing was sent. Confirm them in smaller groups.`,
      cases: [],
      dropped: [],
      unread: 0,
    };
  }
  if (!picked.every(isRunId)) {
    return {
      refusal: 'not_a_run_id',
      says: 'One of those cases is not a run id, so nothing was sent.'
        + ' Go back to the queue and pick the cases again.',
      cases: [],
      dropped: [],
      unread: 0,
    };
  }
  const cases: ConfirmCase[] = [];
  const dropped: { runId: string; says: string }[] = [];
  let unread = 0;
  for (const runId of picked) {
    try {
      const run = await deps.readRun(runId);
      if (run === null) {
        dropped.push({ runId, says: 'the ledger does not hold this case, so it is not in the batch.' });
        continue;
      }
      // #123: the batch holds each reply so a mistake can be undone (DEC-51).
      // An internal write parks no reply and takes no hold (DEC-34), so it is
      // approved on its own case page, where the page names the action.
      if (run.draftExternalId === null) {
        dropped.push({
          runId,
          // What the check tests, and no more: a case with no draft may be an
          // internal write, a reply the gate stopped, or a park naming neither.
          // A case with no draft may offer no approval at all, so the words
          // send the reviewer to read it, not to approve it.
          says: 'this case holds no helpdesk draft, so it is not in the batch. Open its case page'
            + ' to see what it holds.',
        });
        continue;
      }
      const text = replyTextOf(run, options.ledgerReply);
      if (text === null) {
        dropped.push({
          runId,
          says: 'this case holds no reply this console can send, so it is not in the batch.',
        });
        continue;
      }
      cases.push({ runId, ticketId: run.ticketId, shown: replyDigest(text), text });
    } catch (error) {
      // The queue's own rule: one case that cannot be read does not take the
      // batch away. The case is named on the page, and the log line under its
      // run id holds the fault.
      unread += 1;
      const tag = randomUUID().slice(0, 8);
      console.error(logLine({
        event: 'console_confirm_unread', tag, runId,
        host: logged(url.host), error: describeFault(error),
      }));
      dropped.push({
        runId,
        says: 'this case could not be read, so it is not in the batch.'
          + ' The console log holds the fault under this run id.',
      });
    }
  }
  if (cases.length === 0) {
    // A fault is not a fact about the case. Every case that failed to read is
    // a fault, and saying it holds no reply would state something this
    // console did not establish.
    return {
      refusal: 'no_cases',
      says: unread === picked.length
        ? 'None of those cases could be read, so nothing was sent.'
          + ' The console log holds the faults; open the queue and try again.'
        : 'None of those cases holds a reply this console can send, so nothing was sent.'
          + ' Open the queue and pick a case that does.',
      cases: [],
      dropped,
      unread,
    };
  }
  return { refusal: null, says: '', cases, dropped, unread };
}

/**
 * What a batch's approved cases still hold, as this page may draw it (DEC-51).
 *
 * The shortest window, because one undo button answers for every case in the
 * batch: the window it may promise is the one that closes first.
 *
 * `unread` is the log tag of a hold read that failed, and it is its own
 * answer rather than a zero. Zero is a fact — no case is held — and it draws
 * "there is nothing to undo". A read that failed established nothing, so a
 * page that drew that sentence would be stating what it did not read, and
 * withholding the undo from the one case whose window it could not see.
 */
async function remainingHolds(
  deps: ConsoleDeps,
  outcomes: readonly BatchOutcome<ConsoleApproveOutcome['outcome']>[],
): Promise<{ remainingMs: number | null; holdUnread: string | null; delivered: number }> {
  let shortest: number | null = null;
  let holdUnread: string | null = null;
  let delivered = 0;
  for (const one of outcomes) {
    if (isFault(one) || one.outcome !== 'approved') continue;
    try {
      const hold = await deps.readApprovalHold(one.runId);
      if (hold?.status === 'sent') delivered += 1;
      if (hold === null || !hold.held) continue;
      shortest = shortest === null ? hold.remainingMs : Math.min(shortest, hold.remainingMs);
    } catch (error) {
      if (holdUnread === null) holdUnread = randomUUID().slice(0, 8);
      console.error(logLine({
        event: 'console_sendhold_unread', tag: holdUnread, runId: one.runId,
        error: describeFault(error),
      }));
    }
  }
  return { remainingMs: shortest, holdUnread, delivered };
}

/**
 * Each run as an outcome's fit check reads it (DEC-51).
 *
 * A batch's refusal sentence names the run's state, so the page has to read
 * it. A fault reading one is that run's absence from the map: its sentence
 * falls back to the fixed wording rather than claiming a state nobody read.
 */
async function outcomeRuns(
  deps: ConsoleDeps,
  runIds: readonly string[],
): Promise<{ runs: Map<string, OutcomeRun>; unread: ReadonlySet<string> }> {
  const runs = new Map<string, OutcomeRun>();
  const unread = new Set<string>();
  for (const runId of runIds) {
    try {
      const run = await deps.readRun(runId);
      if (run === null) continue;
      runs.set(runId, {
        state: run.state,
        approved: run.approved,
        savedReply: run.request?.savedReplyText != null,
        // The batch draws no outcome banner, and this read decides whether a
        // case may be confirmed: no rewrite claim rests on it.
        ledgerReply: false,
        replyRewritten: run.replyRewritten,
        // The batch draws no outcome banner either, and these two are read
        // only by one. They are read off the run rather than defaulted, so a
        // future banner cannot draw a claim nothing checked.
        sentBack: run.sentBackAt !== null,
        parkedDraft: run.draftExternalId !== null,
        parkedAction: parksAnAction(run.payloadRecorded === true, run.actionClass ?? null, run.draftExternalId ?? null),
        hasTurn: run.request !== null,
        attemptRejected: run.attemptRejected,
        turnClosed: run.turnClosed,
      });
    } catch (error) {
      // Named as unread rather than left out: an outcome drawn against no run
      // fails its fit check and reads as an outcome this console does not
      // know, which is a different fact from a case it could not read.
      unread.add(runId);
      const tag = randomUUID().slice(0, 8);
      console.error(logLine({
        event: 'console_outcome_run_unread', tag, runId, error: describeFault(error),
      }));
    }
  }
  return { runs, unread };
}

class OversizedForm extends Error {
  constructor() {
    super('the approval form is larger than 64 KiB');
    this.name = 'OversizedForm';
  }
}

/** The bound on a posted form, which every route but the approval keeps. */
const FORM_LIMIT = 64 * 1024;

/**
 * The approval's bound (issue #154). Where the editor is drawn, the send posts
 * the editor's text, and an untouched parked draft may be longer than a save
 * allows: non-ASCII text grows about nine times when a form encodes it. Still
 * a bound, for the reason `readForm` gives.
 */
const APPROVE_FORM_LIMIT = 1024 * 1024;

async function readForm(req: IncomingMessage, limit = FORM_LIMIT): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    // A bound, because an operator console on an internal network is still a
    // socket anyone on it can post to.
    if (size > limit) throw new OversizedForm();
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
  const value = cookieOf(cookieHeader, THEME_COOKIE, THEMES);
  // Dark is the console's own default, and an unreadable cookie is not a
  // reason to answer differently than a first visit does.
  return value ?? 'dark';
}

/** The value of one cookie, when it is one of the values allowed, or null. */
function cookieOf<T extends string>(
  cookieHeader: string | undefined,
  name: string,
  allowed: readonly T[],
): T | null {
  for (const pair of (cookieHeader ?? '').split(';')) {
    const at = pair.indexOf('=');
    if (at === -1) continue;
    if (pair.slice(0, at).trim() !== name) continue;
    const value = pair.slice(at + 1).trim().replace(/^"|"$/g, '');
    if ((allowed as readonly string[]).includes(value)) return value as T;
  }
  return null;
}

const SORT_COOKIE = 'sort';

/**
 * The queue order the reviewer chose (issue #154), or the queue's own.
 *
 * A preference, kept as the theme is: a cookie a GET sets on its way back. So
 * a take, a filter and the theme toggle keep it, and no link has to carry it.
 * A value this console does not offer reads as the default and is never
 * written back.
 */
export function readSort(cookieHeader: string | undefined): QueueSort {
  return cookieOf(cookieHeader, SORT_COOKIE, QUEUE_SORTS) ?? 'risk';
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
    // DEC-47: the product rides with the rule, and both are re-encoded from
    // the values this console read rather than from the caller's text.
    const params = new URLSearchParams(back.slice(query + 1));
    const rule = params.get('rule');
    const product = params.get('product');
    const at = back.slice(0, query);
    if (at === '/') return queueHref(rule, product);
    if (at.startsWith('/case/')) {
      const id = decodeRunPath(at.slice('/case/'.length));
      return id !== null && isRunId(id) ? caseHref(id, rule, product) : '/';
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
  /**
   * DEC-44: whether that adapter declares that its helpdesk cannot send the
   * copy it parks, so the ledger holds the reply.
   *
   * Read from the adapter's own declaration at startup, never from the
   * environment again: the console draws the editor where the approval will
   * send the ledger's text, and the two must answer about the same adapter.
   */
  readonly ledgerReply: boolean;
  /**
   * DEC-51: the milliseconds a batch's sends are held before the relay may
   * post them. Zero is allowed and means the send goes at once.
   *
   * Passed in rather than read here, for the reason `states` is: this module
   * reaches nothing, and the entry point reads the environment once.
   */
  readonly sendHoldMs: number;
}

export function createConsole(
  deps: ConsoleDeps,
  css: string,
  options: ConsoleOptions,
): Server {
  const allowed = new Set(options.allowedHosts.map((h) => h.toLowerCase()));
  return createServer(async (req, res) => {
    const theme = readTheme(req.headers.cookie);
    if (!sameOrigin(req, allowed)) {
      // Named, because the commonest cause is a proxy whose name nobody put
      // in `CONSOLE_ALLOWED_HOSTS`. Without the refused `Host` on record the
      // console looks healthy and answers nothing, which is the one failure
      // an operator cannot diagnose from the page.
      // Bounded like every other request value this console logs. Each of
      // these three arrives from a request that passed no allowlist, so its
      // only bound would be Node's header-size limit — and a refusal is
      // exactly the line an attacker can make this console write, as often
      // as they like. `method` needs no bound: the parser refuses a token it
      // does not know, so the value is one of a handful of words.
      const host = req.headers.host ?? '';
      const origin = req.headers.origin ?? '';
      const site = req.headers['sec-fetch-site'] ?? '';
      console.error(logLine({
        event: 'console_refused',
        reason: 'not_same_origin',
        method: req.method ?? null,
        host: logged(host),
        hostLength: loggedLength(host),
        secFetchSite: logged(site),
        secFetchSiteLength: loggedLength(site),
        origin: logged(origin),
        originLength: loggedLength(origin),
      }));
      send(res, 403, bare('Refused', 'This request did not come from the console.', theme));
      return;
    }
    // DEC-45: no page without an active reviewer identity, reads included.
    // The check runs here, before `route` sees the request, so no surface can
    // render a row before the console knows who is asking. It is a property
    // of the request rather than of what the request asks for, so the
    // stylesheet goes through it as well. A refusal page draws unstyled.
    let verdict;
    try {
      verdict = await deps.reviewerFor(req);
    } catch (error) {
      // A roster read that failed is not permission to serve. The log names
      // the fault so an operator can tell a broken ledger from a stranger.
      console.error(logLine({
        event: 'console_refused',
        reason: 'reviewer_unread',
        method: req.method ?? null,
        host: req.headers.host ?? null,
        error: describeFault(error),
      }));
      send(res, 403, bare('Refused', NO_REVIEWER, theme));
      return;
    }
    if ('refusal' in verdict) {
      // Five conditions collapse into this one refusal, and the log says
      // which it was, because each has a different fix: nothing arrived
      // (check the proxy), a value arrived twice (the proxy appends), one
      // line folded two names (the proxy joins them), the rules refuse the
      // value (check what it sends), or the roster does not hold it
      // (`pnpm run reviewers -- --add`). The page says only that nobody may
      // read it.
      console.error(logLine({
        event: 'console_refused',
        reason: 'no_reviewer',
        detail: verdict.refusal.detail,
        header: verdict.refusal.header,
        claim: logged(verdict.refusal.said),
        claimLength: loggedLength(verdict.refusal.said),
        lines: verdict.refusal.lines,
        method: req.method ?? null,
        host: req.headers.host ?? null,
      }));
      send(res, 403, bare('Refused', NO_REVIEWER, theme));
      return;
    }
    const reviewer = verdict.reviewer;
    void route(deps, css, options, theme, req, res, reviewer).catch((error: unknown) => {
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

/** The shell for a surface, given what this request knows. */
function shellFor(
  options: ConsoleOptions,
  theme: Theme,
  path: string,
  approvals: number | null,
  reviewer: string,
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
  reviewer: string,
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
  const surfaces = ['/', '/runs', '/knowledge', '/team', '/routing', '/bands', '/latency', '/notes'];
  const shell = (at: string, approvals: number | null = null): Shell =>
    shellFor(options, theme, at, approvals, reviewer);

  if (reads && path === CSS_PATH) {
    send(res, 200, css, 'text/css');
    return;
  }

  // Issue #154: the queue's sort, set the way the theme is. GET alone, because
  // it writes a cookie, and the return is the queue it came from, rebuilt by
  // the theme's own allowlist.
  if (req.method === 'GET' && path === '/sort') {
    const to = url.searchParams.get('to');
    if (to === null || !(QUEUE_SORTS as readonly string[]).includes(to)) {
      send(res, 404, page('Not found', nothingFound(), shell(path)));
      return;
    }
    res.writeHead(303, {
      ...SAFETY_HEADERS,
      'set-cookie':
        `${SORT_COOKIE}=${to}; Path=/; Max-Age=${THEME_MAX_AGE}; SameSite=Strict; HttpOnly`,
      location: safeReturn(url.searchParams.get('back'), surfaces),
    });
    res.end();
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
    // Issue #154: started once the queue is read, so a page that failed starts
    // no count, and it runs alongside the queue's other reads. The read is
    // the knowledge screen's, which pages share while it runs.
    const gapsRead = gapCountWithin(deps, BADGE_WAIT_MS);
    // DEC-46: who holds what, for the whole page in one read. A fault does
    // not take the queue away — the queue is the work — so it draws without
    // the holders and says which log line names the fault.
    let holds: QueueHoldsRead;
    try {
      const live = await deps.readHolds(waiting.map((run) => run.runId));
      const byRun = new Map<string, QueueHold>();
      for (const [runId, hold] of live) {
        byRun.set(runId, { reviewer: hold.reviewer, takenAt: hold.takenAt });
      }
      holds = { reviewer, holds: byRun };
    } catch (error) {
      const tag = randomUUID().slice(0, 8);
      console.error(logLine({ event: 'console_holds_unread', tag, error: describeFault(error) }));
      holds = { unreadTag: tag };
    }
    // Which gate rule and which product the queue is narrowed to. Compared
    // against what is actually waiting rather than validated against a list:
    // a value nothing carries narrows to an empty queue, which is what it
    // asked for and says so, and it never reaches a statement in any case.
    // DEC-47: the product is read the same way, and both apply at once.
    const { rule, product } = queueFilters(url);
    // DEC-47: the products this request's reviewer covers, for the queue's
    // own order. A fault does not take the queue away — the queue is the
    // work — so it draws in the ledger's order and the page says so.
    let mine: readonly string[] = [];
    let mineUnread: string | null = null;
    try {
      mine = await deps.readReviewerProducts(reviewer);
    } catch (error) {
      const tag = randomUUID().slice(0, 8);
      console.error(logLine({ event: 'console_products_unread', tag, error: describeFault(error) }));
      mineUnread = tag;
    }
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
    // Issue #154: the rail's knowledge badge. A fault or a slow read draws
    // the rail without it, because the queue is the work and a count is not.
    const gaps = await gapsRead;
    send(res, 200, page(
      'Needs a person',
      renderApprovals(
        waiting,
        { rule, product, mine, labels: deps.productLabels, mineUnread, sort: readSort(req.headers.cookie),
          tookNothing: url.searchParams.get('taken') },
        today,
        holds,
      ),
      // Everything waiting, never the narrowed view. A rail badge that fell
      // because a filter was on would report a queue that had emptied.
      // The theme returns with the rule only when something waiting carries
      // it. A rule the query string invented is never written back out.
      {
        ...shell('/', waiting.length),
        gaps,
        // The theme returns with the filters only when something waiting
        // carries them. A value the query string invented is never written
        // back out.
        back: queueBack(waiting, { rule, product }),
      },
    ));
    return;
  }

  if (reads && path.startsWith('/case/')) {
    const runId = decodeRunPath(path.slice('/case/'.length));
    // Shape first, as the run route does: `run_id` is a `uuid` column, and an
    // id of another shape would make Postgres raise rather than match nothing.
    const outcome = url.searchParams.get('outcome') ?? '';
    // DEC-48: what the close route answered, drawn beside the case it closed.
    // Read here rather than beside the other outcome blocks, because the
    // branch below answers for a run this ledger does not hold.
    const closed = url.searchParams.get('closed') ?? '';
    // DEC-48: what the snooze route answered, drawn beside the case.
    const snoozed = url.searchParams.get('snoozed') ?? '';
    // DEC-48: what the rewrite route answered, drawn beside the case. Read
    // here for the reason the close's is: the branch below answers for a run
    // this ledger does not hold.
    const rewritten = url.searchParams.get('rewritten') ?? '';
    // DEC-49: what the send-back route answered, drawn beside the case. Read
    // here for the reason the close's is: the branch below answers for a run
    // this ledger does not hold.
    const sentBack = url.searchParams.get('sentback') ?? '';
    // Whether the page should draw the send-back field rather than its link.
    const sendingBack = url.searchParams.get('sendback') === '1';
    // Whether the page should draw the rewrite field rather than its link.
    const rewriting = url.searchParams.get('rewrite') === '1';
    const { rule, product } = queueFilters(url);
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
      // An approval or a close of a run the ledger does not hold lands here,
      // and its answer — `unknown_run` — is still the ledger's to give. Drawn
      // because it is checked against the run this page read, which is none.
      send(res, 404, page(
        'Case',
        (outcome === '' ? '' : renderOutcome(outcome, null))
          + (closed === '' ? '' : renderCloseOutcome(closed, null))
          + (snoozed === '' ? '' : renderSnoozeOutcome(snoozed, null))
          + (rewritten === '' ? '' : renderRewriteOutcome(rewritten, null))
          + (sentBack === '' ? '' : renderSendBackOutcome(sentBack, null))
          + nothingFound(),
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
    // DEC-46: who holds this case, read for the bar. A fault reading it does
    // not take the case away: the approval lands here, and the hold is
    // advisory. But the page must not draw a holder it did not read, so the
    // fault rides to the bar as its own answer, with the tag of the log line
    // that names it — the shape the customer read uses one block above.
    const taken = url.searchParams.get('taken') ?? '';
    const handoverTo = url.searchParams.get('to') ?? '';
    let hold: CaseHoldRead;
    try {
      const live = await deps.readHold(runId);
      hold = {
        kind: 'read',
        hold: live === null ? null : {
          reviewer: live.reviewer,
          mine: live.reviewer === reviewer,
          remainingMs: Math.max(0, live.lapsesAt.getTime() - Date.now()),
        },
      };
    } catch (error) {
      const tag = randomUUID().slice(0, 8);
      console.error(logLine({ event: 'console_hold_unread', tag, runId, error: describeFault(error) }));
      hold = { kind: 'unread', tag };
    }
    // DEC-51: the way back from a single approval, which holds its send the
    // same way the batch's does. Read only where a window can exist: a run
    // still waiting has none, and this page is drawn in every state. A fault
    // is its own answer, as the take hold's is — a page that read nothing
    // must not draw the case as one with no way back.
    let sendHold: CaseSendHoldRead = { kind: 'read', hold: null };
    if (options.ledgerReply && run.state !== 'awaiting_approval') {
      try {
        sendHold = { kind: 'read', hold: await deps.readApprovalHold(runId) };
      } catch (error) {
        const tag = randomUUID().slice(0, 8);
        console.error(logLine({
          event: 'console_sendhold_unread', tag, runId, error: describeFault(error),
        }));
        sendHold = { kind: 'unread', tag };
      }
    }
    // DEC-44: the helpdesk's copy is read only for the refusal that names it,
    // so an ordinary case reads nothing back. A fault here does not take the
    // case away: the refusal is still drawn, and the copy with a tag.
    const edit = url.searchParams.get('edit') ?? '';
    const why = url.searchParams.get('why') ?? '';
    const writing = url.searchParams.get('write') ?? '';
    let copy: CopyRead = { kind: 'none' };
    if (outcome === 'copy_changed' && run.draftExternalId !== null) {
      try {
        const held = await deps.readCopy(run.draftExternalId);
        // One rule with the approval's, so the page never offers a text the
        // save would refuse: a copy whose text is empty is nothing to choose.
        copy = !copyHoldsText(held)
          ? (held === null ? { kind: 'gone' } : { kind: 'empty' })
          : { kind: 'copy', text: held };
      } catch (error) {
        const tag = randomUUID().slice(0, 8);
        console.error(logLine({ event: 'console_copy_unread', tag, runId, error: describeFault(error) }));
        copy = { kind: 'unread', tag };
      }
    }
    // DEC-50: whether a gap blocks the case, as the knowledge screen counts
    // it. A fault here does not take the case away: the approval lands here.
    let gap: CaseGapRead;
    try {
      gap = { gap: await deps.readCaseGap(runId) };
    } catch (error) {
      const tag = randomUUID().slice(0, 8);
      console.error(logLine({ event: 'console_gap_unread', tag, runId, error: describeFault(error) }));
      gap = { unreadTag: tag };
    }
    // DEC-50: the documents published from this case, and what became of
    // each re-run. A fault does not take the case away, as the gap's does not.
    let reruns: CaseRerunsRead;
    try {
      reruns = { reruns: await deps.readCaseReruns(runId) };
    } catch (error) {
      const tag = randomUUID().slice(0, 8);
      console.error(logLine({ event: 'console_reruns_unread', tag, runId, error: describeFault(error) }));
      reruns = { unreadTag: tag };
    }
    // Issue #154: where this case sits in the queue it was opened from, with
    // that queue's filters and the reviewer's sort. A fault does not take the
    // case away: the page draws without a position.
    const caseSort = readSort(req.headers.cookie);
    let position: { at: number; of: number } | null = null;
    let productsUnreadHere = false;
    if (run.state === 'awaiting_approval') {
      try {
        const read = await readWorkOrder(deps, reviewer, { rule, product }, caseSort);
        // A position counted without the holds or the reviewer's products is
        // a place in another order than the queue draws, so none is drawn.
        productsUnreadHere = read.productsUnread !== null;
        const at = read.order.findIndex((candidate) => candidate.runId === runId);
        // Under oldest the products decide nothing, so only the holds count.
        position = at === -1 || read.holdsUnread !== null || (read.productsUnread !== null && caseSort !== 'oldest')
          ? null
          : { at: at + 1, of: read.order.length };
      } catch (error) {
        const tag = randomUUID().slice(0, 8);
        console.error(logLine({ event: 'console_position_unread', tag, runId, error: describeFault(error) }));
      }
    }
    // Issue #154: the outcome whose form is open in the case, if one is asked.
    const step = (['close', 'snooze', 'handover'] as const)
      .find((name) => url.searchParams.get(name) === '1') ?? null;
    send(res, 200, page(
      `Case ${run.ticketId}`,
      renderCase({ ...run, customer }, {
        position,
        step,
        // The note needs the page's own read to find the products unread, so
        // a link alone cannot make the page say it.
        orderUnread: url.searchParams.get('mine') === 'unread' && productsUnreadHere ? caseSort : null,
        gap,
        reruns,
        composing: url.searchParams.get('compose') === '1',
        published: url.searchParams.get('published') === '1',
        author: reviewer,
        productLabels: deps.productLabels,
        today: new Date().toISOString().slice(0, 10),
        outcome, edit, why, closed, snoozed, rule, product, readBack: options.readBack, hold,
        taken, handoverTo, ledgerReply: options.ledgerReply, writing, copy, sendHold,
        rewritten, rewriting, sentBack, sendingBack,
      }),
      { ...shell(`/case/${runId}`), back: caseHref(runId, rule, product) },
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
    // Issue #154: the case this thread was opened from, when it is a run that
    // answered a turn of it. Any other value names no case to go back to, and
    // is never written back out.
    const from = url.searchParams.get('from');
    const { rule, product } = queueFilters(url);
    // Read from the run itself: a turn names only its newest run, and an
    // older run of the same conversation is still a case to go back to.
    let back: string | null = null;
    if (from !== null && isRunId(from)) {
      try {
        const opened = await deps.readRun(from);
        const of = opened === null ? null : (opened.request?.conversationId ?? opened.conversationId);
        if (opened !== null && opened.runId === from && of === id) back = caseHref(from, rule, product);
      } catch (error) {
        console.error(logLine({ event: 'console_back_unread', tag: randomUUID().slice(0, 8), runId: from, error: describeFault(error) }));
      }
    }
    send(res, 200, page(
      'Conversation',
      renderConversation(thread, back),
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

  if (reads && path === '/knowledge') {
    // A fault reading the figures draws the page with each one named as not
    // read, and the tag of the log line that says why.
    let knowledge: KnowledgeRead;
    try {
      knowledge = { report: await deps.readKnowledge() };
    } catch (error) {
      const tag = randomUUID().slice(0, 8);
      console.error(logLine({ event: 'console_knowledge_unread', tag, error: describeFault(error) }));
      knowledge = { unreadTag: tag };
    }
    send(res, 200, page(
      'Knowledge base',
      renderKnowledge(knowledge, deps.productLabels),
      { ...shell('/knowledge'), gaps: 'report' in knowledge ? knowledge.report.gaps.length : null },
    ));
    return;
  }

  if (reads && path === '/team') {
    // As on the knowledge screen: a fault draws every figure named as not
    // read, with the tag of the log line that says why.
    let team: TeamRead;
    try {
      team = { report: await deps.readTeam() };
    } catch (error) {
      const tag = randomUUID().slice(0, 8);
      console.error(logLine({ event: 'console_team_unread', tag, error: describeFault(error) }));
      team = { unreadTag: tag };
    }
    send(res, 200, page('Team', renderTeam(team, deps.productLabels), shell('/team')));
    return;
  }

  if (reads && path === '/routing') {
    let routing: RoutingRead;
    try {
      routing = { report: await deps.readRouting() };
    } catch (error) {
      const tag = randomUUID().slice(0, 8);
      console.error(logLine({ event: 'console_routing_unread', tag, error: describeFault(error) }));
      routing = { unreadTag: tag };
    }
    // The tab: a product id, the empty value for the channels of no product,
    // or none for the first tab.
    const product = url.searchParams.get('product');
    send(res, 200, page(
      'Routing',
      renderRouting(routing, deps.productLabels, product === '' ? null : product ?? undefined, deps.holdLapseMs),
      shell('/routing'),
    ));
    return;
  }

  if (reads && path === '/notes') {
    send(res, 200, page('Design notes', renderDesignNotes(), shell('/notes')));
    return;
  }

  if (req.method === 'POST' && path === '/take') {
    const from = req.socket.remoteAddress ?? null;
    let form;
    try {
      form = await readForm(req);
    } catch (error) {
      if (!(error instanceof OversizedForm)) {
        if (req.destroyed || req.readableAborted) {
          console.error(logLine({
            event: 'console_refused', reason: 'client_aborted',
            host: req.headers.host ?? null, from,
          }));
          return;
        }
        throw error;
      }
      req.destroy();
      send(res, 413, bare(
        'Refused',
        'The form is larger than this console accepts. Nothing was changed.',
        theme,
        backToQueue(url),
      ));
      return;
    }
    // Issue #154: take next. The server picks the case, from the queue the
    // reviewer was reading, so the page never decides for a moment it no
    // longer describes. A form that names a case as well asks for two things,
    // and is refused rather than read as either.
    if (form.has('next')) {
      if (form.has('runId')) {
        send(res, 400, bare('Refused', 'A take names one case or asks for the next one, not both. Nothing was taken.', theme));
        return;
      }
      const filters = queueFilters(url);
      let read;
      try {
        read = await readWorkOrder(deps, reviewer, filters, readSort(req.headers.cookie));
      } catch (error) {
        const tag = randomUUID().slice(0, 8);
        console.error(logLine({ event: 'console_queue_unread', tag, error: describeFault(error) }));
        send(res, 503, bare(
          'Refused',
          `The queue was not read, so nothing was taken. The console log names the fault ${tag}.`,
          theme,
          backToQueue(url),
        ));
        return;
      }
      const { order, own, holdsUnread } = read;
      const sort = readSort(req.headers.cookie);
      // The order fell back to the ledger's own, and the case says so.
      const mineUnread = read.productsUnread !== null && sort !== 'oldest' ? '&mine=unread' : '';
      // Without the holds the console cannot tell a free case from a held
      // one, so it takes nothing rather than walk the queue on refusals.
      if (holdsUnread !== null) {
        send(res, 503, bare(
          'Refused',
          'The holds were not read, so the console cannot tell which case is free. Nothing was taken.'
            + ` The console log names the fault ${holdsUnread}.`,
          theme,
          backToQueue(url),
        ));
        return;
      }
      const kept = filtersQuery(filters.rule, filters.product);
      const candidates = order.filter((candidate) => !own.has(candidate.runId));
      for (const run of candidates.slice(0, TAKE_NEXT_TRIES)) {
        let outcome: string;
        try {
          // Never `over`: a case somebody holds is theirs, and take next moves
          // on to the next one rather than asking.
          outcome = (await deps.takeHold(run.runId, reviewer, false)).outcome;
        } catch (error) {
          const tag = randomUUID().slice(0, 8);
          console.error(logLine({
            event: 'console_take_failed', tag, runId: run.runId, action: 'next',
            reviewer: logged(reviewer), reviewerLength: loggedLength(reviewer),
            host: req.headers.host ?? null, from, error: describeFault(error),
          }));
          // The case page's own hedge: a fault can arrive after the take
          // committed and before this process read the answer.
          send(res, 500, bare(
            'Error',
            `The take may or may not have committed, and the console log names the fault ${tag}.`,
            theme,
            { href: caseHref(run.runId, filters.rule, filters.product), text: 'Open the case to see its state.' },
          ));
          return;
        }
        console.error(logLine({
          event: 'console_took', runId: run.runId, action: 'next', outcome,
          reviewer: logged(reviewer), reviewerLength: loggedLength(reviewer),
          host: req.headers.host ?? null, from,
        }));
        if (outcome === 'taken') {
          res.writeHead(303, {
            ...SAFETY_HEADERS,
            location: `/case/${encodeURIComponent(run.runId)}?taken=taken${mineUnread}${kept.replace(/^\?/, '&')}`,
          });
          res.end();
          return;
        }
      }
      // Nothing was taken, and the queue says why from what happened: no case
      // waits, every case left is the reviewer's own, every case tried was
      // somebody else's or had just left the queue, or the bound stopped the
      // walk with cases left untried.
      // `order` leaves out the cases a teammate holds, so the queue is empty
      // only when the filters showed nothing, and every case is yours only
      // when you hold each one shown.
      const said = read.shown === 0
        ? 'nothing_waiting'
        : read.ownShown === read.shown
          ? 'all_yours'
          : candidates.length > TAKE_NEXT_TRIES ? 'all_raced' : 'none_free';
      res.writeHead(303, {
        ...SAFETY_HEADERS,
        location: `/${kept}${kept === '' ? '?' : '&'}taken=${said}`,
      });
      res.end();
      return;
    }
    const runId = (form.get('runId') ?? '').trim();
    if (!isRunId(runId)) {
      console.error(logLine({
        event: 'console_refused', reason: 'not_a_run_id',
        runId: logged(runId), runIdLength: loggedLength(runId),
        host: req.headers.host ?? null, from,
      }));
      send(res, 400, bare('Refused', 'That is not a run id, so nothing was taken.', theme));
      return;
    }
    // One form, three actions, and the body decides which: release is the
    // holder letting go, over is the confirmation that moves somebody
    // else's hold, and neither is a take anyone makes by accident.
    const action = form.has('release')
      ? 'release'
      : form.has('handover')
        ? 'handover'
        : form.has('over')
          ? 'over'
          : 'take';
    const to = (form.get('to') ?? '').trim();
    let outcome: string;
    try {
      if (action === 'release') {
        outcome = (await deps.releaseHold(runId, reviewer)).outcome;
      } else if (action === 'handover') {
        outcome = (await deps.handoverHold(runId, reviewer, to)).outcome;
      } else {
        outcome = (await deps.takeHold(runId, reviewer, action === 'over')).outcome;
      }
    } catch (error) {
      const tag = randomUUID().slice(0, 8);
      console.error(logLine({
        event: 'console_take_failed',
        tag,
        runId,
        action,
        reviewer: logged(reviewer),
        reviewerLength: loggedLength(reviewer),
        host: req.headers.host ?? null,
        from,
        error: describeFault(error),
      }));
      // The same hedge the approval uses: a fault can arrive after the
      // transaction committed and before this process read the answer, so the
      // page does not claim the take did not happen.
      send(res, 500, bare(
        'Error',
        `The take may or may not have committed, and the console log names the fault ${tag}.`,
        theme,
        {
          href: caseHref(runId, url.searchParams.get('rule'), url.searchParams.get('product')),
          text: 'Open the case to see its state.',
        },
      ));
      return;
    }
    // The hold changes who the console says is working, so it is recorded:
    // the ledger keeps the hold and its history, and this line is the request
    // that asked for it.
    console.error(logLine({
      event: 'console_took',
      runId,
      action,
      outcome,
      reviewer: logged(reviewer),
      reviewerLength: loggedLength(reviewer),
      host: req.headers.host ?? null,
      from,
    }));
    // DEC-47: both filters come back with it. They travel on the form's own
    // action, so this reads them off the URL as the approval does.
    const kept = url.searchParams;
    // A refused handover carries the identity back, so the page can leave it
    // in the field: a person who typed a colleague's name should not have to
    // type it again to fix a typo. One that moved the case does not, because
    // the page it lands on has no field to fill.
    const keptTo = action === 'handover' && to !== '' && outcome !== 'handed_over'
      ? `&to=${encodeURIComponent(to)}`
      : '';
    res.writeHead(303, {
      ...SAFETY_HEADERS,
      location: `/case/${encodeURIComponent(runId)}?taken=${encodeURIComponent(outcome)}`
        + keptTo
        + filtersQuery(kept.get('rule'), kept.get('product')).replace(/^\?/, '&'),
    });
    res.end();
    return;
  }

  if (req.method === 'POST' && path === '/edit') {
    await editRoute(req, res, deps, reviewer, url, theme, options.ledgerReply);
    return;
  }

  // DEC-48: the case a reviewer finishes with no reply. Its own route, for
  // the reason every other outcome has one: nothing is sent, so a review of
  // this console's writes should read a name that says so.
  if (req.method === 'POST' && path === '/close') {
    await closeRoute(req, res, deps, reviewer, url, theme);
    return;
  }

  // DEC-49: the case a reviewer sends back for a new attempt. Its own route,
  // as every outcome has: the run ends, a new one takes the turn, and nothing
  // is sent.
  if (req.method === 'POST' && path === '/send-back') {
    await sendBackRoute(req, res, deps, reviewer, url, theme);
    return;
  }

  // DEC-50: a document a reviewer writes from a case. Its own route: nothing
  // on the case moves here, and the attempt it asks for is the consumer's.
  if (req.method === 'POST' && path === '/publish') {
    await publishRoute(req, res, deps, reviewer, url, theme, shell, options.ledgerReply);
    return;
  }

  // DEC-48: the case a reviewer puts aside. Its own route, as every outcome
  // has: nothing is sent, and the case waits.
  if (req.method === 'POST' && path === '/snooze') {
    await snoozeRoute(req, res, deps, reviewer, url, theme);
    return;
  }

  // DEC-48: the reply a reviewer writes from scratch. Its own route, as
  // every outcome has: the case stays where it is, and the reply under it
  // becomes a person's.
  if (req.method === 'POST' && path === '/rewrite') {
    await rewriteRoute(req, res, deps, reviewer, url, theme);
    return;
  }

  if (req.method === 'POST' && path === '/approve') {
    // Read before the body, and used by every line this route logs. A client
    // that hangs up destroys its socket, and a later read of the address may
    // find nothing.
    const from = req.socket.remoteAddress ?? null;
    let form;
    try {
      form = await readForm(req, APPROVE_FORM_LIMIT);
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
      send(res, 413, bare(
        'Refused',
        'The approval form is larger than this console accepts. Nothing was sent.',
        theme,
        backToQueue(url),
      ));
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
    // DEC-46: the digest of the reply the form's page drew. Required, because
    // every console approval carries the guard — a request without one is a
    // request this console did not render, and serving it would be an
    // approval of a reply nobody was shown. Checked for shape, never echoed.
    const shown = (form.get('shown') ?? '').trim();
    if (!SHOWN_DIGEST.test(shown)) {
      console.error(logLine({
        event: 'console_refused',
        reason: 'not_a_shown_digest',
        runId,
        shownLength: loggedLength(shown),
        host: req.headers.host ?? null,
        from,
      }));
      send(res, 400, bare(
        'Refused',
        'That request carries no reply digest, so this console will not approve it.' +
        ' Open the case and approve it from there.',
        theme,
      ));
      return;
    }
    // DEC-44: the reviewer's answer to a refusal that drew two texts. It is
    // the digest of the helpdesk copy the page drew, so the approval refuses
    // again if that copy moved since — and a request without it is an
    // approval that is not choosing between two texts. Shape-checked like the
    // reply digest beside it, and never echoed.
    const ack = (form.get('ack') ?? '').trim();
    if (ack !== '' && !SHOWN_DIGEST.test(ack)) {
      console.error(logLine({
        event: 'console_refused',
        reason: 'not_a_copy_digest',
        runId,
        ackLength: loggedLength(ack),
        host: req.headers.host ?? null,
        from,
      }));
      send(res, 400, bare(
        'Refused',
        'That request carries an answer about the helpdesk copy in no shape this console reads,'
          + ' so nothing was approved. Open the case and answer the refusal there.',
        theme,
      ));
      return;
    }
    // The run id and the digests are the whole request, with the editor's
    // text read above only to refuse a change nobody saved. Any other field is
    // ignored, because the relay sends the parked draft verbatim and a body
    // posted here would be recorded as the approved reply without ever
    // reaching the customer.
    // DEC-45: who approved, as the identity the gate resolved. It is on the
    // roster and active, or this request never reached the route.
    //
    // #123: a reply parked in the ledger alone has no helpdesk draft, and the
    // relay refuses a reply record with none (DEC-44). The case page offers no
    // approval for it, and a request built by hand gets none either. A read
    // that fails here refuses nothing: the approval reads the run itself.
    let ledgerOnlyReply = false;
    // Unread counts as waiting, so a fault here never skips the refusal below.
    let waitingRun = true;
    try {
      const run = await deps.readRun(runId);
      ledgerOnlyReply = run !== null && run.draftExternalId === null
        && run.actionClass === CUSTOMER_REPLY_ACTION_CLASS;
      waitingRun = run === null || run.state === 'awaiting_approval';
    } catch (error) {
      console.error(logLine({
        event: 'console_approve_unread', tag: randomUUID().slice(0, 8), runId,
        host: req.headers.host ?? null, from,
        error: describeFault(error),
      }));
    }
    if (ledgerOnlyReply) {
      console.error(logLine({
        event: 'console_refused', reason: 'ledger_only_reply', runId,
        host: req.headers.host ?? null, from,
      }));
      send(res, 400, bare(
        'Refused',
        'This run parked a reply in the ledger alone, with no helpdesk draft, so no reply can be'
          + ' sent from it and nothing was approved. An operator reconciles it by hand.',
        theme,
      ));
      return;
    }
    // Issue #154: the send posts the editor's form where the page drew one, so
    // (checked once the run is read: a case that left the queue gets the
    // approval's own answer, not advice to save)
    // the editor's text arrives with it. Text that differs from what the
    // editor drew is a change nobody saved, and an approval would send the
    // saved reply and drop it. Refused here, so no page whose script did not
    // run can drop it either. Compared as typed text, because a browser posts
    // a textarea's line breaks as CRLF.
    if (form.has('text') && waitingRun) {
      const drawn = (form.get('drawn') ?? '').trim();
      if (!SHOWN_DIGEST.test(drawn)) {
        console.error(logLine({
          event: 'console_refused', reason: 'not_a_drawn_digest', runId,
          drawnLength: loggedLength(drawn), host: req.headers.host ?? null, from,
        }));
        send(res, 400, bare(
          'Refused',
          'That request carries editor text with no digest of what the editor drew, so nothing was approved.'
            + ' Open the case and approve it from there.',
          theme,
        ));
        return;
      }
      if (replyDigest(typedText(form.get('text') ?? '')) !== drawn) {
        console.error(logLine({
          event: 'console_refused', reason: 'unsaved_edit', runId,
          host: req.headers.host ?? null, from,
        }));
        send(res, 409, bare(
          'Refused',
          'The reply in the editor holds changes that were not saved, so nothing was approved.'
            + ' Go back in the browser to keep the changes, then save the reply and approve it.',
          theme,
          {
            href: caseHref(runId, url.searchParams.get('rule'), url.searchParams.get('product')),
            text: 'Open the case without the changes',
          },
        ));
        return;
      }
    }
    let outcome;
    try {
      outcome = ack === ''
        ? await deps.approve(runId, reviewer, shown)
        : await deps.approve(runId, reviewer, shown, ack);
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
        reviewer: logged(reviewer),
        reviewerLength: loggedLength(reviewer),
        host: req.headers.host ?? null,
        from,
        error: describeFault(error),
      }));
      send(res, 500, bare(
        'Error',
        `Something failed during the approval, and it may or may not have committed. The console log names it ${tag}.`,
        theme,
        {
          href: caseHref(runId, url.searchParams.get('rule'), url.searchParams.get('product')),
          text: 'Open the case to see its state.',
        },
      ));
      return;
    }
    // The approval, one of the writes this console makes. The ledger
    // journals that a run was approved; it does not journal which client
    // asked, so this line is the console-side evidence naming the reviewer
    // (DEC-45).
    console.error(logLine({
      event: 'console_approved',
      runId,
      outcome,
      // The identity the roster accepted, and what the ledger records for it.
      // They differ only when the approval did not commit.
      reviewer: logged(reviewer),
      reviewerLength: loggedLength(reviewer),
      approvedBy: outcome === 'approved' ? reviewer : null,
      // DEC-44: the approval that sent the ledger's reply past a helpdesk copy
      // a person edited. A boolean and not the digest: the fact an incident
      // reader needs is that the edit was set aside on purpose, and by whom.
      copyAcknowledged: ack !== '' && outcome === 'approved',
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
    // Both filters come back with it (DEC-47), read off the action's query
    // string and never off the body.
    const keptFilters = filtersQuery(
      url.searchParams.get('rule'),
      url.searchParams.get('product'),
    ).replace(/^\?/, '&');
    res.writeHead(303, {
      ...SAFETY_HEADERS,
      location: `/case/${encodeURIComponent(runId)}?outcome=${encodeURIComponent(outcome)}`
        + keptFilters,
    });
    res.end();
    return;
  }

  // DEC-51: the batch a reviewer confirms from the queue. The queue's clean
  // group posts the cases it has picked, and this draws each reply in full
  // before anything sends.
  if (req.method === 'POST' && path === '/confirm') {
    const from = req.socket.remoteAddress ?? null;
    const form = await formOrRefusal(req, res, theme, 'confirmation', backToQueue(url));
    if (form === null) return;
    // One spelling per case: a uuid reads the same in either letter case.
    const picked = form.getAll('runId').map((value) => value.trim().toLowerCase());
    const chosen = await confirmCases(deps, picked, options, url);
    if (chosen.refusal !== null) {
      console.error(logLine({
        event: 'console_refused', reason: chosen.refusal, runId: null,
        host: req.headers.host ?? null, from,
      }));
      send(res, 400, bare('Refused', chosen.says, theme, backToQueue(url)));
      return;
    }
    send(res, 200, page(
      'Confirm replies',
      renderConfirm(chosen.cases, {
        rule: url.searchParams.get('rule'),
        product: url.searchParams.get('product'),
        // The effective hold: a reply on the DEC-40 draft path is never held,
        // so the screen must not promise a window there.
        holdMs: options.ledgerReply ? options.sendHoldMs : 0,
        dropped: chosen.dropped,
      }),
      { ...shell('/'), back: queueHref(url.searchParams.get('rule'), url.searchParams.get('product')) },
    ));
    return;
  }

  // The batch itself: every picked case goes through the one approval this
  // console has, each with its own digest, so a case whose reply moved since
  // the page was drawn refuses while its neighbours send.
  if (req.method === 'POST' && path === '/confirm/apply') {
    const from = req.socket.remoteAddress ?? null;
    const form = await formOrRefusal(req, res, theme, 'confirmation', backToQueue(url));
    if (form === null) return;
    // One spelling per case: a uuid reads the same in either letter case, so
    // the repeat check below compares what the ledger compares.
    const runIds = form.getAll('runId').map((value) => value.trim().toLowerCase());
    const digests = form.getAll('shown').map((value) => value.trim());
    if (runIds.length === 0 || runIds.length !== digests.length
        || !runIds.every(isRunId) || !digests.every((value) => SHOWN_DIGEST.test(value))) {
      console.error(logLine({
        event: 'console_refused', reason: 'not_a_confirmable_batch', runId: null,
        runs: runIds.length, digests: digests.length,
        host: req.headers.host ?? null, from,
      }));
      send(res, 400, bare(
        'Refused',
        'That is not a batch this console confirms: every case needs its own run id and the'
          + ' reply digest the page drew. Nothing was sent.',
        theme,
        backToQueue(url),
      ));
      return;
    }
    // #123: one answer per case. A run named twice would be checked and
    // approved twice, and the page could not say which answer was its own.
    if (new Set(runIds).size !== runIds.length) {
      console.error(logLine({
        event: 'console_refused', reason: 'batch_repeats_a_case', runId: null,
        runs: runIds.length, host: req.headers.host ?? null, from,
      }));
      send(res, 400, bare(
        'Refused',
        'That batch names a case more than once, so nothing was sent. Go back to the queue and'
          + ' pick the cases again.',
        theme,
        backToQueue(url),
      ));
      return;
    }
    if (runIds.length > MAX_BATCH) {
      send(res, 400, bare(
        'Refused',
        `This console confirms at most ${MAX_BATCH} cases at once, and that request carries`
          + ` ${runIds.length}. Nothing was sent.`,
        theme,
        backToQueue(url),
      ));
      return;
    }
    // #123: a batch confirms replies alone (DEC-51). The page drops an
    // internal write, and a post that names one anyway is refused whole,
    // before anything is approved.
    //
    // A case this read cannot reach is not refused here: a fault says nothing
    // about which kind it parked. The batch's own approval checks the kind
    // again, below, and a case it cannot read there is that case's fault, so
    // nothing unread is ever approved.
    let parkedAction: string | null = null;
    for (const runId of runIds) {
      let run;
      try {
        run = await deps.readRun(runId);
      } catch (error) {
        console.error(logLine({
          event: 'console_confirm_unread', tag: randomUUID().slice(0, 8), runId,
          host: logged(url.host), error: describeFault(error),
        }));
        continue;
      }
      if (run !== null && run.draftExternalId === null) {
        parkedAction = runId;
        break;
      }
    }
    if (parkedAction !== null) {
      console.error(logLine({
        event: 'console_refused', reason: 'batch_names_an_action', runId: parkedAction,
        host: req.headers.host ?? null, from,
      }));
      send(res, 400, bare(
        'Refused',
        'That batch names a case that holds no helpdesk draft. A batch confirms drafted replies'
          + ' alone, so nothing was sent. Open that case\'s page to see what it holds.',
        theme,
        backToQueue(url),
      ));
      return;
    }
    const cases = runIds.map((runId, index) => ({ runId, shown: digests[index]! }));
    let outcomes;
    try {
      outcomes = await confirmBatch(
        {
          // #123: the kind is read as each case is approved, so a case the
          // check above could not read is never approved unchecked. A park
          // row never changes kind, so nothing can move it after this read.
          //
          // Both refusals are answers, not faults: the batch knows nothing
          // was approved, and the page says so.
          approve: async (runId, approvedBy, shown) => {
            let run;
            try {
              run = await deps.readRun(runId);
            } catch (error) {
              console.error(logLine({
                event: 'console_confirm_unread', tag: randomUUID().slice(0, 8), runId,
                host: logged(url.host), error: describeFault(error),
              }));
              return 'batch_unread';
            }
            if (run !== null && run.draftExternalId === null) return 'batch_no_draft';
            return deps.approve(runId, approvedBy, shown);
          },
          undo: deps.undo,
        },
        cases,
        reviewer,
      );
    } catch (error) {
      const tag = randomUUID().slice(0, 8);
      console.error(logLine({
        event: 'console_confirm_failed', tag, runs: runIds.length,
        reviewer: logged(reviewer), reviewerLength: loggedLength(reviewer),
        host: req.headers.host ?? null, from, error: describeFault(error),
      }));
      send(res, 500, bare(
        'Error',
        `Something failed during the batch, and some of it may have committed.`
          + ` The console log names it ${tag}.`,
        theme,
        { href: queueHref(url.searchParams.get('rule'), url.searchParams.get('product')), text: 'Open the queue to see the cases.' },
      ));
      return;
    }
    // Every fault is its own line, naming the case: the panel says a case
    // failed and this is where a reader finds which and why.
    for (const one of outcomes.filter(isFault)) {
      console.error(logLine({
        event: 'console_confirm_case_failed', runId: one.runId,
        reviewer: logged(reviewer), reviewerLength: loggedLength(reviewer),
        host: req.headers.host ?? null, from, error: one.fault,
      }));
    }
    console.error(logLine({
      event: 'console_confirmed',
      runs: runIds.length,
      sent: outcomes.filter((one) => !isFault(one) && one.outcome === 'approved').length,
      reviewer: logged(reviewer), reviewerLength: loggedLength(reviewer),
      host: req.headers.host ?? null, from,
    }));
    const read = await outcomeRuns(deps, runIds);
    // DEC-51: the window that is left, not the period that was configured. A
    // slow batch outlives the period, and a page counting twelve seconds down
    // over a window the ledger has closed promises time nobody has.
    send(res, 200, page(
      'Replies sent',
      renderConfirmResult(outcomes, {
        rule: url.searchParams.get('rule'),
        product: url.searchParams.get('product'),
        holdMs: options.ledgerReply ? options.sendHoldMs : 0,
        ...await remainingHolds(deps, outcomes),
        runs: read.runs,
        unread: read.unread,
      }),
      { ...shell('/'), back: queueHref(url.searchParams.get('rule'), url.searchParams.get('product')) },
    ));
    return;
  }

  // The way back inside the hold (DEC-51). One case that can no longer be
  // undone does not stop the rest, so the answer is a list.
  if (req.method === 'POST' && path === '/undo') {
    const from = req.socket.remoteAddress ?? null;
    const form = await formOrRefusal(req, res, theme, 'undo', backToQueue(url));
    if (form === null) return;
    // One spelling per case: a uuid reads the same in either letter case, so
    // the ids it echoes back and links match what the ledger returns.
    const runIds = form.getAll('runId').map((value) => value.trim().toLowerCase());
    if (runIds.length === 0 || runIds.length > MAX_BATCH || !runIds.every(isRunId)) {
      console.error(logLine({
        event: 'console_refused', reason: 'not_an_undoable_batch', runId: null,
        runs: runIds.length, host: req.headers.host ?? null, from,
      }));
      send(res, 400, bare(
        'Refused',
        'That is not a batch this console undoes: every case needs its own run id.'
          + ' Nothing was undone.',
        theme,
        backToQueue(url),
      ));
      return;
    }
    let outcomes;
    try {
      outcomes = await undoBatch({ undo: deps.undo }, runIds, reviewer);
    } catch (error) {
      const tag = randomUUID().slice(0, 8);
      console.error(logLine({
        event: 'console_undo_failed', tag, runs: runIds.length,
        reviewer: logged(reviewer), reviewerLength: loggedLength(reviewer),
        host: req.headers.host ?? null, from, error: describeFault(error),
      }));
      send(res, 500, bare(
        'Error',
        `Something failed during the undo, and some of it may have committed.`
          + ` The console log names it ${tag}.`,
        theme,
        { href: queueHref(url.searchParams.get('rule'), url.searchParams.get('product')), text: 'Open the queue to see the cases.' },
      ));
      return;
    }
    for (const one of outcomes.filter(isFault)) {
      console.error(logLine({
        event: 'console_undo_case_failed', runId: one.runId,
        reviewer: logged(reviewer), reviewerLength: loggedLength(reviewer),
        host: req.headers.host ?? null, from, error: one.fault,
      }));
    }
    console.error(logLine({
      event: 'console_undone',
      runs: runIds.length,
      undone: outcomes.filter((one) => !isFault(one) && one.outcome.outcome === 'undone').length,
      reviewer: logged(reviewer), reviewerLength: loggedLength(reviewer),
      host: req.headers.host ?? null, from,
    }));
    send(res, 200, page(
      'Undone',
      renderUndoResult(outcomes, {
        rule: url.searchParams.get('rule'),
        product: url.searchParams.get('product'),
      }),
      { ...shell('/'), back: queueHref(url.searchParams.get('rule'), url.searchParams.get('product')) },
    ));
    return;
  }

  // A path no rail link names. A method this console does not serve on a
  // surface's own path, such as a POST to `/`, is not that surface, and the
  // rail must not mark it as the page being read.
  send(res, 404, page('Not found', nothingFound(), shell(NOT_A_SURFACE)));
}

/**
 * The console's save: the reply a reviewer wrote, written onto the turn it
 * answers (DEC-44).
 *
 * Three requests reach here, and they differ only in how the text is
 * assembled. The editor sends the whole reply. A callout sends the sentence
 * it edits, and the rest of the reply is read back from the ledger — so the
 * edit lands on the text the approval would send, not on a copy the browser
 * happened to hold.
 *
 * The response is a redirect to the case, like every other write here: a
 * refresh cannot post the save twice, and the page beside the outcome is the
 * reply it just changed.
 */
async function editRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConsoleDeps,
  reviewer: string,
  url: URL,
  theme: Theme,
  ledgerReply: boolean,
): Promise<void> {
  const from = req.socket.remoteAddress ?? null;
  // The page offers no editor on an adapter whose helpdesk sends its own
  // parked copy, and neither does this route. A save there would write text
  // the approval never reads, which is a reply a reviewer believes they sent.
  if (!ledgerReply) {
    console.error(logLine({
      event: 'console_refused', reason: 'no_editor_on_this_adapter',
      host: req.headers.host ?? null, from,
    }));
    send(res, 400, bare(
      'Refused',
      'This console does not edit replies: the helpdesk copy is what sends,'
        + ' so edit it in the helpdesk.',
      theme,
    ));
    return;
  }
  let form;
  try {
    form = await readForm(req);
  } catch (error) {
    // The same three answers the other writes give a body they cannot read.
    if (!(error instanceof OversizedForm)) {
      if (req.destroyed || req.readableAborted) {
        console.error(logLine({
          event: 'console_refused', reason: 'client_aborted',
          host: req.headers.host ?? null, from,
        }));
        return;
      }
      throw error;
    }
    req.destroy();
    send(res, 413, bare(
      'Refused',
      'The edit is larger than this console accepts. Nothing was saved.',
      theme,
      backToQueue(url),
    ));
    return;
  }

  const runId = (form.get('runId') ?? '').trim();
  if (!isRunId(runId)) {
    console.error(logLine({
      event: 'console_refused', reason: 'not_a_run_id',
      runId: logged(runId), runIdLength: loggedLength(runId),
      host: req.headers.host ?? null, from,
    }));
    send(res, 400, bare('Refused', 'That is not a run id, so nothing was saved.', theme));
    return;
  }
  // The digest of the reply the form's page drew, required for the reason the
  // approval requires one: a save from a page this console did not render
  // would overwrite text its reviewer never read.
  const shown = (form.get('shown') ?? '').trim();
  if (!SHOWN_DIGEST.test(shown)) {
    console.error(logLine({
      event: 'console_refused', reason: 'not_a_shown_digest',
      runId, shownLength: loggedLength(shown),
      host: req.headers.host ?? null, from,
    }));
    send(res, 400, bare(
      'Refused',
      'That request carries no reply digest, so this console will not save it.'
        + ' Open the case and edit it there.',
      theme,
    ));
    return;
  }

  const edit = (form.get('edit') ?? '').trim();
  const sentence = form.get('sentence') ?? '';
  let text: string | null = null;
  // Why an edit that saved nothing did not apply. A code and not a sentence:
  // the answer travels back on a redirect, and a query string is a place any
  // text can be put, so the page looks each code up rather than printing what
  // it was handed.
  let refusal: string | null = null;
  // Whether the save was reached. The 500 below answers for two different
  // moments — a run or a document read that failed, and a write that may have
  // committed — and only this tells them apart. A fault in a read answered
  // "it may or may not have committed" about a write nobody made.
  let saving = false;
  try {
    // Inside the handler for the reason above: a read that fails is a fault
    // this route answers for, and outside it the generic catch-all logged it
    // as an unhandled console error with no edit named.
    const run = await deps.readRun(runId);
    // Every edit needs the run, and this is why. A park that carries no handle
    // into the target system is a ledger-only park (DEC-34): its record routes
    // to `performAction`, so a reply saved here would never send. The card
    // draws no editor for such a run, and neither does this route — a card is
    // not what refuses a request.
    if (run !== null && run.draftExternalId === null) {
      console.error(logLine({
        event: 'console_refused', reason: 'no_reply_to_edit', runId,
        host: req.headers.host ?? null, from,
      }));
      send(res, 400, bare(
        'Refused',
        'This case holds no reply to edit: it parked an action rather than a reply, so nothing'
          + ' here would be sent.',
        theme,
      ));
      return;
    }
    if (edit === 'text') {
      text = form.get('text') ?? '';
    } else if (edit === 'replace' || edit === 'delete' || edit === 'write') {
      const current = run === null
        ? null
        : (run.request?.savedReplyText ?? run.evidence.draftBody);
      if (current === null) {
        refusal = 'no_reply';
      } else if (sentence === '') {
        refusal = 'no_sentence';
      } else if (edit === 'delete') {
        text = withoutSentence(current, sentence);
      } else if (edit === 'write') {
        const answer = (form.get('answer') ?? '').trim();
        if (answer.length === 0) refusal = 'no_answer';
        else text = withSentenceReplaced(current, sentence, answer);
      } else {
        // The document's own words, or the reason there are none. The
        // document is the one the run's own journal says this sentence cites,
        // and never one the request names: a form field would let any indexed
        // document be quoted into a customer reply.
        const cited = (run?.evidence.claims ?? []).find((claim) => claim.text === sentence)?.docId;
        // Three answers, and each says something else. A sentence no claim of
        // this run makes is not in the reply any more. A claim whose document
        // the ledger does not hold is a retrieval fault. A document that
        // shares no word with the claim is the third button's job.
        if (cited === undefined) refusal = 'no_sentence';
        else {
          const body = await deps.readDocumentBody(cited);
          if (body === null) refusal = 'no_document';
          else if (body.length > MAX_CITED_DOCUMENT_CHARS) refusal = 'document_too_large';
          else {
            const pick = closestDocumentSentence(body, sentence);
            if (pick === null) refusal = 'no_wording';
            else text = withSentenceReplaced(current, sentence, pick);
          }
        }
      }
      if (text === null && refusal === null) refusal = 'no_sentence';
    } else {
      console.error(logLine({
        event: 'console_refused', reason: 'not_a_known_edit', runId,
        editLength: loggedLength(edit), host: req.headers.host ?? null, from,
      }));
      send(res, 400, bare('Refused', 'That is not an edit this console knows.', theme));
      return;
    }

    // The console's own arm for an edit that never reached a save, beside
    // the ledger's answers to ones that did.
    let outcome: ConsoleSaveOutcome['outcome'] | 'not_an_edit';
    if (refusal !== null) {
      outcome = 'not_an_edit';
    } else {
      saving = true;
      outcome = await deps.saveReply(runId, text ?? '', shown, reviewer);
    }
    // The write this console makes. The ledger records the text and who saved
    // it (DEC-45); this line records the request: what was asked for, from
    // where, and how it ended.
    console.error(logLine({
      event: 'console_reply_saved',
      runId, edit, outcome, why: refusal,
      reviewer: logged(reviewer), reviewerLength: loggedLength(reviewer),
      host: req.headers.host ?? null, from,
    }));
    const kept = filtersQuery(url.searchParams.get('rule'), url.searchParams.get('product'))
      .replace(/^\?/, '&');
    const why = refusal === null ? '' : `&why=${encodeURIComponent(refusal)}`;
    res.writeHead(303, {
      ...SAFETY_HEADERS,
      location: `/case/${encodeURIComponent(runId)}?edit=${encodeURIComponent(outcome)}${why}${kept}`,
    });
    res.end();
  } catch (error) {
    const tag = randomUUID().slice(0, 8);
    console.error(logLine({
      event: 'console_save_failed', tag, runId, edit, saving,
      reviewer: logged(reviewer), reviewerLength: loggedLength(reviewer),
      host: req.headers.host ?? null, from, error: describeFault(error),
    }));
    send(res, 500, bare(
      'Error',
      saving
        ? `Something failed during the save, and it may or may not have committed.`
          + ` The console log names it ${tag}.`
        : `Something failed while preparing this edit, and nothing was saved.`
          + ` The console log names it ${tag}.`,
      theme,
      {
        href: caseHref(runId, url.searchParams.get('rule'), url.searchParams.get('product')),
        text: 'Open the case to see its reply.',
      },
    ));
  }
}

/**
 * The close a reviewer posts from a case (DEC-48).
 *
 * Two things are checked here and nothing else: the run id, and the digest of
 * the reply the page drew. The reason's own rules — that it says something,
 * and that it fits the ledger's bound — belong to `closeRun`, which refuses
 * before it writes and answers with a code. One set of rules about a reason,
 * and the page words the answer.
 */
async function closeRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConsoleDeps,
  reviewer: string,
  url: URL,
  theme: Theme,
): Promise<void> {
  const from = req.socket.remoteAddress ?? null;
  let form;
  try {
    form = await readForm(req);
  } catch (error) {
    // The same three answers the other writes give a body they cannot read.
    if (!(error instanceof OversizedForm)) {
      if (req.destroyed || req.readableAborted) {
        console.error(logLine({
          event: 'console_refused', reason: 'client_aborted',
          host: req.headers.host ?? null, from,
        }));
        return;
      }
      throw error;
    }
    req.destroy();
    send(res, 413, bare(
      'Refused',
      'The close is larger than this console accepts. Nothing was closed.',
      theme,
      backToQueue(url),
    ));
    return;
  }

  const runId = (form.get('runId') ?? '').trim();
  if (!isRunId(runId)) {
    console.error(logLine({
      event: 'console_refused', reason: 'not_a_run_id',
      runId: logged(runId), runIdLength: loggedLength(runId),
      host: req.headers.host ?? null, from,
    }));
    send(res, 400, bare('Refused', 'That is not a run id, so nothing was closed.', theme));
    return;
  }
  // DEC-46: the digest of the reply the form's page drew, required for the
  // reason the approval requires one — a close from a page this console did
  // not render would apply to a case its reviewer never read. Shape-checked,
  // and never echoed.
  const shown = (form.get('shown') ?? '').trim();
  if (!SHOWN_DIGEST.test(shown)) {
    console.error(logLine({
      event: 'console_refused', reason: 'not_a_shown_digest',
      runId, shownLength: loggedLength(shown),
      host: req.headers.host ?? null, from,
    }));
    send(res, 400, bare(
      'Refused',
      'That request carries no reply digest, so this console will not close the case.'
        + ' Open the case and close it there.',
      theme,
    ));
    return;
  }

  let outcome: string;
  try {
    // The reason travels as the reviewer typed it. Its rules are the core's:
    // an empty one and one past the bound are refused there, before any
    // write, and each has its own sentence on the page.
    outcome = await deps.close(runId, reviewer, form.get('reason') ?? '', shown);
  } catch (error) {
    // One sentence, because a fault here cannot be told apart from one that
    // committed. The route's own checks run before the call, but the call
    // itself does work before it writes — the run read, the connection, the
    // park row — and nothing in the answer says which step threw. So the page
    // says the close may have committed rather than claiming it did not.
    const tag = randomUUID().slice(0, 8);
    console.error(logLine({
      event: 'console_close_failed', tag, runId,
      reviewer: logged(reviewer), reviewerLength: loggedLength(reviewer),
      host: req.headers.host ?? null, from, error: describeFault(error),
    }));
    send(res, 500, bare(
      'Error',
      `Something failed during the close, and it may or may not have committed.`
        + ` The console log names it ${tag}.`,
      theme,
      {
        href: caseHref(runId, url.searchParams.get('rule'), url.searchParams.get('product')),
        text: 'Open the case to see its state.',
      },
    ));
    return;
  }
  // The console's own evidence line, as the approval's and the save's are.
  // The reason is not repeated here: it is the reviewer's text and the ledger
  // holds it, so this names who asked and what the ledger answered.
  console.error(logLine({
    event: 'console_closed',
    runId,
    outcome,
    reviewer: logged(reviewer),
    reviewerLength: loggedLength(reviewer),
    host: req.headers.host ?? null,
    from,
  }));
  const kept = filtersQuery(url.searchParams.get('rule'), url.searchParams.get('product'))
    .replace(/^\?/, '&');
  res.writeHead(303, {
    ...SAFETY_HEADERS,
    location: `/case/${encodeURIComponent(runId)}?closed=${encodeURIComponent(outcome)}${kept}`,
  });
  res.end();
}

/**
 * The send-back a reviewer posts from a case (DEC-49).
 *
 * Two things are checked here: the run id and the digest of the reply the
 * page drew. The note's own rules — that it says something, that it fits, and
 * that the ledger can store it — belong to `sendBackRun`, which refuses each
 * before it writes, and the page words the answer.
 *
 * The note is not bounded here beyond the form's own size. The ledger bounds
 * what it will record, and a console that also refused a length would be the
 * second place the number lives.
 */
async function publishRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConsoleDeps,
  reviewer: string,
  url: URL,
  theme: Theme,
  shell: (at: string) => Shell,
  ledgerReply: boolean,
): Promise<void> {
  const from = req.socket.remoteAddress ?? null;
  let form;
  try {
    form = await readForm(req);
  } catch (error) {
    if (!(error instanceof OversizedForm)) {
      if (req.destroyed || req.readableAborted) {
        console.error(logLine({
          event: 'console_refused', reason: 'client_aborted',
          host: req.headers.host ?? null, from,
        }));
        return;
      }
      throw error;
    }
    req.destroy();
    send(res, 413, bare(
      'Refused',
      'The document is larger than this console accepts. Nothing was published.',
      theme,
      backToQueue(url),
    ));
    return;
  }

  const runId = (form.get('runId') ?? '').trim();
  if (!isRunId(runId)) {
    console.error(logLine({
      event: 'console_refused', reason: 'not_a_run_id',
      runId: logged(runId), runIdLength: loggedLength(runId),
      host: req.headers.host ?? null, from,
    }));
    send(res, 400, bare('Refused', 'That is not a run id, so nothing was published.', theme));
    return;
  }
  const shown = (form.get('shown') ?? '').trim();
  if (!SHOWN_DIGEST.test(shown)) {
    console.error(logLine({
      event: 'console_refused', reason: 'not_a_shown_digest',
      runId, shownLength: loggedLength(shown),
      host: req.headers.host ?? null, from,
    }));
    send(res, 400, bare(
      'Refused',
      'That request carries no reply digest, so this console will not publish from it.'
        + ' Open the case and write the document there.',
      theme,
    ));
    return;
  }

  const fields: ComposerFields = {
    title: form.get('title') ?? '',
    body: form.get('body') ?? '',
    owner: form.get('owner') ?? '',
    reviewBy: (form.get('reviewBy') ?? '').trim(),
    products: form.getAll('product').map((product) => product.trim()).filter((product) => product !== ''),
  };
  const rule = url.searchParams.get('rule');
  const product = url.searchParams.get('product');
  let outcome: PublishOutcome;
  try {
    outcome = await deps.publish(runId, reviewer, fields, shown);
  } catch (error) {
    const tag = randomUUID().slice(0, 8);
    console.error(logLine({
      event: 'console_publish_failed', tag, runId,
      titleLength: loggedLength(fields.title), bodyLength: loggedLength(fields.body),
      reviewer: logged(reviewer), reviewerLength: loggedLength(reviewer),
      host: req.headers.host ?? null, from, error: describeFault(error),
    }));
    send(res, 500, bare(
      'Error',
      `Something failed while publishing, and it may or may not have committed.`
        + ` The console log names it ${tag}.`,
      theme,
      { href: caseHref(runId, rule, product), text: 'Open the case to see what it holds.' },
    ));
    return;
  }
  // The lengths and the outcome, never the text: a refused document may be
  // one that named the customer.
  console.error(logLine({
    // A repeated post wrote nothing, so it is not logged as a publish.
    event: outcome.outcome !== 'published'
      ? 'console_publish_refused'
      : outcome.repeated === true ? 'console_publish_repeated' : 'console_published',
    runId,
    outcome: outcome.outcome,
    ...(outcome.outcome === 'published' ? { docId: outcome.docId, rerun: outcome.rerun } : {}),
    titleLength: loggedLength(fields.title),
    bodyLength: loggedLength(fields.body),
    reviewer: logged(reviewer),
    reviewerLength: loggedLength(reviewer),
    host: req.headers.host ?? null,
    from,
  }));
  if (outcome.outcome !== 'published') {
    // What the reviewer wrote comes back below the refusal: in the composer,
    // or as text when the case maps no product or a person removed the
    // document. The route reads the case again for its product, which the
    // form fixes, and for its reply: a reply that changed is drawn, and the
    // form carries its digest, so the reviewer reads it and publishes again
    // without writing the document twice. A case that cannot be read keeps
    // the product the form posted first, which is the case's own.
    let caseProduct: string | null = fields.products[0] ?? null;
    let current: { readonly text: string; readonly shown: string } | null = null;
    try {
      const run = await deps.readRun(runId);
      if (run !== null) {
        caseProduct = run.product === null || run.product.trim() === '' ? null : run.product;
        if (outcome.outcome === 'shown_changed') {
          const text = replyTextOf(run, ledgerReply) ?? '';
          current = { text, shown: replyDigest(text) };
        }
      }
    } catch (error) {
      const tag = randomUUID().slice(0, 8);
      console.error(logLine({ event: 'console_case_unread', tag, runId, error: describeFault(error) }));
    }
    send(res, 422, page(
      'Publish',
      renderPublishRefused(runId, current?.shown ?? shown, caseProduct, outcome, fields, {
        current: current?.text ?? null,
        rule, product, productLabels: deps.productLabels, today: new Date().toISOString().slice(0, 10),
      }),
      { ...shell(`/case/${runId}`), back: caseHref(runId, rule, product) },
    ));
    return;
  }
  const kept = filtersQuery(rule, product).replace(/^\?/, '&');
  res.writeHead(303, {
    ...SAFETY_HEADERS,
    location: `/case/${encodeURIComponent(runId)}?published=1${kept}#knowledge`,
  });
  res.end();
}

async function sendBackRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConsoleDeps,
  reviewer: string,
  url: URL,
  theme: Theme,
): Promise<void> {
  const from = req.socket.remoteAddress ?? null;
  let form;
  try {
    form = await readForm(req);
  } catch (error) {
    if (!(error instanceof OversizedForm)) {
      if (req.destroyed || req.readableAborted) {
        console.error(logLine({
          event: 'console_refused', reason: 'client_aborted',
          host: req.headers.host ?? null, from,
        }));
        return;
      }
      throw error;
    }
    req.destroy();
    send(res, 413, bare(
      'Refused',
      'The send-back form is larger than this console accepts. Nothing was sent back.',
      theme,
      backToQueue(url),
    ));
    return;
  }

  const runId = (form.get('runId') ?? '').trim();
  if (!isRunId(runId)) {
    console.error(logLine({
      event: 'console_refused', reason: 'not_a_run_id',
      runId: logged(runId), runIdLength: loggedLength(runId),
      host: req.headers.host ?? null, from,
    }));
    send(res, 400, bare('Refused', 'That is not a run id, so nothing was sent back.', theme));
    return;
  }
  const shown = (form.get('shown') ?? '').trim();
  if (!SHOWN_DIGEST.test(shown)) {
    console.error(logLine({
      event: 'console_refused', reason: 'not_a_shown_digest',
      runId, shownLength: loggedLength(shown),
      host: req.headers.host ?? null, from,
    }));
    send(res, 400, bare(
      'Refused',
      'That request carries no reply digest, so this console will not send the case back.'
        + ' Open the case and send it back there.',
      theme,
    ));
    return;
  }

  const note = form.get('note') ?? '';
  let outcome: string;
  try {
    outcome = await deps.sendBack(runId, reviewer, note, shown);
  } catch (error) {
    const tag = randomUUID().slice(0, 8);
    console.error(logLine({
      event: 'console_send_back_failed', tag, runId, noteLength: loggedLength(note),
      reviewer: logged(reviewer), reviewerLength: loggedLength(reviewer),
      host: req.headers.host ?? null, from, error: describeFault(error),
    }));
    send(res, 500, bare(
      'Error',
      `Something failed during the send-back, and it may or may not have committed.`
        + ` The console log names it ${tag}.`,
      theme,
      {
        href: caseHref(runId, url.searchParams.get('rule'), url.searchParams.get('product')),
        text: 'Open the case to see its state.',
      },
    ));
    return;
  }
  console.error(logLine({
    event: 'console_sent_back',
    runId,
    outcome,
    noteLength: loggedLength(note),
    reviewer: logged(reviewer),
    reviewerLength: loggedLength(reviewer),
    host: req.headers.host ?? null,
    from,
  }));
  const kept = filtersQuery(url.searchParams.get('rule'), url.searchParams.get('product'))
    .replace(/^\?/, '&');
  res.writeHead(303, {
    ...SAFETY_HEADERS,
    location: `/case/${encodeURIComponent(runId)}?sentback=${encodeURIComponent(outcome)}${kept}`,
  });
  res.end();
}

/**
 * The snooze a reviewer posts from a case (DEC-48).
 *
 * Two things are checked here: the run id and the digest of the reply the
 * page drew. The period's own rules belong to `snoozeRun`, which refuses one
 * outside its bounds before it writes, and the page words the answer.
 *
 * The period arrives in minutes, the unit the bound is stated in, so a
 * reviewer can ask for the fifteen a case might need. A value that is not a
 * number reaches the ledger as one, and is refused there with the rest of the
 * bounds.
 */
async function snoozeRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConsoleDeps,
  reviewer: string,
  url: URL,
  theme: Theme,
): Promise<void> {
  const from = req.socket.remoteAddress ?? null;
  let form;
  try {
    form = await readForm(req);
  } catch (error) {
    if (!(error instanceof OversizedForm)) {
      if (req.destroyed || req.readableAborted) {
        console.error(logLine({
          event: 'console_refused', reason: 'client_aborted',
          host: req.headers.host ?? null, from,
        }));
        return;
      }
      throw error;
    }
    req.destroy();
    send(res, 413, bare(
      'Refused',
      'The snooze form is larger than this console accepts. Nothing was put aside.',
      theme,
      backToQueue(url),
    ));
    return;
  }

  const runId = (form.get('runId') ?? '').trim();
  if (!isRunId(runId)) {
    console.error(logLine({
      event: 'console_refused', reason: 'not_a_run_id',
      runId: logged(runId), runIdLength: loggedLength(runId),
      host: req.headers.host ?? null, from,
    }));
    send(res, 400, bare('Refused', 'That is not a run id, so nothing was put aside.', theme));
    return;
  }
  const shown = (form.get('shown') ?? '').trim();
  if (!SHOWN_DIGEST.test(shown)) {
    console.error(logLine({
      event: 'console_refused', reason: 'not_a_shown_digest',
      runId, shownLength: loggedLength(shown),
      host: req.headers.host ?? null, from,
    }));
    send(res, 400, bare(
      'Refused',
      'That request carries no reply digest, so this console will not put the case aside.'
        + ' Open the case and snooze it there.',
      theme,
    ));
    return;
  }

  // The period, in the unit the form posts. The bounds are the ledger's and
  // are answered by `snoozeRun`; a value that is not a number at all is
  // passed as one, which the ledger refuses as out of range.
  const minutes = Number((form.get('minutes') ?? '').trim());
  const periodMs = Number.isFinite(minutes)
    ? Math.round(minutes * 60_000)
    : Number.POSITIVE_INFINITY;
  let outcome: string;
  try {
    outcome = await deps.snooze(runId, reviewer, periodMs, shown);
  } catch (error) {
    const tag = randomUUID().slice(0, 8);
    console.error(logLine({
      event: 'console_snooze_failed', tag, runId, minutes: Number.isFinite(minutes) ? minutes : null,
      reviewer: logged(reviewer), reviewerLength: loggedLength(reviewer),
      host: req.headers.host ?? null, from, error: describeFault(error),
    }));
    send(res, 500, bare(
      'Error',
      `Something failed during the snooze, and it may or may not have committed.`
        + ` The console log names it ${tag}.`,
      theme,
      {
        href: caseHref(runId, url.searchParams.get('rule'), url.searchParams.get('product')),
        text: 'Open the case to see its state.',
      },
    ));
    return;
  }
  console.error(logLine({
    event: 'console_snoozed',
    runId,
    outcome,
    minutes: Number.isFinite(minutes) ? minutes : null,
    reviewer: logged(reviewer),
    reviewerLength: loggedLength(reviewer),
    host: req.headers.host ?? null,
    from,
  }));
  const kept = filtersQuery(url.searchParams.get('rule'), url.searchParams.get('product'))
    .replace(/^\?/, '&');
  res.writeHead(303, {
    ...SAFETY_HEADERS,
    location: `/case/${encodeURIComponent(runId)}?snoozed=${encodeURIComponent(outcome)}${kept}`,
  });
  res.end();
}

/**
 * The rewrite (DEC-48): a reviewer writes the reply the customer receives.
 *
 * The same checks the save route makes, and the same refusals word for word:
 * a reply written from a page nobody drew, or on a run the ledger does not
 * hold, is not a reply this console sends. The text is not bounded here,
 * because the ledger bounds what it will write and a reply has no length the
 * adopter set; the form's own size is refused before this point.
 */
async function rewriteRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConsoleDeps,
  reviewer: string,
  url: URL,
  theme: Theme,
): Promise<void> {
  const from = req.socket.remoteAddress ?? null;
  let form;
  try {
    form = await readForm(req);
  } catch (error) {
    if (!(error instanceof OversizedForm)) {
      if (req.destroyed || req.readableAborted) {
        console.error(logLine({
          event: 'console_refused', reason: 'client_aborted',
          host: req.headers.host ?? null, from,
        }));
        return;
      }
      throw error;
    }
    req.destroy();
    send(res, 413, bare(
      'Refused',
      'The rewrite form is larger than this console accepts. Nothing was rewritten.',
      theme,
      backToQueue(url),
    ));
    return;
  }

  const runId = (form.get('runId') ?? '').trim();
  if (!isRunId(runId)) {
    console.error(logLine({
      event: 'console_refused', reason: 'not_a_run_id',
      runId: logged(runId), runIdLength: loggedLength(runId),
      host: req.headers.host ?? null, from,
    }));
    send(res, 400, bare('Refused', 'That is not a run id, so nothing was rewritten.', theme));
    return;
  }
  const shown = (form.get('shown') ?? '').trim();
  if (!SHOWN_DIGEST.test(shown)) {
    console.error(logLine({
      event: 'console_refused', reason: 'not_a_shown_digest',
      runId, shownLength: loggedLength(shown),
      host: req.headers.host ?? null, from,
    }));
    send(res, 400, bare(
      'Refused',
      'That request carries no reply digest, so this console will not rewrite the case.'
        + ' Open the case and rewrite it there.',
      theme,
    ));
    return;
  }

  // The reply itself. The ledger trims it and refuses one that is only
  // whitespace, so the console passes what the field held.
  const text = form.get('text') ?? '';
  let outcome: string;
  try {
    // A park that carries no handle into the target system is a ledger-only
    // park (DEC-34): its record routes to `performAction`, so a reply written
    // here would never send. The card draws no control for such a run, and
    // neither does this route — a card is not what refuses a request. The
    // ledger refuses the same shape, and this is the sentence the edit route
    // refuses it with (DEC-48 reuses it word for word).
    const held = await deps.readRun(runId);
    if (held !== null && held.draftExternalId === null) {
      console.error(logLine({
        event: 'console_refused', reason: 'no_reply_to_rewrite', runId,
        host: req.headers.host ?? null, from,
      }));
      send(res, 400, bare(
        'Refused',
        'This case holds no reply to edit: it parked an action rather than a reply, so nothing'
          + ' here would be sent.',
        theme,
      ));
      return;
    }
    outcome = await deps.rewrite(runId, reviewer, text, shown);
  } catch (error) {
    const tag = randomUUID().slice(0, 8);
    console.error(logLine({
      event: 'console_rewrite_failed', tag, runId, textLength: loggedLength(text),
      reviewer: logged(reviewer), reviewerLength: loggedLength(reviewer),
      host: req.headers.host ?? null, from, error: describeFault(error),
    }));
    send(res, 500, bare(
      'Error',
      `Something failed during the rewrite, and it may or may not have committed.`
        + ` The console log names it ${tag}.`,
      theme,
      {
        href: caseHref(runId, url.searchParams.get('rule'), url.searchParams.get('product')),
        text: 'Open the case to see its state.',
      },
    ));
    return;
  }
  console.error(logLine({
    event: 'console_rewritten',
    runId,
    outcome,
    textLength: loggedLength(text),
    reviewer: logged(reviewer),
    reviewerLength: loggedLength(reviewer),
    host: req.headers.host ?? null,
    from,
  }));
  const kept = filtersQuery(url.searchParams.get('rule'), url.searchParams.get('product'))
    .replace(/^\?/, '&');
  res.writeHead(303, {
    ...SAFETY_HEADERS,
    location: `/case/${encodeURIComponent(runId)}?rewritten=${encodeURIComponent(outcome)}${kept}`,
  });
  res.end();
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
  // Both filters ride along, as they do on every other link to a case
  // (DEC-47): an old link that named a rule may name a product too, and the
  // case it opens returns to the queue the reviewer was reading.
  return caseHref(run, params.get('rule'), params.get('product'));
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
