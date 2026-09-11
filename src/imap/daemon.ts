/**
 * IMAP daemon loop (section 4.1 "Intake"). Turns one poll of the mailbox
 * into a long-lived process: fetch UNSEEN mail, run it through the poller
 * shell (`ImapPoller.pollOnce`), then mark \Seen only for messages whose
 * intake resolved.
 *
 * Guarantees the entrypoint relies on:
 *
 * - At-least-once delivery. A crash anywhere before `markSeen` leaves the
 *   mail unseen, so the next poll redelivers it. Intake must stay
 *   idempotent downstream (DEC-24 keeps inbound events free of invented
 *   dedupe ids; the ledger edge owns idempotency).
 * - Per-message isolation. One message that fails normalization or intake
 *   lands in `PollResult.failures` and is NOT marked seen; the rest of the
 *   batch still reaches intake.
 * - Poll-level isolation. A fetch or mark failure ends only this pass; the
 *   next interval tries again with a fresh connection.
 * - Graceful shutdown. `stop` ends the loop, lets an in-flight poll finish,
 *   and resolves once no further work starts.
 */

import { ImapPoller } from '../ingress/imap-poller.js';
import type { IntakeHandler } from '../ingress/types.js';

import type { ImapMailboxFetcher } from './fetcher.js';
import { errorMessage } from '../errors.js';

/** One structured log line, emitted as a single JSON object. */
export type ImapDaemonLogEntry =
  | { readonly event: 'daemon_started'; readonly at: string; readonly intervalMs: number }
  | { readonly event: 'mail_fetched'; readonly at: string; readonly count: number }
  | { readonly event: 'mail_intaked'; readonly at: string; readonly count: number }
  | {
      readonly event: 'message_failed';
      readonly at: string;
      readonly sourceId: string;
      readonly error: string;
    }
  | { readonly event: 'mark_seen_failed'; readonly at: string; readonly error: string }
  | { readonly event: 'poll_failed'; readonly at: string; readonly error: string }
  | { readonly event: 'daemon_stopped'; readonly at: string };

export interface ImapDaemonOptions {
  /** The real IMAP fetcher (or a fake in tests). */
  readonly fetcher: Pick<ImapMailboxFetcher, 'fetchUnseen' | 'markSeen'>;
  /** The intake seam each normalized event is handed to. */
  readonly onEvent: IntakeHandler;
  /** Milliseconds between polls. Polls never overlap. */
  readonly intervalMs: number;
  /** Defaults to one JSON line per entry on stdout. */
  readonly logger?: (entry: ImapDaemonLogEntry) => void;
}

export interface ImapDaemon {
  /**
   * Stops the loop and waits for the in-flight poll to drain. Resolves when
   * no further IMAP work will start; the caller closes connections.
   */
  stop(): Promise<void>;
}

/** Drives exactly one fetch -> poll -> markSeen pass. Exported for tests. */
export async function pollCycle(options: {
  fetcher: Pick<ImapMailboxFetcher, 'fetchUnseen' | 'markSeen'>;
  poller: ImapPoller;
  log: (entry: ImapDaemonLogEntry) => void;
}): Promise<void> {
  const { fetcher, poller, log } = options;
  const messages = await fetcher.fetchUnseen();
  if (messages.length === 0) return;
  log({ event: 'mail_fetched', at: new Date().toISOString(), count: messages.length });

  // The pre-fetched batch feeds the shell directly: one SEARCH+fetchAll per
  // poll, and the messages marked seen are exactly the ones intaked here.
  const result = await poller.pollOnce(messages);
  const failedIds = new Set(result.failures.map((failure) => failure.sourceId));
  for (const failure of result.failures) {
    log({
      event: 'message_failed',
      at: new Date().toISOString(),
      sourceId: failure.sourceId,
      error: errorMessage(failure.error),
    });
  }
  if (result.normalizedCount > 0) {
    log({ event: 'mail_intaked', at: new Date().toISOString(), count: result.normalizedCount });
  }

  // Only messages whose intake resolved lose their UNSEEN flag. Anything
  // else stays unseen and redelivers on the next poll.
  const seenIds = messages.map((m) => m.sourceId).filter((id) => !failedIds.has(id));
  if (seenIds.length === 0) return;
  try {
    await fetcher.markSeen(seenIds);
  } catch (error) {
    log({ event: 'mark_seen_failed', at: new Date().toISOString(), error: errorMessage(error) });
  }
}

export function startImapDaemon(options: ImapDaemonOptions): ImapDaemon {
  const log =
    options.logger ??
    ((entry: ImapDaemonLogEntry): void => {
      console.log(JSON.stringify(entry));
    });

  const poller = new ImapPoller({
    fetchMessages: () => options.fetcher.fetchUnseen(),
    onEvent: options.onEvent,
    onError: () => {}, // pollOnce errors surface inside pollCycle's own try/catch
  });

  let stopped = false;
  let polling = false;
  let drained: (() => void) | null = null;
  let wakeTimer: (() => void) | null = null;

  async function loop(): Promise<void> {
    while (!stopped) {
      polling = true;
      try {
        await pollCycle({ fetcher: options.fetcher, poller, log });
      } catch (error) {
        log({ event: 'poll_failed', at: new Date().toISOString(), error: errorMessage(error) });
      } finally {
        polling = false;
        drained?.();
        drained = null;
      }
      if (stopped) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          wakeTimer = null;
          resolve();
        }, options.intervalMs);
        wakeTimer = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }

  log({ event: 'daemon_started', at: new Date().toISOString(), intervalMs: options.intervalMs });
  void loop();

  return {
    stop(): Promise<void> {
      stopped = true;
      wakeTimer?.();
      if (!polling) {
        log({ event: 'daemon_stopped', at: new Date().toISOString() });
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        drained = () => {
          log({ event: 'daemon_stopped', at: new Date().toISOString() });
          resolve();
        };
      });
    },
  };
}
