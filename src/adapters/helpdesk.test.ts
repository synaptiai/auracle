import { describe, expect, it } from 'vitest';
import { HelpdeskAdapter } from './helpdesk.js';
import { HELPDESK_FIXTURE_TICKETS } from './fixtures/helpdesk.js';
import type { DraftReply } from './types.js';
import { AdapterCapabilityError } from './types.js';

function newAdapter(): HelpdeskAdapter {
  return new HelpdeskAdapter();
}

function reply(): DraftReply {
  return {
    ticketExternalId: 'HD-1001',
    body: 'The sign-in page accepts your address again.',
    disclosure: 'This reply was drafted with AI assistance.',
    provenance: {
      generatedBy: 'auracle',
      modelId: 'test-model',
      promptVer: 'prompt-v1',
      generatedAt: '2026-01-01T00:00:00.000Z',
    },
  };
}

describe('HelpdeskAdapter capabilities', () => {
  it('declares the five section 4.1 capability flags', () => {
    const adapter = newAdapter();

    expect(Object.keys(adapter.capabilities).sort()).toEqual([
      'supportsDraftState',
      'supportsIdempotencyKey',
      'supportsReadBack',
      'supportsStructuredFields',
      'supportsThreading',
    ]);
  });

  it('declares the guarantees a full helpdesk API gives (DEC-06)', () => {
    const adapter = newAdapter();

    expect(adapter.capabilities).toEqual({
      supportsIdempotencyKey: true,
      supportsReadBack: true,
      supportsDraftState: true,
      supportsStructuredFields: true,
      supportsThreading: true,
    });
  });

  it('freezes the declaration so callers cannot widen autonomy', () => {
    const adapter = newAdapter();

    expect(() => {
      (adapter.capabilities as Record<string, unknown>).supportsIdempotencyKey = false;
    }).toThrow();
    expect(adapter.capabilities.supportsIdempotencyKey).toBe(true);
  });
});

describe('HelpdeskAdapter.createDraft', () => {
  it('parks a gated reply as a draft on a fixture ticket (DEC-11)', async () => {
    const adapter = newAdapter();

    const { draftExternalId } = await adapter.createDraft(reply());
    expect(draftExternalId).toMatch(/^hd-draft-/);

    expect(adapter.getDraft(draftExternalId)).toEqual({
      draftExternalId,
      ticketExternalId: 'HD-1001',
      body: 'The sign-in page accepts your address again.',
      disclosure: 'This reply was drafted with AI assistance.',
      provenance: {
        generatedBy: 'auracle',
        modelId: 'test-model',
        promptVer: 'prompt-v1',
        generatedAt: '2026-01-01T00:00:00.000Z',
      },
      status: 'draft',
    });
  });

  it('assigns distinct ids to successive drafts', async () => {
    const adapter = newAdapter();

    const first = await adapter.createDraft(reply());
    const second = await adapter.createDraft(reply());

    expect(second.draftExternalId).not.toBe(first.draftExternalId);
  });

  it.each([
    ['ticketExternalId is empty', { ...reply(), ticketExternalId: '' }],
    ['body is empty', { ...reply(), body: '' }],
    ['disclosure is empty (DEC-14)', { ...reply(), disclosure: '' }],
  ])('refuses a reply when %s', async (_label, bad) => {
    const adapter = newAdapter();

    await expect(adapter.createDraft(bad)).rejects.toThrow(TypeError);
  });

  it('refuses a reply for a ticket the helpdesk does not hold', async () => {
    const adapter = newAdapter();

    await expect(
      adapter.createDraft({ ...reply(), ticketExternalId: 'HD-9999' }),
    ).rejects.toThrow("helpdesk has no ticket 'HD-9999'");
  });
});

