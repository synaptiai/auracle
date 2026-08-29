// Validation tests for the synthetic fixture corpus.
//
// Decisions obeyed: DEC-18 (no real-looking data, no email-shaped strings),
// DEC-22 (documents + canonical resolutions), DEC-23 (owner + review_by on
// each document), DEC-31 (385 fit / 385 report, no overlap), section 4.10
// (strata present in both halves), section 4.11 ('other' group kept).

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  FIT_COUNT,
  INTENT_CAP,
  REPORT_COUNT,
  assertIntentsKnown,
  conversationHistories,
  fixturesDir,
  goldCaseText,
  isFirstTurn,
  loadDocuments,
  loadGoldSet,
  loadTaxonomy,
  validateGoldHalf,
} from './load.js';
import type { GoldFile, GoldTicket } from './load.js';

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/;

describe('taxonomy', () => {
  const taxonomy = loadTaxonomy();

  it('stays within the 25-intent cap and keeps an other group', () => {
    expect(taxonomy.intents.length).toBeLessThanOrEqual(INTENT_CAP);
    expect(taxonomy.intents.some((i) => i.id === 'other')).toBe(true);
  });

  it('assigns every intent a valid risk tier', () => {
    for (const intent of taxonomy.intents) {
      expect(['low', 'medium', 'high']).toContain(intent.risk_tier);
    }
  });

  it('uses all three risk tiers', () => {
    expect(new Set(taxonomy.intents.map((i) => i.risk_tier)).size).toBe(3);
  });
});

describe('gold set', () => {
  const { fit, report } = loadGoldSet();

  it('splits 770 cases into disjoint halves of 385', () => {
    expect(fit.count).toBe(FIT_COUNT);
    expect(report.count).toBe(REPORT_COUNT);
    expect(fit.tickets.length).toBe(FIT_COUNT);
    expect(report.tickets.length).toBe(REPORT_COUNT);
    const fitIds = new Set(fit.tickets.map((t) => t.ticket_id));
    for (const ticket of report.tickets) {
      expect(fitIds.has(ticket.ticket_id)).toBe(false);
    }
  });

  it('labels every ticket with a taxonomy intent', () => {
    const known = new Set(loadTaxonomy().intents.map((i) => i.id));
    for (const ticket of [...fit.tickets, ...report.tickets]) {
      expect(known.has(ticket.intent)).toBe(true);
    }
  });

  it('carries every observable disposition field (DEC-32)', () => {
    for (const ticket of [...fit.tickets, ...report.tickets]) {
      expect(typeof ticket.disposition.escalated).toBe('boolean');
      expect(typeof ticket.disposition.refund_issued).toBe('boolean');
      const macro = ticket.disposition.macro_applied;
      expect(macro === null || /^MACRO-[A-Z-]+$/.test(macro), `bad macro ${String(macro)}`).toBe(true);
      expect(Number.isInteger(ticket.disposition.first_reply_minutes)).toBe(true);
      expect(ticket.disposition.first_reply_minutes).toBeGreaterThanOrEqual(0);
    }
  });

  it('keeps every disposition type present in both halves', () => {
    for (const half of [fit, report]) {
      expect(half.tickets.some((t) => t.disposition.escalated)).toBe(true);
      expect(half.tickets.some((t) => t.disposition.refund_issued)).toBe(true);
      expect(half.tickets.some((t) => t.disposition.macro_applied !== null)).toBe(true);
    }
  });

  it('represents every intent stratum in both halves (section 4.10)', () => {
    const fitIntents = new Set(fit.tickets.map((t) => t.intent));
    const reportIntents = new Set(report.tickets.map((t) => t.intent));
    for (const intent of loadTaxonomy().intents) {
      expect(fitIntents.has(intent.id), `fit half misses stratum ${intent.id}`).toBe(true);
      expect(reportIntents.has(intent.id), `report half misses stratum ${intent.id}`).toBe(true);
    }
  });

  it('marks every ticket as synthetic with a SYN- id', () => {
    for (const ticket of [...fit.tickets, ...report.tickets]) {
      expect(ticket.source).toBe('synthetic');
      expect(ticket.ticket_id.startsWith('SYN-')).toBe(true);
    }
  });
});

