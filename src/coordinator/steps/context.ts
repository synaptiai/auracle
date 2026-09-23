// What a step is handed, and what it may answer (section 4.3).
//
// `coordinateTicket` was one 592-line function holding seven closures and
// six open-coded step blocks. Testing the gate branch needed a pool, a
// provider and an egress adapter, because there was no smaller thing to
// call. The steps are modules now, each `(ctx: RunContext) => StepResult`,
// and this file is the seam between them and the sequencer (issue #75).
//
// The context is deliberately mutable in two places and nowhere else: the
// step counter and the accumulated results. A step reads what the earlier
// steps produced and writes what it produced. Everything else — the
// dependencies, the input, the run id — is fixed when the run starts.
//
// Nothing here decides the order. The sequencer in `coordinator.ts` does,
// and it is the only module that knows the walk.
import type { Pool, PoolClient } from 'pg';

import type { Classification } from '../../classifier/classifier.js';
import { CoordinatorFaultError } from '../fault.js';
import type { ComposerResult } from '../../composer/composer.js';
import {
  journalFinish as writeJournalFinish,
  journalStart as writeJournalStart,
} from '../../ledger/journal-write.js';
import { fencedTransition, type FencedOutboxInput } from '../../ledger/insert.js';
import { UnreadableAnswerError } from '../../models/provider.js';
import type { ModelProvider } from '../../models/provider.js';
import type { PolicyDecision } from '../../policy/policy.js';
import type { RetrievedDoc } from '../../retriever/types.js';
import type {
  ActiveRunState,
  CoordinateInput,
  CoordinateOutcome,
  CoordinatorDeps,
  EscalationReason,
  TerminalRunState,
} from '../types.js';

/**
 * Step count for the run. Cost is not here: it lives in the meter, which
 * wraps the provider and is the single reader for the DEC-25 limit and for
 * every journal write.
 */
export interface Progress {
  stepsUsed: number;
}

/** The provider a run calls, and what it has spent so far (DEC-25). */
export interface Meter {
  provider: ModelProvider;
  cost: () => number;
}

/**
 * Wraps the provider so every model call reports its cost into one total
 * (DEC-25). The components keep their own interfaces; the coordinator sees
 * the spend without changing them.
 */
export function meterProvider(provider: ModelProvider): Meter {
  let costMicros = 0;
  return {
    provider: {
      async complete(call) {
        let result;
        try {
          result = await provider.complete(call);
        } catch (error) {
          // A refused call still cost money. A truncated one exhausted its
          // answer budget by definition, so it is the most expensive call of
          // the run, and metering only the calls that returned understated
          // the run by its largest one (DEC-25). Counting it here covers
          // every caller, including the classifier, which reads an
          // unreadable sample as a vote against agreement and moves on.
          if (error instanceof UnreadableAnswerError) costMicros += error.costMicros;
          throw error;
        }
        costMicros += result.costMicros;
        return result;
      },
      async embed(call) {
        let result;
        try {
          result = await provider.embed(call);
        } catch (error) {
          // The same credit the chat path takes. An embed fault carries zero
          // today, but an asymmetry here would silently swallow a real number
          // the moment one carried it (DEC-25).
          if (error instanceof UnreadableAnswerError) costMicros += error.costMicros;
          throw error;
        }
        costMicros += result.costMicros;
        return result;
      },
    },
    cost: () => costMicros,
  };
}

/**
 * What the steps have produced so far.
 *
 * Each field is written by exactly one step and read by the steps after it.
 * Absent means the step that writes it has not run, which `stateAfter`
 * turns into a named fault rather than an undefined read three frames away.
 */
export interface RunState {
  /** From `classify`. */
  classification?: Classification;
  /** From `retrieve`. */
  docs?: RetrievedDoc[];
  /** From `compose`. */
  composed?: ComposerResult;
  /**
   * The reply the composer drafted, once `compose` has ruled out an
   * abstain. Held beside the whole result so `park` reads a string and
   * needs no second null check on a case `compose` already ended.
   */
  draft?: string;
  /** From `gate`. */
  decision?: PolicyDecision;
}

