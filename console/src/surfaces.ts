// The five surfaces (issue #27).
//
// Each takes data the query modules produced and returns HTML. None of them
// reads the ledger: the server does that through `bands`, `latency` and the
// runs module, so a metric has one definition and the console cannot drift
// from the job that publishes it.
//
// The design canvas at `.creatumo/design/console-canvas/` settles the
// contents. Its brief states the rule these surfaces are held to: no screen
// anywhere combines agreement and coverage into one score.
//
// Where the canvas draws a value this console cannot read, the block is left
// out rather than drawn empty. An artboard is a proposal about what an
// operator should see; a rendered page is a claim about what the ledger
// holds, and the two are not the same document. Every omission of that kind
// is named in `docs/operations.md`.
import { escapeHtml, renderGates, renderMetricValue } from './render.js';
import { CONSOLE_SCRIPT } from './script.js';
import type { MetricValue } from './render.js';

export interface RunRow {
  readonly runId: string;
  readonly ticketId: string;
  readonly state: string;
  readonly promptVer: string;
  readonly reason: string | null;
  readonly stepsUsed: number;
}

export type Theme = 'dark' | 'light';

/**
 * What the shell needs that no single surface owns.
 *
 * Passed rather than read here, because this module reaches nothing: the
 * theme comes off a cookie in the server, and the ledger name comes off the
 * connection string in the entry point.
 */
export interface Shell {
  readonly theme: Theme;
  /** The surface being shown, so the rail can mark it. */
  readonly path: string;
  /**
   * Runs waiting for a person, or null when this page did not count them.
   *
   * Null rather than zero. A zero badge says the queue is empty, and a page
   * that never asked cannot say that.
   */
  readonly approvals: number | null;
  /** Which ledger this console is bound to, without its credentials. */
  readonly ledger: string;
}

/**
 * The rail, in two groups.
 *
 * Two audiences with different units of work. A responder works a
 * conversation and a queue; an administrator audits a run and reads a band.
 * Five peers made every operator scan all five, and put the queue — the one
 * surface with a deadline on it — beside a latency report.
 *
 * `Conversations` has no listing of its own. A conversation is reached from
 * the run that answered it, because the ledger has no ordering over
 * conversations that means anything to a responder: `opened_at` is when a
 * problem started, not when it last needed attention.
 */
const GROUPS: readonly {
  readonly title: string;
  readonly surfaces: readonly { readonly href: string; readonly title: string }[];
}[] = [
  {
    title: 'Work',
    surfaces: [{ href: '/approvals', title: 'Approval queue' }],
  },
  {
    title: 'Instrument',
    surfaces: [
      { href: '/', title: 'Runs' },
      { href: '/bands', title: 'Control bands' },
      { href: '/latency', title: 'Partition latency' },
    ],
  },
];


/**
 * The theme the next click asks for, and the label that names it.
 *
 * The toggle is a link that sets a cookie
 * and returns. That is why `page` needs the path: the link has to come back
 * to the surface the operator was reading.
 */
function themeLink(shell: Shell): string {
  const next: Theme = shell.theme === 'dark' ? 'light' : 'dark';
  const back = encodeURIComponent(shell.path);
  return `<a class="chip" href="/theme?to=${next}&amp;back=${back}">`
    + `<span class="dot"></span>${next} theme</a>`;
}

/** The rail every surface renders beside. */
function rail(shell: Shell): string {
  const groups = GROUPS.map((group) => {
    const links = group.surfaces.map((surface) => {
      const on = surface.href === shell.path ? ' class="on"' : '';
      // The badge counts only what this page actually counted.
      const badge = surface.href === '/approvals' && shell.approvals !== null
        ? `<span class="badge">${escapeHtml(String(shell.approvals))}</span>`
        : '';
      return `<a href="${surface.href}"${on}>${escapeHtml(surface.title)}${badge}</a>`;
    }).join('');
    return `<div class="navgroup"><div class="lbl">${escapeHtml(group.title)}</div>${links}</div>`;
  }).join('');
  return [
    '<div class="rail">',
    '<div class="brand">',
    '<div class="m" style="font-size:15px; font-weight:600; letter-spacing:-.01em">auracle</div>',
    '<div class="lbl" style="margin-top:3px">operator console</div>',
    '</div>',
    `<div class="nav">${groups}</div>`,
    '<div class="railfoot">',
    '<div class="lbl">Bound to</div>',
    `<span class="chip"><span class="dot" style="color:var(--ok)"></span>${escapeHtml(shell.ledger)}</span>`,
    themeLink(shell),
    '</div>',
    '</div>',
  ].join('');
}

