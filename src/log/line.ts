// One structured log line, safe to read line by line.
//
// Pure. A process writes one JSON object per line, and a reader splits the
// stream on line breaks. `JSON.stringify` escapes the ASCII controls and
// nothing else.

/**
 * Characters JSON leaves raw that a reader of the log may not.
 *
 * DEL and the C1 controls, because NEL (U+0085) breaks a line in some log
 * readers. The Unicode line and paragraph separators, for the same reason.
 * Every format and default-ignorable character, because each one draws
 * nothing, and a bidi control also reorders what a person reading the line
 * sees. A logged value can carry
 * any of them, since several arrive from a request header or a form.
 */
const RAW_IN_JSON = /[\u007f-\u009f\u2028\u2029\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;

/**
 * The JSON of `entry`, with every character above written as a JSON escape.
 *
 * Only the characters change, never the value: `JSON.parse` returns the same
 * entry. A plain entry gives exactly what `JSON.stringify` gives. None of
 * these characters can appear in JSON outside a string, so each one found is
 * inside a string, where a `\u` escape is valid.
 *
 * A character outside the basic plane is two UTF-16 units, and each unit
 * gets its own escape, so no line carries half a character.
 *
 * An object, because `JSON.stringify` returns no string at all for
 * `undefined`, a function or a symbol.
 */
export function logLine(entry: Readonly<Record<string, unknown>>): string {
  return escapeRaw(JSON.stringify(entry));
}

/**
 * The indented JSON of `value`, escaped as a log line is (issue #114).
 *
 * For the report a command prints for a person to read in a terminal: the
 * approval's outcome, the escalations list, the replay and gold reports.
 * It spans many lines on purpose, so it is not a log line, but it carries
 * values from outside — an escalation reason quoting an adapter, a helpdesk
 * copy a person edited — and a terminal reorders and hides the same
 * characters a log reader does.
 *
 * `JSON.parse` returns the same value. The indentation puts whitespace only
 * between tokens, so every escaped character is still inside a string.
 *
 * An object or an array, for the reason `logLine` takes one: `JSON.stringify`
 * returns no string at all for `undefined`.
 */
export function reportJson(value: object): string {
  return escapeRaw(JSON.stringify(value, null, 2));
}

function escapeRaw(json: string): string {
  return json.replace(
    RAW_IN_JSON,
    (ch) => Array.from({ length: ch.length }, (_, i) =>
      `\\u${ch.charCodeAt(i).toString(16).padStart(4, '0')}`).join(''),
  );
}