/**
 * A value an earlier step produced, or a fault that names the step.
 *
 * The message names the sequencer's mistake and not the data's shape:
 * "gate ran before compose" sends its reader to the walk, and
 * "composed is undefined" sends them to the wrong file.
 */
export function stateAfter<K extends keyof RunState>(
  state: RunState,
  key: K,
  step: string,
  producer: string,
): NonNullable<RunState[K]> {
  const value = state[key];
  if (value === undefined) {
    throw new CoordinatorFaultError(
      `${step} ran before ${producer}: the run has no ${String(key)}`,
    );
  }
  return value as NonNullable<RunState[K]>;
}

/** Everything one step of a run may read or write. */
export interface RunContext {
  readonly deps: CoordinatorDeps;
  readonly input: CoordinateInput;
  readonly runId: string;
  /** Mutable: a step that acted increments it. */
  readonly progress: Progress;
  readonly meter: Meter;
  /** Mutable: a step writes what it produced. */
  readonly state: RunState;
  /** The pool, named once so a step does not reach through `deps`. */
  readonly pool: Pool;
}

/**
 * What a step answers.
 *
 * `continue` means the walk goes on. `escalate` hands the sequencer a
 * DEC-25 reason, and the sequencer writes the escalate step and the
 * transition — one place, so every reason is journalled the same way.
 * `stop` is a run that has reached its own end, or a fence that refused it.
 */
export type StepResult =
  | { kind: 'continue' }
  | { kind: 'escalate'; reason: EscalationReason }
  | { kind: 'stop'; outcome: CoordinateOutcome };

/** The walk goes on. */
export const CONTINUE: StepResult = { kind: 'continue' };

export function createRunContext(
  deps: CoordinatorDeps,
  input: CoordinateInput,
  runId: string,
  meter: Meter,
): RunContext {
  return {
    deps,
    input,
    runId,
    progress: { stepsUsed: 0 },
    meter,
    state: {},
    pool: deps.pool,
  };
}

/**
 * The DEC-25 limits. Reaching one is never an error: the run escalates and
 * keeps its partial work.
 *
 * Called by the step that is about to act, not by the sequencer. `park` has
 * no such check and must not gain one — a gated reply that has already been
 * composed is parked whatever the run has spent, because the alternative is
 * a draft the ledger cannot account for. `steps.test.ts` holds that shut.
 */
export function limitHit(ctx: RunContext): EscalationReason | null {
  if (ctx.meter.cost() >= ctx.deps.limits.maxCostMicros) return 'limit_cost';
  if (ctx.progress.stepsUsed >= ctx.deps.limits.maxSteps) return 'limit_steps';
  if (Date.now() >= ctx.deps.limits.deadlineAt.getTime()) return 'limit_clock';
  return null;
}

/**
 * The write-before-act entry: this step is about to run (section 4.3 task 3,
 * DEC-04). Through `src/ledger/journal-write.ts`, which owns the column list.
 *
 * Section 4.2 defines the `step_journal` table and states the two outbox
 * rules. It states nothing about writing before acting; that is task 3 of the
 * coordinator's own list.
 */
export async function journalStart(ctx: RunContext, stepId: string): Promise<void> {
  await writeJournalStart(ctx.pool, {
    runId: ctx.runId,
    stepId,
    promptVer: ctx.deps.pins.promptVer,
    modelVer: ctx.deps.pins.modelVer,
    costMicros: ctx.meter.cost(),
  });
}

/** The outcome of a step this run started. */
export async function journalFinish(
  ctx: RunContext,
  stepId: string,
  status: string,
  result: Record<string, unknown>,
): Promise<void> {
  await writeJournalFinish(ctx.pool, {
    runId: ctx.runId,
    stepId,
    status,
    result,
    costMicros: ctx.meter.cost(),
  });
}

