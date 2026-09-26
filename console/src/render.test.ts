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

import {
  escalationHead, escapeHtml, initialsOf, renderGates, renderMetricValue,
} from './render.js';

describe('the gate display', () => {
  it('shows agreement and coverage as two values, never one', () => {
    const html = renderGates({ agreement: 0.89, coverage: 0.94 });
    expect(html).toContain('0.890');
    expect(html).toContain('0.940');
    // Each is labelled, so a reader cannot mistake one for the other.
    expect(html).toMatch(/agreement/i);
    expect(html).toMatch(/coverage/i);
  });

  /**
   * Every number the gate display may show, and nothing else.
   *
   * A list of forbidden blends cannot state this rule. Two of the four blends
   * the old list named are not catchable that way: the minimum of 0.89 and
   * 0.94 is 0.89, which the case above requires to be present, and the
   * product renders 0.837 at the three places `gateValue` uses rather than
   * the 0.8366 the list looked for. A blended score shipped past both.
   *
   * So the rule is written as an allowlist over what reaches the page: the
   * two gate values and the lines they were judged against, and no third
   * number. Any mean, product, minimum, maximum or ratio is a number that is
   * not in the set, whatever it happens to equal.
   */
  function numbersOn(html: string): string[] {
    // Attributes first. A bar width is `${value * 100}` and a font size is a
    // number too; neither is a value the operator reads, and leaving them in
    // would make the allowlist a list of coincidences.
    const text = html.replace(/\s\w[\w-]*="[^"]*"/g, ' ');
    return [...text.matchAll(/\d+(?:\.\d+)?/g)].map((m) => m[0]);
  }

  it('puts no number on the page but the two gates and their thresholds', () => {
    const html = renderGates({
      agreement: 0.89,
      coverage: 0.94,
      agreementThreshold: 0.6,
      coverageBlock: 0.7,
      coverageReview: 0.8,
      agreementDetail: '8 of 9 samples',
    });
    // How many times each may appear, not merely whether it may. A minimum
    // blend renders 0.890 and a maximum renders 0.940 — both are already on
    // the page, so a set of allowed values cannot see either one. A second
    // 0.890 is what gives the minimum away.
    const allowed = new Map([
      ['0.890', 1], ['0.940', 1], ['0.600', 1], ['0.700', 1], ['0.800', 1],
      ['8', 1], ['9', 1],
    ]);
    const seen = new Map<string, number>();
    for (const number of numbersOn(html)) {
      seen.set(number, (seen.get(number) ?? 0) + 1);
    }
    for (const [number, count] of seen) {
      const permitted = allowed.get(number);
      expect(permitted, `${number} is on the page and is not a gate value`).toBeDefined();
      expect(count, `${number} appears ${count} times, not ${permitted}`).toBe(permitted);
    }
    // And the rule is not vacuous: the values it permits are actually there.
    expect(seen.get('0.890')).toBe(1);
    expect(seen.get('0.940')).toBe(1);
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
  it('says the values were not recorded, rather than not reached', () => {
    const html = renderGates({ agreement: null, coverage: null });
    expect(html.match(/<span class="m gateabsent">not recorded<\/span>/g) ?? []).toHaveLength(2);
    // Never the other claim: that is a fact about the run, not about us.
    expect(html).not.toContain('not reached');
  });

  // The reason is text beside the dash, never a tooltip a keyboard or touch
  // reader cannot open (issue #102).
  it('draws each absent value with the reason its caller gave', () => {
    const html = renderGates({
      agreement: null, coverage: 0.94,
      agreementAbsent: 'the journal holds no agreement for this run',
      coverageAbsent: 'never drawn, because the value is here',
    });
    expect(html).toContain('<span class="m gateabsent">the journal holds no agreement for this run</span>');
    expect(html).not.toContain('never drawn, because the value is here');
    expect(html).not.toContain('title=');
  });

  it('stacks the two gates when asked, and keeps them two cards', () => {
    const html = renderGates({ agreement: 0.89, coverage: 0.94, stacked: true });
    expect(html).toContain('<div class="gates rows">');
    expect(html.match(/class="gate"/g) ?? []).toHaveLength(2);
    expect(renderGates({ agreement: 0.89, coverage: 0.94 })).toContain('<div class="gates">');
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

describe('what reaches the page from a query string', () => {
  // The route refuses a state outside the ledger's vocabulary, so this is not
  // reachable today. The surfaces are pure functions that take what a caller
  // hands them, and the guard lives in another file: this case is what stops
  // the next caller from being the one that forgets.
  it('escapes a filter state before it reaches the empty-list sentence', async () => {
    const { renderRuns } = await import('./surfaces.js');
    const html = renderRuns({
      runs: [],
      filter: { states: ['gated'], active: '<img src=x onerror=alert(1)>' },
      limit: 200,
    });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

describe('an escalation reason on an operator surface', () => {
  // The `escalate` row's reason key is not a closed vocabulary. The relay
  // interpolates whatever the adapter threw, and an SMTP rejection quotes the
  // recipient. This console serves such a reason to a reviewer only
  // (DEC-18, DEC-45).
  it('keeps a reason the coordinator chose, whole', () => {
    for (const reason of [
      'policy_escalated', 'egress_refused', 'composer_abstained', 'limit_cost',
    ]) {
      expect(escalationHead(reason)).toBe(reason);
    }
  });

  it('drops what the relay interpolated, and says it did', () => {
    const leaked = 'delivery_unknown: 550 5.1.1 <alice@example.com>: user unknown';
    const head = escalationHead(leaked);
    expect(head).toBe('delivery_unknown (detail withheld)');
    expect(head).not.toContain('alice@example.com');
    expect(head).not.toContain('550');
  });

  it('drops the payload error the relay writes on a malformed row', () => {
    const head = escalationHead('malformed_payload: to=bob@example.com is not a field');
    expect(head).toBe('malformed_payload (detail withheld)');
    expect(head).not.toContain('bob@example.com');
  });

  it('drops the tail the consumer writes when intake gives up', () => {
    const head = escalationHead('intake_abandoned after 3 attempts: smtp said carol@example.com');
    expect(head).toBe('intake_abandoned after 3 attempts (detail withheld)');
    expect(head).not.toContain('carol@example.com');
  });

  it('passes a null through as a null', () => {
    expect(escalationHead(null)).toBeNull();
  });
});

// The rail's avatar (issue #100). Characters, not UTF-16 units: a name that
// opens with a letter outside the basic plane must not render half of a
// surrogate pair.
describe('initialsOf', () => {
  it('takes the first character of each of the first two words, upper-cased', () => {
    expect(initialsOf('Ida Lindqvist')).toBe('IL');
    expect(initialsOf('ida lindqvist')).toBe('IL');
    expect(initialsOf('Åsa Berg Nyström')).toBe('ÅB');
  });

  // Some letters upper-case to two. The avatar holds one per word.
  it('keeps one character per word when upper-casing yields two', () => {
    expect(initialsOf('ßa Berg')).toBe('SB');
  });

  // A header may carry a name in decomposed form, a letter then its mark. The
  // avatar shows the letter a reader sees, and a word that opens with a mark
  // alone gives no initial.
  it('takes the first visible character of each word', () => {
    const decomposed = 'A\u030asa Nystro\u0308m';
    expect(initialsOf(decomposed)).toBe('\u00c5N');
    expect(initialsOf('ops \u0301')).toBe('O');
    expect(initialsOf('\u0301')).toBe('');
  });

  it('takes one initial from a one-word name', () => {
    expect(initialsOf('ops-oncall')).toBe('O');
  });

  it('counts a character outside the basic plane as one', () => {
    const name = '\u{1D4D0}da Lind';
    const initials = initialsOf(name);
    expect(Array.from(initials)).toEqual(['\u{1D4D0}', 'L']);
  });

  it('ignores the whitespace around and between words', () => {
    expect(initialsOf('  Ida   Lindqvist  ')).toBe('IL');
  });
});
