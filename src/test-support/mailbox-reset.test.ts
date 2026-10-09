// Which hosts a test run will empty mailboxes on.
//
// `MAIL_HOST` means "read mail here", and also "delete every message in the
// mailboxes these suites own here". The reachability probe checks a TCP port
// rather than who owns the server.
import { afterEach, describe, expect, it } from 'vitest';

import { ALLOW_REMOTE_MAIL, assertLocalMailHost } from './mailbox-reset.js';

describe('the host a test run will empty', () => {
  afterEach(() => {
    delete process.env[ALLOW_REMOTE_MAIL];
  });

  it('accepts this machine, by every spelling', () => {
    for (const host of ['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']) {
      expect(() => assertLocalMailHost(host), host).not.toThrow();
    }
  });

  it('refuses a host that is not this machine', () => {
    expect(() => assertLocalMailHost('mail.example.test')).toThrow(/refusing to empty mailboxes/);
    // A host that merely starts with a local name is not local, which is the
    // shape of defect the database guard fixed once already.
    expect(() => assertLocalMailHost('localhost.example.test')).toThrow(/refusing/);
    expect(() => assertLocalMailHost('127.0.0.1.example.test')).toThrow(/refusing/);
  });

  // The refusal names a command that works and a variable that exists, because
  // this repository has shipped a refusal whose advice was impossible.
  it('names a way out that works', () => {
    const message = (() => {
      try {
        assertLocalMailHost('mail.example.test');
        return '';
      } catch (error) {
        return (error as Error).message;
      }
    })();

    expect(message).toContain('docker compose --profile test up -d');
    expect(message).toContain(ALLOW_REMOTE_MAIL);
    expect(message).toContain('mail.example.test');
  });

  it('lets a person say the server is disposable', () => {
    process.env[ALLOW_REMOTE_MAIL] = '1';
    expect(() => assertLocalMailHost('mail.example.test')).not.toThrow();
  });

  it('takes only the exact opt-in value', () => {
    process.env[ALLOW_REMOTE_MAIL] = 'true';
    expect(() => assertLocalMailHost('mail.example.test')).toThrow(/refusing/);
  });
});
