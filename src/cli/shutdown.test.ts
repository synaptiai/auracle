// A pool's end is bounded, so a client stuck behind a lock cannot hold a
// stopping process open.
//
// pg's `pool.end()` waits for every checked-out client to come back. An insert
// blocked by a lock never brings its client back, so the end never settles.
// The process then stays alive on that client's socket.
import { describe, expect, it } from 'vitest';

import { endWithin } from './shutdown.js';

describe('endWithin', () => {
  it('reports an end that settles in time', async () => {
    const outcome = await endWithin(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }, 1_000);
    expect(outcome).toBe('ended');
  });

  it('reports a timeout for an end that never settles', async () => {
    const asked = Date.now();
    const outcome = await endWithin(() => new Promise<void>(() => undefined), 100);
    expect(outcome).toBe('timeout');
    // The wait is the bound, not the end's own time, which here is forever.
    expect(Date.now() - asked).toBeLessThan(1_000);
  });

  it('passes on an end that fails', async () => {
    await expect(endWithin(async () => {
      throw new Error('the pool refused to end');
    }, 1_000)).rejects.toThrow('the pool refused to end');
  });
});
