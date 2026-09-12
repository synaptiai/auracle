// All halves here are synthetic fixtures written to a temporary directory
// (DEC-18). Nothing real appears in this repository.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { selectHalf } from './half-from-env.js';
import type { GoldSplit, GoldTicket } from '../domain/gold-types.js';

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function turn(id: string): GoldTicket {
  return {
    ticket_id: id,
    source: 'real',
    conversation_id: id,
    turn_number: 1,
    intent: 'refund-request',
    queue: 'billing',
    disposition: { escalated: false, macro_applied: null, refund_issued: false, first_reply_minutes: 30 },
    subject: 'Charged twice',
    body: 'I see two charges for one month.',
  };
}

function writeHalf(split: GoldSplit, ids: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'half-env-'));
  dirs.push(dir);
  const path = join(dir, `${split}.json`);
  const tickets = ids.map(turn);
  writeFileSync(path, JSON.stringify({ split, source: 'real', count: tickets.length, tickets }));
  return path;
}

describe('selectHalf', () => {
  it('reads the committed corpus when neither variable is set', () => {
    expect(selectHalf('fit', {})).toEqual({});
  });

  it('reads the named half and the other half it is proved against', () => {
    const fit = writeHalf('fit', ['a@example.test']);
    const report = writeHalf('report', ['b@example.test']);
    const selected = selectHalf('fit', { GOLD_FIT_PATH: fit, GOLD_REPORT_PATH: report });
    expect(selected.half?.tickets).toHaveLength(1);
    expect(selected.counterpart?.ticketIds.has('b@example.test')).toBe(true);
    expect(selected.path).toBe(fit);
  });

  // Halfway through a change is the dangerous state. Fitting on the named
  // half anyway would publish a threshold whose disjointness nobody checked.
  it('refuses one path without the other, naming the variable to set', () => {
    const fit = writeHalf('fit', ['a@example.test']);
    expect(() => selectHalf('fit', { GOLD_FIT_PATH: fit })).toThrow(/GOLD_REPORT_PATH is not/);
    expect(() => selectHalf('fit', { GOLD_REPORT_PATH: fit })).toThrow(/GOLD_FIT_PATH is not/);
  });

  // `GOLD_FIT_PATH=` clears a variable in every shell, and it is a defined
  // empty string. Untrimmed it skipped both guidance errors and died in
  // readFileSync('') naming no variable. Survived mutation before this case.
  it.each(['', '   '])('treats a blank variable as unset (%j)', (blank) => {
    const report = writeHalf('report', ['b@example.test']);
    expect(() => selectHalf('fit', { GOLD_FIT_PATH: blank, GOLD_REPORT_PATH: report }))
      .toThrow(/GOLD_FIT_PATH is not/);
    expect(selectHalf('fit', { GOLD_FIT_PATH: blank })).toEqual({});
  });

  it('reads the report half for the job that publishes', () => {
    const fit = writeHalf('fit', ['a@example.test']);
    const report = writeHalf('report', ['b@example.test']);
    const selected = selectHalf('report', { GOLD_FIT_PATH: fit, GOLD_REPORT_PATH: report });
    expect(selected.half?.split).toBe('report');
    expect(selected.counterpart?.ticketIds.has('a@example.test')).toBe(true);
  });
});
