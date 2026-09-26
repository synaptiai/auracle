// Today's counts, held briefly (issue #101).
//
// The count runs on every load of the landing page. Held for a short time,
// a reviewer reloading the queue costs the ledger one count per window rather
// than one per load.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cachedDaily } from './daily-cache.js';

const at = (iso: string): number => Date.parse(iso);

function reader(days: string[]): { read: () => Promise<{ day: string; n: number }>; calls: () => number } {
  let calls = 0;
  return {
    read: async () => {
      calls += 1;
      return { day: days[Math.min(calls, days.length) - 1]!, n: calls };
    },
    calls: () => calls,
  };
}

describe('a daily count held briefly', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers from the held value inside the window, and reads again after it', async () => {
    let now = at('2026-09-14T10:00:00Z');
    const source = reader(['2026-09-14']);
    const read = cachedDaily(source.read, 30_000, () => now);

    expect(await read()).toEqual({ day: '2026-09-14', n: 1 });
    now += 29_999;
    expect(await read()).toEqual({ day: '2026-09-14', n: 1 });
    expect(source.calls()).toBe(1);
    now += 1;
    expect(await read()).toEqual({ day: '2026-09-14', n: 2 });
  });

  // A count held across midnight would state yesterday's figures as today's.
  it('reads again when the UTC day has turned, inside the window', async () => {
    let now = at('2026-09-14T23:59:50Z');
    const source = reader(['2026-09-14', '2026-09-15']);
    const read = cachedDaily(source.read, 30_000, () => now);

    expect((await read()).day).toBe('2026-09-14');
    now = at('2026-09-15T00:00:05Z');
    expect(await read()).toEqual({ day: '2026-09-15', n: 2 });
  });

  // A read that began before midnight answers the call that started it. A call
  // after midnight does not join it, and the value it returns is never held
  // over the newer day's.
  it('does not hand a read begun before midnight to a call after it', async () => {
    let now = at('2026-09-14T23:59:59.500Z');
    const pending: ((value: { day: string }) => void)[] = [];
    const read = cachedDaily(() => new Promise<{ day: string }>((resolve) => { pending.push(resolve); }), 30_000, () => now);

    const before = read();
    now = at('2026-09-15T00:00:00.500Z');
    const after = read();
    expect(pending).toHaveLength(2);
    pending[1]!({ day: '2026-09-15' });
    expect(await after).toEqual({ day: '2026-09-15' });
    pending[0]!({ day: '2026-09-14' });
    expect(await before).toEqual({ day: '2026-09-14' });
    // The late answer from before midnight did not replace the held value.
    expect(await read()).toEqual({ day: '2026-09-15' });
    expect(pending).toHaveLength(2);
  });

  // A read begun before midnight that fails late must not clear the newer
  // day's read while it runs, or the next call would start a third.
  it('keeps the newer read running when an older one fails late', async () => {
    let now = at('2026-09-14T23:59:59.500Z');
    const settle: { resolve: (value: { day: string }) => void; reject: (error: Error) => void }[] = [];
    const read = cachedDaily(
      () => new Promise<{ day: string }>((resolve, reject) => { settle.push({ resolve, reject }); }),
      30_000,
      () => now,
    );

    const before = read();
    now = at('2026-09-15T00:00:00.500Z');
    const after = read();
    settle[0]!.reject(new Error('the old read failed'));
    await expect(before).rejects.toThrow('the old read failed');
    const joined = read();
    expect(settle).toHaveLength(2);
    settle[1]!.resolve({ day: '2026-09-15' });
    expect(await Promise.all([after, joined])).toEqual([{ day: '2026-09-15' }, { day: '2026-09-15' }]);
  });

  // A read over a connection that died never settles, and nothing answers it.
  // Shared with every later call, it would hang the page for the rest of the
  // day. A read that outlasts its bound fails, and the next call starts anew.
  it('gives up on a read that never settles, and reads again', async () => {
    let calls = 0;
    const read = cachedDaily(
      () => {
        calls += 1;
        return calls === 1 ? new Promise<{ day: string }>(() => undefined) : Promise.resolve({ day: '2026-09-14' });
      },
      30_000,
      () => at('2026-09-14T10:00:00Z'),
      20,
    );

    await expect(read()).rejects.toThrow('the read did not finish within 20ms');
    expect(await read()).toEqual({ day: '2026-09-14' });
    expect(calls).toBe(2);
  });

  // A read that throws before it returns a promise is a failure like any other,
  // and the next call reads again.
  it('reads again after a read that threw at once', async () => {
    let calls = 0;
    const read = cachedDaily((): Promise<{ day: string }> => {
      calls += 1;
      if (calls === 1) throw new Error('thrown before a promise');
      return Promise.resolve({ day: '2026-09-14' });
    }, 30_000, () => at('2026-09-14T10:00:00Z'));

    await expect(read()).rejects.toThrow('thrown before a promise');
    expect(await read()).toEqual({ day: '2026-09-14' });
    expect(calls).toBe(2);
  });

  // The bound belongs to the read, so a call that joins a read late waits only
  // for what is left of it. And an answer that comes after the bound is not
  // held: the next call reads again.
  it('fails a late joiner when the read runs out, and holds no late answer', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const answers: ((value: { day: string }) => void)[] = [];
    const read = cachedDaily(() => {
      calls += 1;
      return new Promise<{ day: string }>((resolve) => { answers.push(resolve); });
    }, 30_000, () => at('2026-09-14T10:00:00Z'), 20);

    const first = read();
    const firstFailed = expect(first).rejects.toThrow('did not finish within 20ms');
    await vi.advanceTimersByTimeAsync(15);
    let joinedSettled = false;
    const joined = read();
    const joinedFailed = expect(joined).rejects.toThrow('did not finish within 20ms')
      .then(() => { joinedSettled = true; });
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(4);
    expect(joinedSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await firstFailed;
    await joinedFailed;
    expect(joinedSettled).toBe(true);

    answers[0]!({ day: '2026-09-14' });
    await vi.advanceTimersByTimeAsync(0);
    const again = read();
    expect(calls).toBe(2);
    answers[1]!({ day: '2026-09-14' });
    expect(await again).toEqual({ day: '2026-09-14' });
  });

  // A fault is not a value. Holding it would show the fault for the whole
  // window after the ledger recovered.
  it('holds no failed read', async () => {
    let fail = true;
    let calls = 0;
    const read = cachedDaily(async () => {
      calls += 1;
      if (fail) throw new Error('the count read failed');
      return { day: '2026-09-14' };
    }, 30_000, () => at('2026-09-14T10:00:00Z'));

    await expect(read()).rejects.toThrow('the count read failed');
    fail = false;
    expect(await read()).toEqual({ day: '2026-09-14' });
    expect(calls).toBe(2);
  });

  // Many reviewers opening the page at once share one read.
  it('shares one read between calls that arrive while it runs', async () => {
    let calls = 0;
    let finish: (value: { day: string }) => void = () => undefined;
    const read = cachedDaily(() => {
      calls += 1;
      return new Promise<{ day: string }>((resolve) => { finish = resolve; });
    }, 30_000, () => at('2026-09-14T10:00:00Z'));

    const first = read();
    const second = read();
    finish({ day: '2026-09-14' });
    expect(await Promise.all([first, second])).toEqual([{ day: '2026-09-14' }, { day: '2026-09-14' }]);
    expect(calls).toBe(1);
  });
});
