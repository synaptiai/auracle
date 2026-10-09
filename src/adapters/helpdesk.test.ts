import { describe, expect, it } from 'vitest';
import { HelpdeskAdapter } from './helpdesk.js';
import { HELPDESK_FIXTURE_TICKETS } from './fixtures/helpdesk.js';
import type { DraftReply } from './types.js';
import { AdapterCapabilityError } from './types.js';

function newAdapter(): HelpdeskAdapter {
  return new HelpdeskAdapter();
}

function reply(overrides: Partial<DraftReply> = {}): DraftReply {
  return {
    ticketExternalId: 'HD-1001',
    body: 'The sign-in page accepts your address again.',
    disclosure: 'This reply was drafted with AI assistance.',
    idemKey: 'park:t-1001:a',
    provenance: {
      generatedBy: 'auracle',
      modelId: 'test-model',
      promptVer: 'prompt-v1',
      generatedAt: '2026-01-01T00:00:00.000Z',
    },
    ...overrides,
  };
}

describe('HelpdeskAdapter capabilities', () => {
  it('declares the guarantees a full helpdesk API gives (DEC-06)', () => {
    const adapter = newAdapter();

    expect(adapter.capabilities).toEqual({
      supportsIdempotencyKey: true,
      supportsReadBack: true,
      supportsDraftState: true,
      supportsStructuredFields: true,
      supportsThreading: true,
      supportsLedgerReply: false,
    });
  });

  // DEC-44: this helpdesk publishes the drafts it parks, so the ledger never
  // holds the reply and the console offers no editor.
  it('declares no ledger reply, because it sends the drafts it parks', async () => {
    const adapter = newAdapter();

    expect(adapter.capabilities.supportsLedgerReply).toBe(false);
    await expect(
      adapter.sendLedgerReply(
        {
          draftExternalId: 'hd-draft-0001',
          bodyText: 'a reply',
          disclosure: 'drafted by an automated assistant',
          provenance: {
            generatedBy: 'auracle',
            modelId: 'test/model-v1',
            promptVer: 'p-2026-01',
            generatedAt: '2026-01-02T03:04:05Z',
          },
        },
        'key',
      ),
    ).rejects.toThrow(AdapterCapabilityError);
  });

  it('freezes the declaration so callers cannot widen autonomy', () => {
    const adapter = newAdapter();

    expect(() => {
      (adapter.capabilities as unknown as Record<string, unknown>).supportsIdempotencyKey = false;
    }).toThrow();
    expect(adapter.capabilities.supportsIdempotencyKey).toBe(true);
  });
});

describe('HelpdeskAdapter.createDraft', () => {
  it('assigns distinct ids to drafts parked under distinct keys', async () => {
    const adapter = newAdapter();

    const first = await adapter.createDraft(reply({ idemKey: 'park:t-1001:a' }));
    const second = await adapter.createDraft(reply({ idemKey: 'park:t-1001:b' }));

    expect(second.draftExternalId).not.toBe(first.draftExternalId);
  });

  it('returns the first draft for a repeated park key (DEC-24)', async () => {
    // createDraft reaches the target system before the ledger records the
    // handle. A retry after a crash in that window must not put a second
    // draft in front of the customer.
    const adapter = newAdapter();

    const first = await adapter.createDraft(reply());
    const repeat = await adapter.createDraft(reply({ body: 'A reworded retry.' }));

    expect(repeat.draftExternalId).toBe(first.draftExternalId);
    // The first draft stands: the repeat neither created nor overwrote one.
    expect(adapter.getDraft(first.draftExternalId)?.body).toBe(
      'The sign-in page accepts your address again.',
    );
  });

  it('refuses a reply for a ticket the helpdesk does not hold', async () => {
    const adapter = newAdapter();

    await expect(
      adapter.createDraft({ ...reply(), ticketExternalId: 'HD-9999' }),
    ).rejects.toThrow("helpdesk has no ticket 'HD-9999'");
  });
});

