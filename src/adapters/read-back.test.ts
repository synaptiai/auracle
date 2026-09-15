// One map of the adapters an approval can read a draft back from (section 4.10).
//
// The approval CLI held this map inside its entry point, so the console could
// not reach it: a barrel may not re-export a module that starts a process. Two
// copies would drift, and the copy that drifted would read back from a system
// the relay does not send through.
import { describe, expect, it } from 'vitest';

import { FreeScoutEgressAdapter } from './freescout.js';
import { HelpdeskAdapter } from './helpdesk.js';
import { SmtpEgressAdapter } from './imap-smtp.js';
import { READ_BACK_ADAPTER_NAMES, selectReadBackAdapter } from './read-back.js';

// Synthetic values only (DEC-18). Nothing here opens a connection: each
// adapter connects when it is asked to read, and no case asks.
const FREESCOUT_ENV = {
  FREESCOUT_BASE_URL: 'http://helpdesk.invalid/',
  FREESCOUT_API_KEY: 'synthetic-key',
  FREESCOUT_USER_ID: '7',
};

const IMAP_SMTP_ENV = {
  IMAP_HOST: 'mail.invalid',
  IMAP_PORT: '3143',
  IMAP_USER: 'synthetic-user',
  IMAP_PASS: 'synthetic-pass',
  SMTP_HOST: 'mail.invalid',
  SMTP_PORT: '3025',
  EMAIL_FROM_ADDRESS: 'support@example.invalid',
};

describe('selectReadBackAdapter', () => {
  it('names the three adapters the approval can read back from', () => {
    expect([...READ_BACK_ADAPTER_NAMES]).toEqual(['helpdesk', 'imap-smtp', 'freescout']);
  });

  it('builds the adapter each name selects', () => {
    expect(selectReadBackAdapter('helpdesk', {})).toBeInstanceOf(HelpdeskAdapter);
    expect(selectReadBackAdapter('freescout', FREESCOUT_ENV)).toBeInstanceOf(FreeScoutEgressAdapter);
    expect(selectReadBackAdapter('imap-smtp', IMAP_SMTP_ENV)).toBeInstanceOf(SmtpEgressAdapter);
  });

  // Built from the environment it is given, not from the process. A console
  // that validates at boot passes the same object it later reads from.
  it('reads the configuration from the environment it is passed', () => {
    expect(() => selectReadBackAdapter('freescout', {})).toThrow(/FREESCOUT_BASE_URL/);
    expect(() => selectReadBackAdapter('imap-smtp', {})).toThrow(/IMAP_HOST/);
  });

  it('refuses a name it does not know, and lists the ones it does', () => {
    expect(() => selectReadBackAdapter('zendesk', {})).toThrow(
      "unknown APPROVE_ADAPTER 'zendesk' (known: helpdesk, imap-smtp, freescout)",
    );
  });

  // A bare read of a plain record walks the prototype, so `toString` was a
  // name that resolved to a function and then failed as a call.
  it('refuses a name that only the object prototype carries', () => {
    expect(() => selectReadBackAdapter('toString', {})).toThrow(/unknown APPROVE_ADAPTER 'toString'/);
  });
});
