// The seeded history is reproducible, and it goes in through the real path.
//
// Reproducibility is the property a band rests on: a baseline built from a
// history nobody can rebuild is a number nobody can check. So it is asserted
// against the ledger itself, twice, not against the plan or the artifact.
//
// Three days rather than forty-five. The property is the same at either size
// and the suite runs against a container.
import { createHash } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { dbUrl, readerDbUrl } from '../db/config.js';
import { truncateLedger } from '../test-support/schema.js';
import { readDays } from '../bands/query.js';
import { approvalEditDistance } from '../approval/edit_distance.js';
import { approvedReplyFor } from './write.js';
import { readLatency } from '../latency/query.js';
import { approveRun } from '../approval/approve.js';
import { listEscalations } from '../escalations/query.js';
import { evaluatePolicyDetailed, SEED_THRESHOLDS } from '../policy/policy.js';
import {
  SEED_INTENTS,
  SEED_DOCUMENTS, followUpFor, inboundMessageFor, planHistory, policyInputFor,
  type PlannedRun,
} from './plan.js';
import { writeDocuments, writeHistory } from './write.js';

const pool = new Pool({ connectionString: dbUrl(), max: 8 });
// The readers connect as the role that cannot act beyond a read.
const readers = new Pool({ connectionString: readerDbUrl(), max: 4 });

await pool.query('SELECT 1');

const OPTIONS = { seed: 0x41726361, days: 3, endDay: '2026-06-30', partitions: 4, provider: 'stub' };

async function truncate(): Promise<void> {
  // `document` too: the seeder writes the small corpus a `retrieve` row's
  // ids point at, and a case that counted rows would otherwise count another
  // suite's index as well.
  await truncateLedger(pool);
}

/** Every column of the ledger a second run must reproduce exactly. */
async function ledgerFingerprint(): Promise<string> {
  const runs = await pool.query(
    `SELECT run_id, ticket_id, partition, epoch, state, prompt_ver, model_ver,
            created_at, enqueued_at, finished_at, approval_edit_distance, conversation_id
       FROM run ORDER BY run_id`,
  );
  const steps = await pool.query(
    'SELECT run_id, step_id, status, result FROM step_journal ORDER BY run_id, step_id',
  );
  const outbox = await pool.query(
    'SELECT run_id, idem_key, status, action_class FROM outbox ORDER BY idem_key',
  );
  return JSON.stringify({ runs: runs.rows, steps: steps.rows, outbox: outbox.rows });
}

afterAll(async () => {
  await truncate();
  await readers.end();
  await pool.end();
});

describe('the document corpus the seeder writes', () => {
  // The schema once, the truncate per case. Every other block here re-applies
  // the whole migration set before each test, and each replay is DDL against
  // a database the run shares — which is where `applyLedgerSchema` deadlocks
  // when the machine is short of memory. This block adds none of that.

  beforeEach(async () => {
    await truncate();
  });

  // Seeded documents are not inert. They go into `document`, which is the
  // table the retriever searches, and every one carries a review date years
  // out — so they pass the freshness filter and can be retrieved. Against a
  // ledger that also serves live traffic, invented refund and data-deletion
  // policy could ground a reply to a real customer.
  it('refuses a ledger holding a document it did not write', async () => {
    await pool.query(
      `INSERT INTO document (doc_id, kind, title, body, owner, review_by, embedding)
       VALUES ('KB-REAL-1', 'document', 'a real article', 'real text', 'support', '2027-01-01',
               $1::vector)`,
      [`[${Array.from({ length: 1536 }, () => 0).join(',')}]`],
    );
    await expect(writeDocuments(pool)).rejects.toThrow(/KB-REAL-1/);
    // Nothing of its own landed beside it.
    const after = await pool.query("SELECT count(*)::int AS n FROM document WHERE doc_id LIKE 'SYN-%'");
    expect(after.rows[0]?.n).toBe(0);
  });

  it('writes the corpus into a ledger holding only its own documents', async () => {
    const written = await writeDocuments(pool);
    expect(written).toEqual({ written: SEED_DOCUMENTS.length, heldByConsole: [] });
    // Counted from the ledger, so the number reports what landed rather than
    // what the plan held.
    const rows = await pool.query("SELECT count(*)::int AS n FROM document WHERE doc_id LIKE 'SYN-%'");
    expect(rows.rows[0]?.n).toBe(SEED_DOCUMENTS.length);
    // Re-applying is the retriever's own upsert, so it stays at the same count.
    expect((await writeDocuments(pool)).written).toBe(SEED_DOCUMENTS.length);
  });

  // DEC-50: a row the console wrote is left as it is, and the count says so.
  it('leaves a document written in the console, and does not count it', async () => {
    const held = SEED_DOCUMENTS[0]!.docId;
    await pool.query(
      `INSERT INTO document (doc_id, kind, title, body, owner, review_by, source, embedding_status, written_by)
       VALUES ($1, 'document', 'Console title', 'Console body', 'synthetic-owner', '2999-01-01', 'console', 'pending',
               'synthetic-reviewer')`,
      [held],
    );
    expect(await writeDocuments(pool)).toEqual({ written: SEED_DOCUMENTS.length - 1, heldByConsole: [held] });
    const kept = await pool.query('SELECT source, title FROM document WHERE doc_id = $1', [held]);
    expect(kept.rows).toEqual([{ source: 'console', title: 'Console title' }]);

    // The history refuses before its first run, so no run cites the held id.
    await expect(writeHistory(pool, planHistory(OPTIONS))).rejects.toThrow(
      `seed-history: a document written in the console holds ${held}. No run was written.`,
    );
    const runs = await pool.query('SELECT count(*)::int AS n FROM run');
    expect(runs.rows[0]?.n).toBe(0);
  });
});

