// Integration suite for the run-journal reader (src/journal/query.ts).
//
// Every fixture is written here, row by row, rather than produced by driving
// the coordinator. Two reasons. The shapes this reader has to survive are the
// ones no healthy run produces — a result that is not an object, a step id
// nobody has heard of, a document id the index no longer holds — and a run
// cannot be asked to make them. And `src/seed` is growing the ability to
// journal these steps, so a suite that read seeded rows would assert against
// a fixture another module owns.
//
// The shapes that a run DOES produce are copied from `coordinator.ts` by
// hand, and `journal.test.ts` holds the case that keeps the step set honest.
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { dbUrl } from '../db/config.js';
import { truncateLedger } from '../test-support/schema.js';
import { readRunJournal } from './query.js';

const pool = new Pool({ connectionString: dbUrl(), max: 4 });

// The global setup guarantees a reachable database before the workers fork.
// A failure here is a fault, and a suite that skipped itself would report
// success while proving nothing.
await pool.query('SELECT 1');

interface Row {
  stepId: string;
  status: string;
  /** Absent for a row journalled before its step produced an outcome. */
  result?: unknown;
  promptVer?: string;
  modelVer?: string;
  costMicros?: number;
}

/**
 * Writes journal rows directly.
 *
 * No `run` row: this reader joins none, so a bare uuid is all a journal row
 * needs. The suite exercising a reader that joined `run` would not notice
 * that it did.
 */
