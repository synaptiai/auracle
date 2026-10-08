// `scripts/bootstrap.sh` tells a newcomer what is missing and how to fix it,
// and its check mode changes nothing.
//
// Each case copies the script beside a `package.json` of its own, and runs it
// with a PATH that holds the real node and stand-ins for corepack, pnpm and
// docker. A stand-in records each run in a log, so a case can see whether it
// ran. Every case has a corepack and a docker of its own, so no host tool
// runs: a host corepack would write shims, and the unit project reaches no
// Docker daemon.
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRATCH = mkdtempSync(path.join(tmpdir(), 'auracle-bootstrap-'));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

interface Tool {
  /** What the stand-in writes to stdout. */
  readonly stdout?: string;
  /** What the stand-in writes to stderr. */
  readonly stderr?: string;
  /**
   * A printf format the stand-in writes to stderr, for bytes a plain string
   * cannot carry: `\\377` is the byte 0xff.
   */
  readonly stderrFormat?: string;
  /** Its exit code. */
  readonly exit: number;
}

let caseCount = 0;

/** Runs the script in a fresh directory with these stand-ins on PATH. */
function bootstrap(options: {
  readonly args?: readonly string[];
  readonly packageManager?: string | null;
  /** A stand-in, or null for no corepack at all, as Node 25 and later ship. */
  readonly corepack?: Tool | null;
  readonly pnpm?: Tool;
  /** The locale the script runs under, as a developer's shell sets it. */
  readonly locale?: string;
}): { status: number | null; stdout: string; stderr: string; ran: string } {
  caseCount += 1;
  const root = path.join(SCRATCH, `case-${caseCount}`);
  const bin = path.join(root, 'bin');
  mkdirSync(path.join(root, 'tree', 'scripts'), { recursive: true });
  mkdirSync(bin);
  copyFileSync(`${REPO_ROOT}scripts/bootstrap.sh`, path.join(root, 'tree', 'scripts', 'bootstrap.sh'));
  const manifest = options.packageManager === null ? {} : { packageManager: options.packageManager ?? 'pnpm@11.20.0' };
  writeFileSync(path.join(root, 'tree', 'package.json'), JSON.stringify(manifest));
  symlinkSync(process.execPath, path.join(bin, 'node'));
  const log = path.join(root, 'ran.log');
  const tools: ReadonlyArray<readonly [string, Tool | undefined]> = [
    ['corepack', options.corepack === null ? undefined : (options.corepack ?? { exit: 1 })],
    ['pnpm', options.pnpm],
    ['docker', { exit: 1 }],
  ];
  for (const [name, tool] of tools) {
    if (tool === undefined) continue;
    const script = path.join(bin, name);
    writeFileSync(script, [
      '#!/bin/sh',
      `echo "${name} $*" >> '${log}'`,
      tool.stdout === undefined ? '' : `printf '%s\\n' '${tool.stdout}'`,
      tool.stderr === undefined ? '' : `printf '%s\\n' '${tool.stderr}' >&2`,
      tool.stderrFormat === undefined ? '' : `printf '${tool.stderrFormat}' >&2`,
      `exit ${tool.exit}`,
    ].join('\n'));
    chmodSync(script, 0o755);
  }
  const run = spawnSync('bash', [path.join(root, 'tree', 'scripts', 'bootstrap.sh'), ...(options.args ?? [])], {
    cwd: path.join(root, 'tree'),
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, ...(options.locale === undefined ? {} : { LC_ALL: options.locale }) },
    encoding: 'utf8',
    // spawnSync blocks the worker, so the test's own timeout cannot stop it.
    timeout: 10_000,
  });
  // A spawn that failed or was killed names its cause, rather than leaving
  // every assertion to read undefined output.
  if (run.error !== undefined) throw run.error;
  if (run.signal !== null) throw new Error(`the bootstrap was killed by ${run.signal}: ${run.stderr}`);
  return {
    status: run.status,
    stdout: run.stdout,
    stderr: run.stderr,
    ran: existsSync(log) ? readFileSync(log, 'utf8') : '',
  };
}

