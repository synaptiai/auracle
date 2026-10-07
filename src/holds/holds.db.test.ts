// The case hold (DEC-46).
//
// Taking a case marks it held by one reviewer, and the others see who holds
// it. The hold is advisory: it refuses no write. What it decides is who the
// console says is working the case, and what the team's time on it was.
//
// The run row is the lock. Two reviewers can reach a take at the same
// instant, and the ledger has to pick one of them: the take reads the run row
// `FOR UPDATE` first, so the second waits and then sees the first's hold.
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readDays } from '../bands/query.js';
import { dbUrl, readerDbUrl } from '../db/config.js';
import { readLatency } from '../latency/query.js';
import { truncateLedger } from '../test-support/schema.js';
import {
  handoverHold, holdHistory, readHold, readHolds, releaseHold, releaseHoldIn, takeHold,
} from './hold.js';

const pool = new Pool({ connectionString: dbUrl(), max: 6 });
// The readers connect as the role that cannot act beyond a read (issue #153).
const readers = new Pool({ connectionString: readerDbUrl(), max: 4 });

await pool.query('SELECT 1');

/** Twenty minutes, the period the console defaults to. */
const LAPSE_MS = 1_200_000;

/** One run, in the state a take applies to unless a case says otherwise. */
async function runIn(state = 'awaiting_approval'): Promise<string> {
  const runId = randomUUID();
  await pool.query(
    `INSERT INTO run (run_id, ticket_id, partition, epoch, state, prompt_ver, model_ver, deadline_at)
     VALUES ($1, 'T-1', 0, 1, $2, 'p', 'm', now() + interval '1 day')`,
    [runId, state],
  );
  return runId;
}

/**
 * Everything about a case a hand-over must not touch (DEC-48).
 *
 * The hold is advisory: it says who is working a case and nothing else. So
 * this is the whole of what a customer could see — the run row entire, the
 * conversation it belongs to, every outbox record and every turn's text —
 * read before and after a move. `SELECT *` and not a column list: a column
 * this change does not know about is a column a later change could move.
 *
 * Out of scope, deliberately: `case_hold` and `case_hold_event`, which are
 * what a move writes, and `step_journal`, which the holds module never
 * writes. The outbox set and the turn set are asserted non-empty by the case
 * below, because two empty sets are equal whatever the code does.
 */
async function customerFacing(runId: string): Promise<unknown> {
  const run = await pool.query('SELECT * FROM run WHERE run_id = $1', [runId]);
  const conversation = await pool.query(
    `SELECT c.* FROM conversation c
       JOIN run r ON r.conversation_id = c.conversation_id
      WHERE r.run_id = $1`,
    [runId],
  );
  const outbox = await pool.query(
    'SELECT step_id, idem_key, status, payload, reply FROM outbox WHERE run_id = $1 ORDER BY step_id',
    [runId],
  );
  const turns = await pool.query(
    `SELECT t.* FROM turn t
       JOIN run r ON r.conversation_id = t.conversation_id
      WHERE r.run_id = $1 ORDER BY t.turn_number`,
    [runId],
  );
  return { run: run.rows, conversation: conversation.rows, outbox: outbox.rows, turns: turns.rows };
}

/** A window that covers a run created now. */
const FROM = new Date(Date.now() - 86_400_000);
const TO = new Date(Date.now() + 86_400_000);

/**
 * A case with a customer behind it: one conversation, one turn carrying text,
 * and a run that answers it.
 *
 * The wait is measured too (`enqueued_at` one second before creation), so the
 * latency report computes a real duration from this run and a move that
 * re-stamped `created_at` would show in it.
 */
async function caseWithACustomer(): Promise<string> {
  const conversationId = randomUUID();
  await pool.query(
    `INSERT INTO conversation (conversation_id, primary_ticket_id, state)
     VALUES ($1, 'T-1', 'open')`,
    [conversationId],
  );
  await pool.query(
    `INSERT INTO turn (conversation_id, turn_number, ticket_id, body_text, saved_reply_text)
     VALUES ($1, 1, 'T-1', 'There are two charges for the same month.', 'We refunded the duplicate.')`,
    [conversationId],
  );
  const runId = await runIn();
  await pool.query(
    `UPDATE run
        SET conversation_id = $2, turn_number = 1,
            enqueued_at = created_at - interval '1 second'
      WHERE run_id = $1`,
    [runId, conversationId],
  );
  return runId;
}

