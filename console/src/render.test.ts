// The two rules the console must never break, and the one number it must
// never invent (issue #27).
//
// The design's own brief states the first: "No screen anywhere combines
// agreement and coverage into one confidence score." That is DEC-05 as a
// display rule — the gates are independent, and a console that averaged them
// would put a number on screen that the system never computes.
//
// The second is the bands rule. `bands` reports a shortfall when a day
// measured nothing, and rendering that as 0 would read as a measurement of
// zero rather than an absence of one.
import { describe, expect, it } from 'vitest';

import { escapeHtml, renderGates, renderMetricValue } from './render.js';

describe('the gate display', () => {
  it('shows agreement and coverage as two values, never one', () => {
    const html = renderGates({ agreement: 0.89, coverage: 0.94 });
    expect(html).toContain('0.89');
    expect(html).toContain('0.94');
    // Neither mean, nor product, nor min: no combined score exists.
    for (const combined of ['0.915', '0.92', '0.8366', '0.89 / 0.94']) {
      expect(html).not.toContain(combined);
    }
    // Each is labelled, so a reader cannot mistake one for the other.
    expect(html).toMatch(/agreement/i);
    expect(html).toMatch(/coverage/i);
  });

  it('renders one gate when the other has no value', () => {
    // A gate with no value shows a dash. Showing 0 would say the samples
    // disagreed completely, which is a measurement rather than its absence.
    const html = renderGates({ agreement: null, coverage: 0.94 });
    expect(html).toContain('0.94');
    expect(html).not.toContain('0.00');
    expect(html).toContain('—');
  });

  // What the console actually shows today, pinned so the surfaces and the
  // runbook cannot drift from it.
  //
  // The escalation module reports what a person needs to work the queue and
  // carries neither gate value, so both render as a dash. The cases above
  // pass values by hand and would keep passing if production never produced
  // one — which it does not. This is the case that says so.
  it('says the values are not read, rather than not reached', () => {
    const html = renderGates({ agreement: null, coverage: null });
    expect(html).toContain('not read by the console');
    // Never the other claim: that is a fact about the run, not about us.
    expect(html).not.toContain('not reached');
  });
});

describe('an unmeasured metric', () => {
  it('never renders as zero', () => {
    const html = renderMetricValue({ value: null, shortfall: 'no_runs' });
    expect(html).not.toContain('0');
    expect(html).toContain('no_runs');
  });

  it('renders a measured zero as zero, which is a different thing', () => {
    const html = renderMetricValue({ value: 0, shortfall: null });
    expect(html).toContain('0');
    expect(html).not.toContain('no_runs');
  });

  // The finding was four codes, not one. `thin_window`, `provider_change`,
  // `steady` and `moved_from_flat` all carry a value, and a first version
  // showed the shortfall only when the value was null — so all four rendered
  // as a bare number and became indistinguishable. Each sends an operator to
  // a different remedy, so the table covers the whole union.
  const CODES = [
    'day_unmeasured',
    'day_not_a_number',
    'thin_window',
    'steady',
    'moved_from_flat',
    'provider_change',
  ] as const;

  it('names every shortfall code beside the value it carries', () => {
    const rendered = CODES.map((code) => renderMetricValue({ value: 0.5, shortfall: code }));
    for (const [i, html] of rendered.entries()) {
      expect(html).toContain(CODES[i]!);
      // The value survives, so a reader sees both facts rather than one.
      expect(html).toContain('0.5');
    }
    // And no two codes render alike, which is the collapse the finding named.
    expect(new Set(rendered).size).toBe(CODES.length);
  });

  it('names every shortfall code when there is no value either', () => {
    for (const code of CODES) {
      expect(renderMetricValue({ value: null, shortfall: code })).toContain(code);
    }
  });

  // The shape production actually emits. `main.ts` formats through the bands
  // job's own `humanValue`, so every value arriving here is a string or null
  // — and every case above passes a number, so the widened branch was
  // exercised by nothing.
  it('renders a formatted value without reformatting it', () => {
    const html = renderMetricValue({ value: '0.667', shortfall: null });
    expect(html).toContain('0.667');
    // Not re-rounded, not re-parsed, not padded.
    expect(html).not.toContain('0.66700');
  });

  it('renders a measured zero that arrives as a string', () => {
    const html = renderMetricValue({ value: '0', shortfall: null });
    expect(html).toContain('>0<');
    expect(html).not.toContain('no verdict');
  });

  it('names the shortfall rather than saying only that a verdict is missing', () => {
    const html = renderMetricValue({ value: null, shortfall: 'provider_change' });
    expect(html).toContain('provider_change');
  });
});

describe('escaping', () => {
  // Ledger text reaches the page: a ticket subject, an escalation reason.
  // None of it is trusted markup.
  it('escapes the characters that would end an attribute or a tag', () => {
    expect(escapeHtml(`<script>alert("x")</script>`)).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
    );
    expect(escapeHtml("it's & more")).toBe('it&#39;s &amp; more');
  });
});
