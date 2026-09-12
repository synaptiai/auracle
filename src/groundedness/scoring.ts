// The scoring pass both coverage jobs share (section 4.7, DEC-31).
//
// One job chooses the thresholds on the fit half and the other measures them
// on the report half. They differ in what they do with the samples and in
// nothing else, so the pass that produces those samples lives here rather than
// in both. Two copies of a retry loop is one copy that gets a fix and one that
// silently does not.
import { label } from '../fixtures/validate.js';
import type { GoldSource, GoldTicket } from '../domain/gold-types.js';
import type { ModelProvider } from '../models/provider.js';
import { UnreadableAnswerError } from '../models/provider.js';
import { scoreDraft } from './run.js';
import type { ScoredDraft } from './run.js';
import type { CoverageSample } from './fit.js';
import { createHash } from 'node:crypto';

import type { ResumeCost, ResumeStore } from './resume.js';
import { errorMessage } from '../errors.js';

/**
 * Attempts a draft gets when the transport, not the answer, fails.
 *
 * A run over a half of this size makes some four thousand calls across hours,
 * and it holds no checkpoint. One connection that drops discarded every draft
 * scored before it, which is what happened on the first run at this size.
 *
 * Only a transport fault is retried. An `UnreadableAnswerError` is an answer
 * the provider will reproduce, so repeating the call spends money to receive
 * the same thing; that draft is dropped and counted instead.
 *
 * DEC-30 does not reach this. That rule governs a delivery whose state is
 * unknown, where a repeat can duplicate an effect a customer sees. A judging
 * call reads, delivers nothing outside this process, and duplicates nothing.
 */
export const TRANSPORT_ATTEMPTS = 5;

/**
 * Milliseconds before the first retry. Each later attempt waits four times
 * longer, so five attempts span roughly two minutes.
 *
 * A flat two seconds was not enough. The first run with a retry still died:
 * one draft drew three transport faults within seconds of each other, because
 * an outage lasts longer than the gap between two immediate attempts.
 */
export const DEFAULT_RETRY_DELAY_MS = 2_000;

/**
 * Refuse a half citing a document this repository cannot resolve.
 *
 * Before the first model call, because the check needs no provider. Inside the
 * scoring loop it would only delay the news: a half citing an unknown document
 * would fail after hours of paid calls rather than in the first second.
 *
 * It also keeps the retry honest. That loop cannot tell a fault it should
 * repeat from one it should not, and an unknown document is a fault no
 * repetition fixes, so retrying one spends the whole backoff to arrive where
 * it started.
 */
export function assertDocumentsResolvable(
  drafts: readonly GoldTicket[],
  bodies: ReadonlyMap<string, string>,
  source: GoldSource,
): void {
  for (const ticket of drafts) {
    for (const claim of ticket.claims ?? []) {
      if (!bodies.has(claim.doc_id)) {
        throw new Error(
          `gold case ${label(ticket.ticket_id, source)} cites unknown document `
            + `${label(claim.doc_id, source)}`,
        );
      }
    }
  }
}

/**
 * A digest of everything the judge is actually asked, for the resume header.
 *
 * The half digest names the CASES a run covered, which is what the DEC-31
 * proof needs. It cannot see a corpus whose claims changed under fixed ticket
 * ids: edit a claim's wording, flip a support label or rewrite a cited
 * document, and a resumed run happily reuses samples scored against the old
 * text. This covers the claim sentence, its label, and the body it is judged
 * against, so any of those moving retires the file.
 *
 * Digested, never listed: on a real half the claim text is the customer's own
 * and the document is the adopter's (DEC-18).
 */
export function scoringDigest(
  drafts: readonly GoldTicket[],
  bodies: ReadonlyMap<string, string>,
): string {
  const rows = drafts.flatMap((ticket) => (ticket.claims ?? []).map((claim) => [
    ticket.ticket_id,
    createHash('sha256').update(claim.text).digest('hex'),
    claim.supported ? '1' : '0',
    claim.grade ?? '',
    createHash('sha256').update(bodies.get(claim.doc_id) ?? '').digest('hex'),
  ].join('\u0000')));
  // Sorted, so the order the corpus happens to list its drafts in cannot
  // retire a file that covers the same work.
  return createHash('sha256').update(rows.sort().join('\n')).digest('hex').slice(0, 16);
}

