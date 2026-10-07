// The console refuses a blank or padded CONSOLE_HOST before it opens anything.
//
// Node's listen() reads an empty host as every interface. With
// CONSOLE_IDENTITY_HEADER set, anyone who reached the port could then name a
// rostered reviewer and approve customer replies. The webhook holds the same
// rule, through the same helper.
//
// Each case starts the real entry point from source, as `pnpm run
// dev:console` does, from an empty directory so no developer's `.env` reaches
// it. The refusal comes before the pool, so no ledger is needed.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRATCH = mkdtempSync(path.join(tmpdir(), 'auracle-console-host-'));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

/** Runs the console with CONSOLE_HOST set, and returns its exit code and stderr. */
async function run(host: string): Promise<{ code: number | null; stderr: string }> {
  // tsx loaded into one node process, so a SIGKILL reaches the console and
  // not only a wrapper. The tsconfig maps the core onto its source.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CONSOLE_HOST: host,
    TSX_TSCONFIG_PATH: `${REPO_ROOT}console/tsconfig.dev.json`,
  };
  const child = spawn(
    process.execPath,
    [
      '--import', pathToFileURL(`${REPO_ROOT}node_modules/tsx/dist/loader.mjs`).href,
      `${REPO_ROOT}console/src/main.ts`,
    ],
    { cwd: SCRATCH, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  try {
    // 'close' fires once the output streams have drained, unlike 'exit'.
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exit) => resolve(exit));
    });
    return { code, stderr };
  } finally {
    clearTimeout(timer);
  }
}

describe('the console bind address', () => {
  it.each(['', '   '])('refuses a blank CONSOLE_HOST (%j)', async (blank) => {
    const { code, stderr } = await run(blank);
    expect(code).toBe(1);
    expect(stderr).toContain('CONSOLE_HOST is set but empty; unset it to bind the default of 127.0.0.1');
  }, 30_000);

  it('refuses a padded CONSOLE_HOST and names the variable', async () => {
    const { code, stderr } = await run(' 127.0.0.1 ');
    expect(code).toBe(1);
    expect(stderr).toContain("CONSOLE_HOST has surrounding whitespace: ' 127.0.0.1 '");
  }, 30_000);
});