/** The shell every surface renders inside. */
export function page(title: string, body: string, shell: Shell): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)} — Auracle console</title>`,
    '<link rel="stylesheet" href="/console.css">',
    '</head><body>',
    `<div class="root" data-theme="${shell.theme}"><div class="shell">`,
    rail(shell),
    '<div class="main">',
    body,
    '</div></div></div>',
    // Last, so every element it binds to exists. Inline and pinned by a CSP
    // hash: a script the page did not ship cannot run, and this one stops
    // running the moment its text changes without the hash changing with it.
    `<script>${CONSOLE_SCRIPT}</script>`,
    '</body></html>',
  ].join('');
}

/** A surface header: what this page is, and what it is not. */
function head(title: string, says: string, chips: readonly string[] = []): string {
  return [
    '<div class="top">',
    `<div><div class="hdt">${escapeHtml(title)}</div>`,
    `<div class="hds">${escapeHtml(says)}</div></div>`,
    chips.length === 0 ? '' : `<div class="hol">${chips.join('')}</div>`,
    '</div>',
  ].join('');
}

/**
 * The palette a surface may colour something with.
 *
 * A closed set of token names rather than a colour string. Every caller today
 * passes a literal, so nothing is exploitable — but the value lands inside a
 * `style` attribute, which the content-security policy has to allow inline
 * and therefore cannot distinguish from an injected one. A union makes the
 * compiler the guard instead of the caller's care.
 */
type Token = 'ok' | 'warn' | 'hot' | 'crit' | 'accent' | 'dim' | 'mut';

function chip(text: string, token?: Token): string {
  const style = token === undefined ? '' : ` style="color:var(--${token})"`;
  return `<span class="chip"${style}>${escapeHtml(text)}</span>`;
}

/**
 * A short page that says why it is short.
 *
 * Every surface can be empty, and an empty page with no sentence on it reads
 * as a console that failed rather than as a ledger that holds nothing.
 */
function nothing(says: string): string {
  return `<div class="wrap"><p class="mut">${escapeHtml(says)}</p></div>`;
}

/** The state filter, as links. Every control here works without a script. */
export interface StateFilter {
  /** Every state the ledger can hold, in the order the rail shows them. */
  readonly states: readonly string[];
  /** The state being shown, or null for every state. */
  readonly active: string | null;
}

function filters(filter: StateFilter): string {
  const one = (href: string, label: string, on: boolean): string =>
    `<a href="${href}"${on ? ' class="on"' : ''}>${escapeHtml(label)}</a>`;
  return [
    '<div class="filters">',
    '<span class="lbl">state</span>',
    '<div class="seg">',
    one('/', 'all', filter.active === null),
    ...filter.states.map((state) =>
      one(`/?state=${encodeURIComponent(state)}`, state, filter.active === state)),
    '</div>',
    '</div>',
  ].join('');
}

export interface RunsPage {
  readonly runs: readonly RunRow[];
  readonly filter: StateFilter;
  /** The cap the query applied, so the footer can say the list is a page. */
  readonly limit: number;
}

/** Surface 1: the runs list. */
export function renderRuns(view: RunsPage): string {
  const header = head(
    'Runs',
    'One row for each run of the state machine, newest first.',
  ) + filters(view.filter);
  if (view.runs.length === 0) {
    return header + nothing(
      view.filter.active === null
        ? 'No runs.'
        // Not escaped here, because `nothing` escapes what it is given and
        // escaping twice renders the escape itself. The route also refuses a
        // state outside the ledger's vocabulary, but this module is a pure
        // function that takes what a caller hands it, so the escape has to
        // happen on this path rather than in the route alone.
        : `No run is in ${view.filter.active}.`,
    );
  }
  const rows = view.runs.map((run) => [
    '<tr>',
    `<td class="m"><a href="/run/${encodeURIComponent(run.runId)}">`,
    `${escapeHtml(run.runId.slice(0, 8))}</a></td>`,
    `<td class="m">${escapeHtml(run.ticketId)}</td>`,
    `<td><span class="st">${escapeHtml(run.state)}</span></td>`,
    `<td class="m">${escapeHtml(run.reason ?? '—')}</td>`,
    `<td class="m">${escapeHtml(run.promptVer)}</td>`,
    `<td class="m">${escapeHtml(String(run.stepsUsed))}</td>`,
    '</tr>',
  ].join(''));
  // The count is of the page, never of the ledger. This statement reads at
  // most `limit` rows, so a total here would be a number nothing counted.
  const foot = view.runs.length < view.limit
    ? `${view.runs.length} runs`
    : `the newest ${view.runs.length} runs, which is the page this reads`;
  return [
    header,
    '<table><thead><tr>',
    '<th>Run</th><th>Ticket</th><th>State</th><th>Reason</th><th>Prompt</th><th>Steps</th>',
    '</tr></thead><tbody>',
    ...rows,
    '</tbody></table>',
    `<div class="foot"><div>${escapeHtml(foot)}</div>`,
    '<div>every statement behind this page is a read, except the approval</div></div>',
  ].join('');
}

export interface RunDetail extends RunRow {
  readonly agreement: number | null;
  readonly coverage: number | null;
  readonly draftExternalId: string | null;
}

/** One journal row, worded for the timeline. */
export interface StepView {
  readonly stepId: string;
  readonly status: string;
  /** What this step recorded, in one line. Null when it recorded nothing. */
  readonly says: string | null;
  /** True while the outcome is still absent: in flight, or crashed. */
  readonly awaitingOutcome: boolean;
  /** True when a result was recorded and could not be read. */
  readonly malformed: boolean;
}

/** One document the retriever returned, in the order the ledger recorded. */
export interface DocumentView {
  readonly position: number;
  readonly docId: string;
  readonly title: string | null;
  readonly kind: string | null;
  readonly owner: string | null;
  /**
   * Whether the document still says what the run read.
   *
   * Three answers. Null means the question cannot be asked: the run recorded
   * no digest, or the id no longer resolves. A surface that drew null as
   * unchanged would vouch for a document nothing compared.
   */
  readonly bodyUnchanged: boolean | null;
  /** The title the run recorded, which is not today's. Null when none. */
  readonly titleAtRun: string | null;
}

/** One claim of the drafted reply, and what the judge said about it. */
export interface ClaimView {
  readonly index: number;
  readonly text: string;
  readonly docId: string;
  /**
   * The judge's verdict, or null when no verdict was recorded for it.
   *
   * Null is not "unsupported". A claim nobody judged and a claim the judge
   * refused are different facts, and the second is the one an operator has to
   * read before approving.
   */
  readonly supported: boolean | null;
}

/** The two gates as the journal recorded them, for one run. */
export interface GateReading {
  readonly agreement: number | null;
  readonly coverage: number | null;
  readonly agreementThreshold: number | null;
  readonly agreementDetail: string | null;
  readonly coverageBlock: number | null;
  readonly coverageReview: number | null;
}

/**
 * The message a run answered, as a surface draws it.
 *
 * Beside the reply rather than behind a link. An approver reading a reply and
 * its sources still cannot tell whether it answers the question, and that is
 * the same shape as the defect this evidence block was built for.
 */
export interface RequestView {
  readonly conversationId: string;
  readonly turnNumber: number;
  readonly bodyText: string | null;
  /** Named when there is no text. Never both null. */
  readonly absence: string | null;
}

/** The drafted reply, its claims and the documents behind them. */
export interface EvidenceView {
  /**
   * The reply the system drafted, or null when the run parked none.
   *
   * Not the text the relay will send: that is the helpdesk copy, which a
   * person may have edited since (DEC-11). Every surface drawing this says
   * which one it is drawing.
   */
  readonly draftBody: string | null;
  /** Null when the compose row recorded no claim list. */
  readonly claims: readonly ClaimView[] | null;
  /** Null when the run journalled no retrieve step. */
  readonly documents: readonly DocumentView[] | null;
  /**
   * A retrieval that completed and recorded a list nothing could read.
   *
   * Its own field, because `documents` has no value that carries it: null is
   * a run that never retrieved and the empty list is a retrieval that found
   * nothing. A surface that folded this into either would say the run did
   * something it did not.
   */
  readonly documentsMalformed: boolean;
}

/** Everything the run detail surface draws beyond the run row itself. */
export interface RunView extends RunDetail {
  readonly steps: readonly StepView[];
  readonly agreementThreshold: number | null;
  readonly agreementDetail: string | null;
  readonly coverageBlock: number | null;
  readonly coverageReview: number | null;
  readonly intentId: string | null;
  readonly decision: string | null;
  readonly policyReason: string | null;
  /** The draft, its claims and their sources. */
  readonly evidence: EvidenceView;
  /** The conversation this run answered, when it answered one. */
  readonly conversationId: string | null;
  /** The message this run answered, when it answered one. */
  readonly request: RequestView | null;
}

/** The colour each journal status carries in the timeline. */
const STATUS_COLOURS: Readonly<Record<string, string>> = {
  done: 'var(--ok)',
  abstained: 'var(--warn)',
  failed: 'var(--crit)',
  parking: 'var(--hot)',
  superseded: 'var(--dim)',
  started: 'var(--dim)',
};

function statusColour(status: string): string {
  return Object.hasOwn(STATUS_COLOURS, status) ? STATUS_COLOURS[status]! : 'var(--dim)';
}

/**
 * The steps the run journalled, in the order the coordinator walks them.
 *
 * The order is the reader module's, not the ledger's. `step_journal` carries
 * no timestamp and no sequence column, and its primary key sorts
 * alphabetically, which is not causal. For the same reason no step carries a
 * duration: none is stored, and a number computed from the run's own
 * timestamps would describe the run rather than the step.
 */
function timeline(steps: readonly StepView[]): string {
  if (steps.length === 0) {
    return '<p class="mut">This run journalled no step.</p>';
  }
  return `<div class="tl">${steps.map((step) => [
    '<div class="step"><div class="spine">',
    `<span class="k" style="background:${statusColour(step.status)}"></span>`,
    '<span class="l"></span>',
    '</div><div class="stepbody"><div class="steptop">',
    `<span class="m" style="font-size:12.5px; color:${statusColour(step.status)}">`,
    `${escapeHtml(step.stepId)}</span>`,
    `<span class="m" style="font-size:11px; color:var(--dim)">${escapeHtml(step.status)}</span>`,
    '</div>',
    step.awaitingOutcome
      ? '<div class="mut" style="font-size:11.5px">No outcome recorded. The run is in flight,'
        + ' or it stopped before it wrote one; the ledger cannot tell the two apart.</div>'
      : step.malformed
        ? '<div class="mut" style="font-size:11.5px">A result was recorded and could not be read.</div>'
        : step.says === null
          ? ''
          : `<div class="mut" style="font-size:11.5px">${escapeHtml(step.says)}</div>`,
    '</div></div>',
  ].join('')).join('')}</div>`;
}

/**
 * The documents the retriever returned, in the order it recorded them.
 *
 * A position, never a rank. DEC-21 fuses ranks and keeps no score, and the
 * fusion returns an ordered list of ids: the reranker may reorder that list
 * and nothing stored says whether it did. So the column says where the
 * document sits in what was written down, and claims nothing more.
 */
function evidence(documents: readonly DocumentView[] | null): string {
  if (documents === null) {
    return '<p class="mut">This run journalled no retrieval.</p>';
  }
  if (documents.length === 0) {
    return '<p class="mut">The retriever returned nothing.</p>';
  }
  return [
    '<div class="ev"><span class="lbl">#</span><span class="lbl">document</span>',
    '<span class="lbl">kind</span><span class="lbl">owner</span></div>',
    ...documents.map((doc) => [
      '<div class="ev">',
      `<span class="m" style="color:var(--dim)">${escapeHtml(String(doc.position))}</span>`,
      doc.title === null
        // The journal holds no foreign key to `document`, so an id can point
        // at a row that is gone. Saying so beats printing an id as a title.
        ? `<span class="mut">${escapeHtml(doc.docId)} — no such document today</span>`
        : `<span>${escapeHtml(doc.title)}</span>`,
      `<span class="m" style="font-size:11px; color:var(--mut)">${escapeHtml(doc.kind ?? '—')}</span>`,
      `<span class="m" style="font-size:11px; color:var(--mut)">${escapeHtml(doc.owner ?? '—')}</span>`,
      '</div>',
    ].join('')),
  ].join('');
}

/**
 * The drafted reply, with every claim tied to the document behind it.
 *
 * One builder, drawn by the run detail and by the approval pane. Two
 * assemblies of the same evidence would eventually disagree about a run, and
 * the one an approver reads is the one that has to be right.
 *
 * The claims are the draft. `composed.draft` is those texts joined, so this
 * renders them in order rather than rendering the draft beside them — which
 * would show the same sentences twice and leave a reader guessing which copy
 * carried the citation.
 *
 * Three states per claim, not two. A claim the judge refused is the warning
 * an approver came for. A claim nobody judged is not a refusal, and drawing
 * it as one would put a warning on a run the ledger never questioned.
 */
function evidenceBlock(
  view: EvidenceView,
  draftId: string | null,
  request: RequestView | null,
): string {
  if (view.draftBody === null && view.claims === null) {
    return requestBlock(request) + nothing('This run composed no reply.');
  }
  // Null and empty are different answers, here as everywhere else on this
  // console. A run journalled no readable retrieval is not a run whose
  // retrieval found nothing, and building a Map from `?? []` made the first
  // one report as the second — then labelled every cited document gone.
  const retrieved = view.documents;
  const sources = new Map((retrieved ?? []).map((doc) => [doc.docId, doc]));
  const claims = view.claims;
  const unsupported = (claims ?? []).filter((claim) => claim.supported === false).length;
  const unread = (claims ?? []).filter((claim) => claim.supported === null).length;

  return [
    requestBlock(request),
    '<div class="card"><header>',
    '<span class="lbl">The reply, as the system drafted it</span>',
    // Named precisely. The relay sends the helpdesk copy, which a person may
    // have edited since (DEC-11), so this is not "as it will be sent".
    draftId === null
      ? chip('parked in the ledger, no helpdesk draft')
      : chip(`helpdesk draft ${draftId}`),
    '</header><div class="body">',
    claims === null
      ? view.draftBody === null
        ? nothing('No draft was recorded for this run.')
        // A draft with no claim list is a run journalled before the claims
        // were written. The reply is shown whole, and the citations are not
        // available for it — which is a different thing from having none.
        : `<div class="prose">${escapeHtml(view.draftBody)}</div>`
          + '<p class="discl">This run recorded no claim list, so no sentence here'
          + ' carries its source. The reply is shown as it was drafted.</p>'
      // A recorded list with nothing in it. Rare and real, and it is not a
      // clean bill of health: drawing an empty prose block and then saying
      // every claim was accepted would have this console vouch for a reply
      // that makes no claims.
      : claims.length === 0
        ? nothing('This run recorded a claim list with no claims in it.')
        : claimList(claims, sources),
    claims === null || claims.length === 0
      ? ''
      : claimSummary(claims.length, unsupported, unread),
    '</div></div>',
    claims === null || claims.length === 0
      ? ''
      : sourceList(claims, sources, retrieved, view.documentsMalformed),
  ].join('');
}

/**
 * The message this run answered, above the reply it drafted.
 *
 * Null is a run that answered no turn: a V1-era run with no conversation, or
 * one recorded before the turn was stored on it. That is not the same as a
 * turn whose text nobody kept, which the absence names — so a run with no turn
 * draws nothing here rather than an absence about a turn that never existed.
 */
function requestBlock(request: RequestView | null): string {
  if (request === null) return '';
  return [
    '<div class="card"><header>',
    '<span class="lbl">The message this answers</span>',
    chip(`turn ${request.turnNumber}`),
    '</header><div class="body">',
    // Decided by the absence, not by re-testing the text. The reader trims
    // before it names one, and a renderer comparing against the empty string
    // disagreed with it: a message of spaces arrived named `empty_message`
    // and was drawn as text, which is the blank the name exists to prevent.
    request.absence !== null || request.bodyText === null
      ? `<p class="absent">${escapeHtml(absenceSays(MESSAGE_ABSENCE, request.absence ?? 'not_retained'))}</p>`
      : `<div class="prose">${escapeHtml(request.bodyText)}</div>`,
    // A later turn is context this does not show, so the whole thread is one
    // click away rather than assumed to be unnecessary.
    `<p class="discl">Read the whole conversation <a href="/conversation/${
      encodeURIComponent(request.conversationId)}">as a thread</a>.</p>`,
    '</div></div>',
  ].join('');
}

