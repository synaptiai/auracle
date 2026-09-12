// A step runs, and answers, without a database (issue #75).
//
// The objective this suite exists for. `coordinateTicket` used to be one
// function, so reaching the gate branch needed a pool, a provider and an
// egress adapter — and `coordinator.db.test.ts` grew to 1,075 lines because
// there was no smaller thing to call. Every case here drives a real step
// module with a recording stub for the ledger.
//
// The stub answers statements; it does not implement the ledger. A case
// that would need the ledger to behave belongs in a `.db.test.ts` file, and
// the two cases below that reach a transition assert the refusal the stub
// produces rather than pretending it accepted.
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import type { Pool } from 'pg';

import type { EgressAdapter } from '../../adapters/types.js';
import { UnreadableAnswerError } from '../../models/provider.js';
import type { ModelProvider } from '../../models/provider.js';
import { PermanentEgressError } from '../../adapters/types.js';
import { classify } from './classify.js';
import { compose } from './compose.js';
import {
  createRunContext, meterProvider, stopEscalated, type RunContext,
} from './context.js';
import { execute } from './execute.js';
import { gate } from './gate.js';
import { park } from './park.js';
import { retrieve } from './retrieve.js';
import type { CoordinateInput, CoordinatorDeps } from '../types.js';

const STEPS_DIR = fileURLToPath(new URL('.', import.meta.url));

/**
 * One thing a step did, in the order it did it.
 *
 * The bind parameters are kept, not only the statement. The first version
 * of this recorder discarded them and kept the first line of the SQL, so a
 * mutation that wrote `cost_micros: 0` on every journal row and a mutation
 * that moved the escalate transition ahead of its journal writes both left
 * the suite green. What a row says is half of what a step does.
 *
 * An egress call is an entry too, so a case can assert that the ledger
 * wrote before the adapter acted (DEC-11).
 */
type Entry =
  | { kind: 'sql'; statement: string; values: readonly unknown[] }
  | { kind: 'egress'; call: string };

interface Recorder {
  entries: Entry[];
  /** Just the statements, for a case that only cares about order. */
  statements: () => string[];
  pool: Pool;
}

/**
 * A pool that records and answers nothing.
 *
 * `connect` hands back a client whose every read is empty, which is what
 * `fencedTransition` reads as `unknown_run`. A step that reaches a
 * transition therefore throws, and the case says so: the alternative is a
 * stub that pretends the ledger accepted a write it never saw.
 */
function recordingPool(entries: Entry[] = []): Recorder {
  const record = (text: string, values?: readonly unknown[]) => {
    entries.push({
      kind: 'sql',
      statement: text.trim().split('\n')[0]!.trim(),
      values: values ?? [],
    });
    return Promise.resolve({ rows: [] });
  };
  const client = { query: record, release: () => undefined };
  const pool = { query: record, connect: () => Promise.resolve(client) };
  return {
    entries,
    statements: () => entries.flatMap((e) => (e.kind === 'sql' ? [e.statement] : [])),
    pool: pool as unknown as Pool,
  };
}

/** An egress that records the call and then fails the way the case wants. */
function recordingEgress(entries: Entry[], fail: Error | null): EgressAdapter {
  return {
    createDraft: (): Promise<{ readonly draftExternalId: string }> => {
      entries.push({ kind: 'egress', call: 'createDraft' });
      if (fail !== null) return Promise.reject(fail);
      return Promise.resolve({ draftExternalId: 'DRAFT-1' });
    },
  } as unknown as EgressAdapter;
}

/** A provider whose every chat call fails to read (DEC-25, DEC-30). */
function unreadableProvider(shape: string, costMicros = 0): ModelProvider {
  return {
    complete: () => Promise.reject(new UnreadableAnswerError('unreadable', shape, costMicros)),
    embed: () => Promise.reject(new Error('the cases here make no embedding call')),
  };
}

const TAXONOMY = { intents: [{ id: 'refund', label: 'Refund', risk_tier: 'high' as const }] };

