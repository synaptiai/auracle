// Validation tests for the synthetic fixture corpus.
//
// Decisions obeyed: DEC-18 (no real-looking data, no email-shaped strings),
// DEC-22 (documents + canonical resolutions), DEC-23 (owner + review_by on
// each document), DEC-31 (equal halves, no overlap), section 4.10
// (strata present in both halves), section 4.11 ('other' group kept).

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  CLAIM_GRADES,
  loadDocuments,
  validateTicketFields,
  loadGoldSet,
  loadTaxonomy,
  assertHalvesDisjoint,
  claimDigest,
  halfDigest,
  identityOf,
  loadGoldHalf,
  readHalfIdentity,
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

  // A half missing a grade lets the fitting job's separation check pass on the
  // easy negatives alone, which is the one thing that check exists to catch.
  // The hardest grade is the one that matters: a judge that cannot separate an
  // unstated detail from a stated one protects nothing on the automatic path.
  it('keeps every unsupported grade in both halves', () => {
    for (const half of [fit, report]) {
      const grades = new Set(
        half.tickets.flatMap((t) => (t.claims ?? []).filter((c) => !c.supported).map((c) => c.grade)),
      );
      expect([...grades].sort(), `${half.split} half`).toEqual(
        ['absent', 'off_topic', 'unstated_detail'],
      );
    }
  });

  // The two halves ask the judge disjoint sentences, so a judge sensitive to
  // one wording moves one half and the disagreement is visible. Before this
  // the halves shared all 56 sentences and the report half could only repeat
  // the fit half (DEC-31).
  it('asks the two halves disjoint claim sentences (DEC-31)', () => {
    const textsOf = (half: GoldFile) =>
      new Set(half.tickets.flatMap((t) => (t.claims ?? []).map((c) => claimDigest(c.text))));
    const fitTexts = textsOf(fit);
    const reportTexts = textsOf(report);
    expect(fitTexts.size).toBeGreaterThan(0);
    expect([...reportTexts].filter((d) => fitTexts.has(d))).toEqual([]);
  });

  // Precision counts grounded drafts above a threshold against every draft
  // above it. The halves held 167 and 195 of 385, which the equivalence
  // test rejects, and the register asked the reader to compensate for it.
  it('holds the same number of fully grounded drafts in each half', () => {
    const groundedIn = (half: GoldFile) =>
      half.tickets.filter((t) => (t.claims ?? []).length > 0
        && (t.claims ?? []).every((c) => c.supported)).length;
    expect(groundedIn(fit)).toBe(groundedIn(report));
  });

  it('splits the corpus into two disjoint halves of equal size', () => {
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

  // A labelled half drawn from an adopter's own history carries their ids,
  // not the generator's. The prefix rules describe the shipped corpus, so
  // they bind a half that claims to be it. Every other rule still binds.
  function realHalf(tickets: GoldTicket[]): unknown {
    return { split: 'fit', source: 'real', count: tickets.length, tickets };
  }

  function realTurn(overrides: Partial<GoldTicket> = {}): GoldTicket {
    return turn({
      ticket_id: 'order-4471@example.test',
      source: 'real',
      conversation_id: 'order-4471@example.test',
      ...overrides,
    });
  }

  it('accepts a half whose cases come from real history', () => {
    const half = realHalf([
      realTurn(),
      realTurn({ ticket_id: 'order-4471-late@example.test', turn_number: 2, body: 'Still nothing.' }),
    ]);
    const loaded = validateGoldHalf(half, 'fit');
    expect(loaded.source).toBe('real');
    expect(loaded.tickets).toHaveLength(2);
  });

  it('refuses a provenance outside the closed set', () => {
    expect(() => validateGoldHalf({ ...(realHalf([realTurn()]) as object), source: 'imap' }, 'fit'))
      .toThrow(/declares source imap/);
  });

  it('still holds a real half to every rule that is not about the shipped corpus', () => {
    expect(() => validateGoldHalf(realHalf([realTurn({ turn_number: 0 })]), 'fit'))
      .toThrow(/turn_number is not a positive integer/);
    const orphan = realTurn();
    delete orphan.conversation_id;
    expect(() => validateGoldHalf(realHalf([orphan]), 'fit')).toThrow(/names no conversation/);
    // The turn-numbering check sits above the synthetic-only reply rule, and
    // it must stay there. A gap makes a rendered history quote a turn the
    // file does not hold, whatever the provenance.
    expect(() =>
      validateGoldHalf(
        realHalf([
          realTurn({ agent_reply: 'We are looking into it.' }),
          realTurn({ ticket_id: 'later@example.test', turn_number: 3 }),
        ]),
        'fit',
      ),
    ).toThrow(/numbers its turns/);
  });

  it('reads a half held outside the repository, and names that path in a fault', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gold-half-'));
    try {
      const file = join(dir, 'fit.json');
      writeFileSync(file, JSON.stringify(realHalf([realTurn()])));
      expect(loadGoldHalf('fit', file).source).toBe('real');

      const broken = join(dir, 'broken.json');
      writeFileSync(broken, JSON.stringify({ ...(realHalf([realTurn()]) as object), count: 9 }));
      expect(() => loadGoldHalf('fit', broken)).toThrow(new RegExp(broken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Node embeds a window of the input in a JSON SyntaxError. Step 5 of the
  // curation loop has a person hand-write these two files, so a trailing
  // comma is the commonest fault there is — and it would put a customer's
  // body on stderr and into CI (DEC-18). The export guards its own parse for
  // exactly this reason; the guard belongs on every parse of real data.
  it('never quotes the file when it cannot be parsed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gold-parse-'));
    try {
      const path = join(dir, 'fit.json');
      // A trailing comma after a value: Node reports it with a snippet.
      writeFileSync(path, '{"split":"fit","source":"real","count":1,"tickets":[{"body":"my card was declined"},]}');
      const call = () => loadGoldHalf('fit', path);
      expect(call).toThrow(/not valid JSON/);
      expect(call).toThrow(/content withheld/);
      expect(call).not.toThrow(/card was declined/);
      // The path is the operator's own and stays, so they know which file.
      expect(call).toThrow(new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('proves two halves disjoint by identifier, and refuses an overlap (DEC-31)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gold-halves-'));
    try {
      const fitPath = join(dir, 'fit.json');
      const reportPath = join(dir, 'report.json');
      // The claim carries a name and an account number, so the key guard
      // below tests something: a member holding the sentence itself, rather
      // than its digest, would show them here.
      writeFileSync(fitPath, JSON.stringify(realHalf([realTurn({
        claims: [{
          text: 'Ada Lovelace asked us to close account 44812.',
          doc_id: 'DOC-SYN-001', supported: true, grade: null,
        }],
      })])));
      writeFileSync(
        reportPath,
        JSON.stringify({
          split: 'report',
          source: 'real',
          count: 1,
          tickets: [realTurn({ ticket_id: 'other@example.test', conversation_id: 'other@example.test' })],
        }),
      );

      const fitIdentity = readHalfIdentity(fitPath, 'fit');
      const reportIdentity = readHalfIdentity(reportPath, 'report');
      // Identifiers alone. No case text crosses into a fitting job.
      expect(fitIdentity.ticketIds.has('order-4471@example.test')).toBe(true);
      expect(Object.keys(fitIdentity)).toEqual([
        'split', 'source', 'ticketIds', 'conversationIds',
        'claimDigests', 'groundedDrafts', 'draftsWithClaims',
      ]);
      // The three members added for the coverage split carry a digest and two
      // counts. A claim sentence is free text with no safe printable form, so
      // none of it may reach an identity a fault message reads (DEC-18).
      expect(fitIdentity.claimDigests.size).toBe(1);
      for (const digest of fitIdentity.claimDigests) expect(digest).toMatch(/^[0-9a-f]{12}$/);
      const asText = JSON.stringify([...fitIdentity.claimDigests]);
      expect(asText).not.toContain('Ada Lovelace');
      expect(asText).not.toContain('44812');
      expect(() => assertHalvesDisjoint(fitIdentity, reportIdentity)).not.toThrow();

      const shared = join(dir, 'shared.json');
      writeFileSync(
        shared,
        JSON.stringify({ split: 'report', source: 'real', count: 1, tickets: [realTurn()] }),
      );
      expect(() => assertHalvesDisjoint(fitIdentity, readHalfIdentity(shared, 'report')))
        .toThrow(/appears in both halves/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses halves that share a conversation but no case (DEC-31)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gold-conv-'));
    try {
      const fitPath = join(dir, 'fit.json');
      const reportPath = join(dir, 'report.json');
      writeFileSync(fitPath, JSON.stringify(realHalf([realTurn()])));
      writeFileSync(
        reportPath,
        JSON.stringify({
          split: 'report',
          source: 'real',
          count: 1,
          // A different case, the same thread. Fitting on one turn and
          // publishing on another turn of one conversation is the leak
          // DEC-31 forbids.
          tickets: [realTurn({ ticket_id: 'later@example.test' })],
        }),
      );
      expect(() => assertHalvesDisjoint(readHalfIdentity(fitPath, 'fit'), readHalfIdentity(reportPath, 'report')))
        .toThrow(/conversation .* appears in both halves/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The digest's whole purpose is comparability across two runs, so its
  // order independence is the property that matters. Every earlier assertion
  // compared halfDigest(x) to halfDigest(x), which passes with the sort
  // removed.
  it('names a case set independently of the order the file listed it in', () => {
    const a = realTurn();
    const b = realTurn({ ticket_id: 'b@example.test', conversation_id: 'b@example.test' });
    const c = realTurn({ ticket_id: 'c@example.test', conversation_id: 'c@example.test' });
    const forward = identityOf({ split: 'fit', source: 'real', count: 3, tickets: [a, b, c] });
    const reversed = identityOf({ split: 'fit', source: 'real', count: 3, tickets: [c, b, a] });
    expect(halfDigest(forward)).toBe(halfDigest(reversed));

    // And it must actually depend on the set: a different case set is a
    // different name, or the digest proves nothing.
    const different = identityOf({ split: 'fit', source: 'real', count: 3, tickets: [a, b, realTurn({ ticket_id: 'd@example.test', conversation_id: 'd@example.test' })] });
    expect(halfDigest(different)).not.toBe(halfDigest(forward));
    expect(halfDigest(forward)).toMatch(/^[0-9a-f]{16}$/);
  });

  // A sentence on both sides is the leak the ticket and conversation checks
  // cannot see. Two halves can hold disjoint cases and still ask the judge the
  // same 56 sentences, and then a judge that mis-reads one of them depresses
  // both halves alike. The report half stops corroborating the fit half and
  // merely repeats it (DEC-31).
  it('refuses halves that share a claim sentence (DEC-31)', () => {
    const shared = { text: 'The article explains renewal dates.', doc_id: 'DOC-SYN-001', supported: true, grade: null };
    const fit = identityOf({
      split: 'fit', source: 'synthetic', count: 1,
      tickets: [turn({ claims: [shared] })],
    });
    const report = identityOf({
      split: 'report', source: 'synthetic', count: 1,
      tickets: [turn({ ticket_id: 'SYN-000002', conversation_id: 'CONV-SYN-000002', claims: [shared] })],
    });
    expect(() => assertHalvesDisjoint(fit, report)).toThrow(/claim sentence/);
  });

  // On a real half a claim sentence is the customer's own text, or an agent's
  // words about their account. It reaches a terminal and a CI log, which is
  // exactly where DEC-18 says such a value may not go. So the sentence is
  // named by digest, like every other case value, and never printed.
  it('names a shared claim sentence by digest, never in full', () => {
    const secret = { text: 'Ada Lovelace at ada@customer-domain.example asked to close account 44812.', doc_id: 'DOC-SYN-001', supported: true, grade: null };
    const fit = identityOf({
      split: 'fit', source: 'real', count: 1,
      tickets: [realTurn({ claims: [secret] })],
    });
    const report = identityOf({
      split: 'report', source: 'real', count: 1,
      tickets: [realTurn({ ticket_id: 'other@customer-domain.example', conversation_id: 'other@customer-domain.example', claims: [secret] })],
    });
    const call = () => assertHalvesDisjoint(fit, report);
    expect(call).toThrow(/claim sentence digest [0-9a-f]{12}/);
    expect(call).not.toThrow(/Ada Lovelace/);
    expect(call).not.toThrow(/customer-domain/);
    expect(call).not.toThrow(/44812/);
  });

  // Precision counts grounded drafts above a threshold against all drafts
  // above it, so a half holding more grounded drafts is the easier one and a
  // precision published from it reads high. The guard is an equivalence test:
  // the halves must show the gap is SMALL, which is a different claim from a
  // significance test's "the gap is not proven real".
  describe('the grounded-share equivalence guard (DEC-31)', () => {
    const grounded = (i: number, split: 'fit' | 'report') => turn({
      ticket_id: `SYN-${split}-${i}`, conversation_id: `CONV-${split}-${i}`,
      claims: [{ text: `supported ${split} ${i}`, doc_id: 'DOC-SYN-001', supported: true, grade: null }],
    });
    const ungrounded = (i: number, split: 'fit' | 'report') => turn({
      ticket_id: `SYN-${split}-${i}`, conversation_id: `CONV-${split}-${i}`,
      claims: [{ text: `unsupported ${split} ${i}`, doc_id: 'DOC-SYN-001', supported: false, grade: 'absent' }],
    });
    const build = (split: 'fit' | 'report', groundedCount: number, n: number) => identityOf({
      split, source: 'synthetic', count: n,
      tickets: Array.from({ length: n }, (_, i) =>
        (i < groundedCount ? grounded : ungrounded)(i, split)),
    });
    const pair = (ka: number, na: number, kb: number, nb: number) =>
      () => { assertHalvesDisjoint(build('fit', ka, na), build('report', kb, nb)); };

    it('refuses a gap that would flatter a published precision', () => {
      // 20 percent grounded against 60 percent. The report half is far easier.
      expect(pair(120, 600, 360, 600)).toThrow(/grounded share/);
    });

    it('accepts halves whose shares are shown to be close', () => {
      expect(pair(400, 800, 400, 800)).not.toThrow();
    });

    // The direction a significance test had backwards. Identical shares over a
    // hundred drafts a side demonstrate nothing about a five point margin: the
    // interval for the difference is 11.6 points wide. The old test asserted
    // that such a pair "must be accepted", which is exactly the trivial pass
    // that let a small half through unchecked. A half this small cannot fit a
    // threshold either (see minimumSupport), so nothing is lost by refusing.
    it('refuses halves too small to demonstrate closeness, even at equal shares', () => {
      expect(pair(50, 100, 50, 100)).toThrow(/not shown to be equally hard/);
    });

    // The boundary the textbook interval cannot see. At a share of exactly 0
    // or exactly 1 the plain standard error is zero, so the interval collapses
    // to a point and ANY size passes — one draft a side "demonstrates
    // closeness". That is the trivial pass this guard replaced a significance
    // test to remove, reappearing at the edge of the range.
    it.each([
      ['every draft grounded', 1, 1],
      ['no draft grounded', 0, 0],
    ])('refuses a one-draft pair where %s', (_name, ka, kb) => {
      expect(pair(ka, 1, kb, 1)).toThrow(/not shown to be equally hard/);
    });

    // And the same shares at a real size still pass, so the correction did not
    // simply refuse everything at the boundary.
    it('accepts halves that are entirely grounded at a size that shows it', () => {
      expect(pair(400, 400, 400, 400)).not.toThrow();
    });

    // And the other direction the old test had backwards: a bigger corpus was
    // allowed a bigger gap, because a bigger corpus makes a gap significant
    // rather than making it matter. 400 against 412 of 800 is 1.5 points and
    // the old test passed it; it is refused here only because 800 drafts a
    // side cannot yet place it inside five points.
    it('reads the margin, not the significance', () => {
      expect(pair(400, 800, 412, 800)).toThrow(/grounded share/);
    });

    // The pair that motivated the guard. The corpus this repository shipped
    // held these counts, and section 6 asked the reader to compensate.
    it('still refuses the halves this repository actually shipped', () => {
      expect(pair(167, 385, 195, 385)).toThrow(/grounded share/);
    });
  });

  it('refuses halves of different sizes (DEC-31)', () => {
    const one = identityOf({ split: 'fit', source: 'real', count: 1, tickets: [realTurn()] });
    const two = identityOf({
      split: 'report', source: 'real', count: 2,
      tickets: [
        realTurn({ ticket_id: 'x@example.test', conversation_id: 'x@example.test' }),
        realTurn({ ticket_id: 'y@example.test', conversation_id: 'y@example.test' }),
      ],
    });
    expect(() => assertHalvesDisjoint(one, two)).toThrow(/two halves of equal size/);
  });

  // Pairing an own fit half with a copy of the shipped report half passed
  // trivially: SYN- ids never collide with real ones, so the proof held
  // against a set nobody would ever publish from.
  it('refuses halves of different provenance (DEC-18, DEC-31)', () => {
    const real = identityOf({ split: 'fit', source: 'real', count: 1, tickets: [realTurn()] });
    const synthetic = identityOf({ split: 'report', source: 'synthetic', count: 1, tickets: [turn()] });
    expect(() => assertHalvesDisjoint(real, synthetic)).toThrow(/different provenance/);
  });

  // A real identifier is a Message-ID: it carries the customer's domain, and
  // a fault reaches a terminal and a CI log (DEC-18).
  it('names a real case by digest, and a synthetic one plainly', () => {
    const shared = realTurn();
    const fit = identityOf({ split: 'fit', source: 'real', count: 1, tickets: [shared] });
    const report = identityOf({ split: 'report', source: 'real', count: 1, tickets: [shared] });
    expect(() => assertHalvesDisjoint(fit, report)).toThrow(/id digest [0-9a-f]{12}/);
    expect(() => assertHalvesDisjoint(fit, report)).not.toThrow(/example\.test/);

    const synth = turn();
    expect(() => assertHalvesDisjoint(
      identityOf({ split: 'fit', source: 'synthetic', count: 1, tickets: [synth] }),
      identityOf({ split: 'report', source: 'synthetic', count: 1, tickets: [synth] }),
    )).toThrow(/ticket SYN-000001 appears in both halves/);
  });

  // The ticket assert fires first when both halves share a case, so the
  // conversation arm's own redaction was never reached by any test.
  it('names a shared conversation by digest too', () => {
    const first = realTurn();
    const later = realTurn({ ticket_id: 'later@customer-domain.example' });
    delete later.agent_reply;
    const fit = identityOf({ split: 'fit', source: 'real', count: 1, tickets: [first] });
    const report = identityOf({ split: 'report', source: 'real', count: 1, tickets: [later] });
    const call = () => assertHalvesDisjoint(fit, report);
    expect(call).toThrow(/conversation with id digest [0-9a-f]{12} appears in both halves/);
    expect(call).not.toThrow(/customer-domain\.example/);
  });

  // A real half's cases reach these validators through loadGoldHalf on the
  // path an operator uses, so a fault here is the commonest leak of all.
  it('names a real case by digest in every validator, not only the split check', () => {
    const leaky = realTurn({ ticket_id: 'leak@customer-domain.example', body: '' });
    const call = () => validateGoldHalf(realHalf([leaky]), 'fit');
    expect(call).toThrow(/id digest [0-9a-f]{12}/);
    expect(call).not.toThrow(/customer-domain\.example/);

    const badTurns = () => validateGoldHalf(
      realHalf([realTurn({ ticket_id: 'x@customer-domain.example', turn_number: 2 })]),
      'fit',
    );
    expect(badTurns).toThrow(/numbers its turns/);
    expect(badTurns).not.toThrow(/customer-domain\.example/);
  });

  it('reports an overlap before a size mismatch, because the overlap is graver', () => {
    const shared = realTurn();
    const fit = identityOf({ split: 'fit', source: 'real', count: 1, tickets: [shared] });
    const report = identityOf({
      split: 'report', source: 'real', count: 2,
      tickets: [shared, realTurn({ ticket_id: 'b@example.test', conversation_id: 'b@example.test' })],
    });
    expect(() => assertHalvesDisjoint(fit, report)).toThrow(/appears in both halves/);
  });

  it('refuses a case whose provenance disagrees with its half, naming it by digest', () => {
    const call = () => validateGoldHalf(
      realHalf([realTurn({ ticket_id: 'x@customer-domain.example', source: 'synthetic' })]),
      'fit',
    );
    expect(call).toThrow(/declares source synthetic, but its half declares real/);
    // This case sat on the leaking line and asserted only the message text,
    // while every sibling paired the assertion with this one.
    expect(call).not.toThrow(/customer-domain\.example/);
  });

  // validateTicket's own five faults were the last raw-identifier path.
  it.each([
    ['a missing turn number', 'turn_number', /turn_number is not a positive integer/],
    ['a missing conversation', 'conversation_id', /names no conversation/],
  ] as const)('names a real case by digest on %s', (_name, field, pattern) => {
    const broken: Record<string, unknown> = { ...realTurn({ ticket_id: 'y@customer-domain.example' }) };
    delete broken[field];
    const call = () => validateGoldHalf(
      { split: 'fit', source: 'real', count: 1, tickets: [broken] },
      'fit',
    );
    expect(call).toThrow(pattern);
    expect(call).not.toThrow(/customer-domain\.example/);
  });

  it('names a real case by digest on an empty agent reply', () => {
    const call = () => validateGoldHalf(
      realHalf([realTurn({ ticket_id: 'y@customer-domain.example', agent_reply: '' })]),
      'fit',
    );
    expect(call).toThrow(/agent_reply is present but empty/);
    expect(call).not.toThrow(/customer-domain\.example/);
  });

  it('names a repeated real ticket and a conversation fault by digest', () => {
    const one = realTurn({ ticket_id: 'dup@customer-domain.example' });
    const repeated = () => validateGoldHalf(realHalf([one, { ...one }]), 'fit');
    expect(repeated).toThrow(/repeats ticket with id digest [0-9a-f]{12}/);
    expect(repeated).not.toThrow(/customer-domain\.example/);

    const gap = () => validateGoldHalf(
      realHalf([realTurn({ ticket_id: 'g@customer-domain.example', turn_number: 2 })]),
      'fit',
    );
    expect(gap).toThrow(/conversation with id digest [0-9a-f]{12} numbers its turns/);
    expect(gap).not.toThrow(/customer-domain\.example/);
  });

  it('refuses two halves that declare the same split (DEC-31)', () => {
    const one = identityOf({
      split: 'fit', source: 'real', count: 1, tickets: [realTurn()],
    });
    const two = identityOf({
      split: 'fit', source: 'real', count: 1,
      tickets: [realTurn({ ticket_id: 'other@example.test', conversation_id: 'other@example.test' })],
    });
    // Disjoint by identifier, and still not a fit-and-report pair. Two fit
    // halves prove nothing about what a report half holds.
    expect(() => assertHalvesDisjoint(one, two)).toThrow(/both halves declare split fit/);
  });

  it('still holds a synthetic half to the shipped-corpus id rules', () => {
    expect(() => validateGoldHalf(half([turn({ ticket_id: 'order-1@example.test' })]), 'fit'))
      .toThrow(/must start with SYN-/);
    // Its sibling conditional. Both became provenance-scoped in the same
    // refactor; only one had a case, so the DEC-35 prefix rule on the
    // committed corpus was unproven.
    expect(() => validateGoldHalf(half([turn({ conversation_id: 'CONV-1' })]), 'fit'))
      .toThrow(/must start with CONV-SYN-/);
  });

  it('rejects a case with no conversation id (DEC-35)', () => {
    const orphan = turn();
    delete orphan.conversation_id;
    expect(() => validateGoldHalf(half([orphan]), 'fit')).toThrow(/names no conversation/);
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

// Per-claim ground truth for the groundedness fit (DEC-07). The loader
// validates it, so these cases feed it corpora broken one rule at a time
// rather than asserting what loadGoldSet already enforced.
describe('claim ground truth', () => {
  const claim = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    text: 'The article lists the refund windows for each plan.',
    doc_id: 'DOC-SYN-002',
    supported: true,
    grade: null,
    ...over,
  });

  function ticketWith(claims: unknown): Record<string, unknown> {
    return {
      ticket_id: 'SYN-TEST-1',
      source: 'synthetic',
      intent: 'refund-request',
      queue: 'billing',
      disposition: { escalated: false, macro_applied: null, refund_issued: false, first_reply_minutes: 5 },
      subject: 'Subject',
      body: 'Body',
      claims,
    };
  }

  it('accepts a case whose claims are well formed', () => {
    expect(() =>
      validateTicketFields(ticketWith([claim(), claim({ supported: false, grade: 'absent' })]), 'synthetic'),
    ).not.toThrow();
  });

  it('accepts a case that carries no claims at all', () => {
    // A real-corpus record has none, because nobody has labelled it.
    const ticket = ticketWith(undefined);
    delete ticket['claims'];

    expect(() => validateTicketFields(ticket, 'synthetic')).not.toThrow();
  });

  it('refuses an empty claims array', () => {
    // Coverage would be nothing over nothing.
    expect(() => validateTicketFields(ticketWith([]), 'synthetic')).toThrow(/empty claims array/);
  });

  it('refuses a supported claim that names a grade', () => {
    expect(() =>
      validateTicketFields(ticketWith([claim({ grade: 'absent' })]), 'synthetic'),
    ).toThrow(/supported and names a grade/);
  });

  it('refuses an unsupported claim that names no grade', () => {
    // The grade is what makes a per-grade report possible, so a fit cannot
    // hide behind the easy negatives.
    expect(() =>
      validateTicketFields(ticketWith([claim({ supported: false, grade: null })]), 'synthetic'),
    ).toThrow(/names no known grade/);
  });

  it('refuses an unknown grade', () => {
    expect(() =>
      validateTicketFields(ticketWith([claim({ supported: false, grade: 'tricky' })]), 'synthetic'),
    ).toThrow(/names no known grade/);
  });

  it('refuses a claim that cites no document', () => {
    expect(() => validateTicketFields(ticketWith([claim({ doc_id: '' })]), 'synthetic')).toThrow(/cites no document/);
  });

  it('gives the committed corpus both classes and all three grades', () => {
    // A fit needs both classes present. A corpus of grounded drafts alone
    // would make the job refuse, correctly, and prove nothing.
    const gold = loadGoldSet();
    const claims = gold.fit.tickets.flatMap((t) => t.claims ?? []);
    const grounded = gold.fit.tickets.filter((t) => (t.claims ?? []).every((c) => c.supported));

    expect(claims.length).toBeGreaterThan(0);
    expect(grounded.length).toBeGreaterThan(0);
    expect(grounded.length).toBeLessThan(gold.fit.tickets.length);
    expect(new Set(claims.filter((c) => !c.supported).map((c) => c.grade))).toEqual(
      new Set(['off_topic', 'absent', 'unstated_detail']),
    );
  });

  it('every claim cites a document that exists in the corpus', () => {
    const docIds = new Set(loadDocuments().map((d) => d.doc_id));
    const gold = loadGoldSet();
    const cited = new Set(
      [...gold.fit.tickets, ...gold.report.tickets].flatMap((t) => (t.claims ?? []).map((c) => c.doc_id)),
    );

    for (const id of cited) expect(docIds).toContain(id);
  });
});

// The invariant the corpus rests on, held by a case rather than by a commit
// message. A review reverted the generator line that enforces it, regenerated,
// and every one of the 679 tests stayed green while 13 mislabelled claims
// shipped — including CI's corpus-versus-generator diff, because the corpus
// was regenerated too. Nothing anywhere fired.
describe('no claim is labelled against evidence the judge can see', () => {
  /** The text each document's supported claim asserts, from the corpus itself. */
  function supportedTexts(): Map<string, string> {
    const byText = new Map<string, string>();
    const gold = loadGoldSet();
    for (const ticket of [...gold.fit.tickets, ...gold.report.tickets]) {
      for (const claim of ticket.claims ?? []) {
        if (claim.supported) byText.set(claim.text, claim.doc_id);
      }
    }
    return byText;
  }

  it.each(CLAIM_GRADES)(
    'never gives a %s claim text a document the draft cites already supports',
    (grade) => {
      // Every grade, not off_topic alone. The gate is given every document any
      // claim cites, so text whose own source is in that set puts the claim's
      // evidence in front of the judge: a claim labelled unsupported is
      // supported, and a better judge scores worse. Held per grade because an
      // earlier version guarded one of the three while its own title claimed
      // all of them, and 88 claims could ship mislabelled in another grade.
      const source = supportedTexts();
      const gold = loadGoldSet();
      const offenders = new Set<string>();

      for (const half of [gold.fit, gold.report]) {
        for (const ticket of half.tickets) {
          const claims = ticket.claims ?? [];
          const retrieved = new Set(claims.map((c) => c.doc_id));
          for (const claim of claims) {
            if (claim.supported || claim.grade !== grade) continue;
            const from = source.get(claim.text);
            if (from !== undefined && retrieved.has(from)) offenders.add(ticket.ticket_id);
          }
        }
      }

      expect([...offenders]).toEqual([]);
    },
  );

  it('gives every supported claim a text its own document actually states', () => {
    // The other direction, which had no guard: a claim labelled supported
    // whose document says nothing of it. An earlier version of this case
    // asserted that no text appears under two documents, which the generator
    // guarantees before a fixture is written, and that every document has at
    // least one text, which Set.add makes unconditional. Both were tautologies
    // and 84 mislabels passed them.
    //
    // The check is mechanical: a supported claim must share a distinctive
    // term with the body of the document it cites. The judge is given the
    // body and nothing else, so a claim built from a document's TITLE names
    // nothing the judge can see — the defect found by hand in three separate
    // cycles, and by this rule in two more the sweeps missed.
    const STOPWORDS = new Set([
      'the', 'a', 'an', 'this', 'that', 'of', 'and', 'or', 'for', 'to', 'in',
      'on', 'with', 'per', 'each', 'every', 'article', 'case', 'records',
      'covers', 'explains', 'lists', 'shows', 'describes', 'walks', 'through',
      'outcome', 'what', 'where', 'how', 'it', 'its', 'is', 'are', 'was',
      'were', 'queue', 'confirmed', 'stated', 'states',
    ]);
    const terms = (text: string): Set<string> =>
      new Set(
        text
          .toLowerCase()
          .split(/[^a-z0-9-]+/)
          .filter((w) => w.length > 0 && !STOPWORDS.has(w)),
      );

    const bodies = new Map(loadDocuments().map((d) => [d.doc_id, terms(d.body)]));
    const gold = loadGoldSet();
    const offenders: string[] = [];

    for (const half of [gold.fit, gold.report]) {
      for (const ticket of half.tickets) {
        for (const claim of ticket.claims ?? []) {
          if (!claim.supported) continue;
          const body = bodies.get(claim.doc_id);
          if (body === undefined) continue;
          const shared = [...terms(claim.text)].filter((w) => body.has(w));
          if (shared.length === 0) offenders.push(`${claim.doc_id}: ${claim.text}`);
        }
      }
    }

    expect([...new Set(offenders)]).toEqual([]);
  });

  it('never gives a supported claim a negation or a quantity its body lacks', () => {
    // The overlap rule above is a topicality floor, not a support test: a
    // claim can share every term and still be false. Changing one string to
    // "lists NO refund windows for ANY plan" shipped 93 mislabels through it.
    //
    // Negation and quantity are the two ways a claim built from a body's own
    // words can contradict it, and both are mechanical. Entailment in general
    // is not, which is why the strings are pinned below as well.
    // Widened after a harness showed `other than`, `excludes`, `fails to`,
    // `rarely` and the quantity words `six`, `dozen`, `half` and `twice` all
    // passed while contradicting their body.
    const NEGATION =
      /\b(no|not|never|none|neither|nor|without|any|except|excludes?|excluding|omits?|fails? to|rarely|seldom|other than|unlike|instead of)\b/i;
    const QUANTITY =
      /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|dozen|half|twice|thirty|ninety|several|many|few|all|both)\b/gi;
    const gold = loadGoldSet();
    const bodies = new Map(loadDocuments().map((d) => [d.doc_id, d.body.toLowerCase()]));
    const offenders: string[] = [];

    for (const half of [gold.fit, gold.report]) {
      for (const ticket of half.tickets) {
        for (const claim of ticket.claims ?? []) {
          if (!claim.supported) continue;
          const body = bodies.get(claim.doc_id) ?? '';
          if (NEGATION.test(claim.text) && !NEGATION.test(body)) {
            offenders.push(`negation: ${claim.text}`);
          }
          // Token match, not substring: `body.includes('one')` was true for a
          // body containing `timezone`, so a quantity of one passed unchecked
          // on every claim citing that document.
          const bodyTokens = new Set(body.split(/[^a-z0-9]+/).filter((w) => w.length > 0));
          for (const number of claim.text.match(QUANTITY) ?? []) {
            if (!bodyTokens.has(number.toLowerCase())) {
              offenders.push(`quantity ${number}: ${claim.text}`);
            }
          }
        }
      }
    }

    expect([...new Set(offenders)]).toEqual([]);
  });

  it('pins every document body, the other half of every entailment', () => {
    // The claim pin holds one side. Editing a body so it no longer states a
    // claim broke nothing: the guards still passed, the snapshot was
    // unchanged, and the corpus-versus-generator diff passed because the
    // corpus regenerates. Support is claim against body, so both are pinned.
    expect(loadDocuments().map((d) => `${d.doc_id}|${d.body}`).sort()).toMatchInlineSnapshot(`
      [
        "DOC-SYN-001|This article explains renewal dates, proration and where the finance archive lists every past invoice copy.",
        "DOC-SYN-002|This article lists the refund windows per plan and the steps that the billing queue follows for each case.",
        "DOC-SYN-003|This article describes period-end closure, what happens to stored records and how reactivation works.",
        "DOC-SYN-004|This article walks through the deletion policy, the verification step and the erase window per region.",
        "DOC-SYN-005|This article covers pause states, error codes such as E-412 and the reconnect procedure for stalled clients.",
        "DOC-SYN-006|This article explains the recovery flow when the second factor and the backup codes are both unavailable.",
        "DOC-SYN-007|This article lists the export formats, the empty-archive causes and the retry rule for partial exports.",
        "DOC-SYN-008|This article shows the cursor parameter, the page size default and the header that reports the next cursor.",
        "DOC-SYN-009|This article explains the retry schedule after a declined card, the grace period before suspension and how to update a payment method.",
        "DOC-SYN-010|This article describes upgrades that apply at once, downgrades that wait for the period end and the proration rule that applies to each.",
        "DOC-SYN-011|This article walks through the first sign-in, inviting colleagues and the setup checklist that appears on the dashboard.",
        "DOC-SYN-012|This article collects the tasks people ask about most, with the steps for each and a link to the deeper reference.",
        "DOC-SYN-013|This article sets out the pricing tiers, what each tier includes and how usage above the included amount is charged.",
        "DOC-SYN-014|This article explains where to report a missing or unclear page, what the report should carry and how the docs team acknowledges it.",
        "DOC-SYN-015|This article describes the feedback channels, how the product team groups what arrives and what happens to a suggestion that many people send.",
        "DOC-SYN-016|This article explains what a good bug report carries, how severity is assigned and where to watch for the fix.",
        "DOC-SYN-017|This article covers the mobile sign-in, the features that differ from the desktop client and the offline behaviour of the app.",
        "DOC-SYN-018|This article explains when a ticket may be escalated, who reviews an escalation and what the requester is told.",
        "DOC-SYN-019|This article explains the lines on an invoice, where taxes appear and how a credit note is shown.",
        "DOC-SYN-020|This article describes enrolling a second factor, replacing a lost device and the recovery codes issued at enrolment.",
        "DOC-SYN-021|This article covers registering a webhook, the retry policy for a failed delivery and the signature that proves an event came from us.",
        "DOC-SYN-022|This article explains where the status page lives, how an incident is graded and where past incidents are listed.",
        "RES-SYN-101|Outcome: the billing queue verified the double charge, refunded the duplicate and confirmed the correct renewal date.",
        "RES-SYN-102|Outcome: the accounts queue cleared the blocked send, issued a fresh reset message and confirmed sign-in.",
        "RES-SYN-103|Outcome: the billing queue scheduled closure for the period end and sent the confirmation with the final invoice.",
        "RES-SYN-104|Outcome: the technical queue rotated the stale token, updated the integration scope and stopped the daily drop.",
        "RES-SYN-105|Outcome: the accounts queue matched the timezone offset, rescheduled the digest and verified the delivery slot.",
        "RES-SYN-106|Outcome: the technical queue matched the slowdown to the active incident and attached the ticket to its tracker.",
        "RES-SYN-107|Outcome: the billing queue confirmed the declined card, took an updated method and cleared the balance.",
        "RES-SYN-108|Outcome: the billing queue applied the upgrade at once, prorated the remaining period and confirmed the new amount.",
        "RES-SYN-109|Outcome: the accounts queue walked the customer through the checklist, invited the remaining colleagues and confirmed the workspace was ready.",
        "RES-SYN-110|Outcome: the general queue explained the tier boundaries, compared the usage on the account and confirmed the tier that fits.",
        "RES-SYN-111|Outcome: the docs team reproduced the confusion, rewrote the unclear step and published the corrected page.",
        "RES-SYN-112|Outcome: the technical queue reproduced the fault, graded it minor and released the fix.",
        "RES-SYN-113|Outcome: the technical queue cleared the stored session, guided a fresh sign-in and confirmed the app worked.",
        "RES-SYN-114|Outcome: the technical queue traced the rejected events, corrected the signing secret and confirmed delivery resumed.",
        "RES-SYN-115|Outcome: the general queue recorded the request, linked it to the existing group and told the customer where to follow it.",
        "RES-SYN-116|Outcome: the technical queue found the interrupted export, ran it again and delivered the complete archive.",
        "RES-SYN-117|Outcome: the accounts queue verified the requester, ran the deletion and sent the written confirmation.",
      ]
    `);
  });

  it('pins every unsupported claim string too', () => {
    // The third side. A claim graded absent that paraphrases its body is
    // supported in fact, so a correct judge is scored wrong and the fit reads
    // a depressed precision. The grade cases catch an exact collision with a
    // supported text and nothing weaker: giving RES-SYN-106 an absent claim
    // that restates its second clause passed all 47 cases.
    const gold = loadGoldSet();
    const byDoc = new Map<string, Set<string>>();
    for (const half of [gold.fit, gold.report]) {
      for (const ticket of half.tickets) {
        for (const claim of ticket.claims ?? []) {
          if (claim.supported) continue;
          const key = `${claim.doc_id}|${claim.grade ?? ''}`;
          byDoc.set(key, (byDoc.get(key) ?? new Set()).add(claim.text));
        }
      }
    }
    // off_topic borrows another document's text, so it is keyed by the doc it
    // cites and its content is pinned by the supported snapshot already.
    const graded = [...byDoc.entries()]
      .filter(([key]) => !key.endsWith('|off_topic'))
      .map(([key, texts]) => `${key}|${[...texts].sort().join('|')}`)
      .sort();

    expect(graded).toMatchInlineSnapshot(`
      [
        "DOC-SYN-001|absent|Every account owner receives a monthly invoice by email.|Invoices are emailed to every account owner each month.",
        "DOC-SYN-001|unstated_detail|Invoice copies stay in the finance archive for seven years.|The finance archive keeps invoice copies for seven years.",
        "DOC-SYN-002|absent|A refund is approved automatically when the plan is annual.|An annual plan has its refunds approved without review.",
        "DOC-SYN-002|unstated_detail|An annual plan carries a longer refund window.|The refund window is longer on an annual plan.",
        "DOC-SYN-003|absent|A closed subscription is announced to every collaborator.|Every collaborator is told when a subscription closes.",
        "DOC-SYN-003|unstated_detail|Closure removes the stored records after fourteen days.|Stored records are removed fourteen days after closure.",
        "DOC-SYN-004|absent|A deletion request is refused while an invoice is unpaid.|An unpaid invoice blocks a deletion request.",
        "DOC-SYN-004|unstated_detail|A deletion request completes within thirty days.|Deletion finishes inside thirty days.",
        "DOC-SYN-005|absent|Sync errors are reported to the status page automatically.|The status page picks up sync errors on its own.",
        "DOC-SYN-005|unstated_detail|Reconnecting is a two-step procedure.|The reconnect procedure takes two steps.",
        "DOC-SYN-006|absent|Account recovery requires a photograph of an identity document.|Recovery asks for a photo of an identity document.",
        "DOC-SYN-006|unstated_detail|A backup code expires after ten minutes.|Backup codes stop working after ten minutes.",
        "DOC-SYN-007|absent|An export can be scheduled to repeat every week.|Weekly repeating exports can be scheduled.",
        "DOC-SYN-007|unstated_detail|Each export gets three retry attempts.|The retry rule allows three attempts per export.",
        "DOC-SYN-008|absent|Every custom field can be filtered on the list endpoints.|The list endpoints accept a filter for each custom field.",
        "DOC-SYN-008|unstated_detail|A cursor stays valid for one hour.|Cursors remain usable for an hour.",
        "DOC-SYN-009|absent|A failed payment is reported to the account owner by telephone.|The account owner is telephoned when a payment fails.",
        "DOC-SYN-009|unstated_detail|Suspension follows a grace period of ten days.|The grace period runs for ten days.",
        "DOC-SYN-010|absent|A billing administrator must approve a plan change.|A plan change requires approval from a billing administrator.",
        "DOC-SYN-010|unstated_detail|A downgrade can be reversed within the same period.|A downgrade may be reversed during the same period.",
        "DOC-SYN-011|absent|An administrator can hide the setup checklist.|The setup checklist can be hidden by an administrator.",
        "DOC-SYN-011|unstated_detail|Seven items make up the setup checklist.|The setup checklist holds seven items.",
        "DOC-SYN-012|absent|Every supported language has a translation of this article.|The article is translated into every supported language.",
        "DOC-SYN-012|unstated_detail|Quarterly updates reach the reference.|The reference is updated each quarter.",
        "DOC-SYN-013|absent|An account keeps its pricing for its lifetime.|Pricing is fixed for the lifetime of an account.",
        "DOC-SYN-013|unstated_detail|Charging for usage happens at the billing period end.|Usage is charged at the end of the billing period.",
        "DOC-SYN-014|absent|A documentation report opens a ticket in the public tracker.|The public tracker receives a ticket for each documentation report.",
        "DOC-SYN-014|unstated_detail|A report is acknowledged inside a working week.|The docs team acknowledges a report within a working week.",
        "DOC-SYN-015|absent|Feedback is answered personally by the product team.|The product team answers feedback personally.",
        "DOC-SYN-015|unstated_detail|A suggestion is reviewed at the monthly planning meeting.|Monthly planning reviews each suggestion.",
        "DOC-SYN-016|absent|A minor bug is fixed in the release after it is reported.|The release after a report carries the fix for a minor bug.",
        "DOC-SYN-016|unstated_detail|Severity is assigned by the engineer who takes the report.|The engineer taking the report assigns its severity.",
        "DOC-SYN-017|absent|A fingerprint unlock is available in the mobile app.|The mobile app supports a fingerprint unlock.",
        "DOC-SYN-017|unstated_detail|Offline changes are merged when the app reconnects.|Reconnecting merges the changes made offline.",
        "DOC-SYN-018|absent|A separate queue receives an escalated ticket.|An escalation moves the ticket to a separate queue.",
        "DOC-SYN-018|unstated_detail|The requester is told the name of the reviewer.|The reviewer is named to the requester.",
        "DOC-SYN-019|absent|An invoice may be issued in a currency the account chooses.|The account may choose the currency of an invoice.",
        "DOC-SYN-019|unstated_detail|Taxes appear beneath the subtotal.|The subtotal is followed by the taxes.",
        "DOC-SYN-020|absent|A second factor may be shared between two accounts.|Two accounts may share one second factor.",
        "DOC-SYN-020|unstated_detail|Enrolment issues the recovery codes a single time.|Recovery codes are issued once at enrolment.",
        "DOC-SYN-021|absent|A webhook may be paused from the dashboard.|The dashboard can pause a webhook.",
        "DOC-SYN-021|unstated_detail|A failed delivery is retried with a growing delay.|Retries of a failed delivery grow further apart.",
        "DOC-SYN-022|absent|Every account owner receives an alert from the status page.|The status page sends an alert to every account owner.",
        "DOC-SYN-022|unstated_detail|An incident is graded by the share of users it reaches.|The share of users reached decides an incident grade.",
        "RES-SYN-101|absent|A discount on the next renewal was offered.|The customer was offered a discount on the next renewal.",
        "RES-SYN-101|unstated_detail|The refund reached the customer in three working days.|Three working days passed before the refund landed.",
        "RES-SYN-102|absent|Afterwards the account address was changed.|The customer changed the address on the account afterwards.",
        "RES-SYN-102|unstated_detail|The reset message arrived within two minutes.|Two minutes passed before the reset message arrived.",
        "RES-SYN-103|absent|Account data was exported before the closure.|The customer exported the account data before closure.",
        "RES-SYN-103|unstated_detail|The last day of the month was the closing date.|The subscription closed on the last day of the month.",
        "RES-SYN-104|absent|A second calendar was connected at the same time.|The customer connected a second calendar at the same time.",
        "RES-SYN-104|unstated_detail|The integration scope now includes write access.|Write access is now part of the integration scope.",
        "RES-SYN-105|absent|Every other notification was switched off.|The customer turned every other notification off.",
        "RES-SYN-105|unstated_detail|Eight in the morning is the new digest time.|The digest now arrives at eight in the morning.",
        "RES-SYN-106|absent|A change to the search index caused the incident.|The incident was caused by a change to the search index.",
        "RES-SYN-106|unstated_detail|Forty minutes was how long the incident ran.|The incident lasted forty minutes.",
        "RES-SYN-107|absent|Credit was given while the payment was retried.|The customer was given credit while the payment was retried.",
        "RES-SYN-107|unstated_detail|The same bank issued the updated card.|The updated method was a card from the same bank.",
        "RES-SYN-108|absent|A return to the earlier plan was requested.|The customer asked to return to the earlier plan.",
        "RES-SYN-108|unstated_detail|The following invoice carried the prorated amount.|The prorated amount appeared on the following invoice.",
        "RES-SYN-109|absent|Data was imported from another product during setup.|The customer imported data from another product during setup.",
        "RES-SYN-109|unstated_detail|The colleagues accepted their invitations the same day.|The invitations were accepted on the same day.",
        "RES-SYN-110|absent|The customer moved to that tier immediately.|The customer moved to the confirmed tier immediately.",
        "RES-SYN-110|unstated_detail|The comparison covered the previous quarter.|The previous quarter was what the comparison covered.",
        "RES-SYN-111|absent|A credit was given for reporting the error.|The customer was credited for reporting the error.",
        "RES-SYN-111|unstated_detail|A worked example came with the rewrite.|The rewrite added a worked example.",
        "RES-SYN-112|absent|The customer tested the fix before it was released.|The fix was tested by the customer before release.",
        "RES-SYN-112|unstated_detail|The fix reached the mobile client at the same time.|The mobile client received the fix at the same time.",
        "RES-SYN-113|absent|The app was reinstalled to resolve the fault.|The customer reinstalled the app to resolve the fault.",
        "RES-SYN-113|unstated_detail|Recovery codes were used for the fresh sign-in.|The fresh sign-in used the recovery codes.",
        "RES-SYN-114|absent|The customer rotated the secret again after the fix.|The secret was rotated again after the fix.",
        "RES-SYN-114|unstated_detail|A redelivery followed for the rejected events.|The rejected events were delivered again after the fix.",
        "RES-SYN-115|absent|The release that follows was to carry the request.|The request was scheduled for the release that follows.",
        "RES-SYN-115|unstated_detail|Similar requests already sat in the existing group.|The existing group already held similar requests.",
        "RES-SYN-116|absent|The customer split the export into smaller ranges.|The export was split into smaller ranges.",
        "RES-SYN-116|unstated_detail|Finishing was faster on the retry than on the attempt before.|The retry finished faster than the attempt before it.",
        "RES-SYN-117|absent|A copy of the data was requested before deletion.|The customer asked for a copy of the data before deletion.",
        "RES-SYN-117|unstated_detail|Backups were covered by the deletion as well.|The deletion covered the backups as well.",
      ]
    `);
  });

  it('pins every supported claim string, because entailment is a judgment', () => {
    // No mechanical rule decides whether a body supports a sentence. Four
    // sweeps and two rules each found something the one before missed, so the
    // strings are pinned: changing one fails here and a person must look at
    // the body again. The repository pins literal idempotency keys for the
    // same reason.
    const gold = loadGoldSet();
    const byDoc = new Map<string, Set<string>>();
    for (const half of [gold.fit, gold.report]) {
      for (const ticket of half.tickets) {
        for (const claim of ticket.claims ?? []) {
          if (!claim.supported) continue;
          byDoc.set(claim.doc_id, (byDoc.get(claim.doc_id) ?? new Set()).add(claim.text));
        }
      }
    }
    const shipped = [...byDoc.entries()]
      .map(([doc, texts]) => `${doc}|${[...texts].sort().join('|')}`)
      .sort();

    expect(shipped).toMatchInlineSnapshot(`
      [
        "DOC-SYN-001|Renewal dates and proration are described here.|The article covers where past invoice copies are listed.|The article explains renewal dates and proration.|This says where the finance archive lists past invoices.",
        "DOC-SYN-002|Refund windows are given per plan here.|The article covers the steps the billing queue follows.|The article lists the refund windows for each plan.|The billing queue steps for each case are set out.",
        "DOC-SYN-003|Period-end closure is described here.|Reactivation is explained here too.|The article covers how reactivation works.|The article describes what happens at period-end closure.",
        "DOC-SYN-004|The article covers how a deletion request is handled.|The article covers the erase window per region.|The erase window is given for each region.|This walks through the deletion policy.",
        "DOC-SYN-005|A stalled client has a reconnect procedure here.|Pause states and codes such as E-412 are covered.|The article covers pause states and error codes such as E-412.|The article covers the reconnect procedure for stalled clients.",
        "DOC-SYN-006|It handles backup codes being unavailable as well.|The article covers the case where the backup codes are unavailable too.|The article explains the recovery flow.|The recovery flow is explained here.",
        "DOC-SYN-007|A partial export has a retry rule here.|The article covers the retry rule for partial exports.|The article lists the export formats and the empty-archive causes.|This lists the export formats and the empty-archive causes.",
        "DOC-SYN-008|A header carries the next cursor, and it is described.|The article covers the header that reports the next cursor.|The article shows the cursor parameter and the page size default.|The cursor parameter and the default page size are shown.",
        "DOC-SYN-009|Retries after a declined card are described here.|The article covers how to update a payment method.|The article explains the retry schedule after a declined card.|Updating a payment method is covered here.",
        "DOC-SYN-010|An upgrade applying at once is described here.|Proration for a downgrade is covered here.|The article covers the proration rule for a downgrade.|The article describes upgrades that apply at once.",
        "DOC-SYN-011|Signing in for the first time is described here.|The article covers the setup checklist on the dashboard.|The article walks through the first sign-in.|The dashboard setup checklist is covered here.",
        "DOC-SYN-012|A link to the deeper reference is given here.|Frequently asked tasks are collected here.|The article collects the tasks people ask about most.|The article gives a link to the deeper reference.",
        "DOC-SYN-013|Charging for usage above the included amount is explained here.|The article explains how usage above the included amount is charged.|The article sets out the pricing tiers.|The pricing tiers are set out here.",
        "DOC-SYN-014|Acknowledgement by the docs team is covered here.|Reporting an unclear page is explained here.|The article covers how the docs team acknowledges a report.|The article explains where to report an unclear page.",
        "DOC-SYN-015|Grouping of arriving feedback is covered here.|The article covers how the product team groups what arrives.|The article describes the feedback channels.|The feedback channels are described here.",
        "DOC-SYN-016|The article covers where to watch for the fix.|The article explains what a good bug report carries.|What a good bug report carries is explained here.|Where to watch for the fix is covered here.",
        "DOC-SYN-017|How the app behaves offline is described here.|Signing in on mobile is covered here.|The article covers the mobile sign-in.|The article describes the offline behaviour of the app.",
        "DOC-SYN-018|The article covers who reviews an escalation.|The article explains when a ticket may be escalated.|When a ticket may be escalated is explained here.|Who reviews an escalation is covered here.",
        "DOC-SYN-019|How a credit note is shown is covered here.|The article covers how a credit note is shown.|The article explains the lines on an invoice.|The lines on an invoice are explained here.",
        "DOC-SYN-020|Enrolling a second factor is described here.|Replacing a lost device is covered here.|The article covers replacing a lost device.|The article describes enrolling a second factor.",
        "DOC-SYN-021|Registering a webhook is covered here.|The article covers registering a webhook.|The article describes the signature that proves an event origin.|The signature proving an event origin is described here.",
        "DOC-SYN-022|The article covers where past incidents are listed.|The article explains where the status page lives.|Where past incidents are listed is covered here.|Where to find the status page is explained here.",
        "RES-SYN-101|A duplicate charge was refunded in this case.|The case records a duplicate charge that was refunded.|The case records the correct renewal date being confirmed.|The correct renewal date was confirmed here.",
        "RES-SYN-102|A fresh reset message went out in this case.|The blocked send was cleared here.|The case records a blocked send that was cleared.|The case records a fresh reset message that was issued.",
        "RES-SYN-103|Closure was scheduled for the period end here.|The case records a confirmation sent with the final invoice.|The case records closure scheduled for the period end.|The confirmation went out with the final invoice.",
        "RES-SYN-104|A stale token was rotated in this case.|The case records a stale token that was rotated.|The case records the daily drop being stopped.|The daily drop was stopped here.",
        "RES-SYN-105|The case records a digest schedule that was corrected.|The case records the delivery slot being verified.|The delivery slot was verified here.|The digest schedule was corrected in this case.",
        "RES-SYN-106|The case records a slowdown matched to the active incident.|The case records the ticket attached to its tracker.|The slowdown was matched to the active incident here.|The ticket was attached to its tracker in this case.",
        "RES-SYN-107|A declined card was confirmed in this case.|The balance was cleared here.|The case records a declined card that was confirmed.|The case records the balance being cleared.",
        "RES-SYN-108|An upgrade was applied at once in this case.|The case records an upgrade applied at once.|The case records the new amount being confirmed.|The new amount was confirmed here.",
        "RES-SYN-109|The case records the customer being walked through the checklist.|The case records the workspace being confirmed ready.|The customer was walked through the checklist here.|The workspace was confirmed ready in this case.",
        "RES-SYN-110|The case records the fitting tier being confirmed.|The case records the tier boundaries being explained.|The fitting tier was confirmed in this case.|The tier boundaries were explained here.",
        "RES-SYN-111|The case records the corrected page being published.|The case records the unclear step being rewritten.|The corrected page was published in this case.|The unclear step was rewritten here.",
        "RES-SYN-112|The case records the fault being reproduced.|The case records the fix being released.|The fault was reproduced here.|The fix was released in this case.",
        "RES-SYN-113|The app was confirmed working in this case.|The case records the app being confirmed working.|The case records the stored session being cleared.|The stored session was cleared here.",
        "RES-SYN-114|Delivery was confirmed as resumed in this case.|The case records delivery being confirmed as resumed.|The case records the rejected events being traced.|The rejected events were traced here.",
        "RES-SYN-115|The case records the customer being told where to follow it.|The case records the request being recorded.|The customer was told where to follow it in this case.|The request was recorded here.",
        "RES-SYN-116|The case records the complete archive being delivered.|The case records the interrupted export being found.|The complete archive was delivered in this case.|The interrupted export was found here.",
        "RES-SYN-117|The case records the requester being verified.|The case records the written confirmation being sent.|The requester was verified here.|The written confirmation was sent in this case.",
      ]
    `);
  });

  it('cites the intent\'s own documents wherever they can supply the claim', () => {
    // The regression cycle five found and this case did not exist to catch:
    // a one-line change to the draw order sent on-topic citation from every
    // claim to one in four, and the judge's context grew by a quarter.
    // Every label stayed self-consistent, so nothing failed and the
    // generator-versus-corpus diff could not see it either.
    const linked = new Map<string, Set<string>>();
    for (const doc of loadDocuments()) {
      for (const intent of doc.linked_intents) {
        linked.set(intent, (linked.get(intent) ?? new Set()).add(doc.doc_id));
      }
    }

    const gold = loadGoldSet();
    let onTopic = 0;
    let cited = 0;
    let contexts = 0;
    let drafts = 0;

    for (const half of [gold.fit, gold.report]) {
      for (const ticket of half.tickets) {
        const claims = ticket.claims ?? [];
        if (claims.length === 0) continue;
        drafts += 1;
        contexts += new Set(claims.map((c) => c.doc_id)).size;
        const own = linked.get(ticket.intent);
        if (own === undefined) continue;
        for (const claim of claims) {
          cited += 1;
          if (own.has(claim.doc_id)) onTopic += 1;
        }
      }
    }

    // An intent links one or two documents and a draft makes up to four
    // distinct claims, so some fill is unavoidable. Eight in ten is what the
    // own-first draw produces; a uniform draw over this corpus gives one in
    // four. Both figures are measured on the corpus as it stands: an earlier
    // comment paired a rate from one corpus with a context size from another.
    expect(onTopic / cited).toBeGreaterThan(0.75);
    // The gate is handed every document a draft cites. A uniform draw took
    // this to 3.40 on this corpus; drawing own documents first keeps it near
    // the original 2.24.
    expect(contexts / drafts).toBeLessThan(3);
  });

  it('never repeats a claim text inside one draft', () => {
    // Documents were picked with replacement, so 853 of 2910 claim entries
    // were verbatim repeats. Each bills the same question to the model twice
    // and weights it twice in the coverage denominator the fit rests on.
    const gold = loadGoldSet();
    const offenders: string[] = [];

    for (const half of [gold.fit, gold.report]) {
      for (const ticket of half.tickets) {
        const texts = (ticket.claims ?? []).map((c) => c.text);
        if (new Set(texts).size !== texts.length) offenders.push(ticket.ticket_id);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('never labels a claim unsupported whose text is supported in the same draft', () => {
    // The weaker sibling of the rule above, and the one an earlier commit
    // measured while claiming to have measured the rule above.
    const offenders = new Set<string>();
    const gold = loadGoldSet();

    for (const half of [gold.fit, gold.report]) {
      for (const ticket of half.tickets) {
        const claims = ticket.claims ?? [];
        const supported = new Set(claims.filter((c) => c.supported).map((c) => c.text));
        if (claims.some((c) => !c.supported && supported.has(c.text))) offenders.add(ticket.ticket_id);
      }
    }

    expect([...offenders]).toEqual([]);
  });
});
