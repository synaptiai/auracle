/**
 * How long a case counts as held (DEC-46).
 *
 * Its own module for the reason `ledger-name.ts` and `hosts.ts` are: `main.ts`
 * runs `main()` when it is imported, so nothing there can be reached from a
 * test. The default is a number three shipped documents state — the design
 * notes card, the runbook and `.env.example` — and a card promising a period
 * the console does not use would be a sentence about another console. So the
 * default is here, where a test holds it to the words the pages use.
 */

/** Twenty minutes: the period the design notes card and the runbook state. */
export const HOLD_LAPSE_MS = 1_200_000;

/**
 * The period `CONSOLE_HOLD_LAPSE_MS` names, or the default.
 *
 * A value that is not whole milliseconds above zero is refused rather than
 * rounded. A period of nothing holds nothing, which is not a hold; a
 * fractional one is a unit mistake, and the operator hears about it at
 * startup rather than from a case that lapsed early.
 */
export function requireHoldLapse(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return HOLD_LAPSE_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`CONSOLE_HOLD_LAPSE_MS must be whole milliseconds above zero, got '${raw}'`);
  }
  return value;
}