function context(
  pool: Pool,
  provider: ModelProvider,
  overrides: {
    deps?: Partial<CoordinatorDeps>;
    input?: Partial<CoordinateInput>;
  } = {},
): RunContext {
  const deps = {
    pool,
    provider,
    taxonomy: TAXONOMY,
    capabilities: { supportsIdempotencyKey: true, supportsReadBack: true, supportsDrafts: true },
    egress: {} as EgressAdapter,
    pins: { promptVer: 'p1', modelVer: 'm1' },
    limits: {
      maxCostMicros: 1_000_000,
      maxSteps: 20,
      deadlineAt: new Date(Date.now() + 60_000),
    },
    partitionCount: 8,
    ...overrides.deps,
  } as CoordinatorDeps;
  const input: CoordinateInput = {
    ticketId: 'T-1',
    ticketText: 'where is my refund',
    epoch: 1n,
    actionClass: 'route_ticket',
    actionPayload: {},
    delivery: 'at_most_once',
    isCustomerVisible: false,
    disclosure: 'drafted by an automated assistant',
    ...overrides.input,
  };
  return createRunContext(deps, input, 'run-1', meterProvider(provider));
}

describe('a step answers without a ledger behind it', () => {
  it('escalates a classification nobody could read, and journals the spend', async () => {
    const recorder = recordingPool();
    const ctx = context(recorder.pool, unreadableProvider('truncated', 700));

    const result = await classify(ctx);

    expect(result).toEqual({ kind: 'escalate', reason: 'classifier_unreadable' });
    // Write before act, then the outcome on the same row. Nine samples were
    // refused and the meter counted every one (DEC-25).
    expect(recorder.statements()[0]).toContain('INSERT INTO step_journal');
    expect(recorder.statements()[1]).toContain('UPDATE step_journal');
    expect(ctx.meter.cost()).toBe(9 * 700);
    expect(ctx.progress.stepsUsed).toBe(1);
    // It stopped before the transition: the escalate row is the sequencer's
    // to write, and this step never reached the ledger at all.
    expect(recorder.statements().some((s) => s.startsWith('BEGIN'))).toBe(false);
  });

  it('names a taxonomy fault by its own reason, not as an answer-budget fault', async () => {
    const recorder = recordingPool();
    const ctx = context(recorder.pool, unreadableProvider('no-label'));

    expect(await classify(ctx)).toEqual({ kind: 'escalate', reason: 'classifier_no_label' });
  });

  it('escalates an expired clock before it spends anything', async () => {
    const recorder = recordingPool();
    const ctx = context(recorder.pool, unreadableProvider('truncated'), {
      deps: {
        limits: { maxCostMicros: 1_000_000, maxSteps: 20, deadlineAt: new Date(Date.now() - 1) },
      },
    });

    expect(await classify(ctx)).toEqual({ kind: 'escalate', reason: 'limit_clock' });
    expect(await execute(ctx)).toEqual({ kind: 'escalate', reason: 'limit_clock' });
    // Not one statement, and not one model call. The check comes before the
    // write-before-act row, so a run that stopped on a limit carries no
    // journal row for the step it never ran.
    expect(recorder.statements()).toEqual([]);
    expect(ctx.meter.cost()).toBe(0);
  });

  // The asymmetry, as behaviour. Park runs after the reply is composed and
  // the money is spent; stopping here would leave a person with no draft to
  // approve and a run that paid for one. A future edit that folds the limit
  // check into the sequencer fails this case.
  it('parks a composed reply even when every limit is exhausted', async () => {
    const recorder = recordingPool();
    const ctx = context(recorder.pool, unreadableProvider('truncated'), {
      deps: { limits: { maxCostMicros: 0, maxSteps: 0, deadlineAt: new Date(Date.now() - 1) } },
    });
    ctx.state.draft = 'Your refund is on its way.';

    // The stub answers no row, which `fencedTransition` reads as a run that
    // is not there. So the step throws at the transition — and that is the
    // point: it got that far rather than escalating on the limits.
    await expect(park(ctx)).rejects.toThrow('transition target vanished from the ledger');
    expect(recorder.statements()[0]).toContain('INSERT INTO step_journal');
    const finish = recorder.statements()[1];
    expect(finish).toContain('UPDATE step_journal');
    expect(ctx.progress.stepsUsed).toBe(1);
  });

  // DEC-11, the branch the whole step exists for, and the one nothing drove
  // before. `createDraft` reaches the customer's helpdesk before the ledger
  // can record what it made, so the 'parking' row is written FIRST and is
  // the crash marker `priorParkUnresolved` reads to refuse a second draft.
  //
  // Deleting that ordering left every suite green: `coordinator.db.test.ts`
  // inserts a 'parking' row by hand to test detection, and nothing drove the
  // egress at all. So the assertion is on the order of the two recorded
  // events, not on either one alone.
  it('records the parking marker before it reaches the customer (DEC-11)', async () => {
    const entries: Entry[] = [];
    const recorder = recordingPool(entries);
    const ctx = context(recorder.pool, unreadableProvider('truncated'), {
      deps: { egress: recordingEgress(entries, new PermanentEgressError('no such recipient')) },
      input: { isCustomerVisible: true },
    });
    ctx.state.draft = 'Your refund is on its way.';

    // A permanent refusal must not go round the retry loop: the queue's
    // attempt ceiling is sized for a transient fault.
    expect(await park(ctx)).toEqual({ kind: 'escalate', reason: 'egress_refused' });

    const kinds = entries.map((entry) => (entry.kind === 'egress' ? 'createDraft' : entry.statement));
    const parking = kinds.findIndex((k) => k.startsWith('UPDATE step_journal'));
    const draft = kinds.indexOf('createDraft');
    expect(parking, 'no journal finish was recorded before the egress').toBeGreaterThanOrEqual(0);
    expect(draft, 'the egress was never called').toBeGreaterThanOrEqual(0);
    expect(parking, 'the draft reached the customer before the ledger named it').toBeLessThan(draft);

    // The marker says 'parking', and the seen throw replaces it with
    // 'failed'. Leaving it standing would poison the ticket: every later run
    // escalates park_unresolved with no draft anywhere to reconcile.
    const statuses = entries
      .filter((entry) => entry.kind === 'sql' && entry.statement.startsWith('UPDATE step_journal'))
      .map((entry) => (entry as { values: readonly unknown[] }).values[2]);
    expect(statuses).toEqual(['parking', 'failed']);
  });

  // The cost on the row, which the recorder could not see before. Every
  // journal write carries the run's spend at the moment it was written
  // (DEC-25); writing a constant there left the whole suite green.
  it('writes the metered spend onto each journal row (DEC-25)', async () => {
    const entries: Entry[] = [];
    const recorder = recordingPool(entries);
    const ctx = context(recorder.pool, unreadableProvider('truncated', 700));

    await classify(ctx);

    const costs = entries
      .filter((entry) => entry.kind === 'sql')
      .map((entry) => (entry as { statement: string; values: readonly unknown[] }))
      .filter((entry) => /step_journal/.test(entry.statement))
      .map((entry) => entry.values[entry.statement.startsWith('INSERT') ? 6 : 4]);
    // The start row is written before the calls, the finish row after all
    // nine. Both read the meter at the moment they run.
    expect(costs).toEqual([0, 9 * 700]);
  });

  // The escalate row is written BEFORE the transition, like every other step
  // (section 4.2). Swapping the two left the coordinator and escalations
  // suites green, because neither reads the order.
  it('journals the escalation before it moves the run (section 4.2)', async () => {
    const entries: Entry[] = [];
    const recorder = recordingPool(entries);
    const ctx = context(recorder.pool, unreadableProvider('truncated'));

    await expect(stopEscalated(ctx, 'limit_cost')).rejects
      .toThrow('transition target vanished from the ledger');

    const statements = recorder.statements();
    const insert = statements.findIndex((line) => line.startsWith('INSERT INTO step_journal'));
    const update = statements.findIndex((line) => line.startsWith('UPDATE step_journal'));
    const begin = statements.indexOf('BEGIN');
    expect(insert, 'the escalation was never journalled').toBeGreaterThanOrEqual(0);
    expect(update).toBeGreaterThan(insert);
    expect(begin, 'the run moved before its reason was journalled').toBeGreaterThan(update);
    // And the reason reaches the row, which is what `escalations/query.ts`
    // reads. A row with the right shape and the wrong reason names nothing.
    const reason = entries
      .filter((entry) => entry.kind === 'sql')
      .map((entry) => entry as { statement: string; values: readonly unknown[] })
      .find((entry) => entry.statement.startsWith('UPDATE step_journal'))?.values[3];
    expect(reason).toBe(JSON.stringify({ reason: 'limit_cost' }));
  });

});

