// Unit tests for the real IMAP fetcher. The imapflow client is replaced by
// a fake speaking the same structural surface (see ImapClientLike), so the
// mapping, flag and reconnection behaviour is checked without sockets.
// Synthetic data only (DEC-18).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ImapMailboxFetcher } from './fetcher.js';
import type { ImapClientFactory, ImapClientLike } from './fetcher.js';

interface FakeMail {
  readonly source: string;
  seen: boolean;
}

/** Stateful mailbox + client pair covering the imapflow calls we use. */
class FakeServer {
  mails = new Map<number, FakeMail>();
  clients: FakeClient[] = [];
  /** When set, connect() rejects with this error once, then heals. */
  connectError: Error | null = null;
  /** When set, the next search resolves false (connection lost mid-command). */
  failSearchOnce = false;
  /** When set, the next lock acquisition throws once, then heals. */
  failLockOnce = false;

  makeClient(): FakeClient {
    const client = new FakeClient(this);
    this.clients.push(client);
    return client;
  }
}

class FakeClient implements ImapClientLike {
  private listeners = new Map<string, () => void>();
  fetchAllCalls = 0;
  flagsAdded: number[][] = [];
  closed = false;

  constructor(private readonly server: FakeServer) {}

  // The port overloads this: 'error' hands the listener an Error, 'close'
  // hands it nothing. The fake accepts either shape.
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  on(event: 'error' | 'close', listener: (...args: never[]) => void): unknown {
    this.listeners.set(event, listener as () => void);
    return this;
  }

  emit(event: 'error' | 'close'): void {
    this.listeners.get(event)?.();
  }

  async connect(): Promise<void> {
    if (this.server.connectError !== null) {
      const error = this.server.connectError;
      this.server.connectError = null;
      throw error;
    }
  }

  async logout(): Promise<void> {}

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  async getMailboxLock(_path: string): Promise<{ release(): void }> {
    if (this.closed || this.server.failLockOnce) {
      const failed = this.server.failLockOnce;
      this.server.failLockOnce = false;
      if (failed) throw new Error('mailbox unavailable');
      throw new Error('client closed');
    }
    return {
      release: () => {},
    };
  }

  async search(): Promise<number[] | false> {
    if (this.server.failSearchOnce) {
      this.server.failSearchOnce = false;
      return false;
    }
    return [...this.server.mails.entries()].filter(([, mail]) => !mail.seen).map(([uid]) => uid);
  }

  async fetchAll(
    range: readonly number[],
  ): Promise<readonly { uid: number; source: string | Uint8Array }[]> {
    this.fetchAllCalls++;
    return range.map((uid) => {
      const mail = this.server.mails.get(uid);
      if (mail === undefined) throw new Error(`no such message ${uid}`);
      return { uid, source: mail.source };
    });
  }

  async messageFlagsAdd(range: readonly number[], flags: string[]): Promise<boolean> {
    if (!flags.includes('\\Seen')) throw new Error('unexpected flag operation');
    this.flagsAdded.push([...range]);
    for (const uid of range) {
      const mail = this.server.mails.get(uid);
      if (mail !== undefined) mail.seen = true;
    }
    return true;
  }
}

function makeFetcher(server: FakeServer): ImapMailboxFetcher {
  const factory: ImapClientFactory = () => server.makeClient();
  return new ImapMailboxFetcher(
    { host: 'imap.example.test', port: 993, user: 'u', pass: 'p' },
    factory,
    () => {},
  );
}