describe('the seeded history', () => {

  beforeEach(async () => {
    await truncate();
  });

  // The acceptance criterion, asserted over the ledger rather than the plan.
  // A planner that was deterministic and a writer that was not would pass a
  // plan-level check and fail this one.
  it('is byte-reproducible from its seed', async () => {
    await writeHistory(pool, planHistory(OPTIONS));
    const first = await ledgerFingerprint();

    await truncate();
    await writeHistory(pool, planHistory(OPTIONS));
    const second = await ledgerFingerprint();

    expect(second).toBe(first);
    expect(first.length).toBeGreaterThan(1000);
  });

  it('gives a different ledger from a different seed', async () => {
    await writeHistory(pool, planHistory(OPTIONS));
    const first = await ledgerFingerprint();

    await truncate();
    await writeHistory(pool, planHistory({ ...OPTIONS, seed: OPTIONS.seed + 1 }));
    expect(await ledgerFingerprint()).not.toBe(first);
  });

  it('has the ledger accept every run it plans', async () => {
    const plan = planHistory(OPTIONS);
    const report = await writeHistory(pool, plan);
    expect(report.refused).toBe(0);
    expect(report.accepted).toBe(plan.length);
    expect(report.documents).toEqual({ written: SEED_DOCUMENTS.length, heldByConsole: [] });
  });

  // Through fencedInsert with a clock, so the epoch, the transaction and the
  // journal are the ones a live run takes. Read back off the stored rows.
  it('records the timing the plan chose, not the wall clock', async () => {
    const plan = planHistory(OPTIONS);
    await writeHistory(pool, plan);
    const { rows } = await pool.query(
      'SELECT created_at, enqueued_at, finished_at FROM run WHERE run_id = $1',
      [plan[0]!.runId],
    );
    const row = rows[0] as { created_at: Date; enqueued_at: Date; finished_at: Date | null };
    expect(row.created_at.toISOString()).toBe(plan[0]!.createdAt.toISOString());
    expect(row.enqueued_at.toISOString()).toBe(plan[0]!.enqueuedAt.toISOString());
    expect(row.finished_at?.toISOString() ?? null).toBe(
      plan[0]!.finishedAt?.toISOString() ?? null,
    );
  });

  // Reproducibility means one seed and one day always give the same run ids,
  // so writing the same window twice collides on the primary key. That is the
  // property working, and it is a refusal rather than a fault — but the raw
  // driver error is a stack trace about an index file, so it is named.
  it('refuses by name when the ledger already holds the history', async () => {
    await writeHistory(pool, planHistory(OPTIONS));
    await expect(writeHistory(pool, planHistory(OPTIONS))).rejects.toThrow(
      /already holds run/,
    );
  });

  // And two windows that share a seed do not collide, because each day mixes
  // the day string into its own stream. Seeding one extra day after a long
  // history used to regenerate the first day's ids.
  it('writes a neighbouring day without colliding on the same seed', async () => {
    await writeHistory(pool, planHistory(OPTIONS));
    const before = await pool.query('SELECT count(*)::int AS n FROM run');
    const extra = await writeHistory(
      pool,
      planHistory({ ...OPTIONS, days: 1, endDay: '2026-07-01' }),
    );
    expect(extra.refused).toBe(0);
    expect(extra.accepted).toBeGreaterThan(0);
    const after = await pool.query('SELECT count(*)::int AS n FROM run');
    expect((after.rows[0] as { n: number }).n).toBe(
      (before.rows[0] as { n: number }).n + extra.accepted,
    );
  });

  it('writes a fencing epoch for every ticket, as the real path does', async () => {
    const plan = planHistory(OPTIONS);
    await writeHistory(pool, plan);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM ticket_epoch');
    expect((rows[0] as { n: number }).n).toBe(new Set(plan.map((r) => r.ticketId)).size);
  });
});

