import { describe, expect, it } from 'vitest';

import { HelpdeskAdapter } from '../adapters/helpdesk.js';
import type { DraftReply, EgressAdapter, LedgerReply } from '../adapters/types.js';
import {
  ApprovalRefusalError,
  parkGatedReply,
  validateGatedReply,
} from './bridge.js';

function reply(overrides: Partial<DraftReply> = {}): DraftReply {
  return {
    idemKey: 'park:T-1:a',
    ticketExternalId: 'HD-1001',
    body: 'The sign-in page accepts your address again.',
    disclosure: 'This reply was drafted with AI assistance.',
    provenance: {
      generatedBy: 'auracle',
      modelId: 'test-model',
      promptVer: 'prompt-v1',
      generatedAt: '2026-01-01T00:00:00.000Z',
    },
    ...overrides,
  };
}

/** An egress adapter that records every createDraft call. */
function recordingAdapter(): EgressAdapter & { calls: number } {
  const delegate = new HelpdeskAdapter();
  const adapter = {
    calls: 0,
    name: delegate.name,
    capabilities: delegate.capabilities,
    performs: delegate.performs,
    async createDraft(r: DraftReply) {
      this.calls += 1;
      return delegate.createDraft(r);
    },
    sendDraft: (id: string, key: string) => delegate.sendDraft(id, key),
    sendLedgerReply: (reply: LedgerReply, key: string) => delegate.sendLedgerReply(reply, key),
    performAction: (actionClass: string, payload: Record<string, unknown>, key: string) =>
      delegate.performAction(actionClass, payload, key),
    readBack: (ref: { readonly idemKey: string }) => delegate.readBack(ref),
  };
  return adapter as EgressAdapter & { calls: number };
}

describe('parkGatedReply refusal on empty disclosure (DEC-14)', () => {
  it('refuses an empty disclosure and never calls the adapter', async () => {
    const adapter = recordingAdapter();

    await expect(parkGatedReply(adapter, reply({ disclosure: '' }))).rejects.toThrow(
      ApprovalRefusalError,
    );
    expect(adapter.calls).toBe(0);
  });

  it('refuses a whitespace-only disclosure (DEC-14)', async () => {
    const adapter = recordingAdapter();

    await expect(parkGatedReply(adapter, reply({ disclosure: '   \n\t' }))).rejects.toThrow(
      ApprovalRefusalError,
    );
    expect(adapter.calls).toBe(0);
  });
});

describe('parkGatedReply provenance enforcement (DEC-33)', () => {
  it('attaches provenance onto the message record in the draft state', async () => {
    const adapter = new HelpdeskAdapter();
    const provenance = {
      generatedBy: 'auracle',
      modelId: 'test-model',
      promptVer: 'prompt-v1',
      generatedAt: '2026-01-01T00:00:00.000Z',
    };
    const { draftExternalId } = await parkGatedReply(
      adapter,
      reply({ provenance }),
    );

    // The record the operator UI reads back carries machine-readable provenance.
    expect(adapter.getDraft(draftExternalId)?.provenance).toEqual(provenance);
  });

  it('refuses a reply whose provenance is missing entirely', async () => {
    const adapter = recordingAdapter();
    const missing = reply() as unknown as DraftReply;
    delete (missing as unknown as Record<string, unknown>)['provenance'];

    await expect(parkGatedReply(adapter, missing)).rejects.toThrow(ApprovalRefusalError);
    expect(adapter.calls).toBe(0);
  });

  it.each([
    ['generatedBy', ''],
    ['modelId', '   '],
    ['promptVer', undefined],
    ['generatedAt', 'not-a-timestamp'],
  ])('refuses provenance with a bad %s field', async (field, value) => {
    const provenance = {
      generatedBy: 'auracle',
      modelId: 'test-model',
      promptVer: 'prompt-v1',
      generatedAt: '2026-01-01T00:00:00.000Z',
      [field]: value,
    };

    const reasons = validateGatedReply(reply({ provenance }));

    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.some((r) => r.includes(field))).toBe(true);
  });
});
