// The stylesheet against the reviewer design's tokens (issue #100).
//
// The handoff fixes these values as final. A pure read of the stylesheet
// string, so a drift in a token or a lost accessibility rule fails here
// rather than in a screenshot nobody compares.
import { describe, expect, it } from 'vitest';

import { CONSOLE_CSS } from './css.js';

interface Rule {
  /** The enclosing at-rule prelude, or null at the top level. */
  readonly at: string | null;
  readonly selector: string;
  readonly declarations: ReadonlyMap<string, string>;
}

/**
 * The stylesheet with every comment removed, and nothing else.
 *
 * A scanner rather than a regular expression. A comment opener inside a
 * string is text, and a regular expression removed everything up to the next
 * closer, rules included.
 */
function withoutComments(css: string): string {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const ch = css[i]!;
    if (ch === '"' || ch === "'") {
      const end = stringEnd(css, i);
      out += css.slice(i, end);
      i = end;
    } else if (ch === '/' && css[i + 1] === '*') {
      const close = css.indexOf('*/', i + 2);
      if (close === -1) throw new Error(`unclosed comment at ${i}`);
      out += ' ';
      i = close + 2;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/** The index just past the string that opens at `start`. */
function stringEnd(css: string, start: number): number {
  const quote = css[start]!;
  let i = start + 1;
  while (i < css.length && css[i] !== quote) {
    i += css[i] === '\\' ? 2 : 1;
  }
  if (i >= css.length) throw new Error(`unclosed string at ${start}`);
  return i + 1;
}

/**
 * The index of the next character from `chars` at or after `from`, outside
 * any string and any parentheses, or -1.
 */
function nextOutside(css: string, from: number, chars: string): number {
  let depth = 0;
  let i = from;
  while (i < css.length) {
    const ch = css[i]!;
    if (ch === '"' || ch === "'") {
      i = stringEnd(css, i);
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth < 0) throw new Error(`unbalanced ) at ${i}`);
    }
    else if (depth === 0 && chars.includes(ch)) return i;
    i += 1;
  }
  return -1;
}

/** One block's declarations, split on semicolons outside strings. */
function declarationsOf(body: string): Map<string, string> {
  const declarations = new Map<string, string>();
  let i = 0;
  while (i <= body.length) {
    const semi = nextOutside(body, i, ';');
    const part = body.slice(i, semi === -1 ? body.length : semi);
    const colon = part.indexOf(':');
    if (colon !== -1) {
      declarations.set(
        part.slice(0, colon).trim(),
        part.slice(colon + 1).trim().replace(/\s+/g, ' '),
      );
    }
    if (semi === -1) break;
    i = semi + 1;
  }
  return declarations;
}

/**
 * Every style rule in a block list, with its declarations.
 *
 * A statement at-rule such as `@layer base;` has no block, and it is skipped
 * whole. A block at-rule holds rules, and each of them records it. A keyframe
 * step is recorded as a rule whose selector is the step. One level of at-rule
 * nesting is enough for this stylesheet. A deeper one, or a style rule nested
 * inside another, is reported rather than misread.
 */
function rulesIn(css: string, at: string | null): Rule[] {
  const rules: Rule[] = [];
  let i = 0;
  for (;;) {
    const stop = nextOutside(css, i, '{;}');
    if (stop === -1) {
      if (css.slice(i).trim() !== '') throw new Error(`text after the last rule: ${css.slice(i).trim()}`);
      return rules;
    }
    const prelude = css.slice(i, stop).trim().replace(/\s+/g, ' ');
    if (css[stop] === '}') throw new Error(`unbalanced close brace at ${stop}`);
    if (css[stop] === ';') {
      if (!prelude.startsWith('@')) throw new Error(`a declaration outside a rule: ${prelude}`);
      i = stop + 1;
      continue;
    }
    const close = blockEnd(css, stop);
    const body = css.slice(stop + 1, close);
    if (prelude.startsWith('@')) {
      if (at !== null) throw new Error(`nested at-rule ${prelude} inside ${at}`);
      rules.push(...rulesIn(body, prelude));
    } else {
      if (nextOutside(body, 0, '{}') !== -1) throw new Error(`a rule nested inside ${prelude}`);
      rules.push({ at, selector: prelude, declarations: declarationsOf(body) });
    }
    i = close + 1;
  }
}

/** The index of the brace that closes the block opening at `open`. */
function blockEnd(css: string, open: number): number {
  let depth = 0;
  let i = open;
  for (;;) {
    const next = nextOutside(css, i, '{}');
    if (next === -1) throw new Error(`unclosed block at ${open}`);
    depth += css[next] === '{' ? 1 : -1;
    if (depth === 0) return next;
    i = next + 1;
  }
}

function rulesOf(css: string): Rule[] {
  return rulesIn(withoutComments(css), null);
}

const RULES = rulesOf(CONSOLE_CSS);

function rule(selector: string, at: string | null = null): ReadonlyMap<string, string> {
  const found = RULES.filter((r) => r.selector === selector && r.at === at);
  expect(found.length, `exactly one rule for ${selector}`).toBe(1);
  return found[0]!.declarations;
}

/** The handoff's token table, verbatim. */
const THEME_FREE = {
  '--s1': '4px', '--s2': '8px', '--s3': '12px', '--s4': '16px',
  '--s5': '24px', '--s6': '32px', '--s7': '48px',
  '--r-sm': '4px', '--r-md': '8px', '--r-lg': '12px',
  '--dur-fast': '150ms', '--dur-normal': '200ms', '--dur-slow': '300ms',
  '--ease-smooth': 'cubic-bezier(0.22, 1, 0.36, 1)',
  '--ease-spring': 'cubic-bezier(0.35, 1.55, 0.65, 1)',
};
const DARK = {
  '--bg': '#0d0e10', '--panel': '#141619', '--panel2': '#1a1d21',
  '--ink': '#e6e7e8', '--mut': '#878d95', '--dim': '#5b626a',
  '--rule': '#25292e', '--rule2': '#31363c',
  '--accent': 'oklch(0.66 0.11 255)', '--warn': 'oklch(0.72 0.11 78)',
  '--hot': 'oklch(0.66 0.13 42)', '--crit': 'oklch(0.62 0.15 22)',
  '--ok': 'oklch(0.68 0.09 155)',
  '--ring': 'inset 0 0 0 1px rgba(255,255,255,.055)',
  '--ring-strong': 'inset 0 0 0 1px rgba(255,255,255,.10)',
  '--shadow-1': '0 1px 1px rgba(0,0,0,.30), 0 2px 6px rgba(0,0,0,.22)',
  '--shadow-2': '0 1px 1px rgba(0,0,0,.34), 0 4px 12px rgba(0,0,0,.28), 0 12px 32px rgba(0,0,0,.22)',
  '--surface': 'linear-gradient(180deg, #16181c 0%, #131518 100%)',
};
const LIGHT = {
  '--bg': '#f7f7f5', '--panel': '#ffffff', '--panel2': '#f1f1ee',
  '--ink': '#17181a', '--mut': '#5f656c', '--dim': '#9198a0',
  '--rule': '#e4e4e0', '--rule2': '#d3d3ce',
  '--accent': 'oklch(0.52 0.12 255)', '--warn': 'oklch(0.58 0.11 78)',
  '--hot': 'oklch(0.55 0.14 42)', '--crit': 'oklch(0.52 0.16 22)',
  '--ok': 'oklch(0.52 0.10 155)',
};

describe('the design tokens', () => {
  it('defines every theme-free token on the root', () => {
    const root = rule('.root');
    for (const [name, value] of Object.entries(THEME_FREE)) {
      expect(root.get(name), name).toBe(value);
    }
  });

  it('defines the dark palette and depth on the root', () => {
    const root = rule('.root');
    for (const [name, value] of Object.entries(DARK)) {
      expect(root.get(name), name).toBe(value);
    }
  });

  // The handoff keeps the light palette as it stands. Its depth tokens are
  // white hairlines, which vanish on a white panel, so the light theme
  // redefines every depth token rather than inheriting an invisible one.
  it('overrides the palette and every depth token in the light theme', () => {
    const light = rule('.root[data-theme="light"]');
    for (const [name, value] of Object.entries(LIGHT)) {
      expect(light.get(name), name).toBe(value);
    }
    for (const name of ['--ring', '--ring-strong', '--shadow-1', '--shadow-2', '--surface']) {
      expect(light.get(name), name).toBeDefined();
      expect(light.get(name), name).not.toBe(DARK[name as keyof typeof DARK]);
    }
  });
});

describe('the shell', () => {
  it('puts a 194px rail beside a column that may shrink', () => {
    expect(rule('.shell').get('grid-template-columns')).toBe('194px minmax(0,1fr)');
  });

  // Without both, "Knowledge base" wraps to two lines inside 194px.
  it('lets a rail label shrink and keeps its badge whole', () => {
    const label = rule('.navlabel');
    expect(label.get('flex')).toBe('1 1 auto');
    expect(label.get('min-width')).toBe('0');
    expect(label.get('overflow')).toBe('hidden');
    expect(label.get('text-overflow')).toBe('ellipsis');
    expect(label.get('white-space')).toBe('nowrap');
    const badge = rule('.nav .badge');
    expect(badge.get('flex')).toBe('none');
    expect(badge.get('white-space')).toBe('nowrap');
  });
});

describe('reading the stylesheet', () => {
  // The reader decides what every other case here sees. A rule it drops
  // silently is a rule no case can check.
  it('keeps a rule after a comment opener inside a string', () => {
    const rules = rulesOf('.a { content:"/*"; } .b { color:red; } .c { content:"*/"; }');
    expect(rules.map((r) => r.selector)).toEqual(['.a', '.b', '.c']);
    expect(rules[1]!.declarations.get('color')).toBe('red');
  });

  it('skips a statement at-rule whole', () => {
    const rules = rulesOf('@layer base; .a { color:red; }');
    expect(rules).toEqual([{ at: null, selector: '.a', declarations: new Map([['color', 'red']]) }]);
  });

  it('reads a brace inside an attribute selector as text', () => {
    const rules = rulesOf('[title="{"] { color:red; } .b { color:blue; }');
    expect(rules.map((r) => r.selector)).toEqual(['[title="{"]', '.b']);
  });

  // This stylesheet nests nothing. A nested rule read as a declaration would
  // pass every case silently, so the reader refuses it.
  it('refuses a style rule nested inside another', () => {
    expect(() => rulesOf('.a { .b { color:red; } }')).toThrow(/nested/);
  });

  // An unmatched parenthesis would hide every brace after it, and the rest
  // of the stylesheet would read as one declaration.
  it('refuses an unmatched close parenthesis', () => {
    expect(() => rulesOf('.a { width:calc(1px)); } .b { color:red; }')).toThrow(/unbalanced \)/);
  });

  it('reads each keyframe step as a rule of its own', () => {
    const rules = rulesOf('@keyframes k { from { opacity:0; } to { opacity:1; } }');
    expect(rules.map((r) => [r.at, r.selector])).toEqual([['@keyframes k', 'from'], ['@keyframes k', 'to']]);
  });
});

