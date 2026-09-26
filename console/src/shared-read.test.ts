// One read at a time, shared by every caller that asks while it runs.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { givingUp, knowledgeReads, sharedRead } from './shared-read.js';

/** A read the test settles by hand, counting how often it started. */
function manual(): { read: () => Promise<number>; settle: (value: number) => void; fail: (e: Error) => void; started: () => number } {
  let started = 0;
  let resolve: (value: number) => void = () => {};
  let reject: (error: Error) => void = () => {};
  return {
    read: () => {
      started += 1;
      return new Promise<number>((res, rej) => { resolve = res; reject = rej; });
    },
    settle: (value) => resolve(value),
    fail: (error) => reject(error),
    started: () => started,
  };
}

describe('a shared read', () => {
  it('starts one read for the calls that arrive while it runs', async () => {
    const m = manual();
    const shared = sharedRead(m.read);
    const a = shared();
    const b = shared();
    m.settle(7);
    expect(await Promise.all([a, b])).toEqual([7, 7]);
    expect(m.started()).toBe(1);
  });

  it('reads again once the read settled, and holds nothing', async () => {
    const m = manual();
    const shared = sharedRead(m.read);
    const first = shared();
    m.settle(1);
    await first;
    const second = shared();
    m.settle(2);
    expect(await second).toBe(2);
    expect(m.started()).toBe(2);
  });

  it('gives every caller waiting on it the failure, and does not hold it', async () => {
    const m = manual();
    const shared = sharedRead(m.read);
    const failed = shared();
    const alsoFailed = shared();
    expect(m.started()).toBe(1);
    m.fail(new Error('the ledger did not answer'));
    await expect(failed).rejects.toThrow('the ledger did not answer');
    await expect(alsoFailed).rejects.toThrow('the ledger did not answer');
    expect(m.started()).toBe(1);
    const next = shared();
    m.settle(3);
    expect(await next).toBe(3);
    expect(m.started()).toBe(2);
  });
});

