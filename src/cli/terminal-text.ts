// Text from the ledger or the helpdesk, written for a terminal to print.
//
// A reply is steered by a customer's message and edited by a person, so it can
// carry any character. Printed raw, an escape sequence controls the terminal
// (colour, a rewritten title, a written title bar) and a bidi override
// reorders the text around it. The approval command prints two labelled
// blocks and asks a person to tell them apart, which is exactly what a bidi
// override defeats: the block labelled "the copy the helpdesk holds" reads as
// the reply the ledger holds.
//
// `src/log/line.ts` escapes the same class for the log sinks. This is the
// same rule for a terminal, with the two characters a person needs to read a
// reply kept as they are: a newline and a tab. Everything else invisible is
// written as a `\u` escape, so the printed text says what it holds.

/**
 * Characters a terminal reads as an instruction rather than as text.
 *
 * C0 controls, DEL and the C1 controls, the Unicode line and paragraph
 * separators, every format character and every default-ignorable one. It is
 * the class `src/log/line.ts` escapes for a log reader, plus the C0 controls:
 * a log is JSON, which escapes them already, and a terminal is not. Two
 * characters a person reading a reply needs are held out by name, because
 * they are C0 controls too: `\n` and `\t`. A reply is read as paragraphs.
 *
 * The backslash that begins an escape is in the class as well, for the
 * reason `terminalText` gives.
 */
const ESCAPED = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\p{Cf}\p{Default_Ignorable_Code_Point}\\]/gu;

/**
 * The same text, with every invisible character written as an escape.
 *
 * Only the characters change, never the value on the page: a reader sees
 * `\u202e` where a control character sat, which is what makes the two blocks
 * below it readable. A character outside the basic plane is two UTF-16 units
 * and each unit is escaped on its own, so no half character is written.
 *
 * A backslash is written twice. Without that, a person who types the six
 * characters `\u202e` gets output identical to an escaped control, and a
 * reader cannot tell the two apart. JSON makes the same choice for the same
 * reason.
 */
export function terminalText(text: string): string {
  return text.replace(
    ESCAPED,
    (ch) => ch === '\\' ? '\\\\' : Array.from({ length: ch.length }, (_, i) =>
      `\\u${ch.charCodeAt(i).toString(16).padStart(4, '0')}`).join(''),
  );
}
