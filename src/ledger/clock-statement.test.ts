// What the widened run insert may and may not name (issue #22).
//
// The seam is a fourth parameter, not a field on FencedRunInput, so the
// no-clock statement stays the statement that shipped before it: the column
// list omits `created_at` and the DEFAULT fires. This suite pins that,
// because a widened statement that always named the column would silently
// move every production row's timestamp onto the caller's clock.
import { describe, expect, it } from 'vitest';

import { runInsertStatement } from './insert.js';

const NO_CLOCK = runInsertStatement(false);
const WITH_CLOCK = runInsertStatement(true);

describe('the run insert statement without a clock', () => {
  // The non-goal, stated as a case: no default changes.
  it('does not name created_at, so the column DEFAULT fires', () => {
    expect(NO_CLOCK).not.toContain('created_at');
  });

  it('names the twelve columns it named before the seam existed', () => {
    for (const column of [
      'run_id',
      'ticket_id',
      'partition',
      'epoch',
      'state',
      'prompt_ver',
      'model_ver',
      'cost_micros',
      'steps_used',
      'deadline_at',
      'enqueued_at',
      'conversation_id',
      'turn_number',
    ]) {
      expect(NO_CLOCK).toContain(column);
    }
  });

  // The exact list, in order.
  //
  // Counting placeholders proves nothing: `runInsertStatement` builds them
  // from this same list, so the two agree whatever the list holds. What can
  // go wrong is a column added here without a value pushed in
  // `fencedTransition`, and no string check on the statement can see that.
  // Pinning the list makes such a change fail here, so its author has to open
  // this file and the values beside it.
  it('names exactly these columns, in this order', () => {
    const columns = NO_CLOCK.slice(NO_CLOCK.indexOf('(') + 1, NO_CLOCK.indexOf(')'))
      .split(',').map((name) => name.trim());
    expect(columns).toEqual([
      'run_id', 'ticket_id', 'partition', 'epoch', 'state', 'prompt_ver',
      'model_ver', 'cost_micros', 'steps_used', 'deadline_at', 'enqueued_at',
      'conversation_id', 'turn_number',
    ]);
    expect(NO_CLOCK).toContain(`$${columns.length}`);
    expect(NO_CLOCK).not.toContain(`$${columns.length + 1}`);
    // The plain form still omits `created_at`, which is what leaves the
    // column DEFAULT in charge of every production row.
    expect(NO_CLOCK).not.toContain('created_at');
  });
});

describe('the run insert statement with a clock', () => {
  it('names created_at', () => {
    expect(WITH_CLOCK).toContain('created_at');
  });

  it('binds one more placeholder than the plain form', () => {
    const plain = NO_CLOCK.slice(NO_CLOCK.indexOf('(') + 1, NO_CLOCK.indexOf(')'))
      .split(',').length;
    expect(WITH_CLOCK).toContain(`$${plain + 1}`);
    expect(WITH_CLOCK).not.toContain(`$${plain + 2}`);
  });

  // Same columns, one added. A form that reordered or dropped a column
  // would still pass the two cases above.
  it('is the plain form plus one column and one placeholder', () => {
    const columns = (s: string): string[] =>
      (/INSERT INTO run \(([^)]*)\)/.exec(s)?.[1] ?? '')
        .split(',')
        .map((c) => c.trim())
        .filter((c) => c.length > 0);
    const plain = columns(NO_CLOCK);
    const clocked = columns(WITH_CLOCK);
    expect(clocked).toHaveLength(plain.length + 1);
    expect(clocked.slice(0, plain.length)).toEqual(plain);
    expect(clocked[plain.length]).toBe('created_at');
  });
});
