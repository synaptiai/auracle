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
import { escapeHtml, renderGates, renderMetricValue } from './render.js';
import type { MetricValue } from './render.js';

export interface RunRow {
  readonly runId: string;
  readonly ticketId: string;
  readonly state: string;
  readonly promptVer: string;
  readonly reason: string | null;
  readonly stepsUsed: number;
}

const SURFACES: readonly { readonly href: string; readonly title: string }[] = [
  { href: '/', title: 'Runs' },
  { href: '/approvals', title: 'Approval queue' },
  { href: '/bands', title: 'Control bands' },
  { href: '/latency', title: 'Partition latency' },
];

/** The shell every surface renders inside. */
export function page(title: string, body: string): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<title>${escapeHtml(title)} — Auracle console</title>`,
    '<link rel="stylesheet" href="/console.css">',
    '</head><body><div class="root"><div class="shell">',
    '<nav class="side">',
    ...SURFACES.map((s) => `<a href="${s.href}">${escapeHtml(s.title)}</a>`),
    '</nav>',
    `<main><h1>${escapeHtml(title)}</h1>`,
    body,
    '</main></div></div></body></html>',
  ].join('');
}

/** Surface 1: the runs list. */
export function renderRuns(runs: readonly RunRow[]): string {
  if (runs.length === 0) return '<p class="mut">No runs.</p>';
  const rows = runs.map((run) => [
    '<tr>',
    `<td class="m"><a href="/run/${encodeURIComponent(run.runId)}">${escapeHtml(run.runId)}</a></td>`,
    `<td class="m">${escapeHtml(run.ticketId)}</td>`,
    `<td>${escapeHtml(run.state)}</td>`,
    `<td class="m">${escapeHtml(run.promptVer)}</td>`,
    `<td class="m">${escapeHtml(String(run.stepsUsed))}</td>`,
    '</tr>',
  ].join(''));
  return [
    '<table><thead><tr>',
    '<th>Run</th><th>Ticket</th><th>State</th><th>Prompt</th><th>Steps</th>',
    '</tr></thead><tbody>',
    ...rows,
    '</tbody></table>',
  ].join('');
}

export interface RunDetail extends RunRow {
  readonly agreement: number | null;
  readonly coverage: number | null;
  readonly draftExternalId: string | null;
}

/** Surface 2: one run, with its two gates shown apart. */
export function renderRunDetail(run: RunDetail): string {
  return [
    `<p class="m">${escapeHtml(run.runId)}</p>`,
    '<dl>',
    `<dt class="lbl">Ticket</dt><dd class="m">${escapeHtml(run.ticketId)}</dd>`,
    `<dt class="lbl">State</dt><dd>${escapeHtml(run.state)}</dd>`,
    `<dt class="lbl">Reason</dt><dd>${escapeHtml(run.reason ?? '—')}</dd>`,
    '</dl>',
    renderGates({ agreement: run.agreement, coverage: run.coverage }),
  ].join('');
}

/** Surface 3: the approval queue, and the console's one write. */
export function renderApprovals(runs: readonly RunDetail[]): string {
  if (runs.length === 0) return '<p class="mut">Nothing is waiting for a person.</p>';
  return runs.map((run) => [
    '<section class="card">',
    `<p class="m"><a href="/run/${encodeURIComponent(run.runId)}">${escapeHtml(run.runId)}</a></p>`,
    // What a person needs to decide, rather than an id and a button. DEC-12
    // puts a person on every customer reply, so the queue has to tell them
    // which ticket, what state it is in and why it stopped.
    '<dl>',
    `<dt class="lbl">Ticket</dt><dd class="m">${escapeHtml(run.ticketId)}</dd>`,
    `<dt class="lbl">State</dt><dd>${escapeHtml(run.state)}</dd>`,
    `<dt class="lbl">Reason</dt><dd>${escapeHtml(run.reason ?? '—')}</dd>`,
    `<dt class="lbl">Draft</dt><dd class="m">${escapeHtml(run.draftExternalId ?? '—')}</dd>`,
    '</dl>',
    renderGates({ agreement: run.agreement, coverage: run.coverage }),
    run.draftExternalId === null
      ? '<p class="mut">No draft is parked, so this cannot be approved here.</p>'
      : [
          // No text box. The draft parks in the helpdesk and is edited there
          // (DEC-11, DEC-40); the relay sends that draft verbatim, so a body
          // typed here would be recorded and never sent.
          '<p class="mut">Edit the draft in the helpdesk. This sends it as it stands.</p>',
          '<form method="post" action="/approve">',
          `<input type="hidden" name="runId" value="${escapeHtml(run.runId)}">`,
          '<button type="submit">Approve</button>',
          '</form>',
        ].join(''),
    '</section>',
  ].join('')).join('');
}

export interface BandRow {
  /** The UTC day judged. Named, because a surface that shows a verdict
   * without its day cannot be checked against `pnpm run bands`. */
  readonly day: string;
  readonly metric: string;
  readonly sample: MetricValue;
  readonly verdict: string | null;
}

/** Surface 4: the control bands, with a named shortfall where there is no verdict. */
export function renderBands(rows: readonly BandRow[]): string {
  if (rows.length === 0) return '<p class="mut">No days measured in the window.</p>';
  return [
    `<p class="lbl">Day ${escapeHtml(rows[0]!.day)}</p>`,
    '<table><thead><tr><th>Metric</th><th>Value</th><th>Verdict</th></tr></thead><tbody>',
    ...rows.map((row) => [
      '<tr>',
      `<td class="m">${escapeHtml(row.metric)}</td>`,
      `<td>${renderMetricValue(row.sample)}</td>`,
      `<td>${row.verdict === null ? '<span class="mut">no verdict</span>' : escapeHtml(row.verdict)}</td>`,
      '</tr>',
    ].join('')),
    '</tbody></table>',
  ].join('');
}

export interface LatencyRow {
  readonly partition: number;
  readonly waitP50: string;
  readonly waitP95: string;
  readonly serviceP50: string;
  readonly serviceP95: string;
  readonly runs: number;
}

/** Surface 5: queue wait and service time per partition. */
export function renderLatency(rows: readonly LatencyRow[]): string {
  if (rows.length === 0) return '<p class="mut">No partition has run.</p>';
  return [
    '<table><thead><tr>',
    '<th>Partition</th><th>Wait p50</th><th>Wait p95</th>',
    '<th>Service p50</th><th>Service p95</th><th>Runs</th>',
    '</tr></thead><tbody>',
    ...rows.map((row) => [
      '<tr>',
      `<td class="m">${escapeHtml(String(row.partition))}</td>`,
      `<td class="m">${escapeHtml(row.waitP50)}</td>`,
      `<td class="m">${escapeHtml(row.waitP95)}</td>`,
      `<td class="m">${escapeHtml(row.serviceP50)}</td>`,
      `<td class="m">${escapeHtml(row.serviceP95)}</td>`,
      `<td class="m">${escapeHtml(String(row.runs))}</td>`,
      '</tr>',
    ].join('')),
    '</tbody></table>',
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
    `<p class="outcome" data-outcome="${escapeHtml(outcome)}">`,
    // An outcome this console does not know is still shown, by name. A
    // silent fall-through would be the defect this function exists to fix.
    escapeHtml(said ?? `The ledger answered: ${outcome}`),
    '</p>',
  ].join('');
}