/**
 * Moves the run, carrying the epoch; the ledger refuses the write when this
 * run's lease went stale (DEC-28).
 *
 * Returns null when the run may go on, and the outcome it must return
 * otherwise.
 */
export async function transitionOrStop(
  ctx: RunContext,
  state: ActiveRunState | TerminalRunState,
  outbox?: FencedOutboxInput,
  /**
   * Writes the transition's own record in its commit, such as the reason a
   * run stopped. A refused transition writes none of it.
   */
  afterWrite?: (client: PoolClient) => Promise<void>,
): Promise<CoordinateOutcome | null> {
  const result = await fencedTransition(ctx.pool, {
    runId: ctx.runId,
    state,
    costMicros: ctx.meter.cost(),
    stepsUsed: ctx.progress.stepsUsed,
    ...(outbox === undefined ? {} : { outbox }),
    ...(afterWrite === undefined ? {} : { afterWrite }),
  });
  if (result.outcome === 'accepted') return null;
  if (result.outcome === 'superseded') return { runId: ctx.runId, outcome: 'superseded' };
  if (result.outcome === 'stale_epoch') {
    return {
      runId: ctx.runId,
      outcome: 'stale_epoch',
      highestAcceptedEpoch: result.highestAcceptedEpoch,
    };
  }
  throw new CoordinatorFaultError(`transition target vanished from the ledger: ${ctx.runId}`);
}

/**
 * Ends the run at 'escalated', with the reason on its own journal row.
 *
 * One place, so every reason reaches `src/escalations/query.ts` in the same
 * shape. A fence that refuses the transition wins: the run stops as the
 * ledger says it stopped, not as this function intended.
 *
 * No `fromState`: a run escalates from any active state, and the fault
 * handler reaches this from every one of them. A named source state would
 * refuse the transition for the state the run actually held and strand it
 * where the throw left it, which is the failure this exit exists to end.
 */
export async function stopEscalated(
  ctx: RunContext,
  reason: EscalationReason,
  /**
   * What the reason does not say, journalled beside it. `internal_fault`
   * names a defect and not a step, so the fault message is the whole of what
   * an operator has to go on (issue #94). `reason` is written last, so a
   * detail key of that name cannot displace the value the queue reads.
   */
  detail: Record<string, unknown> = {},
): Promise<CoordinateOutcome> {
  await journalStart(ctx, 'escalate');
  await journalFinish(ctx, 'escalate', 'done', { ...detail, reason });
  const stop = await transitionOrStop(ctx, 'escalated');
  return stop ?? { runId: ctx.runId, outcome: 'escalated', reason };
}

/**
 * What a step answered, as the run's outcome.
 *
 * Every escalate answer reaches the ledger through `stopEscalated`, which is
 * the single writer of the row; the sequencer's fault handler is its other
 * caller. So each reason reaches `src/escalations/query.ts` in one shape,
 * whether a step chose it or a defect did.
 *
 * A step that answers 'continue' where the run has to end is a defect in the
 * walk: park and execute both end it, so 'continue' from either means the
 * sequencer lost track of its own order. It raises a fault rather than
 * returning, and the sequencer's catch ends the run at 'escalated' (#94).
 *
 * A function rather than a closure inside `coordinateTicket`, so the fault is
 * reachable from a test. It was unreachable from outside the module before,
 * which is the only reason the case for it could not be written.
 */
export async function finishStep(
  ctx: RunContext,
  result: StepResult,
): Promise<CoordinateOutcome> {
  if (result.kind === 'stop') return result.outcome;
  if (result.kind === 'escalate') return stopEscalated(ctx, result.reason);
  throw new CoordinatorFaultError(`a final step of run ${ctx.runId} answered 'continue'`);
}

/** A step, as the sequencer sees one. */
export type Step = (ctx: RunContext) => Promise<StepResult>;
