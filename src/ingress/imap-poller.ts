/**
 * IMAP poller shell (docs/v1-architecture.md, sections 4.1 and 1.1
 * "Intake"). Reference driver: the IMAP protocol itself is behind the
 * injected `fetchMessages` function, so a real deployment plugs its client
 * in without this file changing.
 *
 * One fetched message is one RFC 5322 text plus the source identifier the
 * IMAP server guarantees for it (the UID). The poller runs each message
 * through `ImapSmtpAdapter.normalize` and hands the resulting Ticket+Message
 * to the intake seam. One malformed message fails alone and is reported in
 * `PollResult.failures`; the rest of the batch still reaches the seam.
 *
 * DEC-24 / NormalizedEvent.eventId rules: inbound mail carries no provider-
 * native dedupe id, so the normalized event never has an `eventId`. The
 * poller invents none. `sourceId` comes only from the fetcher; the poller
 * never synthesizes one, because the adapter's ticket-id fallback hashes it
 * and a synthesized id would split threads.
 */

import { ImapSmtpAdapter } from '../adapters/imap-smtp.js';
import type { IntakeHandler } from './types.js';

/** One message as an IMAP client would hand it over. */
export interface ImapInboundMessage {
  /** Source identifier guaranteed by the IMAP server (typically the UID). */
  readonly sourceId: string;
  /** The raw RFC 5322 message text. */
  readonly rfc5322Text: string;
}

/**
 * Fetches the current batch of unread messages. A real deployment wraps
 * its IMAP client here and marks messages seen after the intake handler
 * resolved, so a crash before that point redelivers.
 */
export type ImapMessageFetcher = () => Promise<readonly ImapInboundMessage[]>;

export interface PollResult {
  /** Messages that reached the intake seam normalized. */
  readonly normalizedCount: number;
  /** Messages that failed normalization or intake, with the reason. */
  readonly failures: readonly { sourceId: string; error: unknown }[];
}

export interface ImapPollerDeps {
  fetchMessages: ImapMessageFetcher;
  /** The intake seam. */
  onEvent: IntakeHandler;
  /** Injected for tests; defaults to the reference adapter. */
  adapter?: ImapSmtpAdapter;
  /** Tick interval for start(). Default: 60_000 ms. */
  intervalMs?: number;
  /** Receives errors thrown by fetchMessages during a timed tick. */
  onError: (error: unknown) => void;
}

export class ImapPoller {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: ImapPollerDeps) {}

  /**
   * Polls once. Fetch errors propagate to the caller; per-message failures
   * are isolated into `PollResult.failures`. Pass a pre-fetched batch to
   * feed the shell exactly one fetch (the IMAP daemon does this, so its
   * mark-seen bookkeeping and the intake batch cannot diverge); omit it to
   * fetch through the injected seam as before.
   */
  async pollOnce(messages?: readonly ImapInboundMessage[]): Promise<PollResult> {
    const batch = messages ?? (await this.deps.fetchMessages());
    let normalizedCount = 0;
    const failures: { sourceId: string; error: unknown }[] = [];
    for (const message of batch) {
      try {
        const event = (this.deps.adapter ?? new ImapSmtpAdapter()).normalize({
          sourceId: message.sourceId,
          raw: message.rfc5322Text,
        });
        await this.deps.onEvent(event);
        normalizedCount++;
      } catch (error) {
        failures.push({ sourceId: message.sourceId, error });
      }
    }
    return { normalizedCount, failures };
  }

  /** Starts polling on the tick interval. Idempotent while running. */
  start(): void {
    if (this.timer !== null) return;
    const intervalMs = this.deps.intervalMs ?? 60_000;
    this.timer = setInterval(() => {
      this.pollOnce().catch(this.deps.onError);
    }, intervalMs);
  }

  /** Stops polling. Pending timers are cleared; in-flight polls finish. */
  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