/**
 * Which steps call the DEC-25 limit check, read from the source.
 *
 * A behavioural case can say park does not check; it cannot say the other
 * five still do without five more model stubs. This reads the call itself,
 * parsed rather than matched.
 */
function callsLimitHit(file: string): boolean {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.ESNext,
    true,
  );
  let found = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'limitHit'
    ) found = true;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('the walk', () => {
  const STEPS = ['classify', 'retrieve', 'compose', 'gate', 'park', 'execute'];

  it('has a module per step, each exporting the step', () => {
    const files = readdirSync(STEPS_DIR).filter((f) => f.endsWith('.ts') && !f.includes('.test.'));
    const exported: Record<string, (ctx: RunContext) => unknown> = {
      classify, retrieve, compose, gate, park, execute,
    };
    for (const step of STEPS) {
      expect(files, `${step}.ts is missing`).toContain(`${step}.ts`);
      expect(typeof exported[step], `${step}.ts does not export ${step}`).toBe('function');
      // One parameter: the context. A step that took its dependencies
      // separately would not be substitutable in the sequencer's list.
      expect(exported[step]!.length, `${step} does not take one context`).toBe(1);
    }
    // Every module in the directory is a step or the seam between them. A
    // seventh step added and left out of the sequencer's list would
    // otherwise be invisible here.
    expect(files.sort()).toEqual([...STEPS, 'context', 'digest'].map((n) => `${n}.ts`).sort());
  });

  // Every cross-step read goes through `stateAfter`, which turns "the step
  // that writes this did not run" into a named fault.
  //
  // The sequencer's own read of `decision` was the one exception, and it is
  // the one place where the silent default is dangerous: an unset decision
  // is not `'gated'`, so a bare comparison routes to `execute`, which
  // inserts the outbox record the relay then sends. An ungated customer
  // reply (DEC-12), with the gate row recording a verdict the run never
  // acted on.
  //
  // Structural, because the hazard is only observable when a step is
  // missing, and a suite cannot hold every future way of removing one.
  it('reads no step output without the guard that names its producer', () => {
    const files = [
      join(STEPS_DIR, '..', 'coordinator.ts'),
      ...STEPS.map((step) => join(STEPS_DIR, `${step}.ts`)),
    ];
    const bare: string[] = [];
    for (const file of files) {
      const source = ts.createSourceFile(
        file, readFileSync(file, 'utf8'), ts.ScriptTarget.ESNext, true,
      );
      const visit = (node: ts.Node): void => {
        // `ctx.state.x` on the right of nothing — a read, not a write. An
        // assignment's left side is the step recording its own output.
        if (
          ts.isPropertyAccessExpression(node)
          && ts.isPropertyAccessExpression(node.expression)
          && node.expression.name.text === 'state'
          && !(ts.isBinaryExpression(node.parent)
            && node.parent.left === node
            && node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken)
        ) {
          bare.push(`${basename(file)}: ${node.getText()}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(bare).toEqual([]);
  });

  it('checks the limits in every step but park', () => {
    const checks = Object.fromEntries(
      STEPS.map((step) => [step, callsLimitHit(join(STEPS_DIR, `${step}.ts`))]),
    );
    expect(checks).toEqual({
      classify: true,
      retrieve: true,
      compose: true,
      gate: true,
      park: false,
      execute: true,
    });
  });
});
