// The one reading of a fault, proved against the cases the four deleted copies
// disagreed on.
import { describe, expect, it } from 'vitest';

import { errorMessage } from './errors.js';

describe('errorMessage', () => {
  it('returns the message of an Error', () => {
    expect(errorMessage(new Error('the ledger refused the row'))).toBe(
      'the ledger refused the row',
    );
  });

  it('stringifies a value that is not an Error', () => {
    expect(errorMessage('a bare string')).toBe('a bare string');
    expect(errorMessage(42)).toBe('42');
    expect(errorMessage(null)).toBe('null');
    expect(errorMessage(undefined)).toBe('undefined');
  });

  it('reads the inner errors of an AggregateError', () => {
    // The case three of the four deleted copies got wrong. A refused TCP
    // connection arrives this way: the AggregateError's own message is empty
    // and String() gives the bare class name, so both weaker copies reported
    // a connection failure as '' or 'AggregateError'. ECONNREFUSED is only
    // reachable through `.errors`.
    const refused = new AggregateError(
      [new Error('connect ECONNREFUSED 127.0.0.1:5432')],
      '',
    );
    // The two readings a weaker copy takes, shown failing. Without them this
    // case would pass against an implementation that never looks at
    // `.errors`, because it asserts only the result and not the difficulty.
    expect(refused.message).toBe('');
    expect(String(refused)).not.toContain('ECONNREFUSED');
    expect(errorMessage(refused)).toBe('connect ECONNREFUSED 127.0.0.1:5432');
  });

  it('joins several inner errors', () => {
    const both = new AggregateError(
      [
        new Error('connect ECONNREFUSED 127.0.0.1:5432'),
        new Error('connect ECONNREFUSED ::1:5432'),
      ],
      '',
    );
    expect(errorMessage(both)).toBe(
      'connect ECONNREFUSED 127.0.0.1:5432; connect ECONNREFUSED ::1:5432',
    );
  });

  it('falls back to String() for an Error with an empty message', () => {
    // An Error carrying nothing to say is worse than its class name.
    expect(errorMessage(new Error(''))).toBe('Error');
  });

  it('falls back for an AggregateError with no inner errors', () => {
    expect(errorMessage(new AggregateError([], 'nothing aggregated'))).toBe(
      'nothing aggregated',
    );
  });

  it('stops on an AggregateError that contains itself', () => {
    // The recursion over `.errors` had no guard where the cause walk had two.
    //
    // The result is asserted, not merely that nothing threw. The depth cap
    // also stops this input, so `not.toThrow()` passed with the cycle guard
    // deleted — the cap masked it, and the case proved nothing about the
    // thing it names.
    const loop = new AggregateError([], 'outer');
    (loop as { errors: unknown[] }).errors = [loop];
    expect(errorMessage(loop)).toBe('<a fault that could not describe itself>');
  });

  it('stops on an AggregateError nested past the depth cap', () => {
    let nested: unknown = new Error('innermost');
    for (let i = 0; i < 40; i += 1) nested = new AggregateError([nested], '');
    expect(() => errorMessage(nested)).not.toThrow();
  });

  it('survives a value with no prototype', () => {
    // `String(Object.create(null))` throws, which would make the reporter
    // the fault rather than reporting one.
    expect(() => errorMessage(Object.create(null) as unknown)).not.toThrow();
  });

  it('survives a throwing errors getter', () => {
    const hostile = new AggregateError([], 'outer');
    Object.defineProperty(hostile, 'errors', {
      get() {
        throw new Error('the errors getter blew up');
      },
    });
    expect(() => errorMessage(hostile)).not.toThrow();
  });
});
