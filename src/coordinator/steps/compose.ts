// The compose step (section 4.7, DEC-07, DEC-43).
//
// An abstain is a correct output and not an error: the composer says it
// cannot answer from the retrieved documents, and the run escalates with
// its partial work rather than drafting something unsupported.
import { composeAnswer } from '../../composer/composer.js';
import { UnreadableAnswerError } from '../../models/provider.js';
import type { RetrievedDoc } from '../../retriever/types.js';
import {
  CONTINUE,
  journalFinish,
  journalStart,
  limitHit,
  stateAfter,
  transitionOrStop,
  type RunContext,
  type StepResult,
} from './context.js';

/**
 * The bodies of the documents the claims actually cite.
 *
 * Only the cited ones. A run fuses about eight documents and cites two or
 * three, and the uncited five carry a hash on the `retrieve` row already —
 * enough to say whether they changed, without copying text no claim rests on.
 *
 * Keyed by id and deduplicated, because two claims commonly cite one
 * document and the journal should hold its text once.
 *
 * A cited id that is not in the fused set cannot occur: the composer refuses
 * a citation naming a document it was not given. It is skipped rather than
 * asserted, because this is a write-before-act journal entry and a throw here
 * would lose the run over a record about it.
 */
function citedBodiesOf(
  claims: readonly { readonly docId: string }[],
  docs: readonly RetrievedDoc[],
): Record<string, string> {
  const byId = new Map(docs.map((doc) => [doc.docId, doc.body]));
  const cited: Record<string, string> = {};
  for (const claim of claims) {
    const body = byId.get(claim.docId);
    if (body !== undefined) cited[claim.docId] = body;
  }
  return cited;
}

export async function compose(ctx: RunContext): Promise<StepResult> {
  const docs = stateAfter(ctx.state, 'docs', 'compose', 'retrieve');

  const composeLimit = limitHit(ctx);
  if (composeLimit !== null) return { kind: 'escalate', reason: composeLimit };

  await journalStart(ctx, 'compose');
  let composed;
  try {
    composed = await composeAnswer(
      {
        question: ctx.input.ticketText,
        docs,
        history: ctx.input.history ?? [],
        // DEC-49: the note a reviewer sent the case back with. It reaches the
        // composer and no other step, so it is an instruction and never a
        // retrieved span, and the gates never count it as coverage (DEC-37).
        ...(ctx.input.note === undefined ? {} : { note: ctx.input.note }),
      },
      { provider: ctx.meter.provider, ...ctx.deps.pins },
    );
  } catch (error) {
    // An abstain is a determination and escalates below with its own reason.
    // An unreadable answer is a fault, and it must not borrow that reason.
    if (error instanceof UnreadableAnswerError) {
      // The meter already counted the faulting call's spend (DEC-25). The
      // step still happened, so it still counts.
      ctx.progress.stepsUsed++;
      await journalFinish(ctx, 'compose', 'failed', {
        shape: error.shape,
        ...(error.costUnknown ? { costUnknown: true } : {}),
        error: error.message,
      });
      return { kind: 'escalate', reason: 'composer_unreadable' };
    }
    throw error;
  }
  ctx.progress.stepsUsed++;
  await journalFinish(ctx, 'compose', composed.abstained ? 'abstained' : 'done', {
    abstained: composed.abstained,
    claimCount: composed.claims.length,
    // The drafted reply, sentence by sentence, as the composer partitioned it
    // (DEC-43). A `docId` is the document that sentence rests on; null is a
    // courtesy sentence, which cites nothing and is never counted.
    //
    // The whole reply and not the claims alone: the claims are no longer the
    // draft, so a row holding only them would describe a reply the customer
    // never reads. Stored once, here. `park.body` holds the joined text for
    // the approval to compare against, and nothing else copies it.
    //
    // Named `sentences` rather than `claims`, because a list holding courtesy
    // sentences is not a list of claims. `docs/operations.md` names this key
    // in the erasure statement, and `journal/query.ts` still reads a `claims`
    // row written before this.
    sentences: composed.sentences.map((sentence) => ({
      text: sentence.text,
      docId: sentence.docId,
    })),
    // The cited documents as they read at this moment, and only the cited
    // ones. Journalled here rather than at `retrieve`, because `retrieve`
    // runs first and nothing there knows which documents a claim will cite.
    //
    // The retrieve row stores a hash and this one stores text, and the two
    // are not in tension. A hash answers whether a document changed; it
    // cannot answer what the claim actually rested on once someone edits the
    // document. Evidence a person can read has to be the text, so the run
    // keeps the text for the documents its claims rest on and the cheaper
    // answer for the rest. `README.md` states what that means for retention.
    //
    // Bounded by the retrieval limit above, so a run stores at most that many
    // bodies however many claims it makes.
    citedBodies: citedBodiesOf(composed.claims, docs),
    staleDocumentIds: composed.staleDocuments.map((doc) => doc.docId),
    // What actually answered this run's model calls (issue #23).
    //
    // Read from the provider rather than derived from the pins: this module's
    // own import states that the provider and the model version are
    // independent options, so a stub answering under a real model's pin would
    // report the wrong thing. `scorerOf` in the gold report reads it the same
    // way, for the same reason.
    //
    // `pnpm run bands` compares a day against the thirty before it, and a
    // band across a provider change measures the provider and not the system.
    // Without this the reader had no way to tell, and every day of live
    // traffic recorded nothing while a seeded day recorded a name — which
    // made the report refuse a verdict on any ledger holding both.
    provider: ctx.deps.provider.kind ?? 'model',
  });
  if (composed.abstained || composed.draft === null) {
    // DEC-07: an abstain is a correct output, not an error. A person closes
    // the knowledge gap, so the run keeps its partial work and escalates.
    return { kind: 'escalate', reason: 'composer_abstained' };
  }
  ctx.state.composed = composed;
  // Held separately, past the abstain above, so `park` reads a string.
  ctx.state.draft = composed.draft;
  const composedOk = await transitionOrStop(ctx, 'composed');
  if (composedOk !== null) return { kind: 'stop', outcome: composedOk };
  return CONTINUE;
}
