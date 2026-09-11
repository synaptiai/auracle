// The tail every CLI and daemon now ends with (issue #72).
//
// Twenty entry points had four different answers to "what does this print and
// what does it exit with". These cases pin the one answer, including the two
// the old copies got wrong: a cause chain that was dropped in fifteen tools,
// and a teardown hook that could mask the fault that caused it.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { describeFault, runEntry } from './entry.js';

/** Restores the exit code the runner itself depends on. */
const originalExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

describe('describeFault', () => {
  it('is the message alone when there is no cause', () => {
    // A configuration refusal reads better than six stack frames, and this is
    // the path every `requireDbUrl` failure takes.
    expect(describeFault(new Error('the relay needs DATABASE_URL'))).toBe(
      'the relay needs DATABASE_URL',
    );
  });

  it('walks the cause chain', () => {
    // `src/artifacts/versioned.ts` attaches a cause to every filesystem fault
    // it wraps. Fifteen tails printed the head alone, so an artifact write
    // that failed on a revoked permission read exactly like one that failed
    // on a missing directory. The errno lives in the cause's own message.
    const fault = new Error('cannot write the gold report', {
      cause: new Error("EACCES: permission denied, open '/gold-report/v9.json'"),
    });
    expect(describeFault(fault)).toBe(
      "cannot write the gold report: EACCES: permission denied, open '/gold-report/v9.json'",
    );
  });

  it('walks a chain more than one link deep', () => {
    const fault = new Error('head', {
      cause: new Error('middle', { cause: new Error('tail') }),
    });
    expect(describeFault(fault)).toBe('head: middle: tail');
  });

  it('reads an AggregateError anywhere in the chain', () => {
    const fault = new Error('the consumer cannot reach the ledger', {
      cause: new AggregateError(
        [new Error('connect ECONNREFUSED 127.0.0.1:5432')],
        '',
      ),
    });
    expect(describeFault(fault)).toBe(
      'the consumer cannot reach the ledger: connect ECONNREFUSED 127.0.0.1:5432',
    );
  });

  it('describes a thrown value that is not an Error', () => {
    expect(describeFault('a bare string')).toBe('a bare string');
    expect(describeFault(undefined)).toBe('undefined');
  });

  it('stops on a cause that points back at itself', () => {
    // A fault printer that loops runs at the one moment everything else has
    // already failed. `console/src/main.ts` walked the chain with no guard at
    // all, so this input hung the process instead of reporting it.
    const fault: Error = new Error('self-referential');
    fault.cause = fault;
    expect(describeFault(fault)).toBe('self-referential');
  });

  it('stops on a cycle two links long', () => {
    const first: Error = new Error('first');
    const second: Error = new Error('second', { cause: first });
    first.cause = second;
    expect(describeFault(first)).toBe('first: second');
  });

  it('stops at a depth cap rather than walking for ever', () => {
    // A chain can be long without repeating a node, so the seen-set alone is
    // not a bound. Built past the cap so the guard is the thing under test.
    //
    // The exact links are asserted, not a bound on them. `toBeLessThanOrEqual`
    // passed with the cap mutated from 16 to 8, which made it the one
    // mutation of eight that no test caught.
    let fault = new Error('link-0');
    for (let i = 1; i < 40; i += 1) {
      fault = new Error(`link-${i}`, { cause: fault });
    }
    const described = describeFault(fault);
    const links = described.split(': ');
    expect(links.slice(0, 16)).toEqual(
      Array.from({ length: 16 }, (_unused, i) => `link-${39 - i}`),
    );
    expect(links).toHaveLength(17);
  });

  it('says that it truncated, rather than ending mid-chain in silence', () => {
    // A line that stops at sixteen links reads exactly like a chain that
    // ended at sixteen links.
    let fault = new Error('link-0');
    for (let i = 1; i < 40; i += 1) {
      fault = new Error(`link-${i}`, { cause: fault });
    }
    expect(describeFault(fault).endsWith(': ... (cause chain truncated)')).toBe(true);
  });

  it('adds no truncation note to a chain that fits', () => {
    const fault = new Error('head', { cause: new Error('tail') });
    expect(describeFault(fault)).toBe('head: tail');
  });

  it('survives a cause getter that throws', () => {
    // This runs when everything else has already failed, so it must not
    // become the reason a process dies with nothing to show for it.
    const fault = new Error('the real fault');
    Object.defineProperty(fault, 'cause', {
      get() {
        throw new Error('the cause getter blew up');
      },
    });
    expect(describeFault(fault)).toBe('the real fault');
  });

  it('survives a value with no prototype', () => {
    // `String(Object.create(null))` throws: there is no toString to call.
    expect(() => describeFault(Object.create(null) as unknown)).not.toThrow();
    expect(describeFault(Object.create(null) as unknown).length).toBeGreaterThan(0);
  });

  it('survives a message getter that throws', () => {
    const fault = new Error('placeholder');
    Object.defineProperty(fault, 'message', {
      get() {
        throw new Error('the message getter blew up');
      },
    });
    expect(() => describeFault(fault)).not.toThrow();
  });

  it('survives a Proxy that traps every read', () => {
    const hostile = new Proxy(new Error('never read'), {
      get() {
        throw new Error('trapped');
      },
    });
    expect(() => describeFault(hostile)).not.toThrow();
  });

  it('skips a cause that carries nothing new to say', () => {
    // `new Error(msg, { cause: undefined })` sets the property, so a plain
    // `'cause' in error` test would append 'undefined' to the line.
    const fault = new Error('the whole story', { cause: undefined });
    expect(describeFault(fault)).toBe('the whole story');
  });
});