describe('a read given up', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const noLate = (): void => { throw new Error('no late fault expected'); };

  it('fails at the limit when the read has not settled, and passes the arguments on', async () => {
    vi.useFakeTimers();
    const asked: string[] = [];
    const slow = givingUp(async (id: string) => {
      asked.push(id);
      return new Promise<number>(() => {});
    }, 20, 'readSlow', noLate);
    const answer = slow('run-1');
    vi.advanceTimersByTime(20);
    await expect(answer).rejects.toThrow('readSlow: gave up after 20 ms');
    expect(asked).toEqual(['run-1']);
  });

  it('answers with the read when it settles first, and clears its timer', async () => {
    vi.useFakeTimers();
    expect(await givingUp(async () => 5, 1_000, 'readFast', noLate)()).toBe(5);
    expect(vi.getTimerCount()).toBe(0);
    await expect(givingUp(async () => { throw new Error('refused'); }, 1_000, 'readFast', noLate)())
      .rejects.toThrow('refused');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears its timer when the read throws before it returns a promise', async () => {
    vi.useFakeTimers();
    const throwsAtOnce = givingUp((): Promise<number> => { throw new Error('at once'); }, 1_000, 'readSync', noLate);
    await expect(throwsAtOnce()).rejects.toThrow('at once');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('hands a failure that arrives after the limit to its late handler, and nothing else', async () => {
    vi.useFakeTimers();
    const m = manual();
    const late: [string, string][] = [];
    const read = givingUp(m.read, 20, 'readLate', (error, wait) => late.push([(error as Error).message, wait]));
    const answer = read();
    vi.advanceTimersByTime(20);
    // The page logs this message with its own tag, and the late fault names
    // the same wait, so the tag on the page leads to the reason.
    const gaveUp = await answer.then(() => '', (error: unknown) => (error as Error).message);
    const wait = /^readLate: gave up after 20 ms, wait ([0-9a-f]{8})$/.exec(gaveUp)?.[1];
    expect(wait).toBeDefined();
    m.fail(new Error('the pool gave no connection'));
    await vi.runAllTimersAsync();
    expect(late).toEqual([['the pool gave no connection', wait]]);
  });

  it('keeps a late handler that throws from ending the console', async () => {
    vi.useFakeTimers();
    const m = manual();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => { logged.push(String(line)); });
    try {
      const read = givingUp(m.read, 20, 'readLate', () => { throw new Error('the log line could not be written'); });
      const answer = read();
      vi.advanceTimersByTime(20);
      await expect(answer).rejects.toThrow('gave up');
      m.fail(new Error('the pool gave no connection'));
      await vi.runAllTimersAsync();
      vi.useRealTimers();
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      expect(logged.join('\n')).toContain('the log line could not be written');
      // The read's own failure is what the late handler was there to report.
      expect(logged.join('\n')).toContain('the pool gave no connection');
    } finally {
      spy.mockRestore();
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('names each wait it gives up on apart, so two pages on one read keep their own reasons', async () => {
    vi.useFakeTimers();
    const m = manual();
    const waits: string[] = [];
    const read = givingUp(sharedRead(m.read), 20, 'readShared', (_error, wait) => waits.push(wait));
    const first = read();
    const second = read();
    vi.advanceTimersByTime(20);
    const said = await Promise.all([first, second].map((page) =>
      page.then(() => '', (error: unknown) => (error as Error).message)));
    m.fail(new Error('the pool gave no connection'));
    await vi.runAllTimersAsync();
    expect(said.map((message) => /wait ([0-9a-f]{8})$/.exec(message)?.[1])).toEqual(waits);
    expect(new Set(waits).size).toBe(2);
  });

  it('shares one read between a caller that gave up and one that arrives after', async () => {
    // The order the console wires: the limit around the shared read.
    vi.useFakeTimers();
    const m = manual();
    const read = givingUp(sharedRead(m.read), 20, 'readShared', noLate);
    const first = read();
    vi.advanceTimersByTime(20);
    await expect(first).rejects.toThrow('gave up');
    const second = read();
    m.settle(9);
    expect(await second).toBe(9);
    expect(m.started()).toBe(1);
  });
});

describe('the knowledge reads as the console serves them', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shares the screen read, and gives each page up at the limit, logging a late fault', async () => {
    vi.useFakeTimers();
    const screen = manual();
    const gap = manual();
    const late: [string, string][] = [];
    const reads = knowledgeReads(
      { readKnowledge: screen.read, readCaseGap: () => gap.read() },
      20,
      (read, error, wait) => late.push([read, `${(error as Error).message} (${wait.length})`]),
    );
    const first = reads.readKnowledge();
    const second = reads.readKnowledge();
    expect(screen.started()).toBe(1);
    const casePage = reads.readCaseGap('run-1');
    vi.advanceTimersByTime(20);
    await expect(first).rejects.toThrow('readKnowledge: gave up after 20 ms');
    await expect(second).rejects.toThrow('readKnowledge: gave up after 20 ms');
    await expect(casePage).rejects.toThrow('readCaseGap: gave up after 20 ms');
    // A page after the give-up joins the read still running.
    const third = reads.readKnowledge();
    expect(screen.started()).toBe(1);
    screen.settle(4);
    expect(await third).toBe(4);
    gap.fail(new Error('the pool gave no connection'));
    await vi.runAllTimersAsync();
    expect(late).toEqual([['readCaseGap', 'the pool gave no connection (8)']]);
  });

  it('does not share the case read, which is one case each', async () => {
    const gap = manual();
    const reads = knowledgeReads({ readKnowledge: async () => 0, readCaseGap: () => gap.read() }, 1_000, () => {});
    void reads.readCaseGap('run-1');
    void reads.readCaseGap('run-2');
    expect(gap.started()).toBe(2);
    gap.settle(1);
  });
});
