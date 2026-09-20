// The runs list the console reads (issue #27).
//
// The console writes no SQL. It reads through the modules the jobs already
// use, so a metric or a state filter has exactly one definition and the two
// readers cannot drift. This case pins that the runs list and the escalation
// queue share one SELECT: a second definition is the drift the non-goal names.
import { describe, expect, it } from 'vitest';

import { RUN_STATES } from '../coordinator/coordinator.js';
import { LEDGER_STATES, RUN_STATES_ESCALATION, TERMINAL_RUN_STATES, runSelectFor } from './query.js';

describe('the runs SELECT', () => {
  it('keeps the escalation queue on its own two states', () => {
    expect(RUN_STATES_ESCALATION).toEqual(['escalated', 'awaiting_approval']);
    const sql = runSelectFor(RUN_STATES_ESCALATION);
    expect(sql).toContain("'escalated'");
    expect(sql).toContain("'awaiting_approval'");
    expect(sql).not.toContain("'resolved'");
  });

  // The console's runs surface shows every state, and it must do so through
  // the same statement rather than a copy of it.
  it('widens to any state without a second statement', () => {
    const wide = runSelectFor(['resolved', 'escalated']);
    const narrow = runSelectFor(RUN_STATES_ESCALATION);
    // One SELECT body, one WHERE clause, only the state list differs.
    const strip = (s: string): string => s.slice(0, s.indexOf('WHERE'));
    expect(strip(wide)).toBe(strip(narrow));
    expect(wide).toContain("'resolved'");
  });

  // The state vocabulary lives in the coordinator, and this module holds a
  // reader's view of it. A copy would drift silently: a state added to the
  // walk and not here disappears from the console's runs list, and the run
  // detail answers "no such run" for a run that exists.
  it('carries every active state the coordinator walks', () => {
    for (const state of RUN_STATES) {
      expect(LEDGER_STATES).toContain(state);
    }
    // Derived rather than retyped, so the two cannot fall out of step.
    expect(LEDGER_STATES.slice(0, RUN_STATES.length)).toEqual([...RUN_STATES]);
    // DEC-48: a snoozed run has left the walk without ending, and the runs
    // surface filters on it like any other state.
    expect(LEDGER_STATES).toContain('snoozed');
    expect(LEDGER_STATES).toHaveLength(RUN_STATES.length + TERMINAL_RUN_STATES.length + 1);
  });

  // The terminal states have no runtime list of their own in the coordinator
  // — they are a union type — so this is where they are written down. The
  // `satisfies` clause makes a typo a compile error; this makes a missing one
  // a test failure.
  it('names all five terminal states', () => {
    expect([...TERMINAL_RUN_STATES].sort()).toEqual(
      // `closed` is DEC-48's: a reviewer finished the case with no reply.
      ['abandoned', 'closed', 'escalated', 'resolved', 'superseded'],
    );
  });

  // A state list is interpolated, so it must never carry anything but the
  // ledger's own state names.
  it('refuses a state that is not a ledger state', () => {
    expect(() => runSelectFor(['resolved; DROP TABLE run'])).toThrow(/state/);
    expect(() => runSelectFor([])).toThrow(/state/);
  });
});
