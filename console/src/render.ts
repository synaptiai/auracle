// Rendering rules the console cannot break (issue #27, DEC-05).
//
// Two of them come from the design brief and one from the bands job.
//
// The gates are shown apart. DEC-05 keeps sample agreement and groundedness
// coverage independent, and the policy engine never combines them; a console
// that averaged them would put a number on screen the system does not
// compute and cannot act on. The brief states it as a rule for every screen,
// so it lives in one function rather than in five templates.
//
// An unmeasured value is not zero. `bands` reports a named shortfall when a
// day measured nothing, and rendering that as 0 would read as a measurement.
// The shortfall is shown instead, by name, because a reader needs to know
// which one it was.
//
// Everything from the ledger is escaped. A ticket subject and an escalation
// reason are text a customer or a model wrote, and neither is trusted markup.

/** The characters that would otherwise close a tag or an attribute. */
const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

export interface GateValues {
  /** Null when the run was gated before the agreement comparison ran. */
  readonly agreement: number | null;
  /** Null when no coverage was measured for the run. */
  readonly coverage: number | null;
  /**
   * The threshold this run's agreement was compared against.
   *
   * Not stored. The ledger journals the whole threshold set beside the
   * coverage value, and the intent beside the agreement; the scalar is the
   * set applied to the intent. Null when either half is missing, because a
   * threshold from a set this run did not carry is a different run's number.
   */
  readonly agreementThreshold?: number | null;
  /** What the classifier saw, worded by the caller. */
  readonly agreementDetail?: string | null;
  /** DEC-07's two coverage lines, as journalled with the run. */
  readonly coverageBlock?: number | null;
  readonly coverageReview?: number | null;
}

/**
 * The two gates, side by side and separately labelled.
 *
 * There is deliberately no function here that takes both and returns one
 * number. The absence is the rule: a caller cannot ask for a combined score
 * because nothing offers one. Each card is built from one gate's fields, and
 * neither builder can see the other's.
 */
export function renderGates(values: GateValues): string {
  return [
    '<div class="gates">',
    gateCard({
      label: 'Sample agreement',
      value: values.agreement,
      detail: values.agreementDetail ?? null,
      marks: values.agreementThreshold === undefined || values.agreementThreshold === null
        ? []
        : [{ at: values.agreementThreshold, name: 'threshold' }],
    }),
    gateCard({
      label: 'Groundedness coverage',
      value: values.coverage,
      detail: null,
      marks: [
        ...(values.coverageBlock === undefined || values.coverageBlock === null
          ? [] : [{ at: values.coverageBlock, name: 'block' }]),
        ...(values.coverageReview === undefined || values.coverageReview === null
          ? [] : [{ at: values.coverageReview, name: 'review' }]),
      ],
    }),
    '</div>',
  ].join('');
}

interface GateCard {
  readonly label: string;
  readonly value: number | null;
  readonly detail: string | null;
  readonly marks: readonly { readonly at: number; readonly name: string }[];
}

/**
 * One gate, with the lines it was judged against.
 *
 * The bar is drawn only when there is a value. A track with no fill and a
 * track filled to zero look alike at a glance, and only one of them is a
 * measurement.
 */
function gateCard(gate: GateCard): string {
  const named = gate.marks.length === 0
    ? ''
    : `<div class="m" style="font-size:11px; color:var(--mut)">${
      gate.marks.map((m) => `${escapeHtml(m.name)} ${m.at.toFixed(3)}`).join(' · ')}</div>`;
  const bar = gate.value === null ? '' : [
    '<div class="track">',
    `<i style="width:${(Math.min(1, Math.max(0, gate.value)) * 100).toFixed(1)}%;`,
    ' background:var(--accent)"></i>',
    ...gate.marks.map((m) =>
      `<b style="left:${(Math.min(1, Math.max(0, m.at)) * 100).toFixed(1)}%"></b>`),
    '</div>',
  ].join('');
  return [
    '<div class="gate">',
    `<div class="lbl">${escapeHtml(gate.label)}</div>`,
    '<div style="display:flex; align-items:baseline; gap:9px; flex-wrap:wrap">',
    `<span class="big">${gateValue(gate.value)}</span>`,
    gate.detail === null
      ? ''
      : `<span class="m" style="font-size:11px; color:var(--dim)">${escapeHtml(gate.detail)}</span>`,
    '</div>',
    bar,
    named,
    '</div>',
  ].join('');
}

/**
 * One gate's value.
 *
 * A gate that was never reached shows an em dash and says so. Zero would
 * claim the samples disagreed completely, which is a measurement rather than
 * its absence.
 */
function gateValue(value: number | null): string {
  // "not read", never "not reached". They are different facts and only one
  // of them is this console's: `reachedAgreementGate` in the policy engine
  // distinguishes a run that never got to the comparison from one that did,
  // and this console reads neither value. Claiming the run did not reach the
  // gate would be an assertion about the ledger that nothing here checked.
  if (value === null) return '<span title="not read by the console">—</span>';
  // Three places, not two. Agreement is a count out of nine, so 1/9 reads
  // 0.111 and two places round two distinct sample counts onto one number.
  return escapeHtml(value.toFixed(3));
}

export interface MetricValue {
  /** Null when the day measured nothing. */
  /**
   * The value as the operator reads it, or null when there is none.
   *
   * A string as well as a number, because `main.ts` formats through the
   * bands job's own `humanValue` before it reaches here. Formatting twice, or
   * differently, is how a rate reads 0.667 in `pnpm run bands` and
   * 0.6666666666666666 on the page.
   */
  readonly value: string | number | null;
  /** The named reason there is no value. Null when there is one. */
  readonly shortfall: string | null;
}

/**
 * A control-band metric, or the named reason it has no value.
 *
 * `bands` distinguishes a measured zero from an unmeasured day, and so does
 * this: the first is a number and the second is a shortfall by name.
 */
export function renderMetricValue(metric: MetricValue): string {
  // Two independent facts, and a first version tied them together: it showed
  // the shortfall only when the value was null. Four of the six codes carry a
  // value — `thin_window`, `provider_change`, `steady`, `moved_from_flat` —
  // so those four rendered as a bare number and collapsed into one another.
  // They send an operator to four different remedies.
  const named = metric.shortfall;
  if (metric.value === null) {
    const shown = named ?? 'unmeasured';
    return `<span class="mut" data-shortfall="${escapeHtml(shown)}">no verdict: ${escapeHtml(shown)}</span>`;
  }
  if (named === null) return `<span class="m">${escapeHtml(String(metric.value))}</span>`;
  return `<span class="m" data-shortfall="${escapeHtml(named)}">`
    + `${escapeHtml(String(metric.value))} <span class="mut">(${escapeHtml(named)})</span></span>`;
}

// `escalationHead` moved to `src/escalations/reason.ts`, so the reader and
// this package apply one implementation. The reader trims before a surface
// sees the value; this package re-exports it because the runs list reads the
// escalations module, which does not.
export { escalationHead } from 'auracle/dist/escalations/reason.js';