export interface ScoredHalf {
  readonly samples: CoverageSample[];
  /** The cases the judge could not score, named as the half's provenance allows. */
  readonly faulted: string[];
  /**
   * How many drafts each fault shape accounted for.
   *
   * The count alone cannot say why a half was dropped. On the 2124-case
   * corpus this repository shipped before the growth to 8200, the report half
   * lost 146 drafts of 1062 where the fit half lost 6. A bare count leaves an
   * operator guessing between a corpus that reads badly and a provider having
   * a bad hour. The shape names which. The figures are that corpus's and have
   * not been re-measured, because measuring them costs a model run.
   */
  readonly faultShapes: Map<string, number>;
  /**
   * What this half cost, in micro-dollars, across every run that produced it
   * (DEC-25).
   *
   * A resumed run adds the spend recorded by the runs before it, because the
   * artifact names one fit and that fit was paid for across all of them.
   * Reporting only this process's calls would understate a five-hour job by
   * however much of it survived an outage.
   */
  readonly costMicros: number;
  /**
   * True when the figure above is a floor rather than a total.
   *
   * Set by a faulted draft, whose already-judged claims cost money the error
   * does not carry, and by a transport retry, whose unanswered attempt may
   * still have been billed. Eight absorbed samples reported as free is the
   * largest understatement this system can make, so it says so instead.
   */
  readonly costUnknown: boolean;
}

