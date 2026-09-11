// Which partitions a consumer claims, and whether it can ever receive work
// on them (issue #72).
//
// DEC-27 gives each partition one owner and DEC-36 routes on
// `hash(conversation_id) % PARTITION_COUNT`. Both rules are only as good as
// the parsing underneath them, and the parsing accepted values nobody meant
// to write.
import { describe, expect, it } from 'vitest';

import { parsePartitions, refuseUnreachablePartitions } from './consumer-main.js';

describe('parsePartitions', () => {
  it('reads a comma-separated list, with space around the entries', () => {
    expect(parsePartitions('0,1,2')).toEqual([0, 1, 2]);
    expect(parsePartitions(' 3 , 4 ')).toEqual([3, 4]);
  });

  it('requires the variable', () => {
    expect(() => parsePartitions(undefined)).toThrow(/CONSUMER_PARTITIONS is required/);
    expect(() => parsePartitions('')).toThrow(/CONSUMER_PARTITIONS is required/);
    expect(() => parsePartitions(' , ')).toThrow(/CONSUMER_PARTITIONS is required/);
  });

  it('refuses every spelling Number() used to widen', () => {
    // This is the variable that decides which partitions a consumer claims,
    // and it took all of these. `CONSUMER_PARTITIONS=0x10` claimed partition
    // sixteen; with PARTITION_COUNT=8 no ticket routes there, so the
    // consumer processed nothing and reported a healthy start.
    for (const raw of ['0x10', '1e1', '8.0', '+2', '0b11', '0o7', 'Infinity', 'NaN']) {
      expect(() => parsePartitions(raw)).toThrow(/must be non-negative integers/);
    }
  });

  it('refuses a negative', () => {
    expect(() => parsePartitions('-1')).toThrow(/must be non-negative integers/);
  });

  it('refuses a value past the safe integer range', () => {
    expect(() => parsePartitions('99999999999999999999')).toThrow(
      /must be non-negative integers/,
    );
  });

  it('quotes the offending entry, not the whole list', () => {
    // The old message quoted the entire variable, so a list of twelve
    // partitions with one typo made the operator find it themselves.
    expect(() => parsePartitions('0,1,0x10,3')).toThrow(/got '0x10'/);
  });

  it('accepts zero, which is a real partition', () => {
    expect(parsePartitions('0')).toEqual([0]);
  });
});

describe('refuseUnreachablePartitions', () => {
  it('accepts every partition the count routes to', () => {
    expect(() => refuseUnreachablePartitions([0, 7], 8)).not.toThrow();
  });

  it('refuses a partition at or above the count', () => {
    // `hash(...) % 8` is 0 to 7, so partition 8 never takes a ticket. A
    // consumer claiming it starts cleanly, reports health and processes
    // nothing — which is the silent kind of wrong, not the loud kind.
    expect(() => refuseUnreachablePartitions([8], 8)).toThrow(/never routes to/);
    expect(() => refuseUnreachablePartitions([16], 8)).toThrow(/never routes to/);
  });

  it('names every unreachable partition and the valid range', () => {
    expect(() => refuseUnreachablePartitions([0, 9, 12], 8)).toThrow(/9, 12/);
    expect(() => refuseUnreachablePartitions([0, 9], 8)).toThrow(/Valid partitions are 0 to 7/);
  });

  it('says nothing when the list is empty', () => {
    expect(() => refuseUnreachablePartitions([], 8)).not.toThrow();
  });
});
