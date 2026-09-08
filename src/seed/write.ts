/**
 * Writes a planned history through the real ledger path (issue #23).
 *
 * Every run goes in through `fencedInsert` with an explicit clock, so it
 * takes the same epoch check, the same transaction boundary and the same
 * journal writes a live run takes. The rows a report then describes are rows
 * the system actually produced, which is the whole reason the clock seam
 * exists (issue #22).
 *
 * This module is the one place in `src/` that supplies a clock.
 * `src/ledger/clock-reachability.test.ts` names it as the single exception to
 * the rule that no shipped module may, and it keeps no exception at all for
 * the daemon closure — so a daemon that ever imported this file fails that
 * guard. The seeder may hold the clock; nothing a daemon reaches may.
 */
import { createHash } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { deriveIdemKey } from '../ledger/keys.js';
import {
  fencedInsert,
  type FencedOutboxInput,
  type FencedRunInput,
} from '../ledger/insert.js';
import { indexDocument } from '../retriever/retriever.js';
import { UNATTRIBUTED } from '../approval/approve.js';
import { SEED_THRESHOLDS } from '../policy/policy.js';
import { SEED_DOCUMENTS, mulberry32, type PlannedRun } from './plan.js';

/** The embedding width db/002 pins. A shorter vector is refused by the column. */
const EMBEDDING_DIMS = 1536;

/**
 * A deterministic vector for one seeded document.
 *
 * Meaningless as a direction, and that is honest: nothing in this history
 * runs an embedder, so a vector that pretended to place the document near a
 * query would be a claim the seeder cannot support. It exists because the
 * column is NOT NULL and because the dense channel needs something to order
 * by. Derived from the document id, so re-seeding never rewrites the index
 * with a different vector.
 */
