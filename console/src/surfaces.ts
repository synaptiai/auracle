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
import { escapeHtml, initialsOf, isReadableTime, renderGates, renderMetricValue } from './render.js';
// The engine's own record of which rules reach which gate. Re-deriving that
// order here would be a second copy of it, free to drift from the one the
// policy engine runs.
import {
  POLICY_REASONS, reachedAgreementGate, readCoverageGate,
} from 'auracle/policy';
// The class the coordinator derives `isIrreversible` from. Imported rather
// than spelled here, so the console and the engine cannot disagree about
// which action is the permanent one.
import { COMPENSATION_ACTION_CLASS } from 'auracle/domain';
import type { PolicyReason } from 'auracle/policy';
import { replyDigest } from 'auracle/ledger-read';
import type { OutboxStatus } from 'auracle/ledger-read';
import type { ConsoleApproveOutcome } from './approve.js';
import { CONSOLE_SCRIPT } from './script.js';
import { groupQueue } from './queue.js';
import type { QueueGroup } from './queue.js';
import type { MetricValue } from './render.js';

export interface RunRow {
  readonly runId: string;
  readonly ticketId: string;
  readonly state: string;
  readonly promptVer: string;
  /** Why the run escalated. Null for a run that has not escalated. */
  readonly reason: string | null;
  /**
   * Which policy rule sent the run to a person, from the gate row.
   *
   * The question a person working the queue asks first, and a different
   * question from `reason` above. A waiting run has not escalated, so this
   * is the only one of the two that can answer.
   */
  readonly gateReason: string | null;
  /** The classified intent, so a row says what the ticket is about. */
  readonly intentId: string | null;
  /**
   * Coverage the gate read, from the gate journal row.
   *
   * Named apart from `RunDetail.coverage`, which the run detail replaces
   * with the value its own journal read returns. One name for both would let
   * that replacement erase the value this row was listed with.
   */
  readonly gateCoverage: number | null;
  /** When the ledger opened the run, so a surface ordered by time shows it. */
  readonly createdAt: Date | null;
  readonly stepsUsed: number;
  /**
   * DEC-47: the product of the channel this run's message arrived on, or
   * null when that channel mapped to no product.
   *
   * Null is a value on the queue, not a gap: a run whose channel the map
   * does not name is its own chip and its own row of words. A surface that
   * drew nothing for it would read as a product nobody had chosen.
   */
  readonly product: string | null;
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
   * Where the theme toggle returns, when that is more than the path: a case
   * or the queue with the rule a person chose. The server checks it again.
   */
  readonly back?: string;
  /**
   * Runs waiting for a person, or null when this page did not count them.
   *
   * Null rather than zero. A zero badge says the queue is empty, and a page
   * that never asked cannot say that.
   */
  readonly approvals: number | null;
  /** Which ledger this console is bound to, without its credentials. */
  readonly ledger: string;
  /**
   * The reviewer this request resolved to, as the ledger would record them
   * (DEC-42, DEC-45).
   *
   * Never null, and not a placeholder when nobody is named: the gate refuses
   * such a request before any page is built, so a page that exists has a
   * reviewer behind it.
   */
  readonly reviewer: string;
}

/**
 * The rail's groups: the work, the knowledge behind it, and administration.
 *
 * A reviewer clears a queue, and an engineer audits a run or reads a band.
 * The work group comes first because it is the one with a deadline on it;
 * the surfaces an engineer audits sit under Admin, out of that path, beside
 * the design notes that say why the console works this way. The queue is also
 * the page the console opens on, at `/`.
 *
 * A group with no surface behind it is left out rather than drawn as a
 * heading over nothing, so the knowledge group appears with its first screen.
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
    surfaces: [{ href: '/', title: 'Needs a person' }],
  },
  // Declared with no surface, so its place between the work and the admin
  // surfaces is fixed before its first screen exists. It draws nothing yet.
  { title: 'Knowledge', surfaces: [] },
  {
    title: 'Admin',
    surfaces: [
      { href: '/runs', title: 'Runs' },
      { href: '/bands', title: 'Control bands' },
      { href: '/latency', title: 'Partition latency' },
      { href: '/notes', title: 'Design notes' },
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
  const back = encodeURIComponent(shell.back ?? shell.path);
  return `<a class="chip" href="/theme?to=${next}&amp;back=${back}">`
    + `<span class="dot"></span>${next} theme</a>`;
}

/**
 * Who is working, at the foot of the rail.
 *
 * The reviewer this request resolved to. The sub-line names what every value
 * here has in common: the roster holds it and it is active (DEC-45). Where
 * the name came from — a proxy header, a development stand-in — is the
 * ledger's record, not the rail's.
 */
function reviewerBlock(reviewer: string): string {
  return [
    '<div class="reviewer">',
    `<span class="avatar m">${escapeHtml(initialsOf(reviewer))}</span>`,
    '<div>',
    `<div class="rname">${escapeHtml(reviewer)}</div>`,
    '<div class="rsub">on the reviewer roster</div>',
    '</div>',
    '</div>',
  ].join('');
}