/** The claims in draft order, each marked with what the judge said. */
function claimList(
  claims: readonly ClaimView[],
  sources: ReadonlyMap<string, DocumentView>,
): string {
  return `<div class="prose">${claims.map((claim) => {
    const mark = claim.supported === false
      ? ' unsupported'
      : claim.supported === null ? ' unread' : '';
    const source = sources.get(claim.docId);
    const title = source?.title ?? claim.docId;
    return [
      `<span class="claim${mark}" id="claim-${escapeHtml(String(claim.index))}"`,
      ` data-source="${escapeHtml(claim.docId)}">`,
      escapeHtml(claim.text),
      `<a class="cite" href="#src-${escapeHtml(claim.docId)}"`,
      ` title="${escapeHtml(title)}">${escapeHtml(String(claim.index + 1))}</a>`,
      '</span>',
    ].join('');
  }).join(' ')}</div>`;
}

/**
 * What the marks add up to, in words rather than a second coverage number.
 *
 * Deliberately not a fraction. The gate row's coverage is what the policy
 * engine read, and a second number computed from these marks would be a
 * recount that can disagree with it. This counts the claims a person has to
 * look at, which is a different question.
 *
 * Both counts, independently. A ladder reported the unread claims only when
 * nothing was refused, so a reply with one of each said nothing about the
 * claim nobody judged — the two-state collapse this block exists to refuse.
 */
