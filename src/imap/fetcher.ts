/**
 * Real IMAP fetcher behind the poller's `ImapMessageFetcher` seam
 * (docs/v1-architecture.md, section 4.1 "Intake"), built on imapflow.
 *
 * One poll connects (or reuses) the client, locks INBOX, reads every UNSEEN
 * message as raw RFC 5322 text and returns it with the server UID as
 * `sourceId`. The adapter's threading hashes or references that id, so a
 * synthesized one would split threads; the UID is what the source guarantees.
 *
 * Marking \Seen is deliberately NOT part of fetching. The daemon calls
 * `markSeen` only after the intake handler resolved, so a crash before that
 * point leaves the mail unseen and redelivers (at-least-once).
 *
 * Reconnect handling: imapflow emits `error` and `close`. Both are logged;
 * a close schedules a reconnect with exponential backoff. A failed poll
 * drops the client so the next poll starts from a fresh connection and
 * never kills the daemon.
 */

import { ImapFlow } from 'imapflow';

import type { ImapInboundMessage } from '../ingress/imap-poller.js';
import { errorMessage } from '../errors.js';
import { logLine } from '../log/line.js';

/**
 * One structured line about the connection, written as the daemon's are.
 *
 * The error text is the server's or the network's, so it is a value from
 * outside, and `logLine` escapes it (issue #114).
 */
export type ImapFetcherLogEntry =
  | { readonly event: 'imap_client_error'; readonly at: string; readonly error: string }
  | { readonly event: 'imap_connection_closed'; readonly at: string }
  | { readonly event: 'imap_reconnect_failed'; readonly at: string; readonly error: string };

/** One JSON line per entry on stderr, the stream the fetcher always used. */
function defaultFetcherLog(entry: ImapFetcherLogEntry): void {
  console.error(logLine(entry));
}

/**
 * The subset of the imapflow client this module uses. Kept structural so
 * tests can inject a fake without opening sockets.
 */
export interface ImapClientLike {
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  connect(): Promise<void>;
  logout(): Promise<void>;
  /** Immediate teardown; imapflow emits `close` afterwards. */
  close(): void;
  getMailboxLock(path: string): Promise<{ release(): void }>;
  search(query: { seen?: boolean }, options?: { uid?: boolean }): Promise<number[] | false>;
  fetchAll(
    range: readonly number[],
    query: { uid?: boolean; source?: boolean },
    options?: { uid?: boolean },
  ): Promise<readonly { uid: number; source: string | Uint8Array }[]>;
  messageFlagsAdd(
    range: readonly number[],
    flags: string[],
    options?: { uid?: boolean },
  ): Promise<boolean>;
}

export type ImapClientFactory = () => ImapClientLike;

export interface ImapMailboxConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  secure?: boolean;
}

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

function decodeSource(source: string | Uint8Array): string {
  return typeof source === 'string' ? source : Buffer.from(source).toString('utf8');
}

/** Default factory: a real imapflow client. */
export const imapFlowFactory =
  (config: ImapMailboxConfig): ImapClientFactory =>
  () =>
    new ImapFlow({
      host: config.host,
      port: config.port,
      secure: config.secure ?? true,
      auth: { user: config.user, pass: config.pass },
      logger: false,
    }) as unknown as ImapClientLike;

export class ImapMailboxFetcher {
  private client: ImapClientLike | null = null;
  private connecting: Promise<void> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private backoffMs = INITIAL_BACKOFF_MS;
  private stopped = false;

  constructor(
    private readonly config: ImapMailboxConfig,
    private readonly createClient: ImapClientFactory,
    private readonly log: (entry: ImapFetcherLogEntry) => void = defaultFetcherLog,
  ) {}

  /**
   * Reads every UNSEEN message as RFC 5322 text, oldest UID first. Throws
   * on connection or command failure; the client is dropped either way, so
   * the next call reconnects from scratch.
   */
  async fetchUnseen(): Promise<readonly ImapInboundMessage[]> {
    await this.ensureConnected();
    const client = this.client as ImapClientLike;
    let lock: { release(): void };
    try {
      lock = await client.getMailboxLock('INBOX');
    } catch (error) {
      this.dropClient(client);
      throw error;
    }
    try {
      const uids = await client.search({ seen: false }, { uid: true });
      // imapflow resolves false when the connection dropped mid-command.
      if (uids === false) throw new Error('imap search failed: connection lost');
      if (uids.length === 0) return [];
      const ordered = [...uids].sort((a, b) => a - b);
      const messages = await client.fetchAll(ordered, { uid: true, source: true }, { uid: true });
      return messages.map((message) => ({
        sourceId: String(message.uid),
        rfc5322Text: decodeSource(message.source),
      }));
    } catch (error) {
      // Connection state after a failed command is unknown; reconnect next time.
      this.dropClient(client);
      throw error;
    } finally {
      lock.release();
    }
  }

  /**
   * Marks messages seen by UID. Called by the daemon only after the intake
   * handler resolved for those messages, so a crash before this point
   * redelivers them.
   */
  async markSeen(sourceIds: readonly string[]): Promise<void> {
    if (sourceIds.length === 0) return;
    await this.ensureConnected();
    const client = this.client as ImapClientLike;
    let lock: { release(): void };
    try {
      lock = await client.getMailboxLock('INBOX');
    } catch (error) {
      this.dropClient(client);
      throw error;
    }
    try {
      await client.messageFlagsAdd(
        sourceIds.map((id) => Number(id)),
        ['\\Seen'],
        { uid: true },
      );
    } catch (error) {
      this.dropClient(client);
      throw error;
    } finally {
      lock.release();
    }
  }

  /** Stops reconnection and tears down a live client. Safe to call twice. */
  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.client !== null) this.dropClient(this.client);
  }

  private async ensureConnected(): Promise<void> {
    if (this.client !== null) return;
    if (this.connecting !== null) return this.connecting;
    this.connecting = this.doConnect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    const client = this.createClient();
    client.on('error', (error) => {
      this.log({ event: 'imap_client_error', at: new Date().toISOString(), error: errorMessage(error) });
    });
    client.on('close', () => {
      if (this.client !== client) return;
      this.client = null;
      if (!this.stopped) {
        this.log({ event: 'imap_connection_closed', at: new Date().toISOString() });
        this.scheduleReconnect();
      }
    });
    try {
      await client.connect();
    } catch (error) {
      // Tear down the half-open socket. Its 'close' listener does not
      // schedule a reconnect here (this client was never installed as
      // this.client); the next poll tick retries via ensureConnected.
      try {
        client.close();
      } catch {
        /* already gone */
      }
      throw error;
    }
    this.client = client;
    this.backoffMs = INITIAL_BACKOFF_MS;
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureConnected().catch((error) => {
        this.log({
          event: 'imap_reconnect_failed',
          at: new Date().toISOString(),
          error: errorMessage(error),
        });
        this.scheduleReconnect();
      });
    }, delay);
  }

  private dropClient(client: ImapClientLike): void {
    if (this.client === client) this.client = null;
    try {
      client.close();
    } catch {
      /* already gone */
    }
  }
}
