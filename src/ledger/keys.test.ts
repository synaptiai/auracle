import { describe, expect, it } from 'vitest';

import { deriveIdemKey } from './keys.js';

describe('deriveIdemKey (DEC-24, section 3.4)', () => {
  it('gives the same key for the same action twice, regardless of run identity', () => {
    // The function takes no run_id or timestamp; calling it from two distinct
    // runs with identical semantics must produce one key.
    const first = deriveIdemKey({
      actionClass: 'refund',
      ticketId: 'T-1',
      payload: { amount_cents: 5000, currency: 'USD' },
    });
    const second = deriveIdemKey({
      actionClass: 'refund',
      ticketId: 'T-1',
      payload: { amount_cents: 5000, currency: 'USD' },
    });
    expect(first).toBe(second);
  });

  it('gives different keys for a refund of 50 and a refund of 100', () => {
    const refund50 = deriveIdemKey({
      actionClass: 'refund',
      ticketId: 'T-1',
      payload: { amount_cents: 5000 },
    });
    const refund100 = deriveIdemKey({
      actionClass: 'refund',
      ticketId: 'T-1',
      payload: { amount_cents: 10000 },
    });
    expect(refund50).not.toBe(refund100);
  });

  it('is independent of payload key order', () => {
    const a = deriveIdemKey({
      actionClass: 'refund',
      ticketId: 'T-1',
      payload: { amount_cents: 5000, currency: 'USD' },
    });
    const b = deriveIdemKey({
      actionClass: 'refund',
      ticketId: 'T-1',
      payload: { currency: 'USD', amount_cents: 5000 },
    });
    expect(a).toBe(b);
  });

  it('separates actions by action class', () => {
    const refund = deriveIdemKey({
      actionClass: 'refund',
      ticketId: 'T-1',
      payload: { amount_cents: 5000 },
    });
    const close = deriveIdemKey({
      actionClass: 'close_ticket',
      ticketId: 'T-1',
      payload: { amount_cents: 5000 },
    });
    expect(refund).not.toBe(close);
  });

  it('separates actions by ticket id', () => {
    const t1 = deriveIdemKey({
      actionClass: 'refund',
      ticketId: 'T-1',
      payload: { amount_cents: 5000 },
    });
    const t2 = deriveIdemKey({
      actionClass: 'refund',
      ticketId: 'T-2',
      payload: { amount_cents: 5000 },
    });
    expect(t1).not.toBe(t2);
  });

  it('treats array order as semantic', () => {
    const a = deriveIdemKey({
      actionClass: 'merge_tickets',
      ticketId: 'T-1',
      payload: { sources: ['A', 'B'] },
    });
    const b = deriveIdemKey({
      actionClass: 'merge_tickets',
      ticketId: 'T-1',
      payload: { sources: ['B', 'A'] },
    });
    expect(a).not.toBe(b);
  });

  it('throws when the payload carries run identity (DEC-24 assertion)', () => {
    expect(() =>
      deriveIdemKey({
        actionClass: 'refund',
        ticketId: 'T-1',
        payload: { amount_cents: 5000, run_id: 'some-run' },
      }),
    ).toThrow(/run-identity/);
    expect(() =>
      deriveIdemKey({
        actionClass: 'refund',
        ticketId: 'T-1',
        payload: { nested: { timestamp: Date.now() } },
      }),
    ).toThrow(/run-identity/);
  });

  it('produces keys usable as outbox idem_key text values', () => {
    const key = deriveIdemKey({
      actionClass: 'refund',
      ticketId: 'T-1',
      payload: { amount_cents: 5000 },
    });
    expect(key).toMatch(/^refund:T-1:[0-9a-f]{64}$/);
  });
});