async function journal(rows: readonly Row[]): Promise<string> {
  const runId = randomUUID();
  for (const row of rows) {
    await pool.query(
      `INSERT INTO step_journal
         (run_id, step_id, status, result, prompt_ver, model_ver, cost_micros)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
      [
        runId,
        row.stepId,
        row.status,
        row.result === undefined ? null : JSON.stringify(row.result),
        row.promptVer ?? 'p1',
        row.modelVer ?? 'm1',
        row.costMicros ?? 0,
      ],
    );
  }
  return runId;
}

async function indexDoc(docId: string, title: string, reviewBy: string): Promise<void> {
  await pool.query(
    `INSERT INTO document (doc_id, kind, title, body, owner, review_by, embedding)
     VALUES ($1, 'document', $2, 'synthetic text', 'support-team', $3, $4::vector)
     ON CONFLICT (doc_id) DO UPDATE SET title = EXCLUDED.title`,
    [docId, title, reviewBy, `[${Array(1536).fill(0).join(',')}]`],
  );
}

const THRESHOLDS = {
  agreement: 0.7,
  groundednessBlock: 0.7,
  groundednessReview: 0.8,
  perIntent: { refund_request: 0.9 },
};

/** A run that walked the whole automatic path, as the coordinator writes it. */
async function fullRun(intentId = 'password_reset'): Promise<string> {
  return journal([
    {
      stepId: 'classify',
      status: 'done',
      result: { intentId, agreement: 0.89 },
      costMicros: 120,
    },
    {
      stepId: 'retrieve',
      status: 'done',
      result: { docIds: ['doc-b', 'doc-a'], embed_model_ver: 'embed-1' },
      costMicros: 200,
    },
    {
      stepId: 'compose',
      status: 'done',
      result: {
        abstained: false,
        claimCount: 3,
        staleDocumentIds: ['doc-a'],
        provider: 'stub',
      },
      costMicros: 900,
    },
    {
      stepId: 'gate',
      status: 'done',
      result: {
        groundedness: 0.95,
        decision: 'auto',
        reason: 'auto',
        thresholds: THRESHOLDS,
      },
      costMicros: 1400,
    },
    { stepId: 'execute', status: 'done', result: { idemKey: 'idem-abc' }, costMicros: 1400 },
  ]);
}

beforeEach(async () => {
  await truncateLedger(pool);
});

afterAll(async () => {
  await pool.end();
});

describe('a run with a full journal', () => {
  it('returns every step in the canonical order, not the alphabetical one', async () => {
    const runId = await fullRun();
    const result = await readRunJournal(pool, runId);
    expect(result?.steps.map((s) => s.stepId)).toEqual([
      'classify',
      'retrieve',
      'compose',
      'gate',
      'execute',
    ]);
    // The order the database would have given unaided, which is not causal.
    expect(result?.steps.map((s) => s.stepId)).not.toEqual(
      ['classify', 'compose', 'execute', 'gate', 'retrieve'],
    );
  });

  it('reads the two gates as two independent values (DEC-05)', async () => {
    const runId = await fullRun();
    const result = await readRunJournal(pool, runId);
    expect(result?.agreement).toEqual({
      intentId: 'password_reset',
      agreement: 0.89,
      unreadableSamples: null,
      threshold: 0.7,
    });
    expect(result?.coverage).toEqual({
      groundedness: 0.95,
      decision: 'auto',
      reason: 'auto',
      blockThreshold: 0.7,
      reviewThreshold: 0.8,
      // Coverage detail beside the fraction. This fixture journals none, and
      // the shape stays exact so a field appearing here has to be looked at.
      claimVerdicts: null,
    });
  });

  it('takes the fitted threshold when the classified intent has one (DEC-41)', async () => {
    const runId = await fullRun('refund_request');
    const result = await readRunJournal(pool, runId);
    // The scalar is not stored anywhere. It is the per-intent entry from the
    // gate row applied to the intent from the classify row, which is two rows
    // and a rule that lives in the policy engine.
    expect(result?.agreement?.threshold).toBe(0.9);
    // The other gate is untouched by the intent, because the map belongs to
    // the agreement gate alone.
    expect(result?.coverage?.blockThreshold).toBe(0.7);
  });

  it('reports the run cost at each step, which is cumulative and not per step', async () => {
    const runId = await fullRun();
    const result = await readRunJournal(pool, runId);
    expect(result?.steps.map((s) => s.runCostMicrosAtStep)).toEqual([120, 200, 900, 1400, 1400]);
  });

  it('carries the pins and the embedding pin (DEC-26)', async () => {
    const runId = await fullRun();
    const result = await readRunJournal(pool, runId);
    const retrieve = result?.steps.find((s) => s.stepId === 'retrieve');
    expect(retrieve?.promptVer).toBe('p1');
    expect(retrieve?.modelVer).toBe('m1');
    expect(retrieve?.embedModelVer).toBe('embed-1');
  });

  it('reports the compose outcome and the execute key', async () => {
    const runId = await fullRun();
    const result = await readRunJournal(pool, runId);
    expect(result?.steps.find((s) => s.stepId === 'compose')?.compose).toEqual({
      abstained: false,
      claimCount: 3,
      staleDocumentIds: ['doc-a'],
      // This fixture journals none of them, and the shape stays exact so a
      // field appearing here has to be looked at rather than absorbed.
      sentences: null,
      claims: null,
      citedBodies: null,
      provider: 'stub',
    });
    expect(result?.steps.find((s) => s.stepId === 'execute')?.idemKey).toBe('idem-abc');
  });
});

describe('the compose step', () => {
  it('reads an abstain, which is a determination and not a fault (DEC-07)', async () => {
    const runId = await journal([
      {
        stepId: 'compose',
        status: 'abstained',
        result: { abstained: true, claimCount: 0, staleDocumentIds: [], provider: 'stub' },
      },
    ]);
    const step = (await readRunJournal(pool, runId))?.steps[0];
    // An allowlist of `done` alone would have discarded this, which is the
    // outcome an operator most wants to see.
    expect(step?.compose?.abstained).toBe(true);
    expect(step?.compose?.claimCount).toBe(0);
  });

  it('refuses a compose outcome carried on a row that failed', async () => {
    const runId = await journal([
      {
        stepId: 'compose',
        status: 'failed',
        result: { abstained: true, shape: 'no-content', error: 'unreadable' },
      },
    ]);
    expect((await readRunJournal(pool, runId))?.steps[0]?.compose).toBeNull();
  });

  it('reports an unrecorded claim count as unmeasured, never as zero', async () => {
    const runId = await journal([
      { stepId: 'compose', status: 'done', result: { abstained: false, provider: 'stub' } },
    ]);
    const compose = (await readRunJournal(pool, runId))?.steps[0]?.compose;
    // Zero claims is a real outcome and the groundedness denominator. A row
    // that recorded nothing must not be shown as one.
    expect(compose?.claimCount).toBeNull();
    // The empty list is a clean bill of health under DEC-23. This row gave
    // none, so it gets none.
    expect(compose?.staleDocumentIds).toBeNull();
  });

  it('separates a stale list that is empty from one that was not recorded', async () => {
    const runId = await journal([
      {
        stepId: 'compose',
        status: 'done',
        result: { abstained: false, claimCount: 2, staleDocumentIds: [], provider: 'model' },
      },
    ]);
    expect((await readRunJournal(pool, runId))?.steps[0]?.compose?.staleDocumentIds).toEqual([]);
  });

  // The field's own contract says null, never the empty list, because an
  // empty list is a clean bill of health. A member that is not a string used
  // to be filtered out, so a list of one bad member answered the same as a
  // run whose every cited document was inside its review window.
  it('reads a stale list holding a non-string as unrecorded, not as empty', async () => {
    const runId = await journal([
      {
        stepId: 'compose',
        status: 'done',
        result: { abstained: false, claimCount: 2, staleDocumentIds: ['SYN-1', 7], provider: 'model' },
      },
    ]);
    expect((await readRunJournal(pool, runId))?.steps[0]?.compose?.staleDocumentIds).toBeNull();
  });
});

describe('a retrieval the reader cannot take at its word', () => {
  // Three states, and the reader used to hold two. A completed retrieve row
  // whose `docIds` is unreadable is neither a run that never retrieved (null)
  // nor a retrieval that found nothing (the empty list).
  it('reports an unreadable id list under its own name, not as no retrieval', async () => {
    const runId = await journal([
      { stepId: 'retrieve', status: 'done', result: { docIds: 'SYN-1', embed_model_ver: 'e1' } },
    ]);
    const read = await readRunJournal(pool, runId);
    expect(read?.documentsMalformed).toBe(true);
    expect(read?.documents).toBeNull();
  });

  it('separates that from a run that never reached the retriever', async () => {
    const runId = await journal([
      { stepId: 'classify', status: 'done', result: { intentId: 'password_reset', agreement: 1 } },
    ]);
    const read = await readRunJournal(pool, runId);
    expect(read?.documentsMalformed).toBe(false);
    expect(read?.documents).toBeNull();
  });

  it('separates that from a retrieval that found nothing', async () => {
    const runId = await journal([
      { stepId: 'retrieve', status: 'done', result: { docIds: [], embed_model_ver: 'e1' } },
    ]);
    const read = await readRunJournal(pool, runId);
    expect(read?.documentsMalformed).toBe(false);
    expect(read?.documents).toEqual([]);
  });

  // Filtering the readable members shortened the list handed to the SELECT,
  // and its WITH ORDINALITY then numbered positions over the shorter list. So
  // a dropped member rendered as a complete retrieval with wrong positions.
  it('refuses a part-readable list rather than renumbering what survives', async () => {
    await indexDoc('SYN-KEEP', 'a document that resolves', '2027-01-01');
    const runId = await journal([
      { stepId: 'retrieve', status: 'done', result: { docIds: [null, 'SYN-KEEP'], embed_model_ver: 'e1' } },
    ]);
    const read = await readRunJournal(pool, runId);
    expect(read?.documentsMalformed).toBe(true);
    expect(read?.documents).toBeNull();
  });
});

describe('what the reader now returns about a draft and its claims', () => {
  // DEC-40: a console may approve a parked draft, and an approver who cannot
  // read the reply cannot approve it. This used to be a boolean.
  it('returns the parked draft, and says when there is none', async () => {
    const withDraft = await journal([
      {
        stepId: 'park',
        status: 'done',
        result: {
          draftExternalId: 'hd-1', actionClass: 'send_reply',
          delivery: 'at_most_once', body: 'We refunded the duplicate charge.',
        },
      },
    ]);
    const park = (await readRunJournal(pool, withDraft))?.steps[0]?.park;
    expect(park?.draftRecorded).toBe(true);
    expect(park?.draftBody).toBe('We refunded the duplicate charge.');

    const marker = await journal([
      { stepId: 'park', status: 'parking', result: { actionClass: 'send_reply', parkKey: 'k' } },
    ]);
    const none = (await readRunJournal(pool, marker))?.steps[0]?.park;
    expect(none?.draftRecorded).toBe(false);
    expect(none?.draftBody).toBeNull();
  });

  // The fault message names two customer addresses in the one adapter that
  // builds it, so its presence is reported and its text is not.
  //
  // The action payload is the other half, and it goes the other way. It is
  // the operator's own action rather than a customer's message, and DEC-40
  // lets a console approve a parked action because the approver reads what
  // they are approving — a ledger-only park has no drafted reply, so the
  // payload is the whole of the act. Withholding it put an Approve button
  // over an action whose target appeared nowhere on the page.
  it('withholds the fault message and returns the action payload', async () => {
    const runId = await journal([
      {
        stepId: 'park',
        status: 'failed',
        result: {
          actionClass: 'send_reply', parkKey: 'k',
          error: 'expected ada@customer.example but the thread is from bob@customer.example',
          payload: { queue: 'billing' },
        },
      },
    ]);
    const read = await readRunJournal(pool, runId);
    expect(read?.steps[0]?.park?.failureRecorded).toBe(true);
    expect(read?.steps[0]?.park?.payloadRecorded).toBe(true);
    expect(read?.steps[0]?.park?.payload).toEqual({ queue: 'billing' });
    // The address the fault carries is still not on any surface.
    expect(JSON.stringify(read)).not.toContain('customer.example');
  });

  // `approveRun` accepts a plain object and refuses everything else, so a
  // surface offering to perform any other shape would offer an action the
  // approval path throws on.
  it('returns no payload for a shape the approval path would refuse', async () => {
    for (const payload of ['text', 7, ['a'], null]) {
      const runId = await journal([
        {
          stepId: 'park',
          status: 'done',
          result: { actionClass: 'compensate', parkKey: 'k', payload },
        },
      ]);
      const park = (await readRunJournal(pool, runId))?.steps[0]?.park;
      expect(park?.payload, JSON.stringify(payload)).toBeNull();
    }
  });

  it('returns each claim with the document it cites (DEC-07)', async () => {
    const runId = await journal([
      {
        stepId: 'compose',
        status: 'done',
        result: {
          abstained: false, claimCount: 2, staleDocumentIds: [], provider: 'stub',
          claims: [
            { text: 'Refunds post in five days.', docId: 'SYN-1' },
            { text: 'Your subscription is unchanged.', docId: 'SYN-2' },
          ],
          citedBodies: { 'SYN-1': 'body one', 'SYN-2': 'body two' },
        },
      },
    ]);
    const compose = (await readRunJournal(pool, runId))?.steps[0]?.compose;
    expect(compose?.claims).toEqual([
      { text: 'Refunds post in five days.', docId: 'SYN-1' },
      { text: 'Your subscription is unchanged.', docId: 'SYN-2' },
    ]);
    expect(compose?.citedBodies).toEqual({ 'SYN-1': 'body one', 'SYN-2': 'body two' });
  });

  // DEC-43. The row holds the reply, not the claims, and a reader that took
  // only the cited members would report a reply the customer never reads.
  it('returns every sentence of the draft, courtesy sentences included (DEC-43)', async () => {
    const runId = await journal([
      {
        stepId: 'compose',
        status: 'done',
        result: {
          abstained: false, claimCount: 1, staleDocumentIds: [], provider: 'stub',
          sentences: [
            { text: 'Thanks for writing in.', docId: null },
            { text: 'Refunds post in five days.', docId: 'SYN-1' },
            { text: 'Reply here if it has not arrived.', docId: null },
          ],
        },
      },
    ]);
    const compose = (await readRunJournal(pool, runId))?.steps[0]?.compose;
    expect(compose?.sentences).toEqual([
      { text: 'Thanks for writing in.', docId: null },
      { text: 'Refunds post in five days.', docId: 'SYN-1' },
      { text: 'Reply here if it has not arrived.', docId: null },
    ]);
    // The gate records a verdict by position into this list, so a courtesy
    // sentence entering it would move every later verdict onto the wrong
    // claim. Derived from the partition, never read from a second key.
    expect(compose?.claims).toEqual([
      { text: 'Refunds post in five days.', docId: 'SYN-1' },
    ]);
  });

  // Every run composed before DEC-43 holds `claims`, whose members all cite.
  // A reader answering null for those rows would report the whole history of
  // this ledger as having drafted nothing.
  it('reads a row written before DEC-43 as a partition that cites throughout', async () => {
    const runId = await journal([
      {
        stepId: 'compose',
        status: 'done',
        result: {
          abstained: false, claimCount: 1, staleDocumentIds: [], provider: 'stub',
          claims: [{ text: 'Refunds post in five days.', docId: 'SYN-1' }],
        },
      },
    ]);
    const compose = (await readRunJournal(pool, runId))?.steps[0]?.compose;
    expect(compose?.sentences).toEqual([
      { text: 'Refunds post in five days.', docId: 'SYN-1' },
    ]);
  });

  // Whole or not at all. The verdicts index into this list, so a dropped
  // member would attribute every later verdict to the wrong claim.
  it('refuses a claim list holding an unreadable member, rather than shortening it', async () => {
    const runId = await journal([
      {
        stepId: 'compose',
        status: 'done',
        result: {
          abstained: false, claimCount: 2, staleDocumentIds: [], provider: 'stub',
          claims: [{ text: 'fine', docId: 'SYN-1' }, { text: 7, docId: 'SYN-2' }],
        },
      },
    ]);
    expect((await readRunJournal(pool, runId))?.steps[0]?.compose?.claims).toBeNull();
  });

  // The twin of the case above, on the other field. An unreadable docId that
  // was demoted to a courtesy sentence would leave the ledger reporting a
  // shorter reply, drop the member from the claims, and move every later
  // verdict onto the wrong claim.
  it('refuses a partition whose member cites something that is not a document id', async () => {
    for (const docId of [7, {}, ['SYN-1'], true]) {
      const runId = await journal([
        {
          stepId: 'compose',
          status: 'done',
          result: {
            abstained: false, claimCount: 2, staleDocumentIds: [], provider: 'stub',
            sentences: [
              { text: 'Thanks for writing in.', docId: null },
              { text: 'fine', docId: 'SYN-1' },
              { text: 'not fine', docId },
            ],
          },
        },
      ]);
      const compose = (await readRunJournal(pool, runId))?.steps[0]?.compose;
      expect(compose?.sentences, JSON.stringify(docId)).toBeNull();
      expect(compose?.claims, JSON.stringify(docId)).toBeNull();
    }
  });

  // Both writers emit the key from a `string | null` field, so a member
  // without one is a malformed row rather than a courtesy sentence. Reading
  // it as courteous would silently shorten the claims.
  it('refuses a member that names no citation at all, rather than reading it as courtesy', async () => {
    const runId = await journal([
      {
        stepId: 'compose',
        status: 'done',
        result: {
          abstained: false, claimCount: 1, staleDocumentIds: [], provider: 'stub',
          sentences: [{ text: 'a sentence with no docId key' }],
        },
      },
    ]);
    const compose = (await readRunJournal(pool, runId))?.steps[0]?.compose;
    expect(compose?.sentences).toBeNull();
  });

  it('returns the verdicts by position, beside the fraction and never instead of it', async () => {
    const runId = await journal([
      {
        stepId: 'gate',
        status: 'done',
        result: {
          groundedness: 0.5, decision: 'gated', reason: 'customer_visible',
          thresholds: THRESHOLDS,
          // Each entry carries a claim text the reader must not pass through.
          // Without one here the assertion below could not fail: the fixture
          // held no such key, so `verdictsOf` had nothing to leak.
          claimVerdicts: [
            { claimIndex: 0, supported: true, text: 'Refunds post in five days.' },
            { claimIndex: 1, supported: false, text: 'Your bank decides when.' },
          ],
        },
      },
    ]);
    const coverage = (await readRunJournal(pool, runId))?.coverage;
    expect(coverage?.groundedness).toBe(0.5);
    expect(coverage?.claimVerdicts).toEqual([
      { claimIndex: 0, supported: true },
      { claimIndex: 1, supported: false },
    ]);
    // The claims joined are the draft, so carrying the text here would store
    // the reply a second time.
    expect(JSON.stringify(coverage)).not.toContain('Refunds post');
  });

  it('refuses a verdict list holding an unreadable member', async () => {
    const runId = await journal([
      {
        stepId: 'gate',
        status: 'done',
        result: {
          groundedness: 0.5, decision: 'gated', reason: 'customer_visible',
          thresholds: THRESHOLDS,
          claimVerdicts: [{ claimIndex: 0, supported: true }, { claimIndex: 'one', supported: false }],
        },
      },
    ]);
    expect((await readRunJournal(pool, runId))?.coverage?.claimVerdicts).toBeNull();
  });
});

describe('whether a cited document still says what the run read', () => {
  it('says unchanged when the body still matches the recorded digest', async () => {
    await indexDoc('SYN-SAME', 'a document', '2027-01-01');
    const { rows } = await pool.query(
      "SELECT encode(sha256(convert_to(body, 'UTF8')), 'hex') AS h FROM document WHERE doc_id = 'SYN-SAME'",
    );
    const runId = await journal([
      {
        stepId: 'retrieve',
        status: 'done',
        result: {
          docIds: ['SYN-SAME'], embed_model_ver: 'e1',
          documents: [{
            docId: 'SYN-SAME', title: 'a document', owner: 'support-team',
            reviewBy: '2027-01-01', bodyHash: (rows[0] as { h: string }).h,
          }],
        },
      },
    ]);
    const doc = (await readRunJournal(pool, runId))?.documents?.[0];
    expect(doc?.bodyUnchanged).toBe(true);
    expect(doc?.titleAtRun).toBe('a document');
  });

  it('says changed when the body has moved since', async () => {
    await indexDoc('SYN-MOVED', 'a document', '2027-01-01');
    const runId = await journal([
      {
        stepId: 'retrieve',
        status: 'done',
        result: {
          docIds: ['SYN-MOVED'], embed_model_ver: 'e1',
          documents: [{
            docId: 'SYN-MOVED', title: 'the title it had', owner: 'support-team',
            reviewBy: '2027-01-01', bodyHash: 'a'.repeat(64),
          }],
        },
      },
    ]);
    const doc = (await readRunJournal(pool, runId))?.documents?.[0];
    expect(doc?.bodyUnchanged).toBe(false);
    // Today's title and the run's title are both reported, and they differ.
    expect(doc?.titleAtRun).toBe('the title it had');
    expect(doc?.title).toBe('a document');
  });

  // Three answers, not two. Null is the question being unanswerable.
  it('says nothing when the run recorded no digest, or the document is gone', async () => {
    await indexDoc('SYN-NOHASH', 'a document', '2027-01-01');
    const noHash = await journal([
      {
        stepId: 'retrieve',
        status: 'done',
        result: { docIds: ['SYN-NOHASH'], embed_model_ver: 'e1' },
      },
    ]);
    expect((await readRunJournal(pool, noHash))?.documents?.[0]?.bodyUnchanged).toBeNull();

    const gone = await journal([
      {
        stepId: 'retrieve',
        status: 'done',
        result: {
          docIds: ['SYN-GONE'], embed_model_ver: 'e1',
          documents: [{ docId: 'SYN-GONE', title: 't', owner: 'o', reviewBy: '2027-01-01', bodyHash: 'b'.repeat(64) }],
        },
      },
    ]);
    const missing = (await readRunJournal(pool, gone))?.documents?.[0];
    expect(missing?.resolved).toBe(false);
    expect(missing?.bodyUnchanged).toBeNull();
  });
});

describe('a run the ledger holds no journal for', () => {
  it('answers null rather than an empty journal', async () => {
    // Null here means no journalled step under this id. It does not mean no
    // such run: this reader joins no run row, and the caller that knows
    // whether the run exists is the one that read it.
    expect(await readRunJournal(pool, randomUUID())).toBeNull();
  });

  it('answers null for an id the uuid column could not be asked about', async () => {
    // A console route takes this out of a URL. Bound into a uuid comparison
    // it makes the database raise a syntax fault instead of answering, and
    // the run detail would show an error page for a mistyped link.
    expect(await readRunJournal(pool, 'not-a-uuid')).toBeNull();
  });
});

describe('a step journalled before it produced an outcome', () => {
  it('reports the outcome as missing, and says nothing about why', async () => {
    const runId = await journal([{ stepId: 'classify', status: 'started' }]);
    const step = (await readRunJournal(pool, runId))?.steps[0];
    // In flight or crashed mid-step. `db/006` keeps the column nullable for
    // exactly this window, and nothing stored separates the two, so the
    // reader must not guess.
    expect(step?.awaitingOutcome).toBe(true);
    expect(step?.resultRecorded).toBe(false);
    expect(step?.resultMalformed).toBe(false);
  });

  it('reads no agreement off it', async () => {
    const runId = await journal([{ stepId: 'classify', status: 'started' }]);
    expect((await readRunJournal(pool, runId))?.agreement).toBeNull();
  });
});

describe('a step that failed', () => {
  it('does not read a failed gate as a verdict', async () => {
    const runId = await journal([
      { stepId: 'classify', status: 'done', result: { intentId: 'refund_request', agreement: 0.9 } },
      {
        stepId: 'gate',
        status: 'failed',
        // The exact shape coordinator.ts writes when the groundedness judge
        // answers unreadably: a non-null result with no reason and no
        // coverage. Admitting it on a non-null result alone would render a
        // live fault as a decision.
        result: { shape: 'no-content', error: 'OpenRouter chat: content is not a string' },
      },
    ]);
    const result = await readRunJournal(pool, runId);
    expect(result?.coverage).toBeNull();
    expect(result?.steps.find((s) => s.stepId === 'gate')?.faultShape).toBe('no-content');
    // The threshold rides on the gate row, so a failed gate loses it too.
    // An absence, never a seed.
    expect(result?.agreement?.threshold).toBeNull();
  });

  // The two cases above hold because the fault shape carries none of the
  // fields a verdict needs, so the type guards refuse them on their own. These
  // two remove that coincidence and leave only the status to decide. Nothing
  // writes these rows today; they are the shape a step would file if it
  // measured something and then faulted, and the status test is what keeps a
  // reader from calling that measurement a verdict.
  it('refuses a coverage value carried on a row that failed', async () => {
    const runId = await journal([
      {
        stepId: 'gate',
        status: 'failed',
        result: { groundedness: 0.95, decision: 'auto', reason: 'auto', shape: 'no-content' },
      },
    ]);
    expect((await readRunJournal(pool, runId))?.coverage).toBeNull();
  });

  it('refuses an agreement carried on a row that failed', async () => {
    const runId = await journal([
      {
        stepId: 'classify',
        status: 'failed',
        result: { intentId: 'refund_request', agreement: 0.95, shape: 'no-label' },
      },
    ]);
    expect((await readRunJournal(pool, runId))?.agreement).toBeNull();
  });

  // Every case above uses `failed`, and that is the hole they leave together:
  // a denylist of `failed` passes all of them. `doneResult` is an allowlist of
  // one status on purpose, and these are the rows that tell the two apart.
  //
  // Neither status is hypothetical. `db/006_ledger_constraints.sql:25`
  // backfills `unknown` onto rows written before `status` was NOT NULL, and
  // `started` is what `journalStart` writes before the step acts. A denylist
  // reads whatever either one carries as a verdict.
  it('refuses a verdict carried on a status that is neither done nor failed', async () => {
    for (const status of ['unknown', 'started', 'parking', 'superseded']) {
      const runId = await journal([
        {
          stepId: 'classify',
          status,
          result: { intentId: 'refund_request', agreement: 0.95 },
        },
        {
          stepId: 'gate',
          status,
          result: {
            groundedness: 0.95,
            decision: 'auto',
            reason: 'auto',
            thresholds: { agreement: 0.6, groundednessBlock: 0.7, groundednessReview: 0.8 },
          },
        },
        { stepId: 'retrieve', status, result: { docIds: ['doc-a'] } },
      ]);
      const result = await readRunJournal(pool, runId);
      expect(result?.coverage, status).toBeNull();
      expect(result?.agreement, status).toBeNull();
      expect(result?.documents, status).toBeNull();
    }
  });

  it('refuses retrieved ids carried on a row that failed', async () => {
    const runId = await journal([
      {
        stepId: 'retrieve',
        status: 'failed',
        result: { docIds: ['doc-a'], shape: 'no-vector' },
      },
    ]);
    expect((await readRunJournal(pool, runId))?.documents).toBeNull();
  });

  it('does not read a failed classify as an agreement', async () => {
    const runId = await journal([
      { stepId: 'classify', status: 'failed', result: { shape: 'no-label', error: 'unreadable' } },
    ]);
    const result = await readRunJournal(pool, runId);
    expect(result?.agreement).toBeNull();
    expect(result?.steps[0]?.faultShape).toBe('no-label');
  });

  it('does not read a failed retrieve as a search that found nothing', async () => {
    const runId = await journal([
      { stepId: 'retrieve', status: 'failed', result: { shape: 'no-vector', error: 'no vector' } },
    ]);
    // Null, not the empty list. The run never retrieved.
    expect((await readRunJournal(pool, runId))?.documents).toBeNull();
  });

  it('returns no fault message, only the shape it was typed with (DEC-18)', async () => {
    const runId = await journal([
      {
        stepId: 'park',
        status: 'failed',
        result: {
          actionClass: 'send_reply',
          delivery: 'at_most_once',
          parkKey: 'idem-park',
          // What imap-smtp.ts builds: two addresses in one sentence.
          error: 'refusing to park a reply: the conversation records a@example.test '
            + 'but thread T-1 is addressed to b@example.test',
        },
      },
    ]);
    const result = await readRunJournal(pool, runId);
    expect(JSON.stringify(result)).not.toContain('@example.test');
    expect(result?.steps[0]?.park?.failureRecorded).toBe(true);
  });
});

describe('a result the database did not constrain', () => {
  it('costs that row its detail and no more', async () => {
    const runId = await journal([
      // jsonb takes a bare scalar, so this row is legal and no code writes it.
      { stepId: 'compose', status: 'done', result: 'not an object' },
      { stepId: 'gate', status: 'done', result: { groundedness: 0.9, decision: 'gated', reason: 'customer_visible' } },
    ]);
    const result = await readRunJournal(pool, runId);
    const compose = result?.steps.find((s) => s.stepId === 'compose');
    expect(compose?.resultRecorded).toBe(true);
    expect(compose?.resultMalformed).toBe(true);
    expect(compose?.compose).toBeNull();
    // The rest of the run still reads. One unreadable row must not cost the
    // whole statement, which is what a bare cast would have done.
    expect(result?.coverage?.decision).toBe('gated');
  });

  // The journal carries a gate value as recorded, inside [0, 1] or not. A
  // reader that compares it with a line checks the range itself.
  it('carries a gate value outside [0, 1] as recorded, with its reading', async () => {
    const runId = await journal([
      { stepId: 'classify', status: 'done', result: { intentId: 'x', agreement: 1.4 } },
      { stepId: 'gate', status: 'done', result: { groundedness: 1.5, decision: 'gated', reason: 'customer_visible' } },
    ]);
    const result = await readRunJournal(pool, runId);
    expect(result?.agreement).toMatchObject({ intentId: 'x', agreement: 1.4 });
    expect(result?.coverage).toMatchObject({ decision: 'gated', reason: 'customer_visible', groundedness: 1.5 });
  });

  it('reports a gate row written before the reason key as unrecorded', async () => {
    const runId = await journal([
      { stepId: 'gate', status: 'done', result: { groundedness: 0.9, decision: 'auto' } },
    ]);
    const coverage = (await readRunJournal(pool, runId))?.coverage;
    expect(coverage?.reason).toBeNull();
    expect(coverage?.blockThreshold).toBeNull();
  });

  it('reports a db/006 backfilled pin as unrecorded rather than as a version', async () => {
    const runId = await journal([
      { stepId: 'classify', status: 'unknown', promptVer: 'unrecorded', modelVer: 'unrecorded' },
    ]);
    const step = (await readRunJournal(pool, runId))?.steps[0];
    expect(step?.promptVer).toBeNull();
    expect(step?.modelVer).toBeNull();
    expect(step?.status).toBe('unknown');
  });

  it('keeps a step id it does not recognise, sorted last', async () => {
    const runId = await journal([
      { stepId: 'classify', status: 'done', result: { intentId: 'x', agreement: 0.9 } },
      { stepId: 'reconcile', status: 'done', result: {} },
    ]);
    const steps = (await readRunJournal(pool, runId))?.steps;
    expect(steps?.map((s) => s.stepId)).toEqual(['classify', 'reconcile']);
    expect(steps?.[1]?.recognized).toBe(false);
    expect(steps?.[0]?.recognized).toBe(true);
  });

  it('refuses a threshold set the journal recorded unreadably', async () => {
    const runId = await journal([
      { stepId: 'classify', status: 'done', result: { intentId: 'refund_request', agreement: 0.9 } },
      {
        stepId: 'gate',
        status: 'done',
        result: {
          groundedness: 0.9,
          decision: 'auto',
          reason: 'auto',
          thresholds: { agreement: 'seven tenths' },
        },
      },
    ]);
    const result = await readRunJournal(pool, runId);
    // A string typed as a number would have reached the console as one.
    expect(result?.agreement?.threshold).toBeNull();
    expect(result?.coverage?.reviewThreshold).toBeNull();
    // The verdict itself still reads: it is journalled beside the set, not
    // derived from it.
    expect(result?.coverage?.decision).toBe('auto');
  });
});

describe('the four park shapes', () => {
  it('reads the ledger park, which holds a payload and no handle (DEC-34)', async () => {
    const runId = await journal([
      {
        stepId: 'park',
        status: 'done',
        result: {
          actionClass: 'issue_credit',
          delivery: 'at_least_once',
          body: 'the composed rationale a person reads',
          payload: { amount: 500 },
          turnNumber: 2,
        },
      },
    ]);
    const step = (await readRunJournal(pool, runId))?.steps[0];
    expect(step?.status).toBe('done');
    expect(step?.park).toEqual({
      actionClass: 'issue_credit',
      delivery: 'at_least_once',
      draftExternalId: null,
      parkKey: null,
      turnNumber: 2,
      draftRecorded: true,
      draftBody: 'the composed rationale a person reads',
      payloadRecorded: true,
      payload: { amount: 500 },
      failureRecorded: false,
    });
    // Both are returned, and both are read by the approval surface (DEC-34,
    // DEC-40). The rationale is written for a person to read when they
    // approve this write; the payload is what approving it performs, and a
    // console that showed the first and not the second put an Approve button
    // over an amount that appeared nowhere on the page.
    //
    // This does name an account in a real deployment. `docs/operations.md`
    // says so, beside the note that the console serves such a page to a
    // reviewer only.
    expect(step?.park?.draftBody).toBe('the composed rationale a person reads');
    expect(step?.park?.payload).toEqual({ amount: 500 });
  });

  it('reads the crash marker, which names a draft nobody can name yet', async () => {
    const runId = await journal([
      {
        stepId: 'park',
        status: 'parking',
        result: { actionClass: 'send_reply', delivery: 'at_most_once', parkKey: 'idem-park' },
      },
    ]);
    const step = (await readRunJournal(pool, runId))?.steps[0];
    expect(step?.status).toBe('parking');
    expect(step?.park?.parkKey).toBe('idem-park');
    expect(step?.park?.draftExternalId).toBeNull();
    expect(step?.park?.draftRecorded).toBe(false);
  });

  it('reads the refusal, which overwrote that marker', async () => {
    const runId = await journal([
      {
        stepId: 'park',
        status: 'failed',
        result: {
          actionClass: 'send_reply',
          delivery: 'at_most_once',
          parkKey: 'idem-park',
          error: 'the adapter refused',
        },
      },
    ]);
    const step = (await readRunJournal(pool, runId))?.steps[0];
    expect(step?.status).toBe('failed');
    expect(step?.park?.parkKey).toBe('idem-park');
    expect(step?.park?.failureRecorded).toBe(true);
    // Not a model fault: the park failure carries a message, never a shape.
    expect(step?.faultShape).toBeNull();
  });

  it('reads the customer draft, which carries a handle in the target system', async () => {
    const runId = await journal([
      {
        stepId: 'park',
        status: 'done',
        result: {
          draftExternalId: 'draft-77',
          actionClass: 'send_reply',
          delivery: 'at_most_once',
          turnNumber: 1,
          body: 'the parked reply',
        },
      },
    ]);
    const step = (await readRunJournal(pool, runId))?.steps[0];
    expect(step?.park?.draftExternalId).toBe('draft-77');
    expect(step?.park?.draftRecorded).toBe(true);
    expect(step?.park?.payloadRecorded).toBe(false);
    // Returned now, and DEC-40 is why: a console may approve this draft, and
    // an approver who cannot read the reply cannot approve it. This case
    // asserted its absence while the module withheld it.
    expect(step?.park?.draftBody).toBe('the parked reply');
  });
});

describe('the escalate step', () => {
  it('reports the coordinator reason', async () => {
    const runId = await journal([
      { stepId: 'escalate', status: 'done', result: { reason: 'egress_refused' } },
    ]);
    expect((await readRunJournal(pool, runId))?.steps[0]?.escalationReason).toBe('egress_refused');
  });
});

describe('the retrieved documents', () => {
  it('keeps the recorded order, which is not a rank of either channel', async () => {
    await indexDoc('doc-b', 'Refund policy', '2030-06-01');
    await indexDoc('doc-a', 'Password reset', '2030-07-01');
    const runId = await fullRun();
    const documents = (await readRunJournal(pool, runId))?.documents;
    // The journal recorded doc-b first, so doc-b is position one. RRF fuses
    // ranks and discards the scores, and the reranker stands down below fifty
    // candidates without recording that it did, so the position is the
    // recorded position and nothing else.
    expect(documents?.map((d) => [d.position, d.docId])).toEqual([
      [1, 'doc-b'],
      [2, 'doc-a'],
    ]);
    expect(documents?.[0]?.title).toBe('Refund policy');
    expect(documents?.[0]?.owner).toBe('support-team');
    expect(documents?.[0]?.kind).toBe('document');
  });

  it('renders the review date as the day the ledger stored (DEC-23)', async () => {
    await indexDoc('doc-b', 'Refund policy', '2030-06-01');
    await indexDoc('doc-a', 'Password reset', '2030-07-01');
    const runId = await fullRun();
    const documents = (await readRunJournal(pool, runId))?.documents;
    // A `date` read as a JavaScript Date lands at the local midnight, so a
    // console behind UTC would show the day before. The database renders it.
    expect(documents?.map((d) => d.reviewBy)).toEqual(['2030-06-01', '2030-07-01']);
  });

  it('reports an id the index no longer holds rather than shortening the list', async () => {
    await indexDoc('doc-b', 'Refund policy', '2030-06-01');
    const runId = await fullRun();
    const documents = (await readRunJournal(pool, runId))?.documents;
    // There is no foreign key from the journal to the index, so this happens.
    // Dropping the row would hide that the run cited something that is gone,
    // and would silently renumber every position after it.
    expect(documents?.length).toBe(2);
    expect(documents?.[1]).toEqual({
      docId: 'doc-a',
      position: 2,
      resolved: false,
      title: null,
      kind: null,
      owner: null,
      reviewBy: null,
      // This fixture's retrieve row records no snapshot, so nothing here can
      // say what the document was or whether it moved. Null is the question
      // being unanswerable, not a "no".
      titleAtRun: null,
      ownerAtRun: null,
      reviewByAtRun: null,
      bodyUnchanged: null,
    });
  });

  it('shows today s title, because the index is rewritten in place', async () => {
    await indexDoc('doc-b', 'Refund policy', '2030-06-01');
    await indexDoc('doc-a', 'Password reset', '2030-07-01');
    const runId = await fullRun();
    await indexDoc('doc-b', 'Refund policy, second edition', '2030-06-01');
    const documents = (await readRunJournal(pool, runId))?.documents;
    // The retriever rewrites a document in place, so only the id is a
    // historical fact. The type says so; this proves the type is not lying.
    expect(documents?.[0]?.title).toBe('Refund policy, second edition');
  });

  it('separates a retrieval that found nothing from a run that never retrieved', async () => {
    const empty = await journal([
      { stepId: 'retrieve', status: 'done', result: { docIds: [], embed_model_ver: 'embed-1' } },
    ]);
    expect((await readRunJournal(pool, empty))?.documents).toEqual([]);

    const never = await journal([
      { stepId: 'classify', status: 'done', result: { intentId: 'x', agreement: 0.9 } },
    ]);
    expect((await readRunJournal(pool, never))?.documents).toBeNull();
  });

  it('keeps a duplicated id, because the journal recorded one', async () => {
    await indexDoc('doc-a', 'Password reset', '2030-07-01');
    const runId = await journal([
      {
        stepId: 'retrieve',
        status: 'done',
        result: { docIds: ['doc-a', 'doc-a'], embed_model_ver: 'embed-1' },
      },
    ]);
    const documents = (await readRunJournal(pool, runId))?.documents;
    // A join without ordinality collapses these into one row and the console
    // shows a retrieval the run did not make.
    expect(documents?.map((d) => d.position)).toEqual([1, 2]);
  });
});