/** The live row for a run, as the table holds it. */
async function rowOf(runId: string): Promise<Record<string, unknown> | undefined> {
  const { rows } = await pool.query('SELECT * FROM case_hold WHERE run_id = $1', [runId]);
  return rows[0] as Record<string, unknown> | undefined;
}

describe('the case hold (DEC-46)', () => {
  beforeEach(async () => {
    await truncateLedger(pool);
  });

  afterEach(async () => {
    await truncateLedger(pool);
  });

  // Criterion 1. The take is the whole point: one reviewer marks the case as
  // theirs, and the ledger remembers when the hold started and when it ends.
  it('takes a waiting case, and stamps when the hold lapses', async () => {
    const runId = await runIn();
    expect(await takeHold(pool, { runId, reviewer: 'anna@example.test', lapseMs: LAPSE_MS }))
      .toEqual({ outcome: 'taken' });

    const hold = await readHold(pool, runId);
    expect(hold?.reviewer).toBe('anna@example.test');
    expect(hold?.takenAt).toBeInstanceOf(Date);
    // The period the caller named, from the take, to the millisecond.
    expect(hold!.lapsesAt.getTime() - hold!.takenAt.getTime()).toBe(LAPSE_MS);
    expect(await rowOf(runId)).toMatchObject({
      reviewer: 'anna@example.test',
      released_at: null,
    });
  });

  // Criterion 1. The second reviewer is told who holds it, not merely that
  // somebody does: the answer carries the holder and the time they took it.
  it('tells a second reviewer who holds the case', async () => {
    const runId = await runIn();
    await takeHold(pool, { runId, reviewer: 'anna@example.test', lapseMs: LAPSE_MS });

    const refused = await takeHold(pool, { runId, reviewer: 'bo@example.test', lapseMs: LAPSE_MS });
    expect(refused.outcome).toBe('held_by_other');
    if (refused.outcome !== 'held_by_other') return;
    expect(refused.holder.reviewer).toBe('anna@example.test');
    expect(refused.holder.takenAt).toBeInstanceOf(Date);
    // And nothing changed: Anna still holds it.
    expect((await rowOf(runId))!['reviewer']).toBe('anna@example.test');
  });

  // Criterion 1, risk row "Takeover bookkeeping". A forced take is a
  // handover, and the history has to say so — a takeover recorded as a plain
  // take tells the team two people each took the case for the first time.
  it('moves the hold on a forced take, and records it as a handover', async () => {
    const runId = await runIn();
    await takeHold(pool, { runId, reviewer: 'anna@example.test', lapseMs: LAPSE_MS });
    expect(await takeHold(pool, {
      runId, reviewer: 'bo@example.test', lapseMs: LAPSE_MS, force: true,
    })).toEqual({ outcome: 'taken' });

    const hold = await readHold(pool, runId);
    expect(hold?.reviewer).toBe('bo@example.test');
    // The whole history, in order. `from_reviewer` names whose hold moved.
    expect((await holdHistory(pool, runId)).map((event) => [event.kind, event.reviewer, event.fromReviewer]))
      .toEqual([
        ['take', 'anna@example.test', null],
        ['handover', 'bo@example.test', 'anna@example.test'],
      ]);
  });

  // Criterion 1, and the maintainer's amendment of 2026-09-18: the lock is
  // one case per person, because a reviewer reads one case at a time.
  it('releases the taker\'s other hold when they take another case', async () => {
    const first = await runIn();
    const second = await runIn();
    await takeHold(pool, { runId: first, reviewer: 'anna@example.test', lapseMs: LAPSE_MS });
    expect(await takeHold(pool, { runId: second, reviewer: 'anna@example.test', lapseMs: LAPSE_MS }))
      .toEqual({ outcome: 'taken' });

    expect(await readHold(pool, first)).toBeNull();
    expect((await readHold(pool, second))?.reviewer).toBe('anna@example.test');
    // The release is recorded, with the reason on the row and the event.
    const released = await rowOf(first);
    expect(released).toMatchObject({
      released_by: 'anna@example.test',
      release_kind: 'take_other',
    });
    expect((await holdHistory(pool, first)).map((event) => event.kind))
      .toEqual(['take', 'release']);
  });

  // Criterion 1, failure mode "invalid input". A case that is not waiting for
  // a person is not a case anyone takes, and the answer names its state so
  // the console can say which.
  it('refuses a case that is not waiting, and names its state', async () => {
    const runId = await runIn('resolved');
    expect(await takeHold(pool, { runId, reviewer: 'anna@example.test', lapseMs: LAPSE_MS }))
      .toEqual({ outcome: 'not_waiting', state: 'resolved' });
    expect(await rowOf(runId)).toBeUndefined();
  });

  // Failure mode "invalid input": a run id that is not a UUID cannot be a
  // run, and it never reaches a statement — the uuid column would raise.
  it('answers unknown_run for a run that does not exist, and for one that cannot', async () => {
    expect(await takeHold(pool, {
      runId: randomUUID(), reviewer: 'anna@example.test', lapseMs: LAPSE_MS,
    })).toEqual({ outcome: 'unknown_run' });
    expect(await takeHold(pool, {
      runId: 'not-a-uuid', reviewer: 'anna@example.test', lapseMs: LAPSE_MS,
    })).toEqual({ outcome: 'unknown_run' });
  });

  // Risk row "Take race": two takes at one instant, on one case. One of them
  // wins, and exactly one live row exists afterwards. Without the run's row
  // lock both read no holder and both write one.
  it('lets one of two concurrent takes win, and leaves one live row', async () => {
    const runId = await runIn();
    const [a, b] = await Promise.all([
      takeHold(pool, { runId, reviewer: 'anna@example.test', lapseMs: LAPSE_MS }),
      takeHold(pool, { runId, reviewer: 'bo@example.test', lapseMs: LAPSE_MS }),
    ]);

    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(['held_by_other', 'taken']);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM case_hold WHERE run_id = $1', [runId]);
    expect(rows[0]?.n).toBe(1);
    // And the loser was told who won.
    const loser = a.outcome === 'held_by_other' ? a : b;
    const winner = a.outcome === 'taken' ? 'anna@example.test' : 'bo@example.test';
    expect(loser.outcome === 'held_by_other' && loser.holder.reviewer).toBe(winner);
  });

  // Criterion 2, risk row "Lapse boundary". A hold whose period ends at this
  // instant has ended: `lapses_at <= now()`, never `<`. The wrong version
  // keeps the case held one instant past its lease, which is the instant a
  // reader sees it as somebody's.
  it('treats a hold whose period ends now as lapsed', async () => {
    const runId = await runIn();
    await takeHold(pool, { runId, reviewer: 'anna@example.test', lapseMs: LAPSE_MS });
    // Stamped to end here, as the clock the take read would have left it.
    await pool.query('UPDATE case_hold SET lapses_at = now() WHERE run_id = $1', [runId]);

    expect(await readHold(pool, runId)).toBeNull();
    expect(await takeHold(pool, { runId, reviewer: 'bo@example.test', lapseMs: LAPSE_MS }))
      .toEqual({ outcome: 'taken' });
    // The lapse is recorded, and it is Anna's: the history says the hold
    // ended by time, not that Bo took it from her.
    expect((await holdHistory(pool, runId)).map((event) => [event.kind, event.reviewer]))
      .toEqual([
        ['take', 'anna@example.test'],
        ['lapse', 'anna@example.test'],
        ['take', 'bo@example.test'],
      ]);
    expect((await rowOf(runId))!['reviewer']).toBe('bo@example.test');
  });

  // The boundary, decided in ONE transaction. `now()` is the instant a
  // transaction started, so a hold stamped to end at `now()` and judged by
  // the same transaction's `now()` sits exactly on its period's end — the one
  // instant `<=` and `<` answer differently. Every other case here stamps in
  // one transaction and reads in another, where the second `now()` is later
  // and both spellings clear the row.
  it('treats a hold ending at this instant as lapsed, judged in one transaction', async () => {
    const runId = await runIn();
    await takeHold(pool, { runId, reviewer: 'anna@example.test', lapseMs: LAPSE_MS });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE case_hold SET lapses_at = now() WHERE run_id = $1', [runId]);
      expect(await releaseHoldIn(client, { runId, reviewer: 'anna@example.test', kind: 'release' }))
        .toEqual({ outcome: 'not_held' });
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    // The release released nothing, and the lapse it found is recorded.
    expect((await holdHistory(pool, runId)).map((event) => event.kind)).toEqual(['take', 'lapse']);
    expect((await rowOf(runId))!['release_kind']).toBe('lapse');
  });

  // The queue's read is a pure one: a lapsed hold is simply not in the map,
  // and the lapse stays unrecorded until a read or a take notices it. Without
  // the `lapses_at > now()` filter the queue would keep naming a holder whose
  // period ran out.
  it('leaves a lapsed hold out of the queue\'s map, and records nothing', async () => {
    const live = await runIn();
    const lapsed = await runIn();
    await takeHold(pool, { runId: live, reviewer: 'anna@example.test', lapseMs: LAPSE_MS });
    await takeHold(pool, { runId: lapsed, reviewer: 'bo@example.test', lapseMs: LAPSE_MS });
    await pool.query(
      "UPDATE case_hold SET lapses_at = now() - interval '1 second' WHERE run_id = $1",
      [lapsed],
    );

    const holds = await readHolds(pool, [live, lapsed]);
    expect([...holds.keys()]).toEqual([live]);
    // The row is untouched and the history says only that it was taken: the
    // queue leaves the lapse to the next read or take.
    expect((await rowOf(lapsed))!['released_at']).toBeNull();
    expect((await holdHistory(pool, lapsed)).map((event) => event.kind)).toEqual(['take']);
  });

  // The sweep is global, by design: any transaction here clears every hold
  // whose period has run out, not only the one it was asked about. A take of
  // one case is what records another case's lapse when nobody looked at it.
  it('records another case\'s lapse on the next take', async () => {
    const first = await runIn();
    const second = await runIn();
    await takeHold(pool, { runId: first, reviewer: 'anna@example.test', lapseMs: LAPSE_MS });
    await pool.query(
      "UPDATE case_hold SET lapses_at = now() - interval '1 second' WHERE run_id = $1",
      [first],
    );

    expect(await takeHold(pool, { runId: second, reviewer: 'bo@example.test', lapseMs: LAPSE_MS }))
      .toEqual({ outcome: 'taken' });
    expect((await holdHistory(pool, first)).map((event) => event.kind)).toEqual(['take', 'lapse']);
    expect(await readHold(pool, first)).toBeNull();
  });

  // Criterion 2's other half: the period is the console's, not the module's,
  // so an operator who sets it gets it.
  it('stamps the period it was given, and the lapse follows it', async () => {
    const runId = await runIn();
    await takeHold(pool, { runId, reviewer: 'anna@example.test', lapseMs: 60_000 });
    const hold = await readHold(pool, runId);
    expect(hold!.lapsesAt.getTime() - hold!.takenAt.getTime()).toBe(60_000);
    expect(hold!.lapsesAt.getTime()).toBeGreaterThan(Date.now());
    // The queue reads it as live; nothing lapsed early.
    expect((await readHolds(pool, [runId])).size).toBe(1);
  });

  // Criterion 3: a holder can move the case to a teammate. The teammate has
  // to be on the active roster — the roster is a parameter, because the
  // holds module reads no roster of its own — and the move refreshes the
  // period and records whose hold moved.
  it('moves the hold to the named teammate, and records the move', async () => {
    const runId = await runIn();
    await takeHold(pool, { runId, reviewer: 'anna@example.test', lapseMs: LAPSE_MS });

    const moved = await handoverHold(pool, {
      runId,
      from: 'anna@example.test',
      to: 'bo@example.test',
      lapseMs: 60_000,
      isReviewer: async (identity) => identity === 'bo@example.test',
    });
    expect(moved).toEqual({ outcome: 'handed_over' });

    const hold = await readHold(pool, runId);
    expect(hold?.reviewer).toBe('bo@example.test');
    // The period is the one this call named, from the move.
    expect(hold!.lapsesAt.getTime() - hold!.takenAt.getTime()).toBe(60_000);
    expect((await holdHistory(pool, runId)).map((event) => [event.kind, event.reviewer, event.fromReviewer]))
      .toEqual([
        ['take', 'anna@example.test', null],
        ['handover', 'bo@example.test', 'anna@example.test'],
      ]);
  });

  // Criterion 4, and DEC-48's row for this outcome: a hand-over moves the
  // reservation and nothing else. The customer sees nothing — no record
  // commits, no state moves, no reply text is written — and both published
  // reports read the same before and after, which is what their "unchanged"
  // cells claim.
  it('hands the case over without anything reaching the customer', async () => {
    const runId = await caseWithACustomer();
    await takeHold(pool, { runId, reviewer: 'anna@example.test', lapseMs: LAPSE_MS });
    // A record an earlier action left, so "no record was written" is
    // distinguishable from "there was nothing to write".
    await pool.query(
      `INSERT INTO outbox (run_id, step_id, idem_key, epoch, action_class, delivery, payload, status)
       VALUES ($1, 'execute', $2, 1, 'route_ticket', 'at_most_once', '{}'::jsonb, 'sent')`,
      [runId, `k-${runId}`],
    );
    const before = await customerFacing(runId);
    const daysBefore = await readDays(pool, FROM, TO);
    const latencyBefore = await readLatency(readers);
    // The sets the comparison rests on are not empty, and the reports cover
    // this run. Without these three lines the case would pass against a
    // fixture that read nothing, and against a window that covered nothing.
    expect((before as { turns: unknown[] }).turns).toHaveLength(1);
    expect(daysBefore).toHaveLength(1);
    expect(latencyBefore.runs).toBe(1);

    expect(await handoverHold(pool, {
      runId,
      from: 'anna@example.test',
      to: 'bo@example.test',
      lapseMs: LAPSE_MS,
      isReviewer: async () => true,
    })).toEqual({ outcome: 'handed_over' });

    // The reservation moved...
    expect((await readHold(pool, runId))?.reviewer).toBe('bo@example.test');
    // ...and every fact a customer could be affected by is byte for byte what
    // it was.
    expect(await customerFacing(runId)).toEqual(before);
    expect(await readDays(pool, FROM, TO)).toEqual(daysBefore);
    expect(await readLatency(readers)).toEqual(latencyBefore);
  });

  // One case per person, on the handover path too. The recipient is a
  // person reading one case at a time like anybody else, and without this a
  // handover could leave them holding two — and the queue would show them
  // working both.
  it('releases the recipient\'s other hold when the case moves to them', async () => {
    const first = await runIn();
    const second = await runIn();
    await takeHold(pool, { runId: first, reviewer: 'bo@example.test', lapseMs: LAPSE_MS });
    await takeHold(pool, { runId: second, reviewer: 'anna@example.test', lapseMs: LAPSE_MS });

    expect(await handoverHold(pool, {
      runId: second,
      from: 'anna@example.test',
      to: 'bo@example.test',
      lapseMs: LAPSE_MS,
      isReviewer: async (identity) => identity === 'bo@example.test',
    })).toEqual({ outcome: 'handed_over' });

    expect(await readHold(pool, first)).toBeNull();
    expect((await readHold(pool, second))?.reviewer).toBe('bo@example.test');
    // The release is recorded with the reason a take's release carries, so
    // the history reads as one rule rather than two.
    expect(await rowOf(first)).toMatchObject({
      released_by: 'bo@example.test',
      release_kind: 'take_other',
    });
    expect((await holdHistory(pool, first)).map((event) => [event.kind, event.reason]))
      .toEqual([['take', null], ['release', 'take_other']]);
  });

  // And a hold of theirs that has run out is the lapse it is, not a release
  // this handover caused. The sweep runs first, as it does on the take path.
  it('records the recipient\'s lapsed hold as a lapse, not as a release', async () => {
    const expired = await runIn();
    const moved = await runIn();
    await takeHold(pool, { runId: expired, reviewer: 'bo@example.test', lapseMs: LAPSE_MS });
    await takeHold(pool, { runId: moved, reviewer: 'anna@example.test', lapseMs: LAPSE_MS });
    await pool.query(
      "UPDATE case_hold SET lapses_at = now() - interval '1 second' WHERE run_id = $1",
      [expired],
    );

    expect(await handoverHold(pool, {
      runId: moved,
      from: 'anna@example.test',
      to: 'bo@example.test',
      lapseMs: LAPSE_MS,
      isReviewer: async () => true,
    })).toEqual({ outcome: 'handed_over' });

    expect(await rowOf(expired)).toMatchObject({ release_kind: 'lapse', released_by: null });
    expect((await holdHistory(pool, expired)).map((event) => event.kind)).toEqual(['take', 'lapse']);
    expect((await readHold(pool, moved))?.reviewer).toBe('bo@example.test');
  });

  // The roster decides. A case handed to somebody the roster does not hold
  // is a case nobody holds, so the move is refused and the holder keeps it —
  // and nothing is written.
  it('refuses a handover to an identity the roster does not hold', async () => {
    const runId = await runIn();
    await takeHold(pool, { runId, reviewer: 'anna@example.test', lapseMs: LAPSE_MS });

    expect(await handoverHold(pool, {
      runId,
      from: 'anna@example.test',
      to: 'stranger@example.test',
      lapseMs: LAPSE_MS,
      isReviewer: async (identity) => identity === 'bo@example.test',
    })).toEqual({ outcome: 'not_a_reviewer' });

    expect((await readHold(pool, runId))?.reviewer).toBe('anna@example.test');
    expect((await holdHistory(pool, runId)).map((event) => event.kind)).toEqual(['take']);
  });

  // And the holder is the only one who moves it. A reviewer who does not
  // hold the case is told so, and nothing changes.
  it('refuses a handover by a reviewer who does not hold the case', async () => {
    const runId = await runIn();
    await takeHold(pool, { runId, reviewer: 'anna@example.test', lapseMs: LAPSE_MS });

    expect(await handoverHold(pool, {
      runId,
      from: 'bo@example.test',
      to: 'cy@example.test',
      lapseMs: LAPSE_MS,
      isReviewer: async () => true,
    })).toEqual({ outcome: 'not_yours' });

    expect((await readHold(pool, runId))?.reviewer).toBe('anna@example.test');
    expect((await holdHistory(pool, runId)).map((event) => event.kind)).toEqual(['take']);
  });

  // A handover moves the case to a teammate, so the holder cannot be the
  // teammate. The field that carries the name is free text, and a holder who
  // types their own identity would otherwise write a `handover` naming one
  // person twice — an event that did not happen.
  it('refuses a handover to the reviewer who already holds it', async () => {
    const runId = await runIn();
    await takeHold(pool, { runId, reviewer: 'anna@example.test', lapseMs: LAPSE_MS });

    expect(await handoverHold(pool, {
      runId,
      from: 'anna@example.test',
      to: 'anna@example.test',
      lapseMs: LAPSE_MS,
      isReviewer: async () => true,
    })).toEqual({ outcome: 'already_yours' });

    expect((await readHold(pool, runId))?.reviewer).toBe('anna@example.test');
    expect((await holdHistory(pool, runId)).map((event) => event.kind)).toEqual(['take']);
  });

  // The refusal is about a hold the caller has: a reviewer who holds nothing
  // and names themselves is told the case is not theirs, which is the true
  // answer, rather than that they already have it.
  it('answers not_yours for a self-naming reviewer who holds nothing', async () => {
    const runId = await runIn();
    await takeHold(pool, { runId, reviewer: 'anna@example.test', lapseMs: LAPSE_MS });

    expect(await handoverHold(pool, {
      runId,
      from: 'bo@example.test',
      to: 'bo@example.test',
      lapseMs: LAPSE_MS,
      isReviewer: async () => true,
    })).toEqual({ outcome: 'not_yours' });
    expect((await holdHistory(pool, runId)).map((event) => event.kind)).toEqual(['take']);
  });

  // Nothing to hand over: the case is free, or the hold has run out.
  it('answers not_held when there is no live hold to hand over', async () => {
    const free = await runIn();
    expect(await handoverHold(pool, {
      runId: free,
      from: 'anna@example.test',
      to: 'bo@example.test',
      lapseMs: LAPSE_MS,
      isReviewer: async () => true,
    })).toEqual({ outcome: 'not_held' });

    const lapsed = await runIn();
    await takeHold(pool, { runId: lapsed, reviewer: 'anna@example.test', lapseMs: LAPSE_MS });
    await pool.query('UPDATE case_hold SET lapses_at = now() WHERE run_id = $1', [lapsed]);
    expect(await handoverHold(pool, {
      runId: lapsed,
      from: 'anna@example.test',
      to: 'bo@example.test',
      lapseMs: LAPSE_MS,
      isReviewer: async () => true,
    })).toEqual({ outcome: 'not_held' });
    // The lapse it found is recorded, as every other read records it.
    expect((await holdHistory(pool, lapsed)).map((event) => event.kind)).toEqual(['take', 'lapse']);
  });

  // A take by the reviewer who already holds the case is a refresh, not a
  // move. It is reachable — the queue keeps a reader's own case in its gate
  // group and `c` takes the focused row — and a `handover` naming the same
  // reviewer twice would record an event that did not happen.
  it('refreshes a hold the taker already has, and records no move', async () => {
    const runId = await runIn();
    await takeHold(pool, { runId, reviewer: 'anna@example.test', lapseMs: LAPSE_MS });
    const before = await readHold(pool, runId);

    // A one-minute period, so the refresh is visible in the row itself.
    expect(await takeHold(pool, { runId, reviewer: 'anna@example.test', lapseMs: 60_000 }))
      .toEqual({ outcome: 'taken' });
    const after = await readHold(pool, runId);
    expect(after?.reviewer).toBe('anna@example.test');
    expect(after!.takenAt.getTime()).toBeGreaterThanOrEqual(before!.takenAt.getTime());
    expect(after!.lapsesAt.getTime() - after!.takenAt.getTime()).toBe(60_000);
    expect((await holdHistory(pool, runId)).map((event) => [event.kind, event.reason, event.fromReviewer]))
      .toEqual([
        ['take', null, null],
        ['take', 'refresh', null],
      ]);
  });

  // The comparison is the database's, not this process's. With the console's
  // clock a minute ahead, a hold the ledger still counts live is released —
  // where a comparison against this process's clock read the same hold as
  // lapsed and answered `not_held`, leaving its holder unable to let it go
  // while the queue still showed them working the case.
  it('decides liveness on the database clock, not this process\'s', async () => {
    const runId = await runIn();
    await takeHold(pool, { runId, reviewer: 'anna@example.test', lapseMs: LAPSE_MS });
    await pool.query(
      "UPDATE case_hold SET lapses_at = now() + interval '1 second' WHERE run_id = $1",
      [runId],
    );

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 60_000);
    try {
      expect(await releaseHold(pool, { runId, reviewer: 'anna@example.test', kind: 'release' }))
        .toEqual({ outcome: 'released' });
    } finally {
      vi.useRealTimers();
    }
    expect((await holdHistory(pool, runId)).map((event) => event.kind)).toEqual(['take', 'release']);
  });

  // A rollback that fails must not replace the fault that caused it. The
  // connection is likeliest to be broken exactly when the statement already
  // broke it, and an incident reader needs the statement's fault.
  it('keeps the original fault when the rollback fails too', async () => {
    const broken = {
      connect: async () => ({
        query: async (text: string) => {
          if (text === 'BEGIN') return { rows: [] };
          if (text === 'ROLLBACK') throw new Error('rollback failed: connection terminated');
          throw new Error('statement failed: connection terminated');
        },
        release: (): void => undefined,
      }),
    };

    await expect(takeHold(broken as never, {
      runId: randomUUID(), reviewer: 'anna@example.test', lapseMs: LAPSE_MS,
    })).rejects.toThrow('statement failed: connection terminated');
  });

  // Criterion 8: the fence still refuses a stale write, and the hold changes
  // nothing about it. A take and a release write no column of the run and no
  // ticket epoch, so the comparison the ledger makes is the same before and
  // after — and a fenced write stands or falls on the fence alone.
  it('leaves the run\'s epoch and the ticket\'s fence exactly as it found them', async () => {
    const runId = await runIn();
    await pool.query(
      `INSERT INTO ticket_epoch (ticket_id, epoch) VALUES ('T-1', 5)
       ON CONFLICT (ticket_id) DO UPDATE SET epoch = 5`,
    );
    await takeHold(pool, { runId, reviewer: 'anna@example.test', lapseMs: LAPSE_MS });
    expect(await releaseHold(pool, { runId, reviewer: 'anna@example.test', kind: 'release' }))
      .toEqual({ outcome: 'released' });

    const run = await pool.query('SELECT epoch, state FROM run WHERE run_id = $1', [runId]);
    expect(run.rows[0]).toMatchObject({ state: 'awaiting_approval' });
    expect(BigInt(run.rows[0]!.epoch as string)).toBe(1n);
    const fence = await pool.query('SELECT epoch FROM ticket_epoch WHERE ticket_id = $1', ['T-1']);
    expect(BigInt(fence.rows[0]!.epoch as string)).toBe(5n);
  });

  // Criterion 7. Every way a hold begins and ends is a row in the history,
  // with the reviewer and the time. Every kind on one case, in order: a take,
  // a takeover, a deliberate release, a send, a close, and a lapse.
  it('records every kind in order, each with its reviewer and time', async () => {
    const runId = await runIn();
    await takeHold(pool, { runId, reviewer: 'anna@example.test', lapseMs: LAPSE_MS });
    await takeHold(pool, { runId, reviewer: 'bo@example.test', lapseMs: LAPSE_MS, force: true });
    expect(await releaseHold(pool, { runId, reviewer: 'bo@example.test', kind: 'release' }))
      .toEqual({ outcome: 'released' });

    // The send, in the caller's transaction — the path an approval takes.
    await takeHold(pool, { runId, reviewer: 'bo@example.test', lapseMs: LAPSE_MS });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      expect(await releaseHoldIn(client, { runId, reviewer: 'bo@example.test', kind: 'send' }))
        .toEqual({ outcome: 'released' });
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    // The close (DEC-48), which is the same in-transaction shape as a send
    // and its own word: a case finished with no reply sends nothing.
    await takeHold(pool, { runId, reviewer: 'anna@example.test', lapseMs: LAPSE_MS });
    const closing = await pool.connect();
    try {
      await closing.query('BEGIN');
      expect(await releaseHoldIn(closing, { runId, reviewer: 'anna@example.test', kind: 'close' }))
        .toEqual({ outcome: 'released' });
      await closing.query('COMMIT');
    } finally {
      closing.release();
    }

    // And a lapse nobody acted on, cleared by the next read of the case.
    await takeHold(pool, { runId, reviewer: 'anna@example.test', lapseMs: LAPSE_MS });
    await pool.query('UPDATE case_hold SET lapses_at = now() WHERE run_id = $1', [runId]);
    expect(await readHold(pool, runId)).toBeNull();

    const history = await holdHistory(pool, runId);
    expect(history.map((event) => [event.kind, event.reviewer, event.fromReviewer])).toEqual([
      ['take', 'anna@example.test', null],
      ['handover', 'bo@example.test', 'anna@example.test'],
      ['release', 'bo@example.test', null],
      ['take', 'bo@example.test', null],
      ['send', 'bo@example.test', null],
      ['take', 'anna@example.test', null],
      ['close', 'anna@example.test', null],
      ['take', 'anna@example.test', null],
      ['lapse', 'anna@example.test', null],
    ]);
    // Every event is stamped, and the order is the order they happened. Two
    // events can share a microsecond, so this reads non-decreasing.
    const times = history.map((event) => event.at.getTime());
    expect(times.some((time) => Number.isNaN(time))).toBe(false);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  // Criterion 3: a release is the holder's own. Somebody else's is refused,
  // the holder keeps the case, and nothing is written to the history.
  it('refuses a release by a reviewer who does not hold the case', async () => {
    const runId = await runIn();
    await takeHold(pool, { runId, reviewer: 'anna@example.test', lapseMs: LAPSE_MS });

    const refused = await releaseHold(pool, { runId, reviewer: 'bo@example.test', kind: 'release' });
    expect(refused.outcome).toBe('held_by_other');
    if (refused.outcome !== 'held_by_other') return;
    expect(refused.holder.reviewer).toBe('anna@example.test');
    expect((await readHold(pool, runId))?.reviewer).toBe('anna@example.test');
    expect((await holdHistory(pool, runId)).map((event) => event.kind)).toEqual(['take']);
  });

  // A release of a hold that has run out releases nothing: the case is free
  // already. The lapse is still recorded, by the call that noticed it.
  it('answers not_held for a hold that has lapsed, and records the lapse', async () => {
    const runId = await runIn();
    await takeHold(pool, { runId, reviewer: 'anna@example.test', lapseMs: LAPSE_MS });
    await pool.query('UPDATE case_hold SET lapses_at = now() WHERE run_id = $1', [runId]);

    expect(await releaseHold(pool, { runId, reviewer: 'anna@example.test', kind: 'release' }))
      .toEqual({ outcome: 'not_held' });
    expect((await holdHistory(pool, runId)).map((event) => event.kind)).toEqual(['take', 'lapse']);
  });

  it('answers not_held when a release finds no hold at all', async () => {
    const runId = await runIn();
    expect(await releaseHold(pool, { runId, reviewer: 'anna@example.test', kind: 'release' }))
      .toEqual({ outcome: 'not_held' });
    expect(await holdHistory(pool, runId)).toEqual([]);
  });

  // Criterion 4, risk row "Queue query count". The queue holds hundreds of
  // rows and reads every hold in one statement: a read per row put 476
  // statements behind one page.
  it('reads every hold for a list of runs in one statement', async () => {
    const runs: string[] = [];
    for (let i = 0; i < 40; i += 1) runs.push(await runIn());
    await takeHold(pool, { runId: runs[0]!, reviewer: 'anna@example.test', lapseMs: LAPSE_MS });
    await takeHold(pool, { runId: runs[1]!, reviewer: 'bo@example.test', lapseMs: LAPSE_MS });

    let statements = 0;
    const counted = {
      query: (...args: unknown[]) => {
        statements += 1;
        return (pool.query as (...a: unknown[]) => unknown)(...args);
      },
    };
    const holds = await readHolds(counted as never, runs);
    expect(statements).toBe(1);
    expect(holds.get(runs[0]!)?.reviewer).toBe('anna@example.test');
    expect(holds.get(runs[1]!)?.reviewer).toBe('bo@example.test');
    expect(holds.size).toBe(2);
  });

  afterAll(async () => {
    await readers.end();
    await pool.end();
  });
});
