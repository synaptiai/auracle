// The failures of src/test-support/e2e-artifact.ts that an end-to-end run
// cannot see. AGENTS.md rule 4: the list came first, then these cases, then
// the code. A volatile value that leaks (F1) needs no case here: the second
// run of the suite differs from the committed artifact and fails.
//
//   F2  Normalisation hides a real value, so a changed outcome still matches.
//   F3  One volatile value gets two tokens, or two values share one, so the
//       artifact no longer shows that the park step and the outbox row name
//       the same draft.
//   F4  Key order follows insertion order, so an equal object renders
//       differently.
//   F5  A bigint or a Date throws inside JSON.stringify.
//   F6  A missing golden passes, so a new case proves nothing.
//   F7  A changed artifact fails and leaves nothing to diff.
//   F8  Two cases write one file and overwrite each other's evidence. That
//       includes two files, which run in separate workers, and a retry of
//       one case, which must not read as a second case.
//   F9  A registered value equals an unrelated value elsewhere, so both
//       become one token. A fresh GreenMail gives the first draft UID "1",
//       and the outbox epoch is "1" too. The first version of this module
//       replaced both, and a run against a throwaway server differed from a
//       run against a reused one.
//   F10 A mismatch rewrites the golden, so the next run passes with nothing
//       reviewed. The first version of this module did that. Only an explicit
//       accept may write a golden.
//   F11 A timestamp in Postgres text form ("2026-09-26 15:49:20.12+00")
//       stays raw, so the artifact differs on every run.
//   F12 A number that varies by design stays raw, so the artifact differs on
//       every run. A run's partition is the hash of a conversation id the
//       intake mints, and a column of type integer reaches the artifact as a
//       number. Scoping it to its keys keeps an unrelated equal number raw.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { claimArtifactName, renderArtifact, settleArtifact } from './e2e-artifact.js';

const RUN_A = '0f8b6a52-3c1e-4d7a-9b2f-5e6d7c8b9a01';
const RUN_B = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

describe('renderArtifact', () => {
  it('leaves every deterministic value as it was (F2)', () => {
    const text = renderArtifact({
      state: 'resolved',
      cost: 110000,
      distance: 0.25,
      key: 'route_ticket:T-a:9f2c',
      uid: '3',
      steps: 3,
      absent: null,
      flag: false,
    });
    expect(JSON.parse(text)).toEqual({
      absent: null,
      cost: 110000,
      distance: 0.25,
      flag: false,
      key: 'route_ticket:T-a:9f2c',
      state: 'resolved',
      steps: 3,
      uid: '3',
    });
  });

  it('gives one value one token and two values two tokens (F3)', () => {
    const parsed = JSON.parse(
      renderArtifact(
        { park: { draft: '17', run: RUN_A }, outbox: { draft: '17', run: RUN_A }, other: RUN_B },
        [{ value: '17', kind: 'uid' }],
      ),
    ) as Record<string, Record<string, string> | string>;
    expect(parsed['park']).toEqual(parsed['outbox']);
    expect(parsed['park']).toEqual({ draft: '<uid:1>', run: '<uuid:2>' });
    expect(parsed['other']).toBe('<uuid:1>');
  });

  it('replaces a registered value only where it is the whole string (F2)', () => {
    const parsed = JSON.parse(renderArtifact({ uid: '3', steps: 3, text: 'step 3 of 3' }, [{ value: '3', kind: 'uid' }]));
    expect(parsed).toEqual({ steps: 3, text: 'step 3 of 3', uid: '<uid:1>' });
  });

  it('replaces a scoped value under its own keys and nowhere else (F9)', () => {
    const parsed = JSON.parse(
      renderArtifact(
        { outbox: { epoch: '1', payload: { draftExternalId: '1' } }, drafts: [{ uid: '1' }] },
        [{ value: '1', kind: 'uid', keys: ['uid', 'draftExternalId'] }],
      ),
    );
    expect(parsed).toEqual({
      drafts: [{ uid: '<uid:1>' }],
      outbox: { epoch: '1', payload: { draftExternalId: '<uid:1>' } },
    });
  });

  it('replaces a scoped number under its own keys, and leaves the same number elsewhere (F12)', () => {
    const parsed = JSON.parse(
      renderArtifact(
        { run: { partition: 7, attempt: 7 }, steps: 7 },
        [{ value: '7', kind: 'partition', keys: ['partition'] }],
      ),
    );
    expect(parsed).toEqual({ run: { attempt: 7, partition: '<partition:1>' }, steps: 7 });
  });

  it('replaces a uuid and a timestamp inside a longer string', () => {
    const parsed = JSON.parse(renderArtifact({ note: `run ${RUN_A} at 2026-09-26T10:11:12.345Z` }));
    expect(parsed).toEqual({ note: 'run <uuid:1> at <time>' });
  });

  it('replaces a timestamp in Postgres text form (F11)', () => {
    const parsed = JSON.parse(renderArtifact({ at: '2026-09-26 15:49:20.12+00', day: '2026-09-26' }));
    expect(parsed).toEqual({ at: '<time>', day: '2026-09-26' });
  });

  it('renders equal objects to equal text whatever their key order (F4)', () => {
    expect(renderArtifact({ b: 1, a: { d: 2, c: 3 } })).toBe(renderArtifact({ a: { c: 3, d: 2 }, b: 1 }));
  });

  it('renders a bigint as its digits and a Date as a time token (F5)', () => {
    expect(JSON.parse(renderArtifact({ epoch: 999n, at: new Date(0) }))).toEqual({ at: '<time>', epoch: '999' });
  });

  it('keeps a long vector as its length and digest, and still tells two apart', () => {
    const one = Array.from({ length: 64 }, (_, i) => i / 64);
    const two = one.map((x, i) => (i === 63 ? x + 1e-9 : x));
    const a = JSON.parse(renderArtifact({ v: one })) as { v: { numbers: number; sha256: string } };
    const b = JSON.parse(renderArtifact({ v: two })) as { v: { numbers: number; sha256: string } };
    expect(a.v.numbers).toBe(64);
    expect(a.v.sha256).not.toBe(b.v.sha256);
  });
});

