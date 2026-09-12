// The retrieve step (section 4.6, DEC-21, DEC-23).
//
// One embedding call for the query, then the hybrid search. RRF fuses ranks
// and keeps neither score, so nothing here records a position: a rank
// written to the journal would claim the fusion set the order.
import { hybridSearch } from '../../retriever/retriever.js';
import type { RetrievedDoc } from '../../retriever/types.js';
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
import { digestOf } from './digest.js';

export async function retrieve(ctx: RunContext): Promise<StepResult> {
  const retrieveLimit = limitHit(ctx);
  if (retrieveLimit !== null) return { kind: 'escalate', reason: retrieveLimit };

  await journalStart(ctx, 'retrieve');
  const embedModelVer = ctx.deps.embedModelVer ?? ctx.deps.pins.modelVer;
  let embedded;
  try {
    embedded = await ctx.meter.provider.embed({
      input: [ctx.input.ticketText],
      ...ctx.deps.pins,
      modelVer: embedModelVer,
    });
  } catch (error) {
    // The fourth step that reads a model answer, and the last one with no
    // catch. A response shape the provider will reproduce is not transient,
    // so it ends the run here rather than going round the queue's ceiling.
    if (error instanceof UnreadableAnswerError) {
      ctx.progress.stepsUsed++;
      await journalFinish(ctx, 'retrieve', 'failed', {
        shape: error.shape,
        ...(error.costUnknown ? { costUnknown: true } : {}),
        error: error.message,
      });
      return { kind: 'escalate', reason: 'retriever_unreadable' };
    }
    throw error;
  }
  const queryVector = embedded.vectors[0];
  if (queryVector === undefined) {
    ctx.progress.stepsUsed++;
    await journalFinish(ctx, 'retrieve', 'failed', {
      shape: 'no-vector',
      error: 'embedder returned no vector for the retrieval query',
    });
    return { kind: 'escalate', reason: 'retriever_unreadable' };
  }
  const docs: RetrievedDoc[] = await hybridSearch(
    ctx.pool,
    ctx.input.ticketText,
    queryVector,
    { limit: 5 },
  );
  ctx.progress.stepsUsed++;
  await journalFinish(ctx, 'retrieve', 'done', {
    docIds: docs.map((doc) => doc.docId),
    // What each fused document was when this run read it (DEC-23).
    //
    // `document` rows are updated in place on reindex, so today's title and
    // review date are not the ones the run retrieved. Only the id was a
    // historical fact. These are, and the hash says whether the body still
    // matches without storing a second copy of the corpus.
    //
    // No score and no rank: DEC-21 fuses ranks and keeps neither, and a
    // position recorded here would claim the fusion set the order.
    documents: docs.map((doc) => ({
      docId: doc.docId,
      title: doc.title,
      owner: doc.owner,
      reviewBy: doc.reviewBy,
      bodyHash: digestOf(doc.body),
    })),
    // DEC-26 truthfulness: the step's model_ver column carries the chat pin;
    // the embedding pin is recorded here.
    embed_model_ver: embedModelVer,
  });
  ctx.state.docs = docs;
  const retrieved = await transitionOrStop(ctx, 'retrieved');
  if (retrieved !== null) return { kind: 'stop', outcome: retrieved };
  return CONTINUE;
}
