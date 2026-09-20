// What a run state means to the fencing epoch (DEC-28, issue #113).
//
// The fence exists for one hazard: a partition owner that lost its partition
// and has not noticed. That hazard only exists while a run is in flight —
// while a consumer is walking it and could still write. Three callers ask
// this question, and they must answer it the same way:
//
//   - `claimPartition` raises the fence of the tickets whose runs are in
//     flight in the partition it claims (src/coordinator/consumer.ts);
//   - `fencedTransition` applies the epoch comparison to those runs alone
//     (src/ledger/insert.ts);
//   - the relay sends a finished run's record and refuses every other one
//     (src/relay/relay.ts).
//
// A run parked in `awaiting_approval` or `snoozed` has left every consumer's
// hands: the walk ended at the park, and the next write is a person's, made
// through the approval path, or the clock's, made through the snooze
// returner. A terminal run has left them for good. Their writes are
// settled by their own guards — the run row lock, the state the transition
// requires, and the DEC-24 key that records which run carries an action —
// and not by a fence that another run's work moved.
//
// This module is separate from `insert.ts` so a pure test can read it. The
// terminal names also live in the ledger's own literal set, which the
// latency suite parses to pin its own restated list against; `run-state.test.ts`
// pins the two sets together.
//
// It imports nothing: a state list that needs a connection to read is a
// state list that cannot be read where the decision is made.
/**
 * The states a consumer drives. A run in one of these is in flight, and the
 * fence governs it — whatever moved the fence, and whoever holds the
 * partition now.
 */
export const IN_FLIGHT_RUN_STATES: readonly string[] = [
  'received',
  'classified',
  'retrieved',
  'composed',
  'gated',
  'executing',
];

/**
 * The states that wait (DEC-12, DEC-48). One list, named once, so the three
 * callers cannot disagree about which ones they are.
 *
 * `awaiting_approval` waits for a person. `snoozed` waits for the clock or
 * for the customer, and the reviewer who set it is not standing over it.
 * Either way the walk has ended and the next write is not a consumer's.
 */
export const PARKED_RUN_STATES: readonly string[] = ['awaiting_approval', 'snoozed'];

/**
 * The states a run never leaves (V2 open item 7).
 *
 * `closed` is DEC-48's: a reviewer finished the case with no reply, so the
 * run never sends and never returns to a person.
 */
export const TERMINAL_RUN_STATE_NAMES: readonly string[] = [
  'resolved',
  'escalated',
  'superseded',
  'abandoned',
  'closed',
];

/**
 * What the fence makes of a run in this state.
 *
 * A state outside the vocabulary reads as in flight. That is the safe
 * reading: the fence then governs it, and an epoch that moved still refuses
 * the write. A state this module does not recognise is not a licence to
 * write. The ledger suites seed a run in `queued`, which is not a state the
 * coordinator walks, and they require the epoch check to keep refusing it.
 */
export function runStateClass(state: string): 'in_flight' | 'parked' | 'terminal' {
  if (PARKED_RUN_STATES.includes(state)) return 'parked';
  if (TERMINAL_RUN_STATE_NAMES.includes(state)) return 'terminal';
  return 'in_flight';
}
