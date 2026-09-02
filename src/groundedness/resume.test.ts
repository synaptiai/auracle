// The resume file that lets a five-hour scoring pass survive an outage.
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openResume } from './resume.js';

const FREE = { costMicros: 0, costUnknown: false };

describe('openResume (DEC-18)', () => {
  let dir: string;
  let file: string;
  const key = { modelVer: 'm1', promptVer: 'p1', split: 'fit', halfDigest: 'abcd1234abcd1234' };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'auracle-resume-'));
    file = path.join(dir, 'resume.jsonl');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('starts empty and remembers what it was told', async () => {
    const first = await openResume(file, key);
    expect(first.done.size).toBe(0);
    await first.record('SYN-000001', { coverage: 1, grounded: true, grade: null }, FREE);
    await first.record('SYN-000002', null, FREE);

    const second = await openResume(file, key);
    expect(second.done.size).toBe(2);
    expect(second.done.get(await second.idKey('SYN-000001'))).toEqual({
      coverage: 1, grounded: true, grade: null,
    });
    // A draft the judge could not score is remembered as such, so a resume
    // does not re-attempt it and quietly change the attrition count.
    expect(second.done.get(await second.idKey('SYN-000002'))).toBeNull();
  });

  // A real half's ticket id is a Message-ID. It carries the customer's domain
  // and often a local part their system minted, and this file sits on disk
  // beside the corpus. Nothing in it may be that value (DEC-18).
  it('writes no ticket identifier in the clear', async () => {
    const store = await openResume(file, key);
    await store.record('order-4471@customer-domain.example', {
      coverage: 0.5, grounded: false, grade: 'absent',
    }, FREE);
    const text = await readFile(file, 'utf8');
    expect(text).not.toContain('order-4471');
    expect(text).not.toContain('customer-domain');
  });

  // The half digest names the CASES a run covered. It cannot see a corpus
  // whose claims changed under fixed ticket ids, and a resumed run would then
  // reuse samples scored against text that no longer exists.
  it('refuses a file scored against different claims or documents', async () => {
    const keyed = { ...key, inputDigest: 'aaaa1111bbbb2222' };
    const store = await openResume(file, keyed);
    await store.record('SYN-000001', { coverage: 1, grounded: true, grade: null }, FREE);
    await expect(openResume(file, { ...keyed, inputDigest: 'cccc3333dddd4444' }))
      .rejects.toThrow(/different claims or different documents/);
    // The same inputs still resume.
    expect((await openResume(file, keyed)).done.size).toBe(1);
  });

  // A file written before the input digest existed may well cover the same
  // work. Discarding hours of paid-for scoring on a suspicion is the loss this
  // whole file exists to prevent, so it resumes and says what it could not
  // check.
  it('resumes a file written before the input digest, and says so', async () => {
    const store = await openResume(file, key);
    await store.record('SYN-000001', { coverage: 1, grounded: true, grade: null }, FREE);
    const warned: string[] = [];
    const original = console.warn;
    console.warn = (msg: string) => { warned.push(msg); };
    try {
      expect((await openResume(file, { ...key, inputDigest: 'aaaa1111bbbb2222' })).done.size).toBe(1);
    } finally {
      console.warn = original;
    }
    expect(warned.join(' ')).toContain('before the input digest existed');
  });

  // A file from another model, prompt or half describes a different run. Mixing
  // two runs' samples silently would publish a number from neither.
  it.each([
    ['modelVer', { ...key, modelVer: 'm2' }],
    ['promptVer', { ...key, promptVer: 'p2' }],
    ['split', { ...key, split: 'report' }],
    ['halfDigest', { ...key, halfDigest: '9999999999999999' }],
  ])('refuses a file whose %s disagrees', async (_field, other) => {
    const store = await openResume(file, key);
    await store.record('SYN-000001', { coverage: 1, grounded: true, grade: null }, FREE);
    await expect(openResume(file, other)).rejects.toThrow(/describes a different run/);
  });

  it('refuses a file it cannot parse rather than starting over', async () => {
    await writeFile(file, 'not json\n');
    await expect(openResume(file, key)).rejects.toThrow(/resume file/);
  });

  // A killed shell is one of the three deaths this file exists to survive, and
  // it leaves a torn last line. Refusing the whole file discards every draft
  // already paid for, which is the loss the file was built to prevent.
  it('keeps the drafts before a torn last line, and cuts the tail off', async () => {
    const store = await openResume(file, key);
    for (const id of ['SYN-000001', 'SYN-000002', 'SYN-000003']) {
      await store.record(id, { coverage: 1, grounded: true, grade: null }, FREE);
    }
    const whole = await readFile(file, 'utf8');
    // The writer died 12 bytes into its fourth append.
    await writeFile(file, whole + '{"id":"abc12');

    const resumed = await openResume(file, key);
    expect(resumed.done.size).toBe(3);

    // The tail is gone from the file too. Appending onto a partial line would
    // splice two records into one no later run could read.
    const cut = await readFile(file, 'utf8');
    expect(cut).toBe(whole);
    expect((await stat(file)).size).toBe(Buffer.byteLength(whole));

    // And the file still takes a fourth draft cleanly after the recovery.
    await resumed.record('SYN-000004', { coverage: 0, grounded: false, grade: 'absent' }, FREE);
    expect((await openResume(file, key)).done.size).toBe(4);
  });

  // The earliest possible death: killed while writing the header itself. The
  // tail-truncation cuts the file back to nothing, and the run should then
  // start cleanly — there is no work to lose. Refusing here fails a run over a
  // file that holds no drafts at all.
  it('starts cleanly when the only line written was itself torn', async () => {
    await writeFile(file, '{"header":true,"modelVer":"m1"');
    const store = await openResume(file, key);
    expect(store.done.size).toBe(0);
    // And it is usable: a draft recorded now survives a reopen.
    await store.record('SYN-000001', { coverage: 1, grounded: true, grade: null }, FREE);
    expect((await openResume(file, key)).done.size).toBe(1);
  });

  // A line that is unreadable anywhere but the end is corruption, not a torn
  // write. Guessing which drafts it lost would publish a number from a sample
  // nobody can describe.
  it('still refuses an unreadable line that is not the last one', async () => {
    const store = await openResume(file, key);
    await store.record('SYN-000001', { coverage: 1, grounded: true, grade: null }, FREE);
    await appendFile(file, 'torn in the middle\n');
    await store.record('SYN-000002', { coverage: 1, grounded: true, grade: null }, FREE);
    await expect(openResume(file, key)).rejects.toThrow(/cannot read/);
  });

  // The fit job validates its samples; the report job reads them straight out
  // of this map. A JSON-valid row holding a string coverage would have moved a
  // published number with nothing to stop it.
  it.each([
    ['a string coverage', { coverage: '1', grounded: true, grade: null }],
    ['a coverage above one', { coverage: 1.5, grounded: true, grade: null }],
    ['no grounded flag', { coverage: 1, grade: null }],
    ['a numeric grade', { coverage: 1, grounded: false, grade: 7 }],
  ])('refuses a row carrying %s', async (_name, sample) => {
    await writeFile(
      file,
      JSON.stringify({ header: true, ...key }) + '\n'
        + JSON.stringify({ id: 'abcd1234abcd1234', sample }) + '\n',
    );
    await expect(openResume(file, key)).rejects.toThrow(/sample this job cannot read/);
  });

  // What a resumed run reports as spend is what the whole fit cost, not what
  // its last attempt cost (DEC-25).
  it('carries each draft\'s spend across a restart', async () => {
    const store = await openResume(file, key);
    await store.record('SYN-000001', { coverage: 1, grounded: true, grade: null }, {
      costMicros: 120, costUnknown: false,
    });
    await store.record('SYN-000002', null, { costMicros: 40, costUnknown: true });

    const resumed = await openResume(file, key);
    expect(resumed.cost.get(resumed.idKey('SYN-000001'))).toEqual({
      costMicros: 120, costUnknown: false,
    });
    expect(resumed.cost.get(resumed.idKey('SYN-000002'))).toEqual({
      costMicros: 40, costUnknown: true,
    });
  });

  // A row written before the spend field existed is absent from the map. The
  // reader must mark the total a floor rather than count that draft as free.
  it('holds no spend for a row written before the field existed', async () => {
    await writeFile(
      file,
      JSON.stringify({ header: true, ...key }) + '\n'
        + JSON.stringify({ id: 'abcd1234abcd1234', sample: { coverage: 1, grounded: true, grade: null } }) + '\n',
    );
    const resumed = await openResume(file, key);
    expect(resumed.done.size).toBe(1);
    expect(resumed.cost.size).toBe(0);
  });
});
