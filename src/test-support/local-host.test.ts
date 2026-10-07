// Which server a test run will change (issues #80 and #153).
//
// A test run creates the readers' role, sets its password and its connection
// limit, and empties mailboxes. Each change belongs to the whole server. The
// ways the guard can fail:
//
//   1. It reads the host from the URL, where the driver connects elsewhere:
//      a `host` query parameter, an ignored `hostaddr`, or an empty host the
//      driver fills from PGHOST.
//   2. It refuses a socket on this machine.
//   3. It runs after the first statement, so the server changes before the
//      refusal.
import { afterEach, describe, expect, it } from 'vitest';

import { postgresHost } from './local-host.js';
import { prepareTemplate } from './template-db.js';

const SAVED = { PGHOST: process.env.PGHOST, AURACLE_TEST_ALLOW_REMOTE_DB: process.env.AURACLE_TEST_ALLOW_REMOTE_DB };
afterEach(() => {
  for (const [name, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('postgresHost', () => {
  it('names the host the driver connects to, not the one the URL shows', () => { // 1
    expect(postgresHost('postgres://a:b@localhost:5433/x?host=db.example.test')).toBe('db.example.test');
    expect(postgresHost('postgres://a:b@db.example.test:5432/x?hostaddr=127.0.0.1')).toBe('db.example.test');
    process.env.PGHOST = 'db.example.test';
    expect(postgresHost('postgres:///x')).toBe('db.example.test');
  });

  it('takes a socket path as this machine', () => { // 2
    expect(postgresHost('postgres://a:b@%2Fvar%2Frun%2Fpostgresql/x')).toBe('localhost');
    expect(postgresHost('postgres://a:b@localhost/x?host=/tmp')).toBe('localhost');
  });
});

describe('prepareTemplate', () => {
  // A guard placed after the first statement would try the network first,
  // and fail with a lookup error rather than this refusal.
  it('refuses a remote server before it sends a statement', async () => { // 3
    delete process.env.AURACLE_TEST_ALLOW_REMOTE_DB;
    await expect(prepareTemplate('postgres://a:b@db.example.test:5432/x', 'r1'))
      .rejects.toThrow(/^refusing to create auracle_reader and set its login for the whole server on 'db\.example\.test'/);
  });
});