describe('conversations in the gold set (DEC-35, DEC-38, DEC-39)', () => {
  const { fit, report } = loadGoldSet();
  const halves: [string, GoldFile][] = [['fit', fit], ['report', report]];

  it('carries later turns, so the DEC-39 filter has something to remove', () => {
    for (const [name, half] of halves) {
      const later = half.tickets.filter((t) => !isFirstTurn(t));
      expect(later.length, `${name} half has no later turn`).toBeGreaterThan(0);
      expect(later.length).toBeLessThan(half.tickets.length);
    }
  });

  it('numbers every thread from 1 with no gap', () => {
    for (const [name, half] of halves) {
      const byConversation = new Map<string, number[]>();
      for (const ticket of half.tickets) {
        const id = ticket.conversation_id ?? '';
        expect(id.startsWith('CONV-SYN-'), `${name}: ${ticket.ticket_id} has no conversation`).toBe(true);
        byConversation.set(id, [...(byConversation.get(id) ?? []), ticket.turn_number ?? 0]);
      }
      for (const [id, numbers] of byConversation) {
        expect([...numbers].sort((a, b) => a - b), `${name}: ${id}`).toEqual(
          numbers.map((_, index) => index + 1),
        );
      }
    }
  });

  it('keeps every thread inside one half (DEC-31)', () => {
    const fitConversations = new Set(fit.tickets.map((t) => t.conversation_id));
    for (const ticket of report.tickets) {
      expect(
        fitConversations.has(ticket.conversation_id),
        `conversation ${String(ticket.conversation_id)} straddles the split`,
      ).toBe(false);
    }
  });

  it('records a reply on every turn that another turn follows, and on no other', () => {
    for (const [name, half] of halves) {
      const lastTurn = new Map<string, number>();
      for (const ticket of half.tickets) {
        const id = ticket.conversation_id ?? '';
        lastTurn.set(id, Math.max(lastTurn.get(id) ?? 0, ticket.turn_number ?? 0));
      }
      for (const ticket of half.tickets) {
        const isLast = lastTurn.get(ticket.conversation_id ?? '') === ticket.turn_number;
        expect(
          ticket.agent_reply === undefined,
          `${name}: ${ticket.ticket_id} reply presence is wrong`,
        ).toBe(isLast);
      }
    }
  });

  it('renders the earlier customer message and reply into a later turn history (DEC-37)', () => {
    const histories = conversationHistories(fit.tickets);
    const later = fit.tickets.find((t) => t.turn_number === 2);
    if (!later) throw new Error('the fit half carries no second turn');
    const previous = fit.tickets.find(
      (t) => t.conversation_id === later.conversation_id && t.turn_number === 1,
    );
    if (!previous) throw new Error(`conversation ${String(later.conversation_id)} has no first turn`);

    // The customer entry is the whole earlier message. `turn.body_text` holds
    // `ticket.ticketText`, which the intake adapter builds the same way, so a
    // body-only entry would send a prompt the runtime never sends.
    expect(histories.get(later.ticket_id)).toEqual([
      { turnNumber: 1, author: 'customer', bodyText: goldCaseText(previous) },
      { turnNumber: 1, author: 'agent', bodyText: previous.agent_reply },
    ]);
    expect(goldCaseText(previous)).toBe(`${previous.subject}\n\n${previous.body}`);
    // A first turn has nothing before it.
    expect(histories.get(previous.ticket_id)).toEqual([]);
  });
});

