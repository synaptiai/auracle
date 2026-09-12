// The latency artifact and the rules that keep it readable (V2 open item 7).
//
// The db suite proves the numbers. These cases prove the file cannot state a
// figure nobody could have computed, and that the module reading the ledger
// never writes to it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { excluded, parseSince } from './run.js';
import { humanMs } from './format.js';
import { TERMINAL_STATE_LIST } from './query.js';
import { validateLatencyArtifact } from './artifact.js';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;

function distribution(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { count: 4, p50_ms: 1000, p95_ms: 2000, p99_ms: 3000, max_ms: 3000, ...over };
}

/** A wait half with every exclusion named, so the totals add up. */
function wait(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...distribution(), unmeasured: 0, unordered: 0, ...over };
}

/** A service half with every exclusion named. */
function service(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...distribution(),
    unfinished: 0,
    unstamped: 0,
    unordered: 0,
    never_ran: 0,
    ...over,
  };
}

function makeArtifact(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    artifact: 'run-latency',
    version: 1,
    generated_at: '2026-09-02T12:00:00.000Z',
    role: 'observation',
    since: null,
    runs: 4,
    partitions: [
      {
        partition: 0,
        wait: wait(),
        service: service(),
      },
    ],
    ...over,
  };
}

describe('the latency artifact', () => {
  it('accepts a well-formed record', () => {
    expect(() => validateLatencyArtifact(makeArtifact())).not.toThrow();
  });

  // Open item 7 asks for the data a correction needs. An artifact that could
  // call itself a correction would turn an observation into a decision nobody
  // made, on data this repository does not have.
  it('refuses an artifact claiming a role other than observation', () => {
    expect(() => validateLatencyArtifact(makeArtifact({ role: 'correction' })))
      .toThrow(/role is not 'observation'/);
  });

  // A percentile with no runs behind it is not a small measurement, it is no
  // measurement.
  it('refuses a figure reported over zero runs', () => {
    expect(() => validateLatencyArtifact(makeArtifact({
      partitions: [{
        partition: 0,
        wait: wait({ ...distribution({ count: 0 }), unmeasured: 3 }),
        service: service({ count: 3 }),
      }],
    }))).toThrow(/reports a figure over zero runs/);
  });

  // `runs` used to be a free-standing count, checked only for being a
  // non-negative integer. An artifact claiming a million runs over one
  // partition of four validated cleanly, and `runs` is the first figure a
  // reader sees.
  it('refuses a total that its partitions do not account for', () => {
    expect(() => validateLatencyArtifact(makeArtifact({ runs: 1_000_000 })))
      .toThrow(/the partitions account for 4/);
  });

  // The two distributions describe the same runs, so their totals must agree.
  // A wait figure written into the service field leaves both halves
  // individually well formed and ordered, and the report then names the wrong
  // partition as the busy one.
  it('refuses a partition whose two halves cover different run counts', () => {
    expect(() => validateLatencyArtifact(makeArtifact({
      runs: 4,
      partitions: [{
        partition: 0,
        wait: wait(),
        service: service({ count: 1, unfinished: 0 }),
      }],
    }))).toThrow(/4 runs by wait and 1 by service/);
  });

  it('accepts an empty distribution that says so', () => {
    expect(() => validateLatencyArtifact(makeArtifact({
      runs: 3,
      partitions: [{
        partition: 0,
        wait: wait({ count: 0, unmeasured: 3, p50_ms: null, p95_ms: null, p99_ms: null, max_ms: null }),
        service: service({ count: 3 }),
      }],
    }))).not.toThrow();
  });

  // A p50 above a p99 describes a distribution that cannot exist, and would
  // send an operator to the wrong partition.
  it('refuses percentiles that are not ordered', () => {
    expect(() => validateLatencyArtifact(makeArtifact({
      partitions: [{
        partition: 0,
        wait: wait({ ...distribution({ p50_ms: 9000 }) }),
        service: service(),
      }],
    }))).toThrow(/percentiles are not ordered/);
  });

  // Two rows for one partition would let a reader's eye settle on whichever
  // came first, and nothing records which was read.
  it('refuses a repeated or unsorted partition', () => {
    const row = {
      partition: 1,
      wait: wait(),
      service: service(),
    };
    expect(() => validateLatencyArtifact(makeArtifact({ partitions: [row, { ...row }] })))
      .toThrow(/repeats or unsorts/);
    expect(() => validateLatencyArtifact(makeArtifact({
      partitions: [row, { ...row, partition: 0 }],
    }))).toThrow(/repeats or unsorts/);
  });

  // The window is part of the number. An hour of an incident and a quiet
  // month produce very different figures and nothing else says which this is.
  it('refuses a window that is neither null nor a timestamp', () => {
    expect(() => validateLatencyArtifact(makeArtifact({ since: 'last tuesday' })))
      .toThrow(/neither null nor a timestamp/);
  });

  it('records the window it covered', () => {
    const artifact = validateLatencyArtifact(makeArtifact({ since: '2026-09-01T00:00:00.000Z' }));
    expect(artifact.since).toBe('2026-09-01T00:00:00.000Z');
  });
});

// The module reads a live ledger, so the claim that it cannot damage one has
// to be enforced rather than stated. A single UPDATE added later would make
// `pnpm run latency` unsafe to run in production, and nothing else here would
// notice.
// The promise is made at command scope: AGENTS.md, the README and the runbook
// all tell an operator that `pnpm run latency` is safe against a live
// database. So the scan covers every module the command loads that can reach
// the pool, not the query module alone — `run.ts` owns the pool, and a
// statement added there would have shipped green.
const READ_ONLY_MODULES = ['src/latency/query.ts', 'src/latency/run.ts'];