describe('the turn joins the key (DEC-38)', () => {
  const base = {
    actionClass: 'refund',
    ticketId: 'T-1',
    payload: { amountCents: 2500 },
  };

  it('gives two turns of one request two keys', () => {
    // A customer asks for a refund in turn one and again in turn four after
    // a partial answer. Those are two requests, not a replay of one.
    const first = deriveIdemKey({ ...base, turnNumber: 1 });
    const later = deriveIdemKey({ ...base, turnNumber: 4 });

    expect(first).not.toBe(later);
  });

  it('gives a retry of one turn one key', () => {
    // DEC-24 still holds: two runs of one action derive one key.
    expect(deriveIdemKey({ ...base, turnNumber: 4 })).toBe(
      deriveIdemKey({ ...base, turnNumber: 4 }),
    );
  });

  it('holds the key itself steady across releases', () => {
    // The key is not an internal value. It is stored in outbox.idem_key and
    // handed to the target system, so it identifies a request beyond this
    // process. A change to how it is built silently gives every in-flight
    // approval a new key. The approval then derives a key its park never
    // wrote, and the request is dropped as superseded.
    //
    // Every other case here is relative, so all of them would still pass.
    // These three literals are what actually pins the construction.
    expect(deriveIdemKey(base)).toBe(
      'refund:T-1:49cc03564ceddc33efb08d49d3f456f0dcc6d3da40e8118f8c301979ff587b24',
    );
    expect(deriveIdemKey({ ...base, turnNumber: 1 })).toBe(
      'refund:T-1:a83201593e5126e3d11c7aae2660ddf3d79e2c1e3e30a976aa7f4118d6ed7bb0',
    );
    expect(deriveIdemKey({ ...base, turnNumber: 4 })).toBe(
      'refund:T-1:bf2d9fb006c379ede2931a2975604569abe2b704ef33fbbef4204bbe207ca664',
    );
    expect(deriveIdemKey({ ...base, turnNumber: 1, conversationId: 'C-1' })).toBe(
      'refund:T-1:48fedac5b1c28ce3a51d6ce3c20c9f7c741d5451fa5fd5678dba40e3e64c0727',
    );
  });

  // db/012 refuses a join by a different sender, so one ticket can carry two
  // conversations — and the first turn of each is turn 1. Keyed on ticket and
  // turn alone, the second sender's action derived a key the first already
  // used, the outbox UNIQUE(idem_key) rejected the insert, and the run landed
  // superseded: no reply, no draft, and nothing naming why.
  it('separates two conversations that share one ticket and one turn number', () => {
    const first = deriveIdemKey({ ...base, turnNumber: 1, conversationId: 'C-1' });
    const second = deriveIdemKey({ ...base, turnNumber: 1, conversationId: 'C-2' });

    expect(first).not.toBe(second);
  });

  it('still gives one conversation one key per turn, so a retry deduplicates', () => {
    const once = deriveIdemKey({ ...base, turnNumber: 2, conversationId: 'C-1' });
    const retry = deriveIdemKey({ ...base, turnNumber: 2, conversationId: 'C-1' });

    expect(retry).toBe(once);
    // And the next turn of that conversation is a different request.
    expect(deriveIdemKey({ ...base, turnNumber: 3, conversationId: 'C-1' })).not.toBe(once);
  });

  it('leaves a caller with no turn on the V1 key', () => {
    // A run parked before DEC-38 is approved after it. The approval derives
    // the key from the park record, which carries no turn, so it still
    // matches the record that park would have produced.
    const v1 = deriveIdemKey(base);

    expect(v1).not.toBe(deriveIdemKey({ ...base, turnNumber: 1 }));
    expect(v1).toBe(deriveIdemKey({ ...base }));
  });
});

describe('the attempt joins the key (DEC-49)', () => {
  const base = {
    actionClass: 'reply:park',
    ticketId: 'T-1',
    turnNumber: 2,
    conversationId: 'C-1',
    payload: { intent: 'refund' },
  };

  it('gives two attempts of one turn two keys', () => {
    // The adapter finds drafts by key. A new attempt that derived the first
    // attempt's key would be handed the draft the reviewer rejected.
    const first = deriveIdemKey({ ...base, attempt: 1 });
    const second = deriveIdemKey({ ...base, attempt: 2 });

    expect(first).not.toBe(second);
  });

  it('gives the attempts after the first one different keys', () => {
    // DEC-24 holds across the upgrade: every attempt above the first
    // separates from the one before it.
    //
    // There is no case here asserting that a caller which names one attempt
    // twice gets one key. That is determinism in a pure function of its
    // arguments, which the first case in this file already asserts, and it
    // cannot fail. The claim that a retry stays in its attempt belongs to the
    // caller that chooses the number, and it is asserted there: the poll
    // carries the turn's current attempt into a redelivery, in
    // `src/outcomes/send-back.db.test.ts`.
    expect(deriveIdemKey({ ...base, attempt: 3 })).not.toBe(
      deriveIdemKey({ ...base, attempt: 2 }),
    );
  });

  it('leaves the first attempt on the key the turn always derived', () => {
    // Every run written before db/031 is attempt 1, and so is every run no
    // reviewer has sent back. A caller that names attempt 1, a caller that
    // names none, and a park journaled before the column existed must all
    // derive one key: an approval in flight across the upgrade still matches
    // the record its park wrote.
    const named = deriveIdemKey({ ...base, attempt: 1 });
    const unnamed = deriveIdemKey({ ...base });

    expect(named).toBe(unnamed);
  });

  it('holds the key itself steady across releases', () => {
    // Literal, for the reason the DEC-38 case above is literal: every other
    // case here is relative, and the attempt is folded into a key that
    // identifies a request beyond this process.
    expect(deriveIdemKey({ ...base, attempt: 1 })).toBe(
      'reply:park:T-1:1433a4f20d64d06b797f818ae194f34b7561f9adc915160d0bed8b2a9050e756',
    );
    expect(deriveIdemKey({ ...base, attempt: 2 })).toBe(
      'reply:park:T-1:a217e7c2e30c210ec928c578d2ebc469afbf29a376186e6a160dda20ee76caca',
    );
  });

  it('separates an attempt from a turn of the same number', () => {
    // The attempt is folded inside the turn segment, so attempt 2 of turn 2
    // cannot collide with attempt 1 of a turn whose number reads the same.
    // A caller that named a turn and no attempt is attempt 1, and attempt 2
    // of that turn is a different request.
    const turnTwo = deriveIdemKey({ ...base, attempt: 2 });
    const otherTurn = deriveIdemKey({ ...base, turnNumber: 22, attempt: 1 });

    expect(turnTwo).not.toBe(otherTurn);
    expect(turnTwo).not.toBe(deriveIdemKey({ ...base, turnNumber: 2 }));
  });
});
