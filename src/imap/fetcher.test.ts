// Unit tests for the real IMAP fetcher. The imapflow client is replaced by
// a fake speaking the same structural surface (see ImapClientLike), so the
// mapping, flag and reconnection behavior is checked without sockets.
// Synthetic data only (DEC-18).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { expectEscaped, HOSTILE } from '../test-support/raw-log.js';

import { ImapMailboxFetcher } from './fetcher.js';
import type { ImapClientFactory, ImapClientLike } from './fetcher.js';

interface FakeMail {
  /** Undefined models a FETCH that answered the UID without its body. */
  readonly source: string | undefined;
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
  /** When set, the next STORE answers false, as imapflow does for a refusal. */
  refuseFlagsOnce = false;
  /** When set, the FETCH answers this UID's message with no UID, as imapflow does for an unusable one. */
  unnumberUid: number | null = null;
  /** Rows the FETCH answers ahead of the requested ones, as unsolicited updates. */
  unsolicited: { uid?: number; source?: string }[] = [];
  /** When set, the FETCH loses the mailbox and answers nothing, as imapflow does. */
  loseMailboxOnFetch = false;
  /** When set, the STORE loses the mailbox and answers false, as a dropped connection does. */
  loseMailboxOnStore = false;
  /** When set, the next search resolves undefined (no mailbox selected). */
  unselectSearchOnce = false;
  /** When set, the next lock acquisition throws once, then heals. */
  failLockOnce = false;

  makeClient(): FakeClient {
    const client = new FakeClient(this);
    this.clients.push(client);
    return client;
  }
}

class FakeClient implements ImapClientLike {
  private listeners = new Map<string, (error?: Error) => void>();
  fetchAllCalls = 0;
  flagsAdded: number[][] = [];
  closed = false;
  mailbox: object | false = { path: 'INBOX' };

  constructor(private readonly server: FakeServer) {}

  // The port overloads this: 'error' hands the listener an Error, 'close'
  // hands it nothing. The fake accepts either shape.
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  on(event: 'error' | 'close', listener: (...args: never[]) => void): unknown {
    this.listeners.set(event, listener as (error?: Error) => void);
    return this;
  }