/** Source with comments blanked, so prose about writing never trips the scan. */
function codeOf(relative: string): string {
  return readFileSync(join(REPO_ROOT, relative), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
}

describe('the latency command never writes', () => {
  it.each(READ_ONLY_MODULES)('issues no statement in %s that could change the ledger', (module) => {
    const code = codeOf(module);
    for (const verb of [
      'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'DROP', 'ALTER', 'CREATE', 'GRANT',
      'MERGE', 'COPY', 'REFRESH', 'VACUUM', 'CALL',
    ]) {
      // Case-insensitive. SQL is not, and a lowercase `update run set ...`
      // passed a scan that only knew the shouted spelling.
      expect(code, `${module} contains a ${verb} statement`).not.toMatch(
        new RegExp(`\\b${verb}\\b`, 'i'),
      );
    }
  });

  it('still reads, so the scan is not passing over an empty file', () => {
    expect(codeOf('src/latency/query.ts')).toMatch(/\bSELECT\b/);
  });

  // The report reads timestamps and a partition number. A ticket id, subject
  // or body in this file would put customer text in an artifact that has no
  // reason to hold any (DEC-18).
  it('selects no case text and no case identifier', () => {
    const code = codeOf('src/latency/query.ts');
    // `ticket_id` belongs here and was missing: the comment above forbids a
    // ticket id in as many words, and the list checked everything but that.
    for (const column of ['ticket_text', 'subject', 'body', 'message_id', 'ticket_id', 'sender']) {
      expect(code, `query.ts reads ${column}`).not.toContain(column);
    }
  });
});

describe('the operator-facing helpers', () => {
  it.each([
    [null, '-'],
    [250, '250ms'],
    [1500, '1.5s'],
    [120_000, '2.0m'],
    [7_200_000, '2.0h'],
  ])('renders %s as %s', (ms, expected) => {
    expect(humanMs(ms as number | null)).toBe(expected);
  });

  it('refuses a window it cannot parse, naming what to type', () => {
    expect(() => parseSince('last tuesday')).toThrow(/ISO timestamp/);
    expect(parseSince('2026-09-01T00:00:00Z').toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('names every non-zero exclusion, and says nothing when there are none', () => {
    expect(excluded([['unmeasured', 0], ['unordered', 0]])).toBe('');
    expect(excluded([['unmeasured', 3], ['unordered', 0]])).toBe(' (3 unmeasured)');
    expect(excluded([['unfinished', 2], ['unstamped', 0], ['never_ran', 7]]))
      .toBe(' (2 unfinished, 7 never_ran)');
  });
});

// The runbook gives one remedy per exclusion count and tells an operator to
// read them. The first version of the command printed two of the six, and the
// other four reached the artifact file alone — including `never_ran`, which
// the same runbook says rises when a partition is failing. A count nobody sees
// on the command they run is a diagnostic nobody reads.
//
// Pinned against the validator's own lists rather than a literal here, so an
// exclusion added to the artifact and not printed fails this case.
describe('the counts the command prints', () => {
  // Grouped by distribution, not merged into one set. `unordered` is the name
  // both distributions carry, so a merged comparison passes while the service
  // line quietly loses its own unordered count — the defect class this pin
  // exists to catch. Each side is therefore classified by the distribution the
  // source itself names.
  const group = (
    source: string,
    pattern: RegExp,
    kindOf: (m: RegExpMatchArray) => string,
    namesOf: (m: RegExpMatchArray) => string[],
  ): Record<string, string[]> => {
    const out: Record<string, string[]> = {};
    let seen = 0;
    for (const m of source.matchAll(pattern)) {
      seen += 1;
      (out[kindOf(m)] ??= []).push(...namesOf(m));
    }
    expect(seen, 'the call shape this case scans for is gone').toBeGreaterThan(0);
    for (const kind of Object.keys(out)) out[kind] = [...out[kind]!].sort();
    return out;
  };

  it('covers every exclusion the artifact validator checks, per distribution', () => {
    const artifact = readFileSync(join(REPO_ROOT, 'src/latency/artifact.ts'), 'utf8');
    const run = readFileSync(join(REPO_ROOT, 'src/latency/run.ts'), 'utf8');
    const validated = group(
      artifact,
      /assertExclusions\((wait|service),([\s\S]*?)\);/g,
      (m) => m[1]!,
      (m) => [...m[2]!.matchAll(/'([a-z_]+)'/g)].map((q) => q[1]!),
    );
    const printed = group(
      run,
      /\['([a-z_]+)',\s*p\.(wait|service)\./g,
      (m) => m[2]!,
      (m) => [m[1]!],
    );
    expect(Object.keys(printed).sort()).toEqual(['service', 'wait']);
    expect(printed).toEqual(validated);
  });
});

describe('the terminal states the service population keys on', () => {
  it('matches the set the ledger stamps a finish time for', () => {
    const ledger = readFileSync(join(REPO_ROOT, 'src/ledger/insert.ts'), 'utf8');
    const block = /TERMINAL_RUN_STATES[^=]*=\s*new Set\(\[([^\]]*)\]/.exec(ledger);
    expect(block, 'the ledger no longer declares TERMINAL_RUN_STATES as a literal set').not.toBeNull();
    const ledgerStates = [...block![1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!).sort();
    expect(ledgerStates.length).toBeGreaterThan(0);
    expect([...TERMINAL_STATE_LIST].sort()).toEqual(ledgerStates);
  });
});

describe('the artifact directory', () => {
  it('is ignored, because a latency report is the adopter\'s own traffic', () => {
    const ignore = readFileSync(join(REPO_ROOT, '.gitignore'), 'utf8');
    expect(ignore).toMatch(/^\/latency\/$/m);
  });
});