/** Score every draft, retrying a dropped connection and counting a bad answer. */
export async function scoreHalf(
  drafts: readonly GoldTicket[],
  bodies: ReadonlyMap<string, string>,
  provider: ModelProvider,
  pins: { promptVer: string; modelVer: string },
  source: GoldSource,
  retryDelayMs: number,
  /**
   * Where a run that dies picks up. Absent means no resume, which is what the
   * suite wants: a case that scripts twelve drafts should not leave a file
   * behind for the next case to find.
   */
  resume?: ResumeStore,
): Promise<ScoredHalf> {
  const samples: CoverageSample[] = [];
  const faulted: string[] = [];
  const faultShapes = new Map<string, number>();
  let resumed = 0;
  let costMicros = 0;
  let costUnknown = false;
  for (const ticket of drafts) {
    // Already scored by an earlier run of this same half, model and prompt.
    // The store refuses a file describing any other run, so a hit here is the
    // draft this loop would have paid for.
    if (resume !== undefined) {
      const key = resume.idKey(ticket.ticket_id);
      if (resume.done.has(key)) {
        const held = resume.done.get(key) ?? null;
        // Spend an earlier run paid for this same draft. It belongs to the
        // artifact this run writes, not to the run that happened to die.
        const spent = resume.cost.get(key);
        if (spent === undefined) costUnknown = true;
        else costMicros += spent.costMicros;
        if (spent?.costUnknown === true) costUnknown = true;
        if (held === null) {
          faulted.push(label(ticket.ticket_id, source));
          // The shape is not carried across a restart. The count is what the
          // ceiling reads, and a resumed run says how many it took on trust.
          faultShapes.set('resumed', (faultShapes.get('resumed') ?? 0) + 1);
        } else {
          samples.push(held);
        }
        resumed += 1;
        continue;
      }
    }
    // Whether THIS draft drew a transport fault. The run-level flag alone
    // does not survive a restart: it lives in memory, and the row written for
    // a draft that eventually succeeded said the spend was exact. A resumed
    // run then read every row as exact and published a floor as a total,
    // which is the one thing DEC-25 forbids.
    let retried = false;
    for (let attempt = 1; ; attempt++) {
      let scored: ScoredDraft;
      try {
        scored = await scoreDraft(ticket, bodies, provider, pins, source);
      } catch (error) {
        // An answer the provider will reproduce. Dropped and counted, and the
        // caller's attrition ceiling decides whether the run still means
        // anything.
        if (error instanceof UnreadableAnswerError) {
          faulted.push(label(ticket.ticket_id, source));
          faultShapes.set(error.shape, (faultShapes.get(error.shape) ?? 0) + 1);
          // The failing call's own spend is known; the claims of this draft
          // already judged are not, because the error is raised out of the
          // middle of that loop. So the total becomes a floor.
          costMicros += error.costMicros;
          costUnknown = true;
          await checkpoint(resume, ticket.ticket_id, null, {
            costMicros: error.costMicros, costUnknown: true,
          });
          break;
        }
        // A transport that never recovers still fails the run. A retry with no
        // ceiling is a hang, and an operator waiting on a four-hour job cannot
        // tell a hang from slow progress.
        if (attempt >= TRANSPORT_ATTEMPTS) throw error;
        // An attempt that never answered may still have been billed, and
        // nothing here can tell. The draft's spend below is therefore a floor,
        // and the checkpoint must say so or a restart loses the qualifier.
        costUnknown = true;
        retried = true;
        // The draft restarts, so its earlier claims are asked again. They read
        // and deliver nothing, so the repeat costs money and duplicates no
        // effect. The case identifier is redacted on a real half (DEC-18).
        console.warn(
          `transport fault on gold case ${label(ticket.ticket_id, source)}, `
            + `attempt ${attempt} of ${TRANSPORT_ATTEMPTS}: ${errorText(error)}`,
        );
        // Exponential, because the faults arrive in a cluster: three immediate
        // attempts all landed inside one outage and the run died with the
        // retry working exactly as written.
        const wait = retryDelayMs * 4 ** (attempt - 1);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      // The checkpoint is written BEFORE the sample joins the run, and the
      // write sits outside the try. Both matter. With the push first and the
      // write inside, a failed write was not an UnreadableAnswerError, so it
      // fell through to the transport arm: the draft was scored again and the
      // sample already pushed stayed. One draft then contributed three
      // samples to an interval whose entire purpose is to carry its own
      // sample size honestly, and the run did not fail, so nothing said so.
      costMicros += scored.costMicros;
      // Both sources of doubt reach the run AND the file. `scored.costUnknown`
      // is false today, because scoreDraft returns a complete measurement; it
      // is read rather than assumed so the first partial-cost path added there
      // cannot go unreported.
      if (scored.costUnknown) costUnknown = true;
      await checkpoint(resume, ticket.ticket_id, scored.sample, {
        costMicros: scored.costMicros, costUnknown: scored.costUnknown || retried,
      });
      samples.push(scored.sample);
      break;
    }
  }
  if (resumed > 0) {
    console.warn(`resumed ${resumed} of ${drafts.length} drafts from an earlier run`);
  }
  return { samples, faulted, faultShapes, costMicros, costUnknown };
}

/**
 * Records one draft's outcome, or fails the run.
 *
 * A write fault is not a transport fault and is never retried against the
 * provider: the answer is already paid for, and asking for it again cannot
 * make the disk work. It stops the run instead of being absorbed, because a
 * run that cannot checkpoint has lost the one guarantee it was started for,
 * and an operator who is not told keeps believing the file is current.
 */
async function checkpoint(
  resume: ResumeStore | undefined,
  ticketId: string,
  sample: CoverageSample | null,
  cost: ResumeCost,
): Promise<void> {
  if (resume === undefined) return;
  try {
    await resume.record(ticketId, sample, cost);
  } catch (error) {
    throw new Error(
      `the resume file could not be written, so this run can no longer be `
        + `continued: ${errorText(error)}`,
      { cause: error },
    );
  }
}

/**
 * The fault tally, as one line an operator can act on.
 *
 * Ties break on the shape's own name, never on the order the corpus happened
 * to fault in. Sorting by count alone left the ordering dependence intact
 * wherever two causes drew level, and the runbook sends an operator to a
 * different remedy for each, so the arrival order decided where they were
 * sent. Written once and shared, because both jobs report the same tally and
 * a second copy is a second chance to sort it differently.
 */
export function describeFaultShapes(shapes: ReadonlyMap<string, number>): string {
  return [...shapes]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .map(([shape, n]) => `${shape} ${n}`)
    .join(', ');
}

/**
 * The spend, as a line an operator reads before deciding to fit again.
 *
 * Micro-dollars are the ledger's unit (DEC-25) and stay the recorded one, but
 * nobody sizes a bill in them, so the line carries dollars too. A floor says
 * it is a floor: reporting one as a total is the understatement the qualifier
 * exists to prevent.
 */
export function describeSpend(costMicros?: number, costUnknown?: boolean): string {
  if (costMicros === undefined) return 'not recorded';
  const dollars = (costMicros / 1_000_000).toFixed(4);
  return costUnknown === true
    ? `at least ${costMicros} micro-dollars (${dollars} USD); some calls could not be attributed`
    : `${costMicros} micro-dollars (${dollars} USD)`;
}

/** The message of a thrown value, whatever it is. */
function errorText(error: unknown): string {
  return errorMessage(error);
}
