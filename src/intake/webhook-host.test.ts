// The webhook binds loopback unless an operator names another interface, and
// it stops within a bounded time.
//
// With WEBHOOK_SECRET empty, the default, the webhook accepts every request.
// A listener on every interface then takes unauthenticated tickets from the
// whole network, and each one spends the model budget. The console binds
// loopback by default too, and both read the interface through `hostEnv`.
//
// Each case starts the real entry point from source and reads what the server
// reports. The unit project's DATABASE_URL refuses connections, which is
// harmless: the pool opens nothing until a delivery.
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { REPO_ROOT, startFromSource, startOnFreePort } from '../test-support/source-process.js';

// The child runs from an empty directory, so it reads no developer's `.env`.
// The channel map it needs is the repository's own.
const SCRATCH = mkdtempSync(path.join(tmpdir(), 'auracle-webhook-host-'));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

interface Webhook {
  readonly child: ChildProcess;
  readonly port: number;
  /** Settles once the output streams drain, with how the process ended. */
  readonly closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Settles with the address the server reports, or rejects if it stops first. */
  readonly listening: Promise<string>;
  /** What the process wrote to stderr so far. */
  stderr(): string;
}

/** Starts the webhook from source with WEBHOOK_HOST set as given. */
async function startWebhook(host: string | undefined): Promise<Webhook> {
  return startOnFreePort((port) => startWebhookOn(host, port));
}

function startWebhookOn(host: string | undefined, port: number): Webhook {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WEBHOOK_PORT: String(port),
    PRODUCTS_FILE: `${REPO_ROOT}products.json`,
  };
  delete env['WEBHOOK_HOST'];
  if (host !== undefined) env['WEBHOOK_HOST'] = host;
  const { child, closed, stdout, stderr } = startFromSource('src/intake/webhook-main.ts', { cwd: SCRATCH, env });
  const listening = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no listening line within 20s: ${stderr()}`)), 20_000);
    child.stdout!.on('data', () => {
      // Only complete lines: a chunk can end inside the one being read.
      for (const line of stdout().split('\n').slice(0, -1)) {
        if (!line.includes('"listening"')) continue;
        clearTimeout(timer);
        try {
          resolve((JSON.parse(line) as { host: string }).host);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
        return;
      }
    });
    void closed.then(({ code }) => {
      clearTimeout(timer);
      reject(new Error(`the webhook exited with ${code} before listening: ${stderr()}`));
    });
  });
  // A rejection nobody awaits yet must not fail the run on its own.
  listening.catch(() => undefined);
  return { child, port, closed, listening, stderr };
}

/** Stops the webhook and waits for it, killing it if it ignores SIGTERM. */
async function stop(webhook: Webhook): Promise<void> {
  webhook.child.kill('SIGTERM');
  const killer = setTimeout(() => webhook.child.kill('SIGKILL'), 10_000);
  await webhook.closed;
  clearTimeout(killer);
}

/** Starts the webhook, returns the address it reports, then stops it. */
async function boundAddress(host: string | undefined): Promise<string> {
  const webhook = await startWebhook(host);
  try {
    return await webhook.listening;
  } finally {
    await stop(webhook);
  }
}

/** Opens a connection and sends headers that promise a body which never comes. */
async function halfRequest(port: number): Promise<Socket> {
  const socket = connect(port, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });
  // The webhook may close the socket during shutdown; that is the point.
  socket.on('error', () => undefined);
  socket.write('POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\n{');
  await new Promise((resolve) => setTimeout(resolve, 200));
  return socket;
}

describe('the webhook shutdown', () => {
  // A client that sends half a request holds server.close() open until
  // Node's 300 s request timeout. The supervisor kills the process long
  // before that, so the webhook bounds the wait itself and exits cleanly.
  it('stops within its grace period while a request is still arriving', async () => {
    const webhook = await startWebhook(undefined);
    let socket: Socket | undefined;
    try {
      await webhook.listening;
      socket = await halfRequest(webhook.port);
      const asked = Date.now();
      webhook.child.kill('SIGTERM');
      const ended = await webhook.closed;
      expect(Date.now() - asked).toBeLessThan(10_000);
      expect(ended, webhook.stderr()).toEqual({ code: 0, signal: null });
    } finally {
      socket?.destroy();
      webhook.child.kill('SIGKILL');
    }
  }, 30_000);

  // A second SIGTERM while the first is draining must not take Node's default
  // action, which ends the process at once.
  it('absorbs a second signal while it drains', async () => {
    const webhook = await startWebhook(undefined);
    let socket: Socket | undefined;
    try {
      await webhook.listening;
      socket = await halfRequest(webhook.port);
      webhook.child.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 200));
      webhook.child.kill('SIGTERM');
      expect(await webhook.closed, webhook.stderr()).toEqual({ code: 0, signal: null });
    } finally {
      socket?.destroy();
      webhook.child.kill('SIGKILL');
    }
  }, 30_000);
});

describe('the webhook bind address', () => {
  it('binds loopback when WEBHOOK_HOST is unset', async () => {
    expect(await boundAddress(undefined)).toBe('127.0.0.1');
  }, 30_000);

  // Node reads an empty host as every interface, so a `WEBHOOK_HOST=` line
  // left in `.env` would open the webhook to the network. A blank value is
  // refused, as a blank WEBHOOK_PORT is.
  it.each(['', '   '])('refuses a blank WEBHOOK_HOST (%j)', async (blank) => {
    await expect(boundAddress(blank)).rejects.toThrow(
      /exited with 1 before listening: .*WEBHOOK_HOST is set but empty/s,
    );
  }, 30_000);

  it('refuses a padded WEBHOOK_HOST and names the variable', async () => {
    // A padded host fails name resolution with an error that names no
    // variable. The refusal names the one to fix.
    await expect(boundAddress(' 127.0.0.1 ')).rejects.toThrow(
      /exited with 1 before listening: .*WEBHOOK_HOST has surrounding whitespace: ' 127\.0\.0\.1 '/s,
    );
  }, 30_000);

  it('names WEBHOOK_HOST when the interface cannot be bound', async () => {
    // A name that does not resolve fails inside listen(), whose own error
    // names no variable.
    await expect(boundAddress('no-such-host.invalid')).rejects.toThrow(
      /exited with 1 before listening: .*WEBHOOK_HOST 'no-such-host\.invalid' with WEBHOOK_PORT \d+ cannot be bound/s,
    );
  }, 30_000);

  it('binds the interface WEBHOOK_HOST names', async () => {
    // The IPv6 loopback, so the suite never opens an unauthenticated listener
    // to the network. It is still not the default.
    expect(await boundAddress('::1')).toBe('::1');
  }, 30_000);
});
