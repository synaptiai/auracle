// A defect inside the coordinator, named so the walk can end on it.
//
// Four places in the walk assert an invariant this system controls: a step
// read a value the step before it should have written, a transition addressed
// a run row the ledger does not hold, the gate met an intent the taxonomy
// does not define, and a final step answered 'continue'. None of them is an
// environment fault, and none of them clears on a retry.
//
// Before this they were plain `Error`s. They escaped `coordinateTicket`, so the
// run kept whatever state it last reached and journalled nothing;
// `src/escalations/query.ts` reads its reason from an `escalate` step, and
// these runs wrote none. The consumer logged `{ outcome: 'error' }` and left
// the message queued against MAX_INTAKE_ATTEMPTS, which spent a classifier
// budget and filed an orphan run on every one of the 50 attempts.
//
// A distinct class, and not a catch of every error, because the two cases
// want opposite handling. A defect is deterministic: retrying it is certain
// waste, so the run escalates and the message is acked. A transient fault —
// a dropped connection, a provider timeout — may well clear, so it still
// propagates to the consumer's retry and abandonment floor untouched.
//
// This module imports nothing, so every step may raise a fault without
// reaching the sequencer or the ledger.

/**
 * An invariant of the coordinator that did not hold.
 *
 * Raise this, never a bare `Error`, from a check inside the walk that asserts
 * something this system is responsible for. `coordinator.ts` catches exactly
 * this class and ends the run at 'escalated' with `internal_fault` on its own
 * journal row. `steps.test.ts` holds the four sites shut, in its
 * `a fault inside the walk` block, and a structural case there refuses a bare
 * `Error` anywhere in the walk.
 *
 * **The message is journalled and an operator quotes it into an issue.** So
 * interpolate only what this system named itself: a step id, a state key, the
 * run id, a taxonomy id. Never the ticket text, a customer address, a model
 * answer or an adapter's error. `src/escalations/reason.ts` exists because an
 * interpolated `reason` once carried a recipient, and the `fault` field takes
 * no such trimming — it is shown whole by `pnpm run escalations`, which is a
 * command rather than an unauthenticated page.
 */
export class CoordinatorFaultError extends Error {
  /**
   * `cause` carries the second failure when the escalation itself fails.
   *
   * The sequencer's recovery writes to the ledger, and that write can fail —
   * most sharply for the fault that says the run row is gone, because the
   * recovery's own transition addresses that same missing row. Without a cause
   * the ledger's complaint replaced the invariant message, which is the whole
   * of what `internal_fault` gives an operator.
   */
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CoordinatorFaultError';
  }
}
