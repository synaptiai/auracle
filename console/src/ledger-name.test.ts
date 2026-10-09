// What the rail is allowed to say about the ledger.
//
// The console draws pages for a reviewer, and `DATABASE_URL` carries a
// password. Those two facts together are how a connection string ends up on a
// screen someone else is reading, so the redaction is asserted rather than
// trusted.
import { describe, expect, it } from 'vitest';

import { ledgerName } from './ledger-name.js';

// The host is an RFC 2606 reserved name on purpose. A DSN's `password@host`
// is email-shaped, so `.internal` reads as a reachable address to the
// synthetic-fixture guard (DEC-18, DEC-19). A reserved name cannot reach a
// person, and the guard exempts it by construction.
describe('the ledger the rail names', () => {
  it('names the host, the port and the database', () => {
    expect(ledgerName('postgres://auracle:auracle@localhost:5433/auracle'))
      .toBe('localhost:5433/auracle');
  });

  // The whole point. A password on the page is the failure this function
  // exists to prevent, so every shape that carries one is checked.
  it('never carries the credentials', () => {
    for (const url of [
      'postgres://auracle:hunter2@db.example:5432/auracle',
      'postgresql://someone:p%40ssw0rd@10.0.0.4:5432/ledger',
      'postgres://onlyuser@localhost:5433/auracle',
    ]) {
      const named = ledgerName(url);
      for (const secret of ['hunter2', 'p%40ssw0rd', 'p@ssw0rd', 'auracle:', 'someone', 'onlyuser']) {
        expect(named, `${url} leaked ${secret}`).not.toContain(secret);
      }
    }
  });

  it('omits the port when the connection string does', () => {
    expect(ledgerName('postgres://user:pw@db.example/auracle')).toBe('db.example/auracle');
  });

  it('names the host alone when no database is on the path', () => {
    expect(ledgerName('postgres://user:pw@db.example:5432')).toBe('db.example:5432');
  });

  // A key-value DSN is a string `pg` accepts and `URL` does not. Printing it
  // would print the password, so the shape is named instead of shown.
  it('says nothing at all about a string it cannot parse', () => {
    const named = ledgerName('host=db.example port=5432 user=auracle password=hunter2');
    expect(named).toBe('the configured ledger');
    expect(named).not.toContain('hunter2');
  });

  it('says nothing about an empty string either', () => {
    expect(ledgerName('')).toBe('the configured ledger');
  });
});