describe('the readers over the seeded history', () => {

  beforeEach(async () => {
    await truncate();
    await writeHistory(pool, planHistory(OPTIONS));
  });

  it('gives bands a day whose provider is named', async () => {
    const days = await readDays(
      pool,
      new Date('2026-06-01T00:00:00Z'),
      new Date('2026-07-01T00:00:00Z'),
    );
    expect(days.length).toBeGreaterThanOrEqual(3);
    for (const day of days) expect(day.provider).toBe('stub');
  });

  it('gives bands a measured value for every metric it can measure', async () => {
    const days = await readDays(
      pool,
      new Date('2026-06-01T00:00:00Z'),
      new Date('2026-07-01T00:00:00Z'),
    );
    const day = days.at(-1)!;
    // Ranges, not presence. `not.toBeNull` passed on any wrong-but-present
    // number, which is most of the ways a seeder can go wrong.
    const rate = (v: number | null): number => {
      expect(v).not.toBeNull();
      return v as number;
    };
    // Three of the four are rates, so they live in [0, 1] by definition.
    expect(rate(day.samples.abstain_rate.value)).toBeGreaterThanOrEqual(0);
    expect(rate(day.samples.abstain_rate.value)).toBeLessThanOrEqual(1);
    expect(rate(day.samples.gate_pass_rate.value)).toBeGreaterThanOrEqual(0);
    expect(rate(day.samples.gate_pass_rate.value)).toBeLessThanOrEqual(1);
    // db/003 declares this one a normalized distance in [0, 1]. It held a
    // rounded token count near 24 until the seeder was corrected.
    expect(rate(day.samples.approval_edit_distance.value)).toBeGreaterThanOrEqual(0);
    expect(rate(day.samples.approval_edit_distance.value)).toBeLessThanOrEqual(1);
    // A count, so a whole number that is not negative.
    const unknowns = rate(day.samples.relay_delivery_unknown_count.value);
    expect(Number.isInteger(unknowns)).toBe(true);
    expect(unknowns).toBeGreaterThanOrEqual(0);
  });

  // No seeded run lands in a column that means the ledger is wrong.
  //
  // `unfinished` is the exception, and it is not a defect: a run parked at
  // `awaiting_approval` is waiting for a person and genuinely has no service
  // time yet. DEC-12 puts a person on every customer reply, so a real ledger
  // always holds some. The other five columns each mean the row taught the
  // reader nothing, and none of them may hold a seeded run.
  it('leaves no seeded run in a latency column that means a broken ledger', async () => {
    const report = await readLatency(readers);
    expect(report.runs).toBeGreaterThan(0);
    let unfinished = 0;
    for (const p of report.partitions) {
      expect(p.wait.unmeasured).toBe(0);
      expect(p.wait.unordered).toBe(0);
      expect(p.service.unstamped).toBe(0);
      expect(p.service.unordered).toBe(0);
      expect(p.service.neverRan).toBe(0);
      unfinished += p.service.unfinished;
    }
    // Present, and counted under its own name rather than folded away.
    expect(unfinished).toBeGreaterThan(0);
  });

  it('loads every partition, so the report has something to compare', async () => {
    const report = await readLatency(readers);
    expect(report.partitions).toHaveLength(OPTIONS.partitions);
    for (const p of report.partitions) expect(p.wait.count).toBeGreaterThan(0);
  });
});


