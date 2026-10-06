// The classifier's cases no scripted server can produce reliably: a rejection
// that is not an object, and a login flag on a fault that is not a refusal.
import { describe, expect, it } from 'vitest';

import { AuthenticationFailure } from 'imapflow/lib/errors.js';

import { draftReadFault } from './imap-fault.js';
import { NothingSentError } from './types.js';

const nothingSent = (cause: unknown, permanent: boolean): NothingSentError =>
  new NothingSentError(`no SMTP send was attempted: ${String(cause)}`, { permanent, cause });

describe('draftReadFault', () => {
  it('reads a rejection that is not an object as a transient fault', () => {
    for (const thrown of [null, undefined, 'socket closed']) {
      const fault = draftReadFault(thrown, 'Drafts', nothingSent);
      expect(fault, String(thrown)).toBeInstanceOf(NothingSentError);
      expect((fault as NothingSentError).permanent, String(thrown)).toBe(false);
    }
  });

  // imapflow sets its login flag on any error raised during LOGIN, a dropped
  // connection included. A login flag with a connection code is transient.
  it('reads a login flag on a connection fault as transient', () => {
    for (const code of ['NoConnection', 'ETIMEOUT']) {
      const fault = draftReadFault({ authenticationFailed: true, code }, 'Drafts', nothingSent);
      expect(fault, code).toBeInstanceOf(NothingSentError);
      expect((fault as NothingSentError).permanent, code).toBe(false);
    }
  });

  // imapflow raises some refusals with no response status: a login it finds
  // disabled, or Exchange's "authenticated but not connected". They carry no
  // connection code either, so they are refusals.
  it('reads a login failure with no connection code as a refusal', () => {
    for (const thrown of [new AuthenticationFailure('User is authenticated but not connected'), { authenticationFailed: true }]) {
      const fault = draftReadFault(thrown, 'Drafts', nothingSent);
      expect(fault).toBeInstanceOf(Error);
      expect(fault).not.toBeInstanceOf(NothingSentError);
      expect(fault.message).toMatch(/^the IMAP server refused the login: /);
    }
  });

  // RFC 5530: UNAVAILABLE and INUSE ask for a later try. LIMIT names a limit
  // the request hit, and a retry hits it again.
  it('waits on UNAVAILABLE and INUSE, and refuses on LIMIT', () => {
    for (const code of ['UNAVAILABLE', 'INUSE']) {
      const fault = draftReadFault({ responseStatus: 'NO', serverResponseCode: code, responseText: 'later' }, 'Drafts', nothingSent);
      expect(fault, code).toBeInstanceOf(NothingSentError);
    }
    const limit = draftReadFault({ responseStatus: 'NO', serverResponseCode: 'LIMIT', responseText: 'too many' }, 'Drafts', nothingSent);
    expect(limit).not.toBeInstanceOf(NothingSentError);
  });

  // The cut counts characters, not UTF-16 units: half a surrogate pair is
  // text Postgres refuses to store in the journal.
  it('cuts the server text between characters, never inside one', () => {
    const text = `${'x'.repeat(199)}\u{1F600}${'y'.repeat(20)}`;
    const fault = draftReadFault({ responseStatus: 'NO', responseText: text }, 'Drafts', nothingSent);
    expect(fault.message).toBe(`the IMAP server refused the draft read: ${'x'.repeat(199)}\u{1F600}…`);
    // encodeURIComponent throws on a lone surrogate.
    expect(() => encodeURIComponent(fault.message)).not.toThrow();
  });

  // A goodbye on record says the session closed, unless the server also
  // answered: a refusal is still a refusal. imapflow's own Exchange failure
  // carries the server's reply as its response.
  it('reads a refusal as a refusal when a goodbye is also on record', () => {
    for (const thrown of [
      { authenticationFailed: true, responseStatus: 'NO', responseText: 'Invalid credentials', serverGoodbye: 'too many failures' },
      Object.assign(new AuthenticationFailure('User is authenticated but not connected'), {
        response: 'BAD User is authenticated but not connected.',
        serverGoodbye: 'closing',
      }),
    ]) {
      const fault = draftReadFault(thrown, 'Drafts', nothingSent);
      expect(fault).not.toBeInstanceOf(NothingSentError);
      expect(fault.message).toMatch(/^the IMAP server refused the login: /);
    }
  });

  // The goodbye is server text too, so it carries the same bound.
  it('bounds a goodbye the way it bounds a refusal', () => {
    const fault = draftReadFault({ authenticationFailed: true, serverGoodbye: 'z'.repeat(5000) }, 'Drafts', nothingSent);
    expect(fault).toBeInstanceOf(NothingSentError);
    expect((fault.cause as Error).message).toBe(`the IMAP server closed the session: ${'z'.repeat(200)}…`);
  });
});