function claimSummary(total: number, unsupported: number, unread: number): string {
  const parts: string[] = [];
  if (unsupported > 0) {
    parts.push(`${unsupported} of ${total} claims cite a document that does not support them`);
  }
  if (unread > 0) {
    parts.push(`${unread} of ${total} carry no recorded verdict`);
  }
  const says = parts.length === 0
    ? `every claim of ${total} carries a document the judge accepted`
    : parts.join('; ');
  return `<p class="discl">${escapeHtml(says)}</p>`;
}

/**
 * The documents the claims cite, and whether they still say it.
 *
 * `retrieved` is nullable and the Map is not, because three things can be
 * true of a cited id and they are not the same fact:
 *
 *   - the run journalled no readable retrieval, so nothing here can be
 *     checked at all;
 *   - the id was retrieved and no longer resolves, so the document left the
 *     index after the run read it;
 *   - the id was never retrieved, so the reply cites something the retriever
 *     did not return — which is the more alarming of the two and used to
 *     render as the other.
 */
function sourceList(
  claims: readonly ClaimView[],
  sources: ReadonlyMap<string, DocumentView>,
  retrieved: readonly DocumentView[] | null,
  malformed: boolean,
): string {
  const cited = [...new Set(claims.map((claim) => claim.docId))];
  return [
    '<div class="card"><header>',
    '<span class="lbl">The documents these claims cite</span>',
    // Two counts, never a fraction. A cited id that was not retrieved makes
    // the numerator exceed the denominator, so `3 of 2 retrieved` was a
    // reachable sentence — and with no retrieval journalled the denominator
    // was a zero nobody measured.
    chip(retrieved === null
      ? malformed
        ? `${cited.length} cited · the retrieval could not be read`
        : `${cited.length} cited · no retrieval journalled`
      : `${cited.length} cited · ${retrieved.length} retrieved`),
    '</header><div class="body">',
    ...cited.map((docId) => {
      const doc = sources.get(docId);
      const moved = doc?.bodyUnchanged === false;
      return [
        `<div class="src" id="src-${escapeHtml(docId)}" data-source="${escapeHtml(docId)}">`,
        `<a class="m" href="/document/${encodeURIComponent(docId)}">${escapeHtml(docId)}</a>`,
        ' ',
        doc === undefined
          ? retrieved === null
            ? malformed
              ? '<span class="mut">this run recorded a retrieval nothing could read</span>'
              : '<span class="mut">this run journalled no retrieval, so nothing here is checked</span>'
            : '<span class="mut" style="color:var(--hot)">not among the documents this run retrieved</span>'
          : doc.title === null
            ? '<span class="mut">no such document today</span>'
            : `<span>${escapeHtml(doc.title)}</span>`,
        moved
          // The claim rested on text that is no longer there. Said plainly,
          // because a reader checking a citation against today's document
          // would otherwise conclude the claim was wrong.
          ? ' <span class="chip" style="color:var(--warn)">changed since this run read it</span>'
          : doc !== undefined && doc.bodyUnchanged === null
            ? ' <span class="chip" style="color:var(--dim)">not compared</span>'
            : '',
        '</div>',
      ].join('');
    }),
    '</div></div>',
  ].join('');
}

