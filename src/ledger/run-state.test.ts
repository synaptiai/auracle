// The one predicate the three fence callers read (issue #113, DEC-28).
//
// The consumer's claim, the ledger's transition and the relay's send all ask
// the same question — is this run still in flight, or has it left a
// consumer's hands? The answer lives in one place, because two copies of a
// state list drift, and the drift is silent.
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { RUN_STATES } from '../coordinator/types.js';
import {
  IN_FLIGHT_RUN_STATES,
  PARKED_RUN_STATES,
  TERMINAL_RUN_STATE_NAMES,
  runStateClass,
} from './run-state.js';

describe('what a run state means to the fence', () => {
  it('reads every active state as in flight except the one that waits for a person', () => {
    const classes = RUN_STATES.map((state) => [state, runStateClass(state)] as const);
    expect(classes.filter(([, cls]) => cls === 'parked').map(([state]) => state))
      .toEqual(['awaiting_approval']);
    expect(classes.filter(([, cls]) => cls === 'in_flight').map(([state]) => state))
      .toEqual([...IN_FLIGHT_RUN_STATES]);
    expect(PARKED_RUN_STATES).toEqual(['awaiting_approval']);
    expect(IN_FLIGHT_RUN_STATES).not.toContain('awaiting_approval');
  });

  it('reads the four terminal states as terminal', () => {
    expect(TERMINAL_RUN_STATE_NAMES)
      .toEqual(['resolved', 'escalated', 'superseded', 'abandoned']);
    for (const state of TERMINAL_RUN_STATE_NAMES) {
      expect(runStateClass(state), state).toBe('terminal');
    }
  });

  it('reads a state outside the vocabulary as in flight, so the fence still governs it', () => {
    // The ledger suites seed a run in 'queued' and require the epoch check to
    // keep refusing it (src/ledger/clock.db.test.ts). A value this module does
    // not recognise is not a licence to write.
    expect(runStateClass('queued')).toBe('in_flight');
    expect(runStateClass('')).toBe('in_flight');
    expect(runStateClass('RESOLVED')).toBe('in_flight');
  });

  it('names the same terminal set the ledger stamps a finish time for', () => {
    // Parsed, not pattern-matched: a type argument, a `satisfies` or a named
    // array would each read as a different set to a regular expression, and
    // the ledger is free to spell its declaration any of those ways.
    expect([...TERMINAL_RUN_STATE_NAMES].sort()).toEqual(ledgerTerminalStates().sort());
  });
});

/** The names in `insert.ts`'s `TERMINAL_RUN_STATES` set, from its syntax. */
function ledgerTerminalStates(): string[] {
  const source = readFileSync(new URL('./insert.ts', import.meta.url), 'utf8');
  const file = ts.createSourceFile('insert.ts', source, ts.ScriptTarget.Latest, true);
  let names: string[] | null = null;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        if (declaration.name.text !== 'TERMINAL_RUN_STATES') continue;
        const initializer = declaration.initializer;
        if (initializer === undefined || !ts.isNewExpression(initializer)) continue;
        const argument = (initializer.arguments ?? ts.factory.createNodeArray())[0];
        if (argument === undefined || !ts.isArrayLiteralExpression(argument)) continue;
        names = argument.elements.filter(ts.isStringLiteral).map((element) => element.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  expect(names, 'the ledger declares no TERMINAL_RUN_STATES set of string literals')
    .not.toBeNull();
  return names!;
}
