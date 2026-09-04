/**
 * Writes a planned history through the real ledger path (issue #23).
 *
 * Every run goes in through `fencedInsert` with an explicit clock, so it
 * takes the same epoch check, the same transaction boundary and the same
 * journal writes a live run takes. The rows a report then describes are rows
 * the system actually produced, which is the whole reason the clock seam
 * exists (issue #22).
 *
 * This module is the one place in `src/` that supplies a clock.
 * `src/ledger/clock-reachability.test.ts` names it as the single exception to
 * the rule that no shipped module may, and it keeps no exception at all for
 * the daemon closure — so a daemon that ever imported this file fails that
 * guard. The seeder may hold the clock; nothing a daemon reaches may.
 */
import type { Pool, PoolClient } from 'pg';

import { deriveIdemKey } from '../ledger/keys.js';
import {
  fencedInsert,
  type FencedOutboxInput,
  type FencedRunInput,
} from '../ledger/insert.js';
import type { PlannedRun } from './plan.js';

/** How many runs landed, and how many the ledger refused. */
export interface WriteReport {
  accepted: number;
  refused: number;
}

/**
 * Writes one run: the ledger row, then the journal rows the readers need.
 *
 * The journal writes follow the accepted insert rather than sharing its
 * transaction. `fencedInsert` owns its own boundary (section 4.2 rule 1) and
 * widening it for a seeder would change the path this seeder exists to use
 * unchanged. A row without its journal is visible as a run that never
 * composed, which is a shape the readers already describe.
 */
async function writeJournal(client: PoolClient, run: PlannedRun): Promise<void> {
  // The status the coordinator writes: 'abstained' for an abstain, 'done'
  // otherwise. `bands` reads the result rather than the status here, but a
  // seeded row that disagreed with the coordinator would be a shape no
  // reader could trust.
  await client.query(
    `INSERT INTO step_journal (run_id, step_id, status, result, prompt_ver, model_ver, cost_micros)
     VALUES ($1, 'compose', $3, $2::jsonb, 'seed', 'seed', 0)`,
    [
      run.runId,
      JSON.stringify({ abstained: run.abstained, provider: run.provider }),
      run.abstained ? 'abstained' : 'done',
    ],
  );
  // No gate row for an abstain. The coordinator escalates before the gate
  // step starts, so the row would be a shape it never writes.
  if (run.reason !== null) {
    await client.query(
      `INSERT INTO step_journal (run_id, step_id, status, result, prompt_ver, model_ver, cost_micros)
       VALUES ($1, 'gate', 'done', $2::jsonb, 'seed', 'seed', 0)`,
      [run.runId, JSON.stringify({ reason: run.reason })],
    );
  }
  if (run.editDistance !== null) {
    await client.query('UPDATE run SET approval_edit_distance = $2 WHERE run_id = $1', [
      run.runId,
      run.editDistance,
    ]);
  }
}

/**
 * The outbox record an automatic write produces, if it produced one.
 *
 * Returned so `fencedInsert` commits it in the same transaction as the run
 * row (section 4.2 rule 1). It was written afterwards on a bare connection,
 * which put the state change and the outbox insert in different
 * transactions — the one thing that rule forbids.
 *
 * The key comes from the action's semantics, never from the run identity
 * (DEC-24; DEC-38 names the run id as the rejected alternative, and the
 * outbox column comment in db/001 states the rule verbatim).
 */
function outboxFor(run: PlannedRun): FencedOutboxInput | null {
  if (run.outbox.length === 0) return null;
  const payload = { note: 'synthetic' };
  // An internal class the automatic path really produces. 'reply' is not the
  // customer-reply class any adapter declares, so a reader of
  // outbox.action_class saw a class DEC-29 has no delivery rule for.
  const actionClass = 'route_ticket';
  return {
    stepId: 'execute',
    idemKey: deriveIdemKey({
      actionClass,
      ticketId: run.ticketId,
      conversationId: run.conversationId,
      turnNumber: 1,
      payload,
    }),
    actionClass,
    delivery: 'at_least_once',
    payload,
  };
}

/** Writes the whole plan, oldest run first. */
export async function writeHistory(pool: Pool, plan: readonly PlannedRun[]): Promise<WriteReport> {
  let accepted = 0;
  let refused = 0;
  for (const run of plan) {
    const input: FencedRunInput = {
      runId: run.runId,
      ticketId: run.ticketId,
      conversationId: run.conversationId,
      partition: run.partition,
      epoch: 1n,
      state: run.state,
      // Named 'seed' so a reader can tell a seeded run from a produced one.
      //
      // Only `pnpm run escalations` surfaces it, and it does so because this
      // seeder exists: that report selects `escalated` and
      // `awaiting_approval`, which is most of a seeded history, and it showed
      // no pin at all. `pnpm run bands` and `pnpm run latency` still cannot
      // tell, which the intent file states as a residual risk.
      //
      // The latency reader keys `never_ran` on both pins reading 'intake',
      // which this is not, so a seeded run still contributes its service time.
      promptVer: 'seed',
      modelVer: 'seed',
      deadlineAt: new Date(run.createdAt.getTime() + 300_000),
      enqueuedAt: run.enqueuedAt,
    };
    let result;
    try {
      result = await fencedInsert(pool, input, outboxFor(run), {
        createdAt: run.createdAt,
        // Only for a state that has finished. `awaiting_approval` is waiting
        // for a person, and the clock seam refuses a finish for it.
        ...(run.finishedAt === null ? {} : { finishedAt: run.finishedAt }),
      });
    } catch (error) {
      // A duplicate primary key means this exact history is already in the
      // ledger. That is reproducibility working — one seed and one day always
      // give the same run ids — and it is a refusal, not a fault. Named,
      // because the raw driver error is a stack trace about nbtinsert.c.
      if ((error as { code?: string }).code === '23505') {
        throw new Error(
          `seed-history: the ledger already holds run ${run.runId}. This seed and`
            + ' these days were written before; truncate the ledger or choose'
            + ' another seed or another window.',
        );
      }
      throw error;
    }
    if (result.outcome !== 'accepted') {
      refused += 1;
      continue;
    }
    accepted += 1;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await writeJournal(client, run);
      // The relay writes 'pending' and then marks a delivery it cannot
      // confirm (DEC-30). So the seeded row takes the same two steps rather
      // than being born unknown, which is a state the relay never writes.
      for (const status of run.outbox) {
        await client.query('UPDATE outbox SET status = $2 WHERE run_id = $1', [
          run.runId,
          status,
        ]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  return { accepted, refused };
}
