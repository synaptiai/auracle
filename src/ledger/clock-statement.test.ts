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
    ]) {
      expect(NO_CLOCK).toContain(column);
    }
  });

  it('binds exactly twelve placeholders', () => {
    expect(NO_CLOCK).toContain('$12');
    expect(NO_CLOCK).not.toContain('$13');
  });
});

describe('the run insert statement with a clock', () => {
  it('names created_at', () => {
    expect(WITH_CLOCK).toContain('created_at');
  });

  it('binds one more placeholder than the plain form', () => {
    expect(WITH_CLOCK).toContain('$13');
    expect(WITH_CLOCK).not.toContain('$14');
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
