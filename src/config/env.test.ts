// The one rule for reading an integer and a required string from the
// environment (issue #72).
//
// Four parsers preceded this with three empty-string rules between them, and
// all four accepted spellings nobody meant to allow. DEC-36 is why that
// matters: the consumer and the intake daemons must agree on PARTITION_COUNT
// or two processes claim the same partition.
import { afterEach, describe, expect, it } from 'vitest';

import { positiveIntEnv, requiredEnv } from './env.js';

const TOUCHED = ['AURACLE_TEST_INT', 'AURACLE_TEST_STR'] as const;
const saved = new Map<string, string | undefined>();
for (const name of TOUCHED) saved.set(name, process.env[name]);

afterEach(() => {
  for (const name of TOUCHED) {
    const original = saved.get(name);
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
});

describe('positiveIntEnv', () => {
  it('returns the fallback when the variable is absent', () => {
    delete process.env['AURACLE_TEST_INT'];
    expect(positiveIntEnv('AURACLE_TEST_INT', 8)).toBe(8);
  });

  it('reads a plain decimal integer', () => {
    process.env['AURACLE_TEST_INT'] = '16';
    expect(positiveIntEnv('AURACLE_TEST_INT', 8)).toBe(16);
  });

  it('refuses an empty value rather than guessing', () => {
    // The rule the four parsers disagreed on. Empty was fatal for the
    // consumer and a silent 8 for the webhook, so `PARTITION_COUNT=` — which
    // is what an unsubstituted template leaves behind — gave two daemons
    // that must agree under DEC-36 two different partition counts.
    // Refusing is the loud, harmless half of that asymmetry.
    process.env['AURACLE_TEST_INT'] = '';
    expect(() => positiveIntEnv('AURACLE_TEST_INT', 8)).toThrow(
      /AURACLE_TEST_INT is set but empty/,
    );
  });

  it('names the fix in the message it refuses with', () => {
    process.env['AURACLE_TEST_INT'] = '';
    expect(() => positiveIntEnv('AURACLE_TEST_INT', 8)).toThrow(/unset it to use the default of 8/);
  });

  it('refuses whitespace, which is empty an operator cannot see', () => {
    process.env['AURACLE_TEST_INT'] = '   ';
    expect(() => positiveIntEnv('AURACLE_TEST_INT', 8)).toThrow(/must be a positive integer/);
  });

  it('refuses hexadecimal', () => {
    // `Number('0x10')` is 16 and passes `Number.isInteger`, so every one of
    // the four parsers read PARTITION_COUNT=0x10 as sixteen partitions
    // without a word. The same widening that
    // `src/coordinator/arrival-signal.ts` had already found and fixed in its
    // notification payload.
    process.env['AURACLE_TEST_INT'] = '0x10';
    expect(() => positiveIntEnv('AURACLE_TEST_INT', 8)).toThrow(/must be a positive integer/);
  });

  it('refuses exponent notation', () => {
    // `Number('1e3')` is 1000. IMAP_INTERVAL_MS=1e3 silently worked.
    process.env['AURACLE_TEST_INT'] = '1e3';
    expect(() => positiveIntEnv('AURACLE_TEST_INT', 8)).toThrow(/must be a positive integer/);
  });

  it('refuses a trailing decimal point', () => {
    // `Number('8.0')` is 8 and `Number.isInteger` passes, so this read as
    // eight and told the operator nothing about the value they wrote.
    process.env['AURACLE_TEST_INT'] = '8.0';
    expect(() => positiveIntEnv('AURACLE_TEST_INT', 8)).toThrow(/must be a positive integer/);
  });

  it('refuses a leading sign and surrounding space', () => {
    for (const raw of ['+8', ' 8', '8 ']) {
      process.env['AURACLE_TEST_INT'] = raw;
      expect(() => positiveIntEnv('AURACLE_TEST_INT', 8)).toThrow(/must be a positive integer/);
    }
  });

  it('refuses zero and a negative', () => {
    for (const raw of ['0', '-1', '00']) {
      process.env['AURACLE_TEST_INT'] = raw;
      expect(() => positiveIntEnv('AURACLE_TEST_INT', 8)).toThrow(/must be a positive integer/);
    }
  });

  it('refuses a value past the safe integer range', () => {
    // `/^\d+$/` matches any number of digits, and beyond 2^53 the parse
    // returns a value that no longer equals what was written.
    process.env['AURACLE_TEST_INT'] = '99999999999999999999';
    expect(() => positiveIntEnv('AURACLE_TEST_INT', 8)).toThrow(/must be a positive integer/);
  });

  it('quotes the offending value so the operator can see it', () => {
    process.env['AURACLE_TEST_INT'] = '0x10';
    expect(() => positiveIntEnv('AURACLE_TEST_INT', 8)).toThrow(/got '0x10'/);
  });
});

describe('requiredEnv', () => {
  it('returns the value', () => {
    process.env['AURACLE_TEST_STR'] = 'imap.example.test';
    expect(requiredEnv('AURACLE_TEST_STR')).toBe('imap.example.test');
  });

  it('refuses an absent variable', () => {
    delete process.env['AURACLE_TEST_STR'];
    expect(() => requiredEnv('AURACLE_TEST_STR')).toThrow(/AURACLE_TEST_STR is required/);
  });

  it('refuses an empty variable', () => {
    process.env['AURACLE_TEST_STR'] = '';
    expect(() => requiredEnv('AURACLE_TEST_STR')).toThrow(/AURACLE_TEST_STR is required/);
  });

  it('refuses a variable holding only whitespace', () => {
    // A password that is one space is a typo, not a credential.
    process.env['AURACLE_TEST_STR'] = '  ';
    expect(() => requiredEnv('AURACLE_TEST_STR')).toThrow(/AURACLE_TEST_STR is required/);
  });

  it('keeps a value that has meaningful inner space', () => {
    process.env['AURACLE_TEST_STR'] = 'two words';
    expect(requiredEnv('AURACLE_TEST_STR')).toBe('two words');
  });

  it('returns a value with surrounding whitespace verbatim', () => {
    // Neither trimmed nor refused. `requireNonEmpty` in
    // src/adapters/types.ts trims, because it validates action data already
    // in memory and its callers normalize. This one carries credentials:
    // IMAP_PASS may legitimately end in a space, and `process.loadEnvFile`
    // keeps whitespace inside quotes, so an operator can write one on
    // purpose. Trimming would send the wrong credential silently.
    //
    // Refusing it was tried and reverted. No spelling survives the check, so
    // the refusal made a working password unexpressible.
    for (const raw of [' secret', 'secret ', '\tsecret']) {
      process.env['AURACLE_TEST_STR'] = raw;
      expect(requiredEnv('AURACLE_TEST_STR')).toBe(raw);
    }
  });
});
