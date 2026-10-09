// One structured log line, safe to read line by line.
import { describe, expect, it } from 'vitest';

import { logLine, reportJson } from './line.js';

const char = (code: number): string => String.fromCharCode(code);

describe('a structured log line', () => {
  it('is the JSON of the entry when every string is plain', () => {
    const entry = { event: 'console_approved', runId: 'r-1', approvedBy: 'Åsa Synthetic', n: 3 };
    expect(logLine(entry)).toBe(JSON.stringify(entry));
  });

  // JSON escapes ASCII controls and nothing else. NEL (U+0085) and the
  // Unicode line and paragraph separators break a line in some log readers,
  // so one entry could forge the appearance of a second.
  it('escapes every line break JSON leaves raw', () => {
    for (const code of [0x85, 0x2028, 0x2029]) {
      const line = logLine({ approvedBy: `ops${char(code)}{"event":"forged"}` });
      expect(line, `U+${code.toString(16)}`).not.toContain(char(code));
      expect(line).toContain(`\\u${code.toString(16).padStart(4, '0')}`);
    }
  });

  // DEL and the C1 controls are controls too. A bidi control reorders what a
  // reader of the log sees.
  it('escapes DEL, every C1 control and every bidi control', () => {
    const codes = [0x7f, 0x80, 0x9f, 0x061c, 0x200e, 0x200f, 0x202a, 0x202e, 0x2066, 0x2069];
    const line = logLine({ value: codes.map(char).join('') });
    for (const code of codes) {
      expect(line, `U+${code.toString(16)}`).not.toContain(char(code));
    }
  });

  // A format character draws nothing, so a reader of the log cannot see it.
  // Escaped, it shows where it was, and the value still parses back.
  it('escapes every format and default-ignorable character, a joiner included', () => {
    const codes = [0x00ad, 0x034f, 0x200b, 0x200d, 0x2060, 0xfe0f, 0xfeff];
    const entry = { value: codes.map(char).join('') };
    const line = logLine(entry);
    for (const code of codes) {
      expect(line, `U+${code.toString(16)}`).not.toContain(char(code));
    }
    expect(JSON.parse(line)).toEqual(entry);
  });

  // A tag character sits outside the basic plane, so it is two UTF-16 units.
  // Both are escaped, or the line would carry half a character.
  it('escapes a format character outside the basic plane whole', () => {
    const entry = { value: 'a' + String.fromCodePoint(0xe0041) + 'b' };
    const line = logLine(entry);
    expect(line).toContain('a\\udb40\\udc41b');
    expect(JSON.parse(line)).toEqual(entry);
  });

  // The escapes are JSON escapes, so a reader parses the value it was given.
  it('parses back to the entry it was given', () => {
    const entry = {
      value: ['a', char(0x85), 'b', char(0x2028), 'c', char(0x202e), 'd', char(0x7f)].join(''),
      nested: { list: [char(0x2029)] },
    };
    expect(JSON.parse(logLine(entry))).toEqual(entry);
  });
});

// Issue #114: a command prints a report for a person to read in a terminal,
// indented across lines. It is not one line, and it carries values from
// outside — an escalation reason quoting an adapter, a helpdesk copy a
// person edited. The same characters reorder or hide what a person reads.
describe('a printed report', () => {
  it('is the indented JSON of the value when every string is plain', () => {
    const value = { outcome: 'approved', items: [{ reason: 'policy_escalated' }] };
    expect(reportJson(value)).toBe(JSON.stringify(value, null, 2));
  });

  it('escapes every character a log line escapes, and parses back', () => {
    const codes = [0x7f, 0x85, 0x2028, 0x202e, 0x200b];
    const value = { copyText: codes.map(char).join('x'), list: [char(0x2029)] };
    const text = reportJson(value);
    for (const code of [...codes, 0x2029]) {
      expect(text, `U+${code.toString(16)}`).not.toContain(char(code));
    }
    expect(JSON.parse(text)).toEqual(value);
  });

  // An array is a report too: the escalations command prints a list.
  it('accepts a list', () => {
    expect(JSON.parse(reportJson([char(0x202e)]))).toEqual([char(0x202e)]);
  });
});
