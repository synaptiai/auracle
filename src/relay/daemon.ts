/**
 * Relay daemon loop (section 4.4). Turns the one-shot `relayPending` scan
 * into a long-lived process that scans the pending outbox on an interval.
 *
 * Guarantees the entrypoint relies on:
 *
 * - Per-record isolation. A record whose relay throws (a malformed
 *   payload, a ledger error) is logged and skipped; the rest of the scan
 *   continues and the record stays pending for a later scan.
 * - Scan-level isolation. A failure before any record is read (the ledger
 *   being unreachable) ends only that scan; the next interval retries.
 * - Graceful shutdown. `stop` ends the loop, lets an in-flight record
 *   reach its outcome, and resolves once no further relay work starts.
 *
 * Adapter selection comes from configuration (see main.ts). The delivery
 * rule never does: `relayOne` reads it from each record (DEC-29).
 */
import type { Pool } from 'pg';

import type { EgressAdapter } from '../adapters/types.js';
import type { RelayResult } from './relay.js';
import { pendingRows, relayOne } from './relay.js';
import { errorMessage } from '../errors.js';
import { logLine } from '../log/line.js';

/** One structured log line, emitted as a single JSON object. */
export type RelayLogEntry =
  | {
      readonly event: 'daemon_started';
      readonly at: string;
      readonly adapter: string;
      readonly intervalMs: number;
    }
  | {
      readonly event: 'record_relayed';
      readonly at: string;
      readonly idemKey: string;
      readonly outcome: RelayResult['outcome'];
    }
  | { readonly event: 'record_failed'; readonly at: string; readonly idemKey: string; readonly error: string }
  | { readonly event: 'scan_failed'; readonly at: string; readonly error: string }
  | { readonly event: 'daemon_stopped'; readonly at: string };

export interface RelayDaemonOptions {
  readonly pool: Pool;
  readonly adapter: EgressAdapter;
  /** Milliseconds between scans. Scans never overlap. */
  readonly intervalMs: number;
  /** Defaults to one JSON line per entry on stdout. */
  readonly logger?: (entry: RelayLogEntry) => void;
}

export interface RelayDaemon {
  /**
   * Stops the loop and waits for the in-flight scan to drain. Resolves
   * when no further relay work will start; the caller closes the pool.
   */
  stop(): Promise<void>;
}

export function startRelayDaemon(options: RelayDaemonOptions): RelayDaemon {
  const { pool, adapter, intervalMs } = options;
  const log =
    options.logger ??
    ((entry: RelayLogEntry): void => {
      console.log(logLine(entry));
    });

  let stopped = false;
  let scanning = false;
  let drained: (() => void) | null = null;
  // Wakes an in-flight inter-scan delay so `stop` never leaves a timer
  // behind holding the process open.
  let wakeTimer: (() => void) | null = null;

  const now = (): string => new Date().toISOString();

  async function scanOnce(): Promise<void> {
    for (const row of await pendingRows(pool)) {
      if (stopped) break;
      try {
        const result = await relayOne(pool, adapter, row);
        log({
          event: 'record_relayed',
          at: now(),
          idemKey: result.idemKey,
          outcome: result.outcome,
          // The cause, when there was one. Without it a rotated SMTP
          // credential reads as a steady stream of left_pending_retry and
          // nothing names the authentication failure.
          ...(result.sendError === undefined ? {} : { sendError: result.sendError }),
          ...(result.readBackError === undefined ? {} : { readBackError: result.readBackError }),
        });
      } catch (error) {
        // One bad record must not stop the scan. It stays pending, so a
        // later scan picks it up once whatever made it throw is fixed.
        log({
          event: 'record_failed',
          at: now(),
          idemKey: row.idem_key,
          error: errorMessage(error),
        });
      }
    }
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      scanning = true;
      try {
        await scanOnce();
      } catch (error) {
        // Scan-level failure: this pass could not even read the pending
        // rows. End this pass only; the next interval tries again.
        log({ event: 'scan_failed', at: now(), error: errorMessage(error) });
      } finally {
        scanning = false;
        drained?.();
        drained = null;
      }
      if (stopped) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          wakeTimer = null;
          resolve();
        }, intervalMs);
        wakeTimer = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }

  log({ event: 'daemon_started', at: now(), adapter: adapter.name, intervalMs });
  void loop();

  return {
    stop(): Promise<void> {
      stopped = true;
      wakeTimer?.();
      if (!scanning) {
        log({ event: 'daemon_stopped', at: now() });
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        drained = () => {
          log({ event: 'daemon_stopped', at: now() });
          resolve();
        };
      });
    },
  };
}