// The steps a seeded run journals, read back off the ledger.
//
// The seeder wrote a compose row and sometimes a gate row, and nothing else.
// So every reader that walks the journal saw a run that never classified,
// never retrieved and never parked — and the approval path did worse than
// misread it: `approveRun` threw `awaits approval but journals no park step`
// on every parked run in the history, which is an exception rather than an
// `ApproveOutcome`. That is the defect these cases hold shut.
describe('what the ledger holds about a claim and an approver', () => {
  let plan: PlannedRun[];


  beforeEach(async () => {
    await truncate();
    plan = planHistory(OPTIONS);
    await writeHistory(pool, plan);
  });

  async function resultOf(runId: string, stepId: string): Promise<Record<string, unknown> | null> {
    const { rows } = await pool.query(
      'SELECT result FROM step_journal WHERE run_id = $1 AND step_id = $2',
      [runId, stepId],
    );
    return (rows[0]?.result as Record<string, unknown> | undefined) ?? null;
  }

  it('records each claim with the document it cites (DEC-07)', async () => {
    const gated = plan.find((run) => run.gate !== null && run.claims.length > 0);
    expect(gated).toBeDefined();
    const compose = await resultOf(gated!.runId, 'compose');
    const sentences = compose?.['sentences'] as { text: string; docId: string | null }[];
    const cited = sentences.filter((sentence) => sentence.docId !== null);
    expect(cited).toHaveLength(gated!.claimCount);
    const retrieve = await resultOf(gated!.runId, 'retrieve');
    const docIds = retrieve?.['docIds'] as string[];
    for (const claim of cited) {
      expect(typeof claim.text).toBe('string');
      expect(docIds).toContain(claim.docId);
    }
  });

  // DEC-43. The compose row holds the reply, and `park.body` holds that same
  // reply joined. A row holding the claims alone would describe a reply the
  // customer never reads, which is the ledger state this change removed.
  it('records the reply the run parked, sentence by sentence (DEC-43)', async () => {
    const courteous = plan.find(
      (run) => run.park !== null && run.sentences.some((sentence) => sentence.docId === null),
    );
    expect(courteous).toBeDefined();
    const compose = await resultOf(courteous!.runId, 'compose');
    const sentences = compose?.['sentences'] as { text: string; docId: string | null }[];
    expect(sentences.map((sentence) => sentence.text).join(' '))
      .toBe(courteous!.park!.body);
    // A courtesy sentence records a null citation rather than omitting the
    // key, so a reader cannot mistake it for a claim whose docId was lost.
    expect(sentences.some((sentence) => sentence.docId === null)).toBe(true);
  });

  // The verdicts and the fraction record the same fact. A reader renders the
  // fraction, because that is what `evaluatePolicy` read; if the two ever
  // disagreed the ledger would hold two answers and name neither.
  it('records verdicts that recount to the coverage the gate row holds', async () => {
    let checked = 0;
    for (const run of plan) {
      if (run.gate === null) continue;
      const gate = await resultOf(run.runId, 'gate');
      const verdicts = gate?.['claimVerdicts'] as { claimIndex: number; supported: boolean }[];
      expect(verdicts, run.runId).toHaveLength(run.claimCount);
      const supported = verdicts.filter((v) => v.supported).length;
      expect(supported / verdicts.length, run.runId)
        .toBeCloseTo(gate?.['groundedness'] as number, 10);
      checked += 1;
      if (checked === 12) break;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('keeps agreement off the gate row, so the two gates stay apart (DEC-05)', async () => {
    const gated = plan.find((run) => run.gate !== null)!;
    const gate = await resultOf(gated.runId, 'gate');
    expect(Object.keys(gate ?? {})).not.toContain('agreement');
    const classify = await resultOf(gated.runId, 'classify');
    expect(Object.keys(classify ?? {})).not.toContain('groundedness');
    expect(Object.keys(classify ?? {})).not.toContain('claimVerdicts');
  });

  it('snapshots what each retrieved document said, and no rank or score', async () => {
    const run = plan[0]!;
    const retrieve = await resultOf(run.runId, 'retrieve');
    const docs = retrieve?.['documents'] as Record<string, unknown>[];
    expect(docs).toHaveLength(run.docIds.length);
    for (const doc of docs) {
      expect(Object.keys(doc).sort())
        .toEqual(['bodyHash', 'docId', 'owner', 'reviewBy', 'title']);
      expect(String(doc['bodyHash'])).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('stores the body of a cited document once, and not of an uncited one', async () => {
    const gated = plan.find((run) => run.gate !== null && run.claims.length > 0)!;
    const compose = await resultOf(gated.runId, 'compose');
    const bodies = compose?.['citedBodies'] as Record<string, string>;
    const cited = new Set(gated.claims.map((claim) => claim.docId));
    expect(new Set(Object.keys(bodies))).toEqual(cited);
    for (const docId of gated.docIds) {
      if (!cited.has(docId)) expect(bodies[docId]).toBeUndefined();
    }
  });

  it('names the turn each run answered, so a turn joins to its run (DEC-35)', async () => {
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM run WHERE turn_number IS NULL',
    );
    expect(rows[0]?.n).toBe(0);
    const joined = await pool.query(
      `SELECT count(*)::int AS n FROM turn t
         JOIN run r ON r.conversation_id = t.conversation_id
                   AND r.turn_number = t.turn_number`,
    );
    expect(joined.rows[0]?.n).toBeGreaterThan(0);
  });

  // DEC-42. The seeded history has no proxy in front of it, so it records
  // what a console on an unnamed bind records rather than an invented name.
  it('records an approver on an approved run, and null on a run no approval reached', async () => {
    const approved = await pool.query(
      'SELECT count(*)::int AS n FROM run WHERE approved_by = $1',
      ['unattributed'],
    );
    expect(approved.rows[0]?.n).toBeGreaterThan(0);
    const untouched = await pool.query(
      `SELECT count(*)::int AS n FROM run
        WHERE approved_by IS NULL AND approval_edit_distance IS NULL`,
    );
    expect(untouched.rows[0]?.n).toBeGreaterThan(0);
    // Deliberately not asserted: that an approver never appears without an
    // edit distance. It holds of this seeder, which models an approver who
    // always edits, and it is false of the system. `approveRun` records the
    // approver on every approval and the distance only when a final body was
    // captured — and the console captures none. `approve.db.test.ts` holds
    // that shape, which is the one an adopter will actually read.
  });

  // DEC-18, DEC-45. A seeded ledger is a demo ledger, and a reviewer identity
  // in it would read as a real person's name in an audit column. The roster
  // ships empty for the same reason: only an adopter adds one, and a seeded
  // one would be a name nobody in that deployment recognises.
  it('seeds no reviewer identity at all', async () => {
    const roster = await pool.query('SELECT identity FROM reviewer');
    expect(roster.rows).toEqual([]);
    // And every recorded approver is the absence DEC-42 defines, which is
    // the value that means nobody rather than somebody.
    const named = await pool.query(
      `SELECT count(*)::int AS n FROM run
        WHERE approved_by IS NOT NULL AND approved_by <> 'unattributed'`,
    );
    expect(named.rows[0]?.n).toBe(0);
    const sources = await pool.query(
      `SELECT DISTINCT approved_by_source AS source FROM run WHERE approved_by IS NOT NULL`,
    );
    expect(sources.rows).toEqual([{ source: 'none' }]);
  });
});

describe('the journal a seeded run leaves', () => {
  let plan: PlannedRun[];


  beforeEach(async () => {
    await truncate();
    plan = planHistory(OPTIONS);
    await writeHistory(pool, plan);
  });

  async function stepsOf(runId: string): Promise<Map<string, { status: string; result: Record<string, unknown> }>> {
    const { rows } = await pool.query(
      'SELECT step_id, status, result FROM step_journal WHERE run_id = $1',
      [runId],
    );
    return new Map(rows.map((r: { step_id: string; status: string; result: Record<string, unknown> }) =>
      [r.step_id, { status: r.status, result: r.result }]));
  }

  // The routing screen reads the latest gate of each product and intent from
  // one row, which the gate step writes. A seeded run has no product, so each
  // intent's row is its newest gated run.
  it('records the latest gate of each intent, as the gate step does', async () => {
    const newest = new Map<string, PlannedRun>();
    for (const run of plan) {
      if (run.gate === null || run.reason === null) continue;
      const held = newest.get(run.classification.intentId);
      if (held === undefined || run.createdAt > held.createdAt
        || (run.createdAt.getTime() === held.createdAt.getTime() && run.runId > held.runId)) {
        newest.set(run.classification.intentId, run);
      }
    }
    expect(newest.size).toBeGreaterThan(1);
    const { rows } = await pool.query<{ product: string | null; intent_id: string; run_id: string; reason: string }>(
      'SELECT product, intent_id, run_id, reason FROM gate_latest ORDER BY intent_id',
    );
    expect(rows).toEqual([...newest].sort(([a], [b]) => (a < b ? -1 : 1)).map(([intentId, run]) => ({
      product: null, intent_id: intentId, run_id: run.runId, reason: run.reason,
    })));
  });

  it('writes the steps the run\'s own outcome implies, and no others', async () => {
    for (const run of plan.slice(0, 40)) {
      const steps = await stepsOf(run.runId);
      expect([...steps.keys()].sort()).toEqual(
        ['classify', 'retrieve', 'compose']
          .concat(run.gate === null ? [] : ['gate'])
          .concat(run.park === null ? [] : ['park'])
          .concat(run.escalation === null ? [] : ['escalate'])
          .sort(),
      );
      expect(steps.get('classify')!.result).toEqual({
        intentId: run.classification.intentId,
        agreement: run.classification.agreement,
      });
      expect(steps.get('retrieve')!.result).toEqual({
        docIds: run.docIds,
        embed_model_ver: 'seed',
        // DEC-23: what each fused document was when the run read it. The
        // shape stays exact rather than partial, because a seeded row that
        // drifted from what `coordinateTicket` writes is a row every reader
        // would have to special-case.
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
      });
      expect(steps.get('compose')!.status).toBe(run.abstained ? 'abstained' : 'done');
      expect(steps.get('compose')!.result).toEqual({
        abstained: run.abstained,
        claimCount: run.claimCount,
        staleDocumentIds: [],
        // DEC-43: the reply in draft order, with the mapping DEC-07 already
        // required the composer to resolve.
        sentences: run.sentences.map((sentence) => ({
          text: sentence.text,
          docId: sentence.docId,
        })),
        citedBodies: Object.fromEntries(
          [...new Set(run.claims.map((claim) => claim.docId))].map((docId) => [
            docId,
            SEED_DOCUMENTS.find((d) => d.docId === docId)!.body,
          ]),
        ),
        provider: 'stub',
      });
      if (run.escalation !== null) {
        expect(steps.get('escalate')!.result).toEqual({ reason: run.escalation });
      }
      if (run.gate !== null) {
        expect(steps.get('gate')!.result).toEqual({
          groundedness: run.gate.groundedness,
          decision: run.gate.decision,
          reason: run.reason,
          // DEC-13: the tier the gate judged the intent at, as the coordinator
          // records it.
          riskTier: SEED_INTENTS.find((intent) => intent.id === run.classification.intentId)!.riskTier,
          // Coverage detail beside the fraction, never instead of it, and
          // never joined to agreement (DEC-05).
          claimVerdicts: run.claims.map((claim, index) => ({
            claimIndex: index,
            supported: claim.supported,
          })),
          // DEC-07: the numbers the verdict was reached under, so a reader
          // holding a ledger written across a rolling restart can tell which
          // pair each run was judged by.
          thresholds: {
            agreement: SEED_THRESHOLDS.agreement,
            groundednessBlock: SEED_THRESHOLDS.groundednessBlock,
            groundednessReview: SEED_THRESHOLDS.groundednessReview,
          },
        });
      }
    }
  });

  // Read back through the engine, off the stored rows rather than the plan.
  // A planner that agreed with the engine and a writer that dropped a field
  // would pass the pure case and fail this one.
  it('stores numbers the policy engine still reads as the stored reason', async () => {
    const { rows } = await pool.query(
      `SELECT c.run_id,
              (c.result->>'agreement')::double precision AS agreement,
              (g.result->>'groundedness')::double precision AS groundedness,
              g.result->>'reason' AS reason
         FROM step_journal c
         JOIN step_journal g ON g.run_id = c.run_id AND g.step_id = 'gate'
        WHERE c.step_id = 'classify'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    const byId = new Map(plan.map((run) => [run.runId, run]));
    for (const row of rows as { run_id: string; agreement: number; groundedness: number; reason: string }[]) {
      const run = byId.get(row.run_id)!;
      const input = policyInputFor(run)!;
      expect(row.agreement).toBe(input.agreement);
      expect(row.groundedness).toBe(input.groundedness);
      expect(evaluatePolicyDetailed({ ...input, agreement: row.agreement, groundedness: row.groundedness }).reason)
        .toBe(row.reason);
    }
  });

  // Every identifier a `retrieve` row names resolves to a title. Without the
  // corpus a reader holding this history sees five identifiers per run and
  // can resolve none of them.
  it('indexes every document its retrieve rows point at', async () => {
    const cited = new Set(plan.flatMap((run) => run.docIds));
    const { rows } = await pool.query('SELECT doc_id, title FROM document');
    const titles = new Map(rows.map((r: { doc_id: string; title: string }) => [r.doc_id, r.title]));
    expect(titles.size).toBe(SEED_DOCUMENTS.length);
    for (const docId of cited) {
      expect(titles.get(docId)?.length ?? 0).toBeGreaterThan(0);
    }
  });

  // The escalation queue reads its reason from the `escalate` step and from
  // nowhere else, and `pnpm run escalations` and the operator console's runs
  // list are both served by that statement. Every seeded escalation reported
  // a null reason to both, so the console's Reason column was an em dash for
  // all of them. Asserted through the reader rather than over the rows: a
  // journal row the query does not join to would pass a row count and fail
  // here.
  it('gives the escalation queue a reason for every escalated run', async () => {
    const items = await listEscalations(pool, { state: 'escalated' });
    const planned = new Map(plan.map((run) => [run.runId, run]));
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBe(plan.filter((r) => r.state === 'escalated').length);
    for (const item of items) {
      expect(item.reason).toBe(planned.get(item.runId)!.escalation);
      expect(item.reason).not.toBeNull();
      // The pin that tells an operator this backlog is synthetic.
      expect(item.promptVer).toBe('seed');
    }
  });

  // The two vocabularies stay apart in the ledger, not only in the planner.
  it('writes the escalation vocabulary on the escalate step alone', async () => {
    const { rows } = await pool.query(
      `SELECT s.result->>'reason' AS reason, count(*)::int AS n
         FROM step_journal s WHERE s.step_id = 'escalate' GROUP BY 1 ORDER BY 1`,
    );
    // A subset, and named as one. Three days hold roughly 160 runs, and an
    // unknown delivery is two per cent of the automatic ones, so this window
    // need not contain a single relay escalation. The full set is covered in
    // `plan.test.ts`, over forty-five days.
    const reasons = rows.map((r: { reason: string }) => r.reason);
    for (const reason of reasons) {
      expect(['composer_abstained', 'policy_escalated', 'relay_delivery_unknown'])
        .toContain(reason);
    }
    expect(reasons).toContain('composer_abstained');
    expect(reasons).toContain('policy_escalated');
    const crossed = await pool.query(
      `SELECT count(*)::int AS n FROM step_journal
        WHERE step_id = 'gate' AND result->>'reason' = ANY($1::text[])`,
      [['composer_abstained', 'policy_escalated', 'relay_delivery_unknown']],
    );
    expect((crossed.rows[0] as { n: number }).n).toBe(0);
  });

  // The coordinator's gate row records the tier it judged the intent at
  // (DEC-13), and the queue reads it. A seeded row without it would group a
  // high-risk reply as clean.
  it('records on each gate row the risk tier of the intent it classified', async () => {
    const { rows } = await pool.query(
      `SELECT c.result->>'intentId' AS intent, g.result->>'riskTier' AS tier
         FROM step_journal g
         JOIN step_journal c ON c.run_id = g.run_id AND c.step_id = 'classify'
        WHERE g.step_id = 'gate'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    const tiers = new Map(SEED_INTENTS.map((intent) => [intent.id, intent.riskTier]));
    for (const row of rows as { intent: string; tier: string | null }[]) {
      expect(row.tier, row.intent).toBe(tiers.get(row.intent));
    }
    expect((rows as { tier: string }[]).some((row) => row.tier === 'high')).toBe(true);
  });

  // A run names a conversation on its own row, so something has to hold one.
  // Without it DEC-37 history is empty for every seeded turn, and the
  // approval path rolls back rather than record a reply on a turn that is not
  // there.
  it('opens the conversation and the turn each run answers', async () => {
    const { rows } = await pool.query(
      `SELECT c.primary_ticket_id, c.turn_counter, t.turn_number, t.body_text
         FROM conversation c
         JOIN turn t ON t.conversation_id = c.conversation_id
        WHERE c.conversation_id = $1`,
      [plan[0]!.conversationId],
    );
    expect(rows).toHaveLength(1);
    const row = rows[0] as { primary_ticket_id: string; turn_counter: number; turn_number: number; body_text: string };
    expect(row.primary_ticket_id).toBe(plan[0]!.ticketId);
    // The number intake's counter assigns first, and the number the park
    // record cites (DEC-38).
    expect(row.turn_number).toBe(1);
    expect(row.turn_counter).toBe(2);
    expect(row.body_text.length).toBeGreaterThan(0);
    // One turn per conversation, plus the follow-ups. Counted from the same
    // rule the writer uses, so this says the writer wrote what it decided to
    // rather than restating a number.
    const followUps = plan.filter((r) => followUpFor(r.runId, r.state) !== null).length;
    const counts = await pool.query('SELECT count(*)::int AS n FROM turn');
    expect((counts.rows[0] as { n: number }).n)
      .toBe(new Set(plan.map((r) => r.conversationId)).size + followUps);
    expect(followUps).toBeGreaterThan(0);
  });

  // A conversation is a thread, and every seeded one held a single message —
  // so the surface built to draw a thread had nothing to draw and the
  // reply-absence states it distinguishes were unreachable from a seeded
  // ledger (DEC-35, DEC-37).
  it('writes a second turn nobody has answered, on a run still awaiting a person', async () => {
    const chased = plan.find((run) => followUpFor(run.runId, run.state) !== null);
    expect(chased).toBeDefined();
    const { rows } = await pool.query(
      `SELECT turn_number, body_text, created_at
         FROM turn WHERE conversation_id = $1 ORDER BY turn_number`,
      [chased!.conversationId],
    );
    expect(rows).toHaveLength(2);
    const second = rows[1] as { turn_number: number; body_text: string; created_at: Date };
    expect(second.turn_number).toBe(2);
    expect(second.body_text).toBe(followUpFor(chased!.runId, chased!.state));
    // After the message it follows. A chase that arrived first is not a chase.
    expect(second.created_at.getTime()).toBeGreaterThan(chased!.enqueuedAt.getTime());
    const conv = await pool.query(
      'SELECT turn_counter FROM conversation WHERE conversation_id = $1',
      [chased!.conversationId],
    );
    expect((conv.rows[0] as { turn_counter: number }).turn_counter).toBe(3);
  });

  // Only a run still waiting. A conversation the system answered and closed
  // is not one a customer is chasing.
  it('writes no follow-up on a conversation that reached a terminal state', () => {
    for (const run of plan) {
      if (run.state === 'awaiting_approval') continue;
      expect(followUpFor(run.runId, run.state), run.runId).toBeNull();
    }
  });

  // The run row and the run's own journal are two descriptions of one run.
  // They disagreed on every seeded run — "steps 0" beside a step journal
  // listing five entries — and this holds them together rather than
  // restating the arithmetic that produced one of them.
  it('reports a step count that agrees with the run\'s own journal', async () => {
    const { rows } = await pool.query(
      `SELECT r.run_id, r.steps_used,
              count(*) FILTER (WHERE j.step_id <> 'escalate')::int AS journalled
         FROM run r JOIN step_journal j ON j.run_id = r.run_id
        GROUP BY r.run_id, r.steps_used`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows as { run_id: string; steps_used: number; journalled: number }[]) {
      expect(row.steps_used, row.run_id).toBe(row.journalled);
      expect(row.steps_used, row.run_id).toBeGreaterThan(0);
    }
  });

  // A published control band measured a difference between a draft and
  // nothing: the distance was drawn, and no approved reply text was ever
  // written. The number now comes out of the text it describes.
  it('records an approved reply, and a distance that measures it', async () => {
    const { rows } = await pool.query(
      `SELECT r.run_id, r.approval_edit_distance, t.approved_reply_text, j.result ->> 'body' AS parked
         FROM run r
         JOIN step_journal j ON j.run_id = r.run_id AND j.step_id = 'park'
         JOIN turn t ON t.conversation_id = r.conversation_id AND t.turn_number = r.turn_number
        WHERE r.approval_edit_distance IS NOT NULL
          AND j.result ? 'draftExternalId'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows as {
      run_id: string; approval_edit_distance: number;
      approved_reply_text: string | null; parked: string;
    }[]) {
      expect(row.approved_reply_text, row.run_id).not.toBeNull();
      // Measured through the shipping function, against the two texts the
      // ledger holds. A distance computed any other way here would prove
      // something about this test rather than about the ledger.
      expect(row.approval_edit_distance, row.run_id).toBeCloseTo(
        approvalEditDistance(row.parked, row.approved_reply_text!),
        10,
      );
    }
  });

  // The property the case above cannot see. It recomputes the column with
  // the function that wrote it, so it holds however far the text drifts from
  // the distance the planner drew — and that number is what the rest of the
  // history is built around and what `bands.yaml` publishes.
  it('records a distance close to the one the planner drew', async () => {
    const drawn = new Map(
      plan.filter((run) => run.editDistance !== null).map((run) => [run.runId, run.editDistance!]),
    );
    const { rows } = await pool.query(
      'SELECT run_id, approval_edit_distance AS recorded FROM run WHERE approval_edit_distance IS NOT NULL',
    );
    expect(rows.length).toBeGreaterThan(0);
    let worst = 0;
    for (const row of rows as { run_id: string; recorded: number }[]) {
      const target = drawn.get(row.run_id);
      expect(target, row.run_id).toBeDefined();
      worst = Math.max(worst, Math.abs(row.recorded - target!));
    }
    // Loose here on purpose: this is one small day, and the bound that
    // matters is measured over the shipped history in `plan.test.ts`, where
    // it is a tenth of this and the population includes the rewrite branch.
    expect(worst).toBeLessThan(0.05);
  });

  // The column a published control band averages. `pnpm run bands` reads it
  // with no draft-backed predicate, so a number here with no text behind it
  // is a number in the band — 223 of 812 on the default history were exactly
  // that, because the writer fell back to the planner's draw.
  it('records no edit distance for a park with no draft to measure against', async () => {
    const { rows } = await pool.query(
      `SELECT r.run_id, r.approval_edit_distance AS distance
         FROM run r JOIN step_journal j ON j.run_id = r.run_id AND j.step_id = 'park'
        WHERE NOT (j.result ? 'draftExternalId')`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows as { run_id: string; distance: number | null }[]) {
      expect(row.distance, row.run_id).toBeNull();
    }
  });

  // The tail itself, not the average error. The planner draws it on purpose,
  // because a person who rewrites a draft rewrites most of it, and
  // `bands.yaml` publishes this metric as `high_is_bad`.
  //
  // Asserted on the writer rather than on this small seeded day, which does
  // not always draw one. An append-only writer saturated near 0.59, so no
  // seeded run could represent a rewritten draft however many days ran.
  it('can record a heavy edit at all', () => {
    const body = plan.find((run) => run.park !== null)!.park!.body;
    const rewritten = approvedReplyFor(body, 0.9, plan[0]!.runId);
    expect(approvalEditDistance(body, rewritten)).toBeGreaterThan(0.8);
  });

  // DEC-34, DEC-37. `approveRun` writes the reply text only for a park that
  // carries a helpdesk draft, because a ledger-only park sends no reply. The
  // seeder wrote one anyway, so the ledger asserted a customer reply for a
  // run that routed a ticket and sent nothing — and `consumer.ts` feeds that
  // column to the composer as the agent's half of the conversation.
  it('records no reply text for a run whose approval sends no reply', async () => {
    // Every approved ledger-only park. The planner now leaves the distance
    // null on these, so they are found by the park shape rather than by the
    // distance that used to mark them.
    const ledgerOnly = plan.filter(
      (run) => run.state === 'awaiting_approval' && run.park !== null
        && run.park.draftExternalId === undefined,
    );
    expect(ledgerOnly.length).toBeGreaterThan(0);
    const { rows } = await pool.query(
      `SELECT t.approved_reply_text AS text
         FROM run r JOIN turn t
           ON t.conversation_id = r.conversation_id AND t.turn_number = r.turn_number
        WHERE r.run_id = ANY($1)`,
      [ledgerOnly.map((run) => run.runId)],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows as { text: string | null }[]) expect(row.text).toBeNull();
  });

  // An approver who changed nothing is a real and common outcome, and the
  // reply they sent is the draft. It is not an absence.
  it('records the draft itself when the approver changed nothing', () => {
    const body = 'A charge is refundable inside fourteen days. Reply here if that is not it.';
    expect(approvedReplyFor(body, 0, '00000000-0000-4000-8000-000000000000')).toBe(body);
  });

  // The case above passes on a writer that never edits anything: nothing
  // equals nothing at a distance of zero. This is the half that fails on one
  // — some approvals changed the draft, and the ledger says by how much.
  it('records an edit that actually happened, for an approval that made one', async () => {
    const { rows } = await pool.query(
      `SELECT r.approval_edit_distance AS distance, t.approved_reply_text AS approved,
              j.result ->> 'body' AS parked
         FROM run r
         JOIN step_journal j ON j.run_id = r.run_id AND j.step_id = 'park'
         JOIN turn t ON t.conversation_id = r.conversation_id AND t.turn_number = r.turn_number
        WHERE r.approval_edit_distance > 0
          AND j.result ? 'draftExternalId'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows as { distance: number; approved: string; parked: string }[]) {
      expect(row.approved).not.toBe(row.parked);
      // A light edit keeps the draft and adds to it. A heavy one rewrites the
      // tail, so it is not a prefix — asserted where the population contains
      // both, in `plan.test.ts`, because this day carries no heavy edit.
      expect(row.approved.startsWith(row.parked) || row.approved.length < row.parked.length)
        .toBe(true);
    }
  });

  // The message the ledger holds, not the function that makes one. The
  // writer built its text from the intent id, and a test that only called
  // the message table could not see that.
  it('writes the intent\'s own message as the customer\'s, on every turn', async () => {
    const { rows } = await pool.query(
      `SELECT t.body_text, r.run_id
         FROM turn t JOIN run r ON r.conversation_id = t.conversation_id
        WHERE t.turn_number = 1`,
    );
    expect(rows.length).toBeGreaterThan(0);
    const byRun = new Map(plan.map((run) => [run.runId, run]));
    for (const row of rows as { body_text: string; run_id: string }[]) {
      const run = byRun.get(row.run_id)!;
      expect(row.body_text, row.run_id).toBe(
        inboundMessageFor(run.classification.intentId, Number.parseInt(run.runId.slice(0, 8), 16)),
      );
      // The two tells of the template it replaced.
      expect(row.body_text, row.run_id).not.toContain('T-');
      expect(row.body_text.toLowerCase(), row.run_id)
        .not.toContain(run.classification.intentId.replace(/-/g, ' '));
    }
  });

  // The reply a person approved becomes the agent's half of the conversation
  // (DEC-37). A prompt built from a conversation that records only the
  // customer reads as a monologue.
  it('records the approved reply on the turn it answers', async () => {
    const reply = plan.find(
      (run) => run.state === 'awaiting_approval' && run.reason === 'customer_visible',
    )!;
    await approveRun(pool, reply.runId);
    const { rows } = await pool.query(
      'SELECT approved_reply_text FROM turn WHERE conversation_id = $1 AND turn_number = 1',
      [reply.conversationId],
    );
    expect((rows[0] as { approved_reply_text: string }).approved_reply_text).toBe(reply.park!.body);
  });

  // The defect, stated as the outcome the approval path now returns. It threw
  // here before, from `approveRun`'s own check that a parked run journals a
  // park step, so no console and no operator could act on a seeded history at
  // all.
  it('lets a person approve a parked run', async () => {
    const parked = plan.filter((run) => run.state === 'awaiting_approval');
    expect(parked.length).toBeGreaterThan(0);
    for (const run of parked.slice(0, 20)) {
      const outcome = await approveRun(pool, run.runId);
      expect(outcome.outcome).toBe('approved');
      const { rows } = await pool.query(
        'SELECT state FROM run WHERE run_id = $1',
        [run.runId],
      );
      expect((rows[0] as { state: string }).state).toBe('resolved');
    }
  });

  // And it relays: a customer reply carries the draft handle the relay sends
  // against (DEC-11), a ledger-only park carries the payload `performAction`
  // takes (DEC-34). A record with neither is one `approveRun` refuses.
  it('queues an outbox record the relay can dispatch', async () => {
    const parked = plan.filter((run) => run.state === 'awaiting_approval');
    for (const run of parked.slice(0, 20)) {
      await approveRun(pool, run.runId);
      const { rows } = await pool.query(
        "SELECT action_class, delivery, payload FROM outbox WHERE run_id = $1 AND step_id = 'approve'",
        [run.runId],
      );
      expect(rows).toHaveLength(1);
      const row = rows[0] as { action_class: string; delivery: string; payload: Record<string, unknown> };
      expect(row.action_class).toBe(run.park!.actionClass);
      expect(row.delivery).toBe(run.park!.delivery);
      if (run.reason === 'customer_visible') {
        expect(row.payload['draftExternalId']).toBe(run.park!.draftExternalId);
      } else {
        expect(row.payload).toEqual(run.park!.payload);
      }
    }
  });

  // The column's contract is a normalized distance in [0, 1] (db/003). The
  // seeder wrote a rounded token count near 24, so the control band reported
  // a mean twenty-four times the worst value the metric can take.
  it('records an approval-edit distance on the scale the column declares', async () => {
    const { rows } = await pool.query(
      'SELECT approval_edit_distance AS d FROM run WHERE approval_edit_distance IS NOT NULL',
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows as { d: number }[]) {
      expect(row.d).toBeGreaterThanOrEqual(0);
      expect(row.d).toBeLessThanOrEqual(1);
    }
  });
});
