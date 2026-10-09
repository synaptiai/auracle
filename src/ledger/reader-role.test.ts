// The readers' URL and the migrator's login as the role.
//
// The role suite runs the migrator once with a bad URL and sees it stop
// before any file. It cannot reach each shape of bad URL that way, so the
// check is tested here on its own. The ways it can fail:
//
//   1. It accepts a URL that names another user, so the migrator sets a
//      password the console never logs in with.
//   2. It accepts a user or password in the query string, which the driver
//      reads in place of the ones before the host.
//   3. It returns the password still percent-encoded, or throws on a %
//      escape that is valid.
//   4. It accepts a password outside printable ASCII, which Postgres
//      prepares before it hashes, so the verifier built here would not match.
//   5. It refuses a printable password, a space included.
//   6. It names the password in a refusal.
//   7. It accepts a URL with no password, or text that is not a URL.
//   8. It reads the password differently from the driver, so the migrator
//      sets a verifier the console's login never matches.
//   9. It takes a user or password the URL leaves out from PGUSER or
//      PGPASSWORD, which may be the migrator's own, as the role's login.
//  10. It reports a fault reading the URL, such as a missing TLS file, as a
//      fault in the password.
//  11. The login as the role waits for ever on a server that admits it and
//      never answers.
import { createServer, type AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { driverParameters } from '../db/driver-parameters.js';
import { loginOutcome, readerCredential, readerReach, scramVerifier } from './reader-role.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('readerCredential', () => {
  it('returns the password of a URL that names the readers\' role', () => {
    expect(readerCredential('postgres://auracle_reader:s3cret-Value@db:5432/auracle')).toBe('s3cret-Value');
    // Percent-encoded, as a password holding @ or / must be in a URL. (3)
    expect(readerCredential('postgres://auracle_reader:a%40b%2Fc@db:5432/auracle')).toBe('a@b/c');
    // A space is printable ASCII, and Postgres takes it as it is. (5)
    expect(readerCredential('postgres://auracle_reader:two%20words@db:5432/auracle')).toBe('two words');
  });

  it('refuses a URL the migrator and the console would read differently', () => {
    const cases: [string, RegExp][] = [
      ['postgres://auracle:pw@db:5432/auracle', /names the user 'auracle'; it must name auracle_reader/], // 1
      ['postgres://auracle_reader:pw@db:5432/auracle?password=other', /names its user or password in its query/], // 2
      ['postgres://auracle_reader:pw@db:5432/auracle?user=auracle', /names its user or password in its query/], // 2
      ['postgres://auracle_reader@db:5432/auracle', /carries no user or no password/], // 7
      ['postgres://auracle_reader:p%zzw@db:5432/auracle', /percent-encode the password/], // 3
      ['postgres://auracle_reader:p%C3%A9@db:5432/auracle', /outside printable ASCII/], // 4
      ['postgres://auracle_reader:tab%09here@db:5432/auracle', /outside printable ASCII/], // 4
      ['not a url', /is not a connection URL/], // 7
    ];
    for (const [url, refusal] of cases) {
      expect(() => readerCredential(url), url).toThrow(refusal);
    }
  });

  // The driver re-encodes a URL that holds a space, or a % that starts no
  // escape, and then reads some escapes back apart from the URL. When that
  // changes the user or password, the URL is refused, so the login set is the
  // one the console sends.
  it('reads the password as the driver reads it, or refuses the URL', () => { // 8
    const plain = 'postgres://auracle_reader:a%2Fb%3Ac%3Fd%40e@db:5432/auracle';
    expect(readerCredential(plain)).toBe('a/b:c?d@e');
    expect(readerCredential(plain)).toBe(driverParameters(plain).password);
    for (const url of [
      'postgres://auracle_reader:a%2Fb@db:5432/auracle?application_name=two words',
      'postgres://auracle_reader:a%2Fb@db:5432/auracle?application_name=100%zz',
    ]) {
      expect(() => readerCredential(url), url).toThrow(/is read differently by the Postgres driver/);
    }
  });

  it('refuses a URL that leaves its user or password to the environment', () => { // 9
    vi.stubEnv('PGUSER', 'auracle_reader');
    vi.stubEnv('PGPASSWORD', 'migrator-secret');
    for (const url of [
      'postgres://auracle_reader@db:5432/auracle',
      'postgres://auracle_reader:@db:5432/auracle',
      'postgres://db:5432/auracle',
    ]) {
      expect(() => readerCredential(url), url).toThrow(/carries no user or no password/);
    }
    // A leading space: the URL standard trims it, and the driver reads a URL
    // with no user or password, which the environment then fills.
    expect(() => readerCredential(' postgres://auracle_reader:pw@db:5432/auracle'))
      .toThrow(/is read differently by the Postgres driver/);
  });

  it('names the fault when the driver cannot read the URL', () => { // 10
    expect(() => readerCredential('postgres://auracle_reader:pw@db:5432/auracle?sslrootcert=/no/such/file'))
      .toThrow(/^READER_DATABASE_URL could not be read: .*no\/such\/file/);
  });

  it('names no password in a refusal', () => { // 6
    expect(() => readerCredential('postgres://auracle:hunter2-secret@db:5432/auracle'))
      .toThrow(expect.objectContaining({ message: expect.not.stringContaining('hunter2') }));
  });
});

describe('scramVerifier', () => {
  // The role suite checks the value against the one Postgres builds. This
  // checks that a fresh salt is drawn each time and the password stays out.
  it('builds a SCRAM-SHA-256 verifier with a fresh salt each time', () => {
    const first = scramVerifier('pencil');
    expect(first).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/);
    expect(first).not.toContain('pencil');
    expect(scramVerifier('pencil')).not.toBe(first);
  });
});

// What a failed login as the role says about where it can log in. The ways
// the reading can fail: it counts a fault that decides nothing (a full
// connection limit, a timeout, a server starting up) as a refusal, so the
// migrator reports a database as closed it never measured; or it counts a
// real refusal as unknown.
describe('loginOutcome', () => {
  it('takes pg_hba, a missing database and a missing CONNECT as a refusal', () => {
    for (const code of ['28000', '3D000', '42501']) expect(loginOutcome(code), code).toBe('refused');
  });

  it('takes any other fault as deciding nothing', () => {
    for (const code of ['53300', '57P03', '28P01', undefined]) expect(loginOutcome(code), String(code)).toBe('unknown');
  });
});

// The migrator's login as the role. The way it can fail here: a server that
// admits the login and never answers holds the migrate for as long as the
// connection lives.
describe('readerReach', () => {
  it('stops waiting for a server that admits the login and never answers', async () => { // 11
    // Just enough of the protocol to admit a login: authentication done,
    // ready for a query. Then silence.
    const server = createServer((socket) => {
      socket.once('data', () => {
        const ok = Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0]);
        const ready = Buffer.from([0x5a, 0, 0, 0, 5, 0x49]);
        socket.write(Buffer.concat([ok, ready]));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const migrator = {
      query: async () => ({ rows: [{ database: 'ledger', started: '1', started_at: 'then' }] }),
    } as unknown as Parameters<typeof readerReach>[0];
    const began = Date.now();
    try {
      await expect(readerReach(migrator, `postgres://auracle_reader:pw@127.0.0.1:${port}/ledger`))
        .rejects.toThrow(/could not read which ledger it reached: Query read timeout/);
      expect(Date.now() - began).toBeLessThan(9_000);
    } finally {
      server.close();
    }
  }, 15_000);
});