/** Surface 2: one run, with its two gates shown apart. */
export function renderRunDetail(run: RunView): string {
  return [
    head('Run detail', 'One run, and what the ledger recorded as it walked.', [
      chip(run.state),
      chip(run.promptVer),
    ]),
    '<div class="wrap">',
    '<div class="hd"><div>',
    `<div class="m" style="font-size:17px; font-weight:600">${escapeHtml(run.runId)}</div>`,
    `<div class="hds">ticket ${escapeHtml(run.ticketId)}</div>`,
    '</div>',
    '<dl class="kv">',
    `<dt>intent</dt><dd>${escapeHtml(run.intentId ?? '—')}</dd>`,
    `<dt>decision</dt><dd>${escapeHtml(run.decision ?? '—')}</dd>`,
    `<dt>policy reason</dt><dd>${escapeHtml(run.policyReason ?? '—')}</dd>`,
    `<dt>escalation</dt><dd>${escapeHtml(run.reason ?? '—')}</dd>`,
    `<dt>steps</dt><dd>${escapeHtml(String(run.stepsUsed))}</dd>`,
    `<dt>draft</dt><dd>${escapeHtml(run.draftExternalId ?? '—')}</dd>`,
    '</dl></div>',
    '<div class="cols">',
    '<div class="card"><header>',
    '<span class="lbl">Step journal</span>',
    `<span class="chip">${escapeHtml(String(run.steps.length))} entries · written before each act</span>`,
    '</header><div class="body">',
    timeline(run.steps),
    '</div></div>',
    '<div style="display:flex; flex-direction:column; gap:16px">',
    '<div class="card"><header>',
    '<span class="lbl">The two gates</span>',
    '<span class="chip">independent · never combined</span>',
    '</header><div class="body">',
    renderGates({
      agreement: run.agreement,
      coverage: run.coverage,
      agreementThreshold: run.agreementThreshold,
      agreementDetail: run.agreementDetail,
      coverageBlock: run.coverageBlock,
      coverageReview: run.coverageReview,
    }),
    // The thresholds never decide a customer reply: such a reply already
    // needs approval (DEC-12), and the policy engine returns that verdict
    // before it reads either one.
    run.policyReason === 'customer_visible'
      ? '<p class="discl" style="margin-top:14px">The policy engine returned'
        + ' <span class="m">customer_visible</span> before it read either threshold.'
        + ' A customer reply always waits for a person.</p>'
      : '',
    '</div></div>',
    '<div class="card"><header>',
    '<span class="lbl">Retrieved evidence</span>',
    '<span class="chip">the order the ledger recorded</span>',
    '</header><div class="body">',
    evidence(run.evidence.documents),
    '</div></div>',
    // Spanning both columns rather than placed after them. Prose inside a
    // 326px grid track is prose at forty characters, and the measure is what
    // makes a reply readable — but counting closing tags to escape the grid
    // is arithmetic that breaks silently. The span is declared instead.
    '<div class="full">',
    evidenceBlock(run.evidence, run.draftExternalId, run.request),
    run.conversationId === null
      ? ''
      : `<p class="discl">This run answered a turn of <a href="/conversation/${
        encodeURIComponent(run.conversationId)}">its conversation</a>.</p>`,
    '</div>',
    '</div></div>',
  ].join('');
}

/**
 * Surface 3: the approval queue, and the console's one write.
 *
 * A list of everything waiting, beside the one run the operator is looking
 * at. One, not all of them: the queue is deliberately uncapped, because
 * capping it would drop the oldest waiting replies off the end and show an
 * operator a queue they had finished. A first version drew a full card for
 * every row of that uncapped list, so a 476-run queue rendered a page of 8 MB
 * that repeated the list beside itself.
 *
 * The selection travels in the query string, because this console ships no
 * JavaScript. An absent or unknown selection falls back to the head of the
 * queue, which is the run an operator works next.
 */
/** A waiting run, with the journal read for the one the operator opened. */
export interface ApprovalView extends RunDetail {
  /**
   * The gate values, read for the drawn selection.
   *
   * This surface drew a dash for both, because reading a journal for every
   * waiting run would be one statement per row of an uncapped list. It reads
   * one journal now — for the run it draws — so the dash was saying "not read
   * by the console" about a value the console had.
   */
  readonly gates: GateReading | null;
  /**
   * The draft and its claims, or null when this run's journal was not read.
   *
   * Read for the drawn selection alone. The queue is uncapped by design, and
   * reading a journal for every waiting run would be one statement per row of
   * a list that has been 476 rows long.
   */
  readonly evidence: EvidenceView | null;
  /** The message this run answered, when it answered one. */
  readonly request: RequestView | null;
}

export function renderApprovals(
  runs: readonly RunDetail[],
  outcome: string,
  selected: string | null,
  evidence: EvidenceView | null = null,
  gates: GateReading | null = null,
  request: RequestView | null = null,
): string {
  const header = head(
    'Approval queue',
    'Every customer reply waits for a person. This list is not capped, so the oldest is on it.',
    [chip(`${runs.length} waiting`)],
  );
  if (runs.length === 0) {
    return header + outcome + nothing('Nothing is waiting for a person.');
  }
  const shown = runs.find((run) => run.runId === selected) ?? runs[0]!;
  const drawn: ApprovalView = { ...shown, evidence, gates, request };
  return [
    header,
    outcome,
    '<div class="split">',
    '<div class="list">',
    `<div class="lhd"><span class="lbl">Waiting · ${escapeHtml(String(runs.length))}</span></div>`,
    ...runs.map((run) => [
      `<a class="item${run.runId === shown.runId ? ' on' : ''}"`,
      ` href="/approvals?run=${encodeURIComponent(run.runId)}">`,
      `<div class="m" style="font-size:12.5px">${escapeHtml(run.ticketId)}</div>`,
      `<div class="m" style="font-size:10.5px; color:var(--dim)">${escapeHtml(run.runId.slice(0, 8))}`,
      ` · ${escapeHtml(run.reason ?? 'no reason journalled')}</div>`,
      '</a>',
    ].join('')),
    '</div>',
    `<div class="pane">${approvalCard(drawn)}</div>`,
    '</div>',
  ].join('');
}

