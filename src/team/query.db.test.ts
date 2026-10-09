// The team screen's figures.
//
// A case is a turn, judged by its final attempt. The team's time is the hold
// history: each interval runs from a take or a handover to the next event on
// the run, and never past the lapse its own take set. Every expected value
// below is worked out by hand from those two rules.
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { enqueueTicket } from '../coordinator/intake.js';
import { dbUrl, readerDbUrl } from '../db/config.js';
import { fencedInsert, resumeStrandedRun } from '../ledger/insert.js';
import { truncateLedger } from '../test-support/schema.js';
import { readTeam } from './query.js';

const pool = new Pool({ connectionString: dbUrl() });
// The readers connect as the role that cannot act beyond a read.
const readers = new Pool({ connectionString: readerDbUrl(), max: 4 });
await pool.query('SELECT 1');

const NOW = new Date('2026-09-14T15:00:00Z');
const MINUTE = 60_000;
const LAPSE = 20 * MINUTE;

function minutesBefore(minutes: number): Date {
  return new Date(NOW.getTime() - minutes * MINUTE);
}

interface Turn { conversationId: string; turnNumber: number; ticketId: string }

async function arrive(): Promise<Turn> {
  const ticketId = 'T-' + randomUUID().slice(0, 8);
  const result = await enqueueTicket(pool, { ticketId, messageId: randomUUID(), ticketText: 'a synthetic question' }, 4);
  return { conversationId: result.conversationId, turnNumber: result.turnNumber, ticketId };
}

let epoch = 1n;

async function run(
  turn: Turn,
  state: string,
  options: { attempt?: number; product?: string; createdAt?: Date; approvedBy?: string; sentBack?: boolean } = {},
): Promise<string> {
  const runId = randomUUID();
  epoch += 1n;
  expect(await fencedInsert(pool, {
    runId, ticketId: turn.ticketId, partition: 0, epoch, state, promptVer: 'p1', modelVer: 'm1',
    conversationId: turn.conversationId, turnNumber: turn.turnNumber, deadlineAt: new Date(Date.now() + 60_000),
  }, null)).toEqual({ outcome: 'accepted' });
  await pool.query(
    `UPDATE run SET attempt = $2, product = $3, created_at = $4, approved_by = $5,
                    approved_by_source = CASE WHEN $5::text IS NOT NULL THEN 'roster' END,
                    sent_back_at = CASE WHEN $6 THEN $4::timestamptz END
      WHERE run_id = $1`,
    [runId, options.attempt ?? 1, options.product ?? 'aurora', options.createdAt ?? minutesBefore(60),
      options.approvedBy ?? null, options.sentBack ?? false],
  );
  return runId;
}

async function step(runId: string, stepId: string, status = 'done'): Promise<void> {
  await pool.query(
    `INSERT INTO step_journal (run_id, step_id, status, result, prompt_ver, model_ver, cost_micros)
     VALUES ($1, $2, $3, '{}', 'team-test-prompt', 'team-test-model', 0)`,
    [runId, stepId, status],
  );
}

async function event(runId: string, reviewer: string, kind: string, at: Date, reason?: string): Promise<void> {
  await pool.query(
    'INSERT INTO case_hold_event (run_id, reviewer, kind, reason, at) VALUES ($1, $2, $3, $4, $5)',
    [runId, reviewer, kind, reason ?? null, at],
  );
}

async function reviewer(identity: string, products: string[], active = true): Promise<void> {
  await pool.query('INSERT INTO reviewer (identity, active, products) VALUES ($1, $2, $3)', [identity, active, products]);
}

async function written(writer: string, at: Date): Promise<void> {
  await pool.query(
    `INSERT INTO document (doc_id, kind, title, body, owner, review_by, products, source, embedding_status,
                           created_at, written_by)
     VALUES ($1, 'document', 'A title', 'A body.', 'kb-team', '2999-01-01', '{aurora}', 'console', 'pending', $2, $3)`,
    [`console-${randomUUID()}`, at, writer],
  );
}

async function read(now = NOW) {
  return readTeam(readers, { now, lapseMs: LAPSE });
}

