// Tests for the judge-triage job (method 3, section 4.10, DEC-09).
//
// Four concerns:
// 1. selection semantics: the stub judge flags uncertainty and high risk,
//    and every selection carries a reason;
// 2. run behaviour: the job reviews every case, records provenance per
//    selection, and pins prompt and model versions;
// 3. selection-only discipline: the artifact may not carry a score — the
//    key whitelist in validation rejects any metric field (DEC-09);
// 4. artifact round-trip and tamper rejection.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { StubTriageJudge } from './select.js';
import type { TriageCase, TriageJudge } from './select.js';
import {
  loadTriageArtifact,
  nextVersion,
  validateTriageArtifact,
  writeTriageArtifact,
} from './artifact.js';
import type { TriageArtifact } from './artifact.js';
import { goldSetCases, runTriageJob } from './run.js';
import { loadTaxonomy, FIT_COUNT, REPORT_COUNT } from '../fixtures/load.js';

function tempDirUrl(): URL {
  return pathToFileURL(mkdtempSync(join(tmpdir(), 'auracle-triage-')));
}

function makeCase(overrides: Partial<TriageCase> = {}): TriageCase {
  return {
    ticketId: 't-1',
    origin: 'report',
    subject: 'The export button shows a blank page',
    body: 'When I press export nothing downloads.',
    ...overrides,
  };
}

function stubJudge(): StubTriageJudge {
  const taxonomy = loadTaxonomy();
  return new StubTriageJudge(
    new Map(taxonomy.intents.map((intent) => [intent.id, intent.risk_tier])),
  );
}

describe('stub judge selection', () => {
  it('selects cases that match no known topic and says why', async () => {
    // No fixture topic phrase appears in this text.
    const verdict = await stubJudge().review(
      makeCase({ subject: 'Hello hello hello', body: 'Just saying hi.' }),
    );
    expect(verdict.selected).toBe(true);
    expect(verdict.reason).toContain('other');
  });

  it('passes low and medium risk cases through with a stated reason', async () => {
    // 'typo' maps to bug-minor-report; check the taxonomy tier first so the
    // assertion tracks the committed fixture rather than a hardcoded tier.
    const taxonomy = loadTaxonomy();
    const tier = taxonomy.intents.find((intent) => intent.id === 'bug-minor-report')?.risk_tier;
    expect(tier).not.toBe('high');
    const verdict = await stubJudge().review(
      makeCase({ subject: 'Typo in the FAQ heading', body: 'A word is misspelt.' }),
    );
    expect(verdict.selected).toBe(false);
    expect(verdict.reason).toContain('bug-minor-report');
  });

  it('is deterministic: identical cases get identical verdicts', async () => {
    const testCase = makeCase();
    const first = await stubJudge().review(testCase);
    const second = await stubJudge().review(testCase);
    expect(second).toEqual(first);
  });
});