// The validators are the stated guard on a tampered or hand-edited corpus,
// so each rule gets a corpus that breaks exactly that rule. Asserting
// properties of the committed corpus proves the corpus, never the validator.
describe('the gold-half validator rejects a broken corpus', () => {
  function turn(overrides: Partial<GoldTicket> = {}): GoldTicket {
    return {
      ticket_id: 'SYN-000001',
      source: 'synthetic',
      conversation_id: 'CONV-SYN-000001',
      turn_number: 1,
      intent: 'refund-request',
      queue: 'billing',
      disposition: {
        escalated: false,
        macro_applied: null,
        refund_issued: false,
        first_reply_minutes: 30,
      },
      subject: 'Charged twice this month',
      body: 'I see two charges for one month.',
      ...overrides,
    };
  }

  function half(tickets: GoldTicket[]): unknown {
    return { split: 'fit', source: 'synthetic', count: tickets.length, tickets };
  }

  /** A well-formed two-turn thread, the baseline each case below breaks. */
  function thread(): [GoldTicket, GoldTicket] {
    return [
      turn({ agent_reply: 'We confirm the duplicate charge.' }),
      turn({ ticket_id: 'SYN-000002', turn_number: 2, body: 'This still happens.' }),
    ];
  }

  it('accepts the well-formed baseline', () => {
    expect(validateGoldHalf(half(thread()), 'fit').tickets).toHaveLength(2);
  });

  it('rejects a case with no conversation id (DEC-35)', () => {
    const orphan = turn();
    delete orphan.conversation_id;
    expect(() => validateGoldHalf(half([orphan]), 'fit')).toThrow(
      /conversation_id must start with CONV-SYN-/,
    );
  });

  it('rejects a turn number that is not a positive integer (DEC-38)', () => {
    expect(() => validateGoldHalf(half([turn({ turn_number: 0 })]), 'fit')).toThrow(
      /turn_number is not a positive integer/,
    );
  });

  it('rejects a thread whose turns skip a number', () => {
    const [first, second] = thread();
    expect(() =>
      validateGoldHalf(half([first, { ...second, turn_number: 3 }]), 'fit'),
    ).toThrow(/numbers its turns/);
  });

  it('rejects a repeated ticket id', () => {
    const [first, second] = thread();
    expect(() =>
      validateGoldHalf(half([first, { ...second, ticket_id: 'SYN-000001' }]), 'fit'),
    ).toThrow(/repeats ticket SYN-000001/);
  });

  it('rejects a thread that changes its disposition between turns', () => {
    const [first, second] = thread();
    const moved = {
      ...second,
      disposition: { ...second.disposition, escalated: true },
    };
    expect(() => validateGoldHalf(half([first, moved]), 'fit')).toThrow(
      /changes its disposition between turns/,
    );
  });

  // Without this rule a later turn's prompt silently loses the agent half of
  // the history, which is the exact thing the conversation corpus exists to
  // supply (DEC-37).
  it('rejects a turn that another turn follows but that records no reply', () => {
    const [first, second] = thread();
    const silent = { ...first };
    delete silent.agent_reply;
    expect(() => validateGoldHalf(half([silent, second]), 'fit')).toThrow(
      /has a later turn but no agent_reply/,
    );
  });

  it('rejects a reply recorded against the last turn of a thread', () => {
    const [first, second] = thread();
    expect(() =>
      validateGoldHalf(
        half([first, { ...second, agent_reply: 'We answered again.' }]),
        'fit',
      ),
    ).toThrow(/records a reply to its last turn/);
  });

  it('rejects a half that declares the wrong split', () => {
    expect(() => validateGoldHalf(half(thread()), 'report')).toThrow(/declares split fit/);
  });
});

describe('retrieval corpus', () => {
  const documents = loadDocuments();
  const taxonomy = loadTaxonomy();

  it('contains both documents and canonical resolutions (DEC-22)', () => {
    expect(documents.length).toBeGreaterThan(0);
    expect(documents.some((d) => d.kind === 'document')).toBe(true);
    expect(documents.some((d) => d.kind === 'canonical_resolution')).toBe(true);
  });

  it('declares an owner and a review date on every document (DEC-23)', () => {
    for (const document of documents) {
      expect(document.owner.length).toBeGreaterThan(0);
      expect(document.review_by).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(document.review_by))).toBe(false);
    }
  });

  it('links only intents that exist in the taxonomy', () => {
    expect(() => assertIntentsKnown(taxonomy, documents)).not.toThrow();
  });
});

describe('DEC-18 synthetic-only guarantee', () => {
  it('contains no email-shaped string anywhere under fixtures/', () => {
    const files = listFixtureFiles(fixturesDir());
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(EMAIL_PATTERN.test(file.content), `${file.path} matches the email pattern`).toBe(false);
    }
  });

  it('marks the corpus as synthetic throughout', () => {
    const files = listFixtureFiles(fixturesDir());
    const joined = files.map((f) => f.content).join('\n');
    expect(joined).toContain('"synthetic"');
    expect(joined).toContain('SYN-');
  });
});

function listFixtureFiles(dir: URL): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = [];
  const walk = (current: URL, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(new URL(`${entry.name}/`, current), `${prefix}${entry.name}/`);
      } else {
        out.push({
          path: `${prefix}${entry.name}`,
          content: readFileSync(new URL(entry.name, current), 'utf8'),
        });
      }
    }
  };
  walk(dir, '');
  return out;
}
