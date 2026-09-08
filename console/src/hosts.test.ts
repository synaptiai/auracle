// The `Host` allowlist decides who may reach the approval (issue #27).
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

  it('brackets a bare IPv6 bind, because that is what a browser sends', () => {
    expect(allowedHosts('::1', 8787)).toContain('[::1]:8787');
  });

  it('omits the port on 80 and 443, because the browser omits it', () => {
    expect(allowedHosts('127.0.0.1', 443)).toContain('localhost');
  });

  // The finding this file exists for. `CONSOLE_ALLOWED_HOSTS` used to add to
  // the derived names, so an operator who put an authenticating proxy in
  // front and bound the console off loopback still answered a request that
  // reached the port directly and sent `Host: localhost:8787`. Naming a proxy
  // has to mean the console answers that proxy and nobody else, or the
  // variable cannot do the job the runbook gives it.
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

  // It used to be gated on `CONSOLE_ALLOWED_HOSTS`, on the reasoning that
  // naming a host says a proxy is in front. It does not: the derived-name
  // comment above lists two reasons an operator names hosts with no proxy
  // anywhere. An operator who named hosts for one of those and also named a
  // header got a console where anyone reaching the port named themselves.
  //
  // So the variable is not a proxy detector, and this holds that the two are
  // now independent — the trust is stated rather than inferred.
  it('does not depend on the hosts, which do not imply a proxy', () => {
    process.env[HEADER] = 'X-Forwarded-User';
    process.env[VAR] = 'localhost:8787,[::1]:8787';
    expect(identityHeader()).toBe('x-forwarded-user');
    delete process.env[VAR];
    expect(identityHeader()).toBe('x-forwarded-user');
  });
});
