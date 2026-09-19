/**
 * How long a console send waits before the relay may post it (DEC-51).
 *
 * Its own module for the reason `hold-lapse.ts` is: `main.ts` runs `main()`
 * when it is imported, so nothing there can be reached from a test. The
 * default is the period the handoff's own copy shows — "Undo · 12s" — and
 * two shipped documents state it: the runbook and `.env.example`. A page
 * promising a window the console does not use would be a sentence about
 * another console, so the default is here, where a test holds it to the words
 * the pages use.
 *
 * The period is a *server* hold, never a delay in the browser: a closed tab
 * must not drop a send the page reported as done.
 */

/** Twelve seconds: the window the handoff's undo button counts down. */
export const SEND_HOLD_MS = 12_000;

/**
 * The longest hold an operator may set: five minutes.
 *
 * A hold is a reply a customer has not received yet. The relay skips a held
 * record and picks it up on a later scan, so nothing between here and the
 * customer reports a record held for a day — it waits, and the queue says
 * `pending`. The bound is what keeps a mistyped millisecond count, or a
 * minute count read as milliseconds, from parking replies for a week with
 * nobody told. Five minutes is far past any reviewer's undo.
 */
export const MAX_SEND_HOLD_MS = 300_000;

/**
 * The period `CONSOLE_SEND_HOLD_MS` names, or the default.
 *
 * A value that is not whole milliseconds inside the bound is refused rather
 * than rounded. Zero is allowed and means "send at once": an adopter who
 * wants no window states that rather than losing the feature by accident. A
 * fractional value is a unit mistake, and a value above `MAX_SEND_HOLD_MS`
 * parks replies with nobody told. The operator hears about either at
 * startup, rather than from a reply that reached a customer early or from
 * one that never left.
 */
export function requireSendHold(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return SEND_HOLD_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > MAX_SEND_HOLD_MS) {
    throw new Error(
      `CONSOLE_SEND_HOLD_MS must be whole milliseconds from zero to ${MAX_SEND_HOLD_MS}, got '${raw}'`,
    );
  }
  return value;
}
