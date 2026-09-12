// Run coordinator — docs/v1-architecture.md section 4.3. Obeys DEC-04,
// DEC-25, DEC-27, DEC-28.
//
// A plain state machine: no framework, no agent loop, no control flow from
// the model.
//
//   received -> classified -> retrieved -> composed -> gated
//     -> executing          (automatic path, internal writes only)
//     -> awaiting_approval  (customer replies, DEC-12)
//     -> resolved | escalated | superseded | abandoned
//
// Three tasks per section 4.3:
//   1. Each step is journaled before it acts (step_journal).
//   2. Every write carries the fencing epoch (DEC-28) through the ledger
//      insert path in src/ledger/insert.ts.
//   3. The limits on cost, steps and clock time are applied. Hitting a limit
//      is not an error: the run goes to 'escalated' and keeps its partial
//      work (DEC-25).
//
// This file is the sequencer, and nothing else. Each step is a module under
// `steps/`, and each does all three of those tasks for itself; the walk
// below is the only statement of their order. Before this the walk and the
// six steps were one 592-line function, and testing the gate branch needed
// a pool, a provider and an egress adapter because there was no smaller
// thing to call (issue #75).

import { randomUUID } from 'node:crypto';

import { COMPENSATION_ACTION_CLASS } from '../adapters/types.js';
import { fencedInsert } from '../ledger/insert.js';
import { classify } from './steps/classify.js';
import { compose } from './steps/compose.js';
import {
  createRunContext,
  meterProvider,
  stateAfter,
  stopEscalated as stepStopEscalated,
  type StepResult,
} from './steps/context.js';
import { execute } from './steps/execute.js';
import { gate } from './steps/gate.js';
import { park } from './steps/park.js';
import { retrieve } from './steps/retrieve.js';
import { partitionOf } from './types.js';
import type {
  CoordinateInput,
  CoordinateOutcome,
  CoordinatorDeps,
} from './types.js';

// The vocabulary is declared beside this file and re-exported here, so a
// caller still addresses the coordinator rather than its parts. The turn
// type sits further out again, in `src/domain/conversation-turn.ts`: the
// classifier, the composer and the triage judge each read a turn, this
// module reads all three, and a type declared here made every one of them
// import the orchestrator (issue #75).
export { RUN_STATES, partitionOf } from './types.js';
export type {
  ActiveRunState,
  CoordinateInput,
  CoordinateOutcome,
  CoordinatorDeps,
  CoordinatorTaxonomy,
  EscalationReason,
  RunLimits,
  TerminalRunState,
} from './types.js';
export type { ConversationTurn } from '../domain/conversation-turn.js';

/**
 * Drives one ticket from 'received' to a terminal state or to
 * 'awaiting_approval'. One call walks the whole machine; each hop inside is
 * journaled before it acts and written through the fenced ledger path.
 */

export async function coordinateTicket(
  deps: CoordinatorDeps,
  input: CoordinateInput,
): Promise<CoordinateOutcome> {
  // DEC-29: the action class declares its delivery rule. Compensation
  // declares `at_most_once` — a duplicate refund costs money — so any
  // other rule is a caller defect, refused before any state change.
  if (
    input.actionClass === COMPENSATION_ACTION_CLASS
    && input.delivery !== 'at_most_once'
  ) {
    throw new Error(
      `action class '${COMPENSATION_ACTION_CLASS}' declares delivery 'at_most_once', got '${input.delivery}'`,
    );
  }

  const runId = randomUUID();
  const meter = meterProvider(deps.provider);
  // The context every step reads. The closures below delegate to it, so the
  // steps still inline here and the extracted ones share one step counter,
  // one meter and one journal path (issue #75).
  const ctx = createRunContext(deps, input, runId, meter);

  // Run creation through the existing ledger insert path. No outbox record:
  // receiving a ticket produces no external action, so rule 2 of section 4.2
  // does not operate here.
  const started = await fencedInsert(
    deps.pool,
    {
      runId,
      ticketId: input.ticketId,
      partition:
        input.partition
        ?? partitionOf(input.conversationId ?? input.ticketId, deps.partitionCount),
      ...(input.conversationId == null ? {} : { conversationId: input.conversationId }),
      // DEC-35: the turn this run answers, so a turn joins to the run that
      // answered it without going through the park journal. An automatic run
      // parks nothing, so that join reached no automatic run at all.
      ...(input.turnNumber === undefined ? {} : { turnNumber: input.turnNumber }),
      epoch: input.epoch,
      state: 'received',
      promptVer: deps.pins.promptVer,
      modelVer: deps.pins.modelVer,
      deadlineAt: deps.limits.deadlineAt,
      ...(input.enqueuedAt === undefined ? {} : { enqueuedAt: input.enqueuedAt }),
    },
    null,
  );
  if (started.outcome === 'stale_epoch') {
    return {
      runId,
      outcome: 'stale_epoch',
      highestAcceptedEpoch: started.highestAcceptedEpoch,
    };
  }

  /**
   * What a step answered, as the run's outcome.
   *
   * The escalate row is written here and nowhere else, so every DEC-25
   * reason reaches `src/escalations/query.ts` in one shape. A step never
   * answers 'continue' where this is called: the loop below handles that
   * case, and park and execute both end the run.
   */
  const finish = async (result: StepResult): Promise<CoordinateOutcome> => {
    if (result.kind === 'stop') return result.outcome;
    if (result.kind === 'escalate') return stepStopEscalated(ctx, result.reason);
    throw new Error(`a final step of run ${runId} answered 'continue'`);
  };

  // The walk, and the only statement of its order. Each step journals
  // itself before it acts (section 4.2), checks the DEC-25 limits before it
  // spends, and writes what it produced into `ctx.state` for the steps
  // after it. Remove one from this list and the run fails: the steps after
  // it read a value nobody wrote, and `coordinator.db.test.ts` turns red —
  // 23, 21, 17 and 11 cases for classify, retrieve, compose and gate.
  for (const step of [classify, retrieve, compose, gate]) {
    const result = await step(ctx);
    if (result.kind !== 'continue') return finish(result);
  }

  // DEC-12: a gated action waits for a person, inside the target system or
  // in the ledger. Anything else takes the automatic path.
  //
  // Through `stateAfter`, like every other cross-step read, because the
  // default here is the dangerous one. An unset decision is not `'gated'`,
  // so a bare comparison would route to `execute`, which inserts the outbox
  // record the relay then sends — an ungated customer reply or an
  // irreversible compensation, with the gate row recording a verdict the run
  // never acted on. A named fault is the only safe reading of "gate did not
  // run".
  const decision = stateAfter(ctx.state, 'decision', 'the walk', 'gate');
  return finish(await (decision === 'gated' ? park : execute)(ctx));
}
