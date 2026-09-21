// The park step: a gated action waits for a person (DEC-12, DEC-11).
//
// Two branches, one step id. A gated write with no customer draft parks in
// the ledger alone. A customer reply parks inside the target system, and
// that branch writes an intermediate 'parking' row first, because
// `createDraft` reaches the helpdesk before the ledger can record what it
// created.
//
// This step takes no DEC-25 limit check, and must not gain one. The five
// other steps check before they act; park runs after the reply is already
// composed, and a run that stopped here would leave a person with no draft
// to approve and the composer's spend already paid. `steps.test.ts` holds
// that asymmetry shut.
import type { Pool } from 'pg';

import { PermanentEgressError } from '../../adapters/types.js';
import type { ReplyProvenance } from '../../adapters/types.js';
import { parkGatedReply } from '../../approval/bridge.js';
import { errorMessage } from '../../errors.js';
import { deriveIdemKey } from '../../ledger/keys.js';
import type { PinnedVersions } from '../../models/provider.js';
import {
  journalFinish,
  journalStart,
  stateAfter,
  transitionOrStop,
  type RunContext,
  type StepResult,
} from './context.js';

/**
 * DEC-33 provenance for text this system composed: the pinned model and
 * prompt versions plus the composition time, in ISO 8601.
 */