describe('ImapMailboxFetcher', () => {
  let server: FakeServer;

  beforeEach(() => {
    server = new FakeServer();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns UNSEEN messages oldest UID first, UID as sourceId', async () => {
    server.mails.set(3, { source: 'From: c@x.test\n\nthird', seen: false });
    server.mails.set(1, { source: 'From: a@x.test\n\nfirst', seen: false });
    const fetcher = makeFetcher(server);

    const messages = await fetcher.fetchUnseen();

    expect(messages).toEqual([
      { sourceId: '1', rfc5322Text: 'From: a@x.test\n\nfirst' },
      { sourceId: '3', rfc5322Text: 'From: c@x.test\n\nthird' },
    ]);
  });

  it('returns an empty batch without fetching when nothing is unseen', async () => {
    const fetcher = makeFetcher(server);

    await expect(fetcher.fetchUnseen()).resolves.toEqual([]);
    expect(server.clients[0]?.fetchAllCalls).toBe(0);
  });

  it('markSeen adds \\Seen by UID so the next fetch skips the message', async () => {
    server.mails.set(1, { source: 'one', seen: false });
    server.mails.set(2, { source: 'two', seen: false });
    const fetcher = makeFetcher(server);

    await fetcher.markSeen(['1']);

    expect(server.mails.get(1)?.seen).toBe(true);
    expect(server.mails.get(2)?.seen).toBe(false);
    expect(server.clients[0]?.flagsAdded).toEqual([[1]]);
    await expect(fetcher.fetchUnseen()).resolves.toEqual([{ sourceId: '2', rfc5322Text: 'two' }]);
  });

  it('drops the client and reconnects when a command fails mid-poll', async () => {
    server.mails.set(1, { source: 'one', seen: false });
    const fetcher = makeFetcher(server);

    server.failSearchOnce = true;
    await expect(fetcher.fetchUnseen()).rejects.toThrow('connection lost');
    expect(server.clients).toHaveLength(1);
    expect(server.clients[0]?.closed).toBe(true);

    await expect(fetcher.fetchUnseen()).resolves.toHaveLength(1);
    expect(server.clients).toHaveLength(2);
  });

  it('drops the client and reconnects when the mailbox lock fails', async () => {
    server.mails.set(1, { source: 'one', seen: false });
    const fetcher = makeFetcher(server);

    server.failLockOnce = true;
    await expect(fetcher.fetchUnseen()).rejects.toThrow('mailbox unavailable');
    expect(server.clients[0]?.closed).toBe(true);

    await expect(fetcher.fetchUnseen()).resolves.toHaveLength(1);
    expect(server.clients).toHaveLength(2);
  });

  it('reconnects after an idle close', async () => {
    vi.useFakeTimers();
    const fetcher = makeFetcher(server);
    // Establish the initial connection through a real poll.
    server.mails.set(1, { source: 'one', seen: false });
    await fetcher.fetchUnseen();
    expect(server.clients).toHaveLength(1);

    // Server drops the idle connection.
    server.clients[0]!.emit('close');
    // Not yet: backoff has not elapsed.
    await vi.advanceTimersByTimeAsync(999);
    expect(server.clients).toHaveLength(1);
    // Reconnect attempt after INITIAL_BACKOFF_MS; success resets backoff.
    await vi.advanceTimersByTimeAsync(1);
    expect(server.clients).toHaveLength(2);
  });

  it('doubles the backoff while reconnect attempts keep failing', async () => {
    vi.useFakeTimers();
    const fetcher = makeFetcher(server);
    server.mails.set(1, { source: 'one', seen: false });
    await fetcher.fetchUnseen();

    server.clients[0]!.emit('close');
    server.connectError = new Error('connection refused');
    // First attempt at 1s fails.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(server.clients).toHaveLength(2);
    expect(server.clients[1]!.closed).toBe(true);
    // Second attempt waits the doubled delay: still nothing at +1999ms...
    await vi.advanceTimersByTimeAsync(1_999);
    expect(server.clients).toHaveLength(2);
    // ...then the server heals and the attempt at 2x succeeds.
    server.connectError = null;
    await vi.advanceTimersByTimeAsync(1);
    expect(server.clients).toHaveLength(3);
    expect(server.clients[2]!.closed).toBe(false);
  });

  it('stops scheduling reconnects after stop()', async () => {
    vi.useFakeTimers();
    const fetcher = makeFetcher(server);
    server.mails.set(1, { source: 'one', seen: false });
    await fetcher.fetchUnseen();

    fetcher.stop();
    server.clients[0]!.emit('close');
    await vi.advanceTimersByTimeAsync(60_000);

    expect(server.clients).toHaveLength(1);
  });
});