describe('motion and focus', () => {
  it('animates the content region in once, from a lowered, blurred, clear frame', () => {
    const from = rule('from', '@keyframes riseIn');
    expect(from.get('opacity')).toBe('0');
    expect(from.get('transform')).toBe('translateY(8px)');
    expect(from.get('filter')).toBe('blur(3px)');
    const to = rule('to', '@keyframes riseIn');
    expect(to.get('opacity')).toBe('1');
    const main = rule('.main > *');
    expect(main.get('animation')).toContain('riseIn');
    expect(main.get('animation')).toContain('var(--dur-slow)');
    expect(main.get('animation')).toContain('var(--ease-smooth)');
  });

  // A kept end frame computes as an identity matrix and a zero blur. Either
  // one makes every child a containing block for fixed descendants for the
  // life of the page, so the entrance may fill backwards and never forwards.
  it('leaves no animated value in effect once the entrance ends', () => {
    const fill = rule('.main > *').get('animation')!.split(' ');
    expect(fill).toContain('backwards');
    expect(fill).not.toContain('both');
    expect(fill).not.toContain('forwards');
  });

  it('presses a button or a boxed link on the spring curve', () => {
    const active = rule('.root a:active, .root button:active');
    expect(active.get('transform')).toBe('scale(.97)');
    const transition = rule('.root a, .root button').get('transition');
    expect(transition).toContain('transform var(--dur-fast) var(--ease-spring)');
  });

  // A transform does not act on an inline box. The citation marker is the
  // one link a reader presses that sits in a line of text.
  it('makes the citation marker a box, so it presses', () => {
    expect(rule('.cite').get('display')).toBe('inline-block');
  });

  // A link alone in a table cell or a definition is the action of its row,
  // not a word in a sentence, so it is a box and it presses.
  it('makes a link in a table cell or a definition a box, so it presses', () => {
    expect(rule('td a, dd a').get('display')).toBe('inline-block');
  });

  // A name may carry marks that draw above or below its line. The reviewer
  // block clips its own ink, so nothing it holds draws over the rail.
  it('clips the reviewer block to its own box', () => {
    expect(rule('.reviewer').get('overflow')).toBe('clip');
  });

  it('draws a visible focus ring', () => {
    const focus = rule('.root :focus-visible');
    expect(focus.get('outline')).toBe('2px solid var(--accent)');
    expect(focus.get('outline-offset')).toBe('2px');
    expect(focus.get('border-radius')).toBe('var(--r-md)');
  });

  // The segmented control clips to its rounded border, so a ring drawn
  // outside a button is cut on three sides.
  it('draws the focus ring inside a segmented control', () => {
    expect(rule('.seg').get('overflow')).toBe('hidden');
    expect(rule('.seg a:focus-visible').get('outline-offset')).toBe('-2px');
    expect(rule('.seg a:focus-visible').get('border-radius')).toBe('0');
  });

  // The chosen segment is filled with the accent the ring is drawn in.
  it('draws the ring of the chosen segment in a colour its fill does not share', () => {
    expect(rule('.seg a.on').get('background')).toBe('var(--accent)');
    expect(rule('.seg a.on:focus-visible').get('outline-color')).toBe('currentColor');
  });

  it('stops every animation and transition for a reader who asked', () => {
    const reduced = RULES.filter((r) => r.at === '@media (prefers-reduced-motion: reduce)');
    expect(reduced.length).toBe(1);
    expect(reduced[0]!.selector).toBe('.root *, .root *::before, .root *::after');
    expect(reduced[0]!.declarations.get('animation')).toBe('none !important');
    expect(reduced[0]!.declarations.get('transition')).toBe('none !important');
  });
});