describe('the team screen', () => {
  beforeEach(async () => {
    await truncateLedger(pool);
  });
  afterAll(async () => {
    await readers.end();
    await pool.end();
  });

  it('names no figure on an empty ledger', async () => {
    const report = await read();
    expect(report.today).toMatchObject({ auto: 0, person: 0, escalated: 0, inProgress: 0, noAnswer: 0 });
    expect(report.today.from).toBe('2026-09-14T00:00:00.000Z');
    expect(report.week).toEqual({ from: '2026-09-07T15:00:00.000Z', to: '2026-09-14T15:00:00.000Z' });
    expect(report).toMatchObject({
      supportMs: null, previousSupportMs: null, supportPeople: 0, medianCaseMs: null, sentCases: 0,
      oldestWaiting: null, people: [], products: [],
    });
  });

  it('counts a case once, by its final attempt, and sorts each ending', async () => {
    // Attempt 1 parked and a person sent it back; attempt 2 resolved with no
    // approver. One case, which needed a person.
    const sentBack = await arrive();
    const first = await run(sentBack, 'superseded', { sentBack: true, createdAt: minutesBefore(120) });
    await step(first, 'park');
    await run(sentBack, 'resolved', { attempt: 2, createdAt: minutesBefore(30) });

    await run(await arrive(), 'resolved');
    await run(await arrive(), 'escalated');
    await run(await arrive(), 'composed');
    await run(await arrive(), 'abandoned');
    // A twin superseded because the other run answered: no answer on record.
    await run(await arrive(), 'superseded');
    await run(await arrive(), 'resolved', { approvedBy: 'reviewer-a' });
    await run(await arrive(), 'closed');
    await run(await arrive(), 'snoozed');
    const rewritten = await run(await arrive(), 'resolved');
    await step(rewritten, 'rewrite');
    const parkedAndResolved = await run(await arrive(), 'resolved');
    await step(parkedAndResolved, 'park');
    await run(await arrive(), 'awaiting_approval');
    // Sent back by a person, and its next attempt not yet started.
    await run(await arrive(), 'superseded', { sentBack: true });
    // Yesterday is not today.
    await run(await arrive(), 'resolved', { createdAt: new Date('2026-09-13T23:59:00Z') });

    expect((await read()).today).toMatchObject({ auto: 1, person: 8, escalated: 1, inProgress: 1, noAnswer: 2 });
  });

  it('adds hold time from each take to the next event, never past the lapse the take set', async () => {
    await reviewer('reviewer-a', ['aurora']);
    await reviewer('reviewer-b', ['aurora', 'ledger']);
    const lapsed = await run(await arrive(), 'awaiting_approval');
    // Taken, refreshed 5 minutes later, and the lapse noticed an hour later:
    // 5 minutes, then 20 from the refresh, so 25.
    await event(lapsed, 'reviewer-a', 'take', minutesBefore(120));
    await event(lapsed, 'reviewer-a', 'take', minutesBefore(115), 'refresh');
    await event(lapsed, 'reviewer-a', 'lapse', minutesBefore(60));
    // Taken by a, handed over to b 10 minutes later, sent by b 2 minutes after.
    const handed = await run(await arrive(), 'resolved', { approvedBy: 'reviewer-b' });
    await event(handed, 'reviewer-a', 'take', minutesBefore(50));
    await event(handed, 'reviewer-b', 'handover', minutesBefore(40));
    await event(handed, 'reviewer-b', 'send', minutesBefore(38));

    const report = await read();
    expect(report.supportMs).toBe((25 + 10 + 2) * MINUTE);
    expect(report.supportPeople).toBe(2);
    const people = new Map(report.people.map((person) => [person.identity, person]));
    expect(people.get('reviewer-a')).toMatchObject({ supportMs: 35 * MINUTE, cases: 2, products: ['aurora'] });
    expect(people.get('reviewer-b')).toMatchObject({ supportMs: 2 * MINUTE, cases: 1, products: ['aurora', 'ledger'] });
  });

  it('clips hold time to the week, and reads the week before on its own', async () => {
    await reviewer('reviewer-a', []);
    const early = await run(await arrive(), 'resolved', { createdAt: new Date('2026-09-07T14:00:00Z') });
    // Taken 10 minutes before the week starts and sent 5 minutes into it.
    await event(early, 'reviewer-a', 'take', new Date('2026-09-07T14:50:00Z'));
    await event(early, 'reviewer-a', 'send', new Date('2026-09-07T15:05:00Z'));
    const report = await read();
    expect(report.supportMs).toBe(5 * MINUTE);
    expect(report.previousSupportMs).toBe(10 * MINUTE);
  });

  it('counts an open hold up to now, and names what each person holds', async () => {
    await reviewer('reviewer-a', ['aurora']);
    await reviewer('reviewer-c', [], false);
    const held = await run(await arrive(), 'awaiting_approval');
    await event(held, 'reviewer-a', 'take', minutesBefore(8));
    await pool.query(
      'INSERT INTO case_hold (run_id, reviewer, taken_at, lapses_at) VALUES ($1, $2, $3, $4)',
      [held, 'reviewer-a', minutesBefore(8), new Date(minutesBefore(8).getTime() + LAPSE)],
    );
    const report = await read();
    expect(report.supportMs).toBe(8 * MINUTE);
    // An inactive reviewer is not on the screen.
    expect(report.people).toEqual([
      { identity: 'reviewer-a', products: ['aurora'], cases: 1, supportMs: 8 * MINUTE, documents: 0, holding: [held] },
    ]);
    expect(report.oldestWaiting).toMatchObject({ runId: held, heldBy: 'reviewer-a', product: 'aurora' });
  });

  it('measures a case from its first take to its send, and takes the median', async () => {
    const sends = [
      // Taken, refreshed 10 minutes later, sent 5 after: 15 from the first take.
      { take: 100, refresh: 90, send: 85 },
      { take: 60, send: 55 },
      { take: 50, send: 20 },
    ];
    for (const times of sends) {
      const runId = await run(await arrive(), 'resolved', { approvedBy: 'reviewer-a' });
      await event(runId, 'reviewer-a', 'take', minutesBefore(times.take));
      if (times.refresh !== undefined) await event(runId, 'reviewer-a', 'take', minutesBefore(times.refresh), 'refresh');
      await event(runId, 'reviewer-a', 'send', minutesBefore(times.send));
    }
    const report = await read();
    expect(report.sentCases).toBe(3);
    // 15, 5 and 30 minutes: the median is 15.
    expect(report.medianCaseMs).toBe(15 * MINUTE);
  });

  it('counts documents a person wrote in the week', async () => {
    await reviewer('reviewer-a', []);
    await written('reviewer-a', minutesBefore(60));
    await written('reviewer-a', minutesBefore(3 * 24 * 60));
    await written('reviewer-a', minutesBefore(8 * 24 * 60));
    expect((await read()).people[0]).toMatchObject({ identity: 'reviewer-a', documents: 2 });
  });

  it('names the oldest case that waits for approval', async () => {
    await run(await arrive(), 'awaiting_approval', { createdAt: minutesBefore(30), product: 'ledger' });
    const oldest = await run(await arrive(), 'awaiting_approval', { createdAt: minutesBefore(126), product: 'kestrel' });
    await run(await arrive(), 'resolved', { createdAt: minutesBefore(500) });
    // A hold released, and one that lapsed, hold nothing now.
    await pool.query(
      'INSERT INTO case_hold (run_id, reviewer, taken_at, lapses_at, released_at) VALUES ($1, $2, $3, $4, $5)',
      [oldest, 'reviewer-a', minutesBefore(10), minutesBefore(-10), minutesBefore(5)],
    );
    expect((await read()).oldestWaiting).toEqual({
      runId: oldest, createdAt: minutesBefore(126).toISOString(), product: 'kestrel', heldBy: null,
    });
    await pool.query(
      'UPDATE case_hold SET released_at = NULL, taken_at = $2, lapses_at = $3 WHERE run_id = $1',
      [oldest, minutesBefore(40), minutesBefore(20)],
    );
    expect((await read()).oldestWaiting).toMatchObject({ runId: oldest, heldBy: null });
  });

  it('splits each product\'s cases in the week, with no product last', async () => {
    await run(await arrive(), 'resolved', { product: 'ledger', createdAt: minutesBefore(3 * 24 * 60) });
    await run(await arrive(), 'escalated', { product: 'ledger' });
    await run(await arrive(), 'resolved', { product: 'aurora', approvedBy: 'reviewer-a' });
    const none = await arrive();
    const noProduct = await run(none, 'resolved');
    await pool.query('UPDATE run SET product = NULL WHERE run_id = $1', [noProduct]);
    // Before the week: not counted.
    await run(await arrive(), 'resolved', { product: 'ledger', createdAt: minutesBefore(8 * 24 * 60) });
    expect((await read()).products).toEqual([
      { product: 'aurora', auto: 0, person: 1, escalated: 0, inProgress: 0, noAnswer: 0 },
      { product: 'ledger', auto: 1, person: 0, escalated: 1, inProgress: 0, noAnswer: 0 },
      { product: null, auto: 1, person: 0, escalated: 0, inProgress: 0, noAnswer: 0 },
    ]);
  });

  it('ends an open hold at the lapse its take recorded, not at the lapse the console runs now', async () => {
    await reviewer('reviewer-a', []);
    const held = await run(await arrive(), 'awaiting_approval');
    // Taken 30 minutes ago under a 20-minute lapse, and not yet noticed as
    // lapsed. The screen runs with a lapse of an hour: the hold still counts
    // 20 minutes, the period its take recorded.
    await event(held, 'reviewer-a', 'take', minutesBefore(30));
    await pool.query(
      'INSERT INTO case_hold (run_id, reviewer, taken_at, lapses_at) VALUES ($1, $2, $3, $4)',
      [held, 'reviewer-a', minutesBefore(30), minutesBefore(10)],
    );
    // A take the hold row does not hold ends at most one lapse after it,
    // at the console's setting: 30 minutes, up to now.
    const unheld = await run(await arrive(), 'awaiting_approval');
    await event(unheld, 'reviewer-a', 'take', minutesBefore(30));
    const report = await readTeam(readers, { now: NOW, lapseMs: 60 * MINUTE });
    expect(report.supportMs).toBe((20 + 30) * MINUTE);
  });

  it('counts an open hold taken long before the week whose recorded lapse reaches into it', async () => {
    await reviewer('reviewer-a', []);
    const held = await run(await arrive(), 'awaiting_approval');
    // Taken 40 minutes before the week starts, under an hour's lapse that the
    // hold recorded. The console now runs a 20-minute lapse, so the take is
    // older than the week's start minus that lapse. The hold still counts the
    // 20 minutes its lapse runs into the week.
    const weekStart = new Date(NOW.getTime() - 7 * 24 * 60 * MINUTE);
    const taken = new Date(weekStart.getTime() - 40 * MINUTE);
    await event(held, 'reviewer-a', 'take', taken);
    await pool.query(
      'INSERT INTO case_hold (run_id, reviewer, taken_at, lapses_at) VALUES ($1, $2, $3, $4)',
      [held, 'reviewer-a', taken, new Date(taken.getTime() + 60 * MINUTE)],
    );
    expect((await read()).supportMs).toBe(20 * MINUTE);
  });

  it('reads a large hold history inside its time budget', async () => {
    // 4,000 cases sent in the week, each taken and sent, behind 30,000 older
    // events. A statement that reads the history once per send takes many
    // seconds at this size; the budget is two.
    await pool.query(
      `INSERT INTO case_hold_event (run_id, reviewer, kind, at)
       SELECT gen_random_uuid(), 'reviewer-a', 'take', $1::timestamptz - (n * interval '1 second')
         FROM generate_series(1, 30000) n`,
      [minutesBefore(30 * 24 * 60)],
    );
    await pool.query(
      `INSERT INTO case_hold_event (run_id, reviewer, kind, at)
       SELECT id, 'reviewer-a', kind, $1::timestamptz + (n * interval '1 second') + offset_by
         FROM generate_series(1, 4000) n
         CROSS JOIN LATERAL (SELECT md5(n::text)::uuid AS id) r
         CROSS JOIN (VALUES ('take', interval '0'), ('send', interval '5 minutes')) k(kind, offset_by)
        ORDER BY n, offset_by`,
      [minutesBefore(3 * 24 * 60)],
    );
    // The 4,000 sent cases are runs that stayed resolved.
    await pool.query(
      `INSERT INTO run (run_id, ticket_id, partition, epoch, state, prompt_ver, model_ver, deadline_at, created_at)
       SELECT md5(n::text)::uuid, 'T-' || n, 0, 1, 'resolved', 'p', 'm', now(), $1::timestamptz
         FROM generate_series(1, 4000) n`,
      [minutesBefore(4 * 24 * 60)],
    );
    const report = await readTeam(readers, { now: NOW, lapseMs: LAPSE });
    expect(report.sentCases).toBe(4000);
    expect(report.medianCaseMs).toBe(5 * MINUTE);
  });

  it('judges an attempt by the run that carries it on, not by a twin it superseded', async () => {
    // A stranded walk handed back: the newer run of the same attempt is set
    // superseded with no send-back, and the older one waits for a person.
    const turn = await arrive();
    const base = {
      ticketId: turn.ticketId, partition: 0, promptVer: 'p1', modelVer: 'm1',
      conversationId: turn.conversationId, turnNumber: turn.turnNumber, deadlineAt: new Date(Date.now() + 600_000),
    };
    const older = randomUUID();
    const newer = randomUUID();
    epoch += 1n;
    expect(await fencedInsert(pool, { ...base, runId: older, epoch, state: 'gated' }, null)).toEqual({ outcome: 'accepted' });
    epoch += 1n;
    expect(await fencedInsert(pool, { ...base, runId: newer, epoch, state: 'gated' }, null)).toEqual({ outcome: 'accepted' });
    await pool.query('UPDATE run SET created_at = $2 WHERE run_id = $1', [older, minutesBefore(20)]);
    await pool.query('UPDATE run SET created_at = $2 WHERE run_id = $1', [newer, minutesBefore(10)]);
    expect((await resumeStrandedRun(pool, {
      runId: newer, strandedRunId: older, costMicros: 0, stepsUsed: 0, afterWrite: async () => {},
    })).outcome).toBe('resumed');
    const states = await pool.query<{ run_id: string; state: string }>('SELECT run_id, state FROM run');
    expect(new Map(states.rows.map((row) => [row.run_id, row.state]))).toEqual(
      new Map([[older, 'awaiting_approval'], [newer, 'superseded']]));
    expect((await read()).today).toMatchObject({ person: 1, noAnswer: 0 });
  });

  it('measures a case sent twice once, from its first take to its last send', async () => {
    // Sent, the send undone within its hold, and sent again (DEC-51).
    const runId = await run(await arrive(), 'resolved', { approvedBy: 'reviewer-a' });
    await event(runId, 'reviewer-a', 'take', minutesBefore(60));
    await event(runId, 'reviewer-a', 'send', minutesBefore(50));
    await event(runId, 'reviewer-a', 'take', minutesBefore(45));
    await event(runId, 'reviewer-a', 'send', minutesBefore(20));
    const report = await read();
    expect(report.sentCases).toBe(1);
    expect(report.medianCaseMs).toBe(40 * MINUTE);
  });

  it('counts no case whose send a person undid and never sent again', async () => {
    // An undo (DEC-51) moves the run back to awaiting approval and leaves the
    // send in the hold history (src/approval/undo.ts). No reply reached the
    // customer, so the case was not sent.
    const undone = await run(await arrive(), 'awaiting_approval');
    await event(undone, 'reviewer-a', 'take', minutesBefore(60));
    await event(undone, 'reviewer-a', 'send', minutesBefore(50));
    const sent = await run(await arrive(), 'resolved', { approvedBy: 'reviewer-a' });
    await event(sent, 'reviewer-a', 'take', minutesBefore(30));
    await event(sent, 'reviewer-a', 'send', minutesBefore(25));
    const report = await read();
    expect(report.sentCases).toBe(1);
    expect(report.medianCaseMs).toBe(5 * MINUTE);
  });

  it('refuses a lapse that is not a positive whole number of milliseconds', async () => {
    for (const lapseMs of [0, -1, 1.5, Number.NaN]) {
      await expect(readTeam(readers, { now: NOW, lapseMs })).rejects.toThrow(RangeError);
    }
  });
});