function seededEmbedding(docId: string): number[] {
  let hash = 0x811c9dc5;
  for (let i = 0; i < docId.length; i += 1) {
    hash ^= docId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const rng = mulberry32(hash >>> 0);
  const vector: number[] = [];
  for (let i = 0; i < EMBEDDING_DIMS; i += 1) vector.push(rng() * 2 - 1);
  return vector;
}

/**
 * Writes the small synthetic knowledge base the runs retrieve from.
 *
 * Without it a `retrieve` row names five documents that resolve to nothing,
 * and a reader can no more join an id to a title than it could read a gate
 * reason with no numbers beside it.
 *
 * Through `indexDocument`, so the row is written the way the retriever writes
 * one and the upsert is the retriever's own.
 *
 * The `SYN-` prefix (DEC-18) keeps these ids clear of a real index's own, so
 * nothing here overwrites a document. Overwriting was never the hazard. These
 * rows go into `document`, which is the table the retriever searches, and
 * every one of them carries a review date years out — so they pass
 * `review_by >= CURRENT_DATE` and are retrievable. Seeded against a ledger
 * that also serves live traffic, invented refund and data-deletion policy can
 * be retrieved and grounded into a reply to a real customer.
 *
 * So this refuses a ledger holding any document it did not write. `run.ts`
 * already states that the seeder is unsafe against a live database; this
 * makes the statement enforceable at the one table where the consequence
 * reaches a customer rather than a report.
 */
export async function writeDocuments(pool: Pool): Promise<number> {
  const foreign = await pool.query<{ doc_id: string }>(
    "SELECT doc_id FROM document WHERE doc_id NOT LIKE 'SYN-%' LIMIT 1",
  );
  const first = foreign.rows[0];
  if (first !== undefined) {
    throw new Error(
      `seed-documents: the ledger already holds ${first.doc_id}, which this seeder did not`
        + ' write. Seeded documents are retrievable, so adding them beside a real index lets'
        + ' invented policy ground a reply to a real customer. Point at a scratch ledger.',
    );
  }
  // Counted, not assumed. Returning the input length reports the plan rather
  // than the outcome, and the caller prints this number as what landed.
  let written = 0;
  for (const doc of SEED_DOCUMENTS) {
    await indexDocument(pool, doc, seededEmbedding(doc.docId));
    written += 1;
  }
  return written;
}

/** How many runs landed, and how many the ledger refused. */
export interface WriteReport {
  accepted: number;
  refused: number;
}

/**
 * The conversation and the turn the run answers (DEC-35, DEC-37).
 *
 * The run row already named a conversation and nothing else in the ledger
 * held one, so the identifier resolved to no rows at all. That is not only a
 * gap for a reader: `approveRun` records the approved reply on the turn the
 * park names, and a missing turn makes it roll the whole approval back rather
 * than lose the agent half of the history. So a seeded parked run could not
 * be approved even once its park step existed.
 *
 * One inbound message, so one turn, numbered 1 — which is what
 * `conversation.turn_counter` assigns first and what the park record cites
 * (DEC-38). The counter is left at 2, the value intake would have left it at.
 *
 * `customer_address` stays null. The column records a participant an adapter
 * named, no adapter ran here, and DEC-18 forbids inventing one that looks
 * like a real address.
 */
async function writeConversation(client: PoolClient, run: PlannedRun): Promise<void> {
  await client.query(
    `INSERT INTO conversation (conversation_id, primary_ticket_id, turn_counter, opened_at, state)
     VALUES ($1, $2, 2, $3, $4)
     ON CONFLICT (conversation_id) DO NOTHING`,
    [
      run.conversationId,
      run.ticketId,
      run.enqueuedAt,
      run.state === 'resolved' ? 'resolved' : 'open',
    ],
  );
  await client.query(
    `INSERT INTO turn (conversation_id, turn_number, ticket_id, inbound_message_id,
                       created_at, body_text)
     VALUES ($1, 1, $2, $3, $4, $5)
     ON CONFLICT (conversation_id, turn_number) DO NOTHING`,
    [
      run.conversationId,
      run.ticketId,
      `SYN-MSG-${run.ticketId.slice(2)}`,
      run.enqueuedAt,
      inboundTextFor(run),
    ],
  );
}

/** The customer's message, as DEC-37 keeps it for the prompts of later turns. */
function inboundTextFor(run: PlannedRun): string {
  return `I need help with a ${run.classification.intentId.replace(/-/g, ' ')} `
    + `on ticket ${run.ticketId}. Please tell me what happens next.`;
}

/**
 * Writes one run: the ledger row, then the journal rows the readers need.
 *
 * The journal writes follow the accepted insert rather than sharing its
 * transaction. `fencedInsert` owns its own boundary (section 4.2 rule 1) and
 * widening it for a seeder would change the path this seeder exists to use
 * unchanged. A row without its journal is visible as a run that never
 * composed, which is a shape the readers already describe.
 */
async function writeJournal(client: PoolClient, run: PlannedRun): Promise<void> {
  const step = async (stepId: string, status: string, result: unknown): Promise<void> => {
    await client.query(
      `INSERT INTO step_journal (run_id, step_id, status, result, prompt_ver, model_ver, cost_micros)
       VALUES ($1, $2, $3, $4::jsonb, 'seed', 'seed', 0)`,
      [run.runId, stepId, status, JSON.stringify(result)],
    );
  };

  // The steps the run's own outcome implies, never a fixed set. Each result
  // is the shape `coordinateTicket` writes for that step, because a reader
  // that had to special-case a seeded row would be reading a different
  // ledger from the one it reports on.
  await step('classify', 'done', {
    intentId: run.classification.intentId,
    agreement: run.classification.agreement,
  });
  await step('retrieve', 'done', {
    docIds: run.docIds,
    // What each fused document was when the run read it (DEC-23). The
    // coordinator records this, so a seeded row that omitted it would be a
    // shape no reader could take at face value. No score and no rank: DEC-21
    // keeps neither.
    documents: run.docIds.map((docId) => {
      const doc = SEED_DOCUMENTS.find((d) => d.docId === docId)!;
      return {
        docId: doc.docId,
        title: doc.title,
        owner: doc.owner,
        reviewBy: doc.reviewBy,
        bodyHash: createHash('sha256').update(doc.body, 'utf8').digest('hex'),
      };
    }),
    // DEC-26 truthfulness: the step's model_ver column carries the chat pin
    // and the embedding pin is recorded in the result. Both are 'seed' here,
    // which is what tells a reader no model answered this run.
    embed_model_ver: 'seed',
  });
  // The status the coordinator writes: 'abstained' for an abstain, 'done'
  // otherwise. `bands` reads the result rather than the status here, but a
  // seeded row that disagreed with the coordinator would be a shape no
  // reader could trust.
  //
  // `abstained` and `provider` keep the values they always had. They are two
  // of the three journal fields the control band publishes, and this change
  // may add detail beside them but must not move them.
  await step('compose', run.abstained ? 'abstained' : 'done', {
    abstained: run.abstained,
    claimCount: run.claimCount,
    // Always empty, and not an omission. The coordinator calls `hybridSearch`
    // with no `includeStale`, so the query filters on `review_by >=
    // CURRENT_DATE` and no out-of-date document can reach a composition
    // (DEC-23). Recorded because the coordinator records it: a reader that
    // found the key missing could not tell an empty list from an old row.
    staleDocumentIds: [],
    // The drafted reply, sentence by sentence, exactly as the coordinator
    // writes it (DEC-43). A `docId` is the document the sentence rests on;
    // null is a courtesy sentence, which cites nothing.
    //
    // The whole reply, not the claims alone. `park.body` is these joined, and
    // a compose row holding only the cited ones would describe a reply that
    // is not the one parked.
    sentences: run.sentences.map((sentence) => ({
      text: sentence.text,
      docId: sentence.docId,
    })),
    // The bodies of the documents the claims actually cite. Only the cited
    // ones: the rest carry their hash on the retrieve row, which is what the
    // coordinator writes.
    citedBodies: Object.fromEntries(
      [...new Set(run.claims.map((claim) => claim.docId))].map((docId) => [
        docId,
        SEED_DOCUMENTS.find((d) => d.docId === docId)!.body,
      ]),
    ),
    provider: run.provider,
  });
  // No gate row for an abstain. The coordinator escalates before the gate
  // step starts, so the row would be a shape it never writes.
  if (run.gate !== null && run.reason !== null) {
    await step('gate', 'done', {
      groundedness: run.gate.groundedness,
      // Which claim the judge did not support, beside the fraction rather
      // than instead of it. Derived from the run's own coverage, so a reader
      // that recounts these reaches the fraction above. Coverage detail only:
      // agreement sits on the classify row and DEC-05 keeps them apart.
      claimVerdicts: run.claims.map((claim, index) => ({
        claimIndex: index,
        supported: claim.supported,
      })),
      decision: run.gate.decision,
      reason: run.reason,
      // The numbers this verdict was reached under, from the policy engine's
      // own exported set rather than a pair written out here. Section 6
      // describes a rolling restart in which one consumer holds a fitted pair
      // and another the seeds, so a journal that records the verdict and not
      // the thresholds records a decision nobody can reproduce.
      thresholds: SEED_THRESHOLDS,
    });
  }
  // A gated run parks, whether or not a person has answered it yet. Without
  // this row `approveRun` throws rather than returning an outcome: it reads
  // the park record to derive the outbox key and the edit-distance baseline,
  // and a run in `awaiting_approval` with no park step is a state it treats
  // as a corrupt ledger.
  if (run.park !== null) {
    await step('park', 'done', run.park);
  }
  // The step that says why the run stopped. `src/escalations/query.ts` reads
  // the reason from here and from nowhere else, and that one statement serves
  // both `pnpm run escalations` and the operator console's runs list. Without
  // this row every seeded escalation reported a null reason to the person
  // working the queue, which reads exactly like an escalation nobody can
  // explain.
  //
  // The reason vocabulary is the coordinator's `EscalationReason`, not the
  // `PolicyReason` on the gate row above. They are disjoint sets of words for
  // two different questions, and writing one where the other belongs would
  // land every affected run in a column no reader recognises.
  //
  // The relay writes this row with its own pins where it escalates a delivery
  // it cannot confirm (DEC-30). This one still says 'seed', like every other
  // row the seeder writes, because that is what tells a reader the run is
  // synthetic; the run's own `prompt_ver` is what the escalation queue
  // surfaces, and it says the same.
  if (run.escalation !== null) {
    await step('escalate', 'done', { reason: run.escalation });
  }
  if (run.editDistance !== null) {
    await client.query('UPDATE run SET approval_edit_distance = $2 WHERE run_id = $1', [
      run.runId,
      run.editDistance,
    ]);
    // DEC-42: a run an approval reached records an approver. The seeded
    // history has no proxy in front of it, so it records what a console on an
    // unnamed bind records — which is the value an adopter reading a seeded
    // ledger should expect to see, rather than an invented operator name.
    await client.query('UPDATE run SET approved_by = $2 WHERE run_id = $1', [
      run.runId,
      UNATTRIBUTED,
    ]);
  }
}

/**
 * The outbox record an automatic write produces, if it produced one.
 *
 * Returned so `fencedInsert` commits it in the same transaction as the run
 * row (section 4.2 rule 1). It was written afterwards on a bare connection,
 * which put the state change and the outbox insert in different
 * transactions — the one thing that rule forbids.
 *
 * The key comes from the action's semantics, never from the run identity
 * (DEC-24; DEC-38 names the run id as the rejected alternative, and the
 * outbox column comment in db/001 states the rule verbatim).
 */
function outboxFor(run: PlannedRun): FencedOutboxInput | null {
  if (run.outbox.length === 0) return null;
  // The class the run itself evaluated, not a second one chosen here. An
  // internal class the automatic path really produces: 'reply' is not the
  // customer-reply class any adapter declares, so a reader of
  // outbox.action_class saw a class DEC-29 has no delivery rule for. A
  // constant here would have been the same defect one step on — the journal
  // now names the action, and an outbox row naming a different one would
  // contradict it inside a single run.
  const { actionClass, delivery, actionPayload: payload } = run;
  return {
    stepId: 'execute',
    idemKey: deriveIdemKey({
      actionClass,
      ticketId: run.ticketId,
      conversationId: run.conversationId,
      turnNumber: 1,
      payload,
    }),
    actionClass,
    delivery,
    payload,
  };
}

/** Writes the whole plan, oldest run first. */
export async function writeHistory(pool: Pool, plan: readonly PlannedRun[]): Promise<WriteReport> {
  let accepted = 0;
  let refused = 0;
  // Before the runs, because a `retrieve` row that named a document the index
  // does not hold is the shape this corpus exists to prevent. So a history
  // the ledger then refuses on the primary key leaves the corpus indexed and
  // no runs. That is the harmless order of the two: the upsert is idempotent
  // and the ids are `SYN-` scoped, whereas indexing after the first accepted
  // run would leave that run naming documents nothing holds.
  await writeDocuments(pool);
  for (const run of plan) {
    const input: FencedRunInput = {
      runId: run.runId,
      ticketId: run.ticketId,
      conversationId: run.conversationId,
      // DEC-35: every seeded run answers turn one of its conversation, which
      // is what `writeConversation` records and what the idem key derived
      // below already assumes.
      turnNumber: 1,
      partition: run.partition,
      epoch: 1n,
      state: run.state,
      // Named 'seed' so a reader can tell a seeded run from a produced one.
      //
      // Only `pnpm run escalations` surfaces it, and it does so because this
      // seeder exists: that report selects `escalated` and
      // `awaiting_approval`, which is most of a seeded history, and it showed
      // no pin at all. `pnpm run bands` and `pnpm run latency` still cannot
      // tell, which the intent file states as a residual risk.
      //
      // The latency reader keys `never_ran` on both pins reading 'intake',
      // which this is not, so a seeded run still contributes its service time.
      promptVer: 'seed',
      modelVer: 'seed',
      deadlineAt: new Date(run.createdAt.getTime() + 300_000),
      enqueuedAt: run.enqueuedAt,
    };
    let result;
    try {
      result = await fencedInsert(pool, input, outboxFor(run), {
        createdAt: run.createdAt,
        // Only for a state that has finished. `awaiting_approval` is waiting
        // for a person, and the clock seam refuses a finish for it.
        ...(run.finishedAt === null ? {} : { finishedAt: run.finishedAt }),
      });
    } catch (error) {
      // A duplicate primary key means this exact history is already in the
      // ledger. That is reproducibility working — one seed and one day always
      // give the same run ids — and it is a refusal, not a fault. Named,
      // because the raw driver error is a stack trace about nbtinsert.c.
      if ((error as { code?: string }).code === '23505') {
        throw new Error(
          `seed-history: the ledger already holds run ${run.runId}. This seed and`
            + ' these days were written before; truncate the ledger or choose'
            + ' another seed or another window.',
        );
      }
      throw error;
    }
    if (result.outcome !== 'accepted') {
      refused += 1;
      continue;
    }
    accepted += 1;
    const client = await pool.connect();
    // Held across the finally, so a connection whose ROLLBACK also failed is
    // destroyed rather than returned to the pool still inside a transaction.
    let failure: Error | undefined;
    try {
      await client.query('BEGIN');
      await writeConversation(client, run);
      await writeJournal(client, run);
      // The relay writes 'pending' and then marks a delivery it cannot
      // confirm (DEC-30). So the seeded row takes the same two steps rather
      // than being born unknown, which is a state the relay never writes.
      for (const status of run.outbox) {
        await client.query('UPDATE outbox SET status = $2 WHERE run_id = $1', [
          run.runId,
          status,
        ]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      // The run row and its outbox committed in the transaction above, and
      // this one carries the conversation, the journal and the outbox status.
      // So a throw here leaves the ledger holding a run with no history, and
      // a re-run hits the duplicate-key refusal, whose message says the
      // history was written before rather than half-written. Name it, or the
      // operator's only clue is a message pointing at the wrong remedy.
      failure = new Error(
        `seed-history: run ${run.runId} committed without its journal, so the ledger is`
          + ' part-written. Truncate it before seeding again.',
        { cause: error },
      );
      throw failure;
    } finally {
      client.release(failure);
    }
  }
  return { accepted, refused };
}