  emit(event: 'error' | 'close', error?: Error): void {
    this.listeners.get(event)?.(error);
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

  async search(): Promise<number[] | false | undefined> {
    if (this.server.failSearchOnce) {
      this.server.failSearchOnce = false;
      return false;
    }
    if (this.server.unselectSearchOnce) {
      this.server.unselectSearchOnce = false;
      return undefined;
    }
    return [...this.server.mails.entries()].filter(([, mail]) => !mail.seen).map(([uid]) => uid);
  }

  async fetchAll(
    range: number[],
  ): Promise<readonly { uid?: number | undefined; source?: string | Uint8Array | undefined }[]> {
    this.fetchAllCalls++;
    if (this.server.loseMailboxOnFetch) {
      this.mailbox = false;
      return [];
    }
    const rows = range.map((uid) => {
      const mail = this.server.mails.get(uid);
      if (mail === undefined) throw new Error(`no such message ${uid}`);
      return { uid: uid === this.server.unnumberUid ? undefined : uid, source: mail.source };
    });
    // Unsolicited rows come first, as a server's flag updates can.
    return [...this.server.unsolicited, ...rows];
  }

  async messageFlagsAdd(range: number[], flags: string[]): Promise<boolean> {
    if (!flags.includes('\\Seen')) throw new Error('unexpected flag operation');
    if (this.server.refuseFlagsOnce) {
      this.server.refuseFlagsOnce = false;
      return false;
    }
    if (this.server.loseMailboxOnStore) {
      this.mailbox = false;
      return false;
    }
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

  it('drops the client and reconnects when the search ran with no mailbox selected', async () => {
    server.mails.set(1, { source: 'one', seen: false });
    const fetcher = makeFetcher(server);

    server.unselectSearchOnce = true;
    await expect(fetcher.fetchUnseen()).rejects.toThrow('no mailbox selected');
    expect(server.clients[0]?.closed).toBe(true);

    await expect(fetcher.fetchUnseen()).resolves.toHaveLength(1);
    expect(server.clients).toHaveLength(2);
  });

  it('skips a message whose body the FETCH left out, names it, and leaves it unseen', async () => {
    // imapflow types the source as optional. Throwing on it would fail every
    // poll, because the same message comes back unseen each time, and no
    // other mail would arrive behind it.
    server.mails.set(1, { source: 'one', seen: false });
    server.mails.set(2, { source: undefined, seen: false });
    server.mails.set(3, { source: 'three', seen: false });
    const entries: unknown[] = [];
    const fetcher = new ImapMailboxFetcher(
      { host: 'imap.example.test', port: 993, user: 'u', pass: 'p' },
      () => server.makeClient(),
      (entry) => entries.push(entry),
    );

    await expect(fetcher.fetchUnseen()).resolves.toEqual([
      { sourceId: '1', rfc5322Text: 'one' },
      { sourceId: '3', rfc5322Text: 'three' },
    ]);
    expect(entries).toEqual([
      { event: 'imap_message_without_source', at: expect.any(String), uid: 2 },
    ]);
    expect(server.mails.get(2)?.seen).toBe(false);
    // A skip is not a fault, so the connection stays.
    expect(server.clients).toHaveLength(1);
    expect(server.clients[0]?.closed).toBe(false);
  });

  it('reads each requested message from its own row, past unsolicited and unusable ones', async () => {
    // A flag update for another message, a bodiless row and a row with no
    // usable UID name no message that was asked for, so none is logged.
    server.mails.set(1, { source: 'one', seen: false });
    server.mails.set(2, { source: 'two', seen: false });
    server.unsolicited = [{ uid: 9 }, { uid: 1 }, { source: 'stray' }];
    server.unnumberUid = 2;
    const entries: unknown[] = [];
    const fetcher = new ImapMailboxFetcher(
      { host: 'imap.example.test', port: 993, user: 'u', pass: 'p' },
      () => server.makeClient(),
      (entry) => entries.push(entry),
    );

    // 2 came back without a usable UID, so it is a requested message with no
    // body: skipped, named, and left unseen.
    await expect(fetcher.fetchUnseen()).resolves.toEqual([{ sourceId: '1', rfc5322Text: 'one' }]);
    expect(entries).toEqual([
      { event: 'imap_message_without_source', at: expect.any(String), uid: 2 },
    ]);
  });

  it('fails the poll when the FETCH lost the mailbox, rather than skip every message', async () => {
    server.mails.set(1, { source: 'one', seen: false });
    server.loseMailboxOnFetch = true;
    const fetcher = makeFetcher(server);

    await expect(fetcher.fetchUnseen()).rejects.toThrow(/no mailbox selected/);
    expect(server.clients[0]?.closed).toBe(true);
    expect(server.mails.get(1)?.seen).toBe(false);
  });

  it('fails the mark when the server refuses the STORE, so the daemon logs it', async () => {
    // imapflow answers false and does not throw. Read as success, the message
    // stays unseen, and every poll queues it and runs the pipeline again.
    server.mails.set(1, { source: 'one', seen: false });
    const fetcher = makeFetcher(server);
    await fetcher.fetchUnseen();

    server.refuseFlagsOnce = true;
    await expect(fetcher.markSeen(['1'])).rejects.toThrow(/refused the STORE/);
    expect(server.clients[0]?.closed).toBe(true);
    expect(server.mails.get(1)?.seen).toBe(false);

    // The next mark reconnects and lands.
    await fetcher.markSeen(['1']);
    expect(server.clients).toHaveLength(2);
    expect(server.mails.get(1)?.seen).toBe(true);
  });

  it('names a STORE that lost the mailbox apart from one the server refused', async () => {
    server.mails.set(1, { source: 'one', seen: false });
    const fetcher = makeFetcher(server);
    await fetcher.fetchUnseen();

    server.loseMailboxOnStore = true;
    await expect(fetcher.markSeen(['1'])).rejects.toThrow(/lost its mailbox during the STORE/);
    expect(server.clients[0]?.closed).toBe(true);
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

  // The client's error text is the server's or the network's, and the fetcher's
  // own default sink writes it. It was a prose line with the text pasted in, so
  // nothing escaped it.
  it('writes the client error as an escaped JSON line on its default sink', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    try {
      const fetcher = new ImapMailboxFetcher(
        { host: 'imap.example.test', port: 993, user: 'u', pass: 'p' },
        () => server.makeClient(),
      );
      await fetcher.fetchUnseen();
      server.clients[0]!.emit('error', new Error(`BAD ${HOSTILE}`));
      fetcher.stop();
    } finally {
      spy.mockRestore();
    }
    const carrier = expectEscaped(lines, HOSTILE);
    expect(carrier['event']).toBe('imap_client_error');
  });
});
