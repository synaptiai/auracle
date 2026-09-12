// The intent labeller, and the score that makes its labels readable
// (issue #26, DEC-41).
//
// DEC-41 fits a threshold for each intent above the labelled-case trigger,
// and it requires two things of every such threshold: each case says what
// labelled it, and the artifact says how accurate that labeller was.
//
// The second is measurable in this repository and nowhere else.
// `scripts/generate-fixtures.mjs` assigns each synthetic case its true
// intent, so a case carries `intent` as ground truth and `labelled_intent`
// beside it. A labeller that overwrote the truth would leave nothing to score
// against, and the artifact's agreement rate would be a number with no
// referent.
//
// The stand-in is deterministic and offline, and it labels the committed
// corpus: CI regenerates that corpus and diffs it, so a live call could never
// sit in the generator.
//
// A model kind exists in the artifact's closed set and **no producer ships
// for it**. An adopter labelling their own history writes that producer and
// records `model`; nothing in this repository does. The kind is recorded
// either way, because a stand-in's agreement is a property of the stand-in
// and naming the kind is what stops a reader taking it for a model's score.
// Saying the kind exists is not the same as saying a command fills it, and an
// earlier version of this comment named a `pnpm run label-corpus` that was
// never written.
import type { GoldTicket } from '../domain/gold-types.js';

/** The pin the committed corpus carries. */
export const STUB_LABELLER_PIN = 'stub-labeller-v1';

/** How often the stand-in agrees with the truth. */
const STUB_AGREEMENT = 0.92;

export interface IntentLabeller {
  readonly kind: 'stub' | 'model';
  /** Names the labeller in the corpus and in the artifact. */
  readonly pin: string;
  /** The intents it may choose from, with the queue each belongs to. */
  readonly intents: readonly { id: string; queue: string }[];
}

/**
 * A unit value derived from the case id alone (FNV-1a).
 *
 * Keyed on the case and never on a stream, so this module and the generator
 * compute the same value with no shared state. A label drawn from the
 * generator's PRNG would depend on generation order, and nothing outside that
 * file could reproduce it — which is what the corpus check below relies on.
 */
export function unitFromId(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash / 4294967296;
}

/**
 * The deterministic stand-in.
 *
 * Its errors go to a sibling intent in the same queue, because that is the
 * confusion a classifier makes. A uniformly random error would give the fit a
 * shape no deployment produces, and a per-intent threshold fitted against it
 * would be calibrated for a mistake nobody makes.
 */
export function stubLabeller(
  intents: readonly { id: string; queue: string }[],
): IntentLabeller {
  return { kind: 'stub', pin: STUB_LABELLER_PIN, intents };
}

/**
 * The intent-to-queue map, read off the cases themselves.
 *
 * The shipped `taxonomy.json` carries no queue, and a table copied into this
 * module would be a second source that drifts. The corpus is the one source
 * that already holds the pairing.
 *
 * The queue taken is the intent's own, not the one a case was routed to.
 * `scripts/generate-fixtures.mjs` sends about one case in seven to `general`
 * whatever its intent, so a ticket's queue is where it landed and the
 * intent's queue is what it is about. Confusion belongs to the subject: a
 * classifier mistakes an intent for an adjacent one, not for whatever else
 * shares an overflow queue.
 *
 * The intent's own queue is the most frequent one across its cases, because
 * the routed minority is by construction a minority.
 */
export function intentsFrom(
  cases: readonly Pick<GoldTicket, 'intent' | 'queue'>[],
): { id: string; queue: string }[] {
  const tally = new Map<string, Map<string, number>>();
  for (const ticket of cases) {
    const byQueue = tally.get(ticket.intent) ?? new Map<string, number>();
    byQueue.set(ticket.queue, (byQueue.get(ticket.queue) ?? 0) + 1);
    tally.set(ticket.intent, byQueue);
  }
  return [...tally].map(([id, byQueue]) => {
    // Ties break on the queue name, so the map never depends on case order.
    const ranked = [...byQueue].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return { id, queue: ranked[0]![0] };
  });
}

/** The queue an intent is about, from the same map. */
function queueOf(labeller: IntentLabeller, intent: string): string | undefined {
  return labeller.intents.find((i) => i.id === intent)?.queue;
}

/** The label `labeller` gives one case. */
export function labelWith(
  labeller: IntentLabeller,
  ticket: Pick<GoldTicket, 'ticket_id' | 'intent' | 'queue'>,
): string {
  const rnd = unitFromId(ticket.ticket_id);
  if (rnd < STUB_AGREEMENT) return ticket.intent;
  const subject = queueOf(labeller, ticket.intent);
  // Sorted by id, so the choice does not depend on the order the taxonomy was
  // declared in. The generator sorts the same way.
  const siblings = labeller.intents
    .filter((i) => i.queue === subject && i.id !== ticket.intent)
    .map((i) => i.id)
    .sort();
  if (siblings.length === 0) return ticket.intent;
  const spread = (rnd - STUB_AGREEMENT) / (1 - STUB_AGREEMENT);
  return siblings[Math.min(siblings.length - 1, Math.floor(spread * siblings.length))]!;
}

export interface LabellerScore {
  total: number;
  agreed: number;
  /** `agreed / total`. The figure DEC-41 puts in the artifact. */
  agreement: number;
}

/**
 * Scores a labeller's labels against the generator's ground truth.
 *
 * A case with no label is refused rather than skipped. Skipping it would
 * divide by the cases that happened to carry a label, and report a labeller
 * as more accurate than its own coverage.
 */
export function scoreLabeller(
  cases: readonly Pick<GoldTicket, 'intent' | 'labelled_intent'>[],
): LabellerScore {
  let agreed = 0;
  for (const ticket of cases) {
    if (ticket.labelled_intent === undefined || ticket.labelled_intent === '') {
      throw new Error(
        `a case carries no label, so the agreement rate would count it as neither `
          + `right nor wrong while still dividing by it (intent ${ticket.intent})`,
      );
    }
    if (ticket.labelled_intent === ticket.intent) agreed += 1;
  }
  const total = cases.length;
  return { total, agreed, agreement: total === 0 ? 0 : agreed / total };
}
