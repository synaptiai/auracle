/**
 * A synthetic traffic history, planned before anything is written (issue #23).
 *
 * Pure. It opens no connection, reads no clock and calls no model, so the
 * same seed always yields the same history. That is the whole point: a band
 * built from a history nobody can reproduce is a number nobody can check.
 *
 * ## What this models, and why it is not tuned
 *
 * Issue #25's evidence gate reads `pnpm run latency` against this history and
 * decides which correction head-of-line delay needs. So a history built to
 * make one rule fire would seed the check with the material meant to verify
 * it, and the gate would be reading its own answer back.
 *
 * Every parameter below therefore comes from the system's shape, never from a
 * wanted verdict:
 *
 * - **Service time is heavy-tailed** because a run makes nine classifier
 *   samples at a temperature above zero (section 4.5), an embedding, a
 *   composition and a groundedness check. Model latency is long-tailed, and a
 *   run that makes twelve calls inherits that tail. Drawn log-normal.
 * - **Partition depth is uniform** because `partitionOf` hashes the
 *   conversation id (DEC-36) and a hash spreads evenly. Nothing here skews it.
 * - **Arrivals are bursty**, because support traffic is. Modelled as a Poisson
 *   process, which clusters: a uniform spread never fills a poll batch, and a
 *   full batch is where the delay lives.
 * - **Queue wait is not drawn at all.** It is computed from the consumer's
 *   real loop, and three facts of that loop shape it:
 *     1. Intake signals the consumer inside the enqueue transaction and the
 *        loop wakes on it (issue #25), so a message is visible the instant
 *        it is queued. `CONSUMER_INTERVAL_MS` remains as a ceiling for a
 *        lost signal. Set `wakeOnArrival: false` for the loop before that
 *        change, where a message waited for the next tick at any load.
 *     2. `pollPartition` takes every queued message across the partitions one
 *        consumer owns, and `scanBatchSize` defaults to the whole queue.
 *     3. `processQueuedTickets` awaits each `coordinateTicket` before the
 *        next, so the batch is walked serially.
 *   So a ticket waits for every ticket ahead of it in its consumer's batch —
 *   including tickets on a *different* partition that the same consumer
 *   owns. That cross-partition wait is the head-of-line delay V2 open item 7
 *   names, and modelling one server per partition would have hidden it
 *   entirely.
 *
 * Head-of-line delay is therefore a consequence of those facts, and whatever
 * the report shows about it is a finding rather than a setting.
 *
 * ## What the figures say
 *
 * At this load the system does not queue. Utilisation is 1.37 %, and one run
 * in a hundred waits longer than one poll period. None of the design
 * document's rules R1 to R4 fires.
 *
 * `wakeOnArrival: false` models the loop before the consumer woke on an
 * arrival. There the mean wait is 2.78 s against a poll floor of 2.50 s, so
 * ninety per cent of the wait is the sleep itself. Both regimes stay
 * expressible, because a wait figure that can only be stated one way is not
 * evidence for anything.
 *
 * `src/seed/plan.test.ts` pins every figure the register and the roadmap
 * quote.
 */
import { partitionOf, type EscalationReason } from '../coordinator/coordinator.js';
import { CUSTOMER_REPLY_ACTION_CLASS, COMPENSATION_ACTION_CLASS } from '../adapters/types.js';
import {
  SEED_THRESHOLDS,
  agreementThresholdFor,
  reachedAgreementGate,
  type ActionClass,
  type PolicyReason,
  type AdapterCapabilities,
  type PolicyDecision,
  type PolicyInput,
  type RiskTier,
} from '../policy/policy.js';
import { CLASSIFIER_K } from '../classifier/classifier.js';
import type { IndexedDoc } from '../retriever/types.js';

/** Deterministic PRNG, the same one `scripts/generate-fixtures.mjs` uses. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A v4-shaped identifier from the PRNG.
 *
 * `randomUUID` would make the history irreproducible, and a run id is a
 * primary key a second run must reproduce exactly for the ledger contents to
 * match. The version and variant nibbles are set so the value is a valid
 * UUID and Postgres accepts it in a `uuid` column.
 */
