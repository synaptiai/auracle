// A terminal reads some characters as instructions rather than as text, and
// the approval command prints text a person and a customer both wrote.
//
// The class matters: a bidi override reorders the two labelled blocks the
// refusal prints, which is the one judgement that output exists to support.
import { describe, expect, it } from 'vitest';

import { terminalText } from './terminal-text.js';

describe('text written for a terminal to print', () => {
  it('writes a control character as an escape', () => {
    expect(terminalText('before\u001b[31mafter')).toBe('before\\u001b[31mafter');
    expect(terminalText('bell\u0007')).toBe('bell\\u0007');
    expect(terminalText('nel\u0085')).toBe('nel\\u0085');
    expect(terminalText('del\u007f')).toBe('del\\u007f');
  });

  it('writes a bidi override as an escape', () => {
    expect(terminalText('a\u202eb')).toBe('a\\u202eb');
    expect(terminalText('a\u202cb')).toBe('a\\u202cb');
    // Zero-width and word-joiner characters draw nothing, so a reader cannot
    // see them; they are written out for the same reason.
    expect(terminalText('a\u200bb')).toBe('a\\u200bb');
    expect(terminalText('a\u2060b')).toBe('a\\u2060b');
  });

  it('writes a line or paragraph separator as an escape', () => {
    expect(terminalText('a\u2028b')).toBe('a\\u2028b');
    expect(terminalText('a\u2029b')).toBe('a\\u2029b');
  });

  // A reply is read as paragraphs. These two are C0 controls and a person
  // needs them, so they are the ones the class holds out.
  it('keeps the two characters a reader needs', () => {
    expect(terminalText('one\ntwo\n\ttabbed')).toBe('one\ntwo\n\ttabbed');
  });

  it('leaves ordinary text, and text outside the basic plane, alone', () => {
    expect(terminalText('We refunded the duplicate charge.')).toBe('We refunded the duplicate charge.');
    expect(terminalText('Ana — obrigado! 日本語 ✓')).toBe('Ana — obrigado! 日本語 ✓');
    expect(terminalText('emoji 🙂')).toBe('emoji 🙂');
  });

  // A character outside the basic plane is two UTF-16 units. Neither half is
  // in any of the classes above, but the unit-wise escape is what keeps a
  // character from being written out as half of itself.
  it('escapes each unit of a character it does escape', () => {
    // U+1D173 (musical symbol begin beam) is a format character.
    expect(terminalText('\u{1d173}')).toBe('\\ud834\\udd73');
  });

  // A typed `\u202e` and an escaped control would print alike, and the
  // approval's two blocks exist so a person can tell such texts apart.
  it('writes a backslash twice, so typed text never reads as an escape', () => {
    const typed = String.raw`a\u202eb`;
    expect(terminalText(typed)).toBe(String.raw`a\\u202eb`);
    expect(terminalText(typed)).not.toBe(terminalText('a\u202eb'));
    expect(terminalText(String.raw`C:\files`)).toBe(String.raw`C:\\files`);
  });
});