describe('runEntry', () => {
  it('leaves the exit code alone when main resolves', async () => {
    process.exitCode = undefined;
    await runEntry(async () => {
      await Promise.resolve();
    });
    expect(process.exitCode).toBeUndefined();
  });

  it('keeps an exit code main set for itself', async () => {
    // `kb/cli.ts` sets 1 on a failed document and still returns normally, and
    // `seed/run.ts` does the same on a refused row. A tail that reset it
    // would tell a supervisor the run succeeded.
    process.exitCode = undefined;
    await runEntry(async () => {
      process.exitCode = 1;
      await Promise.resolve();
    });
    expect(process.exitCode).toBe(1);
  });

  it('prints the fault and exits 1 when main rejects', async () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    process.exitCode = undefined;
    await runEntry(async () => {
      await Promise.resolve();
      throw new Error('the ledger refused the row');
    });
    expect(process.exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledWith('the ledger refused the row');
  });

  it('prints the cause chain, not the head alone', async () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await runEntry(async () => {
      await Promise.resolve();
      throw new Error('cannot write the artifact', {
        cause: new Error("ENOENT: no such file or directory, open '/x/v1.json'"),
      });
    });
    expect(stderr).toHaveBeenCalledWith(
      "cannot write the artifact: ENOENT: no such file or directory, open '/x/v1.json'",
    );
  });

  it('runs onFault when main rejects', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const closed = vi.fn(async () => {
      await Promise.resolve();
    });
    await runEntry(
      async () => {
        await Promise.resolve();
        throw new Error('broke');
      },
      { onFault: closed },
    );
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('does not run onFault when main resolves', async () => {
    const closed = vi.fn(async () => {
      await Promise.resolve();
    });
    await runEntry(
      async () => {
        await Promise.resolve();
      },
      { onFault: closed },
    );
    expect(closed).not.toHaveBeenCalled();
  });

  it('reports a rejecting onFault without masking the original fault', async () => {
    // The teardown is likeliest to fail exactly when the work already did,
    // and the operator needs the work's error. Both are printed; neither
    // replaces the other, and the rejection never escapes as an unhandled one.
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    process.exitCode = undefined;
    await runEntry(
      async () => {
        await Promise.resolve();
        throw new Error('the original fault');
      },
      {
        onFault: async () => {
          await Promise.resolve();
          throw new Error('the pool would not close');
        },
      },
    );
    expect(process.exitCode).toBe(1);
    const said = stderr.mock.calls.map((call) => String(call[0]));
    expect(said).toContain('the original fault');
    expect(said.some((line) => line.includes('the pool would not close'))).toBe(true);
  });

  it('reports a synchronously throwing onFault', async () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await runEntry(
      async () => {
        await Promise.resolve();
        throw new Error('the original fault');
      },
      {
        onFault: () => {
          throw new Error('teardown threw at once');
        },
      },
    );
    const said = stderr.mock.calls.map((call) => String(call[0]));
    expect(said).toContain('the original fault');
    expect(said.some((line) => line.includes('teardown threw at once'))).toBe(true);
  });

  it('sets the exit code and closes down even when stderr cannot be written', async () => {
    // The ordering this pins: the exit code is set before anything that can
    // itself fail. Printing came first once, and a failure to print took the
    // whole catch block with it — the process exited 0 and `onFault` never
    // ran, so a failure reported success with the console's pool still open.
    //
    // stderr is what fails here, not the description. `console.error` raises
    // EPIPE when stderr is a pipe nobody reads any more, which is what
    // `node dist/thing.js 2>&1 | head -1` leaves behind. A hostile error
    // object would not reach this, because `describeFault` swallows those.
    vi.spyOn(console, 'error').mockImplementation(() => {
      throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    });
    process.exitCode = undefined;
    const closed = vi.fn(() => undefined);
    await expect(
      runEntry(
        async () => {
          await Promise.resolve();
          throw new Error('the real fault');
        },
        { onFault: closed },
      ),
    ).resolves.toBeUndefined();
    expect(process.exitCode).toBe(1);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('catches a main that throws before its first await', async () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    process.exitCode = undefined;
    await runEntry(() => {
      throw new Error('threw synchronously');
    });
    expect(process.exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledWith('threw synchronously');
  });
});