function replyProvenanceFor(pins: PinnedVersions): ReplyProvenance {
  return {
    generatedBy: 'auracle',
    modelId: pins.modelVer,
    promptVer: pins.promptVer,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * True when an earlier run on this ticket began parking a draft and never
 * recorded the outcome.
 *
 * `createDraft` mutates the target system before the ledger learns the draft
 * handle. A crash in that window leaves a draft nobody can name: the journal
 * row is still 'parking' and carries no handle. Parking again would put a
 * second draft in front of the customer, so the retry escalates instead and
 * a person reconciles the one that is already there.
 */
async function priorParkUnresolved(
  pool: Pool,
  ticketId: string,
  runId: string,
): Promise<boolean> {
  const rows = await pool.query(
    `SELECT 1
       FROM step_journal sj
       JOIN run r ON r.run_id = sj.run_id
      WHERE r.ticket_id = $1
        AND sj.step_id = 'park'
        AND sj.status = 'parking'
        AND sj.run_id <> $2
      LIMIT 1`,
    [ticketId, runId],
  );
  return rows.rows.length > 0;
}

export async function park(ctx: RunContext): Promise<StepResult> {
  const draft = stateAfter(ctx.state, 'draft', 'park', 'compose');

  // Before the journal row, because this refuses rather than acts. The check
  // is one SELECT and changes nothing, so DEC-04 still holds: the row below is
  // written before the first thing this step does to the world, and a read is
  // not one of those things. Journalling first left
  // a 'park' row at status 'started' with a null result forever on every
  // refusal — a step the ledger says began and nothing says ended (issue #94).
  //
  // Guarded on the customer branch, which is the only one that parks in the
  // target system and so the only one a half-finished prior park can concern.
  if (ctx.input.isCustomerVisible
    && await priorParkUnresolved(ctx.pool, ctx.input.ticketId, ctx.runId)) {
    return { kind: 'escalate', reason: 'park_unresolved' };
  }

  await journalStart(ctx, 'park');

  if (!ctx.input.isCustomerVisible) {
    // DEC-34: a gated write with no customer draft parks in the ledger.
    // No adapter call: such a write has nothing to park in the helpdesk
    // (DEC-11), and approval queues a `performAction` record, not a
    // `sendDraft` one. Compensation is one case; a high-risk internal
    // write and one with mediocre coverage reach this branch too. The composed text is the rationale a
    // person reads when approving; it also keeps the edit-distance
    // measurement (section 4.10) available. The action payload goes
    // into the journal verbatim: approveRun copies it onto the outbox.
    ctx.progress.stepsUsed++;
    await journalFinish(ctx, 'park', 'done', {
      actionClass: ctx.input.actionClass,
      delivery: ctx.input.delivery,
      body: draft,
      payload: ctx.input.actionPayload,
      // DEC-38: approval derives the outbox key from this record, so the
      // turn has to survive the wait. Without it, one request per turn
      // would collapse into one key and the later turn would be dropped.
      ...(ctx.input.turnNumber === undefined ? {} : { turnNumber: ctx.input.turnNumber }),
      // DEC-49: and the attempt with it, for the same reason. An approval of
      // a later attempt that derived the first attempt's key would lose the
      // outbox insert and stop the run superseded.
      ...(ctx.input.attempt === undefined ? {} : { attempt: ctx.input.attempt }),
    });
    const awaiting = await transitionOrStop(ctx, 'awaiting_approval');
    if (awaiting !== null) return { kind: 'stop', outcome: awaiting };
    return { kind: 'stop', outcome: { runId: ctx.runId, outcome: 'awaiting_approval', draftExternalId: null } };
  }

  // The approval path, including every customer reply (DEC-12). The bridge
  // parks the draft inside the target system (DEC-11) with the disclosure
  // and machine-readable provenance attached (DEC-14, DEC-33); a refusal
  // throws before any adapter call. The parked handle goes into the
  // journal, then the run stops at 'awaiting_approval'. No outbox record
  // yet: the approve entrypoint inserts it after a person approves.
  //
  // `createDraft` reaches the customer's helpdesk before the ledger can
  // record what it created. An earlier run that died in that window left a
  // draft with no handle in the journal; parking again would show the
  // customer two. So the ledger states the intent first, and a run that
  // finds an unresolved one escalates for a person to reconcile — which the
  // check at the top of this step has already done by the time you read this.
  // DEC-24: the park's key comes from the action and the ticket, never
  // from this run. Two runs of the same park derive the same key, so the
  // adapter recognises the repeat and returns the first draft.
  //
  // DEC-49 answered the caution this comment used to carry. Nothing in the
  // key as it stood distinguished a retry from a fresh attempt after a
  // person rejected the draft, so a reject path would have derived this same
  // key and the adapter would have handed back the rejected draft. The
  // attempt separates them, and it is action semantics: it says what a
  // person asked for. A digest of the composed body fails — a crash retry
  // retrieves again, and a document can pass its review date in between, so
  // the retry would compose different text and park a second draft. The run
  // id stays forbidden (DEC-24).
  const parkKey = deriveIdemKey({
    actionClass: `${ctx.input.actionClass}:park`,
    ticketId: ctx.input.ticketId,
    ...(ctx.input.turnNumber === undefined ? {} : { turnNumber: ctx.input.turnNumber }),
    // DEC-35: the conversation the turn belongs to. A turn number alone is
    // not unique — db/012 can put two conversations on one ticket.
    conversationId: ctx.input.conversationId ?? null,
    ...(ctx.input.attempt === undefined ? {} : { attempt: ctx.input.attempt }),
    payload: ctx.input.actionPayload,
  });
  await journalFinish(ctx, 'park', 'parking', {
    actionClass: ctx.input.actionClass,
    delivery: ctx.input.delivery,
    parkKey,
  });

  // The 'parking' row above is the crash marker: it says a draft may exist
  // that nobody can name, and priorParkUnresolved escalates every later run
  // on this ticket while it stands. That is right for a crash and wrong for
  // a throw we can see, which proves the adapter did NOT get as far as
  // appending. Leaving the marker for one of those poisons the ticket
  // permanently: every future run escalates park_unresolved with no draft
  // anywhere to reconcile.
  // DEC-44: the disclosure and the provenance are what every send of this
  // reply carries (DEC-14, DEC-33). On an adapter whose helpdesk cannot send
  // the copy it parks, the approval sends the reply from the ledger, so both
  // have to survive the wait beside the body.
  const provenance = replyProvenanceFor(ctx.deps.pins);
  let parked;
  try {
    parked = await parkGatedReply(ctx.deps.egress, {
      ticketExternalId: ctx.input.ticketId,
      body: draft,
      disclosure: ctx.input.disclosure,
      provenance,
      idemKey: parkKey,
      expectedRecipient: ctx.input.customerAddress ?? null,
    });
  } catch (error) {
    await journalFinish(ctx, 'park', 'failed', {
      actionClass: ctx.input.actionClass,
      delivery: ctx.input.delivery,
      parkKey,
      error: errorMessage(error),
    });
    // A permanent refusal must not go round the retry loop. The queue's
    // attempt ceiling is sized for a transient fault, so a refused recipient
    // would otherwise spend a full pipeline run and file an orphan run row
    // on every scan until it hit that ceiling.
    if (error instanceof PermanentEgressError) {
      return { kind: 'escalate', reason: 'egress_refused' };
    }
    throw error;
  }
  ctx.progress.stepsUsed++;
  await journalFinish(ctx, 'park', 'done', {
    draftExternalId: parked.draftExternalId,
    actionClass: ctx.input.actionClass,
    delivery: ctx.input.delivery,
    // DEC-38: the turn survives the wait, so approval derives the key this
    // turn's request deserves.
    ...(ctx.input.turnNumber === undefined ? {} : { turnNumber: ctx.input.turnNumber }),
    // DEC-49: and the attempt with it. The approval derives its outbox key
    // from this row, so an attempt left out here derived the first attempt's
    // key — and only the draft handle in the payload kept the two apart.
    ...(ctx.input.attempt === undefined ? {} : { attempt: ctx.input.attempt }),
    // The parked body, exactly as it entered the target system. The
    // approve entrypoint measures the person's edit against it
    // (section 4.10) from the ledger alone.
    body: draft,
    // DEC-44: both travel with it, so an approval that sends this reply from
    // the ledger can attach what the adapter would have attached.
    disclosure: ctx.input.disclosure,
    provenance,
  });
  const awaiting = await transitionOrStop(ctx, 'awaiting_approval');
  if (awaiting !== null) return { kind: 'stop', outcome: awaiting };
  return {
    kind: 'stop',
    outcome: {
      runId: ctx.runId,
      outcome: 'awaiting_approval',
      draftExternalId: parked.draftExternalId,
    },
  };}
