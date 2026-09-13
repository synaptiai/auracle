// The sequencer's fault exit, driven through `coordinateTicket` (issue #94).
//
// `steps.test.ts` drives each of the four invariant checks and asserts the
// class it raises. That is half the claim. The other half is what the walk
// does with one, and only a case that calls `coordinateTicket` can say: the
// catch is in the sequencer, and so is the `return await` the catch depends
// on. A review pass replaced both `return await` with `return` and left every
// suite green, because nothing here went through the sequencer at all.
//
// Pure, against a ledger stub that answers rather than refuses. The stub is
// not the ledger and makes no claim to be one — `coordinator.db.test.ts` owns
// the end-to-end case against Postgres, including the gate fault that reaches
// `escalated` and the row `pnpm run escalations` then names. What a stub can
// answer, and the database cannot be made to do on demand, is "this run row is
// gone": that is the one fault whose own recovery cannot succeed.
import { describe, expect, it } from 'vitest';

import type { Pool } from 'pg';

import { coordinateTicket } from './coordinator.js';
import { CoordinatorFaultError } from './fault.js';
import type { CoordinateInput, CoordinatorDeps } from './types.js';
import type { EgressAdapter } from '../adapters/types.js';
import type { ModelProvider } from '../models/provider.js';

/** One statement the run issued, with what it bound. */
interface Statement {
  text: string;
  values: readonly unknown[];
}

/**
 * A ledger that answers.
 *
 * `steps.test.ts` uses a recorder that answers nothing, which
 * `fencedTransition` reads as a run that is not there. That is the right stub
 * for a step, and the wrong one for the sequencer: every run would fault on
 * its first transition and no other path would ever run.
 *
 * So this one answers the row `fencedTransition` reads, and `runPresent`
 * decides whether it does. False is the ledger saying the run row is gone,
 * which is the precondition of the "transition target vanished" fault.
 */
function ledger(options: { runPresent: boolean }): {
  statements: Statement[];
  pool: Pool;
} {
  const statements: Statement[] = [];
  const answer = (text: string): unknown[] => {
    // The row `fencedTransition` locks before it moves a run. `epoch` matches
    // the input's, so the fence accepts; `finish_unordered` is null because no
    // caller here passes a clock.
    if (text.startsWith('SELECT ticket_id, epoch, state, created_at')) {
      return options.runPresent
        ? [{
            ticket_id: 'T-1',
            epoch: '1',
            state: 'received',
            created_at: new Date('2026-09-13T00:00:00.000Z'),
            finish_unordered: null,
          }]
        : [];
    }
    // No prior epoch for this ticket, so `fencedInsert` accepts the run.
    return [];
  };
  const query = (text: string, values?: readonly unknown[]) => {
    statements.push({ text: text.trim().split('\n')[0]!.trim(), values: values ?? [] });
    return Promise.resolve({ rows: answer(text.trim()), rowCount: 1 });
  };
  const client = { query, release: () => undefined };
  return {
    statements,
    pool: { query, connect: () => Promise.resolve(client) } as unknown as Pool,
  };
}

/** A provider whose every call fails the way the case wants. */
function failingProvider(error: Error): ModelProvider {
  return {
    complete: () => Promise.reject(error),
    embed: () => Promise.reject(error),
  };
}

function deps(pool: Pool, provider: ModelProvider, limits?: Partial<CoordinatorDeps['limits']>): CoordinatorDeps {
  return {
    pool,
    provider,
    taxonomy: { intents: [{ id: 'refund', label: 'Refund', risk_tier: 'high' }] },
    capabilities: {
      supportsIdempotencyKey: true, supportsReadBack: true, supportsDraftState: true,
      supportsStructuredFields: true, supportsThreading: true,
    },
    egress: {} as EgressAdapter,
    pins: { promptVer: 'p1', modelVer: 'm1' },
    limits: {
      maxCostMicros: 1_000_000,
      maxSteps: 20,
      deadlineAt: new Date(Date.now() + 60_000),
      ...limits,
    },
    partitionCount: 8,
  } as CoordinatorDeps;
}

const INPUT: CoordinateInput = {
  ticketId: 'T-1',
  ticketText: 'where is my refund',
  epoch: 1n,
  actionClass: 'route_ticket',
  actionPayload: {},
  delivery: 'at_most_once',
  isCustomerVisible: false,
  disclosure: 'drafted by an automated assistant',
};

