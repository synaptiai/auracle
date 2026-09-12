// The classify step (section 4.5, DEC-05).
//
// Nine samples above temperature zero, and the agreement between them is one
// of the two independent gates. At temperature zero agreement is always 1.0
// and the gate passes every ticket, so the sampling is asserted in the
// classifier and not described in a comment here.
import { classifyTicket } from '../../classifier/classifier.js';
import { UnreadableAnswerError } from '../../models/provider.js';
import {
  CONTINUE,
  journalFinish,
  journalStart,
  limitHit,
  transitionOrStop,
  type RunContext,
  type StepResult,
} from './context.js';

export async function classify(ctx: RunContext): Promise<StepResult> {
  const earlyLimit = limitHit(ctx);
  if (earlyLimit !== null) return { kind: 'escalate', reason: earlyLimit };

  await journalStart(ctx, 'classify');
  let classification;
  try {
    classification = await classifyTicket(ctx.meter.provider, {
      taxonomy: ctx.deps.taxonomy,
      ticketText: ctx.input.ticketText,
      history: ctx.input.history ?? [],
      ...ctx.deps.pins,
    });
  } catch (error) {
    // The third fault path, and the one the metering fix left unpersisted:
    // the meter counted every truncated sample and nothing wrote the total to
    // the run, because this step had no catch. It also went round the retry
    // ceiling, which nine truncated samples reproduce on every pass.
    if (error instanceof UnreadableAnswerError) {
      ctx.progress.stepsUsed++;
      await journalFinish(ctx, 'classify', 'failed', {
        shape: error.shape,
        ...(error.costUnknown ? { costUnknown: true } : {}),
        error: error.message,
      });
      // The shape decides the reason. Samples that answered with labels this
      // taxonomy does not hold is a taxonomy or prompt fault, and sending an
      // operator to check the answer budget for it wastes their time.
      return {
        kind: 'escalate',
        reason: error.shape === 'no-label' ? 'classifier_no_label' : 'classifier_unreadable',
      };
    }
    throw error;
  }
  ctx.progress.stepsUsed++;
  await journalFinish(ctx, 'classify', 'done', {
    intentId: classification.intentId,
    agreement: classification.agreement,
    // An agreement depressed by samples nobody could read is not the same
    // number as one the model actually disagreed on, and this is the one path
    // where a customer is waiting. Recorded beside it, not instead of it.
    ...(classification.unreadableSamples > 0
      ? { unreadableSamples: classification.unreadableSamples }
      : {}),
    ...(classification.costUnknown ? { costUnknown: true } : {}),
  });
  ctx.state.classification = classification;
  const classified = await transitionOrStop(ctx, 'classified');
  if (classified !== null) return { kind: 'stop', outcome: classified };
  return CONTINUE;
}
