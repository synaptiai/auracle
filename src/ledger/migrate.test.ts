// The migrator's check of READER_DATABASE_URL before the restate (issue #153).
//
// The ways the check can fail:
//
//   1. It sends a credential to the host READER_DATABASE_URL names, before
//      anything shows that host is this ledger.
//   2. It takes two addresses for one host. 127.0.0.1 and ::1 are two, and
//      two servers can listen one on each at one port.
//   3. It misses a difference in one part alone: the host, the port, the
//      database, or a host the query string gives.
//   4. It takes two socket directories whose names differ in case for one.
//   5. It accepts a readers' URL with a weaker TLS setting, so the role's own
//      login after the restate travels in clear where the migrator's does not.
//   6. It refuses a TLS setting as strong as the migrator's: another spelling
//      of one mode, a client certificate of the readers' own, or a stronger
//      mode.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { restateReaders } from './migrate.js';

describe('restateReaders', () => {
  it('refuses a readers\' URL on another host before it connects anywhere', async () => { // 1
    let connections = 0;
    const server = createServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    // A migrator connection that must not be used either.
    const migrator = {
      query: async () => {
        throw new Error('the check asked the migrator\'s connection');
      },
    } as unknown as Parameters<typeof restateReaders>[0];
    try {
      await expect(restateReaders(migrator, {
        credential: 'pw',
        readerUrl: `postgres://auracle_reader:pw@127.0.0.1:${port}/auracle`,
        migratorUrl: 'postgres://admin:SECRET@ledger.example.test:5432/auracle',
      })).rejects.toThrow(/^the migrations applied, and READER_DATABASE_URL names another host, port or database than DATABASE_URL/);
      expect(connections).toBe(0);
    } finally {
      server.close();
    }
  });

  it('takes a host name in any case, and two addresses as two hosts', async () => { // 2
    // A check that passes lets the restate ask the connection, which fails
    // with a sentinel.
    const migrator = {
      query: async () => {
        throw new Error('sentinel: the restate began');
      },
    } as unknown as Parameters<typeof restateReaders>[0];
    await expect(restateReaders(migrator, {
      credential: 'pw',
      readerUrl: 'postgres://auracle_reader:pw@LOCALHOST:5433/auracle',
      migratorUrl: 'postgres://auracle:auracle@localhost:5433/auracle',
    })).rejects.toThrow(/sentinel: the restate began/);
    for (const [reader, migrator2] of [['[::1]', '127.0.0.1'], ['127.0.0.1', 'localhost']] as const) {
      await expect(restateReaders(migrator, {
        credential: 'pw',
        readerUrl: `postgres://auracle_reader:pw@${reader}:5433/auracle`,
        migratorUrl: `postgres://auracle:auracle@${migrator2}:5433/auracle`,
      }), reader).rejects.toThrow(/^the migrations applied, and READER_DATABASE_URL names another host/);
    }
  });

  it('refuses a URL that differs from the migrator\'s in one part alone', async () => { // 3, 4
    const migrator = {
      query: async () => {
        throw new Error('the check asked the migrator\'s connection');
      },
    } as unknown as Parameters<typeof restateReaders>[0];
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['host', 'postgres://auracle_reader:pw@ledger.example.test:5433/auracle'],
      ['port', 'postgres://auracle_reader:pw@localhost:5434/auracle'],
      ['database', 'postgres://auracle_reader:pw@localhost:5433/other'],
      ['query host', 'postgres://auracle_reader:pw@localhost:5433/auracle?host=elsewhere.example.test'],
    ];
    for (const [part, readerUrl] of cases) {
      await expect(restateReaders(migrator, {
        credential: 'pw', readerUrl, migratorUrl: 'postgres://auracle:auracle@localhost:5433/auracle',
      }), part).rejects.toThrow(/^the migrations applied, and READER_DATABASE_URL names another host/);
    }
    await expect(restateReaders(migrator, {
      credential: 'pw',
      readerUrl: 'postgres://auracle_reader:pw@x:5433/auracle?host=/run/PG',
      migratorUrl: 'postgres://auracle:auracle@x:5433/auracle?host=/run/pg',
    }), 'socket').rejects.toThrow(/^the migrations applied, and READER_DATABASE_URL names another host/);
  });

  it('refuses a readers\' URL with a weaker TLS setting, and takes one as strong', async () => { // 5, 6
    const migrator = {
      query: async () => {
        throw new Error('sentinel: the restate began');
      },
    } as unknown as Parameters<typeof restateReaders>[0];
    // The driver reads a certificate file as it parses the URL.
    const dir = mkdtempSync(path.join(tmpdir(), 'auracle-tls-'));
    const file = (name: string, text: string) => {
      writeFileSync(path.join(dir, name), text);
      return path.join(dir, name);
    };
    const ca = file('ca.crt', 'CA one');
    const otherCa = file('other-ca.crt', 'CA two');
    const migratorCert = `sslcert=${file('m.crt', 'migrator')}&sslkey=${file('m.key', 'migrator key')}`;
    const readerCert = `sslcert=${file('r.crt', 'reader')}&sslkey=${file('r.key', 'reader key')}`;
    const at = 'ledger.example.test:5432/auracle';
    const pairs: ReadonlyArray<readonly [string, string, boolean]> = [
      // [the migrator's query, the readers' query, accepted]
      ['?sslmode=require', '', false],
      ['?sslmode=require', '?sslmode=no-verify', false],
      ['?sslmode=no-verify', '', false],
      [`?sslmode=verify-full&sslrootcert=${ca}`, `?sslmode=verify-full&sslrootcert=${otherCa}`, false],
      [`?sslmode=verify-full&sslrootcert=${ca}`, '?sslmode=verify-full', false],
      ['?sslmode=require', '?sslmode=require', true],
      ['?ssl=true', '?sslmode=require', true],
      ['?sslmode=no-verify', '?sslmode=verify-full', true],
      ['', '?sslmode=require', true],
      [`?sslmode=verify-full&${migratorCert}`, `?sslmode=verify-full&${readerCert}`, true],
      [`?sslmode=verify-full&sslrootcert=${ca}`, `?sslmode=verify-full&sslrootcert=${ca}`, true],
      // libpq's own modes: verify-ca checks the certificate and not the name.
      [`?uselibpqcompat=true&sslmode=verify-ca&sslrootcert=${ca}`, `?uselibpqcompat=true&sslmode=verify-ca&sslrootcert=${ca}`, true],
      [`?sslmode=verify-full&sslrootcert=${ca}`, `?uselibpqcompat=true&sslmode=verify-ca&sslrootcert=${ca}`, false],
      [`?uselibpqcompat=true&sslmode=verify-ca&sslrootcert=${ca}`, `?sslmode=verify-full&sslrootcert=${ca}`, true],
    ];
    try {
      for (const [writer, reader, accepted] of pairs) {
        const run = restateReaders(migrator, {
          credential: 'pw',
          readerUrl: `postgres://auracle_reader:pw@${at}${reader}`,
          migratorUrl: `postgres://auracle:auracle@${at}${writer}`,
        });
        await expect(run, `${writer} against ${reader}`).rejects.toThrow(accepted
          ? /sentinel: the restate began/
          : /^the migrations applied, and READER_DATABASE_URL names a weaker TLS setting than DATABASE_URL, so auracle_reader was not restated/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
