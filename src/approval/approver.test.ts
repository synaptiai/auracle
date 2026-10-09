// What the ledger records as the approver — DEC-42.
//
// The value arrives from a header a trusted proxy set. It is a claim rather
// than an authentication, and the bound and the character check live at the
// approval chokepoint rather than in a caller, so a console that forgets them
// cannot bypass them.
import { describe, expect, it } from 'vitest';

import { approverFrom, sourceOf, UNATTRIBUTED } from './approver.js';

describe('the approver a reply records', () => {
  it('takes the name a trusted proxy supplied', () => {
    expect(approverFrom('ops-oncall')).toBe('ops-oncall');
  });

  it('trims what the header padded', () => {
    expect(approverFrom('  ops-oncall  ')).toBe('ops-oncall');
  });

  it('records that nobody was named when nobody was', () => {
    expect(approverFrom(undefined)).toBe(UNATTRIBUTED);
    expect(approverFrom('')).toBe(UNATTRIBUTED);
    expect(approverFrom('   ')).toBe(UNATTRIBUTED);
  });

  // A control character in an audit value is a log-injection primitive: it
  // lets one recorded approver forge the appearance of another line.
  it('names nobody rather than record a control character', () => {
    for (const code of [0x00, 0x07, 0x0a, 0x0d, 0x09, 0x1b, 0x7f]) {
      const claimed = `ops${String.fromCharCode(code)}admin`;
      expect(approverFrom(claimed), `U+${code.toString(16)}`).toBe(UNATTRIBUTED);
    }
  });

  // The same attack without an ASCII control. A C1 control such as NEL
  // (U+0085), or a Unicode line or paragraph separator, is a line break to
  // some log readers, and `JSON.stringify` escapes none of them. A bidi
  // control reorders what a reader sees, so a recorded name displays as
  // another one.
  it('names nobody rather than record a line break or a bidi control outside ASCII', () => {
    for (const code of [0x80, 0x85, 0x9f, 0x2028, 0x2029, 0x061c, 0x200e, 0x200f, 0x202a, 0x202e, 0x2066, 0x2069]) {
      const claimed = `ops${String.fromCharCode(code)}admin`;
      expect(approverFrom(claimed), `U+${code.toString(16)}`).toBe(UNATTRIBUTED);
    }
  });

  // The rule: a name holds letters, marks, numbers, punctuation, symbols and
  // single spaces, and nothing that draws nothing. A joiner and a variation
  // selector draw nothing in most places, so neither is part of a name.
  it('keeps a name written outside ASCII', () => {
    const names = [
      '\u00c5sa Synth\u00f6tic',
      '\u0141ucja Synth\u00f3tic',
      '\u06a9\u0627\u0631\u0628\u0631 \u0622\u0632\u0645\u0627\u06cc\u0634\u06cc', // Persian, two words: a test user
      '\u0915\u094d\u0937', // Devanagari, a conjunct written with a virama alone
      '\u0418\u0432\u0430\u043d', // Cyrillic
      'ops \u{1F600}', // an emoji that draws as one
      'Jos\u0065\u0301', // a letter with its combining accent
    ];
    for (const name of names) {
      expect(approverFrom(name), JSON.stringify(name)).toBe(name);
    }
  });

  it('names nobody rather than record a character outside the name alphabet', () => {
    const codes = [
      0x00a0, 0x3000, 0x2002, // spaces other than U+0020
      0x00ad, 0x034f, 0x17b4, 0x180b, 0x200b, 0x2060, 0xfe00, 0xfeff, // characters that draw nothing
      0x3164, 0x115f, 0xffa0, 0x2800, 0xfffc, // characters in the alphabet that draw as blank
      0xe000, // a private-use character
    ];
    for (const code of codes) {
      expect(approverFrom(`al${String.fromCharCode(code)}ice`), `U+${code.toString(16)}`).toBe(UNATTRIBUTED);
    }
    for (const code of [0xe0041, 0xe0100]) {
      expect(approverFrom(`al${String.fromCodePoint(code)}ice`), `U+${code.toString(16)}`).toBe(UNATTRIBUTED);
    }
  });

  // A joiner or a selector that draws nothing is indistinguishable from none,
  // and telling the two apart needs per-script shaping rules. So no name holds
  // one, wherever it sits.
  it('names nobody when a name carries a joiner or a variation selector anywhere', () => {
    const claimed = [
      'al\u200dice',
      '\u0418\u0432\u200d\u0430\u043d', // between Cyrillic letters, where it draws nothing
      '\u06a9\u0627\u0631\u0628\u0631\u200c\u0622\u0632\u0645\u0627\u06cc\u0634\u06cc', // Persian, a non-joiner
      '\u0915\u094d\u200d\u0937', // Devanagari, a joiner inside a conjunct
      'ops \u{1F468}\u200d\u{1F4BB}', // an emoji sequence
      'ops \u2764\ufe0f', // an emoji with its presentation selector
      'ops \u{1F600}\ufe0f', // a selector after an emoji that already draws as one
      'ops \u2764\ufe0e',
      '\u200d\u200d',
      '\ufe0f',
    ];
    for (const name of claimed) {
      expect(approverFrom(name), JSON.stringify(name)).toBe(UNATTRIBUTED);
    }
  });

  // A mark draws on the character before it. With no base it draws a stray
  // tick or a dotted circle, and a tall stack draws over the rail around it.
  it('names nobody when a mark has no base or the marks pile up', () => {
    const claimed = [
      '\u0301',
      '\u0301\u0301',
      '\u0e31',
      '\u0301Ada',
      'ops \u0301',
      'Ada' + '\u0301'.repeat(5),
      'A' + '\u20dd'.repeat(5), // enclosing marks stack too
      'A' + '\u0301'.repeat(3) + '\u20dd'.repeat(2), // both kinds add to one count
      '\u093e', // a spacing mark needs a base as well
      'a \u093e',
    ];
    for (const name of claimed) {
      expect(approverFrom(name), JSON.stringify(name)).toBe(UNATTRIBUTED);
    }
  });

  // Real names stack a few marks: Vietnamese and pointed Hebrew among them. A
  // spacing mark sits beside its letter and never stacks, so a Burmese syllable
  // with five marks, three of them spacing, is still a name.
  it('keeps a letter with up to four stacking marks on it', () => {
    const names = [
      'Nguy\u1ec5n',
      'Ngu\u0079\u0302\u0303n',
      '\u05e9\u05c1\u05b8\u05dc\u05d5\u05b9\u05dd',
      '\u1019\u103b\u103e\u1031\u102c\u103a', // Burmese: letter, Mc, Mn, Mc, Mc, Mn
      'Ada' + '\u0301'.repeat(4),
      'A' + '\u20dd'.repeat(4),
    ];
    for (const name of names) {
      expect(approverFrom(name), JSON.stringify(name)).toBe(name);
    }
  });

  // The rail draws two spaces as one, so `ops  oncall` would read as `ops oncall`.
  it('names nobody when two spaces sit together', () => {
    expect(approverFrom('ops  oncall')).toBe(UNATTRIBUTED);
  });

  // Deliberate: a subdivision flag carries tag characters, a keycap and many
  // emoji carry a selector, and a Mongolian vowel separator is a format
  // character. A name carrying one records `unattributed`. The approval itself
  // is never refused over it.
  it('names nobody for a subdivision flag, a keycap or a Mongolian vowel separator, by choice', () => {
    const scotland = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}';
    expect(approverFrom(`ops ${scotland}`)).toBe(UNATTRIBUTED);
    expect(approverFrom('ops #\ufe0f\u20e3')).toBe(UNATTRIBUTED);
    expect(approverFrom('\u1828\u180e\u1820')).toBe(UNATTRIBUTED);
  });

  it('keeps an ordinary name that merely contains a space', () => {
    expect(approverFrom('ops oncall')).toBe('ops oncall');
  });

  // `text` is unbounded in Postgres, so the bound is this function's own.
  it('names nobody rather than record an unbounded value', () => {
    expect(approverFrom('a'.repeat(256))).toBe('a'.repeat(256));
    expect(approverFrom('a'.repeat(257))).toBe(UNATTRIBUTED);
  });

  // It never throws. DEC-42 says an unnamed approver is a recorded fact, and
  // refusing the approval over the audit field would put a customer reply
  // behind a header's formatting.
  it('never refuses the approval over the shape of this value', () => {
    for (const claimed of ['', '   ', 'a'.repeat(10_000), 'ok']) {
      expect(() => approverFrom(claimed)).not.toThrow();
    }
  });
});

