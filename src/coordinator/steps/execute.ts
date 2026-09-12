// The execute step: the automatic path, internal writes only (section 4.2).
//
// The only step that inserts an outbox record, and it does so in the same
// transaction as the state change (section 4.2 rule 1). An insert of zero
// rows is a distinct result and not an ignored success: a replayed semantic
// action loses the insert and the run stops superseded (rule 2).
import { deriveIdemKey } from '../../ledger/keys.js';
import {
  journalFinish,
  journalStart,
  limitHit,
  transitionOrStop,
  type RunContext,
  type StepResult,
} from './context.js';

export async function execute(ctx: RunContext): Promise<StepResult> {
  const executeLimit = limitHit(ctx);
  if (executeLimit !== null) return { kind: 'escalate', reason: executeLimit };

  await journalStart(ctx, 'execute');
  const idemKey = deriveIdemKey({
    actionClass: ctx.input.actionClass,
    ticketId: ctx.input.ticketId,
    // DEC-38: two turns asking for the same thing are two requests.
    ...(ctx.input.turnNumber === undefined ? {} : { turnNumber: ctx.input.turnNumber }),
    // DEC-35: the conversation the turn belongs to. A turn number alone is
    // not unique — db/012 can put two conversations on one ticket.
    conversationId: ctx.input.conversationId ?? null,
    payload: ctx.input.actionPayload,
  });
  ctx.progress.stepsUsed++;
  const executing = await transitionOrStop(ctx, 'executing', {
    stepId: 'execute',
    idemKey,
    actionClass: ctx.input.actionClass,
    delivery: ctx.input.delivery,
    payload: ctx.input.actionPayload,
  });
  if (executing !== null) {
    // Section 4.2 rule 2 end to end: a replayed semantic action loses the
    // outbox insert and stops superseded, never executing.
    await journalFinish(ctx, 'execute', 'superseded', { idemKey });
    return { kind: 'stop', outcome: executing };
  }
  await journalFinish(ctx, 'execute', 'done', { idemKey });

  const resolved = await transitionOrStop(ctx, 'resolved');
  if (resolved !== null) return { kind: 'stop', outcome: resolved };
  return { kind: 'stop', outcome: { runId: ctx.runId, outcome: 'resolved' } };
}