describe('settleArtifact', () => {
  function scratch(): { golden: string; actual: string } {
    const golden = join(mkdtempSync(join(tmpdir(), 'e2e-artifact-')), 'case.json');
    return { golden, actual: golden.replace(/\.json$/, '.actual.json') };
  }

  it('fails a case that has no committed artifact, and writes no golden (F6, F10)', () => {
    const { golden, actual } = scratch();
    expect(settleArtifact(golden, '{"a":1}\n', false)).toBe('missing');
    expect(existsSync(golden)).toBe(false);
    expect(readFileSync(actual, 'utf8')).toBe('{"a":1}\n');
    // The rerun fails the same way: nothing was accepted.
    expect(settleArtifact(golden, '{"a":1}\n', false)).toBe('missing');
  });

  it('fails a changed artifact, keeps the golden, and writes the new text beside it (F7, F10)', () => {
    const { golden, actual } = scratch();
    writeFileSync(golden, '{"a":1}\n');
    expect(settleArtifact(golden, '{"a":2}\n', false)).toBe('changed');
    expect(readFileSync(golden, 'utf8')).toBe('{"a":1}\n');
    expect(readFileSync(actual, 'utf8')).toBe('{"a":2}\n');
    expect(settleArtifact(golden, '{"a":2}\n', false)).toBe('changed');
  });

  it('writes the golden only when accepted, and clears the new text beside it', () => {
    const { golden, actual } = scratch();
    writeFileSync(golden, '{"a":1}\n');
    settleArtifact(golden, '{"a":2}\n', false);
    expect(settleArtifact(golden, '{"a":2}\n', true)).toBe('accepted');
    expect(readFileSync(golden, 'utf8')).toBe('{"a":2}\n');
    expect(existsSync(actual)).toBe(false);
  });

  it('matches an artifact identical to the committed one, and clears a stale new text', () => {
    const { golden, actual } = scratch();
    writeFileSync(golden, '{"a":1}\n');
    writeFileSync(actual, '{"a":0}\n');
    expect(settleArtifact(golden, '{"a":1}\n', false)).toBe('match');
    expect(existsSync(actual)).toBe(false);
  });
});

describe('claimArtifactName', () => {
  const FILE = 'src/e2e/suite-x.db.test.ts';

  it('refuses a second case that names the same file (F8)', () => {
    claimArtifactName('suite-x/case-y', FILE, 'first case');
    expect(() => claimArtifactName('suite-x/case-y', FILE, 'second case')).toThrow(/two cases/);
  });

  it('lets a retry of the same case claim its name again (F8)', () => {
    claimArtifactName('suite-x/case-z', FILE, 'retried case');
    expect(() => claimArtifactName('suite-x/case-z', FILE, 'retried case')).not.toThrow();
  });

  it('refuses a name under another file\'s suite, which a worker of its own could not see (F8)', () => {
    expect(() => claimArtifactName('suite-w/case-y', FILE, 'a case')).toThrow(/suite-x/);
  });

  it('refuses a name that leaves the artifact directory', () => {
    expect(() => claimArtifactName('../escape', FILE, 'a case')).toThrow(/name/);
  });
});
