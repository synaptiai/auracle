// Tests for the judge-triage job (method 3, section 4.10, DEC-09).
//
// Four concerns:
// 1. selection semantics: the stub judge flags uncertainty and high risk,
//    and every selection carries a reason;
// 2. run behavior: the job reviews every case, records provenance per
//    selection, and pins prompt and model versions;
// 3. selection-only discipline: the artifact may not carry a score — the
//    key whitelist in validation rejects any metric field (DEC-09);
// 4. artifact round-trip and tamper rejection.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { StubTriageJudge, caseText } from './select.js';
import type { TriageCase, TriageJudge } from './select.js';
import {
  loadTriageArtifact,
  nextVersion,
  validateTriageArtifact,
  writeTriageArtifact,
} from './artifact.js';
import type { TriageArtifact } from './artifact.js';
import { goldSetCases, runTriageJob, summariseForStdout } from './run.js';
import { FIT_COUNT, REPORT_COUNT, goldCaseText } from '../domain/gold-types.js';
import { loadGoldSet, loadTaxonomy } from '../fixtures/load.js';
import { expectEscaped, HOSTILE } from '../test-support/raw-log.js';

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

describe('the judge reads a follow-up with its history (DEC-37)', () => {
  const FOLLOW_UP = makeCase({
    ticketId: 't-follow-up',
    subject: 'Re: Export produces an empty archive',
    body: 'This still happens after I followed those steps.',
  });

  it('falls back to the uncertain group when the earlier turns are missing', async () => {
    // The subject still names the topic, so strip it too: this is the shape a
    // judge sees when nothing carries the conversation.
    const verdict = await stubJudge().review({ ...FOLLOW_UP, subject: 'Re: your case' });
    expect(verdict.selected).toBe(true);
    expect(verdict.reason).toContain('other');
  });

  it('reads the topic out of the earlier turns instead', async () => {
    const verdict = await stubJudge().review({
      ...FOLLOW_UP,
      subject: 'Re: your case',
      history: [
        { turnNumber: 1, author: 'customer', bodyText: 'The full export finishes in seconds and the archive contains no records.' },
        { turnNumber: 1, author: 'agent', bodyText: 'An empty archive means the export ran before indexing finished.' },
      ],
    });
    expect(verdict.reason).toContain('export-broken');
  });

  it('gives a later gold case exactly the history the classifier would see', () => {
    const { fit } = loadGoldSet();
    const later = fit.tickets.find((t) => t.turn_number === 2);
    if (!later) throw new Error('the fit half carries no second turn');
    const previous = fit.tickets.find(
      (t) => t.conversation_id === later.conversation_id && t.turn_number === 1,
    );
    if (!previous) throw new Error('the second turn has no first turn');

    const triaged = goldSetCases().find((c) => c.ticketId === later.ticket_id);
    if (!triaged) throw new Error(`case ${later.ticket_id} is missing from the triage source`);
    expect(triaged.history).toEqual([
      { turnNumber: 1, author: 'customer', bodyText: goldCaseText(previous) },
      { turnNumber: 1, author: 'agent', bodyText: previous.agent_reply },
    ]);
    // And the judge reads that history, not the bare follow-up.
    expect(caseText(triaged)).toContain(`[turn 1] agent: ${previous.agent_reply}`);

    // Every first turn carries an empty history, so no case invents one.
    const openers = goldSetCases().filter((c) => (c.history?.length ?? 0) === 0);
    expect(openers.length).toBe(
      [...fit.tickets, ...loadGoldSet().report.tickets].filter((t) => t.turn_number === 1).length,
    );
  });
});

