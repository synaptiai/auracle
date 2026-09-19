// Whether the console reads a draft back before it approves, and how long it
// waits (issue #102, section 4.10).
//
// Pure cases. The adapter choice is injected, so nothing here builds a real
// adapter or reaches a helpdesk.
import { describe, expect, it, vi } from 'vitest';
import type { DraftReadBack, ReadBackAdapter } from 'auracle/ledger-read';

import {
  READ_BACK_GIVE_UP_MS, ReadBackFailed, boundedReadBack, consoleReadBack, readBackFor,
} from './read-back.js';
import { SHUTDOWN_GRACE_MS } from './shutdown.js';

const BOUND = { giveUpMs: 1_000, onLateFault: (): void => undefined };

const draft = (body: string): DraftReadBack => ({ readDraft: async () => ({ body }) });

/**
 * An adapter the selector returns: the read port, and the declaration beside
 * it. Every case here reads a draft, so no case declares a ledger reply.
 */
const chosen = (inner: DraftReadBack): ReadBackAdapter => ({
  ...inner,
  capabilities: {
    supportsIdempotencyKey: false,
    supportsReadBack: false,
    supportsDraftState: true,
    supportsStructuredFields: false,
    supportsThreading: true,
    supportsLedgerReply: false,
  },
});

describe('consoleReadBack', () => {
  // The reference adapter holds drafts in the memory of the process that
  // parked them. The console is another process, so every read would find
  // nothing and every approval would refuse as `draft_missing`.
  it('reads nothing back when no adapter is named, or the reference one is', () => {
    const choose = vi.fn();
    expect(consoleReadBack({}, choose, BOUND)).toBeNull();
    expect(consoleReadBack({ APPROVE_ADAPTER: 'helpdesk' }, choose, BOUND)).toBeNull();
    expect(choose).not.toHaveBeenCalled();
  });

  it('chooses the named adapter from the environment it is given', () => {
    const adapter = chosen(draft('Your refund is on its way.'));
    const env = { APPROVE_ADAPTER: 'freescout', FREESCOUT_BASE_URL: 'http://helpdesk.invalid' };
    const choose = vi.fn().mockReturnValue(adapter);
    const readBack = consoleReadBack(env, choose, BOUND);
    expect(choose).toHaveBeenCalledWith('freescout', env);
    expect(readBack?.name).toBe('freescout');
    // DEC-44: the declaration travels beside the port, so the console draws
    // its editor from the same adapter the approval will use.
    expect(readBack?.supportsLedgerReply).toBe(false);
  });

  // The adapter the console uses is the bounded one, never the bare adapter:
  // a helpdesk that never answers must not hold the approval open.
  it('bounds every read of the adapter it chooses', async () => {
    vi.useFakeTimers();
    try {
      const chosen = consoleReadBack(
        { APPROVE_ADAPTER: 'freescout' },
        () => ({ readDraft: () => new Promise(() => {}), capabilities: { supportsLedgerReply: false } } as never),
        { giveUpMs: 250, onLateFault: () => undefined },
      );
      const settled = chosen!.readDraft.readDraft('4:12').catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(250);
      expect(await settled).toBeInstanceOf(ReadBackFailed);
    } finally {
      vi.useRealTimers();
    }
  });

  // Refused where the console starts, not on the first approval. A console
  // that started and then failed its first approval would look healthy until
  // a person pressed the button.
  it('lets a refused configuration throw, so the console refuses to start', () => {
    const choose = (): ReadBackAdapter => {
      throw new Error('FREESCOUT_BASE_URL is required for the FreeScout adapter');
    };
    expect(() => consoleReadBack({ APPROVE_ADAPTER: 'freescout' }, choose, BOUND)).toThrow(/FREESCOUT_BASE_URL/);
  });

  // An empty value is a name, and it is not one of the three. Reading it as
  // unset would hide a variable an operator meant to fill.
  it('passes an empty name on to be refused rather than reading it as unset', () => {
    const choose = vi.fn(() => {
      throw new Error("unknown APPROVE_ADAPTER ''");
    });
    expect(() => consoleReadBack({ APPROVE_ADAPTER: '' }, choose, BOUND)).toThrow("unknown APPROVE_ADAPTER ''");
  });
});

