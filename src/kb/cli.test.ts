// The knowledge-base CLI reads exactly one directory, and names the fault
// before any model or ledger is touched.
//
// pnpm 11.20.0 forwards the `--` in `pnpm run load-docs -- <dir>`, and a
// direct `node dist/kb/cli.js -- <dir>` keeps it too, so the CLI drops it.
//
// Each case starts the real entry point from source. The unit project's
// DATABASE_URL refuses connections, so a case that gets past the directory
// fails at the ledger, after it has said what it is indexing.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { REPO_ROOT, startFromSource } from '../test-support/source-process.js';

// The child runs from an empty directory, so it reads no developer's `.env`.
const SCRATCH = mkdtempSync(path.join(tmpdir(), 'auracle-load-docs-'));
const DOCS = mkdtempSync(path.join(tmpdir(), 'auracle-load-docs-dir-'));
afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  rmSync(DOCS, { recursive: true, force: true });
});

async function loadDocs(args: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENROUTER_API_KEY: 'sk-test-not-a-key',
    PRODUCTS_FILE: `${REPO_ROOT}products.json`,
  };
  delete env['EMBED_MODEL_VER'];
  delete env['EMBEDDINGS_USD_PER_MTOK'];
  const run = startFromSource('src/kb/cli.ts', { args, cwd: SCRATCH, env });
  const { code } = await run.closed;
  return { code, stdout: run.stdout(), stderr: run.stderr() };
}

describe('load-docs reads its directory', () => {
  it('reaches the directory, with or without a separator before it', async () => {
    for (const args of [[DOCS], ['--', DOCS]]) {
      const run = await loadDocs(args);
      expect(run.stdout, run.stderr).toContain(`indexing ${DOCS} with`);
    }
  }, 30_000);

  it('names a directory that does not exist, before it opens the ledger', async () => {
    const missing = path.join(DOCS, 'no-such-directory');
    const run = await loadDocs([missing]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(`load-docs: ${missing} is not a directory`);
    expect(run.stdout).not.toContain('indexing');
  }, 30_000);

  it('names a file given in place of a directory', async () => {
    const file = path.join(DOCS, 'a-file.md');
    writeFileSync(file, '# a file\n');
    const run = await loadDocs([file]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(`load-docs: ${file} is not a directory`);
    expect(run.stdout).not.toContain('indexing');
  }, 30_000);

  // A path the system cannot read for another reason names that reason, not
  // a missing directory. A name over 255 bytes fails with ENAMETOOLONG for
  // any user, root included.
  it('names the reason a path cannot be read', async () => {
    const tooLong = path.join(DOCS, 'a'.repeat(300));
    const run = await loadDocs([tooLong]);
    expect(run.code).toBe(1);
    // The errno alone, not the system's message, which repeats the path.
    const escaped = tooLong.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(run.stderr).toMatch(new RegExp(`load-docs: cannot read ${escaped}: ENAMETOOLONG$`, 'm'));
    expect(run.stdout).not.toContain('indexing');
  }, 30_000);

  it('names a path under a file as not a directory', async () => {
    const file = path.join(DOCS, 'a-parent-file.md');
    writeFileSync(file, '# a file\n');
    const under = path.join(file, 'sub');
    const run = await loadDocs([under]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(`load-docs: ${under} is not a directory`);
  }, 30_000);

  it('refuses a second directory rather than ignore it', async () => {
    const run = await loadDocs([DOCS, DOCS]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('usage: pnpm run load-docs -- <dir-of-markdown>');
    expect(run.stdout).not.toContain('indexing');
  }, 30_000);

  it('prints the usage when no directory follows the separator', async () => {
    const run = await loadDocs(['--']);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('usage: pnpm run load-docs -- <dir-of-markdown>');
  }, 30_000);
});
