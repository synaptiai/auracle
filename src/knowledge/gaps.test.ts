// What makes a case blocked by a gap, and how a document's change flag reads
// (issue #111, DEC-50).
//
// The classifier reads journal rows through the parsers the run page uses, so
// the case and the knowledge screen cannot count a case two ways.
import { describe, expect, it } from 'vitest';

import { caseFromRows, changeFlag, gapOf } from './gaps.js';

/** A compose row over claims citing each id in turn, with one courtesy sentence first. */
function composed(...docIds: string[]): { status: string; result: Record<string, unknown> } {
  return {
    status: 'done',
    result: {
      abstained: false,
      claimCount: docIds.length,
      sentences: [
        { text: 'Thanks for writing in.', docId: null },
        ...docIds.map((docId, i) => ({ text: `Claim ${i}.`, docId })),
      ],
    },
  };
}

/** A gate row with a coverage reading and these verdicts, by claim position. */
function gated(...supported: unknown[]): { status: string; result: Record<string, unknown> } {
  return {
    status: 'done',
    result: {
      groundedness: 0.5,
      decision: 'gated',
      claimVerdicts: supported.map((s, claimIndex) => ({ claimIndex, supported: s })),
    },
  };
}

describe('a case blocked by a gap', () => {
  it('is blocked when the composer abstained, since no document could support an answer', () => {
    const c = caseFromRows({ compose: { status: 'abstained', result: { abstained: true } } });
    expect(gapOf(c)).toEqual({ kind: 'abstained' });
  });

  it('names the document of the refused claim, not of the supported one', () => {
    // Claim 0 cites DOC-A and is supported; claim 1 cites DOC-B and is not.
    // The courtesy sentence takes no position, so a reader that indexed the
    // sentences rather than the claims would name DOC-A.
    const c = caseFromRows({ compose: composed('DOC-A', 'DOC-B'), gate: gated(true, false) });
    expect(gapOf(c)).toEqual({ kind: 'unsupported', docIds: ['DOC-B'] });
  });

  it('names each refused document once, in claim order', () => {
    const c = caseFromRows({
      compose: composed('DOC-C', 'DOC-A', 'DOC-C'),
      gate: gated(false, false, false),
    });
    expect(gapOf(c)).toEqual({ kind: 'unsupported', docIds: ['DOC-C', 'DOC-A'] });
  });

  it('is not blocked when every claim is supported', () => {
    const c = caseFromRows({ compose: composed('DOC-A', 'DOC-B'), gate: gated(true, true) });
    expect(gapOf(c)).toBeNull();
  });

  it('reads a malformed verdict list as unread, so its refusal counts for nothing', () => {
    // One member is not a boolean. The run page refuses the list whole, so a
    // reader that counted the readable `false` would call a case blocked
    // that the case page shows as not judged.
    const c = caseFromRows({ compose: composed('DOC-A', 'DOC-B'), gate: gated(false, 'no') });
    expect(gapOf(c)).toBeNull();
  });

  it('reads the verdicts of a gate row with no coverage reading as unread', () => {
    const gate = gated(false);
    delete gate.result['groundedness'];
    const c = caseFromRows({ compose: composed('DOC-A'), gate });
    expect(gapOf(c)).toBeNull();
  });

  it('reads the verdicts of a gate row that did not finish as unread', () => {
    const gate = { ...gated(false), status: 'failed' };
    const c = caseFromRows({ compose: composed('DOC-A'), gate });
    expect(gapOf(c)).toBeNull();
  });

  it('is not blocked by a refusal whose claim list is unreadable, which the page draws no claim for', () => {
    const compose = { status: 'done', result: { abstained: false, sentences: 'not a list' } };
    const c = caseFromRows({ compose, gate: gated(false) });
    expect(gapOf(c)).toBeNull();
  });

  it('is not blocked by two verdicts for one claim, which the page reads as not judged', () => {
    const gate = { status: 'done', result: { groundedness: 0.5, decision: 'gated',
      claimVerdicts: [{ claimIndex: 0, supported: false }, { claimIndex: 0, supported: true }, { claimIndex: 1, supported: true }] } };
    // The refusal comes first, so a reader that took the first entry for
    // claim 0 would call the case blocked.
    expect(gapOf(caseFromRows({ compose: composed('DOC-A', 'DOC-B'), gate }))).toBeNull();
  });

  it('is not blocked by a refusal whose position names no claim', () => {
    // One claim, and verdicts for positions 5 and -1. The page draws the one
    // claim as supported and nothing as refused.
    const compose = composed('DOC-A');
    const gate = { status: 'done', result: { groundedness: 0, decision: 'gated',
      claimVerdicts: [{ claimIndex: 0, supported: true }, { claimIndex: 5, supported: false },
        { claimIndex: -1, supported: false }] } };
    expect(gapOf(caseFromRows({ compose, gate }))).toBeNull();
  });

  it('is not blocked when nothing composed and nothing gated', () => {
    expect(gapOf(caseFromRows({}))).toBeNull();
  });

  it('reads the intent only from a classify row that finished, and only as a string', () => {
    expect(caseFromRows({ classify: { status: 'done', intent: 'refund_request' } }).intentId)
      .toBe('refund_request');
    expect(caseFromRows({ classify: { status: 'failed', intent: 'refund_request' } }).intentId)
      .toBeNull();
    expect(caseFromRows({ classify: { status: 'done', intent: 7 } }).intentId).toBeNull();
  });
});

describe("a document's change flag", () => {
  const digest = 'a'.repeat(64);

  it('reads not cited when no case in the window cites the document', () => {
    expect(changeFlag(digest, [])).toBe('not_cited');
  });

  it('reads unchanged when every citing case recorded the same body', () => {
    expect(changeFlag(digest, [digest, digest])).toBe('unchanged');
  });

  it('reads changed when one citing case recorded another body', () => {
    expect(changeFlag(digest, [digest, 'b'.repeat(64)])).toBe('changed');
  });

  it('reads changed over a case that recorded nothing, since one comparison answered', () => {
    expect(changeFlag(digest, [undefined, 'b'.repeat(64)])).toBe('changed');
  });

  it('reads not compared when a citing case recorded no hash, never unchanged', () => {
    expect(changeFlag(digest, [digest, undefined])).toBe('not_compared');
  });
});