describe('triage run', () => {
  it('reviews every case and records only selections with provenance', async () => {
    const dir = tempDirUrl();
    try {
      // The stub judge reads the body, not the subject, and selects only a
      // high-tier intent or 'other'. An earlier version of this case
      // overrode the subject alone, so both bodies still said 'export',
      // both resolved to a medium intent, nothing was selected, and every
      // assertion below sat inside a loop over an empty list.
      const cases = [
        makeCase(),
        makeCase({
          ticketId: 't-2',
          subject: 'I want my money back',
          body: 'Please issue a refund for last month.',
        }),
      ];
      const { artifact } = await runTriageJob({
        judge: stubJudge(),
        cases,
        goldSource: 'synthetic',
        artifactDir: dir,
      });

      expect(artifact.cases_reviewed).toBe(cases.length);
      // Exactly one case is high-tier, so the judge selects one. Without
      // this the loop below proves nothing.
      expect(artifact.selections).toHaveLength(1);
      expect(artifact.selections[0]!.ticket_id).toBe('t-2');
      for (const selection of artifact.selections) {
        expect(selectionsAreFromCases(selection, cases)).toBe(true);
        expect(selection.origin).toBe('report');
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
        goldSource: 'synthetic',
        artifactDir: dir,
      });
      expect(artifact.prompt_ver.length).toBeGreaterThan(0);
      expect(artifact.model_ver).toBe('replay-stub');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The provenance of injected cases is knowable only to the caller. The
  // field defaulted to 'real', so a caller injecting synthetic-derived cases
  // published an artifact falsely claiming real provenance — while the doc
  // beside it called the field required.
  it('refuses injected cases that declare no provenance (DEC-18)', async () => {
    await expect(
      runTriageJob({ judge: stubJudge(), cases: [makeCase()], artifactDir: tempDirUrl() }),
    ).rejects.toThrow(/needs goldSource with injected cases/);
  });

  // Survived mutation in cycle 4: correct only by accident.
  it('names a real case by digest when a judge selects it without a reason', async () => {
    const judge = { async review() { return { selected: true, reason: '' }; } } as never;
    const real = { ...makeCase(), ticketId: 'msg@customer-domain.example' };
    const call = runTriageJob({
      judge, cases: [real], goldSource: 'real',
      prompt_ver: 'p', model_ver: 'm', artifactDir: tempDirUrl(),
    });
    await expect(call).rejects.toThrow(/id digest [0-9a-f]{12}/);
    await expect(call).rejects.not.toThrow(/customer-domain\.example/);
  });

  function makeArtifactShape() {
    return {
      artifact: 'judge-triage' as const,
      version: 1,
      generated_at: '2025-01-01T00:00:00.000Z',
      method: 'judge-triage' as const,
      role: 'selection' as const,
      gold_source: 'synthetic' as const,
      cases_reviewed: 2,
      cases_selected: 1,
      prompt_ver: 'triage-p1',
      model_ver: 'replay-stub',
      selections: [{ ticket_id: 't-1', origin: 'report', reason: 'uncertain' }],
    };
  }

  // This PR widened gold_source to accept 'real', which is what made a raw
  // Message-ID reachable in the validator — while redacting the same
  // identifier one file over in the same commit.
  it('refuses a provenance outside the closed set (DEC-18)', () => {
    expect(() => validateTriageArtifact({ ...makeArtifactShape(), gold_source: 'production' }))
      .toThrow(/gold_source is production, expected one of synthetic, real/);
  });

  it('names a repeated real selection by digest, never in the clear', () => {
    const selection = { ticket_id: 'msg@customer-domain.example', origin: 'report', reason: 'why' };
    const call = () => validateTriageArtifact({
      ...makeArtifactShape(),
      gold_source: 'real',
      cases_selected: 2,
      selections: [selection, { ...selection }],
    });
    expect(call).toThrow(/id digest [0-9a-f]{12}/);
    expect(call).not.toThrow(/customer-domain\.example/);
  });

  // selections carry a case id and a model-written sentence about the
  // customer's problem. The artifact is on gitignored disk either way;
  // stdout is a terminal and a CI log.
  it('withholds real selections from stdout, and prints a synthetic artifact whole', () => {
    const shape = makeArtifactShape();
    const real = summariseForStdout({ ...shape, gold_source: 'real' } as never);
    expect(real).toContain('withheld');
    expect(real).not.toContain('customer-domain.example');
    const synthetic = summariseForStdout(shape as never);
    expect(JSON.parse(synthetic)).toMatchObject({ gold_source: 'synthetic' });
  });

  // A selection's reason is a sentence the judge model wrote about a customer's
  // message, so it can carry any character, and this is the report a person
  // reads in a terminal.
  it('prints the report with every raw character escaped, and it parses back', () => {
    const shape = makeArtifactShape();
    const selections = [{ ticket_id: 't-1', origin: 'report', reason: HOSTILE }];
    const printed = summariseForStdout({ ...shape, selections } as never);
    const carrier = expectEscaped([printed], HOSTILE);
    expect(carrier).toEqual({ ...shape, selections });
  });

  it('records the provenance the caller declared', async () => {
    const dir = tempDirUrl();
    try {
      const { artifact } = await runTriageJob({
        judge: stubJudge(), cases: [makeCase()], goldSource: 'real', artifactDir: dir,
      });
      expect(artifact.gold_source).toBe('real');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to run without pinned versions when the judge declares none', async () => {
    const anonymousJudge: TriageJudge = {
      review: async () => ({ selected: true, reason: 'always' }),
    };
    await expect(
      runTriageJob({ judge: anonymousJudge, cases: [makeCase()], goldSource: 'synthetic', artifactDir: tempDirUrl() }),
    ).rejects.toThrow('DEC-26');
  });

  it('mints a new version per run and reloads the highest one', async () => {
    const dir = tempDirUrl();
    try {
      expect(await nextVersion(dir)).toBe(1);
      await runTriageJob({ judge: stubJudge(), cases: [makeCase()], goldSource: 'synthetic', artifactDir: dir });
      expect(await nextVersion(dir)).toBe(2);
      const loaded = await loadTriageArtifact(undefined, dir);
      expect(loaded?.version).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the default case source is the full synthetic gold set', () => {
  it('carries both halves, every case tagged with its split', () => {
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
    tampered.selections[0]!['confidence'] = 0.95;
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
    tampered.selections[0]!['reason'] = '';
    expect(() => validateTriageArtifact(tampered)).toThrow('no reason');
  });
});

function selectionsAreFromCases(
  selection: { ticket_id: string },
  cases: readonly TriageCase[],
): boolean {
  return cases.some((c) => c.ticketId === selection.ticket_id);
}

// The strictness this module gained when three loaders were put on one scan.
// Mutation testing found it unprotected: reverting the loader to its old
// lenient scan left every case in this file green.
describe('the triage directory obeys the shared scan', () => {
  function dirWith(name: string): URL {
    const dir = pathToFileURL(mkdtempSync(join(tmpdir(), 'auracle-triagedir-')));
    writeFileSync(new URL(name, `${dir.href}/`), '{}');
    return dir;
  }

  it('mints over a capitalised name instead of writing on top of it', async () => {
    expect(await nextVersion(dirWith('V5.json'))).toBe(6);
  });

  it('refuses a leading zero rather than reading a different file', async () => {
    await expect(nextVersion(dirWith('v05.json'))).rejects.toThrow(
      /triage directory holds 'v05\.json'/,
    );
  });

  it('checks the directory before the judge reviews every case', async () => {
    // The whole gold set reviewed, then thrown away by a stray file. The check moved
    // ahead of the loop.
    let reviewed = 0;
    const judge: TriageJudge = {
      async review() {
        reviewed += 1;
        return { selected: false, reason: '' };
      },
    };

    await expect(
      runTriageJob({ judge, artifactDir: dirWith('v5.backup.json') }),
    ).rejects.toThrow(/not a versioned artifact/);

    expect(reviewed).toBe(0);
  });
});
