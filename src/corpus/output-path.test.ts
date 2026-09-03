// No real data here: every path is a literal (DEC-18).

import { dirname, join } from 'node:path';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { agentAddressWarning, failureLines, fetchMessages, refuseEmptyExport } from './export-main.js';
import { resolveCorpusOutput, startedAsCommand } from './output-path.js';

const CWD = '/repo';

describe('resolveCorpusOutput', () => {
  it('takes the named path when it lies under corpus/', () => {
    expect(resolveCorpusOutput(['corpus/history.json'], 'corpus/default.json', CWD))
      .toEqual({ path: 'corpus/history.json' });
  });

  it('falls back when no path is named', () => {
    expect(resolveCorpusOutput([], 'corpus/default.json', CWD))
      .toEqual({ path: 'corpus/default.json' });
  });

  // pnpm forwards its own separator to the script. Taken literally, the
  // export wrote a file named `--` into the repository root and printed that
  // it was gitignored. It was not.
  it('ignores the pnpm argument separator', () => {
    expect(resolveCorpusOutput(['--', 'corpus/history.json'], 'corpus/default.json', CWD))
      .toEqual({ path: 'corpus/history.json' });
    expect(resolveCorpusOutput(['--'], 'corpus/default.json', CWD))
      .toEqual({ path: 'corpus/default.json' });
  });

  // Both production callers rely on the default, so a wrong default would
  // ship while every case passed its own explicit cwd. Survived mutation
  // before this case.
  it('defaults to the working directory', () => {
    // A relative path does not discriminate: it resolves under whatever cwd
    // is in force, so a wrong default accepts it just the same. An ABSOLUTE
    // path under the real working directory is accepted only if the default
    // is that directory.
    const absolute = join(process.cwd(), 'corpus', 'x.json');
    expect(resolveCorpusOutput([absolute], 'corpus/d.json')).toEqual({ path: absolute });
    expect(resolveCorpusOutput(['/etc/x.json'], 'corpus/d.json')).toHaveProperty('refusal');
  });

  it.each([
    ['the repository root', 'out.json'],
    ['a tracked directory', 'fixtures/gold/fit.json'],
    ['outside the repository', '/tmp/out.json'],
    ['a traversal out of corpus/', 'corpus/../out.json'],
    ['a sibling that merely starts with the word', 'corpus-backup/out.json'],
  ])('refuses %s', (_name, path) => {
    const result = resolveCorpusOutput([path], 'corpus/default.json', CWD);
    expect(result).toHaveProperty('refusal');
    expect('refusal' in result && result.refusal).toMatch(/writes under corpus\/ only/);
  });
});

describe('failureLines', () => {
  // The identifier is a Message-ID and carries the customer's domain, and
  // this line goes to a terminal and a CI log (DEC-18).
  it('names a failed message by digest, never in the clear', () => {
    const [line] = failureLines([
      { sourceId: '<abc@customer-domain.example>', error: new Error('unparseable MIME') },
    ]);
    expect(line).toMatch(/id digest [0-9a-f]{12}/);
    expect(line).toContain('unparseable MIME');
    expect(line).not.toContain('customer-domain.example');
  });

  it('numbers the failures it reports', () => {
    const lines = failureLines([
      { sourceId: 'a', error: new Error('one') },
      { sourceId: 'b', error: 'two' },
    ]);
    expect(lines[0]).toContain('failure 1');
    expect(lines[1]).toContain('failure 2');
    expect(lines[1]).toContain('two');
  });
});

describe('startedAsCommand', () => {
  // Both CLIs run main() at module load without this. One of them is
  // imported by this very suite, so a wrong answer would shell out to
  // CORPUS_FETCH_CMD in the middle of a test run.
  it('is true only when this module is the entry point', () => {
    const url = 'file:///repo/dist/corpus/export-main.js';
    expect(startedAsCommand(url, '/repo/dist/corpus/export-main.js')).toBe(true);
    expect(startedAsCommand(url, '/repo/dist/other/thing.js')).toBe(false);
  });

  it('is false when there is no entry point at all', () => {
    expect(startedAsCommand('file:///repo/dist/corpus/export-main.js', undefined)).toBe(false);
  });

  // Node resolves `import.meta.url` through symlinks and `process.argv[1]` is
  // the path as typed. Comparing them raw made a CLI reached through a
  // symlinked directory exit 0 having run nothing and reported nothing. On
  // macOS the `/tmp` link alone is enough to reach it.
  it('sees through a symlinked entry path', () => {
    // realpath on the directory too: on macOS `tmpdir()` is itself a symlink
    // (/var -> /private/var), and Node reports `import.meta.url` resolved.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'entry-real-')));
    const real = join(dir, 'main.js');
    writeFileSync(real, '');
    const link = join(mkdtempSync(join(tmpdir(), 'entry-link-')), 'main.js');
    symlinkSync(real, link);
    try {
      // The module was loaded from the real path; the command named the link.
      expect(startedAsCommand(pathToFileURL(real).href, link)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(dirname(link), { recursive: true, force: true });
    }
  });
});

describe('fetchMessages', () => {
  // Node builds this rejection as `Command failed: <the whole command>`, and
  // the command routinely embeds a credential. A bad credential is the
  // likeliest way to reach this path (DEC-18).
  it('never quotes the command when it fails', async () => {
    const secret = 'curl -u operator:hunter2 https://127.0.0.1:1/nowhere';
    await expect(fetchMessages(secret)).rejects.toThrow(/arguments hidden/);
    await expect(fetchMessages(secret)).rejects.not.toThrow(/hunter2/);
  });

  // Node embeds a window of the input in a JSON SyntaxError, and every line
  // here is mail-derived by construction.
  it('never quotes a line it could not parse', async () => {
    const cmd = `printf '%s\\n' 'Dear support, my card 4111 was declined'`;
    await expect(fetchMessages(cmd)).rejects.toThrow(/invalid JSON on line 1/);
    await expect(fetchMessages(cmd)).rejects.not.toThrow(/declined/);
  });

  it('names the line that lacks the required fields, without quoting it', async () => {
    const cmd = `printf '%s\\n' '{"uid":"1","from":"dana@customer-domain.example"}'`;
    await expect(fetchMessages(cmd)).rejects.toThrow(/line 1 has no sourceId and rfc5322Text/);
    await expect(fetchMessages(cmd)).rejects.not.toThrow(/customer-domain/);
  });

  it('reads well-formed lines', async () => {
    const cmd = `printf '%s\\n' '{"sourceId":"1","rfc5322Text":"raw"}'`;
    await expect(fetchMessages(cmd)).resolves.toEqual([{ sourceId: '1', rfc5322Text: 'raw' }]);
  });
});

describe('the decisions main() makes', () => {
  it('warns when it cannot tell the two sides of a conversation apart', () => {
    expect(agentAddressWarning([])).toMatch(/CORPUS_AGENT_ADDRESSES is not set/);
    expect(agentAddressWarning([])).toMatch(/DEC-37/);
    expect(agentAddressWarning(['support@acme.example'])).toBeNull();
  });

  // Without this the validator reports it as a file-format fault, after the
  // whole mailbox has already been fetched.
  it('names an export that produced nothing, and lets one that produced something through', () => {
    expect(refuseEmptyExport(0, 42)).toMatch(/42 message\(s\) normalized/);
    expect(refuseEmptyExport(0, 42)).toMatch(/Nothing was written/);
    expect(refuseEmptyExport(1, 42)).toBeNull();
  });
});
