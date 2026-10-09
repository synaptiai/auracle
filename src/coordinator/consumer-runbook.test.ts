// What the runbook says a consumer restart does (issue #113, criterion 7).
//
// The claim lives in a document no build reads, and an operator reads it
// before deciding whether a deploy is safe. So it is pinned here, the way
// src/config/model-pin.test.ts pins the model defaults. The runbook is
// wrapped prose, so every phrase is read with its whitespace collapsed: a
// claim split by a line break must read as the sentence it is.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const RUNBOOK = new URL('../../docs/operations.md', import.meta.url);

/** The Partition consumer section, with its wrapping collapsed. */
function partitionSection(): string {
  const text = readFileSync(RUNBOOK, 'utf8');
  const start = text.indexOf('### Partition consumer');
  expect(start, 'the runbook has no Partition consumer section').toBeGreaterThan(-1);
  const end = text.indexOf('\n### ', start + 1);
  return text.slice(start, end === -1 ? undefined : end).replace(/\s+/g, ' ');
}

describe('the runbook on a consumer restart', () => {
  it('says the claim raises the fence only while a run is in flight', () => {
    expect(partitionSection()).toContain(
      'The claim raises the fence of a ticket only while a run of that ticket is in flight.',
    );
  });

  it('says a parked reply keeps its fence, so a person can still approve it', () => {
    const section = partitionSection();
    expect(section).toContain(
      'A reply parked for a person and a record whose run has finished keep their fence.',
    );
    expect(section).toContain('the reply stays approvable');
  });

  it('says an approved record is still sent, and a refused one is visible', () => {
    const section = partitionSection();
    expect(section).toContain('the relay still sends the record');
    expect(section).toContain('it moves the run to `escalated` with the reason');
  });
});