export function seededUuid(rng: () => number): string {
  const hex: string[] = [];
  for (let i = 0; i < 32; i += 1) hex.push(Math.floor(rng() * 16).toString(16));
  hex[12] = '4';
  hex[16] = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/** Milliseconds in one day. */
const DAY_MS = 86_400_000;

/**
 * A log-normal draw, by the Box-Muller transform.
 *
 * Log-normal because a duration cannot be negative and a run's total is a
 * product of several call latencies rather than a sum of them. `sigma`
 * controls the tail: at 0.9 roughly one run in a hundred takes five times the
 * median, which is the shape a twelve-call run has.
 */
export function logNormal(rng: () => number, medianMs: number, sigma: number): number {
  const u1 = Math.max(rng(), Number.EPSILON);
  const u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.round(medianMs * Math.exp(sigma * z));
}

/**
 * The same draw as `logNormal`, kept as a fraction in [0, 1].
 *
 * It consumes the same two values from `rng`, in the same order, so a
 * caller that swaps one for the other leaves every later draw in the stream
 * untouched. `plan.test.ts` pins that, because a version of this function
 * that folded the two draws into one would reshuffle the whole history and
 * move every figure the register quotes.
 *
 * Separate from `logNormal` rather than a flag on it: that one rounds to a
 * whole millisecond, and rounding a fraction of a document leaves only 0
 * and 1.
 */
export function logNormalUnit(rng: () => number, median: number, sigma: number): number {
  const u1 = Math.max(rng(), Number.EPSILON);
  const u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  // Clamped at both ends because the column's contract is [0, 1] inclusive
  // (db/003). A complete rewrite really does score 1, so the upper clamp is
  // a legal value and not a discarded draw.
  return Math.min(1, Math.max(0, median * Math.exp(sigma * z)));
}

/**
 * The curated taxonomy, as `fixtures/taxonomy.json` holds it.
 *
 * Copied rather than loaded, because this planner reads no file: a history
 * that changed when somebody edited a fixture would not be reproducible from
 * its seed alone. `plan.test.ts` loads the real taxonomy and asserts this
 * table matches it entry for entry, so the copy cannot drift.
 *
 * The risk tier matters to the policy engine, not just to a reader. DEC-13
 * keeps a high-risk intent off the automatic path whatever the gates read,
 * so an `auto` run carrying `refund-request` would be a row the engine
 * cannot produce.
 */
export interface SeedIntent {
  readonly id: string;
  readonly riskTier: RiskTier;
}

export const SEED_INTENTS: readonly SeedIntent[] = [
  { id: 'refund-request', riskTier: 'high' },
  { id: 'billing-dispute', riskTier: 'high' },
  { id: 'cancel-subscription', riskTier: 'high' },
  { id: 'data-deletion-request', riskTier: 'high' },
  { id: 'chargeback-notice', riskTier: 'high' },
  { id: 'payment-failure', riskTier: 'medium' },
  { id: 'plan-change-question', riskTier: 'medium' },
  { id: 'invoice-copy-request', riskTier: 'medium' },
  { id: 'account-recovery', riskTier: 'medium' },
  { id: 'login-trouble', riskTier: 'medium' },
  { id: 'sync-error-report', riskTier: 'medium' },
  { id: 'export-broken', riskTier: 'medium' },
  { id: 'integration-failure', riskTier: 'medium' },
  { id: 'feature-request', riskTier: 'low' },
  { id: 'how-to-question', riskTier: 'low' },
  { id: 'pricing-question', riskTier: 'low' },
  { id: 'documentation-gap', riskTier: 'low' },
  { id: 'feedback-positive', riskTier: 'low' },
  { id: 'bug-minor-report', riskTier: 'low' },
  { id: 'onboarding-help', riskTier: 'low' },
  { id: 'notification-settings-help', riskTier: 'low' },
  { id: 'mobile-app-question', riskTier: 'low' },
  { id: 'api-usage-question', riskTier: 'low' },
  { id: 'status-inquiry', riskTier: 'low' },
  { id: 'other', riskTier: 'medium' },
];

/**
 * What a customer wrote, for each intent (DEC-18).
 *
 * Two messages per intent, so a console shows a queue of people rather than
 * one sentence with a word swapped. Every one is invented and about nobody:
 * no name, no address, no telephone number and no account identifier.
 *
 * These replaced one template that read "I need help with a <intent id> on
 * ticket <id>". It said the intent id out loud, so a classification the
 * system was supposed to make was written into the question; the article
 * never agreed with the noun ("a api usage question", "a onboarding help");
 * and every ticket in the queue read the same. None of that is what a
 * support queue looks like, and the console is judged on looking like one.
 */
const INBOUND_MESSAGES: Readonly<Record<string, readonly [string, string]>> = {
  'refund-request': [
    'I was charged twice for this month and I would like the second charge back. Can you sort that out?',
    'We cancelled before the renewal but the payment still went through. Please refund it.',
  ],
  'billing-dispute': [
    'The invoice this month is higher than the plan we agreed and I cannot see why. What changed?',
    'There is a line on our last bill that nobody here recognises. Can you explain the charge?',
  ],
  'cancel-subscription': [
    'We want to close the account at the end of this billing period. What do I need to do?',
    'How do I cancel? I do not want to be billed again next month.',
  ],
  'data-deletion-request': [
    'Please delete all of our data from your systems. How long does that take to complete?',
    'We need everything removed, including the backups. Can you confirm when that is done?',
  ],
  'chargeback-notice': [
    'Our bank has raised a dispute on the last payment. What happens to the account meanwhile?',
    'We have asked the card issuer to reverse this charge. Will you suspend the workspace?',
  ],
  'payment-failure': [
    'The card on file keeps getting declined and I do not know why. The card itself works elsewhere.',
    'We got an email saying the payment failed. How many more times will you try before something breaks?',
  ],
  'plan-change-question': [
    'If we move up a plan halfway through the month, do we pay the difference straight away?',
    'We want to add seats now and downgrade later. How does the billing work across that?',
  ],
  'invoice-copy-request': [
    'Our finance team needs copies of the last three invoices. Where do I find them?',
    'Can you send the invoices to somebody else in the company as well as me?',
  ],
  'account-recovery': [
    'Our only administrator has left and nobody else can get in. How do we recover the workspace?',
    'The account is locked and I cannot reach anyone with admin rights. What are the options?',
  ],
  'login-trouble': [
    'I keep getting bounced back to the sign in page over and over. Nothing I try gets me in.',
    'Sign in loops forever in one browser and works in another. What is going on?',
  ],
  'sync-error-report': [
    'Our sync has been failing since yesterday with an error about credentials. Nothing changed our end.',
    'The connector keeps erroring out and the jobs never finish. Can you tell what is failing?',
  ],
  'export-broken': [
    'The export I ran came back with no rows in it, and there is definitely data there.',
    'Exports have started downloading empty files this week. They worked fine before.',
  ],
  'integration-failure': [
    'The integration stopped posting anything overnight and there is no error we can see.',
    'We rotated a credential and now half the jobs are failing. Did that break the link?',
  ],
  'feature-request': [
    'Is there any way to schedule this to run weekly? If not, is it something you plan to add?',
    'We would use a bulk edit constantly if you had one. Is that on the roadmap anywhere?',
  ],
  'how-to-question': [
    'How do I set up a new workspace for a second team? I cannot find where to start.',
    'What is the right way to invite people who only need to read things?',
  ],
  'pricing-question': [
    'How does the pricing work if we add people partway through the month?',
    'Is there a difference in price between paying monthly and paying for the year?',
  ],
  'documentation-gap': [
    'The page about this setting does not say what happens when it is turned off. Can you clarify?',
    'I followed the guide and the steps do not match what I see on screen. Is it out of date?',
  ],
  'feedback-positive': [
    'Just wanted to say the new layout is much easier to work with. Thanks for sorting it.',
    'Your team fixed our issue quickly last week and it made a real difference. Much appreciated.',
  ],
  'bug-minor-report': [
    'A small thing: the counter at the top does not refresh until I reload the page.',
    'The date on this screen shows a day behind for me. Not urgent, but worth flagging.',
  ],
  'onboarding-help': [
    'We are setting up for the first time and are not sure what to do first. Any guidance?',
    'What do we need in place before we invite the rest of the team in?',
  ],
  'notification-settings-help': [
    'I am getting far too many emails from this. How do I turn most of them off?',
    'Can each person choose their own alerts, or is it set for the whole workspace?',
  ],
  'mobile-app-question': [
    'Does the phone app work when I have no signal? I am often somewhere without one.',
    'The app on my phone shows older information than the website does. Is that expected?',
  ],
  'api-usage-question': [
    'We are hitting a limit on the API and I want to understand what the ceiling actually is.',
    'Is the rate limit per token or across the whole workspace? We have several tokens.',
  ],
  'status-inquiry': [
    'Things are slow for us this morning. Is there anything going on at your end?',
    'Where do I look to see whether an outage is already known about?',
  ],
  other: [
    'Something is not working the way we expect and I am not sure who to ask. Can you point me somewhere?',
    'I have a question that does not fit your categories. Happy to explain if someone can take a look.',
  ],
};

/**
 * What a customer writes back while the first reply waits (DEC-35, DEC-37).
 *
 * A support conversation is rarely one message. Every seeded one was, so the
 * console's conversation surface — built to draw a thread — had a thread of
 * one to draw, and the reply-absence states it distinguishes were unreachable
 * from a seeded ledger.
 *
 * This is the second turn nobody has answered yet: the customer wrote again
 * while the drafted reply sat in the approval queue. It carries no run,
 * because a run answering it would move the run to that conversation's
 * partition (DEC-36) and with it the whole seeded queue simulation, which
 * `docs/v1-architecture.md` cites as evidence.
 *
 * Invented throughout, and about nobody (DEC-18).
 */
export const FOLLOW_UP_MESSAGES: readonly string[] = [
  'Any update on this? It is starting to hold up the rest of the team.',
  'Sorry to chase, but is anyone looking at this yet?',
  'One more thing I forgot to mention: it only happens on the shared workspace.',
  'We found a workaround for now, but I would still like to understand the cause.',
  'Ignore my last message, it has started working again. Still curious what happened.',
];

/**
 * Whether a run's conversation carries a second turn, and what it says.
 *
 * Decided from the run id, which the planner already drew. A draw inserted
 * into the planner would move every figure the seeded history publishes,
 * because they all come out of one shared sequence.
 *
 * Only a run still waiting for a person gets one. A conversation the system
 * already answered and closed is not one a customer is chasing.
 */
export function followUpFor(runId: string, state: string): string | null {
  if (state !== 'awaiting_approval') return null;
  const roll = Number.parseInt(runId.slice(9, 13), 16);
  if (roll % 100 >= 30) return null;
  return FOLLOW_UP_MESSAGES[roll % FOLLOW_UP_MESSAGES.length]!;
}

/**
 * The message a seeded ticket carries.
 *
 * Chosen from the intent's own pair, so the queue reads as a queue and the
 * message is about the thing the run classified. It never names the intent
 * and never names the ticket: a customer writing in knows neither.
 */
export function inboundMessageFor(intentId: string, seed: number): string {
  const pair = INBOUND_MESSAGES[intentId];
  if (pair === undefined) {
    throw new Error(
      `no inbound message for intent '${intentId}'; every intent in SEED_INTENTS needs one, `
        + 'because a seeded ticket with no message is a queue row a person cannot read',
    );
  }
  return pair[seed % 2 === 0 ? 0 : 1];
}

/**
 * The documents a retriever would return for each intent.
 *
 * Retrieval was uniform over the whole corpus, so a refund question came back
 * with the status page, the mobile application and account recovery — and no
 * arrangement of those sentences answers it. A reader opening such a run sees
 * a reply that makes no sense and concludes the system does not work, which
 * is the correct conclusion about that ledger.
 *
 * The first entries are what a hybrid search would rank first for the intent.
 * A run still fills the rest of its window from the remainder, because a
 * retriever returns near misses too — and a claim citing one of those is how
 * an unsupported claim gets a citation at all (DEC-07, DEC-21).
 *
 * An intent with no entry falls back to the whole corpus, which is the
 * honest shape for `other`.
 */
const DOCUMENTS_FOR: Readonly<Record<string, readonly string[]>> = {
  'refund-request': ['SYN-DOC-01', 'SYN-DOC-05'],
  'billing-dispute': ['SYN-DOC-01', 'SYN-DOC-04'],
  'cancel-subscription': ['SYN-DOC-05', 'SYN-DOC-01'],
  'data-deletion-request': ['SYN-DOC-08'],
  'chargeback-notice': ['SYN-DOC-01', 'SYN-DOC-02'],
  'payment-failure': ['SYN-DOC-02', 'SYN-DOC-04'],
  'plan-change-question': ['SYN-DOC-03', 'SYN-DOC-05'],
  'invoice-copy-request': ['SYN-DOC-04'],
  'account-recovery': ['SYN-DOC-06', 'SYN-DOC-07'],
  'login-trouble': ['SYN-DOC-07', 'SYN-DOC-06'],
  'sync-error-report': ['SYN-DOC-10', 'SYN-DOC-14'],
  'export-broken': ['SYN-DOC-09', 'SYN-DOC-10'],
  'integration-failure': ['SYN-DOC-12', 'SYN-DOC-10'],
  'how-to-question': ['SYN-DOC-16', 'SYN-DOC-13'],
  'pricing-question': ['SYN-DOC-03', 'SYN-DOC-04'],
  'documentation-gap': ['SYN-DOC-16'],
  'bug-minor-report': ['SYN-DOC-15', 'SYN-DOC-10'],
  'onboarding-help': ['SYN-DOC-16'],
  'notification-settings-help': ['SYN-DOC-13'],
  'mobile-app-question': ['SYN-DOC-14'],
  'api-usage-question': ['SYN-DOC-11', 'SYN-DOC-12'],
  'status-inquiry': ['SYN-DOC-15'],
};

/**
 * The knowledge base a seeded run retrieves from.
 *
 * Small and fixed, because its job is to give the `docIds` in a retrieve row
 * something to join to. Without it a reader holding a seeded history sees
 * five identifiers per run and can resolve none of them, which is the same
 * defect as a gate reason with no numbers beside it.
 *
 * Every review date is in the future. That is not decoration: the
 * coordinator calls `hybridSearch` with no `includeStale`, so its SQL
 * filters on `review_by >= CURRENT_DATE` and a stale document can never
 * reach a run this seeder models (DEC-23).
 *
 * DEC-18: every field is invented. The owners are team handles, and no body
 * carries a person, an address or an account.
 */
export const SEED_DOCUMENTS: readonly IndexedDoc[] = [
  {
    docId: 'SYN-DOC-01',
    kind: 'document',
    title: 'Refund eligibility windows',
    body: 'A subscription charge is refundable in full inside fourteen days of the charge date. '
      + 'After that window the account keeps access until the end of the paid period. '
      + 'A refund on a disputed charge waits for the dispute to close.',
    owner: 'billing-team',
    reviewBy: '2027-03-31',
  },
  {
    docId: 'SYN-DOC-02',
    kind: 'document',
    title: 'Failed payment retry schedule',
    body: 'A declined card is retried three times over ten days. '
      + 'The account stays active through the retry window and moves to read only after it. '
      + 'A new card cancels the remaining retries and settles the balance at once.',
    owner: 'billing-team',
    reviewBy: '2027-05-14',
  },
  {
    docId: 'SYN-DOC-03',
    kind: 'document',
    title: 'Changing a plan mid cycle',
    body: 'An upgrade takes effect at once and bills the difference for the remaining days. '
      + 'A downgrade takes effect at the next renewal and never issues a credit. '
      + 'Seat counts follow the same rule.',
    owner: 'billing-team',
    reviewBy: '2027-04-30',
  },
  {
    docId: 'SYN-DOC-04',
    kind: 'document',
    title: 'Invoice copies and billing contacts',
    body: 'Every invoice stays available under the billing section of the workspace settings. '
      + 'A workspace owner can add a billing contact who receives each invoice. '
      + 'Historic invoices are never edited; a correction is issued as a credit note.',
    owner: 'billing-team',
    reviewBy: '2027-06-30',
  },
  {
    docId: 'SYN-DOC-05',
    kind: 'document',
    title: 'Cancelling a subscription',
    body: 'Cancellation stops the next renewal and keeps access until the paid period ends. '
      + 'A cancelled workspace is retained for thirty days and then deleted. '
      + 'Reactivation inside those thirty days restores the workspace unchanged.',
    owner: 'billing-team',
    reviewBy: '2027-02-28',
  },
  {
    docId: 'SYN-DOC-06',
    kind: 'document',
    title: 'Account recovery without a second factor',
    body: 'A locked account is recovered by a workspace administrator from the members page. '
      + 'When no administrator remains, recovery needs proof of domain ownership. '
      + 'Support never disables the second factor on request alone.',
    owner: 'accounts-team',
    reviewBy: '2027-01-31',
  },
  {
    docId: 'SYN-DOC-07',
    kind: 'document',
    title: 'Sign in loops and stale sessions',
    body: 'A sign in loop is almost always a stale session cookie for the workspace domain. '
      + 'Clearing site data for that domain resolves it. '
      + 'A loop that survives a cleared session points at a misconfigured identity provider.',
    owner: 'accounts-team',
    reviewBy: '2027-07-31',
  },
  {
    docId: 'SYN-DOC-08',
    kind: 'canonical_resolution',
    title: 'Data deletion request handling',
    body: 'A deletion request is confirmed by the requester and then queued for thirty days. '
      + 'The queue is reversible until it runs. '
      + 'After it runs the workspace and its backups are unrecoverable.',
    owner: 'compliance-desk',
    reviewBy: '2027-03-15',
  },
  {
    docId: 'SYN-DOC-09',
    kind: 'document',
    title: 'Export jobs that finish empty',
    body: 'An export covers the rows a viewer can already see. '
      + 'An empty export usually means the filter excluded every row. '
      + 'An export above one million rows is split into parts and delivered as an archive.',
    owner: 'platform-team',
    reviewBy: '2027-08-31',
  },
  {
    docId: 'SYN-DOC-10',
    kind: 'document',
    title: 'Synchronisation error codes',
    body: 'A sync error names the connector and the stage that failed. '
      + 'Codes in the four hundreds are configuration faults and need a reconnected credential. '
      + 'Codes in the five hundreds are retried automatically for six hours.',
    owner: 'platform-team',
    reviewBy: '2027-09-30',
  },
  {
    docId: 'SYN-DOC-11',
    kind: 'document',
    title: 'Rate limits on the public interface',
    body: 'A workspace may make six hundred requests a minute across every token it holds. '
      + 'A rejected request returns the remaining budget and the reset instant. '
      + 'Bulk work belongs on the batch endpoints, which carry a separate budget.',
    owner: 'platform-team',
    reviewBy: '2027-10-31',
  },
  {
    docId: 'SYN-DOC-12',
    kind: 'document',
    title: 'Integration credentials and rotation',
    body: 'A connector credential is rotated without downtime by adding the new one first. '
      + 'The old credential stays valid for one hour after the swap. '
      + 'A revoked credential stops every job that used it immediately.',
    owner: 'platform-team',
    reviewBy: '2027-11-30',
  },
  {
    docId: 'SYN-DOC-13',
    kind: 'document',
    title: 'Notification settings and digests',
    body: 'Each member controls their own notification settings for every workspace they join. '
      + 'A digest collects notifications for the period the member chose. '
      + 'A workspace administrator can set a default but never overrides a member choice.',
    owner: 'support-enablement',
    reviewBy: '2027-05-31',
  },
  {
    docId: 'SYN-DOC-14',
    kind: 'document',
    title: 'Mobile application offline behaviour',
    body: 'The mobile application keeps the last thirty days of activity for offline reading. '
      + 'An edit made offline is queued and applied when the device reconnects. '
      + 'A conflicting edit keeps both versions and asks the member to choose.',
    owner: 'support-enablement',
    reviewBy: '2027-06-15',
  },
  {
    docId: 'SYN-DOC-15',
    kind: 'canonical_resolution',
    title: 'Status page and incident updates',
    body: 'Every incident is published on the status page before support answers about it. '
      + 'An update follows at least every thirty minutes while the incident is open. '
      + 'A resolved incident keeps its timeline for one year.',
    owner: 'support-enablement',
    reviewBy: '2027-04-15',
  },
  {
    docId: 'SYN-DOC-16',
    kind: 'document',
    title: 'Onboarding a new workspace',
    body: 'A new workspace starts with one owner who invites the first members. '
      + 'The setup checklist covers the domain, the identity provider and the billing contact. '
      + 'A workspace with no verified domain cannot enable automatic joining.',
    owner: 'support-enablement',
    reviewBy: '2027-12-31',
  },
];

/** The classifier's own output, which the `classify` step journals. */
export interface PlannedClassification {
  intentId: string;
  /** DEC-13: a person sets it. The policy engine reads it, so it is carried, not inferred. */
  riskTier: RiskTier;
  /** A count of agreeing samples over CLASSIFIER_K, never a free real number. */
  agreement: number;
}

/**
 * The world the policy engine judged, kept so a reader can re-run the engine.
 *
 * Null for a run whose composer abstained: `coordinateTicket` escalates
 * before the gate step starts, so such a run reaches no engine at all.
 */
export interface PlannedGate {
  groundedness: number;
  decision: PolicyDecision;
  capabilities: AdapterCapabilities;
  action: ActionClass;
}

/**
 * The `park` record a gated run journals, in the shape approval reads back.
 *
 * Two shapes, exactly as the coordinator writes them: a customer reply parks
 * a draft in the helpdesk and records its handle (DEC-11), and every other
 * gated write parks in the ledger alone and records the payload approval
 * copies onto the outbox (DEC-34).
 */
export interface PlannedPark {
  readonly draftExternalId?: string;
  actionClass: string;
  delivery: 'at_least_once' | 'at_most_once';
  body: string;
  readonly payload?: Record<string, unknown>;
  turnNumber: number;
  /**
   * DEC-14 and DEC-33: the disclosure and the provenance a customer reply
   * carries, which the park journals so the ledger can attach them when the
   * reply sends.
   *
   * Absent on a ledger-only park, which holds no customer text (DEC-34). A
   * seeded customer reply carries both, so a seeded ledger exercises the
   * shipped path: without them every waiting run refuses as `no_disclosure`
   * on an adapter whose helpdesk cannot send its parked copy (DEC-44).
   */
  readonly disclosure?: string;
  readonly provenance?: {
    readonly generatedBy: string;
    readonly modelId: string;
    readonly promptVer: string;
    readonly generatedAt: string;
  };
}

/**
 * The disclosure a seeded reply carries (DEC-14).
 *
 * Synthetic, as every seeded value is (DEC-18): it names no adopter and no
 * product, and a reader can tell it from a real one.
 */
const SEED_DISCLOSURE = 'This reply was drafted by an automated assistant, and approved by a person.';

/** The pins every seeded step carries, as `write.ts` spells them (DEC-26). */
const SEED_PIN = 'seed';

/** One planned run, with every value the writer needs. */
export interface PlannedRun {
  runId: string;
  ticketId: string;
  conversationId: string;
  partition: number;
  /** When the message arrived. */
  enqueuedAt: Date;
  /** When the consumer picked it up: arrival plus everything ahead of it. */
  createdAt: Date;
  /**
   * The work itself, which is what occupies the consumer.
   *
   * Distinct from `finishedAt - createdAt`. A run parked for approval holds
   * no consumer while it waits, so the serial walk releases the consumer
   * after this and not after the person answers.
   */
  serviceMs: number;
  /**
   * When it reached a terminal state, or null when it has not reached one.
   *
   * Null for `awaiting_approval`: that run is waiting for a person and has
   * not finished, so the ledger stores no finish and the latency reader
   * counts it under `unfinished`. The clock seam refuses a finish for a
   * non-terminal state, which is how this was found.
   */
  finishedAt: Date | null;
  state: string;
  /** The compose step's outcome. */
  abstained: boolean;
  /**
   * The gate step's reason, or null for a run that never gated.
   *
   * Null when the composer abstained: `coordinateTicket` journals the
   * abstain and escalates before the gate step starts, so such a run has no
   * gate row at all. Writing one produced a shape the system cannot make,
   * and it drove the bands report's `gate_never` count to zero on every day
   * where a real ledger with a 17 per cent abstain rate shows at least that.
   */
  reason: PolicyReason | null;
  /**
   * Why this run escalated, or null for a run that did not.
   *
   * A second vocabulary, and not the gate's. `reason` above is a
   * `PolicyReason` and names which policy rule decided; this names why the
   * run stopped, and the coordinator's `EscalationReason` is a disjoint set
   * of words. `src/escalations/query.ts` reads only this one, off the
   * `escalate` step, and both `pnpm run escalations` and the operator
   * console's runs list are served by that statement. So a seeded escalation
   * with no such row reported a null reason to a person working the queue,
   * and the console's Reason column was an em dash for every one of them.
   *
   * `relay_delivery_unknown` is outside `EscalationReason` on purpose. That
   * escalation comes from the relay rather than the coordinator, and
   * `parkEscalated` composes its reason as `relay_${status}` when it has no
   * send failure to quote (DEC-30).
   */
  escalation: EscalationReason | 'relay_delivery_unknown' | null;
  /** What answered this run's model calls. */
  provider: string;
  /**
   * The person's edit to the parked draft, normalized to [0, 1].
   *
   * Set only when a person approved a draft. The scale is the column's
   * contract (db/003) and what `approvalEditDistance` returns: a token-level
   * Levenshtein distance over the length of the longer text. It was drawn
   * around a median of 24 and rounded to a whole number, which is a token
   * count and not a fraction — so `pnpm run bands` reported a mean edit
   * distance near 24 against a metric whose worst possible value is 1, and
   * the band could never be compared with a measurement from a live
   * approval.
   */
  editDistance: number | null;
  /** Outbox rows to attach, by status. */
  outbox: readonly string[];
  /** The `classify` step's result. Present for every run: every run classifies. */
  classification: PlannedClassification;
  /** The documents the `retrieve` step returned, best first. */
  docIds: readonly string[];
  /** The claims, their citations and their verdicts (DEC-07, DEC-05). */
  claims: readonly PlannedClaim[];
  /**
   * The reply in draft order, courtesy sentences included (DEC-43).
   *
   * Joined, these are `park.body`. `claims` is the cited subset, in the same
   * order, which is what a gate verdict is recorded against.
   */
  sentences: readonly PlannedSentence[];
  /** How many cited claims the composer produced. Zero for an abstain. */
  claimCount: number;
  /**
   * How many steps the run counted, as the coordinator counts them.
   *
   * The coordinator increments once per journal step it finishes, and it
   * finishes `escalate` without counting it: an escalation is how a run ends
   * rather than work it did. `seed.db.test.ts` holds this equal to the
   * journal rows the run actually wrote, so the two cannot drift.
   */
  stepsUsed: number;
  /** The gate step's inputs and verdict, or null for a run that never gated. */
  gate: PlannedGate | null;
  /** The park step's record, or null for a run the policy engine did not gate. */
  park: PlannedPark | null;
  /** The action under evaluation, which decides the delivery rule (DEC-29). */
  actionClass: string;
  delivery: 'at_least_once' | 'at_most_once';
  /** What an adapter would be asked to perform. Non-empty for every action class. */
  actionPayload: Record<string, unknown>;
}

/**
 * The engine input a run's own journal describes.
 *
 * Exported so a test drives `evaluatePolicyDetailed` with it rather than
 * restating the rule. A seeded reason that disagreed with the numbers beside
 * it would be visible on any console that renders both, and nothing else in
 * this planner would catch it.
 *
 * Null for a run that never gated, which is what an abstain produces.
 */
export function policyInputFor(run: PlannedRun): PolicyInput | null {
  if (run.gate === null) return null;
  return {
    riskTier: run.classification.riskTier,
    intent: run.classification.intentId,
    agreement: run.classification.agreement,
    groundedness: run.gate.groundedness,
    thresholds: SEED_THRESHOLDS,
    capabilities: run.gate.capabilities,
    action: run.gate.action,
  };
}

export interface PlanOptions {
  seed: number;
  /** UTC calendar days to write, oldest first. */
  days: number;
  /** The last day of the history, `YYYY-MM-DD`. */
  endDay: string;
  /** Consumer partitions, as CONSUMER_PARTITIONS would name them. */
  partitions: number;
  /**
   * Consumer processes. Each owns `partitions / consumers` of them and walks
   * their combined queue in one serial batch, which is what
   * `pollPartition` plus `processQueuedTickets` do.
   */
  consumers?: number;
  /** Mean tickets a day. Poisson, so the realised count varies. */
  arrivalsPerDay?: number;
  /** The consumer's poll period, CONSUMER_INTERVAL_MS. */
  pollIntervalMs?: number;
  /**
   * Whether the consumer wakes on arrival (issue #25). True models the loop
   * that ships: intake signals on enqueue and the consumer scans at once,
   * with the poll period left as a ceiling. False models the loop before it,
   * where a message was invisible until the next tick.
   *
   * Both regimes stay expressible on purpose. The wait figures this planner
   * produces are the evidence for what the poll floor costs, and evidence
   * that can only be stated one way is not evidence.
   */
  wakeOnArrival?: boolean;
  /** What answered the bulk history's model calls. */
  provider: string;
}

/**
 * The reasons a healthy day produces, with the weight each carries.
 *
 * Taken from `PolicyReason`, so `bands` recognises every one of them. A
 * reason it no longer knows lands in `gate_obsolete`, which would report the
 * seeded history as a ledger the reader cannot interpret.
 *
 * `customer_visible` dominates because DEC-12 sends every customer reply to a
 * person, and that is most of this system's traffic.
 */
const HEALTHY_REASONS: readonly (readonly [PolicyReason, number])[] = [
  ['customer_visible', 0.46],
  ['auto', 0.24],
  ['groundedness_review', 0.10],
  ['agreement', 0.08],
  ['high_risk', 0.06],
  ['groundedness_block', 0.03],
  ['irreversible', 0.02],
  ['no_idempotency', 0.01],
];

/**
 * The degraded day: the classifier disagrees with itself more often.
 *
 * Only `agreement` and `auto` move, and they move against each other, so the
 * day's degradation is one metric falling rather than a reshaped ledger.
 * `gate_pass_rate` is the metric bands.yaml calls low_is_bad, and agreement
 * is the reason that fails it (section 4.5).
 */
const DEGRADED_REASONS: readonly (readonly [PolicyReason, number])[] = [
  ['customer_visible', 0.46],
  ['auto', 0.04],
  ['groundedness_review', 0.10],
  ['agreement', 0.28],
  ['high_risk', 0.06],
  ['groundedness_block', 0.03],
  ['irreversible', 0.02],
  ['no_idempotency', 0.01],
];

/**
 * The state a run ends in, given the reason its gate produced.
 *
 * Read off `evaluatePolicyDetailed` and the coordinator's own branches, not
 * chosen. `auto` is the only reason that proceeds, and it ends `resolved`.
 * Every `gated` reason parks at `awaiting_approval` — DEC-34 for a write
 * with no draft, DEC-12 for a customer reply — and reaches `resolved` only
 * when a person approves it. `agreement` and `groundedness_block` are
 * `escalate`, which ends `escalated`.
 *
 * The first version marked every run `resolved`, including 1112 customer
 * replies that DEC-12 routes to a person. The bands report's own
 * "still to land" count was then zero on every day of the history.
 */
const ESCALATING_REASONS: ReadonlySet<string> = new Set(['agreement', 'groundedness_block']);

export function stateFor(reason: string, approved: boolean): string {
  if (reason === 'auto') return 'resolved';
  if (ESCALATING_REASONS.has(reason)) return 'escalated';
  return approved ? 'resolved' : 'awaiting_approval';
}

function weighted<T extends string>(rng: () => number, table: readonly (readonly [T, number])[]): T {
  let roll = rng();
  for (const [value, weight] of table) {
    roll -= weight;
    if (roll <= 0) return value;
  }
  return table[table.length - 1]![0];
}

/** A UTC day string, `n` days before `endDay`. */
export function dayBefore(endDay: string, n: number): string {
  return new Date(Date.parse(`${endDay}T00:00:00.000Z`) - n * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Plans the whole history.
 *
 * The degraded day sits four days before the end, so a reader has a full
 * thirty measured days behind it and several ordinary days after it.
 */
/**
 * A Poisson draw by Knuth's method.
 *
 * Arrivals to a support desk are Poisson, and Poisson clusters: the gap
 * between two arrivals is exponential, so several land close together far
 * more often than a uniform spread allows. A batch fills from a cluster.
 */
export function poisson(rng: () => number, mean: number): number {
  const limit = Math.exp(-mean);
  let k = 0;
  let p = 1;
  do {
    k += 1;
    p *= rng();
  } while (p > limit);
  return k - 1;
}

/** An exponential gap, which is what makes the arrival process Poisson. */
function exponentialGap(rng: () => number, meanMs: number): number {
  return -Math.log(Math.max(rng(), Number.EPSILON)) * meanMs;
}

/**
 * A day's own seed, mixed from the run seed and the day string.
 *
 * One stream for the whole history made every window that shared a seed start
 * with the same identifiers, so seeding one extra day after a long history
 * regenerated the first day's run ids and the ledger refused them on the
 * primary key. Per-day seeding keeps both properties that matter: one seed and
 * one day always give the same runs, and two different days never collide.
 */
function seedForDay(seed: number, day: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < day.length; i += 1) {
    hash ^= day.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash ^ seed) >>> 0;
}

/**
 * An adapter that declares everything, which is what the shipped ones do.
 *
 * `no_idempotency` is the one reason that needs a gap, and it is made by
 * withdrawing a single flag from this record rather than by writing a second
 * one. Two hand-written capability sets can disagree about a flag nobody is
 * looking at, and the engine reads two of them (DEC-06).
 */
const FULL_CAPABILITIES: AdapterCapabilities = Object.freeze({
  supportsIdempotencyKey: true,
  supportsReadBack: true,
  supportsDraftState: true,
  supportsStructuredFields: true,
  supportsThreading: true,
  supportsLedgerReply: false,
});

/**
 * The reasons `evaluatePolicyDetailed` returns before it reads the risk tier.
 *
 * A run stopped by one of these may carry any intent, including a high-risk
 * one. That is not a licence, it is the traffic: DEC-12 sends every customer
 * reply to a person, and a refund reply is a customer reply first. Excluding
 * the high tier here would have written a history in which no refund is ever
 * answered, which is a claim about this system that is simply false.
 */
const BEFORE_RISK_CHECK: ReadonlySet<PolicyReason> = new Set<PolicyReason>([
  'no_idempotency',
  'no_read_back',
  'customer_visible',
  'irreversible',
]);

/**
 * The internal write classes the helpdesk adapter implements.
 *
 * Both are real: `performAction` names `close_ticket`, `route_ticket` and
 * `compensate`, and refuses anything else. A class it cannot perform would
 * put a row in the outbox that the relay can never dispatch.
 */
const INTERNAL_ACTION_CLASSES: readonly string[] = ['route_ticket', 'close_ticket'];

/** Queues a routed ticket can land in. Synthetic names, DEC-18. */
const SEED_QUEUES: readonly string[] = ['SYN-QUEUE-BILLING', 'SYN-QUEUE-ACCOUNTS', 'SYN-QUEUE-PLATFORM'];

/**
 * Claim counts a composition can produce.
 *
 * Groundedness is `supported / claims.length`, so it is a ratio of two small
 * whole numbers and not a free real number. A coverage drawn without a claim
 * count behind it is a value no composition could have produced, and the
 * journal records both side by side.
 */
// A drafted reply makes a few claims, not ten. Ten produced a nine-sentence
// answer that wandered into whatever the retriever returned last, which reads
// as a broken system rather than a long one. Nothing published depends on
// this: the README's containment and action-match figures come from the gold
// corpus, and the control bands over a seeded history are a demonstration.
const CLAIM_COUNTS: readonly number[] = [2, 3, 4, 5];

/**
 * A coverage value inside [lo, hi), together with the claim count that gives it.
 *
 * The band comes from the gate reason the planner already drew, so the number
 * and the reason cannot disagree. The comparison here is the same division
 * and the same operator the engine applies, so no rounding can put a value on
 * the wrong side of a threshold.
 *
 * Some bands admit nothing at some counts — nothing between 0.7 and 0.8 is a
 * ratio over 3, 5 or 6 — so the search walks the candidates. It draws twice
 * whatever it finds, because a search that consumed a draw per attempt would
 * make the rest of the history depend on which band this run landed in.
 */
function coverageIn(
  rng: () => number,
  lo: number,
  hi: number,
): { claimCount: number; groundedness: number } {
  const start = Math.floor(rng() * CLAIM_COUNTS.length);
  const pick = rng();
  for (let step = 0; step < CLAIM_COUNTS.length; step += 1) {
    const claimCount = CLAIM_COUNTS[(start + step) % CLAIM_COUNTS.length]!;
    const admissible: number[] = [];
    for (let supported = 0; supported <= claimCount; supported += 1) {
      const coverage = supported / claimCount;
      if (coverage >= lo && coverage < hi) admissible.push(coverage);
    }
    if (admissible.length === 0) continue;
    return { claimCount, groundedness: admissible[Math.floor(pick * admissible.length)]! };
  }
  throw new Error(
    `no claim count in [${CLAIM_COUNTS.join(', ')}] gives a coverage in [${lo}, ${hi})`,
  );
}

/** The band the gate reason implies, as the engine's own comparisons define it. */
function coverageBandFor(reason: PolicyReason): { lo: number; hi: number } {
  if (reason === 'groundedness_block') return { lo: 0, hi: SEED_THRESHOLDS.groundednessBlock };
  if (reason === 'groundedness_review') {
    return { lo: SEED_THRESHOLDS.groundednessBlock, hi: SEED_THRESHOLDS.groundednessReview };
  }
  if (reason === 'auto') return { lo: SEED_THRESHOLDS.groundednessReview, hi: Infinity };
  // Every other reason returns before gate 2 is read, so coverage decided
  // nothing for this run and the whole range is truthful. A low number beside
  // `customer_visible` is not a contradiction: DEC-12 returned first, and
  // `reachedAgreementGate` is how a reader tells those runs apart.
  return { lo: 0, hi: Infinity };
}

/**
 * The draft a person sees, or the rationale they approve.
 *
 * The claims joined, and nothing else. `src/composer/composer.ts` builds a
 * draft as exactly that, so a seeder that wrote the two independently
 * produced a ledger the system cannot: the park row said one thing and the
 * compose row another, and every surface that renders the claims showed text
 * the draft did not contain.
 *
 * DEC-18: invented throughout, and about nobody.
 */
function draftFor(sentences: readonly PlannedSentence[]): string {
  return sentences.map((sentence) => sentence.text).join(' ');
}

/**
 * Openings a reply may take, and closings it may end on (DEC-43).
 *
 * A courtesy sentence greets the customer or invites a reply. None of them
 * says anything about the customer, the account, the policy or the outcome,
 * which is what makes them citable to nothing.
 *
 * Invented throughout, and about nobody (DEC-18). None of them names a person
 * or addresses one by name: a seeded corpus that greeted anybody would put a
 * name in a public repository.
 */
export const COURTESY_OPENINGS: readonly string[] = [
  'Thanks for getting in touch about this.',
  'Thanks for writing in, and sorry for the trouble.',
  'Thanks for the detail in your message, it helps.',
  'Sorry you have hit this, and thanks for flagging it.',
];

export const COURTESY_CLOSINGS: readonly string[] = [
  'Reply here if that does not sort it and we will take another look.',
  'Let us know if anything above does not match what you are seeing.',
  'If you need anything else on this, just reply to this message.',
  'Happy to keep digging if this is not the answer you needed.',
];

/**
 * The reply a run drafted, sentence by sentence (DEC-43).
 *
 * The composer writes the reply a support person would send. It may open with
 * one courtesy sentence and close with one, and it may do neither. This draws
 * all four shapes across the history, because a console that only ever met
 * one of them proves nothing about the other three.
 *
 * The claims keep their order and stay contiguous, which is the shape the
 * composer's parser accepts: a courtesy sentence between two claims is an
 * uncited sentence in the body of the answer, and the parser refuses it.
 */
function replyFor(claims: readonly PlannedClaim[], seed: number): PlannedSentence[] {
  const cited: PlannedSentence[] = claims.map((claim) => ({
    text: claim.text,
    docId: claim.docId,
    supported: claim.supported,
  }));
  const shape = seed % 4;
  const opens = shape === 0 || shape === 1;
  const closes = shape === 0 || shape === 2;
  return [
    ...(opens
      ? [{
        text: COURTESY_OPENINGS[seed % COURTESY_OPENINGS.length]!,
        docId: null,
        supported: null,
      }]
      : []),
    ...cited,
    ...(closes
      ? [{
        text: COURTESY_CLOSINGS[seed % COURTESY_CLOSINGS.length]!,
        docId: null,
        supported: null,
      }]
      : []),
  ];
}

/**
 * One sentence of a seeded reply (DEC-43).
 *
 * A `docId` names the document the sentence rests on, and `supported` carries
 * what the judge said about it. A courtesy sentence has neither: it opens or
 * closes the reply, cites nothing, and no verdict names it.
 */
export interface PlannedSentence {
  text: string;
  docId: string | null;
  supported: boolean | null;
}

/** One claim of a seeded draft, and the document it cites (DEC-07). */
export interface PlannedClaim {
  text: string;
  docId: string;
  /**
   * What the groundedness judge said about it.
   *
   * Derived from the run's own coverage rather than drawn, because the
   * fraction is `supported / claimCount` and a verdict list that disagreed
   * with it would put two numbers in the ledger where one decided.
   */
  supported: boolean;
}

/**
 * Sentences a document does not contain, for the claims the judge refuses.
 *
 * Each is a concrete promise about a timescale or an outcome that no document
 * in `SEED_DOCUMENTS` makes. That is what an unsupported claim is: a specific
 * the retrieved text does not carry, which is exactly the failure the
 * groundedness gate exists to catch (DEC-07, section 4.7).
 *
 * Invented throughout, and about nobody (DEC-18).
 */
export const UNSUPPORTED_CLAIMS: readonly string[] = [
  'The refund usually reaches your bank within five working days.',
  'A supervisor will call you back before the end of the day.',
  'This change takes effect immediately and cannot be reversed.',
  'We have applied a credit to your account as a goodwill gesture.',
  'Your data is removed from every backup within twenty four hours.',
  'The engineering team has already reproduced this on their side.',
  'You will not be charged again while this is open.',
  'The next invoice will show the corrected amount.',
  'Your access continues unchanged until this is resolved.',
  'We have escalated this to the team that owns the integration.',
  'A replacement confirmation is on its way to you now.',
  'This is a known issue and a fix is going out this week.',
];

/** The sentences of a document, which are what a claim can be grounded in. */
function sentencesOf(body: string): string[] {
  return body
    .split('. ')
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0)
    .map((sentence) => (sentence.endsWith('.') ? sentence : `${sentence}.`));
}

/**
 * The claims a seeded draft makes, and which of them the judge supported.
 *
 * A supported claim is a sentence of the document it cites. That is what
 * grounding is: the composer must cite or abstain (DEC-07), and a claim the
 * judge accepts is one the retrieved text carries. Inventing a sentence and
 * calling it supported would model a ledger the system cannot produce, and it
 * would give an operator nothing to check a citation against.
 *
 * An unsupported claim is a concrete promise no document makes. It still
 * cites one, because the composer refuses an uncited line — which is why the
 * groundedness gate exists as a second check rather than the citation being
 * enough on its own.
 *
 * The supported count is fixed by the coverage the run already drew, so a
 * reader recounting these reaches the fraction the gate row records.
 *
 * The unsupported ones come last. Nothing depends on that, and it makes a
 * seeded run readable when a person opens one.
 */
function claimsFor(
  docIds: readonly string[],
  claimCount: number,
  groundedness: number,
  seed: number,
): PlannedClaim[] {
  const supportedCount = Math.round(groundedness * claimCount);

  // Every sentence the retrieved documents carry, interleaved by document so
  // consecutive claims cite different ones and a document still comes round
  // more than once. Taken in order and never reused: a document has three
  // sentences, and a strict round-robin over documents wrapped past that and
  // repeated a sentence within one reply.
  const perDoc = docIds.map((docId) => ({
    docId,
    sentences: sentencesOf(SEED_DOCUMENTS.find((doc) => doc.docId === docId)!.body),
  }));
  // Document by document, not pass by pass. `docIds` is ordered by relevance,
  // so taking one sentence from each in turn reached the third document by
  // the third claim — and the third is a near miss. A reply about a refund
  // said something true about onboarding a workspace, which reads as a
  // system that has not understood the question.
  //
  // Exhausting the closest document first keeps a short reply inside the
  // documents that answer it, and a long one still reaches the rest.
  const grounded: { readonly text: string; readonly docId: string }[] = [];
  for (const doc of perDoc) {
    for (const sentence of doc.sentences) grounded.push({ text: sentence, docId: doc.docId });
  }
  // Then the contiguous pairs, because a run can make more claims than its
  // documents have sentences. A pair is still text the document carries, so
  // it is still grounded, and it reads as one longer point rather than a
  // sentence said twice.
  for (const doc of perDoc) {
    for (let i = 0; i + 1 < doc.sentences.length; i += 1) {
      grounded.push({ text: `${doc.sentences[i]!} ${doc.sentences[i + 1]!}`, docId: doc.docId });
    }
  }

  return Array.from({ length: claimCount }, (_, i) => {
    if (i >= supportedCount) {
      return {
        // Distinct within one reply. Twelve of them and at most ten claims,
        // so a run's unsupported claims are consecutive and never wrap onto
        // one another — six of them did, and a reply said the same
        // unsupported thing twice.
        text: UNSUPPORTED_CLAIMS[(seed + i) % UNSUPPORTED_CLAIMS.length]!,
        // It still cites a document, because the composer refuses an uncited
        // line. That is why the groundedness gate is a second check.
        docId: docIds[i % docIds.length]!,
        supported: false,
      };
    }
    const source = grounded[i]!;
    return { text: source.text, docId: source.docId, supported: true };
  });
}

/** Everything a run's journal records beyond its timing, its state and its provider. */
export interface RunDetail {
  classification: PlannedClassification;
  docIds: string[];
  claimCount: number;
  /** The claims, their citations and their verdicts (DEC-07, DEC-05). */
  claims: PlannedClaim[];
  /** The reply in draft order, courtesy sentences included (DEC-43). */
  sentences: PlannedSentence[];
  gate: PlannedGate | null;
  /**
   * How many steps the run counted, as the coordinator counts them.
   *
   * The coordinator increments once per journal step it finishes, and it
   * finishes `escalate` without counting it: an escalation is how a run ends
   * rather than work it did. So this is the journal rows this run writes,
   * less that one.
   *
   * Seeded as zero until now, while the run detail drew "5 entries" from the
   * journal beside "steps 0" from the run row — two numbers about one run,
   * on one screen, disagreeing.
   */
  stepsUsed: number;
  park: PlannedPark | null;
  actionClass: string;
  delivery: 'at_least_once' | 'at_most_once';
  actionPayload: Record<string, unknown>;
}

/**
 * The steps one run journals, derived from the outcome it already drew.
 *
 * Derived rather than drawn independently, and that is the whole point.
 * A run whose gate reason is `agreement` must carry an agreement below the
 * threshold that produced it, or a console renders the reason beside a number
 * that contradicts it and nothing in the ledger says which one is wrong.
 * `plan.test.ts` runs `evaluatePolicyDetailed` over every run to prove the
 * derivation and the engine still agree.
 *
 * `reason` is null for a run whose composer abstained. Such a run reaches no
 * engine at all: the coordinator journals the abstain and escalates before
 * the gate step starts, so it carries no gate row, no park row and no claims.
 */
function planDetail(
  rng: () => number,
  reason: PolicyReason | null,
  ticketId: string,
  /** When this run's reply was composed, for the provenance it carries. */
  composedAt: string,
): RunDetail {
  // The intent, from the pool the reason allows. `high_risk` needs the high
  // tier by definition; a reason that got past the risk check needs anything
  // but it; a reason that returned before it takes the whole taxonomy.
  const pool = reason === 'high_risk'
    ? SEED_INTENTS.filter((intent) => intent.riskTier === 'high')
    : reason !== null && !BEFORE_RISK_CHECK.has(reason)
      ? SEED_INTENTS.filter((intent) => intent.riskTier !== 'high')
      : SEED_INTENTS;
  const intent = pool[Math.floor(rng() * pool.length)]!;

  // Agreement is a count of agreeing samples over CLASSIFIER_K, so the only
  // values the classifier can report are k/9. A uniform real in [0, 1] would
  // be a number the classifier cannot produce.
  const threshold = agreementThresholdFor({ intent: intent.id, thresholds: SEED_THRESHOLDS });
  const counts: number[] = [];
  for (let k = 1; k <= CLASSIFIER_K; k += 1) {
    const agreement = k / CLASSIFIER_K;
    if (reason === 'agreement') {
      if (agreement < threshold) counts.push(agreement);
    } else if (reason !== null && reachedAgreementGate(reason)) {
      if (agreement >= threshold) counts.push(agreement);
    } else {
      // The comparison never happened, so no value is excluded. Seeding those
      // runs across the whole range is what makes `reachedAgreementGate`
      // visible in the ledger rather than only in the engine.
      counts.push(agreement);
    }
  }
  const agreement = counts[Math.floor(rng() * counts.length)]!;

  // Five is the coordinator's own retrieval limit. Fewer is ordinary: the
  // lexical channel returns nothing for a query with no matching term.
  const docCount = 3 + Math.floor(rng() * 3);
  // What a search would rank first for this intent, then near misses. A
  // uniform draw over the corpus answered a refund question with the mobile
  // application, and no ordering of those sentences is a reply.
  const relevant = DOCUMENTS_FOR[intent.id] ?? [];
  const docIds: string[] = [...relevant].slice(0, docCount);
  const remaining = SEED_DOCUMENTS
    .map((doc) => doc.docId)
    .filter((docId) => !docIds.includes(docId));
  while (docIds.length < docCount) {
    docIds.push(remaining.splice(Math.floor(rng() * remaining.length), 1)[0]!);
  }

  // The action, and with it the delivery rule DEC-29 binds to the class.
  const actionClass = reason === 'customer_visible'
    ? CUSTOMER_REPLY_ACTION_CLASS
    : reason === 'irreversible'
      ? COMPENSATION_ACTION_CLASS
      : INTERNAL_ACTION_CLASSES[Math.floor(rng() * INTERNAL_ACTION_CLASSES.length)]!;
  const queue = SEED_QUEUES[Math.floor(rng() * SEED_QUEUES.length)]!;
  // Each class carries the field its adapter demands. `route_ticket` rejects
  // a payload with no queue and `compensate` one with no reason, so a payload
  // shaped for the wrong class is a record the relay can never dispatch.
  const actionPayload: Record<string, unknown> =
    actionClass === CUSTOMER_REPLY_ACTION_CLASS
      ? { intent: intent.id }
      : actionClass === COMPENSATION_ACTION_CLASS
        ? { reason: 'synthetic compensation of a seeded irreversible write' }
        : actionClass === 'route_ticket'
          ? { queue }
          : { resolution: 'synthetic' };
  const delivery = actionClass === COMPENSATION_ACTION_CLASS ? 'at_most_once' : 'at_least_once';

  const classification: PlannedClassification = {
    intentId: intent.id,
    riskTier: intent.riskTier,
    agreement,
  };

  if (reason === null) {
    // An abstain composes no claims, so it has nothing for the groundedness
    // gate to read. `checkGroundedness` refuses an empty claim list outright.
    return {
      classification,
      docIds,
      claimCount: 0,
      // Empty, never a claim with no verdict. An abstain composes nothing,
      // and `checkGroundedness` refuses an empty claim list outright, so
      // there is no gate row for these verdicts to disagree with.
      claims: [],
      // An abstain drafts no reply at all, so it has no sentences either. A
      // courtesy sentence here would be a reply that greets the customer and
      // then says nothing, which is not what an abstain produces (DEC-07).
      sentences: [],
      gate: null,
      park: null,
      // classify, retrieve, compose. An abstain escalates before the gate
      // step starts, and the escalate row is not a counted step.
      stepsUsed: 3,
      actionClass,
      delivery,
      actionPayload,
    };
  }

  const band = coverageBandFor(reason);
  const { claimCount, groundedness } = coverageIn(rng, band.lo, band.hi);
  const decision: PolicyDecision = reason === 'auto'
    ? 'auto'
    : ESCALATING_REASONS.has(reason)
      ? 'escalate'
      : 'gated';
  const gate: PlannedGate = {
    groundedness,
    decision,
    capabilities: reason === 'no_idempotency'
      ? { ...FULL_CAPABILITIES, supportsIdempotencyKey: false }
      : FULL_CAPABILITIES,
    action: {
      // The coordinator hard-codes it: every action it evaluates is a write.
      isWrite: true,
      isCustomerVisible: actionClass === CUSTOMER_REPLY_ACTION_CLASS,
      // Derived from the class, exactly as the coordinator derives it, so a
      // run cannot claim a reversible compensation.
      isIrreversible: actionClass === COMPENSATION_ACTION_CLASS,
    },
  };

  // The claims first, because they are the reply's cited sentences, then the
  // reply around them (DEC-43). One draw feeds both, so a run's opening and
  // its unsupported claims come from the same seed.
  const claimSeed = Math.floor(rng() * 997);
  const claims = claimsFor(docIds, claimCount, groundedness, claimSeed);
  const sentences = replyFor(claims, claimSeed);
  const body = draftFor(sentences);
  const park: PlannedPark | null = decision !== 'gated'
    ? null
    : actionClass === CUSTOMER_REPLY_ACTION_CLASS
      // DEC-11: the draft lives in the helpdesk and the journal records its
      // handle. Derived from the ticket rather than drawn, so it needs no
      // place in the stream and a reader can match the two by eye.
      ? {
        draftExternalId: `SYN-DRAFT-${ticketId.slice(2)}`,
        actionClass,
        delivery,
        body,
        turnNumber: 1,
        disclosure: SEED_DISCLOSURE,
        // The run's own composition time, so a seeded reply carries a
        // provenance that matches the history around it.
        provenance: {
          generatedBy: 'auracle',
          modelId: SEED_PIN,
          promptVer: SEED_PIN,
          generatedAt: composedAt,
        },
      }
      // DEC-34: a gated write with no customer draft parks in the ledger
      // alone, and approval relays the journaled payload through
      // `performAction`. A record with neither a handle nor a payload is one
      // `approveRun` refuses.
      : { actionClass, delivery, body, payload: actionPayload, turnNumber: 1 };

  return {
    classification, docIds, claimCount, claims, sentences, gate, park,
    // classify, retrieve and compose always; gate whenever the policy engine
    // ran; park whenever the decision parked one. Counted from the same
    // conditions `writeJournal` writes those rows under.
    stepsUsed: 3 + 1 + (park === null ? 0 : 1),
    actionClass, delivery, actionPayload,
  };
}

/** A planned run before its journal detail is drawn. */
type PlannedRunCore = Omit<PlannedRun, keyof RunDetail>;

export function planHistory(options: PlanOptions): PlannedRun[] {
  const degradedDay = dayBefore(options.endDay, 4);
  const consumers = options.consumers ?? 2;
  const meanArrivals = options.arrivalsPerDay ?? 54;
  const pollMs = options.pollIntervalMs ?? 5_000;
  const wakeOnArrival = options.wakeOnArrival ?? true;
  const planned: PlannedRun[] = [];

  // Which consumer owns which partition. CONSUMER_PARTITIONS names a set per
  // process, and the sets are contiguous in every example the runbook gives.
  const ownerOf = (partition: number): number =>
    Math.floor(partition / Math.ceil(options.partitions / consumers));

  for (let d = options.days - 1; d >= 0; d -= 1) {
    const day = dayBefore(options.endDay, d);
    const rng = mulberry32(seedForDay(options.seed, day));
    const degraded = day === degradedDay;
    const dayStartMs = Date.parse(`${day}T07:00:00.000Z`);
    const windowMs = 11 * 3_600_000;

    // Poisson arrivals: the count varies, and the gaps are exponential, so
    // the day carries clusters rather than an even spread.
    const arrivals = poisson(rng, meanArrivals);
    const gapMs = windowMs / Math.max(arrivals, 1);

    const drawn = [];
    let cursor = dayStartMs;
    for (let i = 0; i < arrivals; i += 1) {
      cursor += exponentialGap(rng, gapMs);
      const conversationId = seededUuid(rng);
      const ticketId = `T-${seededUuid(rng).slice(0, 8)}`;
      drawn.push({
        conversationId,
        ticketId,
        partition: partitionOf(conversationId, options.partitions),
        arrivedMs: Math.round(cursor),
        // Twelve model calls, so the total inherits their tail.
        serviceMs: logNormal(rng, 14_000, 0.9),
        reason: weighted(rng, degraded ? DEGRADED_REASONS : HEALTHY_REASONS),
        abstained: rng() < 0.17,
        approvalRoll: rng(),
        // A normalized token-level Levenshtein distance, which is what the
        // column stores (db/003) and what `approvalEditDistance` returns.
        // The median says most drafts survive nearly intact; the sigma keeps
        // the long right tail, because a person who rewrites a draft rewrites
        // most of it. `logNormalUnit` takes the same two draws `logNormal`
        // took, so the rest of the history is unmoved by the correction.
        editRaw: logNormalUnit(rng, 0.06, 1.1),
        unknownRoll: rng(),
        runId: seededUuid(rng),
      });
    }

    // The day's runs, before the steps each one journals are drawn.
    const dayRuns: PlannedRunCore[] = [];

    // The consumer loop, as consumer-main.ts and processQueuedTickets run it.
    //
    // Each consumer is one server. It wakes on its poll tick, takes every
    // message queued across the partitions it owns, and walks that batch
    // serially. So a ticket waits for the tick, then for everything ahead of
    // it in the batch — including tickets on a different partition the same
    // consumer owns, which is the head-of-line delay item 7 names.
    const freeAt = new Map<number, number>();
    const byConsumer = new Map<number, typeof drawn>();
    for (const a of drawn) {
      const owner = ownerOf(a.partition);
      const list = byConsumer.get(owner) ?? [];
      list.push(a);
      byConsumer.set(owner, list);
    }

    for (const [owner, queue] of byConsumer) {
      // Served in the order the queue filled.
      queue.sort((x, y) => x.arrivedMs - y.arrivedMs);
      for (const a of queue) {
        // When the consumer learns the message exists. With the arrival
        // signal that is the instant it was queued, because intake notifies
        // inside the same transaction. Without it, the next poll tick: a
        // message was invisible until the consumer looked, whatever the load.
        const visibleMs = wakeOnArrival
          ? a.arrivedMs
          : dayStartMs + Math.ceil((a.arrivedMs - dayStartMs) / pollMs) * pollMs;
        const free = freeAt.get(owner) ?? 0;
        const startedMs = Math.max(visibleMs, free);
        freeAt.set(owner, startedMs + a.serviceMs);

        // An abstain escalates before the gate step starts, so such a run
        // carries no gate row and no approval. DEC-07: it is a correct
        // output, not an error, and it keeps its partial work.
        const reason = a.abstained ? null : a.reason;
        // A person approves a parked run (DEC-12 for a customer reply, DEC-34
        // for a write with no draft), and the distance is what they changed.
        // Most drafts survive nearly intact.
        const approved =
          reason !== null
            && !ESCALATING_REASONS.has(reason)
            && reason !== 'auto'
            && a.approvalRoll < 0.62;
        // DEC-30 makes an unknown delivery terminal AND escalating, so a run
        // carrying one cannot also be resolved. Only an automatic write
        // reaches the relay at all.
        const unknownDelivery = reason === 'auto' && a.unknownRoll < 0.02;
        const state = a.abstained
          ? 'escalated'
          : unknownDelivery
            ? 'escalated'
            : stateFor(reason ?? 'auto', approved);

        // Why the run stopped, read off what it did rather than drawn.
        //
        // Three paths reach `escalated` here and each one names itself. The
        // composer's abstain is a determination, not a fault, and
        // `stopEscalated` journals it as such (DEC-07). A policy escalation
        // is the engine's `escalate` verdict, which is the whole of
        // ESCALATING_REASONS. An unknown delivery is the relay's, and it is
        // the one that does not come from the coordinator at all.
        //
        // Drawing this would have let a run that abstained report a policy
        // escalation. The console renders the state and the reason side by
        // side, so the contradiction would be on screen with nothing to say
        // which half was wrong. It also needs no draw at all, so the history
        // above it is untouched.
        const escalation: PlannedRun['escalation'] = a.abstained
          ? 'composer_abstained'
          : unknownDelivery
            ? 'relay_delivery_unknown'
            : state === 'escalated'
              ? 'policy_escalated'
              : null;

        // db/005 defines service time as finished_at - created_at, so an
        // approved run's service time includes the wait for the person. That
        // is the truth about this system: DEC-12 puts a person on every
        // customer reply, and the ledger measures the run, not the model
        // calls inside it. Drawn log-normal around three quarters of an hour.
        const approvalMs = approved ? logNormal(rng, 2_700_000, 1.0) : 0;
        const finishedAt =
          state === 'awaiting_approval'
            ? null
            : new Date(startedMs + a.serviceMs + approvalMs);
        dayRuns.push({
          runId: a.runId,
          ticketId: a.ticketId,
          conversationId: a.conversationId,
          partition: a.partition,
          enqueuedAt: new Date(a.arrivedMs),
          createdAt: new Date(startedMs),
          serviceMs: a.serviceMs,
          finishedAt,
          state,
          abstained: a.abstained,
          reason,
          escalation,
          provider: options.provider,
          editDistance: approved ? a.editRaw : null,
          outbox: unknownDelivery ? ['delivery_unknown'] : [],
        });
      }
    }

    // The steps each run journals, drawn only once every draw the day already
    // made has been made.
    //
    // The position is load-bearing. `pnpm run bands` reads three journal
    // fields — the compose step's `abstained` and `provider`, and the gate
    // step's `reason` — and publishes them as a control band, while
    // `docs/v1-architecture.md` quotes a mean service time off the finish
    // stamps the loop above draws. A draw inserted anywhere earlier shifts
    // every value after it in the stream, so adding detail to a run would
    // have moved the published numbers that describe it. Appended, it moves
    // nothing above it, and `plan.test.ts` pins that against the planner as
    // it stood before this detail existed.
    for (const run of dayRuns) {
      const detail = planDetail(
        rng,
        run.abstained ? null : run.reason,
        run.ticketId,
        run.createdAt.toISOString(),
      );
      planned.push({
        ...run,
        ...detail,
        // A distance only where a person edited a reply (section 4.10).
        //
        // `approveRun` measures the draft against the text that was sent, and
        // it captures neither for a park with no helpdesk draft — a
        // ledger-only park has no customer-visible text (DEC-34), so
        // production leaves this column null.
        //
        // The seeder wrote the drawn number there anyway, and `pnpm run
        // bands` reads the column with no draft-backed predicate: 223 of 812
        // distances on the default history were a number with no text behind
        // it, which is 27 per cent of a published control band's population.
        editDistance: detail.park?.draftExternalId === undefined ? null : run.editDistance,
      });
    }
  }
  return planned;
}