describe('triage run', () => {
  it('reviews every case and records only selections with provenance', async () => {
    const dir = tempDirUrl();
    try {
      const cases = [makeCase(), makeCase({ ticketId: 't-2', subject: 'There is a typo here' })];
      const { artifact } = await runTriageJob({
        judge: stubJudge(),
        cases,
        artifactDir: dir,
      });

      expect(artifact.cases_reviewed).toBe(cases.length);
      expect(artifact.cases_selected).toBe(artifact.selections.length);
      for (const selection of artifact.selections) {
        expect(selectionsAreFromCases(selection, cases)).toBe(true);
        expect(selection.origin).toBeDefined();
        expect(selection.reason.length).toBeGreaterThan(0);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pins prompt and model versions on the manifest', async () => {
    const dir = tempDirUrl();
    try {
      const { artifact } = await runTriageJob({
        judge: stubJudge(),
        cases: [makeCase()],
        artifactDir: dir,
      });
      expect(artifact.prompt_ver.length).toBeGreaterThan(0);
      expect(artifact.model_ver).toBe('replay-stub');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to run without pinned versions when the judge declares none', async () => {
    const anonymousJudge: TriageJudge = {
      review: async () => ({ selected: true, reason: 'always' }),
    };
    await expect(
      runTriageJob({ judge: anonymousJudge, cases: [makeCase()] }),
    ).rejects.toThrow('DEC-26');
  });

  it('mints a new version per run and reloads the highest one', async () => {
    const dir = tempDirUrl();
    try {
      expect(await nextVersion(dir)).toBe(1);
      await runTriageJob({ judge: stubJudge(), cases: [makeCase()], artifactDir: dir });
      expect(await nextVersion(dir)).toBe(2);
      const loaded = await loadTriageArtifact(undefined, dir);
      expect(loaded?.version).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the default case source is the full synthetic gold set', () => {
  it('carries both halves, 770 cases, each tagged with its split', () => {
    const cases = goldSetCases();
    expect(cases.length).toBe(FIT_COUNT + REPORT_COUNT);
    expect(cases.filter((c) => c.origin === 'fit').length).toBe(FIT_COUNT);
    expect(cases.filter((c) => c.origin === 'report').length).toBe(REPORT_COUNT);
  });
});

describe('selection-only discipline (DEC-09)', () => {
  function baseArtifact(): TriageArtifact {
    return validateTriageArtifact({
      artifact: 'judge-triage',
      version: 1,
      generated_at: '2025-01-01T00:00:00.000Z',
      method: 'judge-triage',
      role: 'selection',
      gold_source: 'synthetic',
      cases_reviewed: 1,
      cases_selected: 1,
      prompt_ver: 'triage-p1',
      model_ver: 'replay-stub',
      selections: [{ ticket_id: 't-1', origin: 'report', reason: 'uncertain' }],
    });
  }

  it('round-trips through write and load', async () => {
    const dir = tempDirUrl();
    try {
      await writeTriageArtifact(baseArtifact(), dir);
      const loaded = await loadTriageArtifact(1, dir);
      expect(loaded).toEqual(baseArtifact());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a metric field at the top level — no rate, interval or accuracy', () => {
    // The one number DEC-09 forbids is a published score. Any extra field
    // fails validation because the key set is whitelisted.
    for (const field of ['action_match', 'containment', 'accuracy']) {
      const tampered = baseArtifact() as unknown as Record<string, unknown>;
      tampered[field] = { rate: 0.9, successes: 9, total: 10 };
      expect(() => validateTriageArtifact(tampered), field).toThrow("unexpected field");
    }
  });

  it('rejects a metric field inside a selection', () => {
    const tampered = baseArtifact() as unknown as { selections: Record<string, unknown>[] };
    tampered.selections[0]['confidence'] = 0.95;
    expect(() => validateTriageArtifact(tampered)).toThrow('unexpected field');
  });

  it('rejects counts that disagree with the recorded selections', () => {
    const artifact = { ...baseArtifact(), cases_reviewed: 2, cases_selected: 2 };
    expect(() => validateTriageArtifact(artifact)).toThrow('does not match');
  });

  it('rejects more selected than reviewed cases', () => {
    const artifact = { ...baseArtifact(), cases_reviewed: 0 };
    expect(() => validateTriageArtifact(artifact)).toThrow('positive integer');
  });

  it('rejects a repeated ticket in the selection list', () => {
    const artifact = {
      ...baseArtifact(),
      cases_reviewed: 2,
      cases_selected: 2,
      selections: [
        { ticket_id: 't-1', origin: 'report' as const, reason: 'a' },
        { ticket_id: 't-1', origin: 'fit' as const, reason: 'b' },
      ],
    };
    expect(() => validateTriageArtifact(artifact)).toThrow('repeats');
  });

  it('rejects an empty reason on a selection', () => {
    const tampered = baseArtifact() as unknown as { selections: Record<string, unknown>[] };
    tampered.selections[0]['reason'] = '';
    expect(() => validateTriageArtifact(tampered)).toThrow('no reason');
  });
});

function selectionsAreFromCases(
  selection: { ticket_id: string },
  cases: readonly TriageCase[],
): boolean {
  return cases.some((c) => c.ticketId === selection.ticket_id);
}
