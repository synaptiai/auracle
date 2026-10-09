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
  /** A stand-in, or null for no corepack at all, as Node 26 and later ship. */
  readonly corepack?: Tool | null;
  readonly pnpm?: Tool;
  /** The locale the script runs under, as a developer's shell sets it. */
  readonly locale?: string;
  /**
   * What `node -v` does: a version as `v22.22.0`, or a tool that fails.
   * Unset, the real node.
   */
  readonly node?: string | Tool;
  /**
   * The python3 stand-in. It answers the version query with `version`, as
   * `3.12.4`, printed the way the script asks for it. Unset, a supported
   * version: the host's own python3 never runs, because macOS ships one that
   * is too old.
   */
  readonly python?: { readonly version?: string; readonly stderr?: string; readonly exit?: number };
}): { status: number | null; stdout: string; stderr: string; ran: string } {
  caseCount += 1;
  const root = path.join(SCRATCH, `case-${caseCount}`);
  const bin = path.join(root, 'bin');
  mkdirSync(path.join(root, 'tree', 'scripts'), { recursive: true });
  mkdirSync(bin);
  copyFileSync(`${REPO_ROOT}scripts/bootstrap.sh`, path.join(root, 'tree', 'scripts', 'bootstrap.sh'));
  const manifest = options.packageManager === null ? {} : { packageManager: options.packageManager ?? 'pnpm@11.20.0' };
  writeFileSync(path.join(root, 'tree', 'package.json'), JSON.stringify(manifest));
  if (options.node === undefined) {
    symlinkSync(process.execPath, path.join(bin, 'node'));
  } else {
    // A stand-in for `node -v` that runs every other call on the real node,
    // so the script's own reads still work.
    const answer: Tool = typeof options.node === 'string' ? { stdout: options.node, exit: 0 } : options.node;
    const node = path.join(bin, 'node');
    writeFileSync(node, [
      '#!/bin/sh',
      'if [ "$1" = "-v" ]; then',
      answer.stderr === undefined ? '' : `  printf '%s\\n' '${answer.stderr}' >&2`,
      answer.stdout === undefined ? '' : `  printf '%s\\n' '${answer.stdout}'`,
      `  exit ${answer.exit}`,
      'fi',
      `exec '${process.execPath}' "$@"`,
    ].join('\n'));
    chmodSync(node, 0o755);
  }
  const log = path.join(root, 'ran.log');
  const tools: ReadonlyArray<readonly [string, Tool | undefined]> = [
    ['corepack', options.corepack === null ? undefined : (options.corepack ?? { exit: 1 })],
    ['pnpm', options.pnpm],
    ['docker', { exit: 1 }],
    ['python3', {
      stdout: (options.python?.version ?? '3.12.4').replaceAll('.', ' '),
      ...(options.python?.stderr === undefined ? {} : { stderr: options.python.stderr }),
      exit: options.python?.exit ?? 0,
    }],
  ];
  // The log records the tools a case asserts on. A version read is not one.
  const unlogged = new Set(['python3']);
  for (const [name, tool] of tools) {
    if (tool === undefined) continue;
    const script = path.join(bin, name);
    writeFileSync(script, [
      '#!/bin/sh',
      unlogged.has(name) ? '' : `echo "${name} $*" >> '${log}'`,
      // stderr first: a warning a tool prints comes before its answer.
      tool.stderr === undefined ? '' : `printf '%s\\n' '${tool.stderr}' >&2`,
      tool.stdout === undefined ? '' : `printf '%s\\n' '${tool.stdout}'`,
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
  // vitest runs on Node 22, 24, and 26 and later, and testcontainers needs
  // 22.22. A version outside that set fails later and less clearly.
  it.each(['v22.21.1', 'v20.19.0'])('refuses Node %s, and names the floor', (version) => {
    const run = bootstrap({ node: version });
    expect(run.stdout).toContain(`${version} — too old, this repository needs Node 22.22 or later`);
    expect(run.status).toBe(1);
  });

  it.each(['v23.11.0', 'v25.2.1'])('refuses Node %s, a major version vitest does not support', (version) => {
    const run = bootstrap({ node: version });
    expect(run.stdout).toContain(`${version} — not supported: use major version 22 (22.22 or later), 24, or 26 and later`);
    expect(run.status).toBe(1);
  });

  // The documentation and guard checks use syntax Python 3.10 added. macOS
  // ships 3.9 as python3, and there the check fails with a TypeError.
  it.each(['3.9.6', '2.7.18'])('refuses Python %s, and names the floor', (version) => {
    const run = bootstrap({ python: { version } });
    expect(run.stdout).toContain(`Python ${version} — too old, the documentation and guard checks need Python 3.10 or later`);
    expect(run.status).toBe(1);
  });

  it.each(['3.10.0', '3.14.2'])('accepts Python %s', (version) => {
    const run = bootstrap({ python: { version } });
    expect(run.stdout).toMatch(new RegExp(`python3\\s+Python ${version.replaceAll('.', '\\.')}\\n`));
  });

  // A warning a Python prints on stderr, before its answer, is not its version.
  it('accepts a supported Python that warns on stderr', () => {
    const run = bootstrap({ python: { version: '3.12.1', stderr: 'Could not find platform independent libraries <prefix>' } });
    expect(run.stdout).toMatch(/python3\s+Python 3\.12\.1\n/);
    expect(run.stdout).not.toContain('too old');
  });

  // Each field is read on its own, so an empty field, a missing one or one too
  // long to compare is refused rather than read as a supported version.
  it.each(['3', '3.x.1', '3.99999999.0'])('refuses a Python version it cannot read: %s', (version) => {
    const run = bootstrap({ python: { version } });
    expect(run.stdout).toContain('not a version this script can read; install Python 3.10 or later');
    expect(run.status).toBe(1);
  });

  // The macOS stub without the developer tools, or a pyenv shim for a version
  // that is not installed. The bootstrap still says what failed.
  it('names a python3 that cannot report its version, and keeps its reason on the terminal', () => {
    const run = bootstrap({ python: { stderr: 'xcrun: error: invalid active developer path', exit: 1 } });
    expect(run.stdout).toMatch(/python3\s+present but fails: exit 1\n/);
    expect(run.stderr).toContain('xcrun: error: invalid active developer path');
    expect(run.status).toBe(1);
  });

  it('names a node that cannot report its version', () => {
    const run = bootstrap({ node: { stderr: 'No version is set for command node', exit: 126 } });
    expect(run.stdout).toMatch(/node\s+present but fails: exit 126\n/);
    expect(run.status).toBe(1);
  });

  it.each(['v22', 'v.22.0', 'v22..0', 'v9999999.0.0', '22.22.0'])('refuses a node version it cannot read: %s', (version) => {
    const run = bootstrap({ node: version });
    expect(run.stdout).toContain(`${version} — not a version this script can read; install Node 22.22 or later`);
    expect(run.status).toBe(1);
  });

  // A prerelease suffix on the patch is the build, not a version to refuse.
  it('accepts a Node build with a suffix, and names the version it read', () => {
    const run = bootstrap({ node: 'v22.22.0-nightly20261001' });
    expect(run.stdout).toMatch(/node\s+v22\.22\.0\n/);
  });

  it.each(['v22.22.0', 'v24.0.0', 'v26.0.0', 'v27.1.0'])('accepts Node %s', (version) => {
    const run = bootstrap({ node: version });
    expect(run.stdout).toMatch(new RegExp(`node\\s+${version.replaceAll('.', '\\.')}\\n`));
    expect(run.stdout).not.toContain('too old');
    expect(run.stdout).not.toContain('not supported');
  });

  it('enables nothing in check mode', () => {
    const run = bootstrap({ args: ['--check'], corepack: { exit: 0 } });
    expect(run.ran).not.toContain('corepack');
    expect(run.stdout).toContain("run 'corepack enable' (Node 22 or 24), or run 'npm install -g pnpm@11.20.0'");
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
