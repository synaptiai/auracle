// The `Host` allowlist decides who may reach the approval.
//
// The approval sends a customer reply and a sent reply cannot be recalled
// (DEC-12, DEC-14), so the set of names this console answers to is a security
// boundary rather than a convenience.
import { afterEach, describe, expect, it } from 'vitest';

import { allowedHosts, identityHeader } from './hosts.js';

const VAR = 'CONSOLE_ALLOWED_HOSTS';
const HEADER = 'CONSOLE_IDENTITY_HEADER';

afterEach(() => {
  delete process.env[VAR];
  delete process.env[HEADER];
});

describe('allowedHosts', () => {
  it('answers the loopback names when the operator names none', () => {
    const names = allowedHosts('127.0.0.1', 8787);
    expect(names).toContain('127.0.0.1:8787');
    expect(names).toContain('localhost:8787');
    expect(names).toContain('[::1]:8787');
  });

  it('adds the bind address, and never a wildcard', () => {
    expect(allowedHosts('192.168.1.9', 8787)).toContain('192.168.1.9:8787');
    expect(allowedHosts('0.0.0.0', 8787)).not.toContain('0.0.0.0:8787');
    expect(allowedHosts('::', 8787)).not.toContain('[::]:8787');
  });

  it('omits the port on 80 and 443, because the browser omits it', () => {
    expect(allowedHosts('127.0.0.1', 443)).toContain('localhost');
  });

  // The case this file exists for. `CONSOLE_ALLOWED_HOSTS` replaces the
  // derived names. If it added to them, a direct request could still send
  // `Host: localhost:8787`. A console behind an authenticating proxy, bound
  // off loopback, would answer it. Naming a proxy has to mean the console
  // answers that proxy and nobody else, or the variable cannot do the job the
  // runbook gives it.
  it('answers only the named hosts once the operator names any', () => {
    process.env[VAR] = 'console.internal.example';
    const names = allowedHosts('0.0.0.0', 8787);
    expect(names).toEqual(['console.internal.example']);
    expect(names).not.toContain('localhost:8787');
    expect(names).not.toContain('127.0.0.1:8787');
    expect(names).not.toContain('[::1]:8787');
  });

  it('keeps loopback only when the operator names it too', () => {
    process.env[VAR] = 'console.internal.example, localhost:8787';
    const names = allowedHosts('0.0.0.0', 8787);
    expect(new Set(names)).toEqual(new Set(['console.internal.example', 'localhost:8787']));
  });

  it('lowercases a named host, because a Host header is compared lowercased', () => {
    process.env[VAR] = 'Console.Internal.Example';
    expect(allowedHosts('0.0.0.0', 8787)).toEqual(['console.internal.example']);
  });

  it('refuses an entry carrying a scheme or a path', () => {
    process.env[VAR] = 'https://console.internal.example';
    expect(() => allowedHosts('0.0.0.0', 8787)).toThrow(/not a URL/);
  });

  it('ignores an empty entry rather than answering to the empty name', () => {
    process.env[VAR] = ' , ';
    const names = allowedHosts('127.0.0.1', 8787);
    expect(names).toContain('localhost:8787');
    expect(names).not.toContain('');
  });
});

describe('the header a trusted proxy names the approver in (DEC-42)', () => {
  it('is read when the operator names it', () => {
    process.env[HEADER] = 'X-Forwarded-User';
    // Lowercased, because that is how node keys a request header.
    expect(identityHeader()).toBe('x-forwarded-user');
  });

  it('is undefined when the operator names none', () => {
    expect(identityHeader()).toBeUndefined();
    process.env[HEADER] = '   ';
    expect(identityHeader()).toBeUndefined();
  });

  // A header the client sets for itself is not a proxy's statement, and
  // naming one makes every value of it a name this console keeps. An
  // operator who named `cookie` got a console where `curl -H 'Cookie: ...'`
  // from anywhere the port is reachable was a complete impersonation of any
  // active reviewer, with nothing in the log to say so.
  it('refuses a header a client sets for itself', () => {
    for (const client of [
      'Cookie', 'host', 'User-Agent', 'referer', 'origin',
      'From', 'Accept-Language', 'X-Requested-With', 'Sec-Fetch-Site',
    ]) {
      process.env[HEADER] = client;
      expect(() => identityHeader(), client).toThrow(/a client sets for itself/);
    }
    // A proxy header stays legal, including the identity headers an
    // authenticating proxy forwards.
    for (const proxy of ['x-forwarded-user', 'X-Auth-Request-Email', 'Remote-User']) {
      process.env[HEADER] = proxy;
      expect(identityHeader(), proxy).toBe(proxy.toLowerCase());
    }
    delete process.env[HEADER];
  });

  // A credential is not a name. The console resolves a name and the approval
  // writes it into the ledger, so a token read from one of these would be
  // kept in two places reviewers read.
  it('refuses a header that carries a credential', () => {
    for (const credential of [
      'Authorization', 'Proxy-Authorization', 'X-Api-Key',
      'X-Goog-Iap-Jwt-Assertion', 'Cf-Access-Jwt-Assertion',
      'X-Pomerium-Jwt-Assertion', 'X-Amzn-Oidc-Data', 'X-Ms-Client-Principal',
    ]) {
      process.env[HEADER] = credential;
      expect(() => identityHeader(), credential).toThrow(/carries a credential/);
    }
    delete process.env[HEADER];
  });

  // Naming a host in `CONSOLE_ALLOWED_HOSTS` does not say a proxy is in
  // front. The derived-name comment above lists two reasons an operator names
  // hosts with no proxy anywhere. A header gated on the hosts would then let
  // anyone who reaches the port name themselves.
  //
  // So the variable is not a proxy detector, and this holds that the two are
  // independent — the trust is stated rather than inferred.
  it('does not depend on the hosts, which do not imply a proxy', () => {
    process.env[HEADER] = 'X-Forwarded-User';
    process.env[VAR] = 'localhost:8787,[::1]:8787';
    expect(identityHeader()).toBe('x-forwarded-user');
    delete process.env[VAR];
    expect(identityHeader()).toBe('x-forwarded-user');
  });
});