describe('what reads at every width', () => {
  // Twelve run states do not fit beside the rail at 907px. A control that
  // clips its children hid four of them, and a mouse could reach none of the
  // last three. The segments wrap, and each one grows to fill its row.
  it('wraps a segmented control rather than clipping its options', () => {
    const seg = rule('.seg');
    expect(seg.get('flex-wrap')).toBe('wrap');
    expect(seg.get('overflow')).toBe('hidden');
    expect(rule('.seg a').get('flex')).toBe('1 0 auto');
  });

  // A chip is one token, such as a date, and breaking it inside reads as two.
  // The ledger chip in the rail foot may break, because a long ledger name
  // must not widen the rail.
  it('keeps a chip on one line, except the ledger chip in the rail foot', () => {
    expect(rule('.chip').get('white-space')).toBe('nowrap');
    expect(rule('.railfoot .chip').get('white-space')).toBe('normal');
  });

  // Issue #101. A queue row's ticket keeps room of its own, and the age
  // beside it drops to the next line rather than squeezing it.
  it('wraps a queue row without starving its subject', () => {
    const top = rule('.itop');
    expect(top.get('display')).toBe('flex');
    expect(top.get('flex-wrap')).toBe('wrap');
    const subject = rule('.isubj');
    expect(subject.get('flex')).toBe('1 1 160px');
    expect(subject.get('min-width')).toBe('0');
    expect(subject.get('overflow-wrap')).toBe('anywhere');
    expect(rule('.age').get('flex')).toBe('none');
    expect(rule('.imeta').get('overflow-wrap')).toBe('anywhere');
  });

  // Issue #102. The case's two columns are flex bases that wrap, never fixed
  // tracks. Side by side they need 460px, 300px and the 24px gap between.
  it('wraps the case columns below about 800px of case width', () => {
    const body = rule('.case');
    expect(body.get('display')).toBe('flex');
    expect(body.get('flex-wrap')).toBe('wrap');
    expect(body.get('gap')).toBe('24px');
    expect(body.has('grid-template-columns')).toBe(false);
    expect(rule('.casemain').get('flex')).toBe('1 1 460px');
    expect(rule('.casemain').get('min-width')).toBe('0');
    const side = rule('.caseside');
    expect(side.get('flex')).toBe('1 1 300px');
    expect(side.get('max-width')).toBe('360px');
    // 460 + 300 + 24. Below that the side column wraps, and takes the width.
    expect(body.get('container-type')).toBe('inline-size');
    // A range, so no fractional width below 784px keeps the side column narrow.
    expect(rule('.caseside', '@container (width < 784px)').get('max-width')).toBe('none');
  });

  it('keeps the approval in reach at the foot of the case', () => {
    const bar = rule('.actionbar');
    expect(bar.get('position')).toBe('sticky');
    expect(bar.get('bottom')).toBe('0');
    expect(bar.get('background')).toBe('var(--panel)');
    // The warning beside the button, wrapping below it when the bar is narrow.
    expect(bar.get('flex-wrap')).toBe('wrap');
    expect(rule('.actionbar .warnbar').get('flex')).toBe('1 1 420px');
    expect(rule('.actionbar form').get('flex')).toBe('none');
  });

  // Issue #103. A turn's time and chip sit beside what was said while there
  // is room, and above it when there is not. Flex bases, because a fixed
  // column track beside the rail leaves the prose too little at a narrow page.
  it('wraps a conversation turn rather than fixing a column track', () => {
    const turn = rule('.turn');
    expect(turn.get('display')).toBe('flex');
    expect(turn.get('flex-wrap')).toBe('wrap');
    expect(turn.has('grid-template-columns')).toBe(false);
    expect(rule('.turnmeta').get('flex')).toBe('0 0 150px');
    const body = rule('.turnbody');
    expect(body.get('flex')).toBe('1 1 320px');
    expect(body.get('min-width')).toBe('0');
    // 150 + 22 + 320. Below that the time and chip take a line of their own.
    expect(rule('.turns').get('container-type')).toBe('inline-size');
    expect(rule('.turns').get('max-width')).toBe('1100px');
    const narrow = rule('.turnmeta', '@container (width < 492px)');
    expect(narrow.get('flex-basis')).toBe('100%');
    expect(narrow.get('flex-direction')).toBe('row');
    // The count of attempts is marked by a class, not an inline style.
    expect(rule('.turnfact.warn').get('color')).toBe('var(--warn)');
    // No rule still places a half of the turn on a grid column.
    expect(RULES.filter((r) => r.declarations.has('grid-column') && r.selector.includes('said'))).toHaveLength(0);
  });

  it('draws a refusal in another colour from an approval', () => {
    expect(rule('.outcome.ok').get('border-left-color')).toBe('var(--ok)');
    expect(rule('.outcome.refused').get('border-left-color')).toBe('var(--hot)');
  });

  // 11px text needs 4.5:1. Near-black on the light accent reads 3.5:1.
  it('draws the chosen segment in light text on the light theme', () => {
    expect(rule('.root[data-theme="light"] .seg a.on').get('color')).toBe('#ffffff');
  });
});

describe('the type', () => {
  // The console fetches no font, so the stack is what renders. Chromium
  // ignores `ui-monospace`, and the generic `monospace` then drew Courier.
  it('names an installed monospace face before the generic one', () => {
    const mono = rule('.root').get('--mono')!;
    const faces = mono.split(',').map((face) => face.trim());
    expect(faces.at(-1)).toBe('monospace');
    for (const face of ["'SF Mono'", 'Menlo', 'Consolas', "'Liberation Mono'"]) {
      expect(faces, face).toContain(face);
    }
  });

  it('names each family once, through its token', () => {
    const named = RULES.flatMap((r) => [...r.declarations.entries()])
      .filter(([name, value]) => name === 'font-family' && /Plex/.test(value));
    expect(named).toEqual([]);
  });
});

describe('what the stylesheet may reach', () => {
  // The content-security policy grants no font-src and no style source but
  // this origin. An import or a remote url would be requested and blocked.
  it('imports nothing and names no remote resource', () => {
    expect(CONSOLE_CSS).not.toMatch(/@import/);
    expect(CONSOLE_CSS).not.toMatch(/url\(/);
    expect(CONSOLE_CSS).not.toMatch(/https?:/);
  });
});