describe('HelpdeskAdapter.readDraft and editDraft', () => {
  it('applies a person edit and keeps every other draft field (DEC-11)', async () => {
    const adapter = newAdapter();
    const { draftExternalId } = await adapter.createDraft(reply());

    await adapter.editDraft(draftExternalId, 'The sign-in page accepts your address again. Take care.');

    expect(adapter.getDraft(draftExternalId)).toEqual({
      draftExternalId,
      ticketExternalId: 'HD-1001',
      body: 'The sign-in page accepts your address again. Take care.',
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

  it('throws on an edit of an unknown draft', async () => {
    const adapter = newAdapter();

    await expect(adapter.editDraft('hd-draft-none', 'new body')).rejects.toThrow(
      "helpdesk has no draft 'hd-draft-none'",
    );
  });

  it('throws on an edit with an empty body', async () => {
    const adapter = newAdapter();
    const { draftExternalId } = await adapter.createDraft(reply());

    // One validator means one message. This adapter used to phrase its own
    // ("helpdesk field 'body' must be a non-empty string"); a later change
    // replaced the three private copies with `requireNonEmpty` in types.ts.
    await expect(adapter.editDraft(draftExternalId, '')).rejects.toThrow(
      'body must not be empty',
    );
  });

  it('throws on an edit after the draft was sent', async () => {
    const adapter = newAdapter();
    const { draftExternalId } = await adapter.createDraft(reply());
    await adapter.sendDraft(draftExternalId, 'idem-1');

    await expect(adapter.editDraft(draftExternalId, 'new body')).rejects.toThrow(
      `draft '${draftExternalId}' was already sent`,
    );
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
    // A genuinely different park, so the two drafts stay distinct; the
    // shared value under test is the outbox send key, not the park key.
    const second = await adapter.createDraft(
      reply({ ticketExternalId: 'HD-1002', idemKey: 'park:t-1002:a' }),
    );

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
});

describe('HelpdeskAdapter.performAction', () => {
  it('applies close_ticket to the fixture ticket state', async () => {
    const adapter = newAdapter();

    await adapter.performAction(
      'close_ticket',
      { ticketExternalId: 'HD-1002' },
      'close_ticket:HD-1002:k1',
    );

    expect(adapter.getTicket('HD-1002')?.status).toBe('closed');
  });

  it('records a compensate action without changing the ticket fields (V2)', async () => {
    const adapter = newAdapter();
    const before = adapter.getTicket('HD-1001');

    const { externalId } = await adapter.performAction(
      'compensate',
      { ticketExternalId: 'HD-1001', reason: 'refund sent to the wrong account' },
      'compensate:HD-1001:k1',
    );
    // A replayed compensation returns the first delivery: never pays twice.
    const resent = await adapter.performAction(
      'compensate',
      { ticketExternalId: 'HD-1001', reason: 'refund sent to the wrong account' },
      'compensate:HD-1001:k1',
    );

    expect(externalId).toMatch(/^hd-act-/);
    expect(resent.externalId).toBe(externalId);
    expect(adapter.listDeliveries()).toHaveLength(1);
    await expect(adapter.readBack({ idemKey: 'compensate:HD-1001:k1' })).resolves.toEqual({
      state: 'delivered',
      externalId,
    });
    expect(adapter.getTicket('HD-1001')).toEqual(before);
  });

  it('refuses a compensate payload with no reason', async () => {
    const adapter = newAdapter();

    await expect(
      adapter.performAction('compensate', { ticketExternalId: 'HD-1001' }, 'compensate:HD-1001:k2'),
    ).rejects.toThrow(/'reason' must be a non-empty string/);
    expect(adapter.listDeliveries()).toHaveLength(0);
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

// The consumer checks its class against this declaration at startup, so the
// declaration must say exactly what performAction does.
describe('HelpdeskAdapter.performs', () => {
  it('declares its three internal classes and the payload fields each needs', () => {
    // From the helpdesk API: a close needs the ticket alone, a route needs the
    // queue it moves to, and a compensation needs its reason.
    expect(Object.fromEntries(newAdapter().performs)).toEqual({
      close_ticket: [],
      route_ticket: ['queue'],
      compensate: ['reason'],
    });
  });

  it('performs each declared class with its declared fields, and no fewer', async () => {
    const adapter = newAdapter();
    let key = 0;
    for (const [actionClass, fields] of adapter.performs) {
      const full = Object.fromEntries(fields.map((field) => [field, 'from the declaration']));
      await expect(adapter.performAction(
        actionClass, { ticketExternalId: 'HD-1001', ...full }, `${actionClass}:${key++}`,
      )).resolves.toHaveProperty('externalId');
      for (const field of fields) {
        for (const missing of [undefined, '', 3]) {
          const before = adapter.listDeliveries().length;
          await expect(adapter.performAction(
            actionClass,
            { ticketExternalId: 'HD-1001', ...full, [field]: missing },
            `${actionClass}:${key++}`,
          )).rejects.toThrow(`helpdesk action payload field '${field}' must be a non-empty string`);
          // A refused write records no delivery.
          expect(adapter.listDeliveries()).toHaveLength(before);
        }
      }
    }
  });

  it('still performs a field of only spaces, as it did for records already queued', async () => {
    // The consumer refuses a blank field at startup, so no new run sends one.
    // A record already in an outbox keeps the rule it was written under.
    const adapter = newAdapter();
    await expect(adapter.performAction(
      'route_ticket', { ticketExternalId: 'HD-1001', queue: '   ' }, 'route_ticket:spaces',
    )).resolves.toHaveProperty('externalId');
    expect(adapter.getTicket('HD-1001')?.queue).toBe('   ');
  });

  it('refuses a class it does not declare, naming the ones it does', async () => {
    await expect(newAdapter().performAction('refund', { ticketExternalId: 'HD-1001' }, 'k'))
      .rejects.toThrow(new AdapterCapabilityError(
        "helpdesk adapter cannot perform action class 'refund'; "
          + 'it implements only close_ticket, route_ticket and compensate',
      ));
  });
});