/**
 * One waiting run, and everything a person needs to decide about it.
 *
 * The evidence is the point. This surface used to draw an Approve button
 * above a reply the approver could not read, which is DEC-40 permitting a
 * console to approve while the console withheld the thing being approved.
 */
function approvalCard(run: ApprovalView): string {
  return [
    '<div class="card"><header>',
    `<span class="m" style="font-size:12.5px">${escapeHtml(run.ticketId)}</span>`,
    `<span class="chip">${escapeHtml(run.state)}</span>`,
    '</header><div class="body">',
    // What a person needs to decide, rather than an id and a button. DEC-12
    // puts a person on every customer reply, so the queue has to tell them
    // which ticket, what state it is in and why it stopped.
    '<dl class="kv">',
    `<dt>run</dt><dd><a href="/run/${encodeURIComponent(run.runId)}">${escapeHtml(run.runId)}</a></dd>`,
    `<dt>reason</dt><dd>${escapeHtml(run.reason ?? '—')}</dd>`,
    `<dt>draft</dt><dd>${escapeHtml(run.draftExternalId ?? '—')}</dd>`,
    '</dl>',
    renderGates(run.gates === null
      ? { agreement: run.agreement, coverage: run.coverage }
      : {
        agreement: run.gates.agreement,
        coverage: run.gates.coverage,
        agreementThreshold: run.gates.agreementThreshold,
        agreementDetail: run.gates.agreementDetail,
        coverageBlock: run.gates.coverageBlock,
        coverageReview: run.gates.coverageReview,
      }),
    // The reply, before the button that sends it.
    run.evidence === null
      ? nothing('The journal for this run has not been read.')
      : evidenceBlock(run.evidence, run.draftExternalId, run.request),
    run.draftExternalId === null
      ? '<p class="discl">No draft is parked, so this cannot be approved here.</p>'
      : [
          // No text box. The draft parks in the helpdesk and is edited there
          // (DEC-11, DEC-40); the relay sends that draft verbatim, so a body
          // typed here would be recorded and never sent.
          '<div class="warnbar"><span class="dot" style="color:var(--accent); margin-top:5px"></span>',
          '<div>The reply above is what the system drafted. The helpdesk holds the copy the',
          ' relay sends, so edit it there — a person may have changed it since. This sends that',
          ' copy as it stands, and a sent reply cannot be recalled.</div></div>',
          '<form method="post" action="/approve">',
          `<input type="hidden" name="runId" value="${escapeHtml(run.runId)}">`,
          '<button class="btn primary" type="submit">Approve</button>',
          '</form>',
        ].join(''),
    '</div></div>',
  ].join('');
}

/** One turn of a conversation, as the reader returned it. */
export interface TurnView {
  readonly turnNumber: number;
  readonly ticketId: string;
  readonly bodyText: string | null;
  readonly messageAbsence: string | null;
  readonly replyText: string | null;
  readonly replyAbsence: string | null;
  readonly runId: string | null;
  readonly runState: string | null;
  readonly runAttempts: number;
}

/** One customer problem, and every turn of it. */
export interface ThreadView {
  readonly conversationId: string;
  readonly primaryTicketId: string;
  readonly state: string;
  readonly participantNamed: boolean;
  readonly turns: readonly TurnView[];
}

/**
 * What each absence means, in the words a responder needs.
 *
 * Six codes and six sentences. They are what the reader distinguishes, and a
 * surface that rendered two of them alike would send an operator to the wrong
 * place — which is the whole reason the reader distinguishes them.
 */
const REPLY_ABSENCE: Readonly<Record<string, string>> = {
  handled_automatically: 'answered by an internal write; no reply was sent to the customer',
  approved_without_reply: 'a person approved an action here; no reply text was recorded',
  awaiting_approval: 'a reply is drafted and waiting for a person',
  in_flight: 'this run has not finished',
  no_reply_sent: 'the run stopped without sending a reply',
  not_retained: 'no run joins this turn, so nothing here can say what happened',
};

const MESSAGE_ABSENCE: Readonly<Record<string, string>> = {
  not_retained: 'the text of this message was not kept',
  empty_message: 'the customer sent no text',
};

/** A named absence, or the id itself when the reader learns a seventh. */
function absenceSays(table: Readonly<Record<string, string>>, code: string): string {
  return Object.hasOwn(table, code) ? table[code]! : code;
}

/** Surface 6: one conversation, read the way a responder reads it. */
export function renderConversation(thread: ThreadView): string {
  return [
    head('Conversation', 'One customer problem, and every turn of it.', [
      chip(thread.state, thread.state === 'open' ? 'accent' : 'dim'),
      chip(`${thread.turns.length} ${thread.turns.length === 1 ? 'turn' : 'turns'}`),
      // Whether it is bound to somebody, never who. An approver already sees
      // the message that address sent.
      chip(thread.participantNamed ? 'participant named' : 'no participant named'),
    ]),
    '<div class="wrap">',
    '<div class="hd"><div>',
    `<div class="m" style="font-size:17px; font-weight:600">${escapeHtml(thread.primaryTicketId)}</div>`,
    `<div class="hds">conversation ${escapeHtml(thread.conversationId)}</div>`,
    '</div></div>',
    thread.turns.length === 0
      ? nothing('This conversation holds no turn.')
      : thread.turns.map((turn) => turnBlock(turn)).join(''),
    '</div>',
  ].join('');
}