/** The rail every surface renders beside. */
function rail(shell: Shell): string {
  const groups = GROUPS.filter((group) => group.surfaces.length > 0).map((group) => {
    const links = group.surfaces.map((surface) => {
      // A case is the queue's work, so the queue stays marked while one is open.
      const on = surface.href === shell.path || (surface.href === '/' && shell.path.startsWith('/case/'))
        ? ' class="on"'
        : '';
      // The badge counts only what this page actually counted.
      const badge = surface.href === '/' && shell.approvals !== null
        ? `<span class="badge">${escapeHtml(String(shell.approvals))}</span>`
        : '';
      // The label and the badge are siblings. The label may shrink and
      // ellipsise; the badge never does, so a long title cannot push a count
      // onto a second line.
      return `<a href="${surface.href}"${on}>`
        + `<span class="navlabel">${escapeHtml(surface.title)}</span>${badge}</a>`;
    }).join('');
    return `<div class="navgroup"><div class="lbl">${escapeHtml(group.title)}</div>${links}</div>`;
  }).join('');
  return [
    '<div class="rail">',
    '<div class="brand">',
    '<div class="m brandname">auracle</div>',
    '<div class="lbl brandsub">support console</div>',
    '</div>',
    `<div class="nav">${groups}</div>`,
    '<div class="railfoot">',
    reviewerBlock(shell.reviewer),
    `<span class="chip"><span class="dot" style="color:var(--ok)"></span>ledger · ${escapeHtml(shell.ledger)}</span>`,
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
/**
 * How long ago something happened, in the coarsest unit that still says it.
 *
 * A person triaging a queue asks "how long has this waited", not "at what
 * instant did it open". Minutes below an hour, hours below a day, days after
 * that — one figure, because a second one is precision nobody acts on.
 *
 * Null is not "now". A run the ledger could not date has an unknown age, and
 * printing `0m` for it would put the freshest possible label on the run least
 * is known about.
 *
 * `now` is a parameter so this function can be asserted. Both call sites let
 * it default to the wall clock, which is what an age on a live page means —
 * the parameter exists for the tests, not for the surfaces.
 */
export function ageSays(at: Date | null, now: Date = new Date()): string {
  if (at === null) return 'age unrecorded';
  if (!isReadableTime(at)) return 'age unreadable';
  const ms = now.getTime() - at.getTime();
  // A run stamped ahead of this clock. Two machines' clocks, or a backdated
  // history: either way it has not waited a negative time, and a minus sign
  // in a queue reads as a defect.
  if (ms < 0) return 'not yet open';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * A timestamp a person can read, in UTC.
 *
 * Always UTC and always said so. The ledger stores UTC, the bands page judges
 * a UTC day, and a console silently rendering local time would have two
 * surfaces disagree about which day a run belongs to.
 */
export function whenSays(at: Date | null): string {
  if (at === null) return 'not recorded';
  // An unreadable time would throw below and take the whole page with it.
  if (!isReadableTime(at)) return 'not a readable time';
  return `${at.toISOString().slice(0, 16).replace('T', ' ')}Z`;
}

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
    one('/runs', 'all', filter.active === null),
    ...filter.states.map((state) =>
      one(`/runs?state=${encodeURIComponent(state)}`, state, filter.active === state)),
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
    // The column this table was ordered by and never showed. "Newest first"
    // is a claim about time, and nothing on the page said what time.
    `<td class="m">${escapeHtml(whenSays(run.createdAt))}`
      + `<span class="dim"> · ${escapeHtml(ageSays(run.createdAt))}</span></td>`,
    `<td><span class="st">${escapeHtml(run.state)}</span></td>`,
    `<td class="m">${escapeHtml(run.intentId ?? '—')}</td>`,
    // Both reasons, because they answer different questions and only one of
    // them can be non-null for any given run.
    // The escalation reason, or the gate rule for a run that has not
    // escalated. Vetted, like every other place this field is drawn.
    `<td class="m">${escapeHtml(run.reason ?? gateRuleOrDash(run.gateReason))}</td>`,
    // Kept. A backdated history writes runs in the same states a produced
    // one reaches, and the pin is what tells an operator pointed at a demo
    // ledger that they are not working real customer traffic.
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
    '<th>Run</th><th>Ticket</th><th>Opened</th><th>State</th>'
      + '<th>Intent</th><th>Reason</th><th>Prompt</th><th>Steps</th>',
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
  /**
   * The agreement line the gate journalled for this run's intent, or null.
   *
   * Beside the value rather than inside it, so a surface can say whether each
   * gate cleared its own line without combining the two (DEC-05).
   */
  readonly agreementThreshold: number | null;
  /** The coverage review line the gate journalled, or null (DEC-07). */
  readonly coverageReviewThreshold: number | null;
  /** The risk tier the gate recorded for the intent, or null (DEC-13). */
  readonly riskTier: string | null;
  readonly draftExternalId: string | null;
  /**
   * Whether the park journalled an action payload (DEC-34).
   *
   * A ledger-only park has no helpdesk draft and is still approvable:
   * `approveRun` relays the payload through `performAction`. The console
   * drew a button only for a draft handle, so a third of the queue offered
   * no approval on the surface built to approve it.
   */
  readonly payloadRecorded: boolean;
  /**
   * What the park will perform on approval, from the park row.
   *
   * Named on the button's warning, because approving a ledger-only park
   * performs an action rather than sending a reply, and an operator is owed
   * the name of the thing they are about to do.
   */
  readonly actionClass: string | null;
  /**
   * The delivery rule the park recorded (DEC-29, DEC-30).
   *
   * `at_most_once` never retries, so a send nobody can confirm escalates
   * rather than repeating — which is a fact an approver is owed before they
   * press the button. The query has always selected this and nothing read it.
   */
  readonly delivery: string | null;
  /**
   * What approving this run performs, when it parks an action rather than a
   * reply (DEC-34, DEC-40).
   *
   * Null for a draft-backed park, whose act is the reply above it.
   */
  readonly payload: Readonly<Record<string, unknown>> | null;
  /**
   * Whether an approval recorded this run's approver (DEC-42). An approval's
   * outcome is shown only on a run that has one.
   */
  readonly approved: boolean;
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

/**
 * One sentence of the drafted reply, as a surface draws it (DEC-43).
 *
 * A cited sentence carries the document it rests on and the judge's verdict.
 * A courtesy sentence carries neither: it opens or closes the reply, and no
 * document stands behind it.
 *
 * `claimIndex` is the position among the cited sentences, which is what the
 * citation marker numbers and what the gate recorded a verdict against. It is
 * not the position in the reply, and on a reply that opens with a courtesy
 * sentence the two differ.
 */
export interface SentenceView {
  readonly text: string;
  readonly docId: string | null;
  readonly claimIndex: number | null;
  readonly supported: boolean | null;
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
  /**
   * Every sentence of the reply in order, courtesy sentences included
   * (DEC-43). Null when the compose row recorded no partition.
   *
   * This is what a surface draws. Joined, it is the drafted reply.
   */
  readonly sentences: readonly SentenceView[] | null;
  /**
   * The cited sentences alone. Null when the compose row recorded no
   * partition.
   *
   * The summary counts and the source list read this rather than filtering
   * the partition again at each call site.
   */
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
 * One builder, drawn by the run detail and by the case. Two
 * assemblies of the same evidence would eventually disagree about a run, and
 * the one an approver reads is the one that has to be right.
 *
 * The sentences are the draft. `composed.draft` is those texts joined, so this
 * renders them in order rather than rendering the draft beside them — which
 * would show the same sentences twice and leave a reader guessing which copy
 * carried the citation.
 *
 * Three states per claim, not two. A claim the judge refused is the warning
 * an approver came for. A claim nobody judged is not a refusal, and drawing
 * it as one would put a warning on a run the ledger never questioned.
 *
 * A courtesy sentence is a fourth thing and not a fourth state (DEC-43). It
 * opens or closes the reply, and no document stands behind it. Nothing proves
 * it carries no fact, so this console draws it as what it is — part of the
 * reply, visibly uncited — rather than leaving it indistinguishable from the
 * sentences a judge accepted.
 */
function evidenceBlock(
  view: EvidenceView,
  draftId: string | null,
  request: RequestView | null,
): string {
  if (view.draftBody === null && view.sentences === null) {
    return requestBlock(request) + nothing('This run composed no reply.');
  }
  // Null and empty are different answers, here as everywhere else on this
  // console. A run journalled no readable retrieval is not a run whose
  // retrieval found nothing, and building a Map from `?? []` made the first
  // one report as the second — then labelled every cited document gone.
  const retrieved = view.documents;
  const sources = new Map((retrieved ?? []).map((doc) => [doc.docId, doc]));
  const sentences = view.sentences;
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
    sentences === null
      ? view.draftBody === null
        ? nothing('No draft was recorded for this run.')
        // A draft with no partition is a run journalled before the sentences
        // were written. The reply is shown whole, and the citations are not
        // available for it — which is a different thing from having none.
        : `<div class="prose">${escapeHtml(view.draftBody)}</div>`
          + '<p class="discl">This run recorded no claim list, so no sentence here'
          + ' carries its source. The reply is shown as it was drafted.</p>'
      // A recorded list with nothing in it. Rare and real, and it is not a
      // clean bill of health: drawing an empty prose block and then saying
      // every claim was accepted would have this console vouch for a reply
      // that makes no claims.
      : sentences.length === 0
        ? nothing('This run recorded a claim list with no claims in it.')
        : replyProse(sentences, sources),
    // Suppressed only when there is no partition at all. A reply whose
    // sentences all cite nothing has no claims to summarise and is the one
    // that most needs saying so: without this the console drew it in muted
    // italic and said nothing, and DEC-43 rests on this console naming every
    // uncited sentence as uncited.
    sentences === null || sentences.length === 0
      ? ''
      : claimSummary(
        (claims ?? []).length,
        unsupported,
        unread,
        sentences.filter((sentence) => sentence.docId === null).length,
      ),
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

/**
 * The reply in draft order, each cited sentence marked with what the judge
 * said and each courtesy sentence marked as citing nothing (DEC-43).
 *
 * One pass over the whole partition rather than the claims alone. Rendering
 * the claims and appending the courtesy sentences would put them in an order
 * the composer did not choose, and the order is the reply.
 */
function replyProse(
  sentences: readonly SentenceView[],
  sources: ReadonlyMap<string, DocumentView>,
): string {
  return `<div class="prose">${sentences.map((sentence) => {
    // A courtesy sentence has no source, so it carries no citation marker and
    // no verdict mark. It is still part of the reply and still shown, because
    // the customer reads it.
    if (sentence.docId === null || sentence.claimIndex === null) {
      return `<span class="courtesy">${escapeHtml(sentence.text)}</span>${verdictWord('courtesy')}`;
    }
    const mark = sentence.supported === false
      ? ' unsupported'
      : sentence.supported === null ? ' unread' : '';
    const source = sources.get(sentence.docId);
    const title = source?.title ?? sentence.docId;
    return [
      `<span class="claim${mark}" id="claim-${escapeHtml(String(sentence.claimIndex))}"`,
      ` data-source="${escapeHtml(sentence.docId)}">`,
      escapeHtml(sentence.text),
      `<a class="cite" href="#src-${escapeHtml(sentence.docId)}"`,
      ` title="${escapeHtml(title)}">${escapeHtml(String(sentence.claimIndex + 1))}</a>`,
      verdictWord(sentence.supported === true ? 'accepted' : sentence.supported === false ? 'refused' : 'unread'),
      '</span>',
    ].join('');
  }).join(' ')}</div>`;
}

/**
 * What each mark means, as a word beside the sentence it marks.
 *
 * The underline and the wash are colour, and colour is not read by everyone.
 * A reader who cannot tell the hues apart still reads the word. The words
 * are the judge's three answers and the courtesy sentence's absence of one.
 */
const VERDICT_WORDS = {
  accepted: { css: 'ok', says: 'accepted' },
  refused: { css: 'refused', says: 'refused' },
  unread: { css: 'unread', says: 'not judged' },
  courtesy: { css: 'courtesy', says: 'courtesy' },
} as const;

function verdictWord(verdict: keyof typeof VERDICT_WORDS): string {
  const word = VERDICT_WORDS[verdict];
  return `<span class="vw ${word.css}">${word.says}</span>`;
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
 *
 * The courtesy count is stated in every case, including the clean one
 * (DEC-43). A reply whose claims the judge all accepted can still open and
 * close with sentences no document stands behind, and a summary that said
 * "every claim carries a document the judge accepted" and stopped there would
 * describe part of the reply as though it were the whole.
 */
function claimSummary(
  total: number,
  unsupported: number,
  unread: number,
  courtesy: number,
): string {
  // A reply that cites nothing at all. `every claim of 0 carries a document
  // the judge accepted` is true and useless, and it reads as a clean bill of
  // health for a reply no document stands behind.
  if (total === 0) {
    return `<p class="discl">${escapeHtml(
      courtesy === 1
        ? 'This reply is one sentence, and no document stands behind it.'
        : `This reply is ${courtesy} sentences, and no document stands behind any of them.`,
    )}</p>`;
  }
  const parts: string[] = [];
  if (unsupported > 0) {
    parts.push(`${unsupported} of ${total} claims cite a document that does not support them`);
  }
  if (unread > 0) {
    parts.push(`${unread} of ${total} carry no recorded verdict`);
  }
  const aboutClaims = parts.length === 0
    ? `every claim of ${total} carries a document the judge accepted`
    : parts.join('; ');
  // Appended, never substituted. A reply whose claims all passed still has to
  // say how much of it cites nothing, and a courtesy count that replaced the
  // verdict summary would answer a different question than the one asked.
  const aboutCourtesy = courtesy === 1
    ? '1 further sentence opens or closes the reply and cites nothing'
    : `${courtesy} further sentences open or close the reply and cite nothing`;
  const says = courtesy === 0 ? aboutClaims : `${aboutClaims}; ${aboutCourtesy}`;
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
        ' ',
        bodyFlag(doc),
        '</div>',
      ].join('');
    }),
    '</div></div>',
  ].join('');
}

/**
 * Whether a cited document still says what the run read. Three answers, and
 * every cited row carries exactly one.
 *
 * Unchanged is said as plainly as changed. A row that drew nothing for an
 * unchanged document read the same as a row nothing was compared for, which
 * is two states pretending to be three.
 *
 * A document the run did not retrieve, or one no row answers for today, has
 * no digest to compare. So it is not compared, whatever else its row says.
 */
function bodyFlag(doc: DocumentView | undefined): string {
  if (doc?.bodyUnchanged === true) return chip('unchanged', 'ok');
  // The claim rested on text that is no longer there. Said plainly, because a
  // reader checking a citation against today's document would otherwise
  // conclude the claim was wrong.
  if (doc?.bodyUnchanged === false) return chip('changed since this run read it', 'warn');
  return chip('not compared', 'dim');
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
    gatesNotReadSays(run.policyReason),
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
 * The gate rules a queue can be narrowed to, in the order a person meets them.
 *
 * Derived from what is waiting rather than fixed, so a rule that nothing
 * carries today does not offer a filter that empties the list. A run whose
 * gate rule the ledger never recorded is reachable through `no gate rule
 * journalled`, because a run nobody can explain is one a person still has to
 * work — and a filter set that hid it would hide exactly that run.
 */
const UNRULED = 'unruled';

function gateFilters(
  runs: readonly RunDetail[],
  active: string | null,
  product: string | null,
): string {
  const rules = [...new Set(runs.map((run) => run.gateReason ?? UNRULED))].sort();
  if (rules.length < 2) return '';
  // Escaped, as the row link, the back link and the four forms are: the value
  // is already percent-encoded by `filtersQuery`, and the attribute adds the
  // one escaping an HTML parser undoes. A site that relied on the encoder
  // alone would be the site that ships an injection the day a value reaches
  // it another way.
  const one = (href: string, label: string, on: boolean, count: number): string =>
    `<a href="${escapeHtml(href)}"${on ? ' class="on"' : ''}>${escapeHtml(label)}`
      + `<span class="dim"> ${escapeHtml(String(count))}</span></a>`;
  return [
    '<div class="filters">',
    '<span class="lbl">needs a person</span>',
    '<div class="seg">',
    // DEC-47: each chip keeps the product the page arrived with, so choosing
    // a rule narrows the product rather than replacing it with every product.
    one(queueHref(null, product), 'all', active === null, runs.length),
    ...rules.map((rule) => one(
      queueHref(rule, product),
      rule === UNRULED ? 'no gate rule' : gateRuleSays(rule),
      active === rule,
      runs.filter((run) => (run.gateReason ?? UNRULED) === rule).length,
    )),
    '</div>',
    '</div>',
  ].join('');
}

/**
 * The queue's own spelling for a run whose channel mapped to no product.
 *
 * Wrapped in double underscores, which `parseProducts` reserves: a catalogue
 * cannot declare this name, so the chip it labels holds only the runs with no
 * product and never a product that happens to share the spelling.
 */
const NO_PRODUCT = '__none__';

/**
 * The product a run holds, as a chip or a row reads it.
 *
 * `''` is the absence as much as null is. The column is `text` with no
 * CHECK, so a row can carry it — a hand-written insert, a backfill, a caller
 * that passed it to `enqueueTicket` — and a surface that drew it would print
 * a blank where the rule says an absence is stated in words.
 */
function productOf(value: string | null): string {
  return value === null || value === '' ? NO_PRODUCT : value;
}

/**
 * The products a queue can be narrowed to, and what each holds (DEC-47).
 *
 * Derived from what is waiting, as the gate-rule filter is: a product that
 * nothing carries today does not offer a filter that empties the list, and a
 * run whose channel mapped to no product is reachable as `no product` rather
 * than hidden — it is still work.
 *
 * The counts are read from every waiting run, never from the narrowed view.
 * A filter that reported its own count as the queue would show a reviewer a
 * queue that emptied the moment they narrowed it.
 *
 * Each chip carries the OTHER filter the page arrived with. A reviewer who
 * narrowed to one product and then picks a rule means both, and a chip that
 * rebuilt the URL from its own dimension alone would silently drop the
 * product they chose.
 */
function productChips(
  runs: readonly RunDetail[],
  active: string | null,
  rule: string | null,
  labels: ReadonlyMap<string, string>,
): string {
  const values = [...new Set(runs.map((run) => productOf(run.product)))].sort();
  if (values.length < 2) return '';
  // Escaped, as the row link, the back link and the four forms are: the value
  // is already percent-encoded by `filtersQuery`, and the attribute adds the
  // one escaping an HTML parser undoes. A site that relied on the encoder
  // alone would be the site that ships an injection the day a value reaches
  // it another way.
  const one = (href: string, label: string, on: boolean, count: number): string =>
    `<a href="${escapeHtml(href)}"${on ? ' class="on"' : ''}>${escapeHtml(label)}`
      + `<span class="dim"> ${escapeHtml(String(count))}</span></a>`;
  return [
    '<div class="filters">',
    '<span class="lbl">product</span>',
    '<div class="seg">',
    // `all` clears this filter and keeps the other one.
    one(queueHref(rule, null), 'all', active === null, runs.length),
    ...values.map((value) => one(
      queueHref(rule, value),
      value === NO_PRODUCT ? 'no product' : productLabel(labels, value),
      active === value,
      runs.filter((run) => productOf(run.product) === value).length,
    )),
    '</div>',
    '</div>',
  ].join('');
}

/** The runs a chosen product leaves, or all of them when none is chosen. */
export function narrowToProduct(
  runs: readonly RunDetail[],
  product: string | null,
): readonly RunDetail[] {
  if (product === null) return runs;
  return runs.filter((run) => productOf(run.product) === product);
}

/**
 * What the gate panel has to say when a threshold decided nothing.
 *
 * The panel draws each value against its thresholds, which reads as a
 * comparison that happened. The engine short-circuits: a customer reply is
 * gated by DEC-12 before either threshold, and four other rules stop before
 * one or both of them. Drawing a block line beside a coverage of 0.40 on such
 * a run says it failed groundedness, which is impossible — a run that failed
 * it would have escalated rather than waited.
 *
 * One note for both gates and both surfaces. Only `customer_visible` was
 * named before, and only on the run detail, so a case contradicted the queue
 * row that led to it.
 */
function gatesNotReadSays(policyReason: string | null): string {
  if (!isPolicyReason(policyReason)) return '';
  const agreement = reachedAgreementGate(policyReason);
  const coverage = readCoverageGate(policyReason);
  if (agreement && coverage) return '';
  const which = !agreement ? 'either threshold' : 'the coverage thresholds';
  const rule = `<span class="m">${escapeHtml(policyReason)}</span>`;
  const because = policyReason === 'customer_visible'
    ? ' A customer reply always waits for a person.'
    : '';
  return `<p class="discl" style="margin-top:14px">The policy engine returned ${rule}`
    + ` before it read ${which}. The marks below them are what the run would have been`
    + ` judged against.${because}</p>`;
}

/**
 * Whether a value from the ledger is a rule the policy engine writes.
 *
 * Two readers of this field disagreed about whether to check it: the coverage
 * marker vetted it and the label beside it printed whatever the column held.
 * One rule, one check.
 *
 * The vocabulary is compiled from the same package the engine is, so the two
 * cannot drift within a build.
 */
function isPolicyReason(value: string | null): value is PolicyReason {
  return value !== null && (POLICY_REASONS as readonly string[]).includes(value);
}

/**
 * The rule a row names, in the engine's own words.
 *
 * A value outside the vocabulary is named as one rather than printed. The
 * gate row is written by the policy engine and holds a closed set, so this is
 * a shape the ledger should not contain — and an unbounded foreign string in
 * a queue row is a layout a person cannot read as well as a claim this
 * console cannot stand behind.
 */
/**
 * DEC-47: the product a case is for, in words. Null is said, not drawn.
 *
 * The catalogue's label when it holds one, and the id otherwise. A product
 * the catalogue no longer declares still has runs, and a row that drew a
 * blank for one would read as a product nobody had chosen.
 */
function productSays(product: string | null, labels: ReadonlyMap<string, string>): string {
  return product === null || product === '' ? 'no product' : productLabel(labels, product);
}

/** The label a product is shown by, or its id when the catalogue holds none. */
function productLabel(labels: ReadonlyMap<string, string>, product: string): string {
  return labels.get(product) ?? product;
}

function gateRuleSays(gateReason: string | null): string {
  if (gateReason === null) return 'no gate rule journalled';
  return isPolicyReason(gateReason) ? gateReason : 'a rule this console does not know';
}

/** The same, where a dash is the right way to say nothing was recorded. */
function gateRuleOrDash(gateReason: string | null): string {
  return gateReason === null ? '—' : gateRuleSays(gateReason);
}

/**
 * What a row says about coverage, given the rule that decided the run.
 *
 * Three answers, not two. A coverage that decided is a number to act on. A
 * coverage the engine never reached is a measurement, and saying so is the
 * difference between informing a person and misleading them. No gate row at
 * all says nothing.
 */
function coverageSays(coverage: number | null, gateReason: string | null): string {
  if (coverage === null) return '';
  const read = isPolicyReason(gateReason) && readCoverageGate(gateReason);
  return read
    ? ` · coverage ${escapeHtml(coverage.toFixed(2))}`
    : ` · coverage ${escapeHtml(coverage.toFixed(2))} (not read)`;
}

/** The runs a chosen gate rule leaves, or all of them when none is chosen. */
export function narrowToRule(
  runs: readonly RunDetail[],
  rule: string | null,
): readonly RunDetail[] {
  if (rule === null) return runs;
  return runs.filter((run) => (run.gateReason ?? UNRULED) === rule);
}

/**
 * Who holds one queued case, and since when (DEC-46).
 *
 * The row says how long ago they took it. A hold that lapsed or was released
 * is not here: the queue reads the live rows only.
 */
export interface QueueHold {
  readonly reviewer: string;
  readonly takenAt: Date;
}

/**
 * The holds on the queue's cases, or the tag of the fault that stopped the
 * console reading them.
 *
 * Two answers, as the counts have. The queue draws either way, because the
 * queue is the work — and a page that dropped the holders without saying so
 * would read as a queue nobody is working.
 */
export type QueueHoldsRead =
  | {
    /** The reviewer behind this request, so their own hold is not somebody else's. */
    readonly reviewer: string;
    readonly holds: ReadonlyMap<string, QueueHold>;
  }
  | { readonly unreadTag: string };

/** Today's counts, as the queue header states them. */
export interface QueueTodayView {
  readonly arrived: number;
  readonly reachedQueue: number;
}

/**
 * What the queue is showing, and to whom (DEC-47).
 *
 * The two filters are separate and both apply: a reviewer working one gate
 * rule on one product gets both at once rather than one replacing the other.
 * `mine` is the products the request's reviewer covers, read from the roster,
 * for the order only.
 */
export interface QueueView {
  readonly rule: string | null;
  readonly product: string | null;
  readonly mine: readonly string[];
  /**
   * DEC-47: the label each product is shown by, from the catalogue the
   * process read at startup. A product the map does not hold is shown by its
   * id, which is its real name rather than a blank.
   */
  readonly labels: ReadonlyMap<string, string>;
  /**
   * The tag of the fault that stopped the console reading the reviewer's own
   * products, or null. The queue still draws: it orders by the ledger's own
   * rule rather than by a preference it could not read, and it says so.
   */
  readonly mineUnread: string | null;
}

/** The counts, or the tag of the fault that stopped the console reading them. */
export type QueueTodayRead =
  | { readonly counts: QueueTodayView }
  | { readonly unreadTag: string };

/**
 * Each group's label, and the note that stands under it.
 *
 * The clean note is the design's standing sentence, and it is always drawn.
 * "Clean" invites a reader to add the two gates into one confidence, and
 * DEC-05 says they are never blended. Neither gate sent these cases to a
 * person, so the note says what did.
 */
const GROUP_LABELS: Readonly<Record<QueueGroup, { readonly label: string; readonly note: string | null }>> = {
  first: { label: 'Irreversible or high risk', note: null },
  clean: {
    label: 'Both gates clean',
    note: 'Agreement and coverage are two independent gates, and this console never blends'
      + ' them into one score. Clean means both values and both lines are recorded, and each value'
      + ' clears its own line.'
      + ' Neither gate decided these cases. Another rule sent each one to a person, and its row names the rule.',
  },
  rest: { label: 'Everything else waiting', note: null },
  // Always drawn: the group is the one thing that says a case on this page is
  // somebody's, and the note says how a case leaves it.
  held: {
    label: 'Held by someone else',
    note: 'Somebody is working each of these. A hold lapses after its period without activity,'
      + ' and the case returns to its own group. To move a hold to you, open the case and confirm it.',
  },
};

/**
 * What the queue says when it could not read the reviewer's own products
 * (DEC-47).
 *
 * The queue draws, ordered as it was before this existed. A reviewer who
 * declared products and reads a list in the ledger's order would otherwise
 * think the console had ignored their choice.
 */
function mineUnreadSays(view: QueueView): string {
  if (view.mineUnread === null) return '';
  return '<p class="qaside">The products you cover were not read, so this queue is in its own'
    + ` order rather than yours. The console log names the fault ${escapeHtml(view.mineUnread)}.</p>`;
}

/**
 * What the queue says when it could not read who holds what (DEC-46).
 *
 * The queue draws without the holders, and says which log line names the
 * fault. Silent, it would read as a queue nobody has taken anything from.
 */
function holdsUnreadSays(holds: QueueHoldsRead): string {
  if (!('unreadTag' in holds)) return '';
  return '<p class="qaside">The holds were not read, so this queue does not say who is working a case.'
    + ` The console log names the fault ${escapeHtml(holds.unreadTag)}.</p>`;
}

/**
 * The header's two counts, for the UTC day.
 *
 * Two counts and no share of one in the other. The published containment
 * figure comes from the gold report, and a live percentage beside it would
 * read as the same number.
 */
function todaySays(today: QueueTodayRead): string {
  if ('unreadTag' in today) {
    return `Today's counts were not read. The console log names the fault ${today.unreadTag}.`;
  }
  const { arrived, reachedQueue } = today.counts;
  const came = arrived === 1 ? '1 message arrived' : `${arrived} messages arrived`;
  return `${came} today (UTC) · ${reachedQueue} reached this queue.`;
}

/**
 * Where the other runs a person owes are.
 *
 * This page lists the runs waiting for approval. An escalated run stops for a
 * person too, and has nothing to approve, so it is not here. A page titled
 * Needs a person that said nothing of those runs would read as all of them.
 */
const ESCALATED_ELSEWHERE = '<p class="qaside">An escalated run waits for a person as well, and has'
  + ' nothing to approve. The runs list shows the newest 200'
  + ' <a href="/runs?state=escalated">escalated runs</a>, and'
  + ' <span class="m">pnpm run escalations</span> lists every one.</p>';

/** What a row says about agreement, given the rule that decided the run. */
function agreementSays(agreement: number | null, gateReason: string | null): string {
  if (agreement === null) return '';
  const read = isPolicyReason(gateReason) && reachedAgreementGate(gateReason);
  return read
    ? ` · agreement ${escapeHtml(agreement.toFixed(2))}`
    : ` · agreement ${escapeHtml(agreement.toFixed(2))} (not read)`;
}

/**
 * Surface 3: the approval queue, as a list (issue #102).
 *
 * Each row opens its case. The queue draws no case beside itself, because a
 * case needs a page of its own and the queue is deliberately uncapped:
 * capping it would drop the oldest waiting replies off the end and show a
 * person a queue they had finished.
 *
 * A chosen rule travels on each row's link, so opening a case and coming back
 * keeps the filter.
 */
export function renderApprovals(
  runs: readonly RunDetail[],
  view: QueueView,
  today: QueueTodayRead,
  holds: QueueHoldsRead,
): string {
  const { rule, product, mine } = view;
  // A filter the query string invented narrows to nothing, which is what it
  // asked for, and the list says so.
  //
  // `runs` is everything waiting. The chips and the counts are read from it
  // rather than from the narrowed view, so a filter cannot make the queue
  // report that it has emptied — and so each chip can say how many it holds.
  // Both filters narrow, and either may be the only one set.
  const shownRuns = narrowToProduct(narrowToRule(runs, rule), product);
  // A value that narrows NOTHING is never written back out into a link: the
  // cross-filter links below carry only the filters that the waiting runs
  // actually carry. Without this, a value from a query string — hostile or
  // merely stale — would ride from the address bar into every chip's href.
  const keptRule = narrowToRule(runs, rule).length > 0 ? rule : null;
  const keptProduct = narrowToProduct(runs, product).length > 0 ? product : null;
  // "Held by someone else" is the whole meaning of the group: a case the
  // reader holds is theirs to work, and stays where its gate facts put it.
  const heldByAnother = (runId: string): QueueHold | null => {
    if ('unreadTag' in holds) return null;
    const hold = holds.holds.get(runId);
    return hold === undefined || hold.reviewer === holds.reviewer ? null : hold;
  };
  const header = head(
    'Needs a person',
    `${todaySays(today)} This list is not capped, so the oldest is on it.`,
    [chip(`${runs.length} waiting`)],
  ) + gateFilters(runs, keptRule, keptProduct)
    + productChips(runs, keptProduct, keptRule, view.labels)
    + ESCALATED_ELSEWHERE + holdsUnreadSays(holds) + mineUnreadSays(view);
  if (shownRuns.length === 0) {
    // For approval, not for a person. An escalated run waits for a person as
    // well, and the line above says where it is.
    // Which filter emptied it, when one did: a reviewer who set two has to
    // be able to tell which one to clear.
    if (rule === null && product === null) {
      return header + nothing('Nothing is waiting for approval.');
    }
    return header + nothing(
      rule !== null && product !== null
        ? 'Nothing waiting carries that rule for that product.'
        : rule !== null
          ? 'Nothing waiting carries that rule.'
          : 'Nothing waiting is for that product.',
    );
  }
  // DEC-47: the reviewer's own products first, inside each group.
  const covered = new Set(mine);
  const sections = groupQueue(
    shownRuns,
    (run) => heldByAnother(run.runId) !== null,
    (run) => run.product !== null && covered.has(run.product),
  );
  const keysLine = keyLegend();
  // Who holds it and for how long, on the row. The group says somebody does;
  // the row says who, because a queue of hundreds has more than one holder.
  const heldSays = (runId: string): string => {
    const hold = heldByAnother(runId);
    return hold === null
      ? ''
      : `held by ${escapeHtml(hold.reviewer)} · ${escapeHtml(ageSays(hold.takenAt))} · `;
  };
  const row = (run: RunDetail): string => [
    `<a class="item" href="${escapeHtml(caseHref(run.runId, keptRule, keptProduct))}">`,
    '<div class="itop">',
    `<span class="m isubj">${escapeHtml(run.ticketId)}</span>`,
    // How long it has waited, on the row. The header says the oldest is on
    // this list and nothing on it said how old anything was.
    `<span class="age">${escapeHtml(ageSays(run.createdAt))}</span>`,
    '</div>',
    // Why this run is a person's, in the gate's own vocabulary. The
    // escalation reason sat here and is null for every waiting run by
    // construction, so the queue read "no reason journalled" 161 times.
    `<div class="m imeta">`,
    `${heldSays(run.runId)}`,
    `${escapeHtml(run.intentId ?? 'intent unrecorded')}`,
    // DEC-47: which product this case is for, said on the row. A reviewer
    // reading a queue ordered by their own products has to see why a case
    // sits where it does, and `no product` is a fact rather than a blank.
    ` · ${escapeHtml(productSays(run.product, view.labels))}`,
    ` · ${escapeHtml(gateRuleSays(run.gateReason))}`,
    // Why a case sits where its rule does not put it. A compensation cannot be
    // undone, and the `irreversible` rule already says so.
    `${run.actionClass === COMPENSATION_ACTION_CLASS && run.gateReason !== 'irreversible' ? ' · compensation' : ''}`,
    // A high tier puts a case first, and a rule that already says it is not
    // repeated. A gate row from before the tier was recorded says so, because
    // its rule alone placed the case.
    `${run.riskTier === 'high' && run.gateReason !== 'high_risk' ? ' · high-risk intent' : ''}`,
    `${run.riskTier === null ? ' · tier unrecorded' : ''}`,
    // Each gate on its own, and whether it decided anything (DEC-05,
    // section 4.8). Two values, never one made of both.
    //
    // The gate row records both whether or not the engine read them. A
    // customer reply is gated by DEC-12 before either threshold, so printing
    // "coverage 0.40" beside `customer_visible` says a run failed
    // groundedness when it was never judged on it — and it says so on most
    // of the queue, because most of the queue is customer replies.
    `${agreementSays(run.agreement, run.gateReason)}`,
    `${coverageSays(run.gateCoverage, run.gateReason)}`,
    '</div>',
    '</a>',
  ].join('');
  return [
    header,
    keysLine,
    '<div class="list">',
    `<div class="lhd"><span class="lbl">Waiting · ${escapeHtml(String(shownRuns.length))}`
      + `${rule === null ? '' : escapeHtml(` · ${rule === UNRULED ? 'no gate rule' : gateRuleSays(rule)}`)}`
      // DEC-47: the product is named the way the rule is. A narrowed list
      // that said `Waiting · 2` and nothing else would leave the narrowing
      // to a chip's highlight to explain.
      + `${product === null || product === '' ? '' : escapeHtml(` · ${product === NO_PRODUCT ? 'no product' : productLabel(view.labels, product)}`)}`
      + '</span></div>',
    ...sections.map((section) => {
      const { label, note } = GROUP_LABELS[section.group];
      return [
        `<div class="qgroup"><span class="lbl">${escapeHtml(label)}`
          + `<span class="dim"> ${escapeHtml(String(section.runs.length))}</span></span>`,
        note === null ? '' : `<p class="qnote">${escapeHtml(note)}</p>`,
        '</div>',
        ...section.runs.map(row),
      ].join('');
    }),
    '</div>',
  ].join('');
}

/**
 * Only the keys that act in this release, because a legend that names a dead
 * key sends a reviewer to press it. Enter is native to the focused anchor;
 * c opens the case until a take exists (#107) and then takes it; a joins the
 * legend with the batch confirm it activates.
 *
 * Drawn above the rows, not under them: the queue is uncapped, so a legend
 * under the list would sit under the fold of every queue that is the reason
 * the legend exists.
 */
function keyLegend(): string {
  return '<div class="keys">j / k move · enter opens · c takes the case</div>';
}

/**
 * The case page of a run, with the chosen queue filters kept for the way
 * back (DEC-47).
 *
 * The rule rode here first, and the product rides beside it rather than
 * replacing it: a reviewer working one rule on one product clears one filter
 * at a time, and a case that dropped either would send them back to a queue
 * they had not chosen.
 */
export function caseHref(runId: string, rule: string | null, product: string | null = null): string {
  return `/case/${encodeURIComponent(runId)}${filtersQuery(rule, product)}`;
}

/** The queue, with the chosen filters kept. */
export function queueHref(rule: string | null, product: string | null): string {
  return `/${filtersQuery(rule, product)}`;
}

/**
 * `?rule=…&product=…`, each value encoded on its own.
 *
 * Written out rather than through `URLSearchParams`, whose form encoding
 * turns a space into `+` and escapes the parentheses a rule name may hold.
 * Both spellings decode to the same value, so this is about the links a
 * browser already holds and about one encoding being this console's, not
 * two.
 */
export function filtersQuery(rule: string | null, product: string | null): string {
  const parts: string[] = [];
  if (rule !== null && rule !== '') parts.push(`rule=${encodeURIComponent(rule)}`);
  if (product !== null && product !== '') parts.push(`product=${encodeURIComponent(product)}`);
  return parts.length === 0 ? '' : `?${parts.join('&')}`;
}

/**
 * What the ledger holds about the customer a case answers.
 *
 * Three answers, because they send a reader to different places: the run
 * answered no conversation, it names one the ledger no longer holds, or here
 * is the conversation.
 */
export type CustomerRead =
  | { readonly kind: 'none' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'thread'; readonly thread: ThreadView }
  /** The read failed. The log holds the fault under this tag. */
  | { readonly kind: 'unread'; readonly tag: string };

/** One case: the run as the run detail reads it, and its customer. */
export interface CaseView extends RunView {
  readonly customer: CustomerRead;
}

export interface CaseOptions {
  /** The outcome of the approval just posted, drawn above the case. */
  readonly outcome: string;
  /** The queue rule a person came from, kept on the way back. */
  readonly rule: string | null;
  /** DEC-47: the queue product a person came from, kept the same way. */
  readonly product: string | null;
  /**
   * The adapter the console reads drafts back through, or null when it reads
   * none (section 4.10). The case says which, because it decides whether an
   * approval records an edit distance.
   */
  readonly readBack: string | null;
  /**
   * Who holds this case, as this page must read it (DEC-46).
   *
   * The hold is advisory: a case held by somebody else still approves, and
   * the bar says who holds it rather than refusing. The take is a second
   * form beside the approval, never a condition on it.
   *
   * Three answers, as the customer read has: somebody, nobody, or a read
   * that failed. A fault that drew "Nobody holds this case" would state a
   * fact it could not establish.
   */
  readonly hold: CaseHoldRead;
  /**
   * The outcome of the take just posted, drawn in the hold bar: taken,
   * held_by_other, not_waiting or unknown_run.
   */
  readonly taken: string;
  /**
   * The teammate a handover named, rendered back when the handover was
   * refused. A refusal that dropped what was typed would ask a person to
   * type a colleague's identity twice.
   */
  readonly handoverTo: string;
}

/**
 * Who holds this case, or why the page cannot say.
 *
 * `unread` carries the tag of the log line that holds the fault, as the
 * customer read does, so the page can name it without printing a fault.
 */
export type CaseHoldRead =
  | { readonly kind: 'read'; readonly hold: CaseHold | null }
  | { readonly kind: 'unread'; readonly tag: string };

/** Who is working this case, for the bar at the foot of it. */
export interface CaseHold {
  readonly reviewer: string;
  /** Whether the reviewer behind this request is that person. */
  readonly mine: boolean;
  /** Milliseconds until the hold lapses. Never negative. */
  readonly remainingMs: number;
}

/**
 * Surface 3a: one case, and everything a person needs to decide on it
 * (issue #102, DEC-40).
 *
 * The main column is what the customer reads and what it rests on: their
 * message, the drafted reply sentence by sentence, and the documents it
 * cites. The context column is why a person has it: the rule the journal
 * recorded, the two gates, the customer and the run's steps. The approval
 * sits in a bar at the foot, so it is in reach wherever the reader is.
 *
 * The case reads any run the ledger holds, so the outcome of an approval is
 * drawn on the case it approved. Only a waiting run offers the approval.
 */
export function renderCase(view: CaseView, options: CaseOptions): string {
  const act = actOf(view);
  const waiting = view.state === 'awaiting_approval';
  const rule = view.policyReason;
  return [
    '<div class="casehd">',
    '<div class="backrow">'
      + `<a class="back" href="${escapeHtml(queueHref(options.rule, options.product))}">← Needs a person</a>`
      + '<span class="backkey">esc returns to the queue</span></div>',
    '<div class="casetitle">',
    `<span class="m casesubj">${escapeHtml(view.ticketId)}</span>`,
    chip(rule === null ? 'no rule journalled' : gateRuleSays(rule), 'hot'),
    chip(view.riskTier === null ? 'tier unrecorded' : `${view.riskTier} risk`),
    chip(view.state, waiting ? 'accent' : 'dim'),
    '</div>',
    '<div class="m casemeta">',
    escapeHtml([
      view.request === null ? 'no turn' : `turn ${view.request.turnNumber}`,
      view.intentId ?? 'intent unrecorded',
      // An age says how long a case has waited, which is true only while it
      // waits. A case that left the queue says when it opened.
      waiting ? `waiting ${ageSays(view.createdAt)}` : `opened ${whenSays(view.createdAt)}`,
    ].join(' · ')),
    ` · run <a href="/run/${encodeURIComponent(view.runId)}">${escapeHtml(view.runId)}</a>`,
    '</div>',
    '</div>',
    options.outcome === '' ? '' : renderOutcome(options.outcome, { state: view.state, approved: view.approved }),
    '<div class="case">',
    '<div class="casemain">',
    evidenceBlock(view.evidence, view.draftExternalId, view.request),
    act.kind === 'action' ? payloadBlock(view.payload) : '',
    '</div>',
    '<div class="caseside">',
    whyBlock(view, act),
    '<div class="card"><header>',
    '<span class="lbl">The two gates</span>',
    chip('independent · never combined'),
    '</header><div class="body">',
    renderGates({
      agreement: view.agreement,
      coverage: view.coverage,
      agreementThreshold: view.agreementThreshold,
      agreementDetail: view.agreementDetail,
      coverageBlock: view.coverageBlock,
      coverageReview: view.coverageReview,
      agreementAbsent: 'the journal holds no agreement for this run',
      coverageAbsent: 'the journal holds no coverage for this run',
      stacked: true,
    }),
    gatesNotReadSays(rule),
    '</div></div>',
    customerBlock(view),
    '<div class="card"><header>',
    '<span class="lbl">How the run walked</span>',
    chip('no durations · none is stored'),
    '</header><div class="body">',
    timeline(view.steps),
    '</div></div>',
    '</div>',
    '</div>',
    holdBar(view, options),
    actionBar(view, act, options),
  ].join('');
}

/**
 * Why a case reached a person, for each rule the policy engine writes.
 *
 * A record over the whole union, so a rule the engine gains fails the build
 * here until it has a sentence. The sentence says what the rule means; the
 * rule itself is printed beside it, from the journal.
 */
const WHY_YOURS: Readonly<Record<PolicyReason, string>> = {
  no_idempotency: 'The adapter cannot tell a repeated send from a new one, so nothing it sends goes out without a person.',
  no_read_back: 'The adapter cannot confirm what it delivered, so nothing it sends goes out without a person.',
  customer_visible: 'A reply to a customer always waits for a person.',
  // What the engine judged, not a claim about the act. The act's own warning
  // is read from the action class in the bar, as it always was.
  irreversible: 'The policy engine judged this write irreversible, so a person approves it.',
  high_risk: 'The policy engine judged this intent high risk, so a person approves it.',
  agreement: 'The classifier samples did not agree enough for the system to act alone.',
  groundedness_block: 'Too little of the reply rests on its documents for the system to act alone.',
  groundedness_review: 'Less of the reply rests on its documents than the review line asks, so a person reads it.',
  auto: 'The policy engine let this act run alone. The ledger does not say why it waits for a person.',
};

/**
 * What the delivery rule the park recorded means for the approved act
 * (DEC-29, DEC-30). The relay decides a retry; this says what it may decide.
 */
function deliverySays(delivery: string | null): string {
  if (delivery === 'at_most_once') {
    return 'It is sent at most once and never retried, so a send nobody can confirm escalates rather than repeating.';
  }
  if (delivery === 'at_least_once') {
    return 'A send that fails may be sent again, where the relay can show that the first one did not land.';
  }
  return delivery === null
    ? 'The park recorded no delivery rule.'
    : 'The park recorded a delivery rule this console does not know.';
}

/** "Why this is yours": the journal's rule, what it means, and the delivery contract. */
function whyBlock(view: CaseView, act: Act): string {
  const rule = view.policyReason;
  const said = rule === null
    ? '<p>The journal recorded no policy rule for this run.</p>'
    : isPolicyReason(rule)
      ? `<p><span class="m">${escapeHtml(rule)}</span>. ${escapeHtml(WHY_YOURS[rule])}</p>`
      : '<p>The journal recorded a rule this console does not know.</p>';
  // What approving does, said only while there is an approval to make.
  const does = view.state !== 'awaiting_approval'
    ? null
    : act.kind === 'reply'
      ? 'Approving sends the helpdesk draft to the customer.'
      : act.kind === 'action'
        ? `Approving performs ${view.actionClass ?? 'the parked action'} through the adapter.`
        : null;
  return [
    '<div class="card why"><header>',
    '<span class="lbl">Why this is yours</span>',
    chip('from the journal'),
    '</header><div class="body">',
    said,
    does === null ? '' : `<p class="discl">${escapeHtml(does)} ${escapeHtml(deliverySays(view.delivery))}</p>`,
    '</div></div>',
  ].join('');
}

/**
 * What the ledger holds about the customer, and a sentence for what it does
 * not. The ledger records a conversation, its turns and whether a participant
 * is bound to it. It records no name, plan or history, so none is drawn.
 */
function customerBlock(view: CaseView): string {
  const open = ['<div class="card"><header>', '<span class="lbl">This customer</span>', '</header><div class="body">'];
  const close = '</div></div>';
  const customer = view.customer;
  if (customer.kind === 'none') {
    return [...open, '<p class="absent">This run answered no conversation, so the ledger holds nothing about its customer.</p>', close].join('');
  }
  if (customer.kind === 'unread') {
    return [...open, `<p class="absent">The customer was not read. The console log names the fault ${escapeHtml(customer.tag)}.</p>`, close].join('');
  }
  if (customer.kind === 'missing') {
    return [...open, '<p class="absent">The ledger holds no conversation under this id.</p>', close].join('');
  }
  const thread = customer.thread;
  const turns = thread.turns.length;
  return [
    ...open,
    '<dl class="kv">',
    `<dt>turn</dt><dd>${escapeHtml(view.request === null
      ? `this run answered no turn of ${turns}`
      : `turn ${view.request.turnNumber} of ${turns}`)}</dd>`,
    `<dt>opened</dt><dd>${escapeHtml(whenSays(thread.openedAt))}</dd>`,
    `<dt>state</dt><dd>${escapeHtml(thread.state)}</dd>`,
    // Whether it is bound to somebody, never who.
    `<dt>participant</dt><dd>${thread.participantNamed ? 'a participant is named' : 'no participant is named'}</dd>`,
    '</dl>',
    '<p class="absent">The ledger holds no name, plan, tenure or account history for this customer.</p>',
    `<p class="discl">Read <a href="/conversation/${encodeURIComponent(thread.conversationId)}">the whole conversation</a>.</p>`,
    close,
  ].join('');
}

/** Minutes left on a hold, as a person reads it. Rounds up, so "1m" is never early. */
function remainingSays(remainingMs: number): string {
  const minutes = Math.max(0, Math.ceil(remainingMs / 60_000));
  if (minutes === 0) return 'less than a minute left';
  if (minutes === 1) return '1 minute left';
  return `${minutes} minutes left`;
}

/**
 * The hold on this case, above the approval bar (DEC-46).
 *
 * Three states, and each one says what the reviewer can do about it: take a
 * free case, release their own, or take over somebody else's after the
 * console has told them who holds it. The takeover is a second form on
 * purpose — one press never moves another person's hold.
 *
 * A fourth answer says nothing about a holder: the read failed. The bar then
 * draws no claim and no control, because every sentence it could draw would
 * be a fact this page does not have.
 */
function holdBar(view: CaseView, options: CaseOptions): string {
  // A hold this page could not read is a hold no sentence about a hold can be
  // checked against, so those answers are dropped with it. The one exception
  // is an outcome whose fit is the run's own state: `not_waiting` says the
  // case is nobody's to take, and this page knows that from the state.
  const readable = options.hold.kind !== 'unread' || options.taken === 'not_waiting';
  const answered = options.taken === '' || !readable
    ? ''
    : `<p class="discl">${escapeHtml(takeSays(
      options.taken,
      options.hold.kind === 'unread' ? null : options.hold.hold,
      view.state,
    ))}</p>`;
  // A case nobody can take answers nothing about a hold — but it still owes
  // the reviewer the answer to the take they just posted. `not_waiting` and
  // `unknown_run` are exactly the outcomes a case that left the queue
  // produces, so the sentence is drawn whatever the state.
  if (view.state !== 'awaiting_approval') {
    return answered === '' ? '' : `<div class="holdbar">${answered}</div>`;
  }
  const read = options.hold;
  if (read.kind === 'unread') {
    // No claim, and no control that would rest on one. The approval bar is
    // still drawn: a fault reading the hold says nothing about the approval.
    return '<div class="holdbar"><p class="discl">The hold on this case was not read,'
      + ' so this page does not say who has it.'
      + ` The console log names the fault ${escapeHtml(read.tag)}.</p></div>`;
  }
  const hold = read.hold;
  const said = answered;
  const field = `<input type="hidden" name="runId" value="${escapeHtml(view.runId)}">`;
  // DEC-47: the queue filters ride on every form that returns to the case,
  // so a take, a release or a handover does not drop the queue the reviewer
  // was reading. They travel on the action's query string, as the approval's
  // do, and never as a field.
  const filters = escapeHtml(filtersQuery(options.rule, options.product));

  if (hold === null) {
    return `<div class="holdbar"><p class="discl">Nobody holds this case.</p>`
      + `<form method="post" action="/take${filters}">${field}`
      + `<button class="btn" type="submit">Take this case</button></form>${said}</div>`;
  }
  if (hold.mine) {
    return `<div class="holdbar"><p class="discl">Held by you · ${escapeHtml(remainingSays(hold.remainingMs))}.</p>`
      + `<form method="post" action="/take${filters}">${field}<input type="hidden" name="release" value="1">`
      + `<button class="btn" type="submit">Release it</button></form>`
      // The handover names a teammate. The identity is text rather than a
      // list of the team: the console shows no roster, and the core refuses
      // a name that is not on it.
      + `<form method="post" action="/take${filters}">${field}<input type="hidden" name="handover" value="1">`
      + `<input class="identity" name="to" type="text" size="18" placeholder="teammate identity"`
      + ` value="${escapeHtml(options.handoverTo)}">`
      + `<button class="btn" type="submit">Hand it over</button></form>${said}</div>`;
  }
  return `<div class="holdbar"><p class="discl">Held by ${escapeHtml(hold.reviewer)}`
    + ` · ${escapeHtml(remainingSays(hold.remainingMs))}.</p>`
    + `<form method="post" action="/take${filters}">${field}`
    + '<input type="hidden" name="over" value="1">'
    + `<button class="btn" type="submit">Take it over</button></form>${said}</div>`;
}

/**
 * What a take, release or handover answered, in the words the case shows.
 *
 * A refusal that lost the hold names whoever holds it now (DEC-46, criterion
 * 6). "Somebody else holds this case" sends the reviewer looking for who, and
 * this page has just read that — so it says the name, and an earlier holder
 * learns of the move at their next action.
 *
 * The read finds nobody when the hold moved again, or lapsed in the instant
 * between the refusal and this page. The sentence says that, rather than
 * naming a holder who is gone or claiming a holder at all.
 */
function takeSays(outcome: string, hold: CaseHold | null, state: string): string {
  if (outcome === 'held_by_other' || outcome === 'not_yours') {
    if (hold === null) return 'The hold moved, and nobody holds this case now.';
    if (!hold.mine) return `${hold.reviewer} holds this case now. Take it over to move it to you.`;
  }
  // `Object.hasOwn`, never a bare read, for the reason `renderOutcome` gives:
  // a plain object literal inherits from `Object.prototype`, so `?taken=
  // toString` resolved a function and `escapeHtml` threw on it — a 500 from a
  // link anyone can send a reviewer. And a value this console does not know
  // gets its own sentence rather than being echoed as the console's words.
  const known = Object.hasOwn(TAKE_SAYS, outcome) ? TAKE_SAYS[outcome]! : UNKNOWN_TAKE;
  // A sentence about a hold must fit the hold this page just read. `?taken=
  // taken` on a page that reloaded after the hold lapsed drew "You hold this
  // case now" beside "Nobody holds this case", and a link can carry any of
  // these values — the approval outcome is checked the same way.
  return takenFits(outcome, hold, state) ? known : UNKNOWN_TAKE;
}

/** What an outcome this console does not know is answered with. */
const UNKNOWN_TAKE = 'That is not an answer this console knows.';

/**
 * Whether an outcome can be the answer about the hold this page read.
 *
 * Each one leaves a fact to check it against: a take ends with the taker
 * holding the case, a release with nobody holding it, a handover with the
 * teammate holding it. `held_by_other` and `not_yours` are about a hold
 * somebody else has, and `takeSays` words them on the hold it read.
 */
function takenFits(outcome: string, hold: CaseHold | null, state: string): boolean {
  switch (outcome) {
    case 'taken':
    case 'not_a_reviewer':
    case 'already_yours':
      return hold !== null && hold.mine;
    case 'released':
    case 'not_held':
      return hold === null;
    case 'handed_over':
      return hold !== null && !hold.mine;
    // The case is not one anybody takes, which is the state this page read.
    case 'not_waiting':
      return state !== 'awaiting_approval';
    // A run the ledger does not hold has no page at all, so this is never the
    // answer here.
    case 'unknown_run':
      return false;
    // About a hold somebody else has. `takeSays` words them on the hold it
    // read, and the sentence must not appear beside a hold that is the
    // reader's own: "Somebody else holds this case" under "Held by you" is
    // the same contradiction the other outcomes are checked for.
    case 'held_by_other':
    case 'not_yours':
      return hold === null || !hold.mine;
    default:
      return false;
  }
}

/** What a take answered, in the words the case shows. */
const TAKE_SAYS: Readonly<Record<string, string>> = {
  taken: 'You hold this case now.',
  released: 'You released this case.',
  held_by_other: 'Somebody else holds this case. Take it over to move it to you.',
  not_waiting: 'This case is not waiting for a person, so nobody can take it.',
  unknown_run: 'The ledger does not hold that case.',
  handed_over: 'The case is theirs now.',
  not_a_reviewer: 'That identity is not an active reviewer, so the case stayed yours.',
  not_yours: 'Somebody else holds this case now, so it did not move.',
  already_yours: 'You already hold this case, so it did not move.',
  not_held: 'Nobody held this case, so there was nothing to hand over.',
};

/**
 * The bar at the foot of the case: the approval, or why there is none.
 *
 * The warnings are worded by `actOf`, and say whether the act can be undone.
 */
function actionBar(view: CaseView, act: Act, options: CaseOptions): string {
  const inner = view.state !== 'awaiting_approval'
    ? `<p class="discl">This run is ${escapeHtml(view.state)}, so there is nothing here to approve.</p>`
    : act.kind === 'none'
      ? `<p class="discl">${escapeHtml(act.says)}</p>`
      // The digest is of the reply this page drew, which is the text the
      // ledger parked and the text the approval will compare against.
      : approveForm(
        view.runId,
        act.label,
        act.says,
        { rule: options.rule, product: options.product },
        replyDigest(view.evidence.draftBody ?? ''),
      )
        + (act.kind === 'reply' ? `<p class="readback">${escapeHtml(readBackSays(options.readBack))}</p>` : '');
  return `<div class="actionbar">${inner}</div>`;
}

/** Whether an approval here measures the edit a person made (section 4.10). */
function readBackSays(readBack: string | null): string {
  return readBack === null
    ? 'This console reads no draft back, so an approval here records no edit distance.'
    : `Approving reads the helpdesk draft back through ${readBack} first, and records how far a person edited it.`;
}

/** What approving a run performs, and the words the button and warning use. */
type Act =
  | { readonly kind: 'none'; readonly says: string }
  | { readonly kind: 'reply' | 'action'; readonly label: string; readonly says: string };

/**
 * The approval, and what it will do (DEC-11, DEC-34, DEC-40).
 *
 * Three cases. A customer reply parks as a helpdesk draft. A gated write with
 * no customer draft parks in the ledger alone, and `approveRun` relays its
 * journalled payload. A park carrying neither is refused by `approveRun`, so
 * no button is offered for it.
 *
 * The warning differs because the act differs, and it says whether the act
 * can be undone. An irreversible write parks in the ledger, so it is here,
 * and a compensation is `at_most_once`: it never retries, and an unconfirmed
 * send escalates as `delivery_unknown` (DEC-30). A person pressing this on a
 * payment reversal is owed both facts.
 */
function actOf(run: RunDetail): Act {
  if (run.draftExternalId === null && !run.payloadRecorded) {
    return {
      kind: 'none',
      says: 'This run parked neither a helpdesk draft nor an action'
        + ' payload, so there is nothing here to approve. An operator reconciles it by hand.',
    };
  }
  if (run.draftExternalId !== null) {
    // No text box. The draft parks in the helpdesk and is edited there
    // (DEC-11, DEC-40); the relay sends that draft verbatim, so a body typed
    // here would be recorded and never sent.
    return {
      kind: 'reply',
      label: 'Approve and send',
      says: 'The reply above is what the system drafted. The helpdesk holds the copy the'
        + ' relay sends, so edit it there — a person may have changed it since. This sends that'
        + ' copy as it stands, and a sent reply cannot be recalled.',
    };
  }
  // Read from the action, not from which rule happened to fire first.
  //
  // A gate reason names the rule that stopped the run. The engine tests
  // idempotency, read-back, customer visibility, irreversibility and risk in
  // that order, so a compensation on an adapter with no idempotency key stops
  // at `no_idempotency` and never reports `irreversible` — while still being
  // the one action on this console that cannot be taken back.
  const permanent = run.actionClass === COMPENSATION_ACTION_CLASS;
  const atMostOnce = run.delivery === 'at_most_once';
  return {
    kind: 'action',
    label: 'Approve and perform',
    says: 'No reply goes to a customer. This run parked an action in the ledger, and'
      + ` approving it performs ${run.actionClass ?? 'the action'} through the adapter with the`
      + ' payload the run journalled.'
      + (permanent ? ' This action cannot be undone once it runs.' : '')
      + (atMostOnce
        ? ' It is sent at most once and never retried, so a send nobody can confirm'
          + ' escalates rather than repeating.'
        : ''),
  };
}

/**
 * The action an approval performs, field by field (DEC-34, DEC-40).
 *
 * A ledger-only park has no drafted reply, so this is what the approver is
 * reading — and DEC-40 permits this console to approve exactly because they
 * read it. The page named the action and showed nothing of its content, which
 * is the shape that rule exists to prevent.
 *
 * Values are stringified rather than rendered structurally. An operator needs
 * to see an amount and a target; a nested viewer would be a second surface
 * with its own failure modes over a payload that is flat in every action this
 * system ships.
 */
function payloadBlock(payload: Readonly<Record<string, unknown>> | null): string {
  if (payload === null) {
    return nothing('This run parked an action and recorded no payload for it.');
  }
  const rows = Object.entries(payload);
  if (rows.length === 0) {
    return nothing('This run parked an action whose payload is empty.');
  }
  return [
    '<div class="card"><header>',
    '<span class="lbl">What approving this performs</span>',
    chip('the payload the run journalled'),
    '</header><div class="body"><dl class="kv">',
    ...rows.map(([key, value]) => `<dt>${escapeHtml(key)}</dt>`
      + `<dd>${escapeHtml(typeof value === 'string' ? value : JSON.stringify(value) ?? 'null')}</dd>`),
    '</dl></div></div>',
  ].join('');
}

/**
 * The warning and the one button, which every approval path shares.
 *
 * Two fields, and neither carries text: the run, and a digest of the reply
 * this page drew (DEC-46). The approval recomputes the digest under the run's
 * lock, so a reply rewritten after this page was built is refused rather than
 * approved as shown. The digest is why no body is posted, and the relay sends
 * the parked draft verbatim in any case.
 */
function approveForm(
  runId: string,
  label: string,
  says: string,
  filters: { readonly rule: string | null; readonly product: string | null },
  shown: string | null = null,
): string {
  return [
    '<div class="warnbar"><span class="dot" style="color:var(--accent); margin-top:5px"></span>',
    `<div>${escapeHtml(says)}</div></div>`,
    // The filters ride on the action, not in a field, and both of them: an
    // approval that came from a narrowed queue returns to that queue
    // (DEC-47). The POST reads them off the URL, so a body cannot set one.
    // Escaped, because the pair holds an `&` and an attribute carries
    // `&amp;`. The POST reads it back decoded, so the filter survives the
    // round trip either way.
    `<form method="post" action="/approve${escapeHtml(filtersQuery(filters.rule, filters.product))}">`,
    `<input type="hidden" name="runId" value="${escapeHtml(runId)}">`,
    shown === null ? '' : `<input type="hidden" name="shown" value="${escapeHtml(shown)}">`,
    `<button class="btn primary" type="submit">${escapeHtml(label)}</button>`,
    '</form>',
  ].join('');
}

/** One turn of a conversation, as the reader returned it. */
export interface TurnView {
  readonly turnNumber: number;
  readonly ticketId: string;
  /** When the message arrived. The ledger requires one on every turn. */
  readonly createdAt: Date;
  readonly bodyText: string | null;
  readonly messageAbsence: string | null;
  readonly replyText: string | null;
  readonly replyAbsence: string | null;
  readonly runId: string | null;
  readonly runState: string | null;
  readonly runAttempts: number;
  /** What the relay recorded on the turn's outbox row, read across all its runs, or null. */
  readonly outboxStatus: OutboxStatus | null;
}

/** One customer problem, and every turn of it. */
export interface ThreadView {
  readonly conversationId: string;
  readonly primaryTicketId: string;
  readonly state: string;
  /** When the customer's problem started. Null when the ledger holds none. */
  readonly openedAt: Date | null;
  readonly participantNamed: boolean;
  readonly turns: readonly TurnView[];
}

/**
 * What each absence means, in the words a responder needs.
 *
 * Six codes and six sentences. They are what the reader distinguishes, and a
 * surface that rendered two of them alike would send an operator to the wrong
 * place — which is the whole reason the reader distinguishes them.
 * `replyAbsenceSays` replaces the `no_reply_sent` sentence on a turn whose row
 * the relay did not refuse.
 */
const REPLY_ABSENCE: Readonly<Record<string, string>> = {
  handled_automatically: 'answered by an internal write; no reply was sent to the customer',
  approved_without_reply: 'a person approved an action here; no reply text was recorded',
  // Not "a reply is drafted": an internal write parks with no draft (DEC-34).
  awaiting_approval: 'this turn waits for a person to approve it',
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

/**
 * Why a turn shows no reply, in words that agree with the turn's row.
 *
 * The absence code is the run's own: a run that stopped sent nothing. The row
 * is read across every run of the turn, so a superseded retry sits on a row an
 * earlier run sent, and a run the relay escalated holds an action nobody can
 * confirm. Saying nothing went out would contradict the chip beside it. Only a
 * malformed row proves the relay sent nothing, so it keeps the sentence.
 *
 * The row on a turn with no reply text is an action this page cannot call a
 * customer reply: an internal write, or one a person approved (DEC-12,
 * DEC-34). So the words name the action and never a reply.
 */
function replyAbsenceSays(turn: TurnView): string {
  const code = turn.replyAbsence ?? 'not_retained';
  if (code !== 'no_reply_sent' || turn.outboxStatus === null || turn.outboxStatus === 'malformed') {
    return absenceSays(REPLY_ABSENCE, code);
  }
  switch (turn.outboxStatus) {
    case 'sent': return 'the run stopped; the action recorded on this turn was sent';
    case 'pending': return 'the run stopped; the action recorded on this turn is still to be sent';
    // `fenced` and `delivery_unknown`, and any value the core would refuse.
    default: return 'the run stopped; nobody can confirm the action recorded on this turn';
  }
}

/** Surface 6: one conversation, read the way a responder reads it. */
export function renderConversation(thread: ThreadView): string {
  return [
    '<div class="casehd">',
    '<div class="casetitle">',
    `<span class="m casesubj">${escapeHtml(thread.primaryTicketId)}</span>`,
    chip(thread.state, thread.state === 'open' ? 'accent' : 'dim'),
    '</div>',
    '<div class="m casemeta">',
    escapeHtml([
      `conversation ${thread.conversationId}`,
      `${thread.turns.length} ${thread.turns.length === 1 ? 'turn' : 'turns'}`,
      `opened ${whenSays(thread.openedAt)}`,
      // Whether it is bound to somebody, never who. An approver already sees
      // the message that address sent.
      thread.participantNamed ? 'participant named' : 'no participant named',
    ].join(' · ')),
    '</div>',
    '</div>',
    thread.turns.length === 0
      ? nothing('This conversation holds no turn.')
      : `<div class="wrap turns">${thread.turns.map((turn) => turnBlock(turn)).join('')}</div>`,
  ].join('');
}

/**
 * What became of a turn, in a word or two.
 *
 * Read from the same facts as the reply's absence, so the chip and the
 * sentence below it cannot disagree. `auto-answered` is a resolved run that
 * recorded no approver. That is a run no person saw, or one approved before
 * db/016 added the column, and the ledger cannot tell those two apart. DEC-12
 * sends every customer reply through a person, so a person approved every
 * turn with reply text. A turn no run joins says nothing about who answered it.
 *
 * Only a recorded send draws the success colour. A resolved run commits its
 * outbox row and no more, so the relay's status is added to the chip until it
 * says `sent`. The row can belong to an earlier run of the turn than the one
 * the chip names, so a run that did not settle names its state beside the row.
 */
function turnOutcome(turn: TurnView): { readonly says: string; readonly token: Token } {
  // The run the turn shows waits for a person, whatever an earlier run of the
  // turn sent. The approval queue lists it, and this page must agree.
  if (turn.runState === 'awaiting_approval') return { says: 'waiting for you', token: 'warn' };
  if (turn.replyText !== null) {
    // A person approved this text, and the row says what became of the send.
    // A run shown beside it that did not settle is a separate fact: it may be
    // the approval's own run escalating (DEC-30), or a later run on the turn.
    return settled(turn.runState)
      ? delivered('approved', turn.outboxStatus)
      : withRow(`approved · ${turn.runState}`, turn.runState === 'escalated' ? 'hot' : 'dim', turn.outboxStatus);
  }
  switch (turn.replyAbsence) {
    case 'handled_automatically': return delivered('auto-answered', turn.outboxStatus);
    case 'approved_without_reply': return delivered('approved', turn.outboxStatus);
    case 'in_flight': return withRow('in flight', 'dim', turn.outboxStatus);
    case 'not_retained': return { says: 'no run', token: 'dim' };
    default:
      // A run that stopped, or an absence this console does not know. Either
      // way the ledger's own state is the one thing it can say for certain.
      return turn.runState === null
        ? { says: 'no run', token: 'dim' }
        : withRow(turn.runState, turn.runState === 'escalated' ? 'hot' : 'dim', turn.outboxStatus);
  }
}

/**
 * Whether the run the turn shows leaves the row to say what happened.
 *
 * A resolved run committed its row. A superseded run lost the insert to a row
 * another run holds (section 4.2, rule 2), so that row is its outcome too.
 */
function settled(runState: string | null): runState is null | 'resolved' | 'superseded' {
  return runState === null || runState === 'resolved' || runState === 'superseded';
}

/**
 * A run state, and the row of the turn when one exists.
 *
 * A retry that stopped or still runs is a fact beside the row an earlier run
 * holds, and neither hides the other. A row that is neither sent nor pending
 * draws hot.
 */
function withRow(word: string, token: Token, outboxStatus: OutboxStatus | null): { readonly says: string; readonly token: Token } {
  if (outboxStatus === null) return { says: word, token };
  const neitherSentNorPending = outboxStatus !== 'sent' && outboxStatus !== 'pending';
  return { says: `${word} · ${outboxStatus}`, token: neitherSentNorPending ? 'hot' : token };
}

/**
 * A resolved outcome, qualified by what the relay recorded.
 *
 * `sent` is the one status that says the act happened. `pending` is a send
 * still to come. Any other status is a send that did not or may not have
 * happened. No status at all, on a run with no outbox row, claims nothing.
 */
function delivered(word: string, outboxStatus: OutboxStatus | null): { readonly says: string; readonly token: Token } {
  if (outboxStatus === 'sent') return { says: word, token: 'ok' };
  if (outboxStatus === null) return { says: word, token: 'dim' };
  return { says: `${word} · ${outboxStatus}`, token: outboxStatus === 'pending' ? 'dim' : 'hot' };
}

/**
 * The heading over a turn's reply, which says what the customer has.
 *
 * "The system replied" only when a person approved text and the relay
 * recorded sending it. An absent reply is headed as the reply, because the
 * sentence below says whether anything was sent.
 *
 * Only a malformed row proves nothing went out. Every other status short of
 * `sent` may follow a send that landed: the relay leaves a row pending after a
 * send that timed out, and fences it on a later scan once the epoch moves on
 * (DEC-28). A heading that said "never sent" over those would invite a second
 * reply to a customer who already has one.
 */
function replyHeading(turn: TurnView): string {
  if (turn.replyText === null) {
    // Not "drafted": a parked internal write holds no draft (DEC-34).
    return turn.runState === 'awaiting_approval' ? 'waiting for a person' : 'the reply';
  }
  // The row alone decides, never the run state. The row can belong to an
  // earlier run than the one the chip names, and the chip names that run.
  switch (turn.outboxStatus) {
    // The relay sets `sent` only after the adapter answers, and every status
    // update is guarded on `pending`, so nothing rewrites it.
    case 'sent': return 'the system replied';
    // The relay refuses a malformed payload before any adapter call, so the
    // ledger knows nothing went out. Nothing rewrites a payload, so this holds
    // unless a relay deploy tightens the payload check after a send timed out.
    case 'malformed': return 'approved, never sent';
    case 'pending': return 'approved, send pending';
    case null: return 'a person approved this reply';
    // `fenced` and `delivery_unknown`. The core refuses any status outside
    // its set, so nothing else reaches here from the ledger. A value that did
    // would confirm nothing, and a heading is never left empty.
    default:
      return 'approved, delivery not confirmed';
  }
}

/** One turn: what the customer wrote, and what the system did about it. */
function turnBlock(turn: TurnView): string {
  const outcome = turnOutcome(turn);
  // A waiting run opens as its case, even on a turn an earlier run answered.
  const waiting = turn.runState === 'awaiting_approval';
  return [
    '<div class="turn">',
    '<div class="turnmeta">',
    `<span class="lbl">turn ${escapeHtml(String(turn.turnNumber))}</span>`,
    `<span class="m turnfact">${escapeHtml(whenSays(turn.createdAt))}</span>`,
    chip(outcome.says, outcome.token),
    `<span class="m turnfact">${escapeHtml(turn.ticketId)}</span>`,
    turn.runId === null
      ? ''
      // A waiting turn opens as a case, where it can be approved. Any other
      // run opens as the record of what it did.
      : waiting
        ? `<a class="m turnfact" href="/case/${encodeURIComponent(turn.runId)}">open the case</a>`
        : `<a class="m turnfact" href="/run/${encodeURIComponent(turn.runId)}">${
          escapeHtml(turn.runState ?? 'run')}</a>`,
    // More than one run worked this turn, which means the consumer retried.
    // Counted rather than drawn as extra turns: a turn that took three runs
    // to abandon is one message the customer sent.
    turn.runAttempts > 1
      ? `<span class="m turnfact warn">${
        escapeHtml(String(turn.runAttempts))} attempts</span>`
      : '',
    '</div>',
    '<div class="turnbody">',
    '<div class="said">',
    '<div class="who">the customer wrote</div>',
    // The absence decides here too, for the reason above.
    turn.messageAbsence !== null || turn.bodyText === null
      ? `<p class="absent">${escapeHtml(absenceSays(MESSAGE_ABSENCE, turn.messageAbsence ?? 'not_retained'))}</p>`
      : `<div class="prose">${escapeHtml(turn.bodyText)}</div>`,
    '</div>',
    '<div class="said">',
    `<div class="who">${escapeHtml(replyHeading(turn))}</div>`,
    turn.replyText === null
      ? `<p class="absent${waiting ? ' waiting' : ''}">${
        escapeHtml(replyAbsenceSays(turn))}</p>`
      // Nothing stops an approval recording a blank body: the helpdesk copy
      // read back is what it stores. A blank is the one thing a turn never
      // draws, so the blank is named.
      : turn.replyText.trim() === ''
        ? '<p class="absent">a person approved a reply that holds no text</p>'
        : `<div class="prose">${escapeHtml(turn.replyText)}</div>`,
    '</div>',
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
  /**
   * Share of the widest value on this surface, so the bars compare, or null
   * when the percentile was not measured. A null draws no track: an empty
   * track and a track filled to zero look alike, and only one is a reading.
   */
  readonly share: number | null;
}

export interface LatencyRow {
  readonly partition: number;
  readonly wait: readonly Percentile[];
  readonly service: readonly Percentile[];
  readonly runs: number;
  /** Counts the job reports beside the figures, already worded. */
  readonly caveats: readonly string[];
}

/**
 * Why the console works the way it does, one card per rule.
 *
 * Each card states what the console does now, and names no code it replaced.
 * A card joins only when the console makes it true: a card for a feature not
 * yet built ships with that feature, so this page never describes a console
 * nobody can use. Every sentence here is a claim about another surface. The
 * server suite pins the words, and checks each claim against the renderer.
 */
const DESIGN_NOTES: readonly { readonly token: Token; readonly title: string; readonly says: string }[] = [
  {
    token: 'warn',
    title: 'The gates stay apart, everywhere',
    says: 'No screen combines agreement and coverage into one score, because the system never computes one'
      + ' and could not act on it. A screen that shows both shows each value on its own.'
      + ' The queue group Both gates clean holds a case only when both values and both lines are recorded,'
      + ' and each value clears its own line.',
  },
  {
    token: 'ok',
    title: 'An absence is still a sentence',
    says: 'A turn with no message or no reply names why, in a sentence of its own.'
      + ' On a run or case page, a gate with no recorded value shows an em dash with a note that names the absence,'
      + ' and draws no bar.'
      + ' No screen renders an unmeasured value as zero, because a zero would read as a measurement.',
  },
  {
    token: 'dim',
    title: 'The engineer surfaces sit under Admin',
    says: 'Runs, control bands and partition latency sit under Admin.'
      + ' They answer questions about the pipeline, and a person clearing a queue between'
      + ' two engineering tasks is not asking them.',
  },
  {
    token: 'ok',
    title: 'Product is a first-class column',
    says: 'Each run records the product of the channel its message arrived on, and the console reads that'
      + ' value rather than inferring one from the message.'
      + ' Every queue row names the product it is for, and a run whose channel the map does not name says'
      + ' no product rather than drawing a blank.'
      + ' A chip per product carries the count read from every waiting run, so narrowing the queue never'
      + ' reports it as smaller than it is.'
      + ' The products a reviewer covers read first, and that order hides nothing: every waiting case is'
      + ' still on the page.',
  },
  {
    token: 'accent',
    title: 'A lock, because four people pull from one uncapped list',
    says: 'The queue is not capped, so the same case can sit in front of four reviewers at once.'
      + ' A reviewer takes a case before working it, so the others see who holds it and the time left.'
      + ' The hold says who is working, and it refuses no write: any reviewer may still approve the case.'
      + ' A hold lapses on its own without activity, twenty minutes by default.'
      + ' Taking a second case releases the first, because a person reads one case at a time.',
  },
];

/** The design notes: what the console does, and why. */
export function renderDesignNotes(): string {
  return [
    head('Design notes', 'Why the console works this way. Each card states a rule the console keeps, and the reason for it.'),
    '<div class="wrap designnotes">',
    ...DESIGN_NOTES.map((note) => [
      `<div class="designnote" style="border-left-color:var(--${note.token})">`,
      `<div class="designnotetitle">${escapeHtml(note.title)}</div>`,
      `<div class="designnotesays">${escapeHtml(note.says)}</div>`,
      '</div>',
    ].join('')),
    '</div>',
  ].join('');
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
      p.share === null
        ? '<span></span>'
        : `<span class="track"><i style="width:${(p.share * 100).toFixed(1)}%; background:${colour}"></i></span>`,
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
 * Every outcome gets a sentence, and the compiler holds the set closed: a new
 * variant with no sentence fails the build. A page that reloaded silently told
 * the operator nothing, and `draft_missing` in particular is a refusal that
 * looked exactly like success.
 *
 * `read_back_failed` is the console's own. The read-back runs before the
 * approval opens its transaction, so a failed read committed nothing.
 */
const OUTCOMES = {
  approved: 'Approved. The relay performs it next.',
  unknown_run: 'That run is not in the ledger.',
  not_awaiting_approval: 'That run is not waiting for approval.',
  superseded: 'Another action already holds this key, so nothing was sent.',
  stale_epoch: 'Another owner took this ticket. Nothing was sent.',
  draft_missing: 'The parked draft is gone, so nothing was sent.',
  // DEC-46: the reply moved under the reviewer. The page that drew it is
  // stale, so the answer says to read the case again rather than to retry.
  shown_changed: 'The reply changed since this page was drawn, so nothing was sent.'
    + ' Open the case again to read it as it is now.',
  read_back_failed: 'The helpdesk draft could not be read back, so nothing was sent. The console log holds the fault.',
} as const satisfies Record<ConsoleApproveOutcome['outcome'], string>;

/** What an outcome is checked against: the run's state, and whether it was approved. */
export interface OutcomeRun {
  readonly state: string;
  readonly approved: boolean;
}

/**
 * Whether an outcome can be the ledger's answer about `run`, or about no run.
 *
 * The outcome arrives on the query string, so a link can carry any of them.
 * Each one leaves a fact it can be checked against. An approval records an
 * approver, and nothing else does, so it holds however the relay moved the run
 * afterwards. A gone or unread draft leaves the run waiting. A run the ledger
 * does not hold has no state at all. An outcome its run contradicts is a
 * sentence somebody wrote for the approver.
 *
 * A run approved before `db/016` recorded approvers has none, so an old link
 * to one reads as an outcome this console does not know. Accepting a resolved
 * run in its place would let a link claim an approval on a run that resolved
 * on the automatic path, which records no approver either.
 */
function outcomeFits(outcome: string, run: OutcomeRun | null): boolean {
  if (run === null) return outcome === 'unknown_run';
  const { state } = run;
  switch (outcome) {
    case 'approved':
      return run.approved;
    case 'draft_missing':
    case 'read_back_failed':
    // DEC-46: the shown-text refusal commits nothing, so the run is still
    // waiting. A run that is not is a sentence somebody wrote.
    case 'shown_changed':
      return state === 'awaiting_approval';
    case 'not_awaiting_approval':
      return state !== 'awaiting_approval';
    case 'unknown_run':
      return false;
    default:
      // `superseded` and `stale_epoch` refuse a move the fence decided. They
      // leave no state of their own to check against.
      return true;
  }
}

/**
 * The sentence for one known outcome, on the run it fits.
 *
 * `not_awaiting_approval` is the one outcome whose sentence depends on the
 * run: DEC-46's guard refuses a case whose state changed under the reviewer,
 * and the answer has to name the state it changed to. The state is the
 * ledger's own, and `outcomeFits` has already established that it is not
 * `awaiting_approval`, so a link cannot put words here.
 */
function outcomeSays(outcome: string, run: OutcomeRun | null): string {
  if (outcome === 'not_awaiting_approval' && run !== null) {
    return `That run is not waiting for approval. It is ${run.state} now, so nothing was sent.`;
  }
  return OUTCOMES[outcome as keyof typeof OUTCOMES];
}

/**
 * The outcome sentence for the approval just posted, on the run it concerns.
 *
 * `run` is the run as it stands now, or null on a page that has no run. An
 * outcome the run contradicts gets the fixed sentence an unknown outcome gets.
 */
export function renderOutcome(outcome: string, run: OutcomeRun | null): string {
  // `Object.hasOwn`, never a bare read. A plain object literal inherits from
  // Object.prototype, so `?outcome=toString` resolved a function, `escapeHtml`
  // called `.replace` on it and the approval queue became a 500 page. This is
  // the same defect the policy engine's per-intent map had, in a second place.
  const known = Object.hasOwn(OUTCOMES, outcome) && outcomeFits(outcome, run);
  const said: string | undefined = known
    ? outcomeSays(outcome, run)
    : undefined;
  // Anything else still gets a sentence, because a silent fall-through would
  // be the defect this function exists to fix. It is never echoed. The outcome
  // arrives on the query string, so a link can carry any text, and text shown
  // as the ledger's answer is a sentence an attacker wrote for the approver.
  // Every outcome the approval returns has a sentence above, so only a
  // hand-written link reaches this.
  //
  // Only an approval wears the success style. Every other known outcome is a
  // refusal, and nothing was sent.
  const style = said === undefined ? '' : outcome === 'approved' ? ' ok' : ' refused';
  // An approval stands whatever the relay did next. A run the relay escalated
  // is a person's again, so the page does not promise the relay will perform
  // it.
  // The relay's next step is promised only on a resolved run, and no raw
  // state name reaches the page.
  const worded = said === undefined || outcome !== 'approved' || run === null || run.state === 'resolved'
    ? said
    : run.state === 'escalated'
      ? 'Approved. The relay escalated the run, so a person has it now.'
      : 'Approved.';
  return [
    '<div class="wrap" style="padding-bottom:0">',
    said === undefined
      ? '<p class="outcome">'
      : `<p class="outcome${style}" data-outcome="${escapeHtml(outcome)}">`,
    escapeHtml(worded ?? 'The ledger answered with an outcome this console does not know.'),
    '</p></div>',
  ].join('');
}
