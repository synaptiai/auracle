// The resume file that lets a five-hour scoring pass survive an outage.
import { appendFile, chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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

  // JSON that parses to something other than an object is no header and no
  // row. Read as one, it raised a TypeError that named no file, and the
  // runbook sends that operator nowhere.
  for (const line of ['null', '[]', '1', '"x"']) {
    it(`refuses a header that is valid JSON but no object, by name: ${line}`, async () => {
      await writeFile(file, `${line}\n`);
      await expect(openResume(file, key)).rejects.toThrow(/does not begin with a run header/);
    });

    it(`refuses a row that is valid JSON but no object, by name: ${line}`, async () => {
      const store = await openResume(file, key);
      await store.record('SYN-000001', { coverage: 1, grounded: true, grade: null }, FREE);
      await appendFile(file, `${line}\n`);
      await store.record('SYN-000002', { coverage: 1, grounded: true, grade: null }, FREE);
      await expect(openResume(file, key)).rejects.toThrow(/holds a line this job cannot read/);
    });
  }

  // An object row with no draft id is damage too. Skipped, it would hide a
  // lost draft behind a run that looks complete.
  it('refuses an object row that names no draft', async () => {
    const store = await openResume(file, key);
    await store.record('SYN-000001', { coverage: 1, grounded: true, grade: null }, FREE);
    await appendFile(file, '{"id": 5}\n');
    await store.record('SYN-000002', { coverage: 1, grounded: true, grade: null }, FREE);
    await expect(openResume(file, key)).rejects.toThrow(/holds a line this job cannot read/);
  });

  // The job writes a header only to a missing or empty file. A second one is
  // left by an earlier job that read a file it could not open as a fresh
  // start. It counts only when it describes this run, or the samples after it
  // mix two runs.
  it('resumes past a second header that describes this run', async () => {
    const store = await openResume(file, key);
    await store.record('SYN-000001', { coverage: 1, grounded: true, grade: null }, FREE);
    await appendFile(file, JSON.stringify({ header: true, ...key }) + '\n');
    await store.record('SYN-000002', { coverage: 0.5, grounded: false, grade: null }, FREE);
    expect((await openResume(file, key)).done.size).toBe(2);
  });

  const digested = { ...key, inputDigest: 'aaaa1111bbbb2222' };
  for (const [field, value] of [
    ['modelVer', 'm2'], ['promptVer', 'p2'], ['split', 'report'], ['halfDigest', 'ffff0000ffff0000'],
    ['inputDigest', 'another-input'],
  ] as const) {
    it(`refuses a second header with another ${field}`, async () => {
      const store = await openResume(file, digested);
      await store.record('SYN-000001', { coverage: 1, grounded: true, grade: null }, FREE);
      await appendFile(file, JSON.stringify({ header: true, ...digested, [field]: value }) + '\n');
      await store.record('SYN-000002', { coverage: 0.1, grounded: false, grade: null }, FREE);
      await expect(openResume(file, digested)).rejects.toThrow(/second run header that describes a different run/);
    });
  }

  // The first header may predate the input digest, and the file then resumes
  // with a warning. A second header that carries this run's digest describes
  // the same run, so it resumes too. One that carries another digest does not.
  it('resumes past a second header that adds this run\'s digest to an older file', async () => {
    const store = await openResume(file, key);
    await store.record('SYN-000001', { coverage: 1, grounded: true, grade: null }, FREE);
    await appendFile(file, JSON.stringify({ header: true, ...digested }) + '\n');
    await store.record('SYN-000002', { coverage: 0.5, grounded: false, grade: null }, FREE);
    const original = console.warn;
    console.warn = () => {};
    try {
      expect((await openResume(file, digested)).done.size).toBe(2);
      await expect(openResume(file, { ...key, inputDigest: 'cccc3333dddd4444' }))
        .rejects.toThrow(/second run header that describes a different run/);
    } finally {
      console.warn = original;
    }
  });

  // The first header's digest counts too, when this run carries none.
  it('refuses a second header whose digest differs from the first header\'s', async () => {
    const store = await openResume(file, digested);
    await store.record('SYN-000001', { coverage: 1, grounded: true, grade: null }, FREE);
    await appendFile(file, JSON.stringify({ header: true, ...key, inputDigest: 'cccc3333dddd4444' }) + '\n');
    await expect(openResume(file, key)).rejects.toThrow(/second run header that describes a different run/);
  });

  // A second header with no digest came from a job that could not check its
  // inputs. It resumes, as a first header with none does, and says so.
  it('resumes past a second header with no digest, and says so', async () => {
    const store = await openResume(file, digested);
    await store.record('SYN-000001', { coverage: 1, grounded: true, grade: null }, FREE);
    await appendFile(file, JSON.stringify({ header: true, ...key }) + '\n');
    await store.record('SYN-000002', { coverage: 0.5, grounded: false, grade: null }, FREE);
    const warned: string[] = [];
    const original = console.warn;
    console.warn = (msg: string) => { warned.push(msg); };
    try {
      expect((await openResume(file, digested)).done.size).toBe(2);
    } finally {
      console.warn = original;
    }
    expect(warned.join(' ')).toContain('second run header was written before the input digest existed');
  });

  // A second header means an earlier job started over and scored drafts
  // again. Both scorings were paid for, so the spend of a repeated draft is
  // the sum, and an unknown part keeps the sum a floor.
  it('adds the spend of a draft the file records twice', async () => {
    const store = await openResume(file, key);
    await store.record('SYN-000001', { coverage: 1, grounded: true, grade: null }, { costMicros: 120, costUnknown: false });
    await appendFile(file, JSON.stringify({ header: true, ...key }) + '\n');
    await store.record('SYN-000001', { coverage: 0.5, grounded: false, grade: null }, { costMicros: 30, costUnknown: true });
    const resumed = await openResume(file, key);
    expect(resumed.cost.get(resumed.idKey('SYN-000001'))).toEqual({ costMicros: 150, costUnknown: true });
    expect(resumed.done.get(resumed.idKey('SYN-000001'))).toEqual({ coverage: 0.5, grounded: false, grade: null });
  });

  // Any scoring of unknown spend keeps the sum a floor, whichever came first.
  it('keeps the spend of a draft scored twice a floor when either scoring is unknown', async () => {
    const sample = { coverage: 1, grounded: true, grade: null };
    const id = (await openResume(file, key)).idKey('SYN-000001');
    const header = JSON.stringify({ header: true, ...key });
    const cases: [string, { costMicros: number; costUnknown: boolean }][] = [
      // Unknown first, then known.
      [JSON.stringify({ id, sample, cost_micros: 30, cost_unknown: true }) + '\n'
        + JSON.stringify({ id, sample, cost_micros: 120, cost_unknown: false }), { costMicros: 150, costUnknown: true }],
      // No spend recorded first, as before the field existed, then known.
      [JSON.stringify({ id, sample }) + '\n'
        + JSON.stringify({ id, sample, cost_micros: 120, cost_unknown: false }), { costMicros: 120, costUnknown: true }],
      // Known first, then no spend recorded.
      [JSON.stringify({ id, sample, cost_micros: 120, cost_unknown: false }) + '\n'
        + JSON.stringify({ id, sample }), { costMicros: 120, costUnknown: true }],
    ];
    for (const [rows, spent] of cases) {
      const [one, two] = rows.split('\n');
      await writeFile(file, [header, one, header, two].join('\n') + '\n');
      expect((await openResume(file, key)).cost.get(id), rows).toEqual(spent);
    }
  });

  // Only a missing file is a fresh start. Read as one, a file the job cannot
  // read discarded every draft it held and wrote a second header after them.
  it.skipIf(process.getuid?.() === 0)('refuses a file it cannot read, by name, rather than starting over', async () => {
    const store = await openResume(file, key);
    await store.record('SYN-000001', { coverage: 1, grounded: true, grade: null }, FREE);
    await chmod(file, 0o200);
    try {
      await expect(openResume(file, key)).rejects.toThrow(new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    } finally {
      await chmod(file, 0o600);
    }
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
