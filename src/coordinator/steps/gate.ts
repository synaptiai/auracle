// The gate step (section 4.7, DEC-05, DEC-07, DEC-12).
//
// Two independent gates, never blended into one score. Agreement was
// measured at `classify` and sits on that row; coverage is measured here.
// `evaluatePolicyDetailed` returns `gated` before agreement is compared for
// a customer reply, a high-risk intent, an irreversible write, or a missing
// capability, so the journalled reason says which rule decided.
import { checkGroundedness } from '../../groundedness/groundedness.js';
import { UnreadableAnswerError } from '../../models/provider.js';
import { COMPENSATION_ACTION_CLASS } from '../../adapters/types.js';
import { CoordinatorFaultError } from '../fault.js';
import { SEED_THRESHOLDS, evaluatePolicyDetailed } from '../../policy/policy.js';
import { recordGateLatestOrSkip } from '../../routing/latest.js';
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

export async function gate(ctx: RunContext): Promise<StepResult> {
  const classification = stateAfter(ctx.state, 'classification', 'gate', 'classify');
  const docs = stateAfter(ctx.state, 'docs', 'gate', 'retrieve');
  const composed = stateAfter(ctx.state, 'composed', 'gate', 'compose');

  const gateLimit = limitHit(ctx);
  if (gateLimit !== null) return { kind: 'escalate', reason: gateLimit };

  // Before the journal row and before the judge call, because this refuses
  // rather than acts. `classify` refuses a label the taxonomy does not hold,
  // so reaching here means the taxonomy this run gated against is not the one
  // it classified against. A defect, not a model answer: it escalates as
  // `internal_fault` rather than escaping the walk (issue #94).
  //
  // Below `journalStart` it left a 'gate' row at status 'started' with a null
  // result forever — the shape this issue removes from `park` — and paid for a
  // coverage judge on a run certain to fault.
  const intent = ctx.deps.taxonomy.intents.find((i) => i.id === classification.intentId);
  if (intent === undefined) {
    throw new CoordinatorFaultError(
      `classified intent ${classification.intentId} is absent from the taxonomy`,
    );
  }

  await journalStart(ctx, 'gate');
  // The composer's own claim partition, not a re-split of the joined draft.
  // Every claim here already carries a citation the composer resolved to a
  // retrieved document (DEC-07), so the coverage denominator is fixed by the
  // composer rather than chosen by a second model call.
  let grounded;
  try {
    grounded = await checkGroundedness(
      {
        claims: composed.claims.map((claim) => claim.text),
        retrievedTexts: docs.map((doc) => doc.body),
      },
      { provider: ctx.meter.provider, versions: ctx.deps.pins },
    );
  } catch (error) {
    // A fault, not a verdict, and not transient: the judge runs at
    // temperature 0, so the retry ceiling would spend a full pipeline run per
    // scan and file an orphan run each time, then abandon. Finish the step and
    // escalate here, so the run reaches a terminal state, the spend reaches
    // the ledger, and an operator sees the reason (DEC-25, DEC-30).
    if (error instanceof UnreadableAnswerError) {
      ctx.progress.stepsUsed++;
      await journalFinish(ctx, 'gate', 'failed', {
        shape: error.shape,
        ...(error.costUnknown ? { costUnknown: true } : {}),
        error: error.message,
      });
      return { kind: 'escalate', reason: 'gate_unreadable' };
    }
    throw error;
  }
  const gateThresholds = ctx.deps.thresholds ?? SEED_THRESHOLDS;
  const outcome = evaluatePolicyDetailed({
    riskTier: intent.risk_tier,
    // DEC-41: the gate reads the threshold fitted for this intent when the
    // artifact carried one. Without this the map is present and never read.
    intent: classification.intentId,
    agreement: classification.agreement,
    groundedness: grounded.groundedness,
    thresholds: gateThresholds,
    capabilities: ctx.deps.capabilities,
    action: {
      isWrite: true,
      isCustomerVisible: ctx.input.isCustomerVisible,
      // DEC-34: an irreversible action always gates, whatever the gates
      // read. Derived from the class, so a caller cannot mark a
      // compensation reversible.
      isIrreversible: ctx.input.actionClass === COMPENSATION_ACTION_CLASS,
    },
  });
  const decision = outcome.decision;
  ctx.progress.stepsUsed++;
  await journalFinish(ctx, 'gate', 'done', {
    groundedness: grounded.groundedness,
    // Which claim the judge did not support, beside the fraction rather than
    // instead of it. The fraction is what `evaluatePolicy` read, and a reader
    // renders that value rather than recounting it from these: two numbers
    // computed twice will disagree, and only one of them decided anything.
    //
    // Coverage detail, and coverage only. Agreement sits on the `classify`
    // row and nothing here touches it, so DEC-05 holds: the ledger still
    // never holds the two gates in one object.
    // The claim's position, not its text. The compose row already holds every
    // sentence of the draft, so storing the text here would put the drafted
    // reply in the ledger a second time — and two copies are two places an
    // erasure path has to reach, and two things that can drift.
    //
    // The position is into the cited sentences, in draft order, which is what
    // `composed.claims` is. A courtesy sentence never enters that list, so a
    // reply that opens with one does not shift a verdict onto the wrong
    // claim (DEC-43).
    //
    // The index is sound because `checkGroundedness` drops a blank claim and
    // the composer cannot emit one: `parseClaims` trims each line before its
    // pattern runs, so the captured text ends on a non-whitespace character.
    // `composer.test.ts` holds that shut, because an index into a list that
    // silently lost a member would attribute every later verdict to the
    // wrong claim.
    claimVerdicts: grounded.claims.map((claim, index) => ({
      claimIndex: index,
      supported: claim.supported,
    })),
    decision,
    // Which rule decided, not only what it decided. `gated` alone is
    // ambiguous between a rule that returns before the agreement gate is
    // read and the groundedness review band, which reaches that gate and
    // passes it. A reader that could not tell those apart would count a
    // customer reply as a gate failure, and the rate would then track
    // traffic mix instead of the classifier (DEC-05, DEC-12).
    reason: outcome.reason,
    // The tier the engine judged this intent at (DEC-13). A rule tested
    // earlier, such as a customer reply, returns before the high-risk rule,
    // so `reason` alone never says a waiting reply is high risk. The queue
    // reads this to put that reply first. Recorded rather than looked up
    // later, because the taxonomy can change after the run.
    riskTier: intent.risk_tier,
    // Section 6 documents a rebalance window where two consumers overlap, and
    // each resolves its thresholds once at startup. During a rolling restart
    // one consumer can run a fitted number and the other the seed, and
    // identical evidence then decides differently. Without this the journal
    // records the verdict and nothing that explains it (DEC-26 pins versions
    // for the same reason).
    thresholds: gateThresholds,
  });
  ctx.state.decision = decision;
  // Issue #112: the latest gate of this product and intent, for the routing
  // screen. In the transition's own commit, so a consumer the fence refused
  // records nothing (DEC-28). A write that cannot finish is skipped and
  // logged, and never stops the run.
  const gated = await transitionOrStop(ctx, 'gated', undefined, (client) => recordGateLatestOrSkip(client, {
    runId: ctx.runId,
    intentId: classification.intentId,
    reason: outcome.reason,
    thresholds: gateThresholds,
  }));
  if (gated !== null) return { kind: 'stop', outcome: gated };

  // DEC-07 and DEC-12: the verdict decides the branch, and the sequencer
  // reads `ctx.state.decision` to take it. An escalate answers here, so
  // every DEC-25 reason is written in one place.
  if (decision === 'escalate') return { kind: 'escalate', reason: 'policy_escalated' };
  return CONTINUE;
}
