// Whether the console reads a parked draft back before it approves.
//
// Section 4.10 measures how far a person edited a draft before it was sent.
// The approval can only measure that by reading the draft back from the
// system that holds it. The command line does so under `--read-back`; the
// console does so whenever `APPROVE_ADAPTER` names a real adapter.
//
// Two rules keep the read honest. A read that fails is a failure, never a
// missing draft: `approveRun` refuses a missing draft as `draft_missing`, and
// that sentence tells an operator someone removed it. And the read is bounded,
// because the approval request waits on it.
import type { DraftReadBack, ReadBackAdapter } from 'auracle/ledger-read';
import { PermanentEgressError } from 'auracle/ledger-read';

/**
 * How long one approval waits for the helpdesk to answer a read-back.
 *
 * Inside the console's shutdown grace. That keeps the read within the grace
 * and leaves its remainder for the approval's own statements. A transaction
 * that asks for a connection after the pool closed is refused and commits
 * nothing. When the read gives up it aborts the adapter, which closes the
 * connection it holds.
 */
export const READ_BACK_GIVE_UP_MS = 4_000;

/** The bound a read-back runs under, and where a late fault goes. */
export interface ReadBackBound {
  readonly giveUpMs: number;
  /** A fault the adapter raised after the page had already given up, and its draft. */
  readonly onLateFault: (fault: string, draftExternalId: string) => void;
}

/** A read-back that failed or did not answer. Nothing was approved. */
export class ReadBackFailed extends Error {
  /** The draft the read was for, when the failure knows it. */
  readonly draftExternalId: string | null;
  /**
   * Whether a retry can clear the fault (DEC-30).
   *
   * The adapter's own class decides it, and the page reads it: a connection
   * fault is worth another press, and a parked thread the helpdesk no longer
   * holds as an internal note is not — the same press refuses every time
   * until the processes read one configuration again.
   */
  readonly permanent: boolean;

  constructor(
    detail: string,
    options?: {
      readonly cause?: unknown;
      readonly draftExternalId?: string;
      readonly permanent?: boolean;
    },
  ) {
    super(`read-back failed: ${detail}`, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ReadBackFailed';
    this.draftExternalId = options?.draftExternalId ?? null;
    this.permanent = options?.permanent ?? options?.cause instanceof PermanentEgressError;
  }
}

/** The adapter the console reads drafts back from, its name, and what it declares. */
export interface ConsoleReadBack {
  readonly name: string;
  readonly readDraft: DraftReadBack;
  /**
   * DEC-44: the adapter's own declaration that its helpdesk cannot send the
   * copy it parks, so the ledger holds the reply.
   *
   * The console reads it to decide whether a reviewer edits the reply here.
   * It comes from the adapter the approval will use, and not from a second
   * reading of the environment: the two must agree about the same instance.
   */
  readonly supportsLedgerReply: boolean;
}

/**
 * The read-back the environment names, or null when it names none.
 *
 * Null for an unset `APPROVE_ADAPTER` and for `helpdesk`. The reference
 * adapter holds its drafts in the memory of the process that parked them, so
 * from the console every read would find nothing and every approval would
 * refuse. Any other value goes to `choose`, which throws on a name or a
 * configuration it refuses. Call this at startup, so that throw stops the
 * console before it serves a page.
 */
export function consoleReadBack(
  env: NodeJS.ProcessEnv,
  choose: (name: string, env: NodeJS.ProcessEnv) => ReadBackAdapter,
  bound: ReadBackBound,
): ConsoleReadBack | null {
  const name = env['APPROVE_ADAPTER'];
  if (name === undefined || name === 'helpdesk') return null;
  const adapter = choose(name, env);
  // Bounded here rather than by the caller, so no path reaches the bare
  // adapter and waits on it without limit. The declaration is read from the
  // adapter itself, before it is wrapped in the bound.
  return {
    name,
    readDraft: boundedReadBack(adapter, bound),
    supportsLedgerReply: adapter.capabilities.supportsLedgerReply,
  };
}

/**
 * The same adapter, with every failure named and every read bounded.
 *
 * A draft that is absent still resolves to null. Anything the adapter throws,
 * and a read that has not answered after `giveUpMs`, rejects as
 * `ReadBackFailed`. A fault the adapter raises after that goes to
 * `onLateFault`, because the log line the page named says only that the read
 * did not answer.
 */
export function boundedReadBack(inner: DraftReadBack, bound: ReadBackBound): DraftReadBack {
  const { giveUpMs, onLateFault } = bound;
  return {
    readDraft: (draftExternalId, options) => new Promise((resolve, reject) => {
      let gaveUp = false;
      // Aborted when the page gives up, or when the caller does, so an
      // adapter holding a connection closes it then rather than at its bound.
      const controller = new AbortController();
      const caller = options?.signal;
      const callerAborted = (): void => {
        gaveUp = true;
        clearTimeout(timer);
        const reason: unknown = caller?.reason;
        const failure = new ReadBackFailed(
          reason instanceof Error ? reason.message : 'the caller stopped waiting',
          { cause: reason, draftExternalId },
        );
        reject(failure);
        controller.abort(failure);
      };
      const timer = setTimeout(() => {
        gaveUp = true;
        const failure = new ReadBackFailed(`the adapter did not answer within ${giveUpMs} ms`, { draftExternalId });
        reject(failure);
        controller.abort(failure);
      }, giveUpMs);
      // The wait belongs to one request. It must not keep a stopping console
      // alive after the request is gone.
      timer.unref();
      const settle = <T>(finish: (value: T) => void) => (value: T): void => {
        clearTimeout(timer);
        caller?.removeEventListener('abort', callerAborted);
        finish(value);
      };
      const failed = settle((error: unknown) => {
        const fault = error instanceof Error ? error.message : String(error);
        if (gaveUp) {
          // The adapter's answer to the abort is the abort, which is not news.
          if (error !== controller.signal.reason) onLateFault(fault, draftExternalId);
          return;
        }
        reject(new ReadBackFailed(fault, { cause: error, draftExternalId }));
      });
      if (caller?.aborted === true) callerAborted();
      else caller?.addEventListener('abort', callerAborted, { once: true });
      try {
        inner.readDraft(draftExternalId, { signal: controller.signal }).then(settle(resolve), failed);
      } catch (error) {
        failed(error);
      }
    }),
  };
}

/**
 * The read-back the console's entry point builds: the adapter the environment
 * names, bounded at {@link READ_BACK_GIVE_UP_MS}, with a late fault logged
 * beside the draft it concerns.
 */
export function readBackFor(
  env: NodeJS.ProcessEnv,
  choose: (name: string, env: NodeJS.ProcessEnv) => ReadBackAdapter,
  log: (record: Readonly<Record<string, unknown>>) => void,
): ConsoleReadBack | null {
  return consoleReadBack(env, choose, {
    giveUpMs: READ_BACK_GIVE_UP_MS,
    // The page already answered that the read failed. A fault that arrives
    // afterwards names what actually went wrong, so it is kept.
    onLateFault: (fault, draftExternalId) => {
      log({ event: 'console_read_back_late_fault', draftExternalId, fault });
    },
  });
}