describe('boundedReadBack', () => {
  it('returns what the adapter read', async () => {
    const bounded = boundedReadBack(draft('Your refund is on its way.'), BOUND);
    await expect(bounded.readDraft('4:12')).resolves.toEqual({ body: 'Your refund is on its way.' });
  });

  // No draft is an answer, and `approveRun` turns it into `draft_missing`.
  // It is not a failure to read.
  it('passes an absent draft through as an absence', async () => {
    const bounded = boundedReadBack({ readDraft: async () => null }, BOUND);
    await expect(bounded.readDraft('4:12')).resolves.toBeNull();
  });

  // A read that failed says nothing about the draft. Calling it missing
  // would tell the operator a person deleted something nobody touched.
  it('names a failed read as a failure, never as a missing draft', async () => {
    const bounded = boundedReadBack({
      readDraft: async () => {
        throw new Error('FreeScout answered 502');
      },
    }, BOUND);
    const failure = await bounded.readDraft('4:12').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ReadBackFailed);
    expect((failure as ReadBackFailed).message).toContain('FreeScout answered 502');
  });

  it('names a synchronous throw as a failure too', async () => {
    const bounded = boundedReadBack({
      readDraft: () => {
        throw new Error('draftExternalId is empty');
      },
    }, BOUND);
    await expect(bounded.readDraft('')).rejects.toBeInstanceOf(ReadBackFailed);
  });

  // The page waits on this read. An adapter that never answers would hold the
  // approval request, and the operator, for as long as the socket lives.
  it('gives up on a read that does not answer within its bound', async () => {
    vi.useFakeTimers();
    try {
      const bounded = boundedReadBack({ readDraft: () => new Promise(() => {}) }, { ...BOUND, giveUpMs: 250 });
      const settled = bounded.readDraft('4:12').catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(249);
      let done = false;
      void settled.then(() => { done = true; });
      await Promise.resolve();
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const failure = await settled;
      expect(failure).toBeInstanceOf(ReadBackFailed);
      expect((failure as ReadBackFailed).message).toContain('250');
    } finally {
      vi.useRealTimers();
    }
  });

  // A read that answers clears its timer, so a settled approval leaves
  // nothing behind to fire.
  it('clears its timer once the read answers', async () => {
    vi.useFakeTimers();
    try {
      const bounded = boundedReadBack(draft('Hello.'), { ...BOUND, giveUpMs: 250 });
      await bounded.readDraft('4:12');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // The page gave up, so the adapter is told to stop: a connection it holds
  // closes then, rather than at its own fifteen-second bound.
  it('aborts the adapter read when it gives up', async () => {
    vi.useFakeTimers();
    try {
      let received: AbortSignal | undefined;
      const bounded = boundedReadBack(
        { readDraft: (_id, options) => { received = options?.signal; return new Promise(() => {}); } },
        { ...BOUND, giveUpMs: 250 },
      );
      const settled = bounded.readDraft('4:12').catch((error: unknown) => error);
      expect(received?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(250);
      await settled;
      expect(received?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // A caller that stops waiting on its own, before the bound, is heard too:
  // its abort reaches the adapter.
  it('passes a caller abort through to the adapter', async () => {
    let received: AbortSignal | undefined;
    const bounded = boundedReadBack(
      { readDraft: (_id, options) => { received = options?.signal; return new Promise(() => {}); } },
      { ...BOUND, giveUpMs: 10_000 },
    );
    const caller = new AbortController();
    const settled = bounded.readDraft('4:12', { signal: caller.signal }).catch((error: unknown) => error);
    caller.abort(new Error('the client hung up'));
    const failure = await settled;
    expect(received?.aborted).toBe(true);
    expect(failure).toBeInstanceOf(ReadBackFailed);
    expect((failure as ReadBackFailed).message).toContain('the client hung up');
  });

  // The failure names the draft it was reading, so its log line can be
  // matched with a fault that arrives later.
  it('names the draft a failed read was for', async () => {
    const bounded = boundedReadBack({ readDraft: async () => { throw new Error('refused'); } }, BOUND);
    const failure = await bounded.readDraft('4:12').catch((error: unknown) => error);
    expect((failure as ReadBackFailed).draftExternalId).toBe('4:12');
  });

  // A fault that arrives after the page gave up is still a fault. It reaches
  // the log, and it does not settle the read a second time.
  it('hands a fault that arrives after the bound to the log', async () => {
    vi.useFakeTimers();
    try {
      const late: string[] = [];
      let fail: (error: Error) => void = () => undefined;
      const bounded = boundedReadBack(
        { readDraft: () => new Promise((_, reject) => { fail = reject; }) },
        { giveUpMs: 250, onLateFault: (fault, draftExternalId) => { late.push(`${fault} · ${draftExternalId}`); } },
      );
      const settled = bounded.readDraft('4:12').catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(250);
      expect(((await settled) as Error).message).toContain('250');
      fail(new Error('FreeScout answered 502'));
      await vi.advanceTimersByTimeAsync(0);
      expect(late).toEqual(['FreeScout answered 502 · 4:12']);
    } finally {
      vi.useRealTimers();
    }
  });

  // A timer that outlives the request must not keep a stopping console alive.
  it('lets the process exit while a read waits', async () => {
    vi.useFakeTimers();
    try {
      const unref = vi.spyOn(globalThis, 'setTimeout');
      const bounded = boundedReadBack({ readDraft: () => new Promise(() => {}) }, { ...BOUND, giveUpMs: 250 });
      void bounded.readDraft('4:12').catch(() => undefined);
      const timer = unref.mock.results.at(-1)?.value as { hasRef?: () => boolean };
      // Asserted on the method itself, so a timer shape without one fails
      // rather than reading as unref'd.
      expect(typeof timer.hasRef).toBe('function');
      expect(timer.hasRef!()).toBe(false);
      await vi.advanceTimersByTimeAsync(250);
    } finally {
      vi.useRealTimers();
    }
  });

  // The read gives up inside the shutdown grace, which leaves the grace's
  // remainder for the transaction after it.
  it('gives up four seconds in, inside the shutdown grace', () => {
    expect(READ_BACK_GIVE_UP_MS).toBe(4_000);
    expect(READ_BACK_GIVE_UP_MS).toBeLessThan(SHUTDOWN_GRACE_MS);
  });
});

describe('readBackFor', () => {
  // What the console's entry point builds. Its late faults reach the log with
  // the draft they concern, and its reads are bounded at the console's limit.
  it('logs a late fault with its draft, under the console bound', async () => {
    vi.useFakeTimers();
    try {
      const records: Record<string, unknown>[] = [];
      let fail: (error: Error) => void = () => undefined;
      const chosen = readBackFor(
        { APPROVE_ADAPTER: 'freescout' },
        () => ({ readDraft: () => new Promise((_, reject) => { fail = reject; }), capabilities: { supportsLedgerReply: false } } as never),
        (record) => { records.push(record); },
      );
      const settled = chosen!.readDraft.readDraft('4:12').catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(READ_BACK_GIVE_UP_MS);
      expect(await settled).toBeInstanceOf(ReadBackFailed);
      fail(new Error('FreeScout answered 502'));
      await vi.advanceTimersByTimeAsync(0);
      expect(records).toEqual([
        { event: 'console_read_back_late_fault', draftExternalId: '4:12', fault: 'FreeScout answered 502' },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads nothing back when the environment names no adapter', () => {
    expect(readBackFor({}, () => ({ readDraft: async () => null, capabilities: { supportsLedgerReply: false } } as never), () => undefined)).toBeNull();
  });
});