/** One turn: what the customer wrote, and what the system did about it. */
function turnBlock(turn: TurnView): string {
  return [
    '<div class="turn">',
    '<div class="turnmeta">',
    `<span class="lbl">turn ${escapeHtml(String(turn.turnNumber))}</span>`,
    `<span class="m" style="font-size:10.5px; color:var(--dim)">${escapeHtml(turn.ticketId)}</span>`,
    turn.runId === null
      ? '<span class="m" style="font-size:10.5px; color:var(--dim)">no run</span>'
      : `<a class="m" style="font-size:10.5px" href="/run/${encodeURIComponent(turn.runId)}">${
        escapeHtml(turn.runState ?? 'run')}</a>`,
    // More than one run worked this turn, which means the consumer retried.
    // Counted rather than drawn as extra turns: a turn that took three runs
    // to abandon is one message the customer sent.
    turn.runAttempts > 1
      ? `<span class="m" style="font-size:10.5px; color:var(--warn)">${
        escapeHtml(String(turn.runAttempts))} attempts</span>`
      : '',
    '</div>',
    '<div class="said">',
    '<div class="who">the customer wrote</div>',
    // The absence decides here too, for the reason above.
    turn.messageAbsence !== null || turn.bodyText === null
      ? `<p class="absent">${escapeHtml(absenceSays(MESSAGE_ABSENCE, turn.messageAbsence ?? 'not_retained'))}</p>`
      : `<div class="prose">${escapeHtml(turn.bodyText)}</div>`,
    '</div>',
    '<div class="said">',
    '<div class="who">the system replied</div>',
    turn.replyText === null
      ? `<p class="absent">${escapeHtml(absenceSays(REPLY_ABSENCE, turn.replyAbsence ?? 'not_retained'))}</p>`
      : `<div class="prose">${escapeHtml(turn.replyText)}</div>`,
    '</div>',
    '</div>',
  ].join('');
}

/** One document of the index, as it stands now. */
export interface DocumentPage {
  readonly docId: string;
  readonly kind: string;
  readonly title: string;
  readonly body: string;
  readonly owner: string;
  readonly reviewBy: string;
  readonly fresh: boolean;
}

/** Surface 7: a cited document, so a person can check the citation. */
export function renderDocument(doc: DocumentPage): string {
  return [
    head('Evidence base', 'One document of the index, as it stands now.', [
      chip(doc.kind),
      chip(doc.owner),
      // DEC-23. A document past its review date leaves the automatic path,
      // and a claim resting on one is a claim resting on unreviewed text.
      doc.fresh
        ? chip(`in review until ${doc.reviewBy}`, 'ok')
        : chip(`review date passed ${doc.reviewBy}`, 'warn'),
    ]),
    '<div class="wrap">',
    '<div class="hd"><div>',
    `<div style="font-size:17px; font-weight:600">${escapeHtml(doc.title)}</div>`,
    `<div class="hds m">${escapeHtml(doc.docId)}</div>`,
    '</div></div>',
    '<div class="card"><header>',
    '<span class="lbl">What this document says today</span>',
    // Today's, not the run's. `document` rows are rewritten in place on
    // reindex, and a run detail says whether the text moved since it read it.
    chip('rewritten in place on reindex'),
    '</header><div class="body">',
    `<div class="prose">${escapeHtml(doc.body)}</div>`,
    '</div></div>',
    '</div>',
  ].join('');
}

export interface BandRow {
  /** The UTC day judged. Named, because a surface that shows a verdict
   * without its day cannot be checked against `pnpm run bands`. */
  readonly day: string;
  readonly metric: string;
  readonly sample: MetricValue;
  readonly verdict: string | null;
  /** The action alone, so the card can colour by it. Null with no verdict. */
  readonly action: string | null;
  /** Runs the value was computed over. */
  readonly count: number;
  /** The baseline the day was judged against, or null when none formed. */
  readonly baseline: { readonly mean: string; readonly sigma: string; readonly days: number } | null;
  /** The measured days before this one, oldest first, for the sparkline. */
  readonly history: readonly (number | null)[];
}

/** The colour bands.yaml's action asks for. */
const ACTION_COLOURS: Readonly<Record<string, string>> = {
  in_band: 'var(--ok)',
  log: 'var(--warn)',
  diagnose: 'var(--hot)',
  propose_change: 'var(--crit)',
};

function actionColour(action: string | null): string {
  if (action === null) return 'var(--dim)';
  return Object.hasOwn(ACTION_COLOURS, action) ? ACTION_COLOURS[action]! : 'var(--dim)';
}

/**
 * The measured days as a line, or nothing.
 *
 * Drawn from the same samples the baseline was computed over, so the line and
 * the verdict cannot disagree. A day that measured nothing breaks the line
 * rather than dropping to the floor: a gap is an absence and a zero is a
 * measurement.
 */
