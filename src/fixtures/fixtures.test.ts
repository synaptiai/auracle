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
  fixturesDir,
  loadDocuments,
  loadGoldSet,
  loadTaxonomy,
} from './load.js';

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
