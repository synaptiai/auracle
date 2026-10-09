// Starts an entry point from source, as a separate process, for a test that
// reads what the real command prints and how it exits.
//
// tsx loads into one node process, not the tsx command. The command starts a
// second process, and a SIGKILL to the first left the child running.
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const TSX_LOADER = pathToFileURL(`${REPO_ROOT}node_modules/tsx/dist/loader.mjs`).href;

export interface SourceProcess {
  readonly child: ChildProcess;
  /**
   * Settles once the output streams drain, with how the process ended. A
   * process that never starts settles too, with its error in `stderr()`.
   */
  readonly closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** What the process wrote to stdout so far. */
  stdout(): string;
  /** What the process wrote to stderr so far. */
  stderr(): string;
}

/**
 * Starts `entry`, a path from the repository root, with `args` after it.
 *
 * The caller names the working directory and the whole environment, so no
 * developer's `.env` or shell variable decides the case.
 */
export function startFromSource(
  entry: string,
  options: {
    readonly args?: readonly string[];
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    /**
     * Kills the process this long after it starts, and says so on stderr.
     * A hung child would otherwise outlive the case that started it.
     */
    readonly deadlineMs?: number;
  },
): SourceProcess {
  const child = spawn(
    process.execPath,
    ['--import', TSX_LOADER, `${REPO_ROOT}${entry}`, ...(options.args ?? [])],
    { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let out = '';
  let err = '';
  // The stream's decoder holds back a character split across two chunks
  // until the rest of it arrives.
  child.stdout!.setEncoding('utf8');
  child.stderr!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => { out += chunk; });
  child.stderr!.on('data', (chunk: string) => { err += chunk; });
  // Longer than every caller's own case limit, so the default never decides
  // a case.
  const deadlineMs = options.deadlineMs ?? 90_000;
  const deadline = setTimeout(() => {
    const killed = child.kill('SIGKILL');
    err += `the process outlived its deadline of ${deadlineMs} ms and ${killed ? 'was killed' : 'could not be killed'}\n`;
  }, deadlineMs);
  // A process that has exited cannot outlive its deadline, even while a child
  // of its own still holds the output open.
  child.once('exit', () => clearTimeout(deadline));
  // 'close' fires once the output streams have drained, unlike 'exit', so the
  // output is complete when a case reads it. A spawn that fails emits 'error'
  // and may never emit 'close'.
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
    child.once('error', (error) => {
      clearTimeout(deadline);
      err += `${error.message}\n`;
      resolve({ code: null, signal: null });
    });
  });
  return { child, closed, stdout: () => out, stderr: () => err };
}

/**
 * Starts a server process on a free loopback port, and tries a fresh port
 * when another process took the first one before the child bound it. The
 * child names that as `EADDRINUSE` on stderr. Any other outcome, a refusal
 * included, goes to the caller, who reads it from `listening`.
 *
 * `listening` must settle within a bound the caller sets: this helper waits
 * on it and adds no limit of its own.
 */
export async function startOnFreePort<T extends {
  readonly listening: Promise<unknown>;
  readonly closed: Promise<unknown>;
  stderr(): string;
}>(start: (port: number) => T): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    const run = start(await freePort());
    const taken = await run.listening.then(() => false, () => run.stderr().includes('EADDRINUSE'));
    if (!taken || attempt === 5) return run;
    await run.closed;
  }
}

/** A loopback port nothing listens on at the moment of the call. */
export async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}
