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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { dbUrl } from '../db/config.js';
import { applyLedgerSchema } from '../test-support/schema.js';
import { readDays } from '../bands/query.js';
import { readLatency } from '../latency/query.js';
import { approveRun } from '../approval/approve.js';
import { listEscalations } from '../escalations/query.js';
import { evaluatePolicyDetailed, SEED_THRESHOLDS } from '../policy/policy.js';
import { SEED_DOCUMENTS, planHistory, policyInputFor, type PlannedRun } from './plan.js';
import { writeDocuments, writeHistory } from './write.js';

const pool = new Pool({ connectionString: dbUrl(), max: 8 });

await pool.query('SELECT 1');

const OPTIONS = { seed: 0x41726361, days: 3, endDay: '2026-06-30', partitions: 4, provider: 'stub' };

async function truncate(): Promise<void> {
  // `document` too: the seeder writes the small corpus a `retrieve` row's
  // ids point at, and a case that counted rows would otherwise count another
  // suite's index as well.
  await pool.query(
    'TRUNCATE run, ticket_epoch, step_journal, outbox, intake, conversation, turn, document',
  );
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
  await pool.end();
});

describe('the document corpus the seeder writes', () => {
  // The schema once, the truncate per case. Every other block here re-applies
  // the whole migration set before each test, and each replay is DDL against
  // a database the run shares — which is where `applyLedgerSchema` deadlocks
  // when the machine is short of memory. This block adds none of that.
  beforeAll(async () => {
    await applyLedgerSchema(pool);
  });

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
    expect(written).toBe(SEED_DOCUMENTS.length);
    // Counted from the ledger, so the number reports what landed rather than
    // what the plan held.
    const rows = await pool.query("SELECT count(*)::int AS n FROM document WHERE doc_id LIKE 'SYN-%'");
    expect(rows.rows[0]?.n).toBe(SEED_DOCUMENTS.length);
    // Re-applying is the retriever's own upsert, so it stays at the same count.
    expect(await writeDocuments(pool)).toBe(SEED_DOCUMENTS.length);
  });
});

describe('the seeded history', () => {
  beforeAll(async () => {
    await applyLedgerSchema(pool);
  });

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
  beforeAll(async () => {
    await applyLedgerSchema(pool);
  });

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
    const report = await readLatency(pool);
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
    const report = await readLatency(pool);
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

  beforeAll(async () => {
    await applyLedgerSchema(pool);
  });

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
});

describe('the journal a seeded run leaves', () => {
  let plan: PlannedRun[];

  beforeAll(async () => {
    await applyLedgerSchema(pool);
  });

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
    const counts = await pool.query('SELECT count(*)::int AS n FROM turn');
    expect((counts.rows[0] as { n: number }).n).toBe(new Set(plan.map((r) => r.conversationId)).size);
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