describe('the bootstrap script', () => {
  it('enables nothing in check mode', () => {
    const run = bootstrap({ args: ['--check'], corepack: { exit: 0 } });
    expect(run.ran).not.toContain('corepack');
    expect(run.stdout).toContain("run 'corepack enable' (Node 22 to 24), or run 'npm install -g pnpm@11.20.0'");
    expect(run.status).toBe(1);
  });

  it('names the install route alone once an enable has run', () => {
    const run = bootstrap({ corepack: { exit: 0 } });
    expect(run.ran).toContain('corepack enable');
    expect(run.stdout).toMatch(/pnpm +MISSING — run 'npm install -g pnpm@11\.20\.0', then run this again/);
    expect(run.stdout).not.toContain("run 'corepack enable'");
  });

  // Check mode, so a corepack the host keeps in /usr/bin changes the advice
  // and fails the case, but is never run.
  it('names corepack enable only where corepack exists', () => {
    const run = bootstrap({ args: ['--check'], corepack: null });
    expect(run.stdout).toMatch(/pnpm +MISSING — run 'npm install -g pnpm@11\.20\.0', then run this again/);
    expect(run.stdout).not.toContain('corepack');
    expect(run.ran).toBe('');
  });

  it('names the first line of a failed enable', () => {
    // Three lines, so a cut at the last line break would still show one.
    const run = bootstrap({ corepack: { stderr: 'EACCES: permission denied\n    at line two\n    at line three', exit: 1 } });
    expect(run.stdout).toMatch(/corepack +could not enable: EACCES: permission denied$/m);
    expect(run.stdout).not.toContain('at line');
  });

  it('gives a reason when a failed enable prints none', () => {
    const run = bootstrap({ corepack: { exit: 1 } });
    expect(run.stdout).toMatch(/corepack +could not enable: no reason given$/m);
  });

  // A carriage return inside the reason would move the cursor to the start
  // of the line, and the reason would overwrite the step's label.
  it('names a reason with its padding trimmed and each carriage return made a space', () => {
    const run = bootstrap({ corepack: { stderr: '\r\n   Preparing\rEACCES: permission denied  \r', exit: 1 } });
    // A space takes the carriage return's place, so the words stay apart.
    expect(run.stdout).toMatch(/corepack +could not enable: Preparing EACCES: permission denied\n/);
  });

  // C.UTF-8 ships with glibc and with macOS. A locale the host lacks falls
  // back to C, and bash 3.2 says nothing, so the case first proves that the
  // locale takes effect under the same bash and PATH.
  it('names a reason that holds a byte the locale cannot read', () => {
    const locale = 'C.UTF-8';
    const charmap = spawnSync('bash', ['-c', 'locale charmap'], {
      env: { PATH: '/usr/bin:/bin', LC_ALL: locale },
      encoding: 'utf8',
    });
    // A probe that cannot run says why, so a missing tool never reads as a
    // missing locale.
    expect(charmap.error).toBeUndefined();
    expect(charmap.status, `locale charmap failed: ${charmap.stderr}`).toBe(0);
    expect(charmap.stdout.trim(), `${locale} must be installed for this case`).toBe('UTF-8');
    const run = bootstrap({ corepack: { stderrFormat: '\\n\\377\\376 EACCES: permission denied\\n', exit: 1 }, locale });
    // The raw bytes reach the step, and read back as U+FFFD. A stand-in that
    // printed the escapes as text would leave a backslash instead.
    expect(run.stdout).toMatch(/could not enable: \uFFFD\uFFFD EACCES: permission denied$/m);
  });

  it('names a reason that follows a blank line', () => {
    const run = bootstrap({ corepack: { stderr: '\nEACCES: permission denied', exit: 1 } });
    expect(run.stdout).toMatch(/corepack +could not enable: EACCES: permission denied$/m);
  });

  it('names no version when package.json pins none', () => {
    const run = bootstrap({ packageManager: null });
    // The case's own corepack ran, not one from the host.
    expect(run.ran).toContain('corepack enable');
    expect(run.stdout).toContain('install the pnpm version package.json pins');
    expect(run.stdout).not.toContain('pnpm@');
  });

  it('never prints a crafted pin as a command', () => {
    const run = bootstrap({ packageManager: 'pnpm@1;touch${IFS}pwned' });
    expect(run.stdout).toContain('install the pnpm version package.json pins');
    expect(run.stdout).not.toContain('touch');
  });

  it('keeps a notice pnpm writes to stderr out of the version', () => {
    const run = bootstrap({ args: ['--check'], pnpm: { stdout: '11.20.0', stderr: 'notice: update available', exit: 0 } });
    expect(run.stdout).toMatch(/pnpm +11\.20\.0$/m);
    // The case's own docker answered the daemon check, not one from the host.
    expect(run.ran).toContain('docker info');
    expect(run.stdout).not.toContain('notice');
  });

  it('names the first line that holds text of the error a failing pnpm prints to stdout', () => {
    // A blank line first, then three lines, so neither a blank reason nor a
    // cut at the wrong line break passes.
    const run = bootstrap({
      args: ['--check'],
      pnpm: { stdout: '\nERR_PNPM_BROKEN something broke\n    at line two\n    at line three', exit: 1 },
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(/pnpm +present but fails: ERR_PNPM_BROKEN something broke$/m);
    expect(run.stdout).not.toContain('at line');
  });

  it('names the exit code when a failing pnpm prints only blanks', () => {
    const run = bootstrap({ args: ['--check'], pnpm: { stdout: '   ', exit: 4 } });
    expect(run.stdout).toMatch(/pnpm +present but fails: exit 4$/m);
  });

  it('stops on a pnpm that cannot run, and says why', () => {
    const run = bootstrap({ args: ['--check'], pnpm: { exit: 3 } });
    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(/pnpm +present but fails: exit 3$/m);
  });
});