function sparkline(history: readonly (number | null)[]): string {
  const measured = history.filter((v): v is number => v !== null);
  if (measured.length < 2) return '';
  const low = Math.min(...measured);
  const high = Math.max(...measured);
  const span = high - low;
  const x = (i: number): number => (history.length === 1 ? 0 : (i / (history.length - 1)) * 560);
  const y = (v: number): number => (span === 0 ? 48 : 88 - ((v - low) / span) * 80);
  let path = '';
  let pen = false;
  for (const [i, value] of history.entries()) {
    if (value === null) { pen = false; continue; }
    path += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(value).toFixed(1)} `;
    pen = true;
  }
  return [
    '<svg class="spark" viewBox="0 0 560 96" preserveAspectRatio="none" aria-hidden="true">',
    `<path d="${path.trim()}" fill="none" stroke="var(--mut)" stroke-width="1.4"></path>`,
    '</svg>',
  ].join('');
}

/** Surface 4: the control bands, with a named shortfall where there is no verdict. */
export function renderBands(rows: readonly BandRow[]): string {
  const header = head(
    'Control bands',
    'One UTC day judged against the thirty measured days before it. The day is never inside its own baseline.',
    rows.length === 0 ? [] : [chip(`day ${rows[0]!.day}`)],
  );
  if (rows.length === 0) {
    return header + nothing('No days measured in the window.');
  }
  return [
    header,
    '<div class="wrap">',
    '<div class="grid">',
    ...rows.map(bandCard),
    '</div>',
    legend(),
    '</div>',
  ].join('');
}

function bandCard(row: BandRow): string {
  const colour = actionColour(row.action);
  return [
    '<div class="card stack"><header>',
    `<span class="m" style="font-size:12.5px">${escapeHtml(row.metric)}</span>`,
    row.verdict === null
      ? '<span class="verdict" style="color:var(--dim)">no verdict</span>'
      : `<span class="verdict" style="color:${colour}">${escapeHtml(row.verdict)}</span>`,
    '</header><div class="body">',
    '<div style="display:flex; align-items:baseline; gap:11px; flex-wrap:wrap">',
    `<span class="big" style="color:${colour}">${renderMetricValue(row.sample)}</span>`,
    `<span class="m" style="font-size:11.5px; color:var(--dim)">over ${escapeHtml(String(row.count))} runs</span>`,
    '</div>',
    sparkline(row.history),
    row.baseline === null
      ? '<div class="shortfall"><span class="lbl" style="color:var(--warn)">No baseline</span>'
        + '<span style="font-size:11.5px; color:var(--mut)">The window carried too few measured days'
        + ' to compare against.</span></div>'
      : [
          '<dl class="kv">',
          `<dt>baseline mean</dt><dd>${escapeHtml(row.baseline.mean)}</dd>`,
          `<dt>baseline sigma</dt><dd>${escapeHtml(row.baseline.sigma)}</dd>`,
          `<dt>days in window</dt><dd>${escapeHtml(String(row.baseline.days))}</dd>`,
          '</dl>',
        ].join(''),
    '</div></div>',
  ].join('');
}

/** What each action means, taken from `bands.yaml`. */
function legend(): string {
  const rows: readonly [string, string, string][] = [
    ['var(--warn)', '1 sigma', 'Log it. Take no action.'],
    ['var(--hot)', '2 sigma', 'Diagnose, read only. Change nothing.'],
    ['var(--crit)', '3 sigma', 'A change is warranted. Open a pull request. This console opens none.'],
    ['var(--dim)', 'no verdict', 'A quantity that could not be measured is never reported as zero.'],
  ];
  return [
    '<div class="legend">',
    ...rows.map(([colour, name, says]) => [
      `<div class="lg"><span class="dot" style="color:${colour}; margin-top:5px"></span><div>`,
      `<div class="m" style="font-size:11.5px">${escapeHtml(name)}</div>`,
      `<div style="font-size:11px; color:var(--mut)">${escapeHtml(says)}</div>`,
      '</div></div>',
    ].join('')),
    '</div>',
  ].join('');
}

export interface Percentile {
  readonly label: string;
  readonly text: string;
  /** Share of the widest value on this surface, so the bars compare. */
  readonly share: number;
}

export interface LatencyRow {
  readonly partition: number;
  readonly wait: readonly Percentile[];
  readonly service: readonly Percentile[];
  readonly runs: number;
  /** Counts the job reports beside the figures, already worded. */
  readonly caveats: readonly string[];
}

/** Surface 5: queue wait and service time per partition. */
export function renderLatency(rows: readonly LatencyRow[]): string {
  const header = head(
    'Partition latency',
    'Queue wait and service time for each partition, as percentiles. An average is where a tail hides.',
    rows.length === 0 ? [] : [chip(`${rows.length} partitions`)],
  );
  if (rows.length === 0) return header + nothing('No partition has run.');
  return [
    header,
    '<div class="wrap">',
    '<div class="card">',
    '<div class="row head">',
    '<span class="lbl">part</span>',
    '<span class="lbl">queue wait — arrival to pickup</span>',
    '<span class="lbl">service time — pickup to terminal state</span>',
    '<span class="lbl" style="text-align:right">not measured</span>',
    '</div>',
    ...rows.map(latencyRow),
    '</div>',
    '<div class="note"><span class="dot" style="color:var(--accent); margin-top:5px"></span>',
    '<div>One consumer owns each partition, so a slow run holds up every ticket behind it in the',
    ' same partition. That delay is V2 open item 7, and this page is its measurement rather than',
    ' its correction.</div></div>',
    '</div>',
  ].join('');
}

function latencyRow(row: LatencyRow): string {
  const bars = (values: readonly Percentile[], colour: string): string =>
    `<div class="pcts">${values.map((p) => [
      '<div class="pl">',
      `<span class="lbl">${escapeHtml(p.label)}</span>`,
      `<span class="track"><i style="width:${(p.share * 100).toFixed(1)}%; background:${colour}"></i></span>`,
      `<span class="pv" style="color:var(--mut)">${escapeHtml(p.text)}</span>`,
      '</div>',
    ].join('')).join('')}</div>`;
  return [
    '<div class="row">',
    '<div>',
    `<div class="m" style="font-size:13px">${escapeHtml(String(row.partition))}</div>`,
    `<div class="m" style="font-size:10.5px; color:var(--dim)">${escapeHtml(String(row.runs))} runs</div>`,
    '</div>',
    bars(row.wait, 'var(--mut)'),
    bars(row.service, 'var(--accent)'),
    // Never folded into the figures. A run with no arrival time has no wait,
    // and counting it as a wait of zero would invent the most flattering
    // number about the runs the ledger knows least about.
    `<div class="hol">${row.caveats.length === 0
      ? '<span class="chip" style="color:var(--ok)"><span class="dot"></span>all measured</span>'
      : row.caveats.map((text) => chip(text, 'warn')).join('')}</div>`,
    '</div>',
  ].join('');
}

/**
 * What the ledger said about the approval just posted, in plain words.
 *
 * Every `ApproveOutcome` variant gets a sentence. A queue that reloaded
 * silently told the operator nothing, and `draft_missing` in particular is a
 * refusal that looked exactly like success.
 */
const OUTCOMES: Readonly<Record<string, string>> = {
  approved: 'Approved. The reply is queued for sending.',
  unknown_run: 'That run is not in the ledger.',
  not_awaiting_approval: 'That run is not waiting for approval.',
  superseded: 'Another action already holds this key, so nothing was sent.',
  stale_epoch: 'Another owner took this ticket. Nothing was sent.',
  draft_missing: 'The parked draft is gone, so nothing was sent.',
};

export function renderOutcome(outcome: string): string {
  // `Object.hasOwn`, never a bare read. A plain object literal inherits from
  // Object.prototype, so `?outcome=toString` resolved a function, `escapeHtml`
  // called `.replace` on it and the approval queue became a 500 page. This is
  // the same defect the policy engine's per-intent map had, in a second place.
  const said = Object.hasOwn(OUTCOMES, outcome) ? OUTCOMES[outcome] : undefined;
  return [
    '<div class="wrap" style="padding-bottom:0">',
    `<p class="outcome" data-outcome="${escapeHtml(outcome)}">`,
    // An outcome this console does not know is still shown, by name. A
    // silent fall-through would be the defect this function exists to fix.
    escapeHtml(said ?? `The ledger answered: ${outcome}`),
    '</p></div>',
  ].join('');
}