// The source a name records beside it (DEC-45). The ledger's CHECKs hold a
// name and its source to one rule: `none` exactly when nobody was named. A
// caller can pass any pair, so the pair is derived here, once, for every
// writer, rather than refused as a database error after the write began.
describe('the source a recorded name carries', () => {
  it('says none for a name nobody gave, whatever the caller claimed', () => {
    expect(sourceOf(UNATTRIBUTED, 'roster')).toBe('none');
    expect(sourceOf(UNATTRIBUTED, undefined)).toBe('none');
  });

  it('keeps the source the caller gave a real name', () => {
    expect(sourceOf('ops-oncall', 'roster')).toBe('roster');
    expect(sourceOf('ops-oncall', 'header')).toBe('header');
  });

  it("reads a real name with no source as a caller's claim", () => {
    expect(sourceOf('ops-oncall', undefined)).toBe('header');
  });

  it('never pairs a real name with none, which no record may hold', () => {
    expect(sourceOf('ops-oncall', 'none')).toBe('header');
  });

  it("reads a source outside the vocabulary as a caller's claim", () => {
    // The writers are public through the ledger-read barrel, so an untyped
    // caller can pass anything. A journal row has no CHECK to refuse it.
    expect(sourceOf('ops-oncall', 'guess' as never)).toBe('header');
  });
});
