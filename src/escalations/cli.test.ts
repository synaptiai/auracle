// The table `pnpm run escalations --pretty` prints.
//
// Pure, so it needs no database: `renderTable` takes the rows the query
// module returns and lays them out. It was private and unasserted, and it
// carried the same defect the operator console did — the column that says
// why a person is needed read the escalation reason, which is null for every
// waiting run by construction.
import { describe, expect, it } from 'vitest';

import { renderTable } from './cli.js';
import type { EscalationItem } from './query.js';

function item(over: Partial<EscalationItem> = {}): EscalationItem {
  return {
    runId: '11111111-2222-4333-8444-555555555555',
    ticketId: 'T-0001',
    state: 'awaiting_approval',
    reason: null,
    fault: null,
    gateReason: 'customer_visible',
    intentId: 'refund-request',
    // DEC-47: the product of the channel the message arrived on. The table
    // prints no column for it yet; the row carries it all the same.
    product: 'aurora',
    coverage: 0.94,
    agreement: 0.91,
    agreementThreshold: 0.8,
    coverageReviewThreshold: 0.8,
    riskTier: 'low',
    approved: false,
    createdAt: new Date('2026-09-07T09:00:00.000Z'),
    promptVer: 'seed',
    outboxStatus: null,
    draftExternalId: 'SYN-DRAFT-0001',
    payloadRecorded: false,
    payload: null,
    actionClass: 'customer_reply',
    delivery: 'at_least_once',
    costMicros: 1200,
    stepsUsed: 5,
    ...over,
  };
}

describe('the escalations table', () => {
  // Issue #94: `internal_fault` names a defect inside the coordinator and not
  // a step, so the invariant message is the whole of what an operator has to
  // go on. The runbook tells them to quote it into an issue, and it reached
  // the ledger and no reader at all.
  it('prints the fault message of a run that met a defect', () => {
    const table = renderTable([
      item({
        state: 'escalated',
        reason: 'internal_fault',
        fault: 'gate ran before classify: the run has no classification',
      }),
    ]);

    expect(table).toContain('internal_fault');
    expect(table).toContain('FAULTS');
    expect(table).toContain('gate ran before classify: the run has no classification');
  });

  // And nothing under the table when no run met one, so the ordinary queue
  // reads exactly as it did.
  it('prints no fault block when no run carries one', () => {
    expect(renderTable([item()])).not.toContain('FAULTS');
  });

  // The defect. This report selects `escalated` and `awaiting_approval`, and
  // only the first has an escalation reason.
  it('names the gate rule for a run that has not escalated', () => {
    const table = renderTable([item({ reason: null, gateReason: 'high_risk' })]);
    expect(table).toContain('high_risk');
  });

  // Two different questions, and an escalated run answers the first.
  it('prefers the escalation reason when the run escalated', () => {
    const table = renderTable([
      item({ state: 'escalated', reason: 'composer_abstained', gateReason: 'high_risk' }),
    ]);
    expect(table).toContain('composer_abstained');
  });

  it('says what the ticket was about', () => {
    expect(renderTable([item({ intentId: 'billing-dispute' })])).toContain('billing-dispute');
  });

  // DEC-34: a gated write with no customer draft parks its payload in the
  // ledger and is still approvable. A dash there read as a run nothing could
  // be done with.
  it('says a ledger-parked action carries a payload to act on', () => {
    const table = renderTable([item({ draftExternalId: null, payloadRecorded: true })]);
    expect(table).toContain('payload');
  });

  it('says a run that parked neither has nothing to act on', () => {
    const table = renderTable([item({ draftExternalId: null, payloadRecorded: false })]);
    expect(table).not.toContain('payload');
  });

  // Every column is padded to its widest cell, so a header the rows do not
  // fill would misalign the whole table.
  it('lays every row out under the same headers', () => {
    const lines = renderTable([item(), item({ ticketId: 'T-a-much-longer-ticket-id' })])
      .split('\n')
      .filter((line) => line.trim() !== '');
    expect(lines).toHaveLength(3);
    const widthOf = (line: string): number => line.replace(/\s+$/, '').length;
    expect(widthOf(lines[1]!)).toBeLessThanOrEqual(lines[0]!.length + 40);
    for (const column of ['RUN', 'TICKET', 'STATE', 'PIN', 'INTENT', 'REASON', 'DRAFT']) {
      expect(lines[0], column).toContain(column);
    }
  });
});
