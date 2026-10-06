// A pool whose named connections fail, for the cases that need a ledger write
// to fail after a send has already failed (DEC-30). Everything else passes
// through to the real pool, so the rest of the case runs against Postgres.
import type { Pool } from 'pg';

/**
 * Wraps `pool` so that its `connect` calls numbered in `failOn` throw, counting
 * from 1. A relay scan takes one connection for the send's transaction and one
 * for each escalation, so the numbers pick out which write fails.
 */
export function failingConnects(pool: Pool, failOn: readonly number[]): Pool {
  let connects = 0;
  return new Proxy(pool, {
    get(target, property) {
      if (property === 'connect') {
        return async () => {
          connects += 1;
          if (failOn.includes(connects)) throw new Error('the ledger dropped the connection');
          return target.connect();
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/**
 * Wraps `pool` so that its `connect` call numbered `on` first runs `before`,
 * then connects. A case uses it to settle a record under the relay, between
 * the moment it reads the record and the moment it writes an escalation.
 */
export function beforeConnect(pool: Pool, on: number, before: () => Promise<unknown>): Pool {
  let connects = 0;
  return new Proxy(pool, {
    get(target, property) {
      if (property === 'connect') {
        return async () => {
          connects += 1;
          if (connects === on) await before();
          return target.connect();
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}
