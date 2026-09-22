// What each process's log test sends and checks (#114).
//
// A value from outside a process — a header, a message, an adapter's error
// text — can carry a character JSON leaves raw. These are the ones a log
// reader treats as a line break or a reordering, in the order the issue
// names them: a C1 control (NEL), the Unicode line and paragraph separators,
// and a bidi override.
import { expect } from 'vitest';

export const HOSTILE = [
  'dana',
  String.fromCharCode(0x85),
  '{"event":"forged"}',
  String.fromCharCode(0x2028),
  'x',
  String.fromCharCode(0x2029),
  'y',
  String.fromCharCode(0x202e),
  'evil',
  // A C1 control that is not NEL, an isolate and a mark: a sink that escaped
  // only the four above would still write these raw.
  String.fromCharCode(0x9b),
  String.fromCharCode(0x2066),
  String.fromCharCode(0x200f),
].join('');

/**
 * The class the issue names, written out here rather than imported, so a
 * sink that escapes a narrower set fails. The C1 controls, the line and
 * paragraph separators, and every bidi control: the marks, the embeddings
 * and overrides, the isolates and the Arabic letter mark.
 */
const RAW = /[\u0080-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069\u061c]/u;

/**
 * Asserts the lines a process wrote hold no raw character, that each parses
 * back to one entry, and that `value` survives in one of them unchanged.
 *
 * Returns the entry that carried it, so a caller can check where it went.
 */
export function expectEscaped(lines: readonly string[], value: string): Record<string, unknown> {
  // Non-vacuity: a sink that wrote nothing would pass every check below.
  expect(lines.length).toBeGreaterThan(0);
  let carrier: Record<string, unknown> | null = null;
  for (const line of lines) {
    const raw = RAW.exec(line);
    expect(raw, raw === null ? '' : `U+${raw[0].charCodeAt(0).toString(16)} reached the log raw`)
      .toBeNull();
    const entry = JSON.parse(line) as Record<string, unknown>;
    if (JSON.stringify(entry).includes(JSON.stringify(value).slice(1, -1))) carrier = entry;
  }
  expect(carrier, 'no line carried the value').not.toBeNull();
  return carrier!;
}