describe('HelpdeskAdapter.sendDraft and readBack', () => {
  it('sends an approved draft once and reports it delivered (section 4.4)', async () => {
    const adapter = newAdapter();
    const { draftExternalId } = await adapter.createDraft(reply());

    const { externalId } = await adapter.sendDraft(draftExternalId, 'idem-1');

    expect(externalId).toMatch(/^hd-msg-/);
    await expect(adapter.readBack({ idemKey: 'idem-1' })).resolves.toEqual({
      state: 'delivered',
      externalId,
    });
    expect(adapter.getDraft(draftExternalId)?.status).toBe('sent');
    expect(adapter.listDeliveries()).toHaveLength(1);
  });

  it('returns the first delivery for a repeated idempotency key (DEC-24)', async () => {
    const adapter = newAdapter();
    const first = await adapter.createDraft(reply());
    const second = await adapter.createDraft({ ...reply(), ticketExternalId: 'HD-1002' });

    const sentFirst = await adapter.sendDraft(first.draftExternalId, 'idem-1');
    const resent = await adapter.sendDraft(second.draftExternalId, 'idem-1');

    // The key comes from the action semantics, so the repeat call does
    // not send a second message.
    expect(resent.externalId).toBe(sentFirst.externalId);
    expect(adapter.listDeliveries()).toHaveLength(1);
    expect(adapter.getDraft(second.draftExternalId)?.status).toBe('draft');
  });

  it('throws when one draft is sent under two different keys', async () => {
    const adapter = newAdapter();
    const { draftExternalId } = await adapter.createDraft(reply());

    await adapter.sendDraft(draftExternalId, 'idem-1');

    await expect(adapter.sendDraft(draftExternalId, 'idem-2')).rejects.toThrow(
      `draft '${draftExternalId}' was already sent under another idempotency key`,
    );
  });

  it('throws on an unknown draft id', async () => {
    const adapter = newAdapter();

    await expect(adapter.sendDraft('hd-draft-none', 'idem-1')).rejects.toThrow(
      "helpdesk has no draft 'hd-draft-none'",
    );
  });

  it('reports not_found before any send instead of guessing (DEC-30)', async () => {
    const adapter = newAdapter();

    await expect(adapter.readBack({ idemKey: 'never-sent' })).resolves.toEqual({
      state: 'not_found',
    });
  });

  it('runs the full path end to end: gate, approve, send, reconcile', async () => {
    const adapter = newAdapter();

    // The approval bridge parks the gated reply (DEC-11).
    const { draftExternalId } = await adapter.createDraft(reply());
    expect(adapter.getDraft(draftExternalId)?.status).toBe('draft');

    // After approval the relay sends through the same adapter with the
    // outbox idem key, then reconciles by read-back (DEC-30).
    const sent = await adapter.sendDraft(draftExternalId, 'run-42:reply');
    await expect(adapter.readBack({ idemKey: 'run-42:reply' })).resolves.toEqual({
      state: 'delivered',
      externalId: sent.externalId,
    });
  });
});

describe('HelpdeskAdapter.performAction', () => {
  it('applies route_ticket to the fixture ticket state', async () => {
    const adapter = newAdapter();

    const { externalId } = await adapter.performAction(
      'route_ticket',
      { ticketExternalId: 'HD-1001', queue: 'password-support' },
      'route_ticket:HD-1001:k1',
    );

    expect(externalId).toMatch(/^hd-act-/);
    expect(adapter.getTicket('HD-1001')?.queue).toBe('password-support');
  });

  it('applies close_ticket to the fixture ticket state', async () => {
    const adapter = newAdapter();

    await adapter.performAction(
      'close_ticket',
      { ticketExternalId: 'HD-1002' },
      'close_ticket:HD-1002:k1',
    );

    expect(adapter.getTicket('HD-1002')?.status).toBe('closed');
  });

  it('returns the first delivery for a repeated idempotency key and applies once (DEC-24)', async () => {
    const adapter = newAdapter();
    const payload = { ticketExternalId: 'HD-1001', queue: 'billing' };

    const first = await adapter.performAction('route_ticket', payload, 'route_ticket:HD-1001:k2');
    // A retry after an ambiguous failure replays the same semantic action.
    const resent = await adapter.performAction('route_ticket', payload, 'route_ticket:HD-1001:k2');

    expect(resent.externalId).toBe(first.externalId);
    expect(adapter.listDeliveries()).toHaveLength(1);
    // The action ran exactly once; a second application is unobservable
    // here, so the single delivery record is the proof.
    expect(adapter.getTicket('HD-1001')?.queue).toBe('billing');
  });

  it('throws instead of faking an action class it does not implement (DEC-06)', async () => {
    const adapter = newAdapter();

    await expect(
      adapter.performAction(
        'merge_tickets',
        { ticketExternalId: 'HD-1001' },
        'merge_tickets:HD-1001:k1',
      ),
    ).rejects.toThrow(AdapterCapabilityError);
    // Nothing was delivered and nothing changed.
    expect(adapter.listDeliveries()).toHaveLength(0);
  });

  it.each([
    ['ticketExternalId is missing', { queue: 'billing' }],
    ['ticketExternalId is empty', { ticketExternalId: '', queue: 'billing' }],
  ])('refuses a payload when %s', async (_label, bad) => {
    const adapter = newAdapter();

    await expect(
      adapter.performAction('route_ticket', bad, 'route_ticket:HD-1001:k3'),
    ).rejects.toThrow(TypeError);
  });

  it('refuses an action for a ticket the helpdesk does not hold', async () => {
    const adapter = newAdapter();

    await expect(
      adapter.performAction(
        'close_ticket',
        { ticketExternalId: 'HD-9999' },
        'close_ticket:HD-9999:k1',
      ),
    ).rejects.toThrow("helpdesk has no ticket 'HD-9999'");
  });
});

describe('helpdesk fixtures', () => {
  it('seeds tickets the drafts attach to (DEC-18)', () => {
    expect(HELPDESK_FIXTURE_TICKETS.length).toBeGreaterThan(0);
    for (const ticket of HELPDESK_FIXTURE_TICKETS) {
      expect(ticket.ticketId).toMatch(/^HD-\d{4}$/);
    }
  });

  it('holds only synthetic content with no real identifiers (DEC-18)', () => {
    for (const ticket of HELPDESK_FIXTURE_TICKETS) {
      const text = JSON.stringify(ticket);
      expect(text).not.toMatch(/@(?!example\.)[\w.-]+\.\w+/); // no email addresses
      expect(text).not.toMatch(/\+?\d[\d(). -]{8,}\d/); // no phone numbers
    }
  });
});
