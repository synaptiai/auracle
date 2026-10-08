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
import { CoordinatorFaultError } from '../fault.js';
import { classify } from './classify.js';
import { compose } from './compose.js';
import {
  CONTINUE, createRunContext, finishStep, meterProvider, stateAfter, stopEscalated,
  transitionOrStop, type RunContext,
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
function recordingPool(
  entries: Entry[] = [],
  /**
   * Rows for a read the case needs answered. Every statement still records;
   * this only decides what comes back. `park` refuses on the strength of a
   * SELECT, so a stub that answers nothing can never reach that branch.
   */
  answer: (statement: string) => unknown[] = () => [],
): Recorder {
  const record = (text: string, values?: readonly unknown[]) => {
    const statement = text.trim().split('\n')[0]!.trim();
    entries.push({ kind: 'sql', statement, values: values ?? [] });
    return Promise.resolve({ rows: answer(statement) });
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

  // The asymmetry, as behavior. Park runs after the reply is composed and
  // the money is spent; stopping here would leave a person with no draft to
  // approve and a run that paid for one. A future edit that folds the limit
  // check into the sequencer fails this case.
  it('parks a composed reply even when every limit is exhausted', async () => {
    // The pool answers the prior-park SELECT, so this case also holds the
    // branch guard shut: the ledger-only park never runs that check, and
    // dropping the guard would escalate this run instead of parking it.
    const recorder = recordingPool([], (statement) =>
      statement.startsWith('SELECT 1') ? [{ '?column?': 1 }] : []);
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
    // The marker is a fenced write (#122), so the run row and the fence it
    // reads are answered as a current lease.
    const recorder = recordingPool(entries, (statement) =>
      statement.startsWith('SELECT ticket_id, epoch, state')
        ? [{ ticket_id: 'T-1', epoch: '1', state: 'gated', created_at: new Date(), finish_unordered: false }]
        : statement.startsWith('SELECT epoch FROM ticket_epoch')
          ? [{ epoch: '1' }]
          : []);
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

  // The refusal comes before the journal row, because it refuses rather than
  // acts (issue #94). Journalling first left a 'park' row at status 'started'
  // with a null result forever on every refusal.
  //
  // The pool answers the SELECT this check reads. A stub that answers nothing
  // never reaches the branch at all, which is why nothing drove it before.
  // #122: the hand-back names a run the ledger then does not hold. That is a
  // fault in the ledger, not a refusal to word, so the walk throws it, and no
  // draft is asked for.
  it('throws a fault when the run it hands the turn back to is gone', async () => {
    const entries: Entry[] = [];
    const recorder = recordingPool(entries, (statement) =>
      statement.startsWith('SELECT r.run_id') ? [{ run_id: 'run-0' }] : []);
    const ctx = context(recorder.pool, unreadableProvider('truncated'), {
      deps: { egress: recordingEgress(entries, null) },
      input: { isCustomerVisible: true, conversationId: 'conv-1', turnNumber: 1 },
    });
    ctx.state.draft = 'Your refund is on its way.';

    await expect(park(ctx)).rejects.toThrow(CoordinatorFaultError);
    await expect(park(ctx)).rejects.toThrow('could not hand its turn back to run-0: unknown_run');
    expect(entries.some((entry) => entry.kind === 'egress')).toBe(false);
  });

  it('leaves no half-written row when it refuses to park (DEC-11)', async () => {
    const entries: Entry[] = [];
    const recorder = recordingPool(entries, (statement) =>
      statement.startsWith('SELECT 1') ? [{ '?column?': 1 }] : []);
    const ctx = context(recorder.pool, unreadableProvider('truncated'), {
      input: { isCustomerVisible: true },
    });
    ctx.state.draft = 'Your refund is on its way.';

    expect(await park(ctx)).toEqual({ kind: 'escalate', reason: 'park_unresolved' });

    // The SELECT ran, and nothing else did. Not the write-before-act row, so
    // no step_journal statement of any kind.
    expect(recorder.statements().filter((line) => /step_journal/.test(line))).toEqual([]);
    expect(entries.some((entry) => entry.kind === 'egress')).toBe(false);
    expect(ctx.progress.stepsUsed).toBe(0);
  });

});

/**
 * A defect inside the walk ends the run where an operator reads it (#94).
 *
 * Four checks assert an invariant this system owns. Each threw a plain
 * `Error` and escaped `coordinateTicket`, so the run kept whatever state it
 * last reached and journalled nothing — and `src/escalations/query.ts` reads
 * its reason from an `escalate` row. The class is what the sequencer catches,
 * so each site is driven here and the class is asserted, not the message.
 */
describe('a fault inside the walk', () => {
  it('names the producer when a step ran before the step it reads', () => {
    expect(() => stateAfter({}, 'classification', 'gate', 'classify'))
      .toThrow(CoordinatorFaultError);
    expect(() => stateAfter({}, 'classification', 'gate', 'classify'))
      .toThrow('gate ran before classify: the run has no classification');
  });

  it('raises a fault when the transition addresses a run the ledger lost', async () => {
    const recorder = recordingPool();
    const ctx = context(recorder.pool, unreadableProvider('truncated'));

    // The stub answers no row, which `fencedTransition` reads as a run that
    // is not there.
    await expect(transitionOrStop(ctx, 'classified')).rejects
      .toThrow(CoordinatorFaultError);
  });

  it('raises a fault when the gate meets an intent the taxonomy lost', async () => {
    const entries: Entry[] = [];
    const recorder = recordingPool(entries);
    const ctx = context(recorder.pool, unreadableProvider('truncated'));
    // `classify` refuses a label the taxonomy does not hold, so this state is
    // only reachable when the taxonomy gated against is not the one
    // classified against.
    ctx.state.classification = {
      intentId: 'chargeback', agreement: 1, unreadableSamples: 0,
    } as NonNullable<RunContext['state']['classification']>;
    // No retrieved text, so the judge makes no model call and the run reaches
    // the taxonomy lookup on the stub alone.
    ctx.state.docs = [];
    ctx.state.composed = {
      claims: [{ text: 'Your refund is on its way.', citations: [] }],
    } as unknown as NonNullable<RunContext['state']['composed']>;

    await expect(gate(ctx)).rejects.toThrow(CoordinatorFaultError);
    await expect(gate(ctx)).rejects
      .toThrow('classified intent chargeback is absent from the taxonomy');

    // And it refuses before it journals, like `park` does. Below the
    // write-before-act row this left a 'gate' row at status 'started' with a
    // null result forever — the shape this issue removes — and paid for a
    // coverage judge on a run certain to fault (issue #94).
    expect(recorder.statements().filter((line) => /step_journal/.test(line))).toEqual([]);
    expect(entries.some((entry) => entry.kind === 'egress')).toBe(false);
    expect(ctx.progress.stepsUsed).toBe(0);
    expect(ctx.meter.cost()).toBe(0);
  });

  it('raises a fault when a final step asks the walk to go on', async () => {
    const recorder = recordingPool();
    const ctx = context(recorder.pool, unreadableProvider('truncated'));

    await expect(finishStep(ctx, CONTINUE)).rejects.toThrow(CoordinatorFaultError);
    await expect(finishStep(ctx, CONTINUE)).rejects
      .toThrow("a final step of run run-1 answered 'continue'");
  });

  // The row an operator reads. `internal_fault` names a defect and not a
  // step, so the message rides beside the reason — and `reason` is written
  // last, so a detail key of that name cannot displace it.
  it('journals the fault message beside the reason', async () => {
    const entries: Entry[] = [];
    const recorder = recordingPool(entries);
    const ctx = context(recorder.pool, unreadableProvider('truncated'));

    await expect(
      stopEscalated(ctx, 'internal_fault', { fault: 'gate ran before classify', reason: 'wrong' }),
    ).rejects.toThrow('transition target vanished from the ledger');

    const result = entries
      .filter((entry) => entry.kind === 'sql')
      .map((entry) => entry as { statement: string; values: readonly unknown[] })
      .find((entry) => entry.statement.startsWith('UPDATE step_journal'))?.values[3];
    expect(result).toBe(
      JSON.stringify({ fault: 'gate ran before classify', reason: 'internal_fault' }),
    );
  });

  // Structural, because the hazard is a check added later. A fifth invariant
  // written as a bare `Error` escapes the sequencer's catch and puts the run
  // back where this issue found it, with every suite green.
  //
  // The first version asked for a `throw` of a `new Identifier(...)`, which is
  // a regex with a parser behind it. An adversarial pass walked four ordinary
  // spellings straight through it — `throw held`, `throw make(msg)`,
  // `throw new globalThis.Error(msg)` and `Promise.reject(new Error(msg))` —
  // with the suite green on each. The repository's rule is to parse source
  // rather than pattern-match it, and parsing the wrong shape is still
  // matching. So this asks two questions instead.
  //
  // One: every `new <name>Error(...)` in these modules is a
  // `CoordinatorFaultError`. That covers a built Error thrown later, one
  // returned by a helper, one reached through `globalThis`, and one handed to
  // `Promise.reject` — none of which is a throw statement at the site.
  //
  // Two: every `throw` raises either a `new CoordinatorFaultError(...)` or the
  // binding of an enclosing `catch`. The second is a rethrow, which `park` and
  // three other steps do for an error they decided not to own.
  //
  // The file list is read from the directory, not typed out. A hand-kept list
  // omitted `digest.ts`, which is a module of the walk that `retrieve.ts`
  // imports, so a new file under `steps/` was unguarded by default.
  it('raises no bare Error from any module of the walk', () => {
    const files = [
      join(STEPS_DIR, '..', 'coordinator.ts'),
      join(STEPS_DIR, '..', 'fault.ts'),
      ...readdirSync(STEPS_DIR)
        .filter((f) => f.endsWith('.ts') && !f.includes('.test.'))
        .map((f) => join(STEPS_DIR, f)),
    ];
    // The scan found the modules. Without this it passes when the directory
    // moves and nothing is read at all.
    expect(files.length, 'no module of the walk was scanned').toBeGreaterThan(8);

    const bare: string[] = [];
    /** The `catch (x)` bindings in scope at this node, innermost last. */
    const rethrows = (node: ts.Node): string[] => {
      const names: string[] = [];
      for (let at: ts.Node | undefined = node; at !== undefined; at = at.parent) {
        if (ts.isCatchClause(at) && at.variableDeclaration !== undefined) {
          const name = at.variableDeclaration.name;
          if (ts.isIdentifier(name)) names.push(name.text);
        }
      }
      return names;
    };
    const errorName = (node: ts.NewExpression): string =>
      ts.isIdentifier(node.expression)
        ? node.expression.text
        : node.expression.getText().split('.').pop() ?? node.expression.getText();

    for (const file of files) {
      const source = ts.createSourceFile(
        file, readFileSync(file, 'utf8'), ts.ScriptTarget.ESNext, true,
      );
      const visit = (node: ts.Node): void => {
        // Every Error built here, wherever it goes next.
        if (ts.isNewExpression(node) && /Error$/.test(errorName(node))
          && errorName(node) !== 'CoordinatorFaultError') {
          bare.push(`${basename(file)}: new ${errorName(node)}`);
        }
        // Every throw, whatever it raises.
        if (ts.isThrowStatement(node) && node.expression !== undefined) {
          const raised = node.expression;
          const isFault = ts.isNewExpression(raised)
            && errorName(raised) === 'CoordinatorFaultError';
          const isRethrow = ts.isIdentifier(raised)
            && rethrows(node).includes(raised.text);
          if (!isFault && !isRethrow) {
            bare.push(`${basename(file)}: throw ${raised.getText().split('(')[0]}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    // The delivery-rule refusal in `coordinateTicket` is the one exception,
    // and it is not in the walk: it runs before the run row exists, so there
    // is nothing to journal a reason against and nothing to move to a
    // terminal state. It is a caller defect, refused to the caller. It appears
    // twice because both questions above see it.
    expect(bare.sort()).toEqual([
      'coordinator.ts: new Error',
      'coordinator.ts: throw new Error',
    ]);
  });
});

/**
 * Which steps call the DEC-25 limit check, read from the source.
 *
 * A behavioral case can say park does not check; it cannot say the other
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