/** The `escalate` journal rows a run wrote, in order, with their result. */
function escalateRows(statements: readonly Statement[]): { status: string; result: unknown }[] {
  return statements
    .filter((s) => /step_journal/.test(s.text) && s.values[1] === 'escalate')
    // Both statements bind status at 2 and result at 3: `journalInsertStatement`
    // and `journalFinishStatement` share one column order, which
    // `journal-statement.test.ts` pins.
    .map((s) => ({ status: String(s.values[2]), result: s.values[3] }));
}

describe('the walk ends on a fault', () => {
  // The fault whose recovery cannot succeed, and the reason the runbook says
  // so rather than promising a terminal state this system cannot reach.
  //
  // The run is past its deadline, so `classify` escalates on DEC-25 before any
  // model call. `finishStep` calls `stopEscalated`, whose transition reads no
  // run row and raises the fault. The sequencer catches it, tries to escalate,
  // and that transition addresses the same missing row — so it fails too.
  //
  // Three claims in one case. The fault reaches the catch at all, which is
  // what `return await` buys. The recovery's own failure does not replace the
  // invariant message. And the escalate row is still written, because
  // `step_journal` holds no foreign key to `run`.
  it('keeps the invariant message when the escalation itself fails', async () => {
    const led = ledger({ runPresent: false });
    const run = deps(led.pool, failingProvider(new Error('no call is made')), {
      deadlineAt: new Date(Date.now() - 1),
    });

    const thrown = await coordinateTicket(run, INPUT).then(
      (outcome) => ({ outcome }),
      (error: unknown) => ({ error }),
    );

    expect('error' in thrown, 'a run whose row is gone cannot reach a terminal state').toBe(true);
    const error = (thrown as { error: unknown }).error;
    expect(error).toBeInstanceOf(CoordinatorFaultError);
    // The invariant, not the ledger's complaint about the second attempt.
    expect((error as Error).message).toContain('transition target vanished from the ledger');
    // The second failure is kept rather than dropped. Without `return await`
    // the rejection leaves the try unread, no recovery runs, and nothing sets
    // this.
    expect((error as { cause?: unknown }).cause, 'the recovery failure was dropped').toBeInstanceOf(
      CoordinatorFaultError,
    );

    // Two escalate rows: the DEC-25 one the step chose, and the fault one the
    // sequencer wrote. Both reached the journal; neither reached a run row.
    const rows = escalateRows(led.statements);
    expect(rows.length, 'the escalation was never journalled').toBeGreaterThan(0);
    expect(JSON.stringify(rows)).toContain('limit_clock');
    expect(JSON.stringify(rows)).toContain('internal_fault');
  });

  // The boundary the design record rests on: a fault is caught, and nothing
  // else is. Widening the catch to `instanceof Error` turns every transient
  // failure into a permanent escalation and acks the message out of the queue,
  // which deletes the consumer's retry and abandonment floor.
  //
  // Both named suites stayed green on that mutation before this case existed.
  it('hands every other error to the caller, and journals no escalation', async () => {
    const led = ledger({ runPresent: true });
    const transient = new Error('ECONNRESET reading from the provider');
    const run = deps(led.pool, failingProvider(transient));

    await expect(coordinateTicket(run, INPUT)).rejects.toThrow(transient);

    // Not an escalation of any kind: the consumer's ceiling owns this one, and
    // an escalate row here would say a person has something to work on.
    expect(escalateRows(led.statements)).toEqual([]);
    expect(led.statements.some((s) => s.values.includes('escalated'))).toBe(false);
  });

  // And the ordinary path still ends where it did. A limit is not a fault: the
  // run escalates with its own reason and returns rather than throwing.
  it('escalates a limit with its own reason, not as a fault', async () => {
    const led = ledger({ runPresent: true });
    const run = deps(led.pool, failingProvider(new Error('no call is made')), {
      deadlineAt: new Date(Date.now() - 1),
    });

    const outcome = await coordinateTicket(run, INPUT);

    expect(outcome.outcome).toBe('escalated');
    if (outcome.outcome === 'escalated') expect(outcome.reason).toBe('limit_clock');
    expect(JSON.stringify(escalateRows(led.statements))).not.toContain('internal_fault');
  });
});
