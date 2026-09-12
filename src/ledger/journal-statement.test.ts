// What the one step_journal statement may and may not name (issue #75).
//
// Four modules wrote this table with three different column lists. One list
// exists now, and this suite is what keeps it one: a column added to
// `JOURNAL_COLUMNS` without a value pushed beside it in `journal-write.ts`
// fails here, so its author has to open both.
//
// The same standard `clock-statement.test.ts` holds `runInsertStatement` to,
// for the same reason: counting placeholders proves nothing on its own,
// because the builder derives them from the list it is being checked against.
import { describe, expect, it } from 'vitest';

import {
  JOURNAL_COLUMNS,
  journalFinishStatement,
  journalInsertStatement,
} from './journal-write.js';

const INSERT = journalInsertStatement();
const IF_ABSENT = journalInsertStatement(true);

function columnsOf(statement: string): string[] {
  return (/INSERT INTO step_journal \(([^)]*)\)/.exec(statement)?.[1] ?? '')
    .split(',')
    .map((column) => column.trim())
    .filter((column) => column.length > 0);
}

describe('the step_journal insert statement', () => {
  it('names exactly these columns, in this order', () => {
    expect(columnsOf(INSERT)).toEqual([
      'run_id', 'step_id', 'status', 'result', 'prompt_ver', 'model_ver', 'cost_micros',
    ]);
  });

  it('binds one placeholder per column and no more', () => {
    const count = JOURNAL_COLUMNS.length;
    expect(INSERT).toContain(`$${count}`);
    expect(INSERT).not.toContain(`$${count + 1}`);
  });

  // The jsonb cast belongs to `result` and to nothing else.
  //
  // Not because the write fails without it — the statement this replaced
  // was `SET result = $4` with no cast and ran in production, because
  // Postgres coerces an unknown-typed parameter in assignment context. It
  // states the parameter's type at the call site, so the one column holding
  // JSON says so, and a cast on any other column would refuse a value that
  // is not JSON.
  it('casts the result column and no other', () => {
    expect(INSERT).toContain(`$${JOURNAL_COLUMNS.indexOf('result') + 1}::jsonb`);
    expect(INSERT.match(/::jsonb/g)).toHaveLength(1);
  });

  // The relay's clause, and the relay's alone. It journals one `escalate`
  // row per run and a repeat must keep the first reason rather than raise a
  // duplicate key. A coordinator step that wrote twice is a defect, so the
  // default form still raises.
  it('is silent about a repeat only when the caller asks', () => {
    expect(INSERT).not.toContain('ON CONFLICT');
    expect(IF_ABSENT).toContain('ON CONFLICT (run_id, step_id) DO NOTHING');
  });

  it('is the plain form plus the clause, with the same columns', () => {
    expect(columnsOf(IF_ABSENT)).toEqual(columnsOf(INSERT));
  });
});

describe('the step_journal finish statement', () => {
  // The non-goal, stated as a case. An outcome changes what the step
  // produced; it must not restate the pins it ran under (DEC-26), and it
  // must not move the row to another run.
  it('sets the three columns an outcome changes, and no others', () => {
    const assignments = (/SET (.*?) WHERE/.exec(journalFinishStatement())?.[1] ?? '')
      .split(',')
      .map((part) => part.trim().split(/\s*=\s*/)[0]);
    expect(assignments).toEqual(['status', 'result', 'cost_micros']);
  });

  it('addresses one row by its whole primary key', () => {
    expect(journalFinishStatement()).toContain('WHERE run_id = $1 AND step_id = $2');
  });

  it('casts the result it writes', () => {
    expect(journalFinishStatement()).toContain('$4::jsonb');
  });
});
